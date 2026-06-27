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
      if (existing && existing.status !== 'FAILED') {
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

    await this.enterTenant(envelope.tenant_id);
    const existing = await this.find(envelope.event_id, consumerName);
    if (existing && existing.status !== 'FAILED') {
      return { started: false, record: existing, idempotent: true };
    }

    const row = existing
      ? await this.updateStatus(envelope.tenant_id, envelope.event_id, consumerName, 'PROCESSING')
      : await this.insert(envelope, consumerName);
    return { started: true, record: row };
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

  private async find(eventId: string, consumerName: string): Promise<DomainInboxRecord | undefined> {
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "domain_inbox_events"
      WHERE "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      LIMIT 1
    `;
    return row ? this.fromRow(row) : undefined;
  }

  private async insert(envelope: DomainEventEnvelope, consumerName: string): Promise<DomainInboxRecord> {
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      INSERT INTO "domain_inbox_events" ("eventId", "consumerName", "tenantId", "status", "updatedAt")
      VALUES (${envelope.event_id}, ${consumerName}, ${envelope.tenant_id}, 'PROCESSING', now())
      RETURNING *
    `;
    return this.fromRow(row);
  }

  private async updateStatus(
    tenantId: string,
    eventId: string,
    consumerName: string,
    status: DomainInboxStatus,
  ): Promise<DomainInboxRecord> {
    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      UPDATE "domain_inbox_events"
      SET "status" = ${status}, "updatedAt" = now()
      WHERE "eventId" = ${eventId} AND "consumerName" = ${consumerName}
      RETURNING *
    `;
    return this.fromRow(row);
  }

  private async enterTenant(tenantId: string): Promise<void> {
    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
  }

  private key(eventId: string, consumerName: string): string {
    return `${eventId}:${consumerName}`;
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
