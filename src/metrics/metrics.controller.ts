/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { Public } from '../auth/public.decorator';
import { MetricsTokenGuard } from '../auth/metrics-token.guard';

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  @Public()
  @UseGuards(MetricsTokenGuard)
  async metrics(@Res() res: any) {
    const body = await this.metricsService.metrics();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(body);
  }
}
