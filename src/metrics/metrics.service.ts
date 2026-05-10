/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 */

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
