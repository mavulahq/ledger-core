/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly requestCounter: client.Counter<string>;

  constructor() {
    // Default metrics
    client.collectDefaultMetrics();
    this.requestCounter =
      (client.register.getSingleMetric('http_requests_total') as client.Counter<string>) ||
      new client.Counter({
        name: 'http_requests_total',
        help: 'Total HTTP requests observed by the service',
      });
    this.requestCounter.inc();
  }

  async metrics(): Promise<string> {
    return await client.register.metrics();
  }
}
