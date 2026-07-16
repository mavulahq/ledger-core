import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FinancialAdjustmentsService } from '../adjustments/financial-adjustments.service';
import type { FinancialAdjustmentRecord } from '../adjustments/financial-adjustment.types';
import type { OperatorContext } from '../accounts/account.types';
import { RequirePermissions } from '../auth/permissions.decorator';
import {
  ApproveFinancialAdjustmentV1Dto,
  CreateFinancialAdjustmentV1Dto,
  FinancialAdjustmentListQueryV1Dto,
  RejectFinancialAdjustmentV1Dto,
} from '../dto/public.dto';
import { IdempotentOperation } from '../idempotency/idempotent-operation.decorator';
import { MetricsService } from '../metrics/metrics.service';

@Controller('financial-adjustment-requests')
export class FinancialAdjustmentsController {
  constructor(
    private readonly adjustments: FinancialAdjustmentsService,
    private readonly metrics?: MetricsService,
  ) {}

  @Post()
  @RequirePermissions('finance.write')
  @IdempotentOperation('financial-adjustments.submit')
  async submit(@Req() req: any, @Body() body: CreateFinancialAdjustmentV1Dto) {
    const correction = body.correction ? {
      lending: body.correction.lending ? {
        amount: body.correction.lending.amount,
        currency: body.correction.lending.currency,
        allocation: body.correction.lending.allocation,
      } : undefined,
      journal: body.correction.journal ? {
        ledgerLines: body.correction.journal.ledger_lines.map((line) => ({
          account_code: line.account_code,
          debit_amount: line.debit_amount ? Number(line.debit_amount) : undefined,
          credit_amount: line.credit_amount ? Number(line.credit_amount) : undefined,
        })),
        accountPostings: body.correction.journal.account_postings?.map((posting) => ({
          accountId: posting.account_id,
          direction: posting.direction,
          amount: posting.amount,
          currency: posting.currency,
          reference: posting.reference,
        })),
      } : undefined,
    } : undefined;
    const request = await this.adjustments.submit(req.tenantId, {
      targetType: body.target_type,
      targetId: body.target_id,
      adjustmentType: body.adjustment_type,
      reason: body.reason,
      correction,
    }, this.actor(req));
    this.metrics?.recordAdjustment(request.adjustmentType, 'requested');
    return this.publicRequest(request);
  }

  @Get()
  @RequirePermissions('finance.read')
  async list(@Req() req: any, @Query() query: FinancialAdjustmentListQueryV1Dto) {
    const page = await this.adjustments.list(req.tenantId, {
      status: query.status,
      adjustmentType: query.adjustment_type,
      targetType: query.target_type,
      targetId: query.target_id,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((request) => this.publicRequest(request)), next_cursor: page.next_cursor };
  }

  @Get(':requestId')
  @RequirePermissions('finance.read')
  async get(@Req() req: any, @Param('requestId') requestId: string) {
    return this.publicRequest(await this.adjustments.get(req.tenantId, requestId));
  }

  @Post(':requestId/approve')
  @RequirePermissions('finance.approve')
  @IdempotentOperation('financial-adjustments.approve')
  async approve(
    @Req() req: any,
    @Param('requestId') requestId: string,
    @Body() body: ApproveFinancialAdjustmentV1Dto,
  ) {
    const request = await this.adjustments.approve(req.tenantId, requestId, body.reason, this.actor(req));
    this.metrics?.recordAdjustment(request.adjustmentType, request.status.toLowerCase());
    return this.publicRequest(request);
  }

  @Post(':requestId/reject')
  @RequirePermissions('finance.approve')
  @IdempotentOperation('financial-adjustments.reject')
  async reject(
    @Req() req: any,
    @Param('requestId') requestId: string,
    @Body() body: RejectFinancialAdjustmentV1Dto,
  ) {
    const request = await this.adjustments.reject(req.tenantId, requestId, body.reason, this.actor(req));
    this.metrics?.recordAdjustment(request.adjustmentType, request.status.toLowerCase());
    return this.publicRequest(request);
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

  private publicRequest(request: FinancialAdjustmentRecord) {
    return {
      id: request.id,
      target_type: request.targetType,
      target_id: request.targetId,
      adjustment_type: request.adjustmentType,
      status: request.status,
      reason: request.reason,
      correction: request.correction,
      target_transaction_id: request.targetTransactionId,
      target_journal_entry_id: request.targetJournalEntryId,
      target_loan_id: request.targetLoanId,
      requested_by: request.requestedBy,
      decided_by: request.decidedBy,
      decision_reason: request.decisionReason,
      failure_reason: request.failureReason,
      correlation_id: request.correlationId,
      reversal_transaction_id: request.reversalTransactionId,
      reversal_journal_entry_id: request.reversalJournalEntryId,
      replacement_transaction_id: request.replacementTransactionId,
      replacement_journal_entry_id: request.replacementJournalEntryId,
      created_at: request.createdAt.toISOString(),
      decided_at: request.decidedAt?.toISOString(),
      applied_at: request.appliedAt?.toISOString(),
    };
  }
}
