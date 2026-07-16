import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';

type IdempotencyOutcome = 'created' | 'replayed' | 'conflict' | 'failed' | 'unavailable';

@Injectable()
export class MetricsService {
  private static defaultMetricsStarted = false;

  private readonly httpRequests = this.counter('ledger_core_http_requests_total', 'HTTP requests handled by ledger-core', [
    'method', 'route', 'status',
  ]);
  private readonly httpDuration = this.histogram(
    'ledger_core_http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route', 'status'],
  );
  private readonly idempotencyRequests = this.counter(
    'ledger_core_idempotency_requests_total',
    'Idempotent request outcomes',
    ['operation', 'outcome'],
  );
  private readonly idempotencyCleanup = this.counter(
    'ledger_core_idempotency_cleanup_total',
    'Idempotency receipt cleanup outcomes',
    ['outcome'],
  );
  private readonly idempotencyActive = this.gauge(
    'ledger_core_idempotency_receipts_active',
    'Active durable idempotency receipts',
  );
  private readonly idempotencyExpired = this.gauge(
    'ledger_core_idempotency_receipts_expired',
    'Expired durable idempotency receipts awaiting cleanup',
  );
  private readonly securityFailures = this.counter(
    'ledger_core_security_failures_total',
    'Authentication and tenant boundary failures',
    ['boundary', 'reason'],
  );
  private readonly contractFailures = this.counter(
    'ledger_core_contract_validation_failures_total',
    'Public request contract validation failures',
    ['route'],
  );
  private readonly adjustmentOutcomes = this.counter(
    'ledger_core_financial_adjustments_total',
    'Financial adjustment outcomes',
    ['adjustment_type', 'result'],
  );

  constructor() {
    if (!MetricsService.defaultMetricsStarted) {
      client.collectDefaultMetrics({ prefix: 'ledger_core_' });
      MetricsService.defaultMetricsStarted = true;
    }
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, seconds);
  }

  recordIdempotency(operation: string, outcome: IdempotencyOutcome): void {
    this.idempotencyRequests.inc({ operation, outcome });
  }

  recordIdempotencyCleanup(outcome: 'success' | 'failure', deleted = 0): void {
    this.idempotencyCleanup.inc({ outcome }, outcome === 'success' ? Math.max(1, deleted) : 1);
  }

  setIdempotencyReceiptStatus(active: number, expired: number): void {
    this.idempotencyActive.set(active);
    this.idempotencyExpired.set(expired);
  }

  recordSecurityFailure(boundary: 'authentication' | 'tenant', reason: string): void {
    this.securityFailures.inc({ boundary, reason });
  }

  recordContractFailure(route: string): void {
    this.contractFailures.inc({ route });
  }

  recordAdjustment(adjustmentType: string, result: string): void {
    this.adjustmentOutcomes.inc({ adjustment_type: adjustmentType, result });
  }

  async metrics(): Promise<string> {
    return client.register.metrics();
  }

  private counter(name: string, help: string, labelNames: string[]): client.Counter<string> {
    return (client.register.getSingleMetric(name) as client.Counter<string>) || new client.Counter({ name, help, labelNames });
  }

  private histogram(name: string, help: string, labelNames: string[]): client.Histogram<string> {
    return (client.register.getSingleMetric(name) as client.Histogram<string>) || new client.Histogram({
      name,
      help,
      labelNames,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    });
  }

  private gauge(name: string, help: string): client.Gauge<string> {
    return (client.register.getSingleMetric(name) as client.Gauge<string>) || new client.Gauge({ name, help });
  }
}
