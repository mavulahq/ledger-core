/*
 * getfluxo.io - General Ledger & Chart of Accounts Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 * 
 * Double-entry bookkeeping: GL, COA, journal entries, trial balance
 * Compliance: IFRS/Basel III ready
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import { FengineStoreService } from '../services/fengine-store.service';
import { AuditTrailService } from '../services/audit-trail.service';

// Chart of Accounts - International standard structure
export enum AccountClass {
  ASSET = '1',        // Balance sheet: current/non-current assets
  LIABILITY = '2',    // Balance sheet: current/non-current liabilities
  EQUITY = '3',       // Balance sheet: capital, retained earnings
  REVENUE = '4',      // P&L: interest income, fees
  EXPENSE = '5',      // P&L: interest expense, operational costs
}

export interface ChartOfAccounts {
  account_code: string;    // e.g., '10010' = Asset > Cash > Clearing
  account_name: string;
  account_class: AccountClass;
  account_subclass: string;
  balance_debit: number;   // Debit side balance
  balance_credit: number;  // Credit side balance
  currency: string;
  is_active: boolean;
  created_at: Date;
}

export interface JournalEntry {
  entry_id: string;
  entry_date: Date;
  transaction_id: string;  // Link to source transaction
  description: string;
  posted_by: string;       // User ID
  posting_date: Date;
  entries: LedgerLine[];
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  metadata: Record<string, any>;
}

export interface LedgerLine {
  account_code: string;
  debit_amount?: number;
  credit_amount?: number;
  quantity?: number;       // For inventory tracking
  unit_cost?: number;
}

export interface TrialBalance {
  generated_at: Date;
  period: { from: Date; to: Date };
  accounts: Array<{
    account_code: string;
    account_name: string;
    debit_total: number;
    credit_total: number;
    balance: number;
    balance_type: 'DEBIT' | 'CREDIT';
  }>;
  total_debits: number;
  total_credits: number;
  is_balanced: boolean;
}

export interface GeneralLedgerReport {
  account_code: string;
  account_name: string;
  opening_balance: number;
  opening_balance_type: 'DEBIT' | 'CREDIT';
  transactions: Array<{
    date: Date;
    description: string;
    debit?: number;
    credit?: number;
    balance: number;
  }>;
  closing_balance: number;
  closing_balance_type: 'DEBIT' | 'CREDIT';
}

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private store: FengineStoreService,
    private auditTrail: AuditTrailService,
  ) {}

  /**
   * Initialize Chart of Accounts for tenant (SADC banking standard)
   */
  async initializeChartOfAccounts(tenantId: string): Promise<ChartOfAccounts[]> {
    const existing = await this.store.listChartOfAccounts(tenantId);
    if (existing.length > 0) {
      return existing;
    }

    const coa: ChartOfAccounts[] = [];

    // ASSET ACCOUNTS (10000-19999)
    const assetAccounts = [
      { code: '10010', name: 'Cash in Clearing', subclass: 'Current' },
      { code: '10020', name: 'Cash in Vault', subclass: 'Current' },
      { code: '10100', name: 'Nostro Accounts - USD', subclass: 'Current' },
      { code: '10110', name: 'Nostro Accounts - EUR', subclass: 'Current' },
      { code: '11000', name: 'Customer Deposits', subclass: 'Current' },
      { code: '11100', name: 'Loan Portfolio', subclass: 'Current' },
      { code: '11200', name: 'Overdraft Portfolio', subclass: 'Current' },
      { code: '12000', name: 'Fixed Assets', subclass: 'Non-Current' },
      { code: '12100', name: 'Accumulated Depreciation', subclass: 'Non-Current' },
    ];

    for (const acc of assetAccounts) {
      coa.push({
        account_code: acc.code,
        account_name: acc.name,
        account_class: AccountClass.ASSET,
        account_subclass: acc.subclass,
        balance_debit: 0,
        balance_credit: 0,
        currency: 'MZN',
        is_active: true,
        created_at: new Date(),
      });
    }

    // LIABILITY ACCOUNTS (20000-29999)
    const liabilityAccounts = [
      { code: '20010', name: 'Customer Current Accounts', subclass: 'Current' },
      { code: '20020', name: 'Customer Savings Accounts', subclass: 'Current' },
      { code: '20030', name: 'Interbank Borrowings', subclass: 'Current' },
      { code: '20100', name: 'Interest Payable', subclass: 'Current' },
      { code: '21000', name: 'Long-term Debt', subclass: 'Non-Current' },
    ];

    for (const acc of liabilityAccounts) {
      coa.push({
        account_code: acc.code,
        account_name: acc.name,
        account_class: AccountClass.LIABILITY,
        account_subclass: acc.subclass,
        balance_debit: 0,
        balance_credit: 0,
        currency: 'MZN',
        is_active: true,
        created_at: new Date(),
      });
    }

    // EQUITY ACCOUNTS (30000-39999)
    coa.push({
      account_code: '30000',
      account_name: 'Share Capital',
      account_class: AccountClass.EQUITY,
      account_subclass: 'Permanent',
      balance_debit: 0,
      balance_credit: 0,
      currency: 'MZN',
      is_active: true,
      created_at: new Date(),
    });

    // REVENUE ACCOUNTS (40000-49999)
    const revenueAccounts = [
      { code: '40010', name: 'Interest Income - Loans' },
      { code: '40020', name: 'Interest Income - Savings' },
      { code: '40030', name: 'Interest Income - Overdraft' },
      { code: '40100', name: 'Fee Income - Account Maintenance' },
      { code: '40110', name: 'Fee Income - Transaction Fees' },
      { code: '40120', name: 'Fee Income - Loan Origination' },
      { code: '40200', name: 'Foreign Exchange Gains' },
    ];

    for (const acc of revenueAccounts) {
      coa.push({
        account_code: acc.code,
        account_name: acc.name,
        account_class: AccountClass.REVENUE,
        account_subclass: 'Operating',
        balance_debit: 0,
        balance_credit: 0,
        currency: 'MZN',
        is_active: true,
        created_at: new Date(),
      });
    }

    // EXPENSE ACCOUNTS (50000-59999)
    const expenseAccounts = [
      { code: '50010', name: 'Interest Expense - Customer Deposits' },
      { code: '50020', name: 'Interest Expense - Interbank Borrowings' },
      { code: '50100', name: 'Salary & Benefits' },
      { code: '50110', name: 'Occupancy Costs' },
      { code: '50120', name: 'Technology & Systems' },
      { code: '50130', name: 'Audit & Compliance' },
      { code: '50140', name: 'Loan Loss Provision' },
      { code: '50200', name: 'Depreciation' },
    ];

    for (const acc of expenseAccounts) {
      coa.push({
        account_code: acc.code,
        account_name: acc.name,
        account_class: AccountClass.EXPENSE,
        account_subclass: 'Operating',
        balance_debit: 0,
        balance_credit: 0,
        currency: 'MZN',
        is_active: true,
        created_at: new Date(),
      });
    }

    await this.store.saveChartOfAccounts(tenantId, coa);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'ledger.chart.seeded',
      entity_type: 'ledger_chart',
      entity_id: tenantId,
      phase: 'ACT',
      metadata: { accounts: coa.length },
    });
    console.log(`✓ Chart of Accounts initialized for tenant ${tenantId} (${coa.length} accounts)`);
    return coa;
  }

  /**
   * Post journal entry (double-entry bookkeeping)
   * Rule: Debits must equal Credits
   */
  async postJournalEntry(tenantId: string, entry: JournalEntry): Promise<JournalEntry> {
    // Validate balanced entry
    const totalDebits = (entry.entries || [])
      .reduce((sum, line) => sum + (line.debit_amount || 0), 0);
    const totalCredits = (entry.entries || [])
      .reduce((sum, line) => sum + (line.credit_amount || 0), 0);

    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      throw new Error(`Journal entry not balanced: Debits ${totalDebits} ≠ Credits ${totalCredits}`);
    }

    // Update account balances
    for (const line of entry.entries || []) {
      if (line.debit_amount) {
        await this.updateAccountBalance(tenantId, line.account_code, line.debit_amount, 'DEBIT');
      }
      if (line.credit_amount) {
        await this.updateAccountBalance(tenantId, line.account_code, line.credit_amount, 'CREDIT');
      }
    }

    entry.status = 'POSTED';
    entry.posting_date = new Date();
    await this.store.saveJournalEntry(tenantId, entry);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'ledger.entry.posted',
      entity_type: 'journal_entry',
      entity_id: entry.entry_id,
      phase: 'ACT',
      metadata: {
        transaction_id: entry.transaction_id,
        lines: entry.entries.length,
      },
    });
    console.log(`✓ Journal entry posted: ${entry.entry_id}`);

    return entry;
  }

  /**
   * Record complete transaction as journal entry
   * Example: Customer payment
   *   DEBIT: 10010 (Cash) 5000
   *   CREDIT: 11100 (Loan Portfolio) 4500
   *   CREDIT: 40010 (Interest Income) 500
   */
  async recordPaymentTransaction(params: {
    tenantId: string;
    transactionId: string;
    customerId: string;
    payment_amount: number;
    principal_payment: number;
    interest_payment: number;
    fee_payment: number;
  }): Promise<JournalEntry> {
    const entry: JournalEntry = {
      entry_id: `je_${params.transactionId}`,
      entry_date: new Date(),
      transaction_id: params.transactionId,
      description: `Payment received from customer ${params.customerId}`,
      posted_by: 'SYSTEM',
      posting_date: new Date(),
      entries: [
        // Debit: Cash received
        { account_code: '10010', debit_amount: params.payment_amount },
        // Credit: Reduce loan principal
        { account_code: '11100', credit_amount: params.principal_payment },
        // Credit: Interest income
        { account_code: '40010', credit_amount: params.interest_payment },
        // Credit: Fee income
        { account_code: '40100', credit_amount: params.fee_payment },
      ],
      status: 'DRAFT',
      metadata: { customer_id: params.customerId },
    };

    return this.postJournalEntry(params.tenantId, entry);
  }

  /**
   * Calculate Trial Balance (sum of all accounts)
   */
  async generateTrialBalance(tenantId: string, asOfDate: Date): Promise<TrialBalance> {
    const accounts = await this.initializeChartOfAccounts(tenantId);

    const trialBalanceItems = accounts
      .filter(acc => acc.is_active)
      .map(acc => {
        const net = acc.balance_debit - acc.balance_credit;
        const balanceType: 'DEBIT' | 'CREDIT' = net >= 0 ? 'DEBIT' : 'CREDIT';
        return {
          account_code: acc.account_code,
          account_name: acc.account_name,
          debit_total: net > 0 ? net : 0,
          credit_total: net < 0 ? Math.abs(net) : 0,
          balance: net,
          balance_type: balanceType,
        };
      });

    const totalDebits = trialBalanceItems.reduce((sum, item) => sum + item.debit_total, 0);
    const totalCredits = trialBalanceItems.reduce((sum, item) => sum + item.credit_total, 0);
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

    return {
      generated_at: new Date(),
      period: { from: new Date(asOfDate.getFullYear(), 0, 1), to: asOfDate },
      accounts: trialBalanceItems,
      total_debits: totalDebits,
      total_credits: totalCredits,
      is_balanced: isBalanced,
    };
  }

  private async updateAccountBalance(
    tenantId: string,
    accountCode: string,
    amount: number,
    type: 'DEBIT' | 'CREDIT'
  ): Promise<void> {
    const account = await this.store.getAccount(tenantId, accountCode);
    if (!account) {
      throw new Error(`Account ${accountCode} not found for tenant ${tenantId}`);
    }

    if (type === 'DEBIT') {
      account.balance_debit += amount;
    } else {
      account.balance_credit += amount;
    }

    await this.store.saveAccount(tenantId, account);
    console.log(`  Update account ${accountCode}: ${type} ${amount}`);
  }

  listAccounts(tenantId: string): Promise<ChartOfAccounts[]> {
    return this.store.listChartOfAccounts(tenantId);
  }

  getAccountDetails(tenantId: string, accountCode: string): Promise<ChartOfAccounts | undefined> {
    return this.store.getAccount(tenantId, accountCode);
  }

  listEntries(tenantId: string): Promise<JournalEntry[]> {
    return this.store.listJournalEntries(tenantId);
  }
}
