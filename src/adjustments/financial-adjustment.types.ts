import type { LedgerLine } from '../ledger/ledger.service';
import type { AccountPostingInput, OperatorContext } from '../accounts/account.types';

export const FINANCIAL_ADJUSTMENT_TYPES = ['REVERSAL', 'CORRECTION'] as const;
export type FinancialAdjustmentType = (typeof FINANCIAL_ADJUSTMENT_TYPES)[number];
export const FINANCIAL_ADJUSTMENT_TARGET_TYPES = ['TRANSACTION', 'JOURNAL_ENTRY'] as const;
export type FinancialAdjustmentTargetType = (typeof FINANCIAL_ADJUSTMENT_TARGET_TYPES)[number];
export const FINANCIAL_ADJUSTMENT_STATUSES = ['PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'FAILED'] as const;
export type FinancialAdjustmentStatus = (typeof FINANCIAL_ADJUSTMENT_STATUSES)[number];

export interface LendingCorrectionInput {
  amount: string;
  currency: string;
  allocation?: {
    principal: string;
    interest: string;
    fees: string;
  };
}

export interface JournalCorrectionInput {
  ledgerLines: LedgerLine[];
  accountPostings?: AccountPostingInput[];
}

export interface FinancialAdjustmentCorrection {
  lending?: LendingCorrectionInput;
  journal?: JournalCorrectionInput;
}

export interface CreateFinancialAdjustmentInput {
  targetType: FinancialAdjustmentTargetType;
  targetId: string;
  adjustmentType: FinancialAdjustmentType;
  reason: string;
  correction?: FinancialAdjustmentCorrection;
}

export interface FinancialAdjustmentRecord extends CreateFinancialAdjustmentInput {
  id: string;
  tenantId: string;
  status: FinancialAdjustmentStatus;
  targetTransactionId?: string;
  targetJournalEntryId: string;
  targetLoanId?: string;
  expectedLoanVersion?: number;
  requestedBy: string;
  requestedRoles: string[];
  institutionId: string;
  branchId?: string;
  correlationId: string;
  decidedBy?: string;
  decisionReason?: string;
  decidedAt?: Date;
  appliedAt?: Date;
  failureReason?: string;
  reversalTransactionId?: string;
  reversalJournalEntryId?: string;
  replacementTransactionId?: string;
  replacementJournalEntryId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinancialAdjustmentListQuery {
  status?: FinancialAdjustmentStatus;
  adjustmentType?: FinancialAdjustmentType;
  targetType?: FinancialAdjustmentTargetType;
  targetId?: string;
  cursor?: string;
  limit: number;
}

export interface FinancialAdjustmentDecision {
  request: FinancialAdjustmentRecord;
  actor: OperatorContext;
}
