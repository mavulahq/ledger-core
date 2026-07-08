/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  async metrics(@Res() res: any) {
    const body = await this.metricsService.metrics();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(body);
  }
}
