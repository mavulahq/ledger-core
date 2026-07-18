import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DomainEventEnvelope, assertDomainEventEnvelope } from '../domain-events/domain-event.types';
import { DomainInboxService } from '../domain-events/domain-inbox.service';
import { DomainOutboxService } from '../domain-events/domain-outbox.service';
import { PrismaService } from '../services/prisma.service';
import {
  ProjectionApplyResult,
  ProjectionCheckpoint,
  ProjectionRebuildResult,
  READ_PROJECTION_NAMES,
  ReadProjectionName,
  ReadProjectionRecord,
  isReadProjectionName,
} from './read-projection.types';

const CONSUMER_NAME = 'fengine.read-models';

type ProjectionTarget = {
  projectionName: ReadProjectionName;
  entityId: string;
  entityType: string;
};

type ProjectionEventEntry = {
  event_id: string;
  event_type?: string;
  event_version?: number;
  aggregate_version?: number;
  occurred_at: string;
  [key: string]: any;
};

@Injectable()
export class ReadProjectionService {
  private readonly memory = new Map<string, ReadProjectionRecord>();
  private readonly checkpoints = new Map<string, ProjectionCheckpoint>();
  private readonly memoryLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: DomainInboxService,
    private readonly outbox: DomainOutboxService,
  ) {}

  async apply(event: DomainEventEnvelope): Promise<ProjectionApplyResult> {
    assertDomainEventEnvelope(event);
    const target = this.targetFor(event);
    if (!target) {
      return { applied: false, ignored: true };
    }

    if (!this.prisma.isConfigured) {
      return this.applyMemory(event, target);
    }

    return this.applyDatabase(event, target);
  }

  async rebuild(input: {
    tenantId: string;
    projectionName?: ReadProjectionName;
  }): Promise<ProjectionRebuildResult> {
    const projectionNames = input.projectionName ? [input.projectionName] : [...READ_PROJECTION_NAMES];
    await this.clear(input.tenantId, projectionNames);

    const records = (await this.outbox.list(input.tenantId))
      .filter((record) => {
        const target = this.targetFor(record.envelope);
        return target && projectionNames.includes(target.projectionName);
      })
      .sort(
        (left, right) =>
          Date.parse(left.envelope.occurred_at) - Date.parse(right.envelope.occurred_at),
      );

    let rebuilt = 0;
    for (const record of records) {
      await this.inbox.reset(record.envelope.tenant_id, record.envelope.event_id, CONSUMER_NAME);
      const result = await this.apply(record.envelope);
      if (result.applied) {
        rebuilt += 1;
      }
    }

    return {
      rebuilt,
      scanned: records.length,
      projection_names: projectionNames,
      tenant_id: input.tenantId,
    };
  }

  async list(
    tenantId: string,
    projectionName: ReadProjectionName,
  ): Promise<ReadProjectionRecord[]> {
    if (!this.prisma.isConfigured) {
      return [...this.memory.values()]
        .filter(
          (record) =>
            record.tenant_id === tenantId &&
            record.projection_name === projectionName,
        )
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime());
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<any[]>`
        SELECT * FROM "read_projections"
        WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
        ORDER BY "updatedAt" DESC
      `;
      return rows.map((row) => this.projectionFromRow(row));
    });
  }

  async get(
    tenantId: string,
    projectionName: ReadProjectionName,
    entityId: string,
  ): Promise<ReadProjectionRecord | undefined> {
    if (!this.prisma.isConfigured) {
      return this.memory.get(this.key(tenantId, projectionName, entityId));
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<any[]>`
        SELECT * FROM "read_projections"
        WHERE "tenantId" = ${tenantId}
          AND "projectionName" = ${projectionName}
          AND "entityId" = ${entityId}
        LIMIT 1
      `;
      return row ? this.projectionFromRow(row) : undefined;
    });
  }

  async status(tenantId: string): Promise<{
    status: 'ok';
    projections: ProjectionCheckpoint[];
  }> {
    if (!this.prisma.isConfigured) {
      const projections = [...this.checkpoints.values()]
        .filter((checkpoint) => checkpoint.tenant_id === tenantId)
        .sort((left, right) => left.projection_name.localeCompare(right.projection_name));
      return { status: 'ok', projections };
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<any[]>`
        SELECT * FROM "projection_checkpoints"
        WHERE "tenantId" = ${tenantId}
        ORDER BY "projectionName" ASC
      `;
      return { status: 'ok' as const, projections: rows.map((row) => this.checkpointFromRow(row)) };
    });
  }

  projectionName(value: string): ReadProjectionName {
    if (!isReadProjectionName(value)) {
      throw new Error(`Unsupported projection: ${value}`);
    }
    return value;
  }

  private async applyMemory(
    event: DomainEventEnvelope,
    target: ProjectionTarget,
  ): Promise<ProjectionApplyResult> {
    return this.withMemoryLock(this.key(event.tenant_id, target.projectionName, target.entityId), async () => {
      const processing = await this.inbox.startProcessing(event, CONSUMER_NAME);
      if (!processing.started) {
        return {
          applied: false,
          idempotent: true,
          projection_name: target.projectionName,
          entity_id: target.entityId,
        };
      }

      try {
        this.projectMemory(event, target);
        await this.inbox.markProcessed(event.tenant_id, event.event_id, CONSUMER_NAME);
        return {
          applied: true,
          projection_name: target.projectionName,
          entity_id: target.entityId,
        };
      } catch (error) {
        await this.inbox.markFailed(event.tenant_id, event.event_id, CONSUMER_NAME, error as Error);
        throw error;
      }
    });
  }

  private async applyDatabase(
    event: DomainEventEnvelope,
    target: ProjectionTarget,
  ): Promise<ProjectionApplyResult> {
    try {
      return await this.prisma.withTenant(event.tenant_id, async (tx) => {
        const processing = await this.startInboxProcessing(tx, event);
        if (!processing.started) {
          return {
            applied: false,
            idempotent: true,
            projection_name: target.projectionName,
            entity_id: target.entityId,
          };
        }

        await this.projectDatabase(tx, event, target);
        await this.markInboxProcessed(tx, event);
        return {
          applied: true,
          projection_name: target.projectionName,
          entity_id: target.entityId,
        };
      });
    } catch (error) {
      await this.inbox.recordFailed(event.tenant_id, event.event_id, CONSUMER_NAME, error as Error);
      throw error;
    }
  }

  private projectMemory(event: DomainEventEnvelope, target: ProjectionTarget): void {
    const existing = this.memory.get(this.key(event.tenant_id, target.projectionName, target.entityId));
    const alreadyProjected = this.hasProjectedEvent(existing?.data, event.event_id);
    const record = this.buildRecord(event, target, existing);
    this.memory.set(this.key(event.tenant_id, target.projectionName, target.entityId), record);
    if (!alreadyProjected) {
      this.updateMemoryCheckpoint(record, new Date());
    }
  }

  private async projectDatabase(
    tx: any,
    event: DomainEventEnvelope,
    target: ProjectionTarget,
  ): Promise<void> {
    const lockKey = this.key(event.tenant_id, target.projectionName, target.entityId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

    const [row] = await tx.$queryRaw<any[]>`
      SELECT * FROM "read_projections"
      WHERE "tenantId" = ${event.tenant_id}
        AND "projectionName" = ${target.projectionName}
        AND "entityId" = ${target.entityId}
      LIMIT 1
      FOR UPDATE
    `;
    const existing = row ? this.projectionFromRow(row) : undefined;
    const alreadyProjected = this.hasProjectedEvent(existing?.data, event.event_id);
    const record = this.buildRecord(event, target, existing);

    await tx.$executeRaw`
      INSERT INTO "read_projections" (
        "id", "tenantId", "projectionName", "entityId", "entityType", "data",
        "lastEventId", "lastEventType", "lastEventVersion", "lastOccurredAt", "updatedAt"
      )
      VALUES (
        ${randomUUID()}, ${record.tenant_id}, ${record.projection_name}, ${record.entity_id}, ${record.entity_type}, CAST(${this.json(record.data)} AS jsonb),
        ${record.last_event_id}, ${record.last_event_type}, ${record.last_event_version}, ${record.last_occurred_at}, now()
      )
      ON CONFLICT ("tenantId", "projectionName", "entityId") DO UPDATE SET
        "entityType" = EXCLUDED."entityType",
        "data" = EXCLUDED."data",
        "lastEventId" = EXCLUDED."lastEventId",
        "lastEventType" = EXCLUDED."lastEventType",
        "lastEventVersion" = EXCLUDED."lastEventVersion",
        "lastOccurredAt" = EXCLUDED."lastOccurredAt",
        "updatedAt" = now()
    `;
    if (!alreadyProjected) {
      await this.upsertCheckpoint(tx, record);
    }
  }

  private buildRecord(
    event: DomainEventEnvelope,
    target: ProjectionTarget,
    existing?: ReadProjectionRecord,
  ): ReadProjectionRecord {
    const data = this.projectData(event, existing?.data || {});
    const metadata = this.projectionMetadata(event, data);
    const now = new Date();
    return {
      tenant_id: event.tenant_id,
      projection_name: target.projectionName,
      entity_id: target.entityId,
      entity_type: target.entityType,
      data,
      last_event_id: metadata.event_id,
      last_event_type: metadata.event_type,
      last_event_version: metadata.event_version,
      last_occurred_at: new Date(metadata.occurred_at),
      created_at: existing?.created_at || now,
      updated_at: now,
    };
  }

  private projectData(event: DomainEventEnvelope, existing: Record<string, any>): Record<string, any> {
    switch (event.event_type) {
      case 'lending.loan_disbursed':
        return this.loanActivity(event, existing, 'DISBURSED');
      case 'lending.payment_posted':
        return this.loanActivity(event, existing, 'PAYMENT_POSTED');
      case 'lending.adjustment_applied':
        return this.loanAdjustmentActivity(event, existing);
      case 'ledger.journal_posted':
      case 'ledger.adjustment_posted':
        return this.ledgerActivity(event, existing);
      case 'products.configuration_published':
        return this.productPublication(event, existing);
      default:
        return existing;
    }
  }

  private productPublication(
    event: DomainEventEnvelope,
    existing: Record<string, any>,
  ): Record<string, any> {
    const publications = this.appendUnique(existing.publications || [], {
      event_id: event.event_id,
      event_type: event.event_type,
      event_version: event.event_version,
      aggregate_version: event.aggregate.version,
      occurred_at: event.occurred_at,
      product_type: event.payload.product_type,
      name: event.payload.name,
      configuration_version: event.payload.configuration_version,
      enabled: event.payload.enabled,
    });
    const latest = publications[publications.length - 1];
    return {
      product_id: event.payload.product_id,
      product_type: latest.product_type,
      name: latest.name,
      enabled: latest.enabled,
      latest_version: latest.configuration_version,
      latest_event_id: latest.event_id,
      latest_event_type: latest.event_type,
      latest_event_version: latest.event_version,
      latest_occurred_at: latest.occurred_at,
      publications,
    };
  }

  private ledgerActivity(
    event: DomainEventEnvelope,
    existing: Record<string, any>,
  ): Record<string, any> {
    const next = event.event_type === 'ledger.journal_posted'
      ? {
          event_id: event.event_id,
          event_type: event.event_type,
          event_version: event.event_version,
          aggregate_version: event.aggregate.version,
          occurred_at: event.occurred_at,
          journal_entry_id: event.payload.journal_entry_id,
          transaction_id: event.payload.transaction_id,
          posted_at: event.payload.posted_at,
          line_count: event.payload.line_count,
          totals: event.payload.totals,
          lines: event.payload.lines,
        }
      : {
          event_id: event.event_id,
          event_type: event.event_type,
          event_version: event.event_version,
          aggregate_version: event.aggregate.version,
          occurred_at: event.occurred_at,
          adjustment_request_id: event.payload.adjustment_request_id,
          adjustment_type: event.payload.adjustment_type,
          target_journal_entry_id: event.payload.target_journal_entry_id,
          reversal_journal_entry_id: event.payload.reversal_journal_entry_id,
          replacement_journal_entry_id: event.payload.replacement_journal_entry_id,
          adjusted_at: event.payload.applied_at,
        };
    const events = this.appendUnique(existing.events || [], next);
    const journal = [...events].reverse().find((entry) => entry.event_type === 'ledger.journal_posted');
    const adjustment = [...events].reverse().find((entry) => entry.event_type === 'ledger.adjustment_posted');
    const latest = events[events.length - 1];
    return {
      ...(journal ? {
        journal_entry_id: journal.journal_entry_id,
        transaction_id: journal.transaction_id,
        posted_at: journal.posted_at,
        line_count: journal.line_count,
        totals: journal.totals,
        lines: journal.lines,
      } : {}),
      ...(adjustment ? {
        adjustment_request_id: adjustment.adjustment_request_id,
        adjustment_type: adjustment.adjustment_type,
        reversal_journal_entry_id: adjustment.reversal_journal_entry_id,
        replacement_journal_entry_id: adjustment.replacement_journal_entry_id,
        adjusted_at: adjustment.adjusted_at,
      } : {}),
      latest_event_id: latest.event_id,
      latest_event_type: latest.event_type,
      latest_event_version: latest.event_version,
      latest_occurred_at: latest.occurred_at,
      event_count: events.length,
      events,
    };
  }

  private loanActivity(
    event: DomainEventEnvelope,
    existing: Record<string, any>,
    activityType: string,
  ): Record<string, any> {
    const activities = this.appendUnique(existing.activities || [], {
      event_id: event.event_id,
      event_type: event.event_type,
      event_version: event.event_version,
      aggregate_version: event.aggregate.version,
      occurred_at: event.occurred_at,
      transaction_id: event.payload.transaction_id,
      activity_type: activityType,
      money: event.payload.money,
      allocation: event.payload.allocation,
      balance_after: event.payload.balance_after,
    });
    const latest = activities[activities.length - 1];
    const disbursement = [...activities]
      .reverse()
      .find((activity) => activity.event_type === 'lending.loan_disbursed');
    return {
      loan_id: event.aggregate.id,
      latest_activity_type: latest.activity_type,
      latest_transaction_id: latest.transaction_id,
      latest_event_id: latest.event_id,
      latest_event_type: latest.event_type,
      latest_event_version: latest.event_version,
      latest_occurred_at: latest.occurred_at,
      currency: latest.money?.currency || existing.currency,
      disbursed_amount: disbursement?.money?.amount || existing.disbursed_amount,
      balance_after: latest.balance_after || existing.balance_after || latest.money?.amount,
      activity_count: activities.length,
      activities,
    };
  }

  private loanAdjustmentActivity(
    event: DomainEventEnvelope,
    existing: Record<string, any>,
  ): Record<string, any> {
    const activities = this.appendUnique(existing.activities || [], {
      event_id: event.event_id,
      event_type: event.event_type,
      event_version: event.event_version,
      aggregate_version: event.aggregate.version,
      occurred_at: event.occurred_at,
      transaction_id: event.payload.replacement_transaction_id || event.payload.reversal_transaction_id,
      original_transaction_id: event.payload.original_transaction_id,
      activity_type: `${event.payload.operation}_${event.payload.adjustment_type}`,
      adjustment_request_id: event.payload.adjustment_request_id,
      adjustment_type: event.payload.adjustment_type,
      money: event.payload.money,
      allocation: event.payload.allocation,
      balance_after: event.payload.balance_after,
      loan_status: event.payload.loan_status,
    });
    const latest = activities[activities.length - 1];
    const disbursement = [...activities]
      .reverse()
      .find((activity) => activity.event_type === 'lending.loan_disbursed');
    return {
      ...existing,
      loan_id: event.aggregate.id,
      latest_activity_type: latest.activity_type,
      latest_transaction_id: latest.transaction_id,
      latest_event_id: latest.event_id,
      latest_event_type: latest.event_type,
      latest_event_version: latest.event_version,
      latest_occurred_at: latest.occurred_at,
      currency: event.payload.money.currency,
      disbursed_amount: event.payload.operation === 'LOAN_DISBURSEMENT'
        ? (event.payload.adjustment_type === 'REVERSAL' ? '0.00' : event.payload.money.amount)
        : disbursement?.money?.amount || existing.disbursed_amount,
      balance_after: event.payload.balance_after,
      loan_status: event.payload.loan_status,
      activity_count: activities.length,
      activities,
    };
  }

  private targetFor(event: DomainEventEnvelope): ProjectionTarget | undefined {
    switch (event.event_type) {
      case 'lending.loan_disbursed':
      case 'lending.payment_posted':
      case 'lending.adjustment_applied':
        return { projectionName: 'loan_activity', entityId: event.aggregate.id, entityType: 'loan' };
      case 'ledger.journal_posted':
        return { projectionName: 'ledger_activity', entityId: event.payload.journal_entry_id, entityType: 'journal_entry' };
      case 'ledger.adjustment_posted':
        return { projectionName: 'ledger_activity', entityId: event.payload.target_journal_entry_id, entityType: 'journal_entry' };
      case 'products.configuration_published':
        return { projectionName: 'product_publication', entityId: event.payload.product_id, entityType: 'product_configuration' };
      default:
        return undefined;
    }
  }

  private async clear(tenantId: string, projectionNames: ReadProjectionName[]): Promise<void> {
    if (!this.prisma.isConfigured) {
      for (const key of [...this.memory.keys()]) {
        const record = this.memory.get(key);
        if (
          record &&
          record.tenant_id === tenantId &&
          projectionNames.includes(record.projection_name)
        ) {
          this.memory.delete(key);
        }
      }
      for (const key of [...this.checkpoints.keys()]) {
        const checkpoint = this.checkpoints.get(key);
        if (
          checkpoint &&
          checkpoint.tenant_id === tenantId &&
          projectionNames.includes(checkpoint.projection_name)
        ) {
          this.checkpoints.delete(key);
        }
      }
      return;
    }

    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const projectionName of projectionNames) {
        await tx.$executeRaw`
          DELETE FROM "read_projections"
          WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
        `;
        await tx.$executeRaw`
          DELETE FROM "projection_checkpoints"
          WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
        `;
      }
    });
  }

  private updateMemoryCheckpoint(
    record: ReadProjectionRecord,
    now: Date,
  ): void {
    const key = this.checkpointKey(record.tenant_id, record.projection_name);
    const existing = this.checkpoints.get(key);
    this.checkpoints.set(key, {
      tenant_id: record.tenant_id,
      projection_name: record.projection_name,
      last_event_id: record.last_event_id,
      last_event_type: record.last_event_type,
      last_event_version: record.last_event_version,
      last_occurred_at: record.last_occurred_at,
      event_count: (existing?.event_count || 0) + 1,
      lag_ms: this.lagMs(record.last_occurred_at),
      created_at: existing?.created_at || now,
      updated_at: now,
    });
  }

  private async upsertCheckpoint(
    tx: any,
    record: ReadProjectionRecord,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "projection_checkpoints" (
        "id", "tenantId", "projectionName", "lastEventId", "lastEventType",
        "lastEventVersion", "lastOccurredAt", "eventCount", "lagMs", "updatedAt"
      )
      VALUES (
        ${randomUUID()}, ${record.tenant_id}, ${record.projection_name}, ${record.last_event_id}, ${record.last_event_type},
        ${record.last_event_version}, ${record.last_occurred_at}, 1, ${this.lagMs(record.last_occurred_at)}, now()
      )
      ON CONFLICT ("tenantId", "projectionName") DO UPDATE SET
        "lastEventId" = EXCLUDED."lastEventId",
        "lastEventType" = EXCLUDED."lastEventType",
        "lastEventVersion" = EXCLUDED."lastEventVersion",
        "lastOccurredAt" = EXCLUDED."lastOccurredAt",
        "eventCount" = "projection_checkpoints"."eventCount" + 1,
        "lagMs" = EXCLUDED."lagMs",
        "updatedAt" = now()
    `;
  }

  private async startInboxProcessing(
    tx: any,
    event: DomainEventEnvelope,
  ): Promise<{ started: boolean }> {
    const [inserted] = await tx.$queryRaw<any[]>`
      INSERT INTO "domain_inbox_events" ("id", "eventId", "consumerName", "tenantId", "status", "updatedAt")
      VALUES (${randomUUID()}, ${event.event_id}, ${CONSUMER_NAME}, ${event.tenant_id}, 'PROCESSING', now())
      ON CONFLICT ("tenantId", "eventId", "consumerName") DO NOTHING
      RETURNING *
    `;
    if (inserted) {
      return { started: true };
    }

    const staleBefore = new Date(Date.now() - this.processingLeaseMs());
    const [claimed] = await tx.$queryRaw<any[]>`
      UPDATE "domain_inbox_events"
      SET "status" = 'PROCESSING', "lastError" = NULL, "updatedAt" = now()
      WHERE "eventId" = ${event.event_id}
        AND "consumerName" = ${CONSUMER_NAME}
        AND "tenantId" = ${event.tenant_id}
        AND (
          "status" = 'FAILED'
          OR ("status" = 'PROCESSING' AND "updatedAt" <= ${staleBefore})
        )
      RETURNING *
    `;
    return { started: Boolean(claimed) };
  }

  private async markInboxProcessed(tx: any, event: DomainEventEnvelope): Promise<void> {
    await tx.$executeRaw`
      UPDATE "domain_inbox_events"
      SET
        "status" = 'PROCESSED',
        "processedAt" = now(),
        "failedAt" = NULL,
        "lastError" = NULL,
        "updatedAt" = now()
      WHERE "eventId" = ${event.event_id}
        AND "consumerName" = ${CONSUMER_NAME}
        AND "tenantId" = ${event.tenant_id}
    `;
  }

  private appendUnique<T extends ProjectionEventEntry>(
    existing: T[],
    next: T,
  ): T[] {
    const entries = Array.isArray(existing)
      ? existing.map((entry) => this.normalizeProjectionEntry(entry))
      : [];
    if (!entries.some((entry) => entry.event_id === next.event_id)) {
      entries.push(this.normalizeProjectionEntry(next));
    }
    return entries.sort((left, right) => this.compareProjectionEvents(left, right));
  }

  private projectionMetadata(
    event: DomainEventEnvelope,
    data: Record<string, any>,
  ): ProjectionEventEntry {
    const latest =
      data.activities?.[data.activities.length - 1] ||
      data.publications?.[data.publications.length - 1] ||
      data.events?.[data.events.length - 1];
    if (latest) {
      const eventId = latest.event_id || data.latest_event_id;
      const eventType =
        latest.event_type ||
        this.projectionEventType(latest) ||
        data.latest_event_type;
      const occurredAt = latest.occurred_at || data.latest_occurred_at;
      if (!eventId || !eventType || !occurredAt) {
        throw new Error('Cannot resolve projection metadata for legacy history entry');
      }
      return {
        ...latest,
        event_id: eventId,
        event_type: eventType,
        event_version:
          this.positiveInteger(latest.event_version) ||
          this.positiveInteger(data.latest_event_version) ||
          1,
        aggregate_version:
          this.aggregateVersion(latest) ||
          this.aggregateVersion(data),
        occurred_at: occurredAt,
      };
    }
    return {
      event_id: data.latest_event_id || event.event_id,
      event_type: data.latest_event_type || event.event_type,
      event_version: data.latest_event_version || event.event_version,
      aggregate_version: this.aggregateVersion(data) || event.aggregate.version,
      occurred_at: data.latest_occurred_at || event.occurred_at,
    };
  }

  private normalizeProjectionEntry<T extends ProjectionEventEntry>(entry: T): T {
    return {
      ...entry,
      event_type: entry.event_type || this.projectionEventType(entry),
      event_version: this.positiveInteger(entry.event_version) || 1,
      aggregate_version: this.aggregateVersion(entry),
      occurred_at: entry.occurred_at || '1970-01-01T00:00:00.000Z',
    };
  }

  private projectionEventType(entry: ProjectionEventEntry): string | undefined {
    if (entry.activity_type === 'DISBURSED') {
      return 'lending.loan_disbursed';
    }
    if (entry.activity_type === 'PAYMENT_POSTED') {
      return 'lending.payment_posted';
    }
    if (entry.adjustment_type) {
      return 'lending.adjustment_applied';
    }
    if (entry.configuration_version !== undefined) {
      return 'products.configuration_published';
    }
    if (entry.adjustment_request_id && entry.reversal_journal_entry_id) {
      return 'ledger.adjustment_posted';
    }
    if (entry.journal_entry_id && entry.transaction_id) {
      return 'ledger.journal_posted';
    }
    return undefined;
  }

  private aggregateVersion(entry: Record<string, any>): number {
    return (
      this.positiveInteger(entry.aggregate_version) ||
      this.positiveInteger(entry.configuration_version) ||
      this.positiveInteger(entry.latest_version) ||
      this.positiveInteger(entry.event_version) ||
      0
    );
  }

  private positiveInteger(value: any): number | undefined {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private hasProjectedEvent(data: Record<string, any> | undefined, eventId: string): boolean {
    if (!data) {
      return false;
    }
    return (
      data.latest_event_id === eventId ||
      Boolean(data.activities?.some((entry: ProjectionEventEntry) => entry.event_id === eventId)) ||
      Boolean(data.publications?.some((entry: ProjectionEventEntry) => entry.event_id === eventId)) ||
      Boolean(data.events?.some((entry: ProjectionEventEntry) => entry.event_id === eventId))
    );
  }

  private compareProjectionEvents(
    left: ProjectionEventEntry,
    right: ProjectionEventEntry,
  ): number {
    const leftAggregateVersion = this.aggregateVersion(left);
    const rightAggregateVersion = this.aggregateVersion(right);
    if (
      leftAggregateVersion > 0 &&
      rightAggregateVersion > 0 &&
      leftAggregateVersion !== rightAggregateVersion
    ) {
      return leftAggregateVersion - rightAggregateVersion;
    }
    const byTime = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
    if (byTime !== 0) {
      return byTime;
    }
    return 0;
  }

  private lagMs(occurredAt: Date): number {
    return Math.max(0, Date.now() - occurredAt.getTime());
  }

  private processingLeaseMs(): number {
    return Number(process.env.FENGINE_INBOX_PROCESSING_LEASE_MS || 300000);
  }

  private async withMemoryLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.memoryLocks.get(lockKey) || Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.memoryLocks.set(lockKey, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.memoryLocks.get(lockKey) === chain) {
        this.memoryLocks.delete(lockKey);
      }
    }
  }

  private key(tenantId: string, projectionName: ReadProjectionName, entityId: string): string {
    return `${tenantId}:${projectionName}:${entityId}`;
  }

  private checkpointKey(tenantId: string, projectionName: ReadProjectionName): string {
    return `${tenantId}:${projectionName}`;
  }

  private projectionFromRow(row: any): ReadProjectionRecord {
    return {
      tenant_id: row.tenantId,
      projection_name: row.projectionName,
      entity_id: row.entityId,
      entity_type: row.entityType,
      data: this.parseJson(row.data),
      last_event_id: row.lastEventId,
      last_event_type: row.lastEventType,
      last_event_version: row.lastEventVersion,
      last_occurred_at: new Date(row.lastOccurredAt),
      created_at: new Date(row.createdAt),
      updated_at: new Date(row.updatedAt),
    };
  }

  private checkpointFromRow(row: any): ProjectionCheckpoint {
    return {
      tenant_id: row.tenantId,
      projection_name: row.projectionName,
      last_event_id: row.lastEventId || undefined,
      last_event_type: row.lastEventType || undefined,
      last_event_version: row.lastEventVersion || undefined,
      last_occurred_at: row.lastOccurredAt ? new Date(row.lastOccurredAt) : undefined,
      event_count: row.eventCount,
      lag_ms: Number(row.lagMs),
      created_at: new Date(row.createdAt),
      updated_at: new Date(row.updatedAt),
    };
  }

  private parseJson<T>(value: any): T {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  private json<T>(value: T): string {
    return JSON.stringify(value);
  }
}
