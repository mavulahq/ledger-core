import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { FinancialAdjustmentsService } from '../../src/adjustments/financial-adjustments.service';
import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { LoanStatus, LoanType } from '../../src/loans/loan.service';
import { ProductConfigService, ProductType } from '../../src/products/product-config.service';
import { AccountsService } from '../../src/services/accounts.service';
import { AuditTrailService } from '../../src/services/audit-trail.service';
import { FengineStoreService } from '../../src/services/fengine-store.service';
import { PrismaService } from '../../src/services/prisma.service';
import { TransactionStatus, TransactionType } from '../../src/transactions/transaction.service';

describe('controlled financial adjustments', () => {
  let adjustments: FinancialAdjustmentsService;
  let accounts: AccountsService;
  let ledger: LedgerService;
  let products: ProductConfigService;
  let store: FengineStoreService;
  let outbox: DomainOutboxService;
  let audit: AuditTrailService;

  const tenantId = 'tenant_financial_adjustments';
  const maker = {
    subject: 'operator_maker',
    roles: ['operations_maker'],
    permissions: ['finance.read', 'finance.write'],
    institutionId: 'institution_001',
    branchId: 'branch_001',
    correlationId: 'corr_adjustment',
  };
  const checker = {
    subject: 'operator_checker',
    roles: ['operations_checker'],
    permissions: ['finance.read', 'finance.approve'],
    institutionId: 'institution_001',
    branchId: 'branch_001',
    correlationId: 'corr_adjustment',
  };

  beforeEach(async () => {
    const prisma = { isConfigured: false };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinancialAdjustmentsService,
        AccountsService,
        AuditTrailService,
        FengineStoreService,
        ProductConfigService,
        DomainEventFactory,
        DomainOutboxService,
        LedgerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    adjustments = module.get(FinancialAdjustmentsService);
    accounts = module.get(AccountsService);
    ledger = module.get(LedgerService);
    products = module.get(ProductConfigService);
    store = module.get(FengineStoreService);
    outbox = module.get(DomainOutboxService);
    audit = module.get(AuditTrailService);
    await products.createOrUpdateProduct(tenantId, ProductType.CHECKING, {
      product_id: 'prod_current_account',
      name: 'Current Account',
      enabled: true,
    });
    await ledger.initializeChartOfAccounts(tenantId);
  });

  it('reverses a journal and account posting without mutating the original', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const original = journal('reverse_001', account.id, '100.00');
    await ledger.postJournalEntry(tenantId, original);
    const request = await adjustments.submit(tenantId, {
      targetType: 'JOURNAL_ENTRY',
      targetId: original.entry_id,
      adjustmentType: 'REVERSAL',
      reason: 'Duplicate branch posting',
    }, maker);

    await expect(adjustments.approve(tenantId, request.id, 'Evidence verified', { ...checker, subject: maker.subject }))
      .rejects.toThrow('Self-approval is not permitted');
    const applied = await adjustments.approve(tenantId, request.id, 'Evidence verified', checker);
    const balance = await accounts.getBalance(tenantId, account.id);
    const entries = await accounts.statement(tenantId, account.id, { limit: 10 });
    const persistedOriginal = await store.getJournalEntry(tenantId, original.entry_id);

    expect(applied).toMatchObject({ status: 'APPLIED', reversalJournalEntryId: expect.any(String) });
    expect(balance.balance).toBe('0.00');
    expect(entries.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry_type: 'POSTING', amount: '100.00' }),
      expect.objectContaining({ entry_type: 'REVERSAL', amount: '100.00' }),
    ]));
    expect(persistedOriginal).toMatchObject({ status: 'POSTED' });
    expect(persistedOriginal).not.toHaveProperty('adjustment_request_id');
    expect((await audit.listByTenant(tenantId)).find((event) => event.action === 'financial.adjustment.applied'))
      .toMatchObject({ stage: 'POSTED', result: 'REVERSED', approval_reference: request.id });
  });

  it('corrects a journal through reversal and replacement and replays concurrent approval', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const original = journal('correction_001', account.id, '100.00');
    await ledger.postJournalEntry(tenantId, original);
    const request = await adjustments.submit(tenantId, {
      targetType: 'JOURNAL_ENTRY',
      targetId: original.entry_id,
      adjustmentType: 'CORRECTION',
      reason: 'Amount entered incorrectly',
      correction: {
        journal: {
          ledgerLines: [
            { account_code: '10010', debit_amount: 75 },
            { account_code: '20010', credit_amount: 75 },
          ],
          accountPostings: [{
            accountId: account.id,
            direction: 'CREDIT',
            amount: '75.00',
            currency: 'MZN',
          }],
        },
      },
    }, maker);

    const results = await Promise.all([
      adjustments.approve(tenantId, request.id, undefined, checker),
      adjustments.approve(tenantId, request.id, undefined, { ...checker, subject: 'operator_checker_2' }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'APPLIED', replacementJournalEntryId: expect.any(String) }),
      expect.objectContaining({ status: 'APPLIED', replacementJournalEntryId: expect.any(String) }),
    ]);
    await expect(accounts.getBalance(tenantId, account.id)).resolves.toMatchObject({ balance: '75.00' });
    expect((await outbox.list(tenantId)).filter((record) => record.envelope.event_type === 'ledger.adjustment_posted'))
      .toHaveLength(1);
    expect((await ledger.generateTrialBalance(tenantId, new Date())).is_balanced).toBe(true);
  });

  it('corrects the latest loan payment and keeps lending and ledger consistent', async () => {
    const loan = {
      id: 'loan_adjustment_001',
      version: 2,
      tenant_id: tenantId,
      customer_id: 'customer_loan_001',
      product_id: 'product_loan_001',
      loan_type: LoanType.PERSONAL,
      principal_amount: 1000,
      disbursed_amount: 1000,
      term_months: 12,
      monthly_rate: 0.02,
      annual_rate: 0.24,
      interest_method: 'SIMPLE' as const,
      origination_fee_percent: 0,
      origination_fee_amount: 0,
      late_payment_fee_percent: 0,
      monthly_payment: 100,
      total_interest: 0,
      total_repayable: 1000,
      grace_months: 0,
      status: LoanStatus.ACTIVE,
      application_date: new Date(),
      total_paid_principal: 100,
      total_paid_interest: 10,
      total_paid_fees: 0,
      remaining_balance: 900,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const originalTransaction = {
      id: 'txn_loan_payment_adjustment_001',
      tenant_id: tenantId,
      transaction_type: TransactionType.LOAN_PAYMENT,
      status: TransactionStatus.POSTED,
      from_account_id: 'customer_account_001',
      amount: 110,
      currency: 'MZN',
      loan_id: loan.id,
      principal_payment: 100,
      interest_payment: 10,
      fee_payment: 0,
      created_at: new Date(),
      posted_at: new Date(),
      created_by: 'SYSTEM',
      metadata: {
        settlement_result: {
          posting_status: 'SUCCESS',
          allocation: { principal_payment: 100, interest_payment: 10, fee_payment: 0, balance_after: 900 },
        },
      },
    };
    await store.saveLoan(tenantId, loan);
    await store.saveTransaction(tenantId, originalTransaction);
    await ledger.postJournalEntry(tenantId, {
      entry_id: 'je_loan_payment_adjustment_001',
      entry_date: new Date(),
      transaction_id: originalTransaction.id,
      description: 'Original loan payment',
      posted_by: 'SYSTEM',
      posting_date: new Date(),
      entries: [
        { account_code: '10010', debit_amount: 110 },
        { account_code: '11100', credit_amount: 100 },
        { account_code: '40010', credit_amount: 10 },
      ],
      status: 'DRAFT',
      metadata: {},
    });
    const request = await adjustments.submit(tenantId, {
      targetType: 'TRANSACTION',
      targetId: originalTransaction.id,
      adjustmentType: 'CORRECTION',
      reason: 'Payment allocation corrected',
      correction: {
        lending: {
          amount: '55.00',
          currency: 'MZN',
          allocation: { principal: '50.00', interest: '5.00', fees: '0.00' },
        },
      },
    }, maker);

    const applied = await adjustments.approve(tenantId, request.id, 'Approved correction', checker);
    const correctedLoan = await store.getLoan(tenantId, loan.id);
    const originalAfter = await store.getTransaction(tenantId, originalTransaction.id);
    const events = (await outbox.list(tenantId)).map((record) => record.envelope.event_type);

    expect(applied).toMatchObject({ status: 'APPLIED', replacementTransactionId: expect.any(String) });
    expect(correctedLoan).toMatchObject({
      version: 3,
      total_paid_principal: 50,
      total_paid_interest: 5,
      remaining_balance: 950,
      status: LoanStatus.ACTIVE,
    });
    expect(originalAfter).toMatchObject({ id: originalTransaction.id, amount: 110 });
    expect(originalAfter).not.toHaveProperty('adjustment_request_id');
    expect(events).toEqual(expect.arrayContaining(['ledger.adjustment_posted', 'lending.adjustment_applied']));
    expect((await ledger.generateTrialBalance(tenantId, new Date())).is_balanced).toBe(true);
  });

  it('reverses a loan disbursement and restores the approved state', async () => {
    const loan = loanRecord(tenantId, 'loan_disbursement_adjustment_001', LoanStatus.ACTIVE);
    const original = lendingTransaction(
      tenantId,
      'txn_loan_disbursement_adjustment_001',
      loan.id,
      TransactionType.LOAN_DISBURSEMENT,
      1000,
    );
    await store.saveLoan(tenantId, loan);
    await store.saveTransaction(tenantId, original);
    await ledger.postJournalEntry(tenantId, {
      ...journal('loan_disbursement_adjustment_001', 'unused', '1000.00'),
      transaction_id: original.id,
      entries: [
        { account_code: '11100', debit_amount: 1000 },
        { account_code: '10010', credit_amount: 1000 },
      ],
      account_postings: [],
    });
    const request = await adjustments.submit(tenantId, {
      targetType: 'TRANSACTION',
      targetId: original.id,
      adjustmentType: 'REVERSAL',
      reason: 'Disbursement released against an invalid instruction',
    }, maker);

    await adjustments.approve(tenantId, request.id, 'Instruction invalidated', checker);

    await expect(store.getLoan(tenantId, loan.id)).resolves.toMatchObject({
      version: 3,
      status: LoanStatus.APPROVED,
      disbursed_amount: 0,
      remaining_balance: 1000,
    });
    expect((await outbox.list(tenantId)).map((record) => record.envelope.event_type))
      .toEqual(expect.arrayContaining(['ledger.adjustment_posted', 'lending.adjustment_applied']));
  });

  it('fails approval when a loan has later financial effects', async () => {
    const loan = loanRecord(tenantId, 'loan_later_effect_001', LoanStatus.ACTIVE);
    const original = lendingTransaction(
      tenantId,
      'txn_loan_disbursement_later_001',
      loan.id,
      TransactionType.LOAN_DISBURSEMENT,
      1000,
    );
    original.posted_at = new Date('2026-07-15T08:00:00.000Z');
    const later = lendingTransaction(
      tenantId,
      'txn_loan_payment_later_001',
      loan.id,
      TransactionType.LOAN_PAYMENT,
      100,
    );
    later.posted_at = new Date('2026-07-15T09:00:00.000Z');
    await store.saveLoan(tenantId, loan);
    await store.saveTransaction(tenantId, original);
    await store.saveTransaction(tenantId, later);
    await ledger.postJournalEntry(tenantId, {
      ...journal('loan_disbursement_later_001', 'unused', '1000.00'),
      transaction_id: original.id,
      entries: [
        { account_code: '11100', debit_amount: 1000 },
        { account_code: '10010', credit_amount: 1000 },
      ],
      account_postings: [],
    });
    const request = await adjustments.submit(tenantId, {
      targetType: 'TRANSACTION',
      targetId: original.id,
      adjustmentType: 'REVERSAL',
      reason: 'Attempt to reverse an earlier loan effect',
    }, maker);

    await expect(adjustments.approve(tenantId, request.id, undefined, checker))
      .rejects.toThrow('Loan has later financial effects');
    await expect(adjustments.get(tenantId, request.id)).resolves.toMatchObject({
      status: 'FAILED',
      failureReason: 'Loan has later financial effects; adjust the latest transaction first',
    });
  });

  it('rejects an adjustment without posting financial effects', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const original = journal('rejected_001', account.id, '100.00');
    await ledger.postJournalEntry(tenantId, original);
    const request = await adjustments.submit(tenantId, {
      targetType: 'JOURNAL_ENTRY',
      targetId: original.entry_id,
      adjustmentType: 'REVERSAL',
      reason: 'Adjustment requested without sufficient evidence',
    }, maker);

    const rejected = await adjustments.reject(tenantId, request.id, 'Evidence rejected', checker);

    expect(rejected).toMatchObject({ status: 'REJECTED', decidedBy: checker.subject });
    await expect(accounts.getBalance(tenantId, account.id)).resolves.toMatchObject({ balance: '100.00' });
    expect((await outbox.list(tenantId)).map((record) => record.envelope.event_type))
      .not.toContain('ledger.adjustment_posted');
  });

  it('does not reopen the balance of a closed account through an adjustment', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const original = journal('closed_adjustment_original', account.id, '100.00');
    await ledger.postJournalEntry(tenantId, original);
    await ledger.postJournalEntry(tenantId, {
      ...journal('closed_adjustment_offset', account.id, '100.00'),
      account_postings: [{
        accountId: account.id,
        direction: 'DEBIT',
        amount: '100.00',
        currency: 'MZN',
      }],
    });
    const close = await accounts.submitLifecycleRequest(
      tenantId,
      account.id,
      'CLOSE',
      'Customer relationship terminated',
      maker,
    );
    await accounts.approveLifecycleRequest(tenantId, close.id, undefined, checker);

    await expect(adjustments.submit(tenantId, {
      targetType: 'JOURNAL_ENTRY',
      targetId: original.entry_id,
      adjustmentType: 'REVERSAL',
      reason: 'Attempt to alter a closed account history',
    }, maker)).rejects.toThrow('Closed accounts cannot receive financial adjustments');
    await expect(accounts.getBalance(tenantId, account.id)).resolves.toMatchObject({ balance: '0.00' });
  });

  it('enforces active-target uniqueness, tenant RLS, and append-only audit grants in migration', () => {
    const migration = readFileSync(
      'prisma/migrations/20260715000200_financial_adjustments_audit_stage/migration.sql',
      'utf8',
    );

    expect(migration).toContain("WHERE status IN ('PENDING_APPROVAL', 'APPLIED')");
    expect(migration).toContain('ALTER TABLE public.financial_adjustment_requests FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON public.audit_trail_events FROM ledger_core_app');
    expect(migration).toContain('GRANT SELECT, INSERT ON public.audit_trail_events TO ledger_core_app');
  });
});

