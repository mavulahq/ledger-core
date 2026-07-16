import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';

export const AUDIT_TRAIL_STAGES = [
  'REQUESTED',
  'VALIDATED',
  'EVALUATED',
  'AUTHORIZED',
  'POSTED',
  'CONFIGURED',
  'DISPATCHED',
] as const;
export type AuditTrailStage = (typeof AUDIT_TRAIL_STAGES)[number];
export type AuditTrailResult = 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'REVERSED';
export type AuditTrailSource = 'API' | 'WORKER' | 'SYSTEM';

export interface AuditTrailEvent {
  id: string;
  tenant_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  phase?: 'OBSERVE' | 'ORIENT' | 'DECIDE' | 'ACT';
  stage?: AuditTrailStage;
  result?: AuditTrailResult;
  source?: AuditTrailSource;
  actor_id?: string;
  actor_roles?: string[];
  institution_id?: string;
  branch_id?: string;
  reason?: string;
  correlation_id?: string;
  causation_id?: string;
  approval_reference?: string;
  metadata: Record<string, any>;
  created_at: Date;
}

export type AuditTrailWriteEvent = Omit<AuditTrailEvent, 'id' | 'created_at' | 'phase'> & {
  stage: AuditTrailStage;
  result: AuditTrailResult;
  source: AuditTrailSource;
};

@Injectable()
export class AuditTrailService {
  private readonly events = new Map<string, AuditTrailEvent[]>();

  constructor(private readonly prisma: PrismaService) {}

  record(event: AuditTrailWriteEvent): AuditTrailEvent {
    const entry = this.appendMemory(event);
    const persistence = this.persist(entry);
    const tracked = typeof (this.prisma as any).trackTenantOperation === 'function'
      && this.prisma.trackTenantOperation(persistence);
    if (!tracked) {
      void persistence.catch(() => undefined);
    }
    return entry;
  }

  async recordInTransaction(
    tx: Prisma.TransactionClient,
    event: AuditTrailWriteEvent,
  ): Promise<AuditTrailEvent> {
    const entry = this.buildEntry(event);
    await this.persistWithTransaction(tx, entry);
    return entry;
  }

  async listByTenant(tenantId: string): Promise<AuditTrailEvent[]> {
    if (this.prisma.isConfigured) {
      const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>`
          SELECT * FROM "audit_trail_events"
          WHERE "tenantId" = ${tenantId}
          ORDER BY "createdAt" DESC
        `);
      return rows.map((row) => ({
        id: row.id,
        tenant_id: row.tenantId,
        action: row.action,
        entity_type: row.entityType,
        entity_id: row.entityId,
        phase: row.phase as AuditTrailEvent['phase'],
        stage: row.stage as AuditTrailStage | undefined,
        result: row.result as AuditTrailResult | undefined,
        source: row.source as AuditTrailSource | undefined,
        actor_id: row.actorId || undefined,
        actor_roles: this.parseRoles(row.actorRoles),
        institution_id: row.institutionId || undefined,
        branch_id: row.branchId || undefined,
        reason: row.reason || undefined,
        correlation_id: row.correlationId || undefined,
        causation_id: row.causationId || undefined,
        approval_reference: row.approvalReference || undefined,
        metadata: row.metadata as Record<string, any>,
        created_at: row.createdAt,
      }));
    }

    return [...(this.events.get(tenantId) || [])].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
  }

  private async persist(entry: AuditTrailEvent): Promise<void> {
    if (!this.prisma.isConfigured) {
      return;
    }

    await this.prisma.withTenant(entry.tenant_id, (tx) => this.persistWithTransaction(tx, entry));
  }

  private appendMemory(
    event: AuditTrailWriteEvent,
  ): AuditTrailEvent {
    const entry = this.buildEntry(event);
    const tenantEvents = this.events.get(event.tenant_id) || [];
    tenantEvents.push(entry);
    this.events.set(event.tenant_id, tenantEvents);
    return entry;
  }

  private buildEntry(
    event: AuditTrailWriteEvent,
  ): AuditTrailEvent {
    return {
      id: `audit_${randomUUID()}`,
      created_at: new Date(),
      ...event,
    };
  }

  private async persistWithTransaction(
    tx: Prisma.TransactionClient,
    entry: AuditTrailEvent,
  ): Promise<void> {
    await tx.$executeRaw`
        INSERT INTO "audit_trail_events" (
          "id", "tenantId", "action", "entityType", "entityId", "phase", stage,
          result, source, "actorId", "actorRoles", "institutionId", "branchId",
          reason, "correlationId", "causationId", "approvalReference", metadata, "createdAt"
        )
        VALUES (
          ${entry.id}, ${entry.tenant_id}, ${entry.action}, ${entry.entity_type},
          ${entry.entity_id}, NULL, ${entry.stage}, ${entry.result}, ${entry.source},
          ${entry.actor_id || null}, CAST(${JSON.stringify(entry.actor_roles || [])} AS jsonb),
          ${entry.institution_id || null}, ${entry.branch_id || null}, ${entry.reason || null},
          ${entry.correlation_id || null}, ${entry.causation_id || null},
          ${entry.approval_reference || null}, CAST(${JSON.stringify(entry.metadata)} AS jsonb),
          ${entry.created_at}
        )
      `;
  }

  private parseRoles(value: unknown): string[] | undefined {
    if (value === null || value === undefined) return undefined;
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  }
}
