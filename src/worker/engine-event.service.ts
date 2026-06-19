import { Injectable } from '@nestjs/common';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';
import { AuditTrailService } from '../services/audit-trail.service';
import { EngineEventCallback } from './worker.types';

@Injectable()
export class EngineEventService {
  private readonly completed = new Map<string, any>();

  constructor(
    private readonly schemas: SchemaManagerService,
    private readonly auditTrail: AuditTrailService,
  ) {}

  async handle(event: EngineEventCallback) {
    const replay = this.completed.get(event.job_id);
    if (replay) {
      return { ...replay, idempotent: true };
    }

    const workflows = await this.schemas.getWorkflowsByTrigger(event.tenant_id, event.event_type);
    const context = {
      ...(event.payload || {}),
      job_id: event.job_id,
      tenant_id: event.tenant_id,
      event_type: event.event_type,
    };
    const executions = [];
    for (const workflow of workflows) {
      executions.push({
        workflow_id: workflow.workflow_id,
        ...(await this.schemas.executeWorkflow(event.tenant_id, workflow.workflow_id, context)),
      });
    }

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
      metadata: { event_type: event.event_type, executed_workflows: executions.length },
    });
    return result;
  }
}
