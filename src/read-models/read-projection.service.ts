import { Injectable } from '@nestjs/common';
import { DomainEventEnvelope } from '../domain-events/domain-event.types';
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

@Injectable()
export class ReadProjectionService {
  private readonly memory = new Map<string, ReadProjectionRecord>();
  private readonly checkpoints = new Map<string, ProjectionCheckpoint>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: DomainInboxService,
    private readonly outbox: DomainOutboxService,
  ) {}

  async apply(event: DomainEventEnvelope): Promise<ProjectionApplyResult> {
    const target = this.targetFor(event);
    if (!target) {
      return { applied: false, ignored: true };
    }

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
      await this.project(event, target.projectionName, target.entityId, target.entityType);
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
  }

  async rebuild(input: {
    tenantId?: string;
    projectionName?: ReadProjectionName;
  } = {}): Promise<ProjectionRebuildResult> {
    const projectionNames = input.projectionName ? [input.projectionName] : [...READ_PROJECTION_NAMES];
    await this.clear(input.tenantId, projectionNames);

    const records = await this.outbox.list(input.tenantId);
    let scanned = 0;
    let rebuilt = 0;
    for (const record of records.sort(
      (left, right) =>
        Date.parse(left.envelope.occurred_at) - Date.parse(right.envelope.occurred_at),
    )) {
      const target = this.targetFor(record.envelope);
      if (!target || !projectionNames.includes(target.projectionName)) {
        continue;
      }
      scanned += 1;
      await this.project(
        record.envelope,
        target.projectionName,
        target.entityId,
        target.entityType,
      );
      rebuilt += 1;
    }

    return {
      rebuilt,
      scanned,
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

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "read_projections"
      WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
      ORDER BY "updatedAt" DESC
    `;
    return rows.map((row) => this.projectionFromRow(row));
  }

  async get(
    tenantId: string,
    projectionName: ReadProjectionName,
    entityId: string,
  ): Promise<ReadProjectionRecord | undefined> {
    if (!this.prisma.isConfigured) {
      return this.memory.get(this.key(tenantId, projectionName, entityId));
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "read_projections"
      WHERE "tenantId" = ${tenantId}
        AND "projectionName" = ${projectionName}
        AND "entityId" = ${entityId}
      LIMIT 1
    `;
    return row ? this.projectionFromRow(row) : undefined;
  }

  async status(tenantId?: string): Promise<{
    status: 'ok';
    projections: ProjectionCheckpoint[];
  }> {
    if (!this.prisma.isConfigured) {
      const projections = [...this.checkpoints.values()]
        .filter((checkpoint) => !tenantId || checkpoint.tenant_id === tenantId)
        .sort((left, right) => left.projection_name.localeCompare(right.projection_name));
      return { status: 'ok', projections };
    }

    if (tenantId) {
      await this.enterTenant(tenantId);
    } else {
      await this.prisma.setTenantContext('*');
    }
    const rows = tenantId
      ? await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "projection_checkpoints"
          WHERE "tenantId" = ${tenantId}
          ORDER BY "projectionName" ASC
        `
      : await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "projection_checkpoints"
          ORDER BY "tenantId" ASC, "projectionName" ASC
        `;
    return { status: 'ok', projections: rows.map((row) => this.checkpointFromRow(row)) };
  }

  projectionName(value: string): ReadProjectionName {
    if (!isReadProjectionName(value)) {
      throw new Error(`Unsupported projection: ${value}`);
    }
    return value;
  }

  private async project(
    event: DomainEventEnvelope,
    projectionName: ReadProjectionName,
    entityId: string,
    entityType: string,
  ): Promise<void> {
    const existing = await this.get(event.tenant_id, projectionName, entityId);
    const data = this.projectData(event, existing?.data || {});
    const now = new Date();
    const occurredAt = new Date(event.occurred_at);
    const record: ReadProjectionRecord = {
      tenant_id: event.tenant_id,
      projection_name: projectionName,
      entity_id: entityId,
      entity_type: entityType,
      data,
      last_event_id: event.event_id,
      last_event_type: event.event_type,
      last_event_version: event.event_version,
      last_occurred_at: occurredAt,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    if (!this.prisma.isConfigured) {
      this.memory.set(this.key(event.tenant_id, projectionName, entityId), record);
      this.updateMemoryCheckpoint(event, projectionName, occurredAt, now);
      return;
    }

    await this.enterTenant(event.tenant_id);
    await this.prisma.db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${event.tenant_id}, true)`;
      await tx.$executeRaw`
        INSERT INTO "read_projections" (
          "tenantId", "projectionName", "entityId", "entityType", "data",
          "lastEventId", "lastEventType", "lastEventVersion", "lastOccurredAt", "updatedAt"
        )
        VALUES (
          ${record.tenant_id}, ${record.projection_name}, ${record.entity_id}, ${record.entity_type}, CAST(${this.json(record.data)} AS jsonb),
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
      await this.upsertCheckpoint(tx, event, projectionName, occurredAt);
    });
  }

  private projectData(event: DomainEventEnvelope, existing: Record<string, any>): Record<string, any> {
    switch (event.event_type) {
      case 'lending.loan_disbursed':
        return this.loanActivity(event, existing, 'DISBURSED');
      case 'lending.payment_posted':
        return this.loanActivity(event, existing, 'PAYMENT_POSTED');
      case 'ledger.journal_posted':
        return {
          journal_entry_id: event.payload.journal_entry_id,
          transaction_id: event.payload.transaction_id,
          posted_at: event.payload.posted_at,
          line_count: event.payload.line_count,
          totals: event.payload.totals,
          lines: event.payload.lines,
        };
      case 'products.configuration_published':
        return {
          product_id: event.payload.product_id,
          product_type: event.payload.product_type,
          name: event.payload.name,
          enabled: event.payload.enabled,
          latest_version: event.payload.configuration_version,
          publications: [
            ...(existing.publications || []),
            {
              event_id: event.event_id,
              occurred_at: event.occurred_at,
              configuration_version: event.payload.configuration_version,
              enabled: event.payload.enabled,
            },
          ],
        };
      default:
        return existing;
    }
  }

  private loanActivity(
    event: DomainEventEnvelope,
    existing: Record<string, any>,
    activityType: string,
  ): Record<string, any> {
    const activities = [
      ...(existing.activities || []),
      {
        event_id: event.event_id,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        transaction_id: event.payload.transaction_id,
        activity_type: activityType,
        money: event.payload.money,
        allocation: event.payload.allocation,
        balance_after: event.payload.balance_after,
      },
    ];
    return {
      loan_id: event.aggregate.id,
      latest_activity_type: activityType,
      latest_transaction_id: event.payload.transaction_id,
      currency: event.payload.money?.currency || existing.currency,
      disbursed_amount: event.event_type === 'lending.loan_disbursed'
        ? event.payload.money?.amount
        : existing.disbursed_amount,
      balance_after: event.payload.balance_after || existing.balance_after || event.payload.money?.amount,
      activity_count: activities.length,
      activities,
    };
  }

  private targetFor(event: DomainEventEnvelope): {
    projectionName: ReadProjectionName;
    entityId: string;
    entityType: string;
  } | undefined {
    switch (event.event_type) {
      case 'lending.loan_disbursed':
      case 'lending.payment_posted':
        return { projectionName: 'loan_activity', entityId: event.aggregate.id, entityType: 'loan' };
      case 'ledger.journal_posted':
        return { projectionName: 'ledger_activity', entityId: event.payload.journal_entry_id, entityType: 'journal_entry' };
      case 'products.configuration_published':
        return { projectionName: 'product_publication', entityId: event.payload.product_id, entityType: 'product_configuration' };
      default:
        return undefined;
    }
  }

  private async clear(tenantId: string | undefined, projectionNames: ReadProjectionName[]): Promise<void> {
    if (!this.prisma.isConfigured) {
      for (const key of [...this.memory.keys()]) {
        const record = this.memory.get(key);
        if (
          record &&
          (!tenantId || record.tenant_id === tenantId) &&
          projectionNames.includes(record.projection_name)
        ) {
          this.memory.delete(key);
        }
      }
      for (const key of [...this.checkpoints.keys()]) {
        const checkpoint = this.checkpoints.get(key);
        if (
          checkpoint &&
          (!tenantId || checkpoint.tenant_id === tenantId) &&
          projectionNames.includes(checkpoint.projection_name)
        ) {
          this.checkpoints.delete(key);
        }
      }
      return;
    }

    if (tenantId) {
      await this.enterTenant(tenantId);
      for (const projectionName of projectionNames) {
        await this.prisma.db.$executeRaw`
          DELETE FROM "read_projections"
          WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
        `;
        await this.prisma.db.$executeRaw`
          DELETE FROM "projection_checkpoints"
          WHERE "tenantId" = ${tenantId} AND "projectionName" = ${projectionName}
        `;
      }
      return;
    }

    await this.prisma.setTenantContext('*');
    for (const projectionName of projectionNames) {
      await this.prisma.db.$executeRaw`
        DELETE FROM "read_projections"
        WHERE "projectionName" = ${projectionName}
      `;
      await this.prisma.db.$executeRaw`
        DELETE FROM "projection_checkpoints"
        WHERE "projectionName" = ${projectionName}
      `;
    }
  }

  private updateMemoryCheckpoint(
    event: DomainEventEnvelope,
    projectionName: ReadProjectionName,
    occurredAt: Date,
    now: Date,
  ): void {
    const key = this.checkpointKey(event.tenant_id, projectionName);
    const existing = this.checkpoints.get(key);
    this.checkpoints.set(key, {
      tenant_id: event.tenant_id,
      projection_name: projectionName,
      last_event_id: event.event_id,
      last_event_type: event.event_type,
      last_event_version: event.event_version,
      last_occurred_at: occurredAt,
      event_count: (existing?.event_count || 0) + 1,
      lag_ms: this.lagMs(occurredAt),
      created_at: existing?.created_at || now,
      updated_at: now,
    });
  }

  private async upsertCheckpoint(
    tx: any,
    event: DomainEventEnvelope,
    projectionName: ReadProjectionName,
    occurredAt: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "projection_checkpoints" (
        "tenantId", "projectionName", "lastEventId", "lastEventType",
        "lastEventVersion", "lastOccurredAt", "eventCount", "lagMs", "updatedAt"
      )
      VALUES (
        ${event.tenant_id}, ${projectionName}, ${event.event_id}, ${event.event_type},
        ${event.event_version}, ${occurredAt}, 1, ${this.lagMs(occurredAt)}, now()
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

  private lagMs(occurredAt: Date): number {
    return Math.max(0, Date.now() - occurredAt.getTime());
  }

  private async enterTenant(tenantId: string): Promise<void> {
    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
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
      lag_ms: row.lagMs,
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
