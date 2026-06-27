import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainOutboxService } from './domain-outbox.service';
import { WorkerQueueService } from '../worker/worker-queue.service';

@Injectable()
export class DomainOutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: DomainOutboxService,
    private readonly queue: WorkerQueueService,
  ) {}

  onModuleInit(): void {
    if (process.env.FENGINE_OUTBOX_PUBLISHER_ENABLED === 'true') {
      this.timer = setInterval(
        () => void this.publishPending().catch((error) => console.error('Outbox publish failed', error)),
        Number(process.env.FENGINE_OUTBOX_POLL_MS || 1000),
      );
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async publishPending(limit = Number(process.env.FENGINE_OUTBOX_BATCH_SIZE || 25)) {
    const claimed = await this.outbox.claimPending(limit);
    let published = 0;
    let failed = 0;

    for (const record of claimed) {
      try {
        await this.queue.enqueueDomainEvent(record.envelope, {
          max_attempts: record.max_attempts,
        });
        await this.outbox.markPublished(record);
        published += 1;
      } catch (error) {
        await this.outbox.markPublishFailed(record, error as Error);
        failed += 1;
      }
    }

    return {
      claimed: claimed.length,
      published,
      failed,
      status: await this.outbox.stats(),
    };
  }
}
