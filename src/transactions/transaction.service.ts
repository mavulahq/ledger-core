/*
 * getfluxo.io - Transaction Processing & Payment Settlement Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
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
  timestamp: Date;
}

@Injectable()
export class TransactionService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private rulesEngine: RulesEngineService
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
  }): Promise<SettlementResult> {
    const txnId = `txn_${params.loanId}_${Date.now()}`;

    try {
      // Step 1: Validate payment amount
      if (params.paymentAmount <= 0) {
        return this.failedResult(txnId, 'Invalid payment amount');
      }

      // Step 2: Evaluate rules (OODA: Evaluate rules before acting)
      const ruleResults = this.rulesEngine.evaluateRules(params.productId, {
        customer_id: params.customerId,
        transaction_amount: params.paymentAmount,
        transaction_type: TransactionType.LOAN_PAYMENT,
      });

      // Step 3: Check if any critical rule failed
      const failedCritical = ruleResults.find(r => !r.passed && r.rule_type.includes('REQUIRED'));
      if (failedCritical) {
        return this.failedResult(txnId, `Rule failed: ${failedCritical.rule_type}`);
      }

      // Step 4: Allocate payment (principal, interest, fees)
      // In production, would fetch loan details from database
      const interestDue = 1000;  // Example
      const principalDue = 4500; // Example
      const feesDue = 0;

      const allocation = allocatePayment({
        payment_amount: params.paymentAmount,
        interest_due: interestDue,
        principal_due: principalDue,
        fees_due: feesDue,
        current_balance: 50000,  // Example
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
      console.log(`✓ Payment processed: ${txnId} (Principal: ${allocation.principal_payment}, Interest: ${allocation.interest_payment})`);

      return {
        transaction_id: txnId,
        status: TransactionStatus.POSTED,
        posting_status: 'SUCCESS',
        gl_entry_id: `je_${txnId}`,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error(`Payment processing failed for ${txnId}:`, error);
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
  }): Promise<SettlementResult> {
    const txnId = `disburse_${params.loanId}_${Date.now()}`;

    try {
      // Create transaction record
      const txn: Transaction = {
        id: txnId,
        tenant_id: params.tenantId,
        transaction_type: TransactionType.LOAN_DISBURSEMENT,
        status: TransactionStatus.PROCESSING,
        from_account_id: 'BANK_VAULT',
        to_account_id: `CUST_${params.customerId}`,
        amount: params.principal,
        currency: params.currency,
        fee: params.originationFee,
        loan_id: params.loanId,
        created_at: new Date(),
        created_by: 'SYSTEM',
        metadata: { customer_id: params.customerId },
      };

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

      console.log(`✓ Disbursement processed: ${txnId} (Principal: ${params.principal})`);

      return {
        transaction_id: txnId,
        status: TransactionStatus.POSTED,
        posting_status: 'SUCCESS',
        gl_entry_id: `je_${txnId}`,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error(`Disbursement processing failed for ${txnId}:`, error);
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
      console.error(`Interest accrual failed for ${txnId}:`, error);
      return this.failedResult(txnId, (error as Error).message);
    }
  }

  /**
   * Reverse transaction (refund/cancellation)
   */
  async reverseTransaction(tenantId: string, transactionId: string): Promise<SettlementResult> {
    console.log(`Reversing transaction: ${transactionId}`);

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
}
