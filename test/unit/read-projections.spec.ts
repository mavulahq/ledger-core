import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainInboxService } from '../../src/domain-events/domain-inbox.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { JournalEntry } from '../../src/ledger/ledger.service';
import { Loan, LoanStatus, LoanType } from '../../src/loans/loan.service';
import { ProductType } from '../../src/products/product-config.service';
import { ReadProjectionService } from '../../src/read-models/read-projection.service';

describe('read projections', () => {
  const tenantId = 'tenant_001';

  let outbox: DomainOutboxService;
  let service: ReadProjectionService;
  let factory: DomainEventFactory;

  beforeEach(() => {
    const prisma = { isConfigured: false } as any;
    outbox = new DomainOutboxService(prisma);
    service = new ReadProjectionService(prisma, new DomainInboxService(prisma), outbox);
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
