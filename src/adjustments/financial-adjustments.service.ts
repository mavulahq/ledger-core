import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import type {
  AccountEntryRecord,
  AccountPostingInput,
  OperatorContext,
  TenantTransaction,
} from '../accounts/account.types';
import { DomainEventFactory } from '../domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../domain-events/domain-outbox.service';
import type { JournalEntry, LedgerLine } from '../ledger/ledger.service';
import { LedgerService } from '../ledger/ledger.service';
import type { Loan } from '../loans/loan.service';
import { LoanStatus } from '../loans/loan.service';
import { TransactionStatus, TransactionType, type Transaction } from '../transactions/transaction.service';
import { AccountsService } from '../services/accounts.service';
import { AuditTrailService } from '../services/audit-trail.service';
import { FengineStoreService } from '../services/fengine-store.service';
import { PrismaService } from '../services/prisma.service';
import { CommittedBusinessConflictException } from '../idempotency/committed-business-conflict.exception';
import {
  CreateFinancialAdjustmentInput,
  FinancialAdjustmentCorrection,
  FinancialAdjustmentListQuery,
  FinancialAdjustmentRecord,
  FinancialAdjustmentStatus,
} from './financial-adjustment.types';

interface ResolvedTarget {
  transaction?: Transaction;
  journal: JournalEntry;
  loan?: Loan;
  accountEntries: AccountEntryRecord[];
}

interface AdjustmentApplication {
  reversalTransactionId?: string;
  reversalJournalEntryId: string;
  replacementTransactionId?: string;
  replacementJournalEntryId?: string;
  loan?: Loan;
  amount: string;
  currency: string;
  allocation?: { principal: string; interest: string; fees: string };
  lendingOperation?: 'LOAN_PAYMENT' | 'LOAN_DISBURSEMENT';
}

