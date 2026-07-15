import { Test, TestingModule } from '@nestjs/testing';
import { AccountLifecycleController } from '../../src/controllers/account-lifecycle.controller';
import { AccountsController } from '../../src/controllers/accounts.controller';
import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { ProductConfigService, ProductType } from '../../src/products/product-config.service';
import { AccountsService } from '../../src/services/accounts.service';
import { AuditTrailService } from '../../src/services/audit-trail.service';
import { FengineStoreService } from '../../src/services/fengine-store.service';
import { PrismaService } from '../../src/services/prisma.service';

describe('controlled account lifecycle', () => {
  let accounts: AccountsService;
  let ledger: LedgerService;
  let products: ProductConfigService;
  let audit: AuditTrailService;

  const tenantId = 'tenant_controlled_accounts';
  const maker = {
    subject: 'operator_maker',
    roles: ['operations_maker'],
    permissions: ['finance.read', 'finance.write'],
    institutionId: 'institution_001',
    branchId: 'branch_001',
    correlationId: 'corr_account_lifecycle',
  };
  const checker = {
    subject: 'operator_checker',
    roles: ['operations_checker'],
    permissions: ['finance.read', 'finance.approve'],
    institutionId: 'institution_001',
    branchId: 'branch_001',
    correlationId: 'corr_account_lifecycle',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController, AccountLifecycleController],
      providers: [
        AccountsService,
        AuditTrailService,
        FengineStoreService,
        ProductConfigService,
        DomainEventFactory,
        DomainOutboxService,
        LedgerService,
        {
          provide: PrismaService,
          useValue: { isConfigured: false },
        },
      ],
    }).compile();
    accounts = module.get(AccountsService);
    ledger = module.get(LedgerService);
    products = module.get(ProductConfigService);
    audit = module.get(AuditTrailService);
    await products.createOrUpdateProduct(tenantId, ProductType.CHECKING, {
      product_id: 'prod_current_account',
      name: 'Current Account',
      enabled: true,
    });
    await ledger.initializeChartOfAccounts(tenantId);
  });

  it('opens at zero and builds balance and statement from journal-backed entries', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    expect(account).toMatchObject({ status: 'ACTIVE', balance: '0.00', currency: 'MZN' });

    const entry = await ledger.postJournalEntry(tenantId, journal('credit_001', account.id, 'CREDIT', '100.00'));
    const replay = await ledger.postJournalEntry(tenantId, journal('credit_001', account.id, 'CREDIT', '100.00'));
    await ledger.postJournalEntry(tenantId, journal('credit_001_second', account.id, 'CREDIT', '50.00'));
    const balance = await accounts.getBalance(tenantId, account.id);
    const firstPage = await accounts.statement(tenantId, account.id, { limit: 1 });
    const secondPage = await accounts.statement(tenantId, account.id, { limit: 1, cursor: firstPage.next_cursor });
    const trialBalance = await ledger.generateTrialBalance(tenantId, new Date());

    expect(entry.entry_id).toBe(replay.entry_id);
    expect(balance.balance).toBe('150.00');
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    expect(secondPage.entries).toHaveLength(1);
    expect([...firstPage.entries, ...secondPage.entries]).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'CREDIT', amount: '100.00', balance_after: '100.00' }),
      expect.objectContaining({ direction: 'CREDIT', amount: '50.00', balance_after: '150.00' }),
    ]));
    expect(trialBalance.is_balanced).toBe(true);
  });

  it('requires a different checker and applies freeze, unfreeze and close', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    await ledger.postJournalEntry(tenantId, journal('credit_002', account.id, 'CREDIT', '100.00'));
    const freeze = await accounts.submitLifecycleRequest(tenantId, account.id, 'FREEZE', 'Operational hold', maker);
    const selfChecker = { ...checker, subject: maker.subject };

    await expect(accounts.approveLifecycleRequest(tenantId, freeze.id, undefined, selfChecker))
      .rejects.toThrow('Self-approval is not permitted');
    await expect(accounts.approveLifecycleRequest(tenantId, freeze.id, 'Reviewed', checker))
      .resolves.toMatchObject({ status: 'APPLIED' });
    await expect(ledger.postJournalEntry(tenantId, journal('debit_blocked', account.id, 'DEBIT', '10.00')))
      .rejects.toThrow('frozen for debits');
    await expect(ledger.postJournalEntry(tenantId, journal('credit_allowed', account.id, 'CREDIT', '25.00')))
      .resolves.toMatchObject({ status: 'POSTED' });

    const unfreeze = await accounts.submitLifecycleRequest(tenantId, account.id, 'UNFREEZE', 'Hold cleared', maker);
    await accounts.approveLifecycleRequest(tenantId, unfreeze.id, undefined, checker);
    await ledger.postJournalEntry(tenantId, journal('debit_to_zero', account.id, 'DEBIT', '125.00'));
    const close = await accounts.submitLifecycleRequest(tenantId, account.id, 'CLOSE', 'Customer request', maker);
    await expect(accounts.approveLifecycleRequest(tenantId, close.id, undefined, checker))
      .resolves.toMatchObject({ status: 'APPLIED' });
    await expect(ledger.postJournalEntry(tenantId, journal('closed_credit', account.id, 'CREDIT', '1.00')))
      .rejects.toThrow('is closed');
    await expect(accounts.getAccount(tenantId, account.id)).resolves.toMatchObject({ status: 'CLOSED', balance: '0.00' });
  });

  it('rejects lifecycle decisions without changing the account and records structured audit', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const request = await accounts.submitLifecycleRequest(tenantId, account.id, 'FREEZE', 'Review required', maker);
    const rejected = await accounts.rejectLifecycleRequest(tenantId, request.id, 'Evidence was insufficient', checker);
    const events = await audit.listByTenant(tenantId);

    expect(rejected.status).toBe('REJECTED');
    await expect(accounts.getAccount(tenantId, account.id)).resolves.toMatchObject({ status: 'ACTIVE' });
    const rejectedAudit = events.find((event) => event.action === 'account.lifecycle.rejected');
    expect(rejectedAudit).toMatchObject({
      actor_id: checker.subject,
      metadata: expect.objectContaining({
        result: 'REJECTED',
        approval_reference: request.id,
        maker_subject: maker.subject,
        checker_subject: checker.subject,
      }),
    });
    expect(rejectedAudit?.phase).toBeUndefined();
  });

  it('serializes concurrent approvals without applying the transition twice', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const request = await accounts.submitLifecycleRequest(tenantId, account.id, 'FREEZE', 'Concurrent review', maker);
    const secondChecker = {
      ...checker,
      subject: 'operator_checker_2',
    };

    const approvals = await Promise.all([
      accounts.approveLifecycleRequest(tenantId, request.id, undefined, checker),
      accounts.approveLifecycleRequest(tenantId, request.id, undefined, secondChecker),
    ]);
    const updated = await accounts.getAccount(tenantId, account.id);

    expect(approvals).toEqual([
      expect.objectContaining({ status: 'APPLIED' }),
      expect.objectContaining({ status: 'APPLIED' }),
    ]);
    expect(updated).toMatchObject({ status: 'FROZEN', version: 2 });
  });

  it('rejects reuse of an account posting key with a different journal', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    const first = journal('posting_key_first', account.id, 'CREDIT', '20.00', 'posting-key-shared');
    const conflicting = journal('posting_key_second', account.id, 'CREDIT', '20.00', 'posting-key-shared');
    await ledger.postJournalEntry(tenantId, first);
    const before = await ledger.generateTrialBalance(tenantId, new Date());

    await expect(ledger.postJournalEntry(tenantId, conflicting))
      .rejects.toThrow('already used by another account entry');
    const after = await ledger.generateTrialBalance(tenantId, new Date());

    expect(after.total_debits).toBe(before.total_debits);
    expect(after.total_credits).toBe(before.total_credits);
    await expect(accounts.getBalance(tenantId, account.id)).resolves.toMatchObject({ balance: '20.00' });
  });

  it('fails close approval while balance is non-zero', async () => {
    const account = await createAccount(accounts, tenantId, maker);
    await ledger.postJournalEntry(tenantId, journal('credit_close_check', account.id, 'CREDIT', '50.00'));
    const close = await accounts.submitLifecycleRequest(tenantId, account.id, 'CLOSE', 'Premature close', maker);

    await expect(accounts.approveLifecycleRequest(tenantId, close.id, undefined, checker))
      .rejects.toThrow('Account balance must be zero before close');
    await expect(accounts.getLifecycleRequest(tenantId, close.id)).resolves.toMatchObject({ status: 'FAILED' });
    await expect(accounts.getAccount(tenantId, account.id)).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('rejects disabled and non-account products', async () => {
    await products.createOrUpdateProduct(tenantId, ProductType.SAVINGS, {
      product_id: 'prod_disabled_savings',
      name: 'Disabled Savings',
      enabled: false,
    });
    await products.createOrUpdateProduct(tenantId, ProductType.LOAN, {
      product_id: 'prod_loan_only',
      name: 'Loan Product',
      enabled: true,
    });
    const input = {
      customer_id: 'customer_invalid_product',
      name: 'Invalid Product Account',
      currency: 'MZN',
    };

    await expect(accounts.createAccount(tenantId, { ...input, product_id: 'prod_disabled_savings' }, maker))
      .rejects.toThrow('is disabled');
    await expect(accounts.createAccount(tenantId, { ...input, product_id: 'prod_loan_only' }, maker))
      .rejects.toThrow('cannot open an account');
  });
});

async function createAccount(accounts: AccountsService, tenantId: string, actor: any) {
  return accounts.createAccount(tenantId, {
    customer_id: `customer_${Date.now()}_${Math.random()}`,
    product_id: 'prod_current_account',
    name: 'Controlled Current Account',
    currency: 'MZN',
  }, actor);
}

function journal(
  suffix: string,
  accountId: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
  postingKey?: string,
) {
  const numericAmount = Number(amount);
  return {
    entry_id: `je_${suffix}`,
    entry_date: new Date(),
    transaction_id: `txn_${suffix}`,
    description: `Controlled account posting ${suffix}`,
    posted_by: 'SYSTEM',
    posting_date: new Date(),
    entries: [
      { account_code: '10010', debit_amount: numericAmount },
      { account_code: '20010', credit_amount: numericAmount },
    ],
    account_postings: [{
      accountId,
      direction,
      amount,
      currency: 'MZN',
      reference: suffix,
      postingKey,
    }],
    status: 'DRAFT' as const,
    metadata: {},
  };
}
