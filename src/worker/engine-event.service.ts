import { Injectable, Optional } from '@nestjs/common';
import { DomainEventEnvelope } from '../domain-events/domain-event.types';
import { DomainInboxService } from '../domain-events/domain-inbox.service';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';
import { AuditTrailService } from '../services/audit-trail.service';
import { EngineEventCallback } from './worker.types';

@Injectable()
export class EngineEventService {
  private readonly completed = new Map<string, any>();

  constructor(
    private readonly schemas: SchemaManagerService,
    private readonly auditTrail: AuditTrailService,
    @Optional() private readonly inbox?: DomainInboxService,
  ) {}

  async handle(event: EngineEventCallback) {
    const replay = this.completed.get(event.job_id);
    if (replay) {
      return { ...replay, idempotent: true };
    }

    const context = {
      ...(event.payload || {}),
      job_id: event.job_id,
      tenant_id: event.tenant_id,
      event_type: event.event_type,
    };
    const executions = await this.executeWorkflows(event.tenant_id, event.event_type, context);

    const result = {
      accepted: true,
      job_id: event.job_id,
      event_type: event.event_type,
      executed_workflows: executions.length,
      executions,
      processed_at: new Date().toISOString(),
    };
    this.completed.set(event.job_id, result);
    this.auditTrail.record({
      tenant_id: event.tenant_id,
      action: 'worker.event.processed',
      entity_type: 'worker_job',
      entity_id: event.job_id,
      phase: 'ACT',
      metadata: {
        event_type: event.event_type,
        executed_workflows: executions.length,
      },
    });
    return result;
  }

  async handleDomainEvent(event: DomainEventEnvelope, jobId?: string) {
    if (!this.inbox) {
      throw new Error('DomainInboxService is required to process domain events');
    }

    const consumerName = 'fengine.workflow-dispatch';
    const processing = await this.inbox.startProcessing(event, consumerName);
    if (!processing.started) {
      return {
        accepted: true,
        event_id: event.event_id,
        event_type: event.event_type,
        consumer: consumerName,
        idempotent: true,
        processed_at: processing.record.processed_at?.toISOString(),
      };
    }

    try {
      const context = {
        ...(event.payload || {}),
        job_id: jobId,
        tenant_id: event.tenant_id,
        event_id: event.event_id,
        event_type: event.event_type,
        domain_event: event,
      };
      const executions = await this.executeWorkflows(event.tenant_id, event.event_type, context);
      await this.inbox.markProcessed(event.tenant_id, event.event_id, consumerName);

      const result = {
        accepted: true,
        event_id: event.event_id,
        event_type: event.event_type,
        consumer: consumerName,
        executed_workflows: executions.length,
        executions,
        processed_at: new Date().toISOString(),
      };
      this.auditTrail.record({
        tenant_id: event.tenant_id,
        action: 'domain_event.processed',
        entity_type: 'domain_event',
        entity_id: event.event_id,
        phase: 'ACT',
        metadata: {
          event_type: event.event_type,
          executed_workflows: executions.length,
        },
      });
      return result;
    } catch (error) {
      await this.inbox.markFailed(event.tenant_id, event.event_id, consumerName, error as Error);
      throw error;
    }
  }

  private async executeWorkflows(tenantId: string, trigger: string, context: Record<string, any>) {
    const workflows = await this.schemas.getWorkflowsByTrigger(tenantId, trigger);
    const executions = [];
    for (const workflow of workflows) {
      executions.push({
        workflow_id: workflow.workflow_id,
        ...(await this.schemas.executeWorkflow(tenantId, workflow.workflow_id, context)),
      });
    }
    return executions;
  }
}
