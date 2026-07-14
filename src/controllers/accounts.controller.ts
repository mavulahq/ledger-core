/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { AccountsService } from '../services/accounts.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreateAccountV1Dto } from '../dto/public.dto';

@Controller('accounts')
export class AccountsController {
  constructor(private svc: AccountsService) {}

  @Get()
  @RequirePermissions('finance.read')
  async list(@Req() req: any) {
    return this.svc.listAccounts(req.tenantId);
  }

  @Post()
  @RequirePermissions('finance.write')
  async create(@Req() req: any, @Body() body: CreateAccountV1Dto) {
    return this.svc.createAccount(req.tenantId, body);
  }
}
