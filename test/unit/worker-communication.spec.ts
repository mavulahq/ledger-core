import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainInboxService } from '../../src/domain-events/domain-inbox.service';
import { DomainOutboxPublisherService } from '../../src/domain-events/domain-outbox-publisher.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { JournalEntry } from '../../src/ledger/ledger.service';
import { Loan, LoanStatus, LoanType } from '../../src/loans/loan.service';
import { ProductSchema, ProductType } from '../../src/products/product-config.service';
import { EngineEventService } from '../../src/worker/engine-event.service';
import { WorkerQueueService } from '../../src/worker/worker-queue.service';

describe('ledger-core worker communication', () => {
  beforeEach(() => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
  });

  afterEach(() => {
    delete process.env.FENGINE_QUEUE_BACKEND;
  });

  it('publishes idempotent BullMQ-compatible engine jobs', async () => {
    const queue = new WorkerQueueService();
    const first = await queue.enqueue({
      tenant_id: 'tenant_001',
      event_type: 'LOAN_APPROVED',
      payload: { loan_id: 'loan_001' },
      idempotency_key: 'loan-approved-001',
    });

    expect(first).toMatchObject({
      id: 'ledger-core-loan-approved-001',
      queue: 'platform',
      type: 'LEDGER_CORE_EVENT',
      status: 'QUEUED',
      payload: { loan_id: 'loan_001', event_type: 'LOAN_APPROVED' },
    });
    await expect(queue.get(first.id)).resolves.toEqual(first);
  });

  it('publishes canonical domain events through the Outbox publisher', async () => {
    const queue = new WorkerQueueService();
    const outbox = new DomainOutboxService({ isConfigured: false } as any);
    const publisher = new DomainOutboxPublisherService(outbox, queue);
    const factory = new DomainEventFactory();
    const disbursementEvent = factory.loanDisbursed({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'disburse_loan_001',
      currency: 'MZN',
      idempotencyKey: 'idem_disburse_loan_001',
    });
    const paymentEvent = factory.lendingPaymentPosted({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'txn_loan_001',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 2500,
      currency: 'MZN',
      allocation: {
        principal_payment: 1375,
        interest_payment: 625,
        fee_payment: 500,
        balance_after: 23625,
      },
      idempotencyKey: 'idem_payment_loan_001',
    });
    const productEvent = factory.productsConfigurationPublished({
      tenantId: 'tenant_001',
      product: productConfiguration(),
    });
    const journalEvent = factory.ledgerJournalPosted({
      tenantId: 'tenant_001',
      entry: journalEntry(),
      lines: [
        { account_code: '10010', currency: 'MZN', debit: '2500.00', credit: '0.00' },
        { account_code: '11100', currency: 'MZN', debit: '0.00', credit: '2500.00' },
      ],
    });

    await outbox.append(disbursementEvent);
    await outbox.append(paymentEvent);
    await outbox.append(productEvent);
    await outbox.append(journalEvent);
    await expect(publisher.publishPending(1)).resolves.toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });

    const queued = await queue.get(`ledger-core-${disbursementEvent.event_id}`);
    expect(queued).toMatchObject({
      type: 'LEDGER_CORE_EVENT',
      tenant_id: 'tenant_001',
      payload: {
        domain_event: true,
        event_type: 'lending.loan_disbursed',
      },
    });
    expect(queued?.payload.event).toMatchObject({
      event_id: disbursementEvent.event_id,
      event_type: 'lending.loan_disbursed',
    });
    await expect(publisher.publishPending(1)).resolves.toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    const paymentQueued = await queue.get(`ledger-core-${paymentEvent.event_id}`);
    expect(paymentQueued).toMatchObject({
      payload: {
        domain_event: true,
        event_type: 'lending.payment_posted',
      },
    });
    expect(paymentQueued?.payload.event.payload).toMatchObject({
      transaction_id: 'txn_loan_001',
      allocation: { principal: '1375.00', interest: '625.00', fees: '500.00' },
      balance_after: '23625.00',
    });
    await expect(publisher.publishPending(1)).resolves.toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    const productQueued = await queue.get(`ledger-core-${productEvent.event_id}`);
    expect(productQueued).toMatchObject({
      payload: {
        domain_event: true,
        event_type: 'products.configuration_published',
      },
    });
    expect(productQueued?.payload.event.payload).toMatchObject({
      product_id: 'prod_loan_001',
      product_type: ProductType.LOAN,
      configuration_version: 2,
    });
    await expect(publisher.publishPending(1)).resolves.toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    const journalQueued = await queue.get(`ledger-core-${journalEvent.event_id}`);
    expect(journalQueued).toMatchObject({
      payload: {
        domain_event: true,
        event_type: 'ledger.journal_posted',
      },
    });
    expect(journalQueued?.payload.event.payload).toMatchObject({
      journal_entry_id: 'je_txn_001',
      transaction_id: 'txn_001',
      totals: [{ currency: 'MZN', debit: '2500.00', credit: '2500.00' }],
    });
    await expect(outbox.list('tenant_001')).resolves.toEqual([
      expect.objectContaining({ status: 'PUBLISHED' }),
      expect.objectContaining({ status: 'PUBLISHED' }),
      expect.objectContaining({ status: 'PUBLISHED' }),
      expect.objectContaining({ status: 'PUBLISHED' }),
    ]);
  });

  it('executes workflows for callbacks and replays completed jobs safely', async () => {
    const schemas = {
      getWorkflowsByTrigger: jest.fn().mockResolvedValue([{ workflow_id: 'wf_001' }]),
      executeWorkflow: jest.fn().mockResolvedValue({ success: true, results: [] }),
    };
    const audit = { record: jest.fn() };
    const service = new EngineEventService(schemas as any, audit as any);
    const event = {
      job_id: 'job_001',
      tenant_id: 'tenant_001',
      event_type: 'LOAN_APPROVED',
      payload: { loan_id: 'loan_001' },
    };

    await expect(service.handle(event)).resolves.toMatchObject({
      accepted: true,
      executed_workflows: 1,
    });
    await expect(service.handle(event)).resolves.toMatchObject({
      accepted: true,
      idempotent: true,
    });
    expect(schemas.executeWorkflow).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('deduplicates domain event workflow dispatch through Inbox', async () => {
    const schemas = {
      getWorkflowsByTrigger: jest.fn().mockResolvedValue([{ workflow_id: 'wf_001' }]),
      executeWorkflow: jest.fn().mockResolvedValue({ success: true, results: [] }),
    };
    const audit = { record: jest.fn() };
    const inbox = new DomainInboxService({ isConfigured: false } as any);
    const service = new EngineEventService(schemas as any, audit as any, inbox);
    const event = new DomainEventFactory().lendingPaymentPosted({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'txn_loan_002',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 2500,
      currency: 'MZN',
      allocation: {
        principal_payment: 1375,
        interest_payment: 625,
        fee_payment: 500,
        balance_after: 23625,
      },
    });

    await expect(service.handleDomainEvent(event, 'job_001')).resolves.toMatchObject({
      accepted: true,
      event_id: event.event_id,
      executed_workflows: 1,
    });
    await expect(service.handleDomainEvent(event, 'job_001')).resolves.toMatchObject({
      accepted: true,
      idempotent: true,
    });
    expect(schemas.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('keeps payment settlement events outside active financial processing', async () => {
    const schemas = {
      getWorkflowsByTrigger: jest.fn().mockResolvedValue([{ workflow_id: 'wf_settlement_001' }]),
      executeWorkflow: jest.fn(),
    };
    const audit = { record: jest.fn() };
    const inbox = new DomainInboxService({ isConfigured: false } as any);
    const projections = {
      apply: jest.fn().mockResolvedValue({ applied: false, ignored: true }),
    };
    const service = new EngineEventService(schemas as any, audit as any, inbox, projections as any);
    const event = {
      event_id: 'evt_7e2edbbb-9ea6-4d7d-85f0-098594d79e9b',
      event_type: 'payments.settlement_completed',
      event_version: 1,
      occurred_at: '2026-06-30T10:00:00.000Z',
      tenant_id: 'tenant_001',
      aggregate: { type: 'settlement', id: 'settlement_001', version: 1 },
      correlation_id: 'corr_payment_settlement_001',
      causation_id: 'cmd_7e2edbbb-9ea6-4d7d-85f0-098594d79e9b',
      idempotency_key: 'idem_7e2edbbb-9ea6-4d7d-85f0-098594d79e9b',
      payload: {
        settlement_id: 'settlement_001',
        payment_process_id: 'settlement_001',
        provider_reference: 'mpesa_ref_001',
        rail: 'mpesa',
        money: { amount: '150.00', currency: 'MZN' },
        settled_at: '2026-06-30T10:00:00.000Z',
        reconciliation_status: 'MATCHED',
      },
      metadata: {
        producer: 'settlements',
        data_classification: 'restricted',
        schema_uri: 'contracts/domain-events/event-envelope.schema.json',
      },
    };

    await expect(service.handleDomainEvent(event as any, 'job_settlement_001')).resolves.toMatchObject({
      accepted: true,
      event_type: 'payments.settlement_completed',
      executed_workflows: 0,
    });
    expect(projections.apply).toHaveBeenCalledWith(event);
    expect(schemas.getWorkflowsByTrigger).not.toHaveBeenCalled();
    expect(schemas.executeWorkflow).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'domain_event.processed',
      entity_id: 'evt_7e2edbbb-9ea6-4d7d-85f0-098594d79e9b',
    }));
  });

  it('does not let an expired outbox publisher complete a reclaimed record', async () => {
    const outbox = new DomainOutboxService({ isConfigured: false } as any);
    const event = new DomainEventFactory().loanDisbursed({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'disburse_loan_003',
      currency: 'MZN',
      idempotencyKey: 'idem_disburse_loan_003',
    });

    await outbox.append(event);
    const [claimed] = await outbox.claimPending(1);
    (outbox as any).memory.set(event.event_id, {
      ...claimed,
      locked_by: 'ledger-core-outbox-new-owner',
    });

    await outbox.markPublished(claimed);

    await expect(outbox.list('tenant_001')).resolves.toEqual([
      expect.objectContaining({
        status: 'PUBLISHING',
        locked_by: 'ledger-core-outbox-new-owner',
      }),
    ]);
  });

  it('reclaims stale inbox processing records', async () => {
    process.env.FENGINE_INBOX_PROCESSING_LEASE_MS = '1';
    const inbox = new DomainInboxService({ isConfigured: false } as any);
    const event = new DomainEventFactory().lendingPaymentPosted({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'txn_loan_003',
      sourceAccountId: 'CUST_cust_001',
      paymentAmount: 2500,
      currency: 'MZN',
      allocation: {
        principal_payment: 1375,
        interest_payment: 625,
        fee_payment: 500,
        balance_after: 23625,
      },
      idempotencyKey: 'idem_payment_loan_003',
    });

    const first = await inbox.startProcessing(event, 'workflow-dispatch');
    (inbox as any).memory.set(`${event.event_id}:workflow-dispatch`, {
      ...first.record,
      status: 'PROCESSING',
      updated_at: new Date(Date.now() - 1000),
    });

    await expect(inbox.startProcessing(event, 'workflow-dispatch')).resolves.toMatchObject({
      started: true,
      record: expect.objectContaining({ status: 'PROCESSING' }),
    });
    delete process.env.FENGINE_INBOX_PROCESSING_LEASE_MS;
  });

});

