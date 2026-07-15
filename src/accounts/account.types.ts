import type { Prisma } from '@prisma/client';

export const ACCOUNT_STATUSES = ['ACTIVE', 'FROZEN', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_LIFECYCLE_TRANSITIONS = ['FREEZE', 'UNFREEZE', 'CLOSE'] as const;
export type AccountLifecycleTransition = (typeof ACCOUNT_LIFECYCLE_TRANSITIONS)[number];

export const ACCOUNT_LIFECYCLE_REQUEST_STATUSES = [
  'PENDING_APPROVAL',
  'APPLIED',
  'REJECTED',
  'FAILED',
] as const;
export type AccountLifecycleRequestStatus = (typeof ACCOUNT_LIFECYCLE_REQUEST_STATUSES)[number];

export type AccountEntryDirection = 'DEBIT' | 'CREDIT';
export type AccountEntryType = 'OPENING_BALANCE' | 'POSTING';

export interface OperatorContext {
  subject: string;
  roles: string[];
  permissions: string[];
  institutionId: string;
  branchId?: string;
  correlationId: string;
}

export interface AccountRecord {
  id: string;
  tenantId: string;
  customerId?: string;
  productId?: string;
  name: string;
  currency: string;
  status: AccountStatus;
  balance: string;
  version: number;
  createdBy?: string;
  frozenAt?: Date;
  frozenBy?: string;
  freezeReason?: string;
  closedAt?: Date;
  closedBy?: string;
  closeReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountEntryRecord {
  id: string;
  tenantId: string;
  accountId: string;
  journalEntryId?: string;
  transactionId?: string;
  postingKey: string;
  entryType: AccountEntryType;
  direction: AccountEntryDirection;
  amount: string;
  currency: string;
  balanceAfter: string;
  reference?: string;
  createdBy: string;
  postedAt: Date;
  createdAt: Date;
}

export interface AccountPostingInput {
  accountId: string;
  direction: AccountEntryDirection;
  amount: string;
  currency: string;
  reference?: string;
  transactionId?: string;
  postingKey?: string;
}

export interface AccountLifecycleRequestRecord {
  id: string;
  tenantId: string;
  accountId: string;
  transition: AccountLifecycleTransition;
  fromStatus: AccountStatus;
  targetStatus: AccountStatus;
  expectedAccountVersion: number;
  status: AccountLifecycleRequestStatus;
  reason: string;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountStatementQuery {
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface AccountLifecycleListQuery {
  accountId?: string;
  status?: AccountLifecycleRequestStatus;
  cursor?: string;
  limit: number;
}

export type TenantTransaction = Prisma.TransactionClient;
