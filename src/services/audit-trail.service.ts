import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface AuditTrailEvent {
  id: string;
  tenant_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  phase?: 'OBSERVE' | 'ORIENT' | 'DECIDE' | 'ACT';
  actor_id?: string;
  metadata: Record<string, any>;
  created_at: Date;
}

@Injectable()
export class AuditTrailService {
  private readonly events = new Map<string, AuditTrailEvent[]>();

  constructor(private readonly prisma: PrismaService) {}

  record(event: Omit<AuditTrailEvent, 'id' | 'created_at'>): AuditTrailEvent {
    const entry: AuditTrailEvent = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date(),
      ...event,
    };

    const tenantEvents = this.events.get(event.tenant_id) || [];
    tenantEvents.push(entry);
    this.events.set(event.tenant_id, tenantEvents);
    void this.persist(entry);
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
        actor_id: row.actorId || undefined,
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

    await this.prisma.withTenant(entry.tenant_id, (tx) => tx.$executeRaw`
        INSERT INTO "audit_trail_events" ("id", "tenantId", "action", "entityType", "entityId", "phase", "actorId", "metadata", "createdAt")
        VALUES (${entry.id}, ${entry.tenant_id}, ${entry.action}, ${entry.entity_type}, ${entry.entity_id}, ${entry.phase || null}, ${entry.actor_id || null}, CAST(${JSON.stringify(entry.metadata)} AS jsonb), ${entry.created_at})
      `);
  }
}
