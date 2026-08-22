import { Test, TestingModule } from '@nestjs/testing';
import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { RulesEngineService } from '../../src/rules-engine/rules-engine.service';
import { AccountsService } from '../../src/services/accounts.service';
import { AuditTrailService } from '../../src/services/audit-trail.service';
import { FengineStoreService } from '../../src/services/fengine-store.service';
import { PrismaService } from '../../src/services/prisma.service';
import { TransactionService } from '../../src/transactions/transaction.service';

describe('transaction posting idempotency', () => {
  const tenantId = 'tenant_txn_idempotency';
  let transactions: TransactionService;
  let ledger: LedgerService;
  let store: FengineStoreService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        LedgerService,
        RulesEngineService,
        AccountsService,
        AuditTrailService,
        FengineStoreService,
        DomainEventFactory,
        DomainOutboxService,
        {
          provide: PrismaService,
          useValue: { isConfigured: false },
        },
      ],
    }).compile();

    transactions = module.get(TransactionService);
    ledger = module.get(LedgerService);
    store = module.get(FengineStoreService);
    await ledger.initializeChartOfAccounts(tenantId);
  });

  it('does not post a second payment journal when save fails after the GL write', async () => {
    const payment = {
      tenantId,
      customerId: 'cust_001',
      accountId: 'CUST_cust_001',
      loanId: 'loan_001',
      paymentAmount: 2500,
      currency: 'MZN',
      productId: 'prod_loan_001',
      principalDue: 2000,
      interestDue: 500,
      feesDue: 0,
      currentBalance: 25000,
      idempotencyKey: 'idem_payment_crash_retry',
    };
    const save = store.saveTransaction.bind(store);
    jest.spyOn(store, 'saveTransaction')
      .mockImplementationOnce(async () => {
        throw new Error('connection lost after journal post');
      })
      .mockImplementation(save);

    const failed = await transactions.processPayment(payment);
    const retried = await transactions.processPayment(payment);
    const cash = await store.getAccount(tenantId, '10010');
    const journals = (await store.listJournalEntries(tenantId))
      .filter((entry) => entry.transaction_id === retried.transaction_id);

    expect(failed.posting_status).toBe('FAILED');
    expect(retried.posting_status).toBe('SUCCESS');
    expect(retried.transaction_id).toMatch(/^txn_[a-f0-9]{32}$/);
    expect(journals).toHaveLength(1);
    expect(cash?.balance_debit).toBe(2500);
  });

  it('does not post a second disbursement journal when the posted-state save fails', async () => {
    const disbursement = {
      tenantId,
      customerId: 'cust_001',
      loanId: 'loan_002',
      principal: 25000,
      originationFee: 0,
      currency: 'MZN',
      idempotencyKey: 'idem_disburse_crash_retry',
    };
    const save = store.saveTransaction.bind(store);
    jest.spyOn(store, 'saveTransaction').mockImplementation(async (id, transaction) => {
      if (transaction.status === 'POSTED') {
        throw new Error('connection lost after journal post');
      }
      return save(id, transaction);
    });

    const failed = await transactions.processDisbursement(disbursement);
    (store.saveTransaction as jest.Mock).mockImplementation(save);

    const retried = await transactions.processDisbursement(disbursement);
    const cash = await store.getAccount(tenantId, '10010');
    const journals = (await store.listJournalEntries(tenantId))
      .filter((entry) => entry.transaction_id === retried.transaction_id);

    expect(failed.posting_status).toBe('FAILED');
    expect(retried.posting_status).toBe('SUCCESS');
    expect(retried.transaction_id).toBe(failed.transaction_id);
    expect(journals).toHaveLength(1);
    expect(cash?.balance_credit).toBe(25000);
  });
});
