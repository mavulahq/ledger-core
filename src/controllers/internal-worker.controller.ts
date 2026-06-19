import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { EngineEventService } from '../worker/engine-event.service';
import { InternalApiKeyGuard } from '../worker/internal-api-key.guard';
import { WorkerQueueService } from '../worker/worker-queue.service';
import { EngineEventCallback, EnqueueEngineEventInput } from '../worker/worker.types';

@Controller('internal/worker')
@UseGuards(InternalApiKeyGuard)
export class InternalWorkerController {
  constructor(
    private readonly queue: WorkerQueueService,
    private readonly events: EngineEventService,
  ) {}

  @Post('jobs')
  enqueue(@Body() body: EnqueueEngineEventInput) {
    this.validateEvent(body);
    return this.queue.enqueue({ ...body, payload: body.payload || {}, max_attempts: body.max_attempts || 3 });
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

  private validateEvent(body: { tenant_id?: string; event_type?: string; max_attempts?: number }) {
    if (!body?.tenant_id) throw new BadRequestException('tenant_id is required');
    if (!body.event_type || !/^[A-Z][A-Z0-9_]{2,100}$/.test(body.event_type)) {
      throw new BadRequestException('event_type must be an uppercase event identifier');
    }
    if (body.max_attempts !== undefined && (!Number.isInteger(Number(body.max_attempts)) || Number(body.max_attempts) < 1)) {
      throw new BadRequestException('max_attempts must be a positive integer');
    }
  }
}
