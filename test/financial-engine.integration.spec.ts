/*
 * getfluxo.io - Financial Engine Integration Test
 * Copyright (c) 2025 getfluxo.io
 *
 * Test: loan lifecycle integration across products, rules, calculations, ledger, transactions, and loans.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { LoanService, LoanType, LoanStatus } from '../src/loans/loan.service';
import {
  TransactionService,
  TransactionType,
  TransactionStatus,
} from '../src/transactions/transaction.service';
import { RulesEngineService, RuleType } from '../src/rules-engine/rules-engine.service';
import { LedgerService, AccountClass } from '../src/ledger/ledger.service';
import { ProductConfigService, ProductType } from '../src/products/product-config.service';
import { PrismaService } from '../src/services/prisma.service';
import { AuditTrailService } from '../src/services/audit-trail.service';
import { FengineStoreService } from '../src/services/fengine-store.service';
import { DomainEventFactory } from '../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../src/domain-events/domain-outbox.service';

describe('Financial engine loan lifecycle integration', () => {
  let loanService: LoanService;
  let transactionService: TransactionService;
  let rulesEngine: RulesEngineService;
  let ledgerService: LedgerService;
  let productConfigService: ProductConfigService;
  let outboxService: DomainOutboxService;

  const tenantId = 'test_inst_001';
  const customerId = 'cust_001';
  const productId = 'prod_loan_001';

  beforeAll(async () => {
    // Initialize services (in production, would be injected by NestJS)
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanService,
        TransactionService,
        RulesEngineService,
        LedgerService,
        ProductConfigService,
        FengineStoreService,
        AuditTrailService,
        DomainEventFactory,
        DomainOutboxService,
        {
          provide: PrismaService,
          useValue: {
            /* mock Prisma */
          },
        },
      ],
    }).compile();

    loanService = module.get<LoanService>(LoanService);
    transactionService = module.get<TransactionService>(TransactionService);
    rulesEngine = module.get<RulesEngineService>(RulesEngineService);
    ledgerService = module.get<LedgerService>(LedgerService);
    productConfigService = module.get<ProductConfigService>(ProductConfigService);
    outboxService = module.get<DomainOutboxService>(DomainOutboxService);
  });

  it('creates a pending loan application', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Business inventory',
      metadata: { ip: '192.168.1.100', device: 'mobile' },
    });

    expect(loan).toBeDefined();
    expect(loan.status).toBe(LoanStatus.PENDING_APPROVAL);
    expect(loan.principal_amount).toBe(25000);
    expect(loan.term_months).toBe(12);
  });

  it('publishes product configuration events idempotently by product version', async () => {
    const productId = `prod_event_${Date.now()}`;
    const initial = await productConfigService.createOrUpdateProduct(tenantId, ProductType.LOAN, {
      product_id: productId,
      name: 'Evented Loan',
      enabled: true,
    });
    const updated = await productConfigService.createOrUpdateProduct(tenantId, ProductType.LOAN, {
      product_id: productId,
      name: 'Evented Loan v2',
      enabled: false,
    });
    const events = (await outboxService.list(tenantId)).filter(
      (event) =>
        event.envelope.event_type === 'products.configuration_published' &&
        event.envelope.aggregate.id === productId,
    );

    expect(initial.version).toBe(1);
    expect(updated.version).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0].envelope).toMatchObject({
      event_type: 'products.configuration_published',
      tenant_id: tenantId,
      aggregate: { type: 'product_configuration', id: productId, version: 1 },
      payload: {
        product_id: productId,
        product_type: ProductType.LOAN,
        name: 'Evented Loan',
        enabled: true,
        configuration_version: 1,
      },
      metadata: {
        producer: 'fengine',
        data_classification: 'internal',
      },
    });
    expect(events[1].envelope).toMatchObject({
      aggregate: { type: 'product_configuration', id: productId, version: 2 },
      payload: {
        product_id: productId,
        name: 'Evented Loan v2',
        enabled: false,
        configuration_version: 2,
      },
    });
  });

  it('serializes concurrent product configuration publications', async () => {
    const productId = `prod_concurrent_${Date.now()}`;
    const results = await Promise.all([
      productConfigService.createOrUpdateProduct(tenantId, ProductType.LOAN, {
        product_id: productId,
        name: 'Concurrent Loan A',
        enabled: true,
      }),
      productConfigService.createOrUpdateProduct(tenantId, ProductType.LOAN, {
        product_id: productId,
        name: 'Concurrent Loan B',
        enabled: true,
      }),
    ]);
    const versions = results.map((product) => product.version).sort((a, b) => a - b);
    const events = (await outboxService.list(tenantId)).filter(
      (event) =>
        event.envelope.event_type === 'products.configuration_published' &&
        event.envelope.aggregate.id === productId,
    );
    const eventVersions = events
      .map((event) => event.envelope.aggregate.version)
      .sort((a, b) => a - b);

    expect(versions).toEqual([1, 2]);
    expect(events).toHaveLength(2);
    expect(eventVersions).toEqual([1, 2]);
    expect(new Set(events.map((event) => event.envelope.idempotency_key)).size).toBe(2);
  });

  it('evaluates lending eligibility rules', async () => {
    const rules = await rulesEngine.initializeDefaultRules(tenantId, productId);
    expect(rules.length).toBeGreaterThan(10);

    const customerCredit = {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    };

    const ruleResults = await rulesEngine.evaluateRules(productId, {
      customer_id: customerId,
      customer_credit_score: customerCredit.credit_score,
      customer_income: customerCredit.income,
      customer_employment_years: customerCredit.employment_years,
      transaction_amount: 25000,
    });

    const passed = ruleResults.filter((r) => r.passed).length;
    const failed = ruleResults.filter((r) => !r.passed).length;

    expect(passed).toBeGreaterThan(failed);
  });

  it('approves a loan and calculates repayment terms', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Business inventory',
      metadata: {},
    });

    const customerCredit = {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    };

    const approval = await loanService.approveLoan(tenantId, loan, customerCredit);

    expect(approval.approved).toBe(true);
    expect(approval.approved_amount).toBe(25000);
    expect(approval.approved_rate).toBeGreaterThan(0);
    expect(loan.monthly_payment).toBeGreaterThan(0);
    expect(loan.total_repayable).toBeGreaterThan(loan.principal_amount);
  });

  it('disburses an approved loan and records ledger entries', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Business inventory',
      metadata: {},
    });

    const approval = await loanService.approveLoan(tenantId, loan, {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    });

    const coa = await ledgerService.initializeChartOfAccounts(tenantId);
    expect(coa.length).toBeGreaterThan(20);

    const disburse = await loanService.disburseLoan(tenantId, loan, {
      idempotencyKey: `idem_disburse_act_${loan.id}`,
    });
    expect(disburse.success).toBe(true);

    expect(loan.status).toBe(LoanStatus.ACTIVE);
    expect(loan.disbursement_date).toBeDefined();
    await expect(outboxService.list(tenantId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'PENDING',
          envelope: expect.objectContaining({
            event_type: 'lending.loan_disbursed',
            tenant_id: tenantId,
            aggregate: expect.objectContaining({ type: 'loan', id: loan.id }),
            payload: expect.objectContaining({
              transaction_id: disburse.disbursement_id,
              money: { amount: '25000.00', currency: 'MZN' },
            }),
          }),
        }),
      ]),
    );
  });

  it('generates an amortization schedule', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Business inventory',
      metadata: {},
    });

    await loanService.approveLoan(tenantId, loan, {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    });

    const schedule = loanService.generateAmortizationSchedule(loan);

    expect(schedule).toHaveLength(12);
    expect(schedule[0].opening_balance).toBe(25000);
    expect(schedule[0].payment).toBeGreaterThan(0);
    expect(schedule[11].closing_balance).toBeLessThan(1);
  });

  it('Process loan payment and verify GL posting', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Business inventory',
      metadata: {},
    });

    await loanService.approveLoan(tenantId, loan, {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    });

    await loanService.disburseLoan(tenantId, loan, {
      idempotencyKey: `idem_disburse_payment_${loan.id}`,
    });

    // Initialize GL
    await ledgerService.initializeChartOfAccounts(tenantId);

    const payment = await loanService.processLoanPayment(tenantId, loan, 2500, {
      idempotencyKey: `idem_payment_post_${loan.id}`,
    });

    expect(payment.success).toBe(true);
    expect(payment.principal_paid).toBeGreaterThan(0);
    expect(payment.interest_paid).toBeGreaterThan(0);
    await expect(outboxService.list(tenantId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'PENDING',
          envelope: expect.objectContaining({
            event_type: 'lending.payment_posted',
            tenant_id: tenantId,
            aggregate: expect.objectContaining({ type: 'loan', id: loan.id }),
            payload: expect.objectContaining({
              money: { amount: '2500.00', currency: 'MZN' },
              allocation: expect.objectContaining({
                principal: payment.principal_paid.toFixed(2),
                interest: payment.interest_paid.toFixed(2),
              }),
              balance_after: payment.balance_remaining.toFixed(2),
            }),
          }),
        }),
      ]),
    );

    const status = loanService.getLoanStatus(loan);
    expect(status.remaining_balance).toBe(payment.balance_remaining);
    expect(status.progress_percent).toBeGreaterThan(0);
  });

  it('replays disbursement and payment idempotently', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Idempotency test',
      metadata: {},
    });

    await loanService.approveLoan(tenantId, loan, {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    });
    await ledgerService.initializeChartOfAccounts(tenantId);

    const disbursementKey = `idem_disburse_${loan.id}`;
    const firstDisbursement = await loanService.disburseLoan(tenantId, loan, {
      idempotencyKey: disbursementKey,
    });
    (outboxService as any).memory.clear();
    const secondDisbursement = await loanService.disburseLoan(tenantId, loan, {
      idempotencyKey: disbursementKey,
    });
    const disbursementEventsAfterReplay = await outboxService.list(tenantId);

    expect(firstDisbursement.disbursement_id).toBe(secondDisbursement.disbursement_id);
    expect(secondDisbursement.idempotent).toBe(true);
    expect(countLoanEvents(disbursementEventsAfterReplay, loan.id, 'lending.loan_disbursed')).toBe(
      1,
    );

    const paymentKey = `idem_payment_${loan.id}`;
    const firstPayment = await loanService.processLoanPayment(tenantId, loan, 2500, {
      idempotencyKey: paymentKey,
    });
    const principalAfterFirstPayment = loan.total_paid_principal;
    const paymentEventsAfterFirstPayment = await outboxService.list(tenantId);
    const firstPaymentEvent = paymentEventsAfterFirstPayment.find(
      (event) =>
        event.envelope.event_type === 'lending.payment_posted' &&
        event.envelope.aggregate.id === loan.id,
    );
    (outboxService as any).memory.clear();
    const secondPayment = await loanService.processLoanPayment(tenantId, loan, 9999, {
      idempotencyKey: paymentKey,
    });
    const paymentEventsAfterReplay = await outboxService.list(tenantId);

    expect(secondPayment.idempotent).toBe(true);
    expect(secondPayment.principal_paid).toBe(firstPayment.principal_paid);
    expect(loan.total_paid_principal).toBe(principalAfterFirstPayment);
    expect(firstPaymentEvent?.envelope.aggregate.version).toBe(loan.version);
    expect(countLoanEvents(paymentEventsAfterReplay, loan.id, 'lending.payment_posted')).toBe(1);
    const replayedPaymentEvent = paymentEventsAfterReplay.find(
      (event) => event.envelope.event_type === 'lending.payment_posted',
    );
    expect(replayedPaymentEvent?.envelope.payload.money).toEqual({
      amount: '2500.00',
      currency: 'MZN',
    });

    await loanService.processLoanPayment(tenantId, loan, 1000, {
      idempotencyKey: `idem_payment_second_${loan.id}`,
    });
    const paymentEventsAfterSecondPayment = (await outboxService.list(tenantId)).filter(
      (event) =>
        event.envelope.event_type === 'lending.payment_posted' &&
        event.envelope.aggregate.id === loan.id,
    );
    expect(paymentEventsAfterSecondPayment).toHaveLength(2);
    expect(paymentEventsAfterSecondPayment[1].envelope.aggregate.version).toBeGreaterThan(
      paymentEventsAfterSecondPayment[0].envelope.aggregate.version,
    );
  });

  it('repairs loan state before replaying a disbursement event', async () => {
    const loan = await loanService.applyForLoan(tenantId, {
      customer_id: customerId,
      product_id: productId,
      loan_type: LoanType.PERSONAL,
      requested_amount: 25000,
      requested_term_months: 12,
      purpose: 'Disbursement recovery test',
      metadata: {},
    });

    await loanService.approveLoan(tenantId, loan, {
      credit_score: 650,
      income: 120000,
      employment_years: 5,
    });
    await ledgerService.initializeChartOfAccounts(tenantId);

    const disbursementKey = `idem_disburse_repair_${loan.id}`;
    const posted = await transactionService.processDisbursement({
      tenantId,
      customerId: loan.customer_id,
      loanId: loan.id,
      principal: loan.principal_amount,
      originationFee: loan.origination_fee_amount,
      currency: 'MZN',
      idempotencyKey: disbursementKey,
    });

    expect(posted.posting_status).toBe('SUCCESS');
    expect(loan.status).toBe(LoanStatus.APPROVED);
    expect(loan.disbursed_amount).toBe(0);

    const replayed = await loanService.disburseLoan(tenantId, loan, {
      idempotencyKey: disbursementKey,
    });
    const repairedLoan = await loanService.getLoan(tenantId, loan.id);
    const disbursementEvents = await outboxService.list(tenantId);
    const repairedEvent = disbursementEvents.find(
      (event) =>
        event.envelope.event_type === 'lending.loan_disbursed' &&
        event.envelope.aggregate.id === loan.id,
    );

    expect(replayed).toEqual({
      success: true,
      disbursement_id: posted.transaction_id,
      idempotent: true,
    });
    expect(repairedLoan?.status).toBe(LoanStatus.ACTIVE);
    expect(repairedLoan?.disbursed_amount).toBe(25000);
    expect(repairedEvent?.envelope.payload.money).toEqual({ amount: '25000.00', currency: 'MZN' });
    expect(repairedEvent?.envelope.aggregate.version).toBe(repairedLoan?.version);
  });

});

function countLoanEvents(events: any[], loanId: string, eventType: string): number {
  return events.filter(
    (event) => event.envelope.event_type === eventType && event.envelope.aggregate.id === loanId,
  ).length;
}
