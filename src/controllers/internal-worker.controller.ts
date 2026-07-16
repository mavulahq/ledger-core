import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { DomainOutboxPublisherService } from '../domain-events/domain-outbox-publisher.service';
import { ReadProjectionService } from '../read-models/read-projection.service';
import { EngineEventService } from '../worker/engine-event.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { WorkerQueueService } from '../worker/worker-queue.service';
import { DomainEventWorkerCallback, EngineEventCallback, EnqueueEngineEventInput } from '../worker/worker.types';
import { RegulatoryExportSourceService, type RegulatoryExportSourceRequest } from '../regulatory/regulatory-export-source.service';

@Controller('internal/worker')
@RequirePermissions('internal.worker')
export class InternalWorkerController {
  constructor(
    private readonly queue: WorkerQueueService,
    private readonly events: EngineEventService,
    private readonly outboxPublisher: DomainOutboxPublisherService,
    private readonly projections: ReadProjectionService,
    private readonly regulatoryExports: RegulatoryExportSourceService,
  ) {}

  @Post('regulatory-transaction-records')
  async regulatoryTransactionRecords(@Req() req: any, @Body() body: RegulatoryExportSourceRequest) {
    this.assertTenant(req, body?.tenant_id);
    if (!body?.institution_id || body.institution_id !== req.identity?.institution_id) {
      throw new ForbiddenException('Authenticated institution context does not match the request');
    }
    try {
      return await this.regulatoryExports.page(body);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Post('jobs')
  enqueue(@Req() req: any, @Body() body: EnqueueEngineEventInput) {
    this.validateEvent(body);
    this.assertTenant(req, body.tenant_id);
    return this.queue.enqueue({
      ...body,
      payload: body.payload || {},
      max_attempts: body.max_attempts || 3,
    });
  }

  @Get('jobs/:jobId')
  async get(@Req() req: any, @Param('jobId') jobId: string) {
    const job = await this.queue.get(this.tenant(req), jobId);
    if (!job) {
      throw new NotFoundException(`Worker job not found: ${jobId}`);
    }
    return job;
  }

  @Post('events')
  callback(@Req() req: any, @Body() body: EngineEventCallback) {
    if (!body?.job_id) throw new BadRequestException('job_id is required');
    this.validateEvent(body);
    this.assertTenant(req, body.tenant_id);
    return this.events.handle({ ...body, payload: body.payload || {} });
  }

  @Post('domain-events')
  domainCallback(@Req() req: any, @Body() body: DomainEventWorkerCallback) {
    if (!body?.event) throw new BadRequestException('event is required');
    this.assertTenant(req, body.event.tenant_id);
    return this.events.handleDomainEvent(body.event, body.job_id);
  }

  @Post('outbox/publish')
  publishOutbox(@Req() req: any, @Body() body: { limit?: number } = {}) {
    const limit = body.limit === undefined ? undefined : Number(body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return this.outboxPublisher.publishPending(this.tenant(req), limit);
  }

  @Post('projections/rebuild')
  rebuildProjections(@Req() req: any, @Body() body: { tenant_id?: string; projection_name?: string } = {}) {
    let projectionName;
    try {
      projectionName = body.projection_name
        ? this.projections.projectionName(body.projection_name)
        : undefined;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const tenantId = this.tenant(req);
    if (body.tenant_id) this.assertTenant(req, body.tenant_id);
    return this.projections.rebuild({
      tenantId,
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

  private assertTenant(req: any, tenantId: string | undefined): void {
    if (!tenantId || tenantId !== this.tenant(req)) {
      throw new ForbiddenException('Authenticated tenant context does not match the request');
    }
  }

  private tenant(req: any): string {
    return req.tenantId;
  }
}
