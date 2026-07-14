import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../services/prisma.service';
import {
  DomainEventEnvelope,
  DomainInboxRecord,
  DomainInboxStatus,
  assertDomainEventEnvelope,
} from './domain-event.types';

@Injectable()
export class DomainInboxService {
  private readonly memory = new Map<string, DomainInboxRecord>();

  constructor(private readonly prisma: PrismaService) {}

  async startProcessing(
    envelope: DomainEventEnvelope,
    consumerName: string,
  ): Promise<{
    started: boolean;
    record: DomainInboxRecord;
    idempotent?: boolean;
  }> {
    assertDomainEventEnvelope(envelope);
    const key = this.key(envelope.tenant_id, envelope.event_id, consumerName);

    if (!this.prisma.isConfigured) {
      const existing = this.memory.get(key);
      if (existing?.status === 'PROCESSED') {
        return { started: false, record: existing, idempotent: true };
      }
      if (existing?.status === 'PROCESSING' && !this.isProcessingStale(existing.updated_at)) {
        return { started: false, record: existing, idempotent: true };
      }
      const now = new Date();
      const record: DomainInboxRecord = {
        event_id: envelope.event_id,
        consumer_name: consumerName,
        tenant_id: envelope.tenant_id,
        status: 'PROCESSING',
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      this.memory.set(key, record);
      return { started: true, record };
    }

    const result = await this.prisma.withTenant(envelope.tenant_id, async (tx) => {
      const inserted = await this.insert(envelope, consumerName, tx);
      if (inserted) {
        return { started: true, record: inserted };
      }

      const claimed = await this.claimExisting(
        envelope.tenant_id,
        envelope.event_id,
        consumerName,
        tx,
      );
      if (claimed) {
        return { started: true, record: claimed };
      }

      const existing = await this.find(envelope.tenant_id, envelope.event_id, consumerName, tx);
      if (!existing) {
        throw new Error(
          `Inbox record not found after conflict for ${envelope.event_id}/${consumerName}`,
        );
      }
      return { started: false, record: existing, idempotent: true };
    });
    return result;
  }

  async markProcessed(tenantId: string, eventId: string, consumerName: string): Promise<void> {
    await this.setFinalStatus(tenantId, eventId, consumerName, 'PROCESSED');
  }

  async markFailed(
    tenantId: string,
    eventId: string,
    consumerName: string,
    error: Error,
  ): Promise<void> {
    await this.setFinalStatus(
      tenantId,
      eventId,
      consumerName,
      'FAILED',
      error.message.slice(0, 2000),
    );
  }

  async recordFailed(
    tenantId: string,
    eventId: string,
    consumerName: string,
    error: Error,
  ): Promise<void> {
    const message = error.message.slice(0, 2000);
    const key = this.key(tenantId, eventId, consumerName);
    if (!this.prisma.isConfigured) {
      const now = new Date();
      const existing = this.memory.get(key);
      this.memory.set(key, {
        event_id: eventId,
        consumer_name: consumerName,
        tenant_id: tenantId,
        status: 'FAILED',
        processed_at: existing?.processed_at,
        failed_at: now,
        last_error: message,
        created_at: existing?.created_at || now,
        updated_at: now,
      });
      return;
    }

    await this.prisma.withTenant(tenantId, (tx) => tx.$executeRaw`
        INSERT INTO "domain_inbox_events" (
          "id", "eventId", "consumerName", "tenantId", "status", "failedAt", "lastError", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${eventId}, ${consumerName}, ${tenantId}, 'FAILED', now(), ${message}, now()
        )
        ON CONFLICT ("tenantId", "eventId", "consumerName") DO UPDATE SET
          "status" = 'FAILED',
          "processedAt" = NULL,
          "failedAt" = now(),
          "lastError" = EXCLUDED."lastError",
          "updatedAt" = now()
      `);
  }

  async reset(tenantId: string, eventId: string, consumerName: string): Promise<void> {
    const key = this.key(tenantId, eventId, consumerName);
    if (!this.prisma.isConfigured) {
      this.memory.delete(key);
      return;
    }

    await this.prisma.withTenant(tenantId, (tx) => tx.$executeRaw`
        DELETE FROM "domain_inbox_events"
        WHERE "tenantId" = ${tenantId}
          AND "eventId" = ${eventId}
          AND "consumerName" = ${consumerName}
      `);
  }

  private async setFinalStatus(
    tenantId: string,
    eventId: string,
    consumerName: string,
    status: Extract<DomainInboxStatus, 'PROCESSED' | 'FAILED'>,
    error?: string,
  ): Promise<void> {
    const key = this.key(tenantId, eventId, consumerName);
    if (!this.prisma.isConfigured) {
      const record = this.memory.get(key);
      if (record) {
        this.memory.set(key, {
          ...record,
          status,
          processed_at: status === 'PROCESSED' ? new Date() : record.processed_at,
          failed_at: status === 'FAILED' ? new Date() : record.failed_at,
          last_error: error,
          updated_at: new Date(),
        });
      }
      return;
    }

    await this.prisma.withTenant(tenantId, (tx) => tx.$executeRaw`
        UPDATE "domain_inbox_events"
        SET
          "status" = ${status},
          "processedAt" = ${status === 'PROCESSED' ? new Date() : null},
          "failedAt" = ${status === 'FAILED' ? new Date() : null},
          "lastError" = ${error || null},
          "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      `);
  }

  private async find(
    tenantId: string,
    eventId: string,
    consumerName: string,
    db: any,
  ): Promise<DomainInboxRecord | undefined> {
    const rows = (await db.$queryRaw`
      SELECT * FROM "domain_inbox_events"
      WHERE "tenantId" = ${tenantId} AND "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      LIMIT 1
    `) as any[];
    const [row] = rows;
    return row ? this.fromRow(row) : undefined;
  }

  private async insert(
    envelope: DomainEventEnvelope,
    consumerName: string,
    db: any,
  ): Promise<DomainInboxRecord | undefined> {
    const rows = (await db.$queryRaw`
      INSERT INTO "domain_inbox_events" ("id", "eventId", "consumerName", "tenantId", "status", "updatedAt")
      VALUES (${randomUUID()}, ${envelope.event_id}, ${consumerName}, ${envelope.tenant_id}, 'PROCESSING', now())
      ON CONFLICT ("tenantId", "eventId", "consumerName") DO NOTHING
      RETURNING *
    `) as any[];
    const [row] = rows;
    return row ? this.fromRow(row) : undefined;
  }

  private async claimExisting(
    tenantId: string,
    eventId: string,
    consumerName: string,
    db: any,
  ): Promise<DomainInboxRecord | undefined> {
    const staleBefore = new Date(Date.now() - this.processingLeaseMs());
    const rows = (await db.$queryRaw`
      UPDATE "domain_inbox_events"
      SET "status" = 'PROCESSING', "lastError" = NULL, "updatedAt" = now()
      WHERE "eventId" = ${eventId}
        AND "consumerName" = ${consumerName}
        AND "tenantId" = ${tenantId}
        AND (
          "status" = 'FAILED'
          OR ("status" = 'PROCESSING' AND "updatedAt" <= ${staleBefore})
        )
      RETURNING *
    `) as any[];
    const [row] = rows;
    return row ? this.fromRow(row) : undefined;
  }

  private key(tenantId: string, eventId: string, consumerName: string): string {
    return `${tenantId}:${eventId}:${consumerName}`;
  }

  private isProcessingStale(updatedAt: Date): boolean {
    return updatedAt.getTime() <= Date.now() - this.processingLeaseMs();
  }

  private processingLeaseMs(): number {
    return Number(process.env.FENGINE_INBOX_PROCESSING_LEASE_MS || 300000);
  }

  private fromRow(row: any): DomainInboxRecord {
    return {
      event_id: row.eventId,
      consumer_name: row.consumerName,
      tenant_id: row.tenantId,
      status: row.status,
      processed_at: row.processedAt ? new Date(row.processedAt) : undefined,
      failed_at: row.failedAt ? new Date(row.failedAt) : undefined,
      last_error: row.lastError || undefined,
      created_at: new Date(row.createdAt),
      updated_at: new Date(row.updatedAt),
    };
  }
}
