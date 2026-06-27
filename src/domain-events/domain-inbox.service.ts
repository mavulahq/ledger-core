import { Injectable } from '@nestjs/common';
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
    const key = this.key(envelope.event_id, consumerName);

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

    const result = await this.prisma.db.$transaction(async (tx: any) => {
      await this.enterTenant(envelope.tenant_id, tx);
      const inserted = await this.insert(envelope, consumerName, tx);
      if (inserted) {
        return { started: true, record: inserted };
      }

      const existing = await this.find(envelope.event_id, consumerName, tx);
      if (!existing) {
        throw new Error(`Inbox record not found after conflict for ${envelope.event_id}/${consumerName}`);
      }
      if (existing.status === 'PROCESSED') {
        return { started: false, record: existing, idempotent: true };
      }
      if (existing.status === 'PROCESSING' && !this.isProcessingStale(existing.updated_at)) {
        return { started: false, record: existing, idempotent: true };
      }

      const row = await this.updateStatus(envelope.tenant_id, envelope.event_id, consumerName, 'PROCESSING', tx);
      return { started: true, record: row };
    });
    return result;
  }

  async markProcessed(tenantId: string, eventId: string, consumerName: string): Promise<void> {
    await this.setFinalStatus(tenantId, eventId, consumerName, 'PROCESSED');
  }

  async markFailed(tenantId: string, eventId: string, consumerName: string, error: Error): Promise<void> {
    await this.setFinalStatus(tenantId, eventId, consumerName, 'FAILED', error.message.slice(0, 2000));
  }

  private async setFinalStatus(
    tenantId: string,
    eventId: string,
    consumerName: string,
    status: Extract<DomainInboxStatus, 'PROCESSED' | 'FAILED'>,
    error?: string,
  ): Promise<void> {
    const key = this.key(eventId, consumerName);
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

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      UPDATE "domain_inbox_events"
      SET
        "status" = ${status},
        "processedAt" = ${status === 'PROCESSED' ? new Date() : null},
        "failedAt" = ${status === 'FAILED' ? new Date() : null},
        "lastError" = ${error || null},
        "updatedAt" = now()
      WHERE "eventId" = ${eventId} AND "consumerName" = ${consumerName}
    `;
  }

  private async find(eventId: string, consumerName: string, db = this.prisma.db): Promise<DomainInboxRecord | undefined> {
    const rows = await db.$queryRaw`
      SELECT * FROM "domain_inbox_events"
      WHERE "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      LIMIT 1
    ` as any[];
    const [row] = rows;
    return row ? this.fromRow(row) : undefined;
  }

  private async insert(
    envelope: DomainEventEnvelope,
    consumerName: string,
    db = this.prisma.db,
  ): Promise<DomainInboxRecord | undefined> {
    const rows = await db.$queryRaw`
      INSERT INTO "domain_inbox_events" ("eventId", "consumerName", "tenantId", "status", "updatedAt")
      VALUES (${envelope.event_id}, ${consumerName}, ${envelope.tenant_id}, 'PROCESSING', now())
      ON CONFLICT ("eventId", "consumerName") DO NOTHING
      RETURNING *
    ` as any[];
    const [row] = rows;
    return row ? this.fromRow(row) : undefined;
  }

  private async updateStatus(
    tenantId: string,
    eventId: string,
    consumerName: string,
    status: DomainInboxStatus,
    db = this.prisma.db,
  ): Promise<DomainInboxRecord> {
    await this.enterTenant(tenantId, db);
    const rows = await db.$queryRaw`
      UPDATE "domain_inbox_events"
      SET "status" = ${status}, "lastError" = NULL, "updatedAt" = now()
      WHERE "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      RETURNING *
    ` as any[];
    const [row] = rows;
    return this.fromRow(row);
  }

  private async enterTenant(tenantId: string, db = this.prisma.db): Promise<void> {
    await this.prisma.ensureTenant(tenantId);
    if (db === this.prisma.db) {
      await this.prisma.setTenantContext(tenantId);
      return;
    }
    await db.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
  }

  private key(eventId: string, consumerName: string): string {
    return `${eventId}:${consumerName}`;
  }

  private isProcessingStale(updatedAt: Date): boolean {
    const leaseMs = Number(process.env.FENGINE_INBOX_PROCESSING_LEASE_MS || 300000);
    return updatedAt.getTime() <= Date.now() - leaseMs;
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
