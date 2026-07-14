import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { DomainOutboxPublisherService } from '../domain-events/domain-outbox-publisher.service';
import { ReadProjectionService } from '../read-models/read-projection.service';
import { EngineEventService } from '../worker/engine-event.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { WorkerQueueService } from '../worker/worker-queue.service';
import { DomainEventWorkerCallback, EngineEventCallback, EnqueueEngineEventInput } from '../worker/worker.types';

@Controller('internal/worker')
@RequirePermissions('internal.worker')
export class InternalWorkerController {
  constructor(
    private readonly queue: WorkerQueueService,
    private readonly events: EngineEventService,
    private readonly outboxPublisher: DomainOutboxPublisherService,
    private readonly projections: ReadProjectionService,
  ) {}

  @Post('jobs')
  enqueue(@Body() body: EnqueueEngineEventInput) {
    this.validateEvent(body);
    return this.queue.enqueue({
      ...body,
      payload: body.payload || {},
      max_attempts: body.max_attempts || 3,
    });
  }

  @Get('jobs/:jobId')
  async get(@Param('jobId') jobId: string) {
    const job = await this.queue.get(jobId);
    if (!job) {
      throw new NotFoundException(`Worker job not found: ${jobId}`);
    }
    return job;
  }

  @Post('events')
  callback(@Body() body: EngineEventCallback) {
    if (!body?.job_id) throw new BadRequestException('job_id is required');
    this.validateEvent(body);
    return this.events.handle({ ...body, payload: body.payload || {} });
  }

  @Post('domain-events')
  domainCallback(@Body() body: DomainEventWorkerCallback) {
    if (!body?.event) throw new BadRequestException('event is required');
    return this.events.handleDomainEvent(body.event, body.job_id);
  }

  @Post('outbox/publish')
  publishOutbox(@Body() body: { limit?: number } = {}) {
    const limit = body.limit === undefined ? undefined : Number(body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return this.outboxPublisher.publishPending(limit);
  }

  @Post('projections/rebuild')
  rebuildProjections(@Body() body: { tenant_id?: string; projection_name?: string } = {}) {
    let projectionName;
    try {
      projectionName = body.projection_name
        ? this.projections.projectionName(body.projection_name)
        : undefined;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return this.projections.rebuild({
      tenantId: body.tenant_id,
      projectionName,
    });
  }

  private validateEvent(body: { tenant_id?: string; event_type?: string; max_attempts?: number }) {
    if (!body?.tenant_id) throw new BadRequestException('tenant_id is required');
    if (!body.event_type || !/^[A-Z][A-Z0-9_]{2,100}$/.test(body.event_type)) {
      throw new BadRequestException('event_type must be an uppercase event identifier');
    }
    if (
      body.max_attempts !== undefined &&
      (!Number.isInteger(Number(body.max_attempts)) || Number(body.max_attempts) < 1)
    ) {
      throw new BadRequestException('max_attempts must be a positive integer');
    }
  }
}
