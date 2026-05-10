/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 */

import { Controller, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get('metrics')
  async metrics(@Res() res: any) {
    const body = await this.metrics.metrics();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(body);
  }
}
