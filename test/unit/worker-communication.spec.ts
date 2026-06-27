import { InternalApiKeyGuard } from '../../src/worker/internal-api-key.guard';
import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainInboxService } from '../../src/domain-events/domain-inbox.service';
import { DomainOutboxPublisherService } from '../../src/domain-events/domain-outbox-publisher.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { Loan, LoanStatus, LoanType } from '../../src/loans/loan.service';
import { EngineEventService } from '../../src/worker/engine-event.service';
import { WorkerQueueService } from '../../src/worker/worker-queue.service';

describe('fengine worker communication', () => {
  beforeEach(() => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });

  afterEach(() => {
    delete process.env.FENGINE_QUEUE_BACKEND;
    delete process.env.INTERNAL_API_KEY;
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
      id: 'fengine-loan-approved-001',
      queue: 'platform',
      type: 'FENGINE_EVENT',
      status: 'QUEUED',
      payload: { loan_id: 'loan_001', event_type: 'LOAN_APPROVED' },
    });
    await expect(queue.get(first.id)).resolves.toEqual(first);
  });

  it('publishes canonical domain events through the Outbox publisher', async () => {
    const queue = new WorkerQueueService();
    const outbox = new DomainOutboxService({ isConfigured: false } as any);
    const publisher = new DomainOutboxPublisherService(outbox, queue);
    const event = new DomainEventFactory().loanDisbursed({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'disburse_loan_001',
      currency: 'MZN',
      idempotencyKey: 'idem_disburse_loan_001',
    });

    await outbox.append(event);
    await expect(publisher.publishPending(1)).resolves.toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });

    const queued = await queue.get(`fengine-${event.event_id}`);
    expect(queued).toMatchObject({
      type: 'FENGINE_EVENT',
      tenant_id: 'tenant_001',
      payload: {
        domain_event: true,
        event_type: 'lending.loan_disbursed',
      },
    });
    expect(queued?.payload.event).toMatchObject({
      event_id: event.event_id,
      event_type: 'lending.loan_disbursed',
    });
    await expect(outbox.list('tenant_001')).resolves.toEqual([expect.objectContaining({ status: 'PUBLISHED' })]);
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
    const event = new DomainEventFactory().loanDisbursed({
      tenantId: 'tenant_001',
      loan: approvedLoan(),
      transactionId: 'disburse_loan_002',
      currency: 'MZN',
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

  it('rejects missing or invalid internal API keys', () => {
    const guard = new InternalApiKeyGuard();
    const context = (key?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: key ? { 'x-internal-api-key': key } : {},
          }),
        }),
      }) as any;

    expect(() => guard.canActivate(context())).toThrow('Internal API key is required');
    expect(() => guard.canActivate(context('invalid-key'))).toThrow('Invalid internal API key');
    expect(guard.canActivate(context('test-internal-key'))).toBe(true);
  });
});

function approvedLoan(): Loan {
  return {
    id: 'loan_001',
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
