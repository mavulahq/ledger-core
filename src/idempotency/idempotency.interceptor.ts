import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';
import { IDEMPOTENT_OPERATION } from './idempotent-operation.decorator';
import { IdempotencyService } from './idempotency.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operation = this.reflector.getAllAndOverride<string>(IDEMPOTENT_OPERATION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!operation) return next.handle();

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    return from(this.idempotency.execute({
      tenantId: request.tenantId,
      operation,
      key: request.headers['idempotency-key'],
      actorId: request.identity?.sub,
      correlationId: this.correlationId(request.headers['x-correlation-id']),
      method: request.method,
      params: request.params,
      query: request.query,
      body: request.body,
    }, () => response.statusCode, () => lastValueFrom(next.handle())).then((result) => {
      response.status(result.status);
      if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
      return result.body;
    }));
  }

  private correlationId(value: unknown): string | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
  }
}