@Injectable()
export class FinancialAdjustmentsService {
  private readonly memory = new Map<string, Map<string, FinancialAdjustmentRecord>>();
  private readonly memoryLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: FengineStoreService,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditTrailService,
    private readonly eventFactory: DomainEventFactory,
    private readonly outbox: DomainOutboxService,
  ) {}

  async submit(
    tenantId: string,
    input: CreateFinancialAdjustmentInput,
    actor: OperatorContext,
  ): Promise<FinancialAdjustmentRecord> {
    this.assertInput(input);
    if (!this.prisma.isConfigured) {
      const target = await this.resolveMemoryTarget(tenantId, input.targetType, input.targetId);
      this.assertEligibleTarget(tenantId, input, target);
      await this.validateMemoryReferences(tenantId, input, target);
      const requests = this.memory.get(tenantId) || new Map<string, FinancialAdjustmentRecord>();
      if ([...requests.values()].some((request) =>
        request.targetJournalEntryId === target.journal.entry_id
        && ['PENDING_APPROVAL', 'APPLIED'].includes(request.status))) {
        throw new ConflictException('Financial target already has an active adjustment');
      }
      const request = this.buildRequest(tenantId, input, actor, target);
      requests.set(request.id, request);
      this.memory.set(tenantId, requests);
      this.audit.record(this.auditEvent(request, actor, 'financial.adjustment.requested', 'REQUESTED', 'PENDING'));
      return request;
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const target = await this.resolveTargetInTransaction(tx, tenantId, input.targetType, input.targetId);
        this.assertEligibleTarget(tenantId, input, target);
        await this.validateConfiguredReferences(tx, tenantId, input, target);
        const [active] = await tx.$queryRaw<any[]>`
          SELECT id FROM "financial_adjustment_requests"
          WHERE "tenantId" = ${tenantId}
            AND "targetJournalEntryId" = ${target.journal.entry_id}
            AND status IN ('PENDING_APPROVAL', 'APPLIED')
          LIMIT 1
        `;
        if (active) throw new ConflictException('Financial target already has an active adjustment');
        const request = this.buildRequest(tenantId, input, actor, target);
        const [row] = await tx.$queryRaw<any[]>`
          INSERT INTO "financial_adjustment_requests" (
            id, "tenantId", "targetType", "targetId", "adjustmentType", status,
            reason, correction, "targetTransactionId", "targetJournalEntryId",
            "targetLoanId", "expectedLoanVersion", "requestedBy", "requestedRoles",
            "institutionId", "branchId", "correlationId", "updatedAt"
          )
          VALUES (
            ${request.id}, ${tenantId}, ${request.targetType}, ${request.targetId},
            ${request.adjustmentType}, 'PENDING_APPROVAL', ${request.reason},
            ${request.correction ? Prisma.sql`CAST(${this.json(request.correction)} AS jsonb)` : null},
            ${request.targetTransactionId || null}, ${request.targetJournalEntryId},
            ${request.targetLoanId || null}, ${request.expectedLoanVersion || null},
            ${request.requestedBy}, CAST(${this.json(request.requestedRoles)} AS jsonb),
            ${request.institutionId}, ${request.branchId || null}, ${request.correlationId}, now()
          )
          RETURNING *
        `;
        const persisted = this.fromRow(row);
        await this.audit.recordInTransaction(
          tx,
          this.auditEvent(persisted, actor, 'financial.adjustment.requested', 'REQUESTED', 'PENDING'),
        );
        return persisted;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Financial target already has a pending adjustment');
      }
      throw error;
    }
  }

  async list(tenantId: string, query: FinancialAdjustmentListQuery) {
    if (!this.prisma.isConfigured) {
      const cursor = this.decodeCursor(query.cursor);
      const rows = [...(this.memory.get(tenantId)?.values() || [])]
        .filter((request) => !query.status || request.status === query.status)
        .filter((request) => !query.adjustmentType || request.adjustmentType === query.adjustmentType)
        .filter((request) => !query.targetType || request.targetType === query.targetType)
        .filter((request) => !query.targetId || request.targetId === query.targetId)
        .filter((request) => !cursor || this.beforeCursor(request.createdAt, request.id, cursor))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, query.limit + 1);
      return this.page(rows, query.limit);
    }
    const cursor = this.decodeCursor(query.cursor);
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM "financial_adjustment_requests"
      WHERE "tenantId" = ${tenantId}
        ${query.status ? Prisma.sql`AND status = ${query.status}` : Prisma.empty}
        ${query.adjustmentType ? Prisma.sql`AND "adjustmentType" = ${query.adjustmentType}` : Prisma.empty}
        ${query.targetType ? Prisma.sql`AND "targetType" = ${query.targetType}` : Prisma.empty}
        ${query.targetId ? Prisma.sql`AND "targetId" = ${query.targetId}` : Prisma.empty}
        ${cursor ? Prisma.sql`AND ("createdAt", id) < (${cursor.at}, ${cursor.id})` : Prisma.empty}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${query.limit + 1}
    `));
    return this.page(rows.map((row) => this.fromRow(row)), query.limit);
  }

  async get(tenantId: string, requestId: string): Promise<FinancialAdjustmentRecord> {
    if (!this.prisma.isConfigured) {
      const request = this.memory.get(tenantId)?.get(requestId);
      if (!request) throw new NotFoundException(`Financial adjustment not found: ${requestId}`);
      return request;
    }
    const request = await this.prisma.withTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<any[]>`
        SELECT * FROM "financial_adjustment_requests"
        WHERE "tenantId" = ${tenantId} AND id = ${requestId}
        LIMIT 1
      `;
      return row ? this.fromRow(row) : undefined;
    });
    if (!request) throw new NotFoundException(`Financial adjustment not found: ${requestId}`);
    return request;
  }

  approve(
    tenantId: string,
    requestId: string,
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<FinancialAdjustmentRecord> {
    return this.decide(tenantId, requestId, 'APPROVE', decisionReason, actor);
  }

  reject(
    tenantId: string,
    requestId: string,
    decisionReason: string,
    actor: OperatorContext,
  ): Promise<FinancialAdjustmentRecord> {
    return this.decide(tenantId, requestId, 'REJECT', decisionReason, actor);
  }

  private async decide(
    tenantId: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<FinancialAdjustmentRecord> {
    if (!this.prisma.isConfigured) {
      return this.withMemoryLock(`${tenantId}:${requestId}`, () =>
        this.decideMemory(tenantId, requestId, decision, decisionReason, actor));
    }

    try {
      const result = await this.prisma.withTenant(tenantId, async (tx) => {
        const [row] = await tx.$queryRaw<any[]>`
          SELECT * FROM "financial_adjustment_requests"
          WHERE "tenantId" = ${tenantId} AND id = ${requestId}
          FOR UPDATE
        `;
        if (!row) throw new NotFoundException(`Financial adjustment not found: ${requestId}`);
        const request = this.fromRow(row);
        this.assertChecker(request, actor);
        const replay = this.terminalReplay(request, decision);
        if (replay) return { request: replay };
        if (decision === 'REJECT') {
          const [rejectedRow] = await tx.$queryRaw<any[]>`
            UPDATE "financial_adjustment_requests"
            SET status = 'REJECTED', "decidedBy" = ${actor.subject},
                "decisionReason" = ${decisionReason}, "decidedAt" = now(), "updatedAt" = now()
            WHERE "tenantId" = ${tenantId} AND id = ${requestId}
            RETURNING *
          `;
          const rejected = this.fromRow(rejectedRow);
          await this.audit.recordInTransaction(
            tx,
            this.auditEvent(rejected, actor, 'financial.adjustment.rejected', 'AUTHORIZED', 'REJECTED'),
          );
          return { request: rejected };
        }

        const target = await this.resolveTargetInTransaction(tx, tenantId, request.targetType, request.targetId);
        const conflict = await this.approvalConflict(tx, tenantId, request, target);
        if (conflict) {
          return { request: await this.failInTransaction(tx, request, actor, conflict), conflict };
        }
        const application = await this.applyConfigured(tx, tenantId, request, target, actor);
        const [appliedRow] = await tx.$queryRaw<any[]>`
          UPDATE "financial_adjustment_requests"
          SET status = 'APPLIED', "decidedBy" = ${actor.subject},
              "decisionReason" = ${decisionReason || null}, "decidedAt" = now(),
              "appliedAt" = now(), "reversalTransactionId" = ${application.reversalTransactionId || null},
              "reversalJournalEntryId" = ${application.reversalJournalEntryId},
              "replacementTransactionId" = ${application.replacementTransactionId || null},
              "replacementJournalEntryId" = ${application.replacementJournalEntryId || null},
              "updatedAt" = now()
          WHERE "tenantId" = ${tenantId} AND id = ${requestId}
          RETURNING *
        `;
        const applied = this.fromRow(appliedRow);
        await this.appendAdjustmentEvents(tx, applied, application);
        await this.audit.recordInTransaction(
          tx,
          this.auditEvent(
            applied,
            actor,
            'financial.adjustment.applied',
            'POSTED',
            request.adjustmentType === 'REVERSAL' ? 'REVERSED' : 'SUCCEEDED',
          ),
        );
        return { request: applied };
      });
      if (result.conflict) throw new CommittedBusinessConflictException(result.conflict);
      return result.request;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }
      await this.markUnexpectedFailure(tenantId, requestId, actor, (error as Error).message);
      throw error;
    }
  }

  private async decideMemory(
    tenantId: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<FinancialAdjustmentRecord> {
    const request = await this.get(tenantId, requestId);
    this.assertChecker(request, actor);
    const replay = this.terminalReplay(request, decision);
    if (replay) return replay;
    request.decidedBy = actor.subject;
    request.decisionReason = decisionReason;
    request.decidedAt = new Date();
    request.updatedAt = new Date();
    if (decision === 'REJECT') {
      request.status = 'REJECTED';
      this.audit.record(this.auditEvent(request, actor, 'financial.adjustment.rejected', 'AUTHORIZED', 'REJECTED'));
      return request;
    }
    const target = await this.resolveMemoryTarget(tenantId, request.targetType, request.targetId);
    const conflict = await this.memoryApprovalConflict(tenantId, request, target);
    if (conflict) {
      request.status = 'FAILED';
      request.failureReason = conflict;
      this.audit.record(this.auditEvent(request, actor, 'financial.adjustment.failed', 'VALIDATED', 'FAILED'));
      throw new ConflictException(conflict);
    }
    const application = await this.applyMemory(tenantId, request, target, actor);
    request.status = 'APPLIED';
    request.appliedAt = new Date();
    request.reversalTransactionId = application.reversalTransactionId;
    request.reversalJournalEntryId = application.reversalJournalEntryId;
    request.replacementTransactionId = application.replacementTransactionId;
    request.replacementJournalEntryId = application.replacementJournalEntryId;
    if (application.loan) await this.store.saveLoan(tenantId, application.loan);
    await this.outbox.append(this.eventFactory.ledgerAdjustmentPosted({
      tenantId,
      requestId: request.id,
      adjustmentType: request.adjustmentType,
      targetJournalEntryId: request.targetJournalEntryId,
      reversalJournalEntryId: application.reversalJournalEntryId,
      replacementJournalEntryId: application.replacementJournalEntryId,
      correlationId: request.correlationId,
    }));
    if (application.loan && request.targetTransactionId) {
      await this.outbox.append(this.lendingEvent(request, application));
    }
    this.audit.record(this.auditEvent(
      request,
      actor,
      'financial.adjustment.applied',
      'POSTED',
      request.adjustmentType === 'REVERSAL' ? 'REVERSED' : 'SUCCEEDED',
    ));
    return request;
  }

  private async applyConfigured(
    tx: TenantTransaction,
    tenantId: string,
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    actor: OperatorContext,
  ): Promise<AdjustmentApplication> {
    const decidedRequest = { ...request, decidedBy: actor.subject };
    const reversalTransactionId = target.transaction ? `txn_reversal_${randomUUID()}` : undefined;
    const reversalJournalEntryId = `je_reversal_${randomUUID()}`;
    const reversalEntry = this.reversalJournal(
      request,
      target,
      actor,
      reversalTransactionId || `txn_${request.id}_reversal`,
      reversalJournalEntryId,
    );
    await this.ledger.postJournalEntryInTransaction(tx, tenantId, reversalEntry);
    if (target.transaction && reversalTransactionId) {
      await this.insertAdjustmentTransaction(
        tx,
        tenantId,
        this.reversalTransaction(decidedRequest, target.transaction, reversalTransactionId),
      );
    }

    let replacementTransactionId: string | undefined;
    let replacementJournalEntryId: string | undefined;
    let replacementTransaction: Transaction | undefined;
    if (request.adjustmentType === 'CORRECTION') {
      replacementTransactionId = target.transaction ? `txn_correction_${randomUUID()}` : undefined;
      replacementJournalEntryId = `je_correction_${randomUUID()}`;
      const replacement = this.replacementJournal(
        request,
        target,
        actor,
        replacementTransactionId || `txn_${request.id}_correction`,
        replacementJournalEntryId,
      );
      await this.ledger.postJournalEntryInTransaction(tx, tenantId, replacement);
      if (target.transaction && replacementTransactionId) {
        replacementTransaction = this.replacementTransaction(
          decidedRequest,
          target.transaction,
          replacementTransactionId,
        );
        await this.insertAdjustmentTransaction(tx, tenantId, replacementTransaction);
      }
    }

    const loan = target.loan
      ? this.adjustLoan(request, target, replacementTransaction)
      : undefined;
    if (loan) {
      await tx.$executeRaw`
        UPDATE loans
        SET status = ${loan.status}, data = CAST(${this.json(loan)} AS jsonb), "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${loan.id}
      `;
    }
    const money = this.applicationMoney(request, target);
    return {
      reversalTransactionId,
      reversalJournalEntryId,
      replacementTransactionId,
      replacementJournalEntryId,
      loan,
      ...money,
      lendingOperation: this.lendingOperation(target.transaction),
    };
  }

  private async applyMemory(
    tenantId: string,
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    actor: OperatorContext,
  ): Promise<AdjustmentApplication> {
    const reversalTransactionId = target.transaction ? `txn_reversal_${randomUUID()}` : undefined;
    const reversalJournalEntryId = `je_reversal_${randomUUID()}`;
    await this.ledger.postJournalEntry(tenantId, this.reversalJournal(
      request,
      target,
      actor,
      reversalTransactionId || `txn_${request.id}_reversal`,
      reversalJournalEntryId,
    ));
    if (target.transaction && reversalTransactionId) {
      await this.store.saveTransaction(
        tenantId,
        this.reversalTransaction(request, target.transaction, reversalTransactionId),
      );
    }
    let replacementTransactionId: string | undefined;
    let replacementJournalEntryId: string | undefined;
    let replacementTransaction: Transaction | undefined;
    if (request.adjustmentType === 'CORRECTION') {
      replacementTransactionId = target.transaction ? `txn_correction_${randomUUID()}` : undefined;
      replacementJournalEntryId = `je_correction_${randomUUID()}`;
      await this.ledger.postJournalEntry(tenantId, this.replacementJournal(
        request,
        target,
        actor,
        replacementTransactionId || `txn_${request.id}_correction`,
        replacementJournalEntryId,
      ));
      if (target.transaction && replacementTransactionId) {
        replacementTransaction = this.replacementTransaction(request, target.transaction, replacementTransactionId);
        await this.store.saveTransaction(tenantId, replacementTransaction);
      }
    }
    const loan = target.loan ? this.adjustLoan(request, target, replacementTransaction) : undefined;
    return {
      reversalTransactionId,
      reversalJournalEntryId,
      replacementTransactionId,
      replacementJournalEntryId,
      loan,
      ...this.applicationMoney(request, target),
      lendingOperation: this.lendingOperation(target.transaction),
    };
  }

  private reversalJournal(
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    actor: OperatorContext,
    transactionId: string,
    journalEntryId: string,
  ): JournalEntry {
    return {
      entry_id: journalEntryId,
      entry_date: new Date(),
      transaction_id: transactionId,
      description: `Approved reversal for ${target.journal.entry_id}`,
      posted_by: actor.subject,
      posting_date: new Date(),
      entries: target.journal.entries.map((line) => ({
        account_code: line.account_code,
        debit_amount: line.credit_amount,
        credit_amount: line.debit_amount,
      })),
      account_postings: target.accountEntries.map((entry) => ({
        accountId: entry.accountId,
        direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amount: entry.amount,
        currency: entry.currency,
        reference: request.id,
        postingKey: `${request.id}:reversal:${entry.id}`,
        entryType: 'REVERSAL',
      })),
      status: 'DRAFT',
      metadata: {
        ...target.journal.metadata,
        adjustment_request_id: request.id,
        adjustment_type: 'REVERSAL',
      },
      adjustment_request_id: request.id,
      reversal_of_entry_id: target.journal.entry_id,
    };
  }

  private replacementJournal(
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    actor: OperatorContext,
    transactionId: string,
    journalEntryId: string,
  ): JournalEntry {
    const lending = request.correction?.lending;
    const lines = lending && target.transaction
      ? this.lendingLines(target.transaction.transaction_type, lending)
      : request.correction?.journal?.ledgerLines || [];
    const postings = lending
      ? this.lendingReplacementPostings(request, target, lending.amount)
      : (request.correction?.journal?.accountPostings || []).map((posting, index) => ({
          ...posting,
          postingKey: posting.postingKey || `${request.id}:correction:${index}:${posting.accountId}`,
          entryType: 'CORRECTION' as const,
        }));
    return {
      entry_id: journalEntryId,
      entry_date: new Date(),
      transaction_id: transactionId,
      description: `Approved correction for ${target.journal.entry_id}`,
      posted_by: actor.subject,
      posting_date: new Date(),
      entries: lines,
      account_postings: postings,
      status: 'DRAFT',
      metadata: {
        ...target.journal.metadata,
        adjustment_request_id: request.id,
        adjustment_type: 'CORRECTION',
      },
      adjustment_request_id: request.id,
      correction_of_entry_id: target.journal.entry_id,
    };
  }

  private lendingLines(type: TransactionType, correction: NonNullable<FinancialAdjustmentCorrection['lending']>): LedgerLine[] {
    const amount = this.decimal(correction.amount);
    if (type === TransactionType.LOAN_DISBURSEMENT) {
      return [
        { account_code: '11100', debit_amount: amount.toNumber() },
        { account_code: '10010', credit_amount: amount.toNumber() },
      ];
    }
    if (type !== TransactionType.LOAN_PAYMENT || !correction.allocation) {
      throw new BadRequestException('Unsupported lending correction');
    }
    const allocation = correction.allocation;
    const credits = [
      { account_code: '11100', credit_amount: this.nonNegativeDecimal(allocation.principal).toNumber() },
      { account_code: '40010', credit_amount: this.nonNegativeDecimal(allocation.interest).toNumber() },
      { account_code: '40100', credit_amount: this.nonNegativeDecimal(allocation.fees).toNumber() },
    ].filter((line) => (line.credit_amount || 0) > 0);
    return [{ account_code: '10010', debit_amount: amount.toNumber() }, ...credits];
  }

  private lendingReplacementPostings(
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    amount: string,
  ): AccountPostingInput[] {
    if (target.accountEntries.length === 0) return [];
    if (target.accountEntries.length !== 1) {
      throw new ConflictException('Lending correction requires a single customer account posting');
    }
    const original = target.accountEntries[0];
    return [{
      accountId: original.accountId,
      direction: original.direction,
      amount,
      currency: original.currency,
      reference: request.id,
      postingKey: `${request.id}:correction:${original.id}`,
      entryType: 'CORRECTION',
    }];
  }

  private reversalTransaction(
    request: FinancialAdjustmentRecord,
    original: Transaction,
    id: string,
  ): Transaction {
    const now = new Date();
    return {
      ...original,
      id,
      transaction_type: original.transaction_type,
      status: TransactionStatus.POSTED,
      idempotency_key: undefined,
      created_at: now,
      posted_at: now,
      reversed_at: undefined,
      created_by: request.decidedBy || 'SYSTEM',
      adjustment_request_id: request.id,
      reversal_of_transaction_id: original.id,
      correction_of_transaction_id: undefined,
      metadata: {
        ...original.metadata,
        adjustment_request_id: request.id,
        adjustment_type: 'REVERSAL',
        original_transaction_id: original.id,
      },
    };
  }

  private replacementTransaction(
    request: FinancialAdjustmentRecord,
    original: Transaction,
    id: string,
  ): Transaction {
    const lending = request.correction?.lending;
    const amount = lending
      ? this.decimal(lending.amount).toNumber()
      : request.correction?.journal
        ? request.correction.journal.ledgerLines.reduce((sum, line) => sum + (line.debit_amount || 0), 0)
        : original.amount;
    const now = new Date();
    const allocation = lending?.allocation;
    return {
      ...original,
      id,
      amount,
      status: TransactionStatus.POSTED,
      idempotency_key: undefined,
      principal_payment: allocation ? this.nonNegativeDecimal(allocation.principal).toNumber() : original.principal_payment,
      interest_payment: allocation ? this.nonNegativeDecimal(allocation.interest).toNumber() : original.interest_payment,
      fee_payment: allocation ? this.nonNegativeDecimal(allocation.fees).toNumber() : original.fee_payment,
      created_at: now,
      posted_at: now,
      reversed_at: undefined,
      created_by: request.decidedBy || 'SYSTEM',
      adjustment_request_id: request.id,
      reversal_of_transaction_id: undefined,
      correction_of_transaction_id: original.id,
      metadata: {
        ...original.metadata,
        adjustment_request_id: request.id,
        adjustment_type: 'CORRECTION',
        original_transaction_id: original.id,
        settlement_result: allocation ? {
          transaction_id: id,
          status: TransactionStatus.POSTED,
          posting_status: 'SUCCESS',
          allocation: {
            principal_payment: this.nonNegativeDecimal(allocation.principal).toNumber(),
            interest_payment: this.nonNegativeDecimal(allocation.interest).toNumber(),
            fee_payment: this.nonNegativeDecimal(allocation.fees).toNumber(),
          },
          timestamp: now,
        } : undefined,
      },
    };
  }

  private adjustLoan(
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
    replacement?: Transaction,
  ): Loan {
    const loan = structuredClone(target.loan!) as Loan;
    const original = target.transaction!;
    if (original.transaction_type === TransactionType.LOAN_PAYMENT) {
      const allocation = this.originalAllocation(original);
      loan.total_paid_principal = this.nonNegative(loan.total_paid_principal - allocation.principal);
      loan.total_paid_interest = this.nonNegative(loan.total_paid_interest - allocation.interest);
      loan.total_paid_fees = this.nonNegative(loan.total_paid_fees - allocation.fees);
      loan.remaining_balance = this.nonNegative(loan.remaining_balance + allocation.principal);
      if (replacement) {
        const corrected = this.originalAllocation(replacement);
        loan.total_paid_principal += corrected.principal;
        loan.total_paid_interest += corrected.interest;
        loan.total_paid_fees += corrected.fees;
        loan.remaining_balance = this.nonNegative(loan.remaining_balance - corrected.principal);
      }
      loan.status = loan.remaining_balance <= 0 ? LoanStatus.PAID_UP : LoanStatus.ACTIVE;
    } else if (original.transaction_type === TransactionType.LOAN_DISBURSEMENT) {
      loan.status = replacement ? LoanStatus.ACTIVE : LoanStatus.APPROVED;
      loan.disbursed_amount = replacement?.amount || 0;
      loan.remaining_balance = replacement?.amount || loan.principal_amount;
      if (!replacement) {
        loan.disbursement_date = undefined;
        loan.maturity_date = undefined;
      }
    } else {
      throw new ConflictException('Unsupported lending transaction type');
    }
    loan.version = Number(loan.version || 1) + 1;
    loan.updated_at = new Date();
    return loan;
  }

  private async insertAdjustmentTransaction(
    tx: TenantTransaction,
    tenantId: string,
    transaction: Transaction,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "financial_transactions" (
        id, "tenantId", type, status, amount, currency, "loanId", "idempotencyKey",
        data, "postedAt", "adjustmentRequestId", "reversalOfTransactionId",
        "correctionOfTransactionId"
      )
      VALUES (
        ${transaction.id}, ${tenantId}, ${transaction.transaction_type}, ${transaction.status},
        ${transaction.amount}, ${transaction.currency}, ${transaction.loan_id || null}, NULL,
        CAST(${this.json(transaction)} AS jsonb), ${transaction.posted_at || new Date()},
        ${transaction.adjustment_request_id || null}, ${transaction.reversal_of_transaction_id || null},
        ${transaction.correction_of_transaction_id || null}
      )
    `;
  }

  private async appendAdjustmentEvents(
    tx: TenantTransaction,
    request: FinancialAdjustmentRecord,
    application: AdjustmentApplication,
  ): Promise<void> {
    await this.outbox.appendInTransaction(tx, this.eventFactory.ledgerAdjustmentPosted({
      tenantId: request.tenantId,
      requestId: request.id,
      adjustmentType: request.adjustmentType,
      targetJournalEntryId: request.targetJournalEntryId,
      reversalJournalEntryId: application.reversalJournalEntryId,
      replacementJournalEntryId: application.replacementJournalEntryId,
      correlationId: request.correlationId,
    }));
    if (application.loan && request.targetTransactionId) {
      await this.outbox.appendInTransaction(tx, this.lendingEvent(request, application));
    }
  }

  private lendingEvent(request: FinancialAdjustmentRecord, application: AdjustmentApplication) {
    const operation = application.lendingOperation;
    if (!operation) throw new Error('Lending adjustment operation is missing');
    return this.eventFactory.lendingAdjustmentApplied({
      tenantId: request.tenantId,
      requestId: request.id,
      adjustmentType: request.adjustmentType,
      operation,
      loanId: application.loan!.id,
      loanVersion: application.loan!.version,
      originalTransactionId: request.targetTransactionId!,
      reversalTransactionId: application.reversalTransactionId!,
      replacementTransactionId: application.replacementTransactionId,
      amount: application.amount,
      currency: application.currency,
      allocation: application.allocation,
      balanceAfter: Number(application.loan!.remaining_balance).toFixed(2),
      loanStatus: application.loan!.status,
      correlationId: request.correlationId,
    });
  }

  private lendingOperation(transaction?: Transaction): 'LOAN_PAYMENT' | 'LOAN_DISBURSEMENT' | undefined {
    if (transaction?.transaction_type === TransactionType.LOAN_PAYMENT) return 'LOAN_PAYMENT';
    if (transaction?.transaction_type === TransactionType.LOAN_DISBURSEMENT) return 'LOAN_DISBURSEMENT';
    return undefined;
  }

  private applicationMoney(request: FinancialAdjustmentRecord, target: ResolvedTarget) {
    const correction = request.correction?.lending;
    const journalAmount = target.journal.entries.reduce(
      (total, line) => total.plus(line.debit_amount || 0),
      new Decimal(0),
    );
    const amount = correction?.amount
      || (target.transaction ? new Decimal(target.transaction.amount).toFixed(2) : journalAmount.toFixed(2));
    const currency = correction?.currency || target.transaction?.currency || 'MZN';
    const original = target.transaction ? this.originalAllocation(target.transaction) : undefined;
    return {
      amount: this.decimal(amount).toFixed(2),
      currency,
      allocation: correction?.allocation ? {
        principal: this.nonNegativeDecimal(correction.allocation.principal).toFixed(2),
        interest: this.nonNegativeDecimal(correction.allocation.interest).toFixed(2),
        fees: this.nonNegativeDecimal(correction.allocation.fees).toFixed(2),
      } : original ? {
        principal: new Decimal(original.principal).toFixed(2),
        interest: new Decimal(original.interest).toFixed(2),
        fees: new Decimal(original.fees).toFixed(2),
      } : undefined,
    };
  }

  private async resolveMemoryTarget(
    tenantId: string,
    targetType: 'TRANSACTION' | 'JOURNAL_ENTRY',
    targetId: string,
  ): Promise<ResolvedTarget> {
    let transaction: Transaction | undefined;
    let journal: JournalEntry | undefined;
    if (targetType === 'TRANSACTION') {
      transaction = await this.store.getTransaction(tenantId, targetId);
      if (!transaction) throw new NotFoundException(`Financial transaction not found: ${targetId}`);
      const journals = (await this.store.listJournalEntries(tenantId))
        .filter((entry) => entry.transaction_id === transaction!.id && entry.status === 'POSTED');
      if (journals.length !== 1) throw new ConflictException('Financial transaction must reference exactly one posted journal entry');
      journal = journals[0];
    } else {
      journal = await this.store.getJournalEntry(tenantId, targetId);
      if (!journal) throw new NotFoundException(`Journal entry not found: ${targetId}`);
      transaction = await this.store.getTransaction(tenantId, journal.transaction_id);
    }
    const loan = transaction?.loan_id ? await this.store.getLoan(tenantId, transaction.loan_id) : undefined;
    return {
      transaction,
      journal,
      loan,
      accountEntries: await this.accounts.listEntriesByJournal(tenantId, journal.entry_id),
    };
  }

  private async resolveTargetInTransaction(
    tx: TenantTransaction,
    tenantId: string,
    targetType: 'TRANSACTION' | 'JOURNAL_ENTRY',
    targetId: string,
  ): Promise<ResolvedTarget> {
    let transactionRow: any;
    let journalRow: any;
    if (targetType === 'TRANSACTION') {
      [transactionRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "financial_transactions"
        WHERE "tenantId" = ${tenantId} AND id = ${targetId}
        FOR UPDATE
      `;
      if (!transactionRow) throw new NotFoundException(`Financial transaction not found: ${targetId}`);
      const journals = await tx.$queryRaw<any[]>`
        SELECT * FROM "journal_entries"
        WHERE "tenantId" = ${tenantId} AND "transactionId" = ${targetId} AND status = 'POSTED'
        FOR UPDATE
      `;
      if (journals.length !== 1) throw new ConflictException('Financial transaction must reference exactly one posted journal entry');
      journalRow = journals[0];
    } else {
      [journalRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "journal_entries"
        WHERE "tenantId" = ${tenantId} AND id = ${targetId}
        FOR UPDATE
      `;
      if (!journalRow) throw new NotFoundException(`Journal entry not found: ${targetId}`);
      [transactionRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "financial_transactions"
        WHERE "tenantId" = ${tenantId} AND id = ${journalRow.transactionId}
        FOR UPDATE
      `;
    }
    const transaction = transactionRow ? this.transactionFromRow(transactionRow) : undefined;
    let loan: Loan | undefined;
    if (transaction?.loan_id) {
      const [loanRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM loans
        WHERE "tenantId" = ${tenantId} AND id = ${transaction.loan_id}
        FOR UPDATE
      `;
      loan = loanRow ? this.parseJson<Loan>(loanRow.data) : undefined;
    }
    const accountRows = await tx.$queryRaw<any[]>`
      SELECT * FROM account_entries
      WHERE "tenantId" = ${tenantId} AND "journalEntryId" = ${journalRow.id}
      ORDER BY "createdAt" ASC, id ASC
    `;
    return {
      transaction,
      journal: this.journalFromRow(journalRow),
      loan,
      accountEntries: accountRows.map((row) => this.accountEntryFromRow(row)),
    };
  }

  private assertEligibleTarget(
    tenantId: string,
    input: CreateFinancialAdjustmentInput,
    target: ResolvedTarget,
  ): void {
    if (target.journal.status !== 'POSTED') throw new ConflictException('Only posted journal entries can be adjusted');
    if (target.journal.adjustment_request_id) throw new ConflictException('Adjustment-generated journal entries cannot be targeted directly');
    if (input.targetType === 'TRANSACTION' && target.transaction?.adjustment_request_id) {
      throw new ConflictException('Adjustment-generated transactions cannot be targeted directly');
    }
    if (target.transaction?.tenant_id !== undefined && target.transaction.tenant_id !== tenantId) {
      throw new ForbiddenException('Financial target belongs to another tenant');
    }
    this.assertCorrection(input, target);
  }

  private assertInput(input: CreateFinancialAdjustmentInput): void {
    if (!input.reason?.trim() || input.reason.length > 500) {
      throw new BadRequestException('Adjustment reason must contain between 1 and 500 characters');
    }
    if (input.adjustmentType === 'CORRECTION' && !input.correction) {
      throw new BadRequestException('Correction details are required');
    }
    if (input.adjustmentType === 'REVERSAL' && input.correction) {
      throw new BadRequestException('Reversal must not include correction details');
    }
  }

  private assertCorrection(input: CreateFinancialAdjustmentInput, target: ResolvedTarget): void {
    if (input.adjustmentType !== 'CORRECTION') return;
    const transaction = target.transaction;
    if (transaction?.loan_id) {
      const correction = input.correction?.lending;
      if (!correction || input.correction?.journal) {
        throw new BadRequestException('Lending correction details are required for loan transactions');
      }
      const amount = this.decimal(correction.amount);
      if (correction.currency !== transaction.currency) throw new BadRequestException('Correction currency must match the original transaction');
      if (transaction.transaction_type === TransactionType.LOAN_PAYMENT) {
        if (!correction.allocation) throw new BadRequestException('Loan payment correction requires allocation');
        const allocationTotal = this.nonNegativeDecimal(correction.allocation.principal)
          .plus(this.nonNegativeDecimal(correction.allocation.interest))
          .plus(this.nonNegativeDecimal(correction.allocation.fees));
        if (!allocationTotal.equals(amount)) throw new BadRequestException('Loan payment allocation must equal corrected amount');
      } else if (transaction.transaction_type === TransactionType.LOAN_DISBURSEMENT) {
        if (correction.allocation) throw new BadRequestException('Loan disbursement correction must not include allocation');
        const approved = new Decimal(target.loan?.approved_amount || target.loan?.principal_amount || 0);
        if (!amount.equals(approved)) throw new BadRequestException('Corrected disbursement must equal the approved principal');
      } else {
        throw new BadRequestException('Unsupported lending transaction type');
      }
      return;
    }
    const correction = input.correction?.journal;
    if (!correction || input.correction?.lending) {
      throw new BadRequestException('Journal correction details are required');
    }
    this.assertBalanced(correction.ledgerLines);
    if (target.accountEntries.length > 0 && (!correction.accountPostings || correction.accountPostings.length === 0)) {
      throw new BadRequestException('Correction must replace the original controlled-account postings');
    }
    for (const posting of correction.accountPostings || []) {
      this.decimal(posting.amount);
    }
  }

  private async approvalConflict(
    tx: TenantTransaction,
    tenantId: string,
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
  ): Promise<string | undefined> {
    if (target.loan && request.expectedLoanVersion !== Number(target.loan.version)) {
      return 'Loan state changed after the adjustment request';
    }
    if (target.transaction?.loan_id) {
      const [later] = await tx.$queryRaw<any[]>`
        SELECT id FROM "financial_transactions"
        WHERE "tenantId" = ${tenantId} AND "loanId" = ${target.transaction.loan_id}
          AND ("postedAt", id) > (
            ${target.transaction.posted_at || target.transaction.created_at},
            ${target.transaction.id}
          )
          AND "adjustmentRequestId" IS NULL
        LIMIT 1
      `;
      if (later) return 'Loan has later financial effects; adjust the latest transaction first';
    }
    const accountConflict = await this.configuredAccountConflict(tx, tenantId, request, target);
    if (accountConflict) return accountConflict;
    return undefined;
  }

  private async memoryApprovalConflict(
    tenantId: string,
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
  ): Promise<string | undefined> {
    if (target.loan && request.expectedLoanVersion !== Number(target.loan.version)) {
      return 'Loan state changed after the adjustment request';
    }
    if (target.transaction?.loan_id) {
      const targetAt = target.transaction.posted_at || target.transaction.created_at;
      const later = (await this.store.listTransactions(tenantId)).some((transaction) =>
        transaction.loan_id === target.transaction!.loan_id
        && !transaction.adjustment_request_id
        && (
          (transaction.posted_at || transaction.created_at) > targetAt
          || ((transaction.posted_at || transaction.created_at).valueOf() === targetAt.valueOf()
            && transaction.id > target.transaction!.id)
        ));
      if (later) return 'Loan has later financial effects; adjust the latest transaction first';
    }
    const accountConflict = await this.memoryAccountConflict(tenantId, request, target);
    if (accountConflict) return accountConflict;
    return undefined;
  }

  private async configuredAccountConflict(
    tx: TenantTransaction,
    tenantId: string,
    request: FinancialAdjustmentRecord,
    target: ResolvedTarget,
  ): Promise<string | undefined> {
    const accountIds = this.adjustmentAccountIds(request, target);
    if (accountIds.length === 0) return undefined;
    const rows = await tx.$queryRaw<any[]>(Prisma.sql`
      SELECT id, status FROM accounts
      WHERE "tenantId" = ${tenantId} AND id IN (${Prisma.join(accountIds)})
      ORDER BY id
      FOR UPDATE
    `);
    if (rows.length !== accountIds.length) return 'Financial adjustment references an unavailable account';
    if (rows.some((row) => row.status === 'CLOSED')) return 'Closed accounts cannot receive financial adjustments';
    return undefined;
  }

  private async validateConfiguredReferences(
    tx: TenantTransaction,
    tenantId: string,
    input: CreateFinancialAdjustmentInput,
    target: ResolvedTarget,
  ): Promise<void> {
    const accountIds = this.adjustmentAccountIds(input, target);
    if (accountIds.length > 0) {
      const rows = await tx.$queryRaw<any[]>(Prisma.sql`
        SELECT id, status, currency FROM accounts
        WHERE "tenantId" = ${tenantId} AND id IN (${Prisma.join(accountIds)})
        ORDER BY id
      `);
      if (rows.length !== accountIds.length) {
        throw new BadRequestException('Financial adjustment references an unavailable account');
      }
      if (rows.some((row) => row.status === 'CLOSED')) {
        throw new ConflictException('Closed accounts cannot receive financial adjustments');
      }
      const currencies = new Map(rows.map((row) => [row.id, row.currency]));
      for (const posting of input.correction?.journal?.accountPostings || []) {
        if (currencies.get(posting.accountId) !== posting.currency) {
          throw new BadRequestException(`Posting currency does not match account ${posting.accountId}`);
        }
      }
    }
    const accountCodes = [...new Set(
      (input.correction?.journal?.ledgerLines || []).map((line) => line.account_code),
    )].sort();
    if (accountCodes.length > 0) {
      const rows = await tx.$queryRaw<any[]>(Prisma.sql`
        SELECT "accountCode" FROM ledger_accounts
        WHERE "tenantId" = ${tenantId} AND "accountCode" IN (${Prisma.join(accountCodes)})
          AND "isActive" = true
      `);
      if (rows.length !== accountCodes.length) {
        throw new BadRequestException('Financial adjustment references an unknown or inactive ledger account');
      }
    }
  }

  private async memoryAccountConflict(
    tenantId: string,
    request: Pick<FinancialAdjustmentRecord, 'correction'>,
    target: ResolvedTarget,
  ): Promise<string | undefined> {
    for (const accountId of this.adjustmentAccountIds(request, target)) {
      const account = await this.accounts.getAccount(tenantId, accountId);
      if (account.status === 'CLOSED') return 'Closed accounts cannot receive financial adjustments';
    }
    return undefined;
  }

  private adjustmentAccountIds(
    request: { correction?: FinancialAdjustmentCorrection },
    target: ResolvedTarget,
  ): string[] {
    return [...new Set([
      ...target.accountEntries.map((entry) => entry.accountId),
      ...(request.correction?.journal?.accountPostings || []).map((posting) => posting.accountId),
    ])].sort();
  }

  private async validateMemoryReferences(
    tenantId: string,
    input: CreateFinancialAdjustmentInput,
    target: ResolvedTarget,
  ): Promise<void> {
    const request = { correction: input.correction };
    const accountConflict = await this.memoryAccountConflict(tenantId, request, target);
    if (accountConflict) throw new ConflictException(accountConflict);
    for (const posting of input.correction?.journal?.accountPostings || []) {
      const account = await this.accounts.getAccount(tenantId, posting.accountId);
      if (account.currency !== posting.currency) {
        throw new BadRequestException(`Posting currency does not match account ${account.id}`);
      }
    }
    for (const line of input.correction?.journal?.ledgerLines || []) {
      const account = await this.store.getAccount(tenantId, line.account_code);
      if (!account?.is_active) {
        throw new BadRequestException(`Unknown or inactive ledger account: ${line.account_code}`);
      }
    }
  }

  private buildRequest(
    tenantId: string,
    input: CreateFinancialAdjustmentInput,
    actor: OperatorContext,
    target: ResolvedTarget,
  ): FinancialAdjustmentRecord {
    const now = new Date();
    return {
      id: `far_${randomUUID()}`,
      tenantId,
      ...input,
      status: 'PENDING_APPROVAL',
      targetTransactionId: target.transaction?.id,
      targetJournalEntryId: target.journal.entry_id,
      targetLoanId: target.loan?.id,
      expectedLoanVersion: target.loan?.version,
      requestedBy: actor.subject,
      requestedRoles: actor.roles,
      institutionId: actor.institutionId,
      branchId: actor.branchId,
      correlationId: actor.correlationId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private assertChecker(request: FinancialAdjustmentRecord, actor: OperatorContext): void {
    if (!actor.permissions.includes('finance.approve')) {
      throw new ForbiddenException('finance.approve permission is required');
    }
    if (request.requestedBy === actor.subject) throw new ForbiddenException('Self-approval is not permitted');
  }

  private terminalReplay(
    request: FinancialAdjustmentRecord,
    decision: 'APPROVE' | 'REJECT',
  ): FinancialAdjustmentRecord | undefined {
    if (request.status === 'PENDING_APPROVAL') return undefined;
    if (decision === 'APPROVE' && request.status === 'APPLIED') return request;
    if (decision === 'REJECT' && request.status === 'REJECTED') return request;
    throw new ConflictException(`Financial adjustment is already ${request.status}`);
  }

  private async failInTransaction(
    tx: TenantTransaction,
    request: FinancialAdjustmentRecord,
    actor: OperatorContext,
    failureReason: string,
  ): Promise<FinancialAdjustmentRecord> {
    const [row] = await tx.$queryRaw<any[]>`
      UPDATE "financial_adjustment_requests"
      SET status = 'FAILED', "decidedBy" = ${actor.subject}, "decidedAt" = now(),
          "failureReason" = ${failureReason}, "updatedAt" = now()
      WHERE "tenantId" = ${request.tenantId} AND id = ${request.id}
      RETURNING *
    `;
    const failed = this.fromRow(row);
    await this.audit.recordInTransaction(
      tx,
      this.auditEvent(failed, actor, 'financial.adjustment.failed', 'VALIDATED', 'FAILED'),
    );
    return failed;
  }

  private async markUnexpectedFailure(
    tenantId: string,
    requestId: string,
    actor: OperatorContext,
    message: string,
  ): Promise<void> {
    if (!this.prisma.isConfigured) return;
    await this.prisma.withTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<any[]>`
        UPDATE "financial_adjustment_requests"
        SET status = 'FAILED', "decidedBy" = ${actor.subject}, "decidedAt" = now(),
            "failureReason" = ${message.slice(0, 500)}, "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${requestId} AND status = 'PENDING_APPROVAL'
        RETURNING *
      `;
      if (row) {
        await this.audit.recordInTransaction(
          tx,
          this.auditEvent(this.fromRow(row), actor, 'financial.adjustment.failed', 'POSTED', 'FAILED'),
        );
      }
    });
  }

  private auditEvent(
    request: FinancialAdjustmentRecord,
    actor: OperatorContext,
    action: string,
    stage: 'REQUESTED' | 'VALIDATED' | 'AUTHORIZED' | 'POSTED',
    result: 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'REVERSED',
  ) {
    return {
      tenant_id: request.tenantId,
      action,
      entity_type: 'financial_adjustment',
      entity_id: request.id,
      stage,
      result,
      source: 'API' as const,
      actor_id: actor.subject,
      actor_roles: actor.roles,
      institution_id: actor.institutionId,
      branch_id: actor.branchId,
      reason: result === 'REJECTED' ? request.decisionReason : request.reason,
      correlation_id: request.correlationId,
      causation_id: request.targetId,
      approval_reference: request.id,
      metadata: {
        adjustment_type: request.adjustmentType,
        target_type: request.targetType,
        target_id: request.targetId,
        target_transaction_id: request.targetTransactionId,
        target_journal_entry_id: request.targetJournalEntryId,
        target_loan_id: request.targetLoanId,
        maker_subject: request.requestedBy,
        checker_subject: request.decidedBy,
      },
    };
  }

  private originalAllocation(transaction: Transaction) {
    const settlement = transaction.metadata?.settlement_result;
    const allocation = settlement?.allocation || {};
    return {
      principal: Number(allocation.principal_payment ?? transaction.principal_payment ?? 0),
      interest: Number(allocation.interest_payment ?? transaction.interest_payment ?? 0),
      fees: Number(allocation.fee_payment ?? transaction.fee_payment ?? 0),
    };
  }

  private assertBalanced(lines: LedgerLine[]): void {
    if (!Array.isArray(lines) || lines.length < 2) throw new BadRequestException('Correction requires at least two ledger lines');
    let debits = new Decimal(0);
    let credits = new Decimal(0);
    for (const line of lines) {
      const debit = new Decimal(line.debit_amount || 0);
      const credit = new Decimal(line.credit_amount || 0);
      if (
        (!debit.isZero() && !credit.isZero())
        || (debit.isZero() && credit.isZero())
        || debit.isNegative()
        || credit.isNegative()
        || debit.decimalPlaces() > 2
        || credit.decimalPlaces() > 2
      ) {
        throw new BadRequestException('Each ledger line must contain exactly one positive debit or credit');
      }
      debits = debits.plus(debit);
      credits = credits.plus(credit);
    }
    if (!debits.equals(credits)) throw new BadRequestException('Correction ledger lines must be balanced');
  }

  private decimal(value: string | number): Decimal {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || !decimal.isPositive() || decimal.decimalPlaces() > 2) {
      throw new BadRequestException('Financial amount must be a positive decimal with at most two places');
    }
    return decimal;
  }

  private nonNegativeDecimal(value: string | number): Decimal {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.isNegative() || decimal.decimalPlaces() > 2) {
      throw new BadRequestException('Financial amount must be a non-negative decimal with at most two places');
    }
    return decimal;
  }

  private nonNegative(value: number): number {
    return Math.max(0, Number(new Decimal(value).toFixed(2)));
  }

  private isUniqueViolation(error: unknown): boolean {
    const candidate = error as any;
    return candidate?.code === 'P2002'
      || candidate?.code === '23505'
      || candidate?.meta?.code === '23505'
      || candidate?.cause?.code === '23505';
  }

  private transactionFromRow(row: any): Transaction {
    return {
      ...this.parseJson<Transaction>(row.data),
      tenant_id: row.tenantId,
      amount: Number(row.amount),
      currency: row.currency,
      loan_id: row.loanId || undefined,
      status: row.status,
      created_at: row.createdAt,
      posted_at: row.postedAt || undefined,
      adjustment_request_id: row.adjustmentRequestId || undefined,
      reversal_of_transaction_id: row.reversalOfTransactionId || undefined,
      correction_of_transaction_id: row.correctionOfTransactionId || undefined,
    };
  }

  private journalFromRow(row: any): JournalEntry {
    return {
      entry_id: row.id,
      entry_date: row.entryDate,
      transaction_id: row.transactionId,
      description: row.description,
      posted_by: row.postedBy,
      posting_date: row.postingDate,
      entries: this.parseJson(row.lines),
      status: row.status,
      metadata: this.parseJson(row.metadata),
      adjustment_request_id: row.adjustmentRequestId || undefined,
      reversal_of_entry_id: row.reversalOfEntryId || undefined,
      correction_of_entry_id: row.correctionOfEntryId || undefined,
    };
  }

  private accountEntryFromRow(row: any): AccountEntryRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      accountId: row.accountId,
      journalEntryId: row.journalEntryId || undefined,
      transactionId: row.transactionId || undefined,
      postingKey: row.postingKey,
      entryType: row.entryType,
      direction: row.direction,
      amount: new Decimal(row.amount).toFixed(2),
      currency: row.currency,
      balanceAfter: new Decimal(row.balanceAfter).toFixed(2),
      reference: row.reference || undefined,
      createdBy: row.createdBy,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
    };
  }

  private fromRow(row: any): FinancialAdjustmentRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      targetType: row.targetType,
      targetId: row.targetId,
      adjustmentType: row.adjustmentType,
      status: row.status,
      reason: row.reason,
      correction: row.correction ? this.parseJson(row.correction) : undefined,
      targetTransactionId: row.targetTransactionId || undefined,
      targetJournalEntryId: row.targetJournalEntryId,
      targetLoanId: row.targetLoanId || undefined,
      expectedLoanVersion: row.expectedLoanVersion === null ? undefined : Number(row.expectedLoanVersion),
      requestedBy: row.requestedBy,
      requestedRoles: this.parseJson(row.requestedRoles),
      institutionId: row.institutionId,
      branchId: row.branchId || undefined,
      correlationId: row.correlationId,
      decidedBy: row.decidedBy || undefined,
      decisionReason: row.decisionReason || undefined,
      decidedAt: row.decidedAt || undefined,
      appliedAt: row.appliedAt || undefined,
      failureReason: row.failureReason || undefined,
      reversalTransactionId: row.reversalTransactionId || undefined,
      reversalJournalEntryId: row.reversalJournalEntryId || undefined,
      replacementTransactionId: row.replacementTransactionId || undefined,
      replacementJournalEntryId: row.replacementJournalEntryId || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private page(rows: FinancialAdjustmentRecord[], limit: number) {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = hasMore ? items[items.length - 1] : undefined;
    return { items, next_cursor: last ? this.encodeCursor(last.createdAt, last.id) : null };
  }

  private encodeCursor(at: Date, id: string): string {
    return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor?: string): { at: Date; id: string } | undefined {
    if (!cursor) return undefined;
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const at = new Date(value.at);
      if (!value.id || Number.isNaN(at.getTime())) throw new Error('invalid cursor');
      return { at, id: value.id };
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private beforeCursor(at: Date, id: string, cursor: { at: Date; id: string }): boolean {
    return at < cursor.at || (at.getTime() === cursor.at.getTime() && id < cursor.id);
  }

  private async withMemoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.memoryLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.memoryLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.memoryLocks.get(key) === queued) this.memoryLocks.delete(key);
    }
  }

  private parseJson<T>(value: any): T {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  private json(value: unknown): string {
    return JSON.stringify(value);
  }
}
