import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OperatorContext } from '../accounts/account.types';
import { RequirePermissions } from '../auth/permissions.decorator';
import {
  AccountLifecycleListQueryV1Dto,
  ApproveAccountLifecycleV1Dto,
  RejectAccountLifecycleV1Dto,
} from '../dto/public.dto';
import { AccountsService } from '../services/accounts.service';
import { IdempotentOperation } from '../idempotency/idempotent-operation.decorator';

@Controller('account-lifecycle-requests')
export class AccountLifecycleController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePermissions('finance.read')
  async list(@Req() req: any, @Query() query: AccountLifecycleListQueryV1Dto) {
    const page = await this.accounts.listLifecycleRequests(req.tenantId, {
      accountId: query.account_id,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((request) => this.publicRequest(request)),
      next_cursor: page.next_cursor,
    };
  }

  @Get(':requestId')
  @RequirePermissions('finance.read')
  async get(@Req() req: any, @Param('requestId') requestId: string) {
    return this.publicRequest(await this.accounts.getLifecycleRequest(req.tenantId, requestId));
  }

  @Post(':requestId/approve')
  @RequirePermissions('finance.approve')
  @IdempotentOperation('account-lifecycle.approve')
  async approve(
    @Req() req: any,
    @Param('requestId') requestId: string,
    @Body() body: ApproveAccountLifecycleV1Dto,
  ) {
    return this.publicRequest(await this.accounts.approveLifecycleRequest(
      req.tenantId,
      requestId,
      body.reason,
      this.actor(req),
    ));
  }

  @Post(':requestId/reject')
  @RequirePermissions('finance.approve')
  @IdempotentOperation('account-lifecycle.reject')
  async reject(
    @Req() req: any,
    @Param('requestId') requestId: string,
    @Body() body: RejectAccountLifecycleV1Dto,
  ) {
    return this.publicRequest(await this.accounts.rejectLifecycleRequest(
      req.tenantId,
      requestId,
      body.reason,
      this.actor(req),
    ));
  }

  private actor(req: any): OperatorContext {
    const identity = req.identity || {};
    const supplied = req.headers?.['x-correlation-id'];
    return {
      subject: identity.sub,
      roles: identity.roles || [],
      permissions: identity.permissions || [],
      institutionId: identity.institution_id,
      branchId: identity.branch_id,
      correlationId: typeof supplied === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)
        ? supplied
        : `corr_${randomUUID()}`,
    };
  }

  private publicRequest(request: any) {
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
