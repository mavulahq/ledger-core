/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, Get, Req } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health(@Req() req: any) {
    return { status: 'ok', tenant: req.tenantId || null };
  }
}
