/*
 * mavula.io - Transaction Processing & Payment Settlement Engine
 * Copyright (c) 2025 mavula.io
 * 
 * Author: EstandarMustaq <estandarmustaq@mavula.io>
 * License: Proprietary - See LICENSE file
 * 
 * Real-time transaction processing, settlement, reconciliation
 * Multi-currency, dual-ledger (GL + customer account)
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RulesEngineService } from '../rules-engine/rules-engine.service';
import { allocatePayment } from '../calculations/financial-calculations';
import { AuditTrailService } from '../services/audit-trail.service';
import { FengineStoreService } from '../services/fengine-store.service';

export enum TransactionType {
  DEPOSIT = 'DEPOSIT',              // Money in
  WITHDRAWAL = 'WITHDRAWAL',        // Money out
  TRANSFER = 'TRANSFER',            // Account to account
  LOAN_DISBURSEMENT = 'LOAN_DISBURSEMENT',  // Loan payout
  LOAN_PAYMENT = 'LOAN_PAYMENT',    // Loan repayment
  FEE_CHARGE = 'FEE_CHARGE',        // Fee deduction
  INTEREST_ACCRUAL = 'INTEREST_ACCRUAL',  // Interest credit
}

export enum TransactionStatus {
  PENDING = 'PENDING',              // Awaiting processing
  PROCESSING = 'PROCESSING',        // In flight
  POSTED = 'POSTED',                // Recorded in ledger
  FAILED = 'FAILED',                // Error during settlement
  REVERSED = 'REVERSED',            // Cancellation
}

export interface Transaction {
  id: string;
  tenant_id: string;
  transaction_type: TransactionType;
  status: TransactionStatus;
  idempotency_key?: string;
  
  // Source and destination
  from_account_id: string;
  to_account_id?: string;
  
  // Amounts
  amount: number;
  currency: string;
  fee?: number;
  
  // For loans
  loan_id?: string;
  principal_payment?: number;
  interest_payment?: number;
  fee_payment?: number;
  
  // Rules evaluation
  rule_results?: any[];
  
  // Audit trail
  created_at: Date;
  posted_at?: Date;
  reversed_at?: Date;
  created_by: string;
  metadata: Record<string, any>;
}

export interface SettlementResult {
  transaction_id: string;
  status: TransactionStatus;
  posting_status: 'SUCCESS' | 'FAILED';
  gl_entry_id?: string;
  error?: string;
  idempotent?: boolean;
  allocation?: {
    principal_payment: number;
    interest_payment: number;
    fee_payment: number;
    balance_after: number;
  };
  timestamp: Date;
}

@Injectable()
export class TransactionService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private rulesEngine: RulesEngineService,
    private auditTrail: AuditTrailService,
    private store: FengineStoreService,
  ) {}

  /**
   * Process payment transaction end-to-end
   * Flow: Validate → Evaluate Rules → Allocate Payment → Post GL → Update Account
   */
  async processPayment(params: {
    tenantId: string;
    customerId: string;
    accountId: string;
    loanId: string;
    paymentAmount: number;
    currency: string;
    productId: string;
    principalDue: number;
    interestDue: number;
    feesDue: number;
    currentBalance: number;
    idempotencyKey?: string;
  }): Promise<SettlementResult> {
    const txnId = `txn_${params.loanId}_${Date.now()}`;

    try {
      const replay = await this.getIdempotentResult(params.tenantId, params.idempotencyKey);
      if (replay) {
        return replay;
      }

      // Step 1: Validate payment amount
      if (params.paymentAmount <= 0) {
        return this.failedResult(txnId, 'Invalid payment amount');
      }

      // Step 2: Evaluate posting rules before ledger mutation.
      const ruleResults = await this.rulesEngine.evaluateRules(params.productId, {
        tenant_id: params.tenantId,
        customer_id: params.customerId,
        transaction_amount: params.paymentAmount,
        transaction_type: TransactionType.LOAN_PAYMENT,
        stage: 'PAYMENT',
      });

      // Step 3: Check if any critical rule failed
      const failedCritical = ruleResults.find(r => !r.passed && r.rule_type.includes('REQUIRED'));
      if (failedCritical) {
        return this.failedResult(txnId, `Rule failed: ${failedCritical.rule_type}`);
      }

      // Step 4: Allocate payment (principal, interest, fees)
      // In production, would fetch loan details from database
      const allocation = allocatePayment({
        payment_amount: params.paymentAmount,
        interest_due: params.interestDue,
        principal_due: params.principalDue,
        fees_due: params.feesDue,
        current_balance: params.currentBalance,
      });

      // Step 5: Record in General Ledger
      await this.ledger.recordPaymentTransaction({
        tenantId: params.tenantId,
        transactionId: txnId,
        customerId: params.customerId,
        payment_amount: params.paymentAmount,
        principal_payment: allocation.principal_payment,
        interest_payment: allocation.interest_payment,
        fee_payment: allocation.fee_payment,
      });

      // Step 6: Update customer account
      // In production: UPDATE accounts SET balance = balance - principal WHERE id = account_id

      const result: SettlementResult = {
        transaction_id: txnId,
        status: TransactionStatus.POSTED,
        posting_status: 'SUCCESS',
        gl_entry_id: `je_${txnId}`,
        allocation,
        timestamp: new Date(),
      };

      await this.store.saveTransaction(params.tenantId, {
        id: txnId,
        tenant_id: params.tenantId,
        transaction_type: TransactionType.LOAN_PAYMENT,
        status: TransactionStatus.POSTED,
        idempotency_key: params.idempotencyKey,
        from_account_id: params.accountId,
        amount: params.paymentAmount,
        currency: params.currency,
        loan_id: params.loanId,
        principal_payment: allocation.principal_payment,
        interest_payment: allocation.interest_payment,
        fee_payment: allocation.fee_payment,
        rule_results: ruleResults,
        created_at: new Date(),
        posted_at: new Date(),
        created_by: 'SYSTEM',
        metadata: {
          customer_id: params.customerId,
          idempotency_key: params.idempotencyKey,
          settlement_result: result,
        },
      });
      this.auditTrail.record({
        tenant_id: params.tenantId,
        action: 'transaction.payment.posted',
        entity_type: 'transaction',
        entity_id: txnId,
        phase: 'ACT',
        metadata: {
          loan_id: params.loanId,
          payment_amount: params.paymentAmount,
          allocation,
        },
      });

      return result;
    } catch (error) {
      return this.failedResult(txnId, (error as Error).message);
    }
  }

  /**
   * Process loan disbursement transaction
   * GL: DEBIT Customer Account, CREDIT Loan Portfolio
   */
  async processDisbursement(params: {
    tenantId: string;
    customerId: string;
    loanId: string;
    principal: number;
    originationFee: number;
    currency: string;
    idempotencyKey?: string;
  }): Promise<SettlementResult> {
    const txnId = `disburse_${params.loanId}_${Date.now()}`;

    try {
      const replay = await this.getIdempotentResult(params.tenantId, params.idempotencyKey);
      if (replay) {
        return replay;
      }

      // Create transaction record
      const txn: Transaction = {
        id: txnId,
        tenant_id: params.tenantId,
        transaction_type: TransactionType.LOAN_DISBURSEMENT,
        status: TransactionStatus.PROCESSING,
        idempotency_key: params.idempotencyKey,
        from_account_id: 'BANK_VAULT',
        to_account_id: `CUST_${params.customerId}`,
        amount: params.principal,
        currency: params.currency,
        fee: params.originationFee,
        loan_id: params.loanId,
        created_at: new Date(),
        created_by: 'SYSTEM',
        metadata: { customer_id: params.customerId, idempotency_key: params.idempotencyKey },
      };
      await this.store.saveTransaction(params.tenantId, txn);

      // Record GL entry
      // DEBIT: 11100 (Loan Portfolio)
      // CREDIT: 10010 (Cash)
      await this.ledger.postJournalEntry(params.tenantId, {
        entry_id: `je_${txnId}`,
        entry_date: new Date(),
        transaction_id: txnId,
        description: `Loan disbursement for customer ${params.customerId}`,
        posted_by: 'SYSTEM',
        posting_date: new Date(),
        entries: [
          { account_code: '11100', debit_amount: params.principal },
          { account_code: '10010', credit_amount: params.principal },
        ],
        status: 'POSTED',
        metadata: { customer_id: params.customerId },
      });

      const result: SettlementResult = {
        transaction_id: txnId,
        status: TransactionStatus.POSTED,
        posting_status: 'SUCCESS',
        gl_entry_id: `je_${txnId}`,
        timestamp: new Date(),
      };

      txn.status = TransactionStatus.POSTED;
      txn.posted_at = result.timestamp;
      txn.metadata = {
        ...txn.metadata,
        settlement_result: result,
      };
      await this.store.saveTransaction(params.tenantId, txn);

      this.auditTrail.record({
        tenant_id: params.tenantId,
        action: 'transaction.disbursement.posted',
        entity_type: 'transaction',
        entity_id: txnId,
        phase: 'ACT',
        metadata: {
          customer_id: params.customerId,
          principal: params.principal,
          origination_fee: params.originationFee,
        },
      });

      return result;
    } catch (error) {
      return this.failedResult(txnId, (error as Error).message);
    }
  }

  /**
   * Process interest accrual (daily/monthly)
   * GL: DEBIT Customer Account, CREDIT Interest Income
   */
  async accrueInterest(params: {
    tenantId: string;
    accountId: string;
    interestAmount: number;
    accrualType: 'LOAN' | 'SAVINGS';
  }): Promise<SettlementResult> {
    const txnId = `accrue_int_${params.accountId}_${Date.now()}`;

    try {
      const debitAccount = params.accrualType === 'LOAN' ? '11100' : '20010';
      const creditAccount = params.accrualType === 'LOAN' ? '40010' : '20010';

      await this.ledger.postJournalEntry(params.tenantId, {
        entry_id: `je_${txnId}`,
        entry_date: new Date(),
        transaction_id: txnId,
        description: `Interest accrual for account ${params.accountId}`,
        posted_by: 'SYSTEM',
        posting_date: new Date(),
        entries: [
          { account_code: debitAccount, debit_amount: params.interestAmount },
          { account_code: creditAccount, credit_amount: params.interestAmount },
        ],
        status: 'POSTED',
        metadata: { account_id: params.accountId },
      });

      return {
        transaction_id: txnId,
        status: TransactionStatus.POSTED,
        posting_status: 'SUCCESS',
        gl_entry_id: `je_${txnId}`,
        timestamp: new Date(),
      };
    } catch (error) {
      return this.failedResult(txnId, (error as Error).message);
    }
  }

  /**
   * Reverse transaction (refund/cancellation)
   */
  async reverseTransaction(tenantId: string, transactionId: string): Promise<SettlementResult> {
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'transaction.reversed',
      entity_type: 'transaction',
      entity_id: transactionId,
      phase: 'ACT',
      metadata: {},
    });

    // In production, would create offsetting GL entries
    return {
      transaction_id: transactionId,
      status: TransactionStatus.REVERSED,
      posting_status: 'SUCCESS',
      timestamp: new Date(),
    };
  }

  private failedResult(txnId: string, error: string): SettlementResult {
    return {
      transaction_id: txnId,
      status: TransactionStatus.FAILED,
      posting_status: 'FAILED',
      error,
      timestamp: new Date(),
    };
  }

  private async getIdempotentResult(tenantId: string, key?: string): Promise<SettlementResult | undefined> {
    if (!key) {
      return undefined;
    }

    const transaction = await this.store.getTransactionByIdempotencyKey(tenantId, key);
    const stored = transaction?.metadata?.settlement_result as SettlementResult | undefined;
    if (!transaction || !stored) {
      return undefined;
    }

    return {
      ...stored,
      idempotent: true,
      timestamp: new Date(stored.timestamp),
    };
  }

  listTransactions(tenantId: string): Promise<Transaction[]> {
    return this.store.listTransactions(tenantId);
  }
}
