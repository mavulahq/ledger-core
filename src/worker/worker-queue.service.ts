import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Job, JobsOptions, Queue } from 'bullmq';
import { EngineWorkerJob, EnqueueEngineEventInput } from './worker.types';

@Injectable()
export class WorkerQueueService implements OnModuleDestroy {
  private readonly memory = new Map<string, EngineWorkerJob>();
  private readonly queue = this.usesMemory()
    ? undefined
    : new Queue('platform', { connection: this.redisConnection() });

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(input: EnqueueEngineEventInput): Promise<EngineWorkerJob> {
    const now = new Date().toISOString();
    const id = this.jobId(input.idempotency_key);
    const job: EngineWorkerJob = {
      id,
      queue: 'platform',
      type: 'FENGINE_EVENT',
      tenant_id: input.tenant_id,
      payload: { ...(input.payload || {}), event_type: input.event_type },
      status: 'QUEUED',
      attempts: 0,
      max_attempts: input.max_attempts || 3,
      created_at: now,
      updated_at: now,
    };

    if (!this.queue) {
      this.memory.set(id, job);
      return job;
    }

    const options: JobsOptions = {
      jobId: id,
      attempts: job.max_attempts,
      backoff: {
        type: 'exponential',
        delay: Number(process.env.FENGINE_WORKER_BACKOFF_MS || 5000),
      },
      removeOnComplete: false,
      removeOnFail: false,
    };
    await this.queue.add(job.type, job, options);
    return job;
  }

  async get(jobId: string): Promise<EngineWorkerJob | null> {
    if (!this.queue) {
      return this.memory.get(jobId) || null;
    }

    const job = await this.queue.getJob(jobId);
    return job ? this.fromBullJob(job) : null;
  }

  private usesMemory(): boolean {
    return process.env.FENGINE_QUEUE_BACKEND === 'memory' || process.env.NODE_ENV === 'test';
  }

  private redisConnection() {
    const parsed = new URL(process.env.REDIS_URL || 'redis://localhost:16379');
    return {
      host: parsed.hostname || 'localhost',
      port: Number(parsed.port || 6379),
      password: parsed.password || undefined,
      db: parsed.pathname ? Number(parsed.pathname.slice(1) || 0) : 0,
      maxRetriesPerRequest: null,
    };
  }

  private jobId(idempotencyKey?: string): string {
    if (!idempotencyKey) {
      return `fengine-${randomUUID()}`;
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(idempotencyKey)) {
      throw new Error('idempotency_key must use letters, numbers, underscore, or dash');
    }
    return `fengine-${idempotencyKey}`;
  }

  private async fromBullJob(job: Job): Promise<EngineWorkerJob> {
    const data = job.data as EngineWorkerJob;
    const state = await job.getState();
    return {
      ...data,
      id: String(job.id || data.id),
      status: this.mapState(state),
      attempts: job.attemptsMade,
      updated_at: new Date(job.processedOn || job.finishedOn || job.timestamp).toISOString(),
      result: job.returnvalue,
      last_error: job.failedReason || undefined,
    };
  }

  private mapState(state: string): EngineWorkerJob['status'] {
    if (state === 'completed') return 'COMPLETED';
    if (state === 'active') return 'PROCESSING';
    if (state === 'failed') return 'FAILED';
    return 'QUEUED';
  }
}