async function createAccount(accounts: AccountsService, tenantId: string, actor: any) {
  return accounts.createAccount(tenantId, {
    customer_id: `customer_${Date.now()}_${Math.random()}`,
    product_id: 'prod_current_account',
    name: 'Adjustment Account',
    currency: 'MZN',
  }, actor);
}

function journal(suffix: string, accountId: string, amount: string) {
  const numericAmount = Number(amount);
  return {
    entry_id: `je_${suffix}`,
    entry_date: new Date(),
    transaction_id: `txn_${suffix}`,
    description: `Adjustment journal ${suffix}`,
    posted_by: 'SYSTEM',
    posting_date: new Date(),
    entries: [
      { account_code: '10010', debit_amount: numericAmount },
      { account_code: '20010', credit_amount: numericAmount },
    ],
    account_postings: [{
      accountId,
      direction: 'CREDIT' as const,
      amount,
      currency: 'MZN',
    }],
    status: 'DRAFT' as const,
    metadata: {},
  };
}

function loanRecord(tenant: string, id: string, status: LoanStatus) {
  return {
    id,
    version: 2,
    tenant_id: tenant,
    customer_id: `customer_${id}`,
    product_id: 'product_loan_001',
    loan_type: LoanType.PERSONAL,
    principal_amount: 1000,
    approved_amount: 1000,
    disbursed_amount: 1000,
    term_months: 12,
    monthly_rate: 0.02,
    annual_rate: 0.24,
    interest_method: 'SIMPLE' as const,
    origination_fee_percent: 0,
    origination_fee_amount: 0,
    late_payment_fee_percent: 0,
    monthly_payment: 100,
    total_interest: 0,
    total_repayable: 1000,
    grace_months: 0,
    status,
    application_date: new Date(),
    disbursement_date: new Date(),
    total_paid_principal: 0,
    total_paid_interest: 0,
    total_paid_fees: 0,
    remaining_balance: 1000,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function lendingTransaction(
  tenant: string,
  id: string,
  loanId: string,
  type: TransactionType,
  amount: number,
) {
  return {
    id,
    tenant_id: tenant,
    transaction_type: type,
    status: TransactionStatus.POSTED,
    from_account_id: `account_${id}`,
    amount,
    currency: 'MZN',
    loan_id: loanId,
    created_at: new Date(),
    posted_at: new Date(),
    created_by: 'SYSTEM',
    metadata: {},
  };
}