function approvedLoan(): Loan {
  return {
    id: 'loan_001',
    version: 3,
    tenant_id: 'tenant_001',
    customer_id: 'cust_001',
    product_id: 'prod_loan_001',
    loan_type: LoanType.PERSONAL,
    principal_amount: 25000,
    disbursed_amount: 25000,
    term_months: 12,
    monthly_rate: 0.025,
    annual_rate: 0.3,
    interest_method: 'SIMPLE',
    origination_fee_percent: 2,
    origination_fee_amount: 500,
    late_payment_fee_percent: 5,
    monthly_payment: 2300,
    total_interest: 2600,
    total_repayable: 27600,
    grace_months: 0,
    status: LoanStatus.ACTIVE,
    application_date: new Date(),
    approval_date: new Date(),
    disbursement_date: new Date(),
    maturity_date: new Date(),
    total_paid_principal: 0,
    total_paid_interest: 0,
    total_paid_fees: 0,
    remaining_balance: 25000,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function productConfiguration(): ProductSchema {
  return {
    product_id: 'prod_loan_001',
    version: 2,
    tenant_id: 'tenant_001',
    name: 'Personal Loan',
    type: ProductType.LOAN,
    min_principal: 1000,
    max_principal: 50000,
    min_term_months: 3,
    max_term_months: 60,
    default_interest_rate: 2.5,
    origination_fee: 2,
    late_payment_fee: 50,
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
  };
}

function journalEntry(): JournalEntry {
  return {
    entry_id: 'je_txn_001',
    entry_date: new Date('2026-06-29T10:00:00.000Z'),
    transaction_id: 'txn_001',
    description: 'Journal entry fixture',
    posted_by: 'SYSTEM',
    posting_date: new Date('2026-06-29T10:00:00.000Z'),
    entries: [
      { account_code: '10010', debit_amount: 2500 },
      { account_code: '11100', credit_amount: 2500 },
    ],
    status: 'POSTED',
    metadata: {},
  };
}
