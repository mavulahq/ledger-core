import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const started = process.hrtime.bigint();
    const route = request.route?.path || request.url?.split('?')[0] || 'unknown';
    const complete = (status: number, error?: unknown) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.metrics.observeHttp(request.method || 'UNKNOWN', route, status, seconds);
      if (status === 400 && error instanceof HttpException && Array.isArray((error.getResponse() as any)?.message)) {
        this.metrics.recordContractFailure(route);
      }
    };
    return next.handle().pipe(tap({
      next: () => complete(response.statusCode),
      error: (error) => complete(error instanceof HttpException ? error.getStatus() : 500, error),
    }));
  }
}
