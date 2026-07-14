import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainInboxService } from '../../src/domain-events/domain-inbox.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { readFileSync } from 'fs';
import { JournalEntry } from '../../src/ledger/ledger.service';
import { Loan, LoanStatus, LoanType } from '../../src/loans/loan.service';
import { ProductType } from '../../src/products/product-config.service';
import { ReadProjectionService } from '../../src/read-models/read-projection.service';

describe('read projections', () => {
  const tenantId = 'tenant_001';

  let outbox: DomainOutboxService;
  let inbox: DomainInboxService;
  let service: ReadProjectionService;
  let factory: DomainEventFactory;

  beforeEach(() => {
    const prisma = { isConfigured: false } as any;
    outbox = new DomainOutboxService(prisma);
    inbox = new DomainInboxService(prisma);
    service = new ReadProjectionService(prisma, inbox, outbox);
    factory = new DomainEventFactory();
  });

  it('projects loan, ledger, and product events idempotently', async () => {
    const loan = approvedLoan();
    const disbursed = factory.loanDisbursed({
      tenantId,
      loan,
      transactionId: 'disburse_loan_001',
      currency: 'MZN',
    });
    const payment = factory.lendingPaymentPosted({
      tenantId,
      loan,
      transactionId: 'payment_loan_001',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 2500,
      currency: 'MZN',
      allocation: {
        principal_payment: 2000,
        interest_payment: 400,
        fee_payment: 100,
        balance_after: 23000,
      },
    });
    const journal = factory.ledgerJournalPosted({
      tenantId,
      entry: journalEntry(),
      lines: [
        { account_code: '10010', currency: 'MZN', debit: '2500.00', credit: '0.00' },
        { account_code: '11100', currency: 'MZN', debit: '0.00', credit: '2500.00' },
      ],
    });
    const product = factory.productsConfigurationPublished({
      tenantId,
      product: {
        tenant_id: tenantId,
        product_id: 'prod_loan_001',
        type: ProductType.LOAN,
        name: 'Loan Product',
        enabled: true,
        version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    await service.apply(disbursed);
    await service.apply(payment);
    await service.apply(journal);
    await service.apply(product);
    await expect(service.apply(payment)).resolves.toMatchObject({
      applied: false,
      idempotent: true,
    });

    const loanProjection = await service.get(tenantId, 'loan_activity', loan.id);
    const ledgerProjection = await service.get(tenantId, 'ledger_activity', 'je_txn_001');
    const productProjection = await service.get(tenantId, 'product_publication', 'prod_loan_001');
    const status = await service.status(tenantId);

    expect(loanProjection?.data).toMatchObject({
      loan_id: loan.id,
      activity_count: 2,
      balance_after: '23000.00',
    });
    expect(ledgerProjection?.data).toMatchObject({
      journal_entry_id: 'je_txn_001',
      line_count: 2,
    });
    expect(productProjection?.data).toMatchObject({
      product_id: 'prod_loan_001',
      latest_version: 1,
      publications: [expect.objectContaining({ configuration_version: 1 })],
    });
    expect(status.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projection_name: 'loan_activity', event_count: 2 }),
        expect.objectContaining({ projection_name: 'ledger_activity', event_count: 1 }),
        expect.objectContaining({ projection_name: 'product_publication', event_count: 1 }),
      ]),
    );
  });

  it('rebuilds projections from Outbox records', async () => {
    const event = factory.loanDisbursed({
      tenantId,
      loan: approvedLoan(),
      transactionId: 'disburse_loan_002',
      currency: 'MZN',
    });
    await outbox.append(event);

    await expect(service.rebuild({ tenantId })).resolves.toMatchObject({
      rebuilt: 1,
      scanned: 1,
      tenant_id: tenantId,
    });
    await expect(service.get(tenantId, 'loan_activity', 'loan_001')).resolves.toMatchObject({
      data: expect.objectContaining({
        latest_transaction_id: 'disburse_loan_002',
      }),
    });
  });

  it('does not duplicate projection history when an inbox record is replayed', async () => {
    const event = factory.loanDisbursed({
      tenantId,
      loan: approvedLoan(),
      transactionId: 'disburse_loan_004',
      currency: 'MZN',
    });

    await service.apply(event);
    await inbox.reset(tenantId, event.event_id, 'fengine.read-models');
    await service.apply(event);

    await expect(service.get(tenantId, 'loan_activity', 'loan_001')).resolves.toMatchObject({
      data: expect.objectContaining({
        activity_count: 1,
        activities: [expect.objectContaining({ event_id: event.event_id })],
      }),
    });
    await expect(service.status(tenantId)).resolves.toMatchObject({
      projections: [expect.objectContaining({ projection_name: 'loan_activity', event_count: 1 })],
    });
  });

  it('serializes concurrent updates for the same projected entity', async () => {
    const loan = approvedLoan();
    const disbursed = factory.loanDisbursed({
      tenantId,
      loan,
      transactionId: 'disburse_loan_005',
      currency: 'MZN',
      aggregateVersion: 1,
    });
    const firstPayment = factory.lendingPaymentPosted({
      tenantId,
      loan: { ...loan, version: 2 },
      transactionId: 'payment_loan_005_a',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 1500,
      currency: 'MZN',
      allocation: {
        principal_payment: 1200,
        interest_payment: 300,
        fee_payment: 0,
        balance_after: 23800,
      },
      aggregateVersion: 2,
    });
    const secondPayment = factory.lendingPaymentPosted({
      tenantId,
      loan: { ...loan, version: 3 },
      transactionId: 'payment_loan_005_b',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 2000,
      currency: 'MZN',
      allocation: {
        principal_payment: 1700,
        interest_payment: 300,
        fee_payment: 0,
        balance_after: 22100,
      },
      aggregateVersion: 3,
    });

    await Promise.all([
      service.apply(disbursed),
      service.apply(firstPayment),
      service.apply(secondPayment),
    ]);

    await expect(service.get(tenantId, 'loan_activity', loan.id)).resolves.toMatchObject({
      data: expect.objectContaining({
        activity_count: 3,
        latest_transaction_id: 'payment_loan_005_b',
        balance_after: '22100.00',
      }),
    });
  });

  it('keeps the latest projection state when older events arrive later', async () => {
    const productId = 'prod_projection_order';
    const earlier = factory.productsConfigurationPublished({
      tenantId,
      product: product(productId, 1, 'Order Product v1', true),
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const later = factory.productsConfigurationPublished({
      tenantId,
      product: product(productId, 2, 'Order Product v2', false),
      occurredAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await service.apply(later);
    await service.apply(earlier);

    await expect(service.get(tenantId, 'product_publication', productId)).resolves.toMatchObject({
      data: expect.objectContaining({
        latest_version: 2,
        name: 'Order Product v2',
        enabled: false,
        publications: [
          expect.objectContaining({ configuration_version: 1 }),
          expect.objectContaining({ configuration_version: 2 }),
        ],
      }),
    });
    await expect(service.status(tenantId)).resolves.toMatchObject({
      projections: [
        expect.objectContaining({
          projection_name: 'product_publication',
          last_event_id: later.event_id,
        }),
      ],
    });
  });

  it('keeps latest state when legacy projection history has no aggregate version', async () => {
    const productId = 'prod_projection_legacy';
    const existing = {
      tenant_id: tenantId,
      projection_name: 'product_publication',
      entity_id: productId,
      entity_type: 'product_configuration',
      data: {
        product_id: productId,
        product_type: ProductType.LOAN,
        name: 'Legacy Product v2',
        enabled: false,
        latest_version: 2,
        publications: [
          {
            event_id: 'evt_11111111-1111-4111-8111-111111111111',
            occurred_at: '2026-01-02T00:00:00.000Z',
            configuration_version: 2,
            enabled: false,
            name: 'Legacy Product v2',
            product_type: ProductType.LOAN,
          },
        ],
      },
      last_event_id: 'evt_11111111-1111-4111-8111-111111111111',
      last_event_type: 'products.configuration_published',
      last_event_version: 1,
      last_occurred_at: new Date('2026-01-02T00:00:00.000Z'),
      created_at: new Date('2026-01-02T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };
    (service as any).memory.set(`${tenantId}:product_publication:${productId}`, existing);
    const older = factory.productsConfigurationPublished({
      tenantId,
      product: product(productId, 1, 'Legacy Product v1', true),
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.apply(older);

    await expect(service.get(tenantId, 'product_publication', productId)).resolves.toMatchObject({
      last_event_id: 'evt_11111111-1111-4111-8111-111111111111',
      last_event_type: 'products.configuration_published',
      last_event_version: 1,
      data: expect.objectContaining({
        latest_version: 2,
        name: 'Legacy Product v2',
        enabled: false,
        publications: [
          expect.objectContaining({ configuration_version: 1 }),
          expect.objectContaining({ configuration_version: 2 }),
        ],
      }),
    });
  });

  it('infers latest legacy loan activity metadata without incoming event fallback', async () => {
    const loan = approvedLoan();
    const paymentEventId = 'evt_22222222-2222-4222-8222-222222222222';
    const existing = {
      tenant_id: tenantId,
      projection_name: 'loan_activity',
      entity_id: loan.id,
      entity_type: 'loan',
      data: {
        loan_id: loan.id,
        latest_activity_type: 'PAYMENT_POSTED',
        latest_transaction_id: 'payment_loan_legacy',
        currency: 'MZN',
        balance_after: '23000.00',
        activity_count: 1,
        activities: [
          {
            event_id: paymentEventId,
            occurred_at: '2026-01-02T00:00:00.000Z',
            transaction_id: 'payment_loan_legacy',
            activity_type: 'PAYMENT_POSTED',
            money: { amount: '2000.00', currency: 'MZN' },
            allocation: { principal: '2000.00', interest: '0.00', fees: '0.00' },
            balance_after: '23000.00',
          },
        ],
      },
      last_event_id: paymentEventId,
      last_event_type: 'lending.payment_posted',
      last_event_version: 1,
      last_occurred_at: new Date('2026-01-02T00:00:00.000Z'),
      created_at: new Date('2026-01-02T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };
    (service as any).memory.set(`${tenantId}:loan_activity:${loan.id}`, existing);
    const older = factory.loanDisbursed({
      tenantId,
      loan,
      transactionId: 'disburse_loan_legacy',
      currency: 'MZN',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      aggregateVersion: 1,
    });

    await service.apply(older);

    await expect(service.get(tenantId, 'loan_activity', loan.id)).resolves.toMatchObject({
      last_event_id: paymentEventId,
      last_event_type: 'lending.payment_posted',
      last_event_version: 1,
      data: expect.objectContaining({
        latest_event_id: paymentEventId,
        latest_event_type: 'lending.payment_posted',
        latest_transaction_id: 'payment_loan_legacy',
        balance_after: '23000.00',
      }),
    });
    await expect(service.status(tenantId)).resolves.toMatchObject({
      projections: [
        expect.objectContaining({
          projection_name: 'loan_activity',
          last_event_id: paymentEventId,
          last_event_type: 'lending.payment_posted',
        }),
      ],
    });
  });

  it('rebuilds without duplicating later event delivery', async () => {
    const event = factory.loanDisbursed({
      tenantId,
      loan: approvedLoan(),
      transactionId: 'disburse_loan_006',
      currency: 'MZN',
    });
    await outbox.append(event);
    await service.apply(event);

    await service.rebuild({ tenantId });
    await expect(service.apply(event)).resolves.toMatchObject({
      applied: false,
      idempotent: true,
    });
    await expect(service.get(tenantId, 'loan_activity', 'loan_001')).resolves.toMatchObject({
      data: expect.objectContaining({ activity_count: 1 }),
    });
  });

  it('includes projection tables in tenant isolation policies', () => {
    const rls = readFileSync(
      'prisma/migrations/20260714000200_transactional_tenant_rls/migration.sql',
      'utf8',
    );

    expect(rls).toContain("'read_projections'");
    expect(rls).toContain("'projection_checkpoints'");
    expect(rls).toContain('ENABLE ROW LEVEL SECURITY');
    expect(rls).toContain('FORCE ROW LEVEL SECURITY');
    expect(rls).not.toContain("current_tenant_id() = '*'");
  });

  it('rejects malformed envelopes before projection processing', async () => {
    const event = factory.loanDisbursed({
      tenantId,
      loan: approvedLoan(),
      transactionId: 'disburse_loan_bad_envelope',
      currency: 'MZN',
    });

    await expect(service.apply({ ...event, event_id: 'invalid_event_id' })).rejects.toThrow(
      'domain event event_id must use evt_<uuid>',
    );
  });

  it('persists a failed inbox record after database projection rollback', async () => {
    const event = factory.loanDisbursed({
      tenantId,
      loan: approvedLoan(),
      transactionId: 'disburse_loan_db_failure',
      currency: 'MZN',
    });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([
          {
            eventId: event.event_id,
            consumerName: 'fengine.read-models',
            tenantId,
            status: 'PROCESSING',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ])
        .mockRejectedValueOnce(new Error('projection select failed')),
    };
    const prisma = {
      isConfigured: true,
      withTenant: jest.fn(async (_tenantId, callback) => callback(tx)),
    } as any;
    const databaseService = new ReadProjectionService(
      prisma,
      new DomainInboxService(prisma),
      new DomainOutboxService(prisma),
    );

    await expect(databaseService.apply(event)).rejects.toThrow('projection select failed');
    expect(
      tx.$executeRaw.mock.calls.some((call) =>
        String(call[0]).includes('INSERT INTO "domain_inbox_events"'),
      ),
    ).toBe(true);
  });

  it('ignores unsupported events', async () => {
    await expect(
      service.apply({
        ...factory.loanDisbursed({
          tenantId,
          loan: approvedLoan(),
          transactionId: 'disburse_loan_003',
          currency: 'MZN',
        }),
        event_type: 'payments.settlement_completed',
      }),
    ).resolves.toEqual({ applied: false, ignored: true });
  });
});

function product(productId: string, version: number, name: string, enabled: boolean) {
  return {
    tenant_id: 'tenant_001',
    product_id: productId,
    type: ProductType.LOAN,
    name,
    enabled,
    version,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function approvedLoan(): Loan {
  const now = new Date();
  return {
    id: 'loan_001',
    version: 1,
    tenant_id: 'tenant_001',
    customer_id: 'cust_001',
    product_id: 'prod_loan_001',
    loan_type: LoanType.PERSONAL,
    status: LoanStatus.ACTIVE,
    principal_amount: 25000,
    approved_amount: 25000,
    disbursed_amount: 25000,
    term_months: 12,
    monthly_rate: 0.015,
    annual_rate: 18,
    interest_method: 'SIMPLE',
    origination_fee_percent: 2,
    origination_fee_amount: 500,
    late_payment_fee_percent: 5,
    monthly_payment: 2291.67,
    total_interest: 2500,
    total_repayable: 27500,
    grace_months: 0,
    application_date: now,
    approval_date: now,
    disbursement_date: now,
    maturity_date: now,
    total_paid_principal: 0,
    total_paid_interest: 0,
    total_paid_fees: 0,
    remaining_balance: 25000,
    created_at: now,
    updated_at: now,
  };
}

function journalEntry(): JournalEntry {
  const now = new Date();
  return {
    entry_id: 'je_txn_001',
    entry_date: now,
    transaction_id: 'txn_001',
    description: 'Journal posting',
    posted_by: 'SYSTEM',
    posting_date: now,
    entries: [
      { account_code: '10010', debit_amount: 2500 },
      { account_code: '11100', credit_amount: 2500 },
    ],
    status: 'POSTED',
    metadata: {},
  };
}
