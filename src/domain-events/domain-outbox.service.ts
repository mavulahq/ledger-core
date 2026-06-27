import { Injectable } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import {
  DomainEventEnvelope,
  DomainOutboxRecord,
  DomainOutboxStatus,
  assertDomainEventEnvelope,
} from './domain-event.types';

@Injectable()
export class DomainOutboxService {
  private readonly memory = new Map<string, DomainOutboxRecord>();
  private readonly workerId = `fengine-outbox-${process.pid}`;

  constructor(private readonly prisma: PrismaService) {}

  async append(envelope: DomainEventEnvelope, options: { maxAttempts?: number } = {}): Promise<DomainOutboxRecord> {
    assertDomainEventEnvelope(envelope);
    const maxAttempts = Number(options.maxAttempts || process.env.FENGINE_OUTBOX_MAX_ATTEMPTS || 3);

    if (!this.prisma.isConfigured) {
      const existing = this.findMemoryByIdempotencyKey(envelope.tenant_id, envelope.idempotency_key);
      if (existing) {
        return existing;
      }
      const now = new Date();
      const record: DomainOutboxRecord = {
        envelope,
        status: 'PENDING',
        attempts: 0,
        max_attempts: maxAttempts,
        available_at: now,
        created_at: now,
        updated_at: now,
      };
      this.memory.set(envelope.event_id, record);
      return record;
    }

    await this.enterTenant(envelope.tenant_id);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      INSERT INTO "domain_outbox_events" (
        "eventId", "tenantId", "eventType", "eventVersion", "occurredAt",
        "aggregateType", "aggregateId", "aggregateVersion",
        "correlationId", "causationId", "idempotencyKey",
        "payload", "metadata", "status", "attempts", "maxAttempts", "availableAt", "updatedAt"
      )
      VALUES (
        ${envelope.event_id}, ${envelope.tenant_id}, ${envelope.event_type}, ${envelope.event_version}, ${new Date(envelope.occurred_at)},
        ${envelope.aggregate.type}, ${envelope.aggregate.id}, ${envelope.aggregate.version},
        ${envelope.correlation_id}, ${envelope.causation_id}, ${envelope.idempotency_key || null},
        CAST(${JSON.stringify(envelope.payload)} AS jsonb), CAST(${JSON.stringify(envelope.metadata)} AS jsonb),
        'PENDING', 0, ${maxAttempts}, now(), now()
      )
      ON CONFLICT ("tenantId", "idempotencyKey") DO UPDATE SET
        "updatedAt" = "domain_outbox_events"."updatedAt"
      RETURNING *
    `;
    return this.fromRow(row);
  }

  async list(tenantId?: string): Promise<DomainOutboxRecord[]> {
    if (!this.prisma.isConfigured) {
      return [...this.memory.values()].filter((record) => !tenantId || record.envelope.tenant_id === tenantId);
    }

    if (tenantId) {
      await this.enterTenant(tenantId);
    } else {
      await this.enterSystemContext();
    }
    const rows = tenantId
      ? await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "domain_outbox_events"
          WHERE "tenantId" = ${tenantId}
          ORDER BY "createdAt" ASC
        `
      : await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "domain_outbox_events"
          ORDER BY "createdAt" ASC
        `;
    return rows.map((row) => this.fromRow(row));
  }

  async claimPending(limit = 25): Promise<DomainOutboxRecord[]> {
    if (!this.prisma.isConfigured) {
      const now = new Date();
      return [...this.memory.values()]
        .filter((record) => this.canClaim(record, now))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(0, limit)
        .map((record) => {
          const lockedUntil = new Date(now.getTime() + this.leaseMs());
          const updated = {
            ...record,
            status: 'PUBLISHING' as const,
            attempts: record.attempts + 1,
            locked_until: lockedUntil,
            locked_by: this.workerId,
            updated_at: now,
          };
          this.memory.set(record.envelope.event_id, updated);
          return updated;
        });
    }

    await this.enterSystemContext();
    const lockedUntil = new Date(Date.now() + this.leaseMs());
    const rows = await this.prisma.db.$queryRaw<any[]>`
      UPDATE "domain_outbox_events"
      SET
        "status" = 'PUBLISHING',
        "attempts" = "attempts" + 1,
        "lockedUntil" = ${lockedUntil},
        "lockedBy" = ${this.workerId},
        "updatedAt" = now()
      WHERE "eventId" IN (
        SELECT "eventId" FROM "domain_outbox_events"
        WHERE (
          ("status" = 'PENDING' AND "availableAt" <= now())
          OR ("status" = 'PUBLISHING' AND "lockedUntil" <= now())
        )
        ORDER BY "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
    return rows.map((row) => this.fromRow(row));
  }

  async markPublished(eventId: string): Promise<void> {
    if (!this.prisma.isConfigured) {
      const record = this.memory.get(eventId);
      if (record) {
        this.memory.set(eventId, {
          ...record,
          status: 'PUBLISHED',
          published_at: new Date(),
          locked_until: undefined,
          locked_by: undefined,
          updated_at: new Date(),
        });
      }
      return;
    }

    await this.enterSystemContext();
    await this.prisma.db.$executeRaw`
      UPDATE "domain_outbox_events"
      SET "status" = 'PUBLISHED', "publishedAt" = now(), "lockedUntil" = NULL, "lockedBy" = NULL, "updatedAt" = now()
      WHERE "eventId" = ${eventId}
    `;
  }

  async markPublishFailed(record: DomainOutboxRecord, error: Error): Promise<void> {
    const terminal = record.attempts >= record.max_attempts;
    const nextStatus: DomainOutboxStatus = terminal ? 'FAILED' : 'PENDING';
    const availableAt = new Date(Date.now() + this.retryDelayMs(record.attempts));
    const message = error.message.slice(0, 2000);

    if (!this.prisma.isConfigured) {
      this.memory.set(record.envelope.event_id, {
        ...record,
        status: nextStatus,
        available_at: terminal ? record.available_at : availableAt,
        locked_until: undefined,
        locked_by: undefined,
        failed_at: terminal ? new Date() : undefined,
        last_error: message,
        updated_at: new Date(),
      });
      return;
    }

    await this.enterSystemContext();
    await this.prisma.db.$executeRaw`
      UPDATE "domain_outbox_events"
      SET
        "status" = ${nextStatus},
        "availableAt" = ${terminal ? record.available_at : availableAt},
        "lockedUntil" = NULL,
        "lockedBy" = NULL,
        "failedAt" = ${terminal ? new Date() : null},
        "lastError" = ${message},
        "updatedAt" = now()
      WHERE "eventId" = ${record.envelope.event_id}
    `;
  }

  async stats(): Promise<Record<DomainOutboxStatus, number>> {
    const empty = { PENDING: 0, PUBLISHING: 0, PUBLISHED: 0, FAILED: 0 };
    if (!this.prisma.isConfigured) {
      return [...this.memory.values()].reduce((acc, record) => {
        acc[record.status] += 1;
        return acc;
      }, empty);
    }

    await this.enterSystemContext();
    const rows = await this.prisma.db.$queryRaw<Array<{ status: DomainOutboxStatus; count: bigint }>>`
      SELECT "status", COUNT(*) AS count
      FROM "domain_outbox_events"
      GROUP BY "status"
    `;
    return rows.reduce((acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    }, empty);
  }

  private findMemoryByIdempotencyKey(tenantId: string, idempotencyKey?: string): DomainOutboxRecord | undefined {
    if (!idempotencyKey) {
      return undefined;
    }
    return [...this.memory.values()].find(
      (record) => record.envelope.tenant_id === tenantId && record.envelope.idempotency_key === idempotencyKey,
    );
  }

  private canClaim(record: DomainOutboxRecord, now: Date): boolean {
    if (record.status === 'PENDING') {
      return record.available_at.getTime() <= now.getTime();
    }
    return record.status === 'PUBLISHING' && !!record.locked_until && record.locked_until.getTime() <= now.getTime();
  }

  private leaseMs(): number {
    return Number(process.env.FENGINE_OUTBOX_LEASE_MS || 30000);
  }

  private retryDelayMs(attempts: number): number {
    const base = Number(process.env.FENGINE_OUTBOX_BACKOFF_MS || 5000);
    return Math.min(base * Math.max(1, 2 ** Math.max(0, attempts - 1)), 300000);
  }

  private async enterTenant(tenantId: string): Promise<void> {
    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
  }

  private async enterSystemContext(): Promise<void> {
    await this.prisma.setTenantContext('*');
  }

  private fromRow(row: any): DomainOutboxRecord {
    return {
      envelope: {
        event_id: row.eventId,
        event_type: row.eventType,
        event_version: row.eventVersion,
        occurred_at: new Date(row.occurredAt).toISOString(),
        tenant_id: row.tenantId,
        aggregate: {
          type: row.aggregateType,
          id: row.aggregateId,
          version: row.aggregateVersion,
        },
        correlation_id: row.correlationId,
        causation_id: row.causationId,
        idempotency_key: row.idempotencyKey || undefined,
        payload: row.payload || {},
        metadata: row.metadata || {},
      },
      status: row.status,
      attempts: row.attempts,
      max_attempts: row.maxAttempts,
      available_at: new Date(row.availableAt),
      locked_until: row.lockedUntil ? new Date(row.lockedUntil) : undefined,
      locked_by: row.lockedBy || undefined,
      published_at: row.publishedAt ? new Date(row.publishedAt) : undefined,
      failed_at: row.failedAt ? new Date(row.failedAt) : undefined,
      last_error: row.lastError || undefined,
      created_at: new Date(row.createdAt),
      updated_at: new Date(row.updatedAt),
    };
  }
}
