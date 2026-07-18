import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../services/prisma.service';
import { CommittedBusinessConflictException } from './committed-business-conflict.exception';

export interface IdempotentRequestContext {
  tenantId: string;
  operation: string;
  key: unknown;
  actorId: string;
  correlationId?: string;
  method: string;
  params: unknown;
  query: unknown;
  body: unknown;
}

export interface IdempotentExecutionResult<T> {
  body: T;
  status: number;
  replayed: boolean;
}

interface ReceiptRow {
  requestHash: string;
  httpStatus: number;
  responseBody: unknown;
}

@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);
  private cleanupTimer?: NodeJS.Timeout;
  private readonly retentionDays = this.integer('LEDGER_CORE_IDEMPOTENCY_RETENTION_DAYS', 365, 1, 3650);
  private readonly cleanupIntervalMs = this.integer('LEDGER_CORE_IDEMPOTENCY_CLEANUP_INTERVAL_MS', 3_600_000, 60_000, 86_400_000);
  private readonly cleanupBatchSize = this.integer('LEDGER_CORE_IDEMPOTENCY_CLEANUP_BATCH_SIZE', 500, 1, 5000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'production' && !this.prisma.isConfigured) {
      throw new Error('DATABASE_URL is required for durable idempotency in production');
    }
    if (this.prisma.isConfigured) {
      this.cleanupTimer = setInterval(() => void this.cleanup(), this.cleanupIntervalMs);
      this.cleanupTimer.unref();
      void this.refreshStatus();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async execute<T>(
    context: IdempotentRequestContext,
    status: () => number,
    operation: () => Promise<T>,
  ): Promise<IdempotentExecutionResult<T>> {
    const key = this.requireKey(context.key);
    if (!this.prisma.isConfigured) {
      this.metrics.recordIdempotency(context.operation, 'unavailable');
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'IDEMPOTENCY_STORE_UNAVAILABLE',
        message: 'Durable idempotency storage is unavailable',
      });
    }

    const keyDigest = this.digest(key);
    const requestHash = this.digest(this.canonical({
      method: context.method.toUpperCase(),
      operation: context.operation,
      actor_id: context.actorId,
      params: context.params || {},
      query: context.query || {},
      body: context.body ?? null,
    }));

    try {
      const result = await this.prisma.withTenant(context.tenantId, async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${context.tenantId}:${context.operation}:${keyDigest}`}, 0)
          )::text AS "lock"
        `;
        const rows = await tx.$queryRaw<ReceiptRow[]>`
          SELECT "requestHash", "httpStatus", "responseBody"
          FROM "idempotency_receipts"
          WHERE "tenantId" = ${context.tenantId}
            AND operation = ${context.operation}
            AND "keyDigest" = ${keyDigest}
            AND "expiresAt" > now()
          LIMIT 1
        `;
        const receipt = rows[0];
        if (receipt) {
          if (receipt.requestHash !== requestHash) {
            this.metrics.recordIdempotency(context.operation, 'conflict');
            throw new ConflictException({
              statusCode: 409,
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Idempotency-Key was already used with a different request',
            });
          }
          this.metrics.recordIdempotency(context.operation, 'replayed');
          return { body: receipt.responseBody as T, status: receipt.httpStatus, replayed: true };
        }

        await tx.$queryRaw`
          SELECT public.delete_expired_idempotency_receipt(
            ${context.tenantId}, ${context.operation}, ${keyDigest}
          )
        `;

        let body: T;
        try {
          body = await operation();
        } catch (error) {
          if (error instanceof CommittedBusinessConflictException) {
            return { committedError: error } as const;
          }
          throw error;
        }
        const httpStatus = status();
        if (httpStatus < 200 || httpStatus > 299) {
          throw new Error(`Idempotent operations must complete with a 2xx status, received ${httpStatus}`);
        }
        const completedAt = new Date();
        const expiresAt = new Date(completedAt.getTime() + this.retentionDays * 86_400_000);
        await tx.$executeRaw`
          INSERT INTO "idempotency_receipts" (
            id, "tenantId", operation, "keyDigest", "requestHash", "actorId",
            "correlationId", "httpStatus", "responseBody", "completedAt", "expiresAt"
          ) VALUES (
            ${`idem_${randomUUID()}`}, ${context.tenantId}, ${context.operation}, ${keyDigest}, ${requestHash},
            ${context.actorId}, ${context.correlationId || null}, ${httpStatus},
            CAST(${JSON.stringify(body ?? null)} AS jsonb), ${completedAt}, ${expiresAt}
          )
        `;
        return { body, status: httpStatus, replayed: false } as const;
      });
      if ('committedError' in result) {
        this.metrics.recordIdempotency(context.operation, 'conflict');
        throw result.committedError;
      }
      if (!result.replayed) this.metrics.recordIdempotency(context.operation, 'created');
      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.metrics.recordIdempotency(context.operation, 'failed');
      throw error;
    }
  }

  private requireKey(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key is required',
      });
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must contain 16-128 supported characters',
      });
    }
    return value;
  }

  private canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async cleanup(): Promise<void> {
    try {
      const deleted = await this.prisma.cleanupExpiredIdempotencyReceipts(this.cleanupBatchSize);
      this.metrics.recordIdempotencyCleanup('success', deleted);
      await this.refreshStatus();
    } catch {
      this.metrics.recordIdempotencyCleanup('failure');
      this.logger.error(JSON.stringify({ event: 'idempotency_cleanup_failed', result: 'FAILED' }));
    }
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await this.prisma.globalIdempotencyReceiptStatus();
      this.metrics.setIdempotencyReceiptStatus(status.active, status.expired);
    } catch {
      this.metrics.recordIdempotencyCleanup('failure');
    }
  }

  private integer(name: string, fallback: number, minimum: number, maximum: number): number {
    const value = process.env[name] ? Number(process.env[name]) : fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  }
}
