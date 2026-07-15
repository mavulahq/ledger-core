/*
 * mavula.io - Controlled Account API
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OperatorContext } from '../accounts/account.types';
import { RequirePermissions } from '../auth/permissions.decorator';
import {
  AccountStatementQueryV1Dto,
  CreateAccountStatusTransitionV1Dto,
  CreateAccountV1Dto,
} from '../dto/public.dto';
import { AccountsService } from '../services/accounts.service';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePermissions('finance.read')
  async list(@Req() req: any) {
    return Promise.all((await this.accounts.listAccounts(req.tenantId)).map((account) => this.publicAccount(account)));
  }

  @Get(':accountId')
  @RequirePermissions('finance.read')
  async get(@Req() req: any, @Param('accountId') accountId: string) {
    return this.publicAccount(await this.accounts.getAccount(req.tenantId, accountId));
  }

  @Get(':accountId/balance')
  @RequirePermissions('finance.read')
  balance(@Req() req: any, @Param('accountId') accountId: string) {
    return this.accounts.getBalance(req.tenantId, accountId);
  }

  @Get(':accountId/statement')
  @RequirePermissions('finance.read')
  statement(
    @Req() req: any,
    @Param('accountId') accountId: string,
    @Query() query: AccountStatementQueryV1Dto,
  ) {
    return this.accounts.statement(req.tenantId, accountId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @RequirePermissions('finance.write')
  async create(@Req() req: any, @Body() body: CreateAccountV1Dto) {
    return this.publicAccount(await this.accounts.createAccount(req.tenantId, body, this.actor(req)));
  }

  @Post(':accountId/status-transitions')
  @RequirePermissions('finance.write')
  async transition(
    @Req() req: any,
    @Param('accountId') accountId: string,
    @Body() body: CreateAccountStatusTransitionV1Dto,
  ) {
    return this.publicLifecycle(await this.accounts.submitLifecycleRequest(
      req.tenantId,
      accountId,
      body.transition,
      body.reason,
      this.actor(req),
    ));
  }

  private actor(req: any): OperatorContext {
    const identity = req.identity || {};
    return {
      subject: identity.sub,
      roles: identity.roles || [],
      permissions: identity.permissions || [],
      institutionId: identity.institution_id,
      branchId: identity.branch_id,
      correlationId: this.correlationId(req.headers?.['x-correlation-id']),
    };
  }

  private correlationId(value: unknown): string {
    return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
      ? value
      : `corr_${randomUUID()}`;
  }

  private publicAccount(account: any) {
    return {
      id: account.id,
      customer_id: account.customerId,
      product_id: account.productId,
      name: account.name,
      currency: account.currency,
      status: account.status,
      balance: account.balance,
      version: account.version,
      frozen_at: account.frozenAt?.toISOString(),
      closed_at: account.closedAt?.toISOString(),
      created_at: account.createdAt.toISOString(),
      updated_at: account.updatedAt.toISOString(),
    };
  }

  private publicLifecycle(request: any) {
    return {
      id: request.id,
      account_id: request.accountId,
      transition: request.transition,
      from_status: request.fromStatus,
      target_status: request.targetStatus,
      status: request.status,
      reason: request.reason,
      requested_by: request.requestedBy,
      decided_by: request.decidedBy,
      decision_reason: request.decisionReason,
      failure_reason: request.failureReason,
      correlation_id: request.correlationId,
      created_at: request.createdAt.toISOString(),
      decided_at: request.decidedAt?.toISOString(),
      applied_at: request.appliedAt?.toISOString(),
    };
  }
}
