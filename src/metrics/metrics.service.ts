import { Injectable } from '@nestjs/common';
import client from 'prom-client';

@Injectable()
export class MetricsService {
  constructor() {
    // Default metrics
    client.collectDefaultMetrics();
  }

  async metrics(): Promise<string> {
    return await client.register.metrics();
  }
}
