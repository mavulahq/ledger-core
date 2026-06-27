/*
 * getfluxo.io - Loan Management & Origination Engine
 * Copyright (c) 2025 getfluxo.io
 *
 * Author: EstandarMustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 *
 * Complete loan lifecycle: origination, validation, disbursement, payments, closures
 * Integrated with financial calculations, rules engine, GL, transactions
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import { OODAStage, RulesEngineService } from '../rules-engine/rules-engine.service';
import { ProductConfigService } from '../products/product-config.service';
import { AuditTrailService } from '../services/audit-trail.service';
import { FengineStoreService } from '../services/fengine-store.service';
import { DomainEventFactory } from '../domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../domain-events/domain-outbox.service';
import {
  allocatePayment,
  calculatePMT,
  generateAmortizationSchedule,
  generateLoanScenarios,
  getMonthlyRateFromAPR,
} from '../calculations/financial-calculations';

export enum LoanStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DISBURSED = 'DISBURSED',
  ACTIVE = 'ACTIVE',
  PAID_UP = 'PAID_UP',
  DEFAULTED = 'DEFAULTED',
  WRITTEN_OFF = 'WRITTEN_OFF',
}

export enum LoanType {
  PERSONAL = 'PERSONAL',
  BUSINESS = 'BUSINESS',
  AGRICULTURE = 'AGRICULTURE',
  AUTO = 'AUTO',
  REAL_ESTATE = 'REAL_ESTATE',
}

export interface Loan {
  id: string;
  tenant_id: string;
  customer_id: string;
  product_id: string;

  // Loan details
  loan_type: LoanType;
  principal_amount: number;
  approved_amount?: number;
  disbursed_amount: number;

  // Terms
  term_months: number;
  monthly_rate: number; // e.g., 0.025 for 2.5%
  annual_rate: number;
  interest_method: 'SIMPLE' | 'COMPOUND' | 'DAILY_ACCRUAL';

  // Fees
  origination_fee_percent: number;
  origination_fee_amount: number;
  late_payment_fee_percent: number;

  // Amortization
  monthly_payment: number;
  total_interest: number;
  total_repayable: number;

  // Grace period
  grace_months: number;

  // Status & dates
  status: LoanStatus;
  application_date: Date;
  approval_date?: Date;
  disbursement_date?: Date;
  maturity_date?: Date;

  // Tracking
  total_paid_principal: number;
  total_paid_interest: number;
  total_paid_fees: number;
  remaining_balance: number;
  days_overdue?: number;

  created_at: Date;
  updated_at: Date;
}

export interface LoanApplication {
  customer_id: string;
  product_id: string;
  loan_type: LoanType;
  requested_amount: number;
  requested_term_months: number;
  purpose?: string;
  metadata: Record<string, any>;
}

export interface LoanApprovalResult {
  loan_id: string;
  status: LoanStatus;
  approved: boolean;
  approved_amount?: number;
  approved_term_months?: number;
  approved_rate?: number;
  reason?: string;
  rules_passed: number;
  rules_failed: number;
}

@Injectable()
export class LoanService {
  constructor(
    private prisma: PrismaService,
    private transactionService: TransactionService,
    private rulesEngine: RulesEngineService,
    private productConfigService: ProductConfigService,
    private auditTrail: AuditTrailService,
    private store: FengineStoreService,
    private domainEvents: DomainEventFactory,
    private outbox: DomainOutboxService,
  ) {}

  /**
   * Apply for loan (OODA: Observe customer, Orient to rules, Decide approval)
   */
  async applyForLoan(tenantId: string, application: LoanApplication): Promise<Loan> {
    const loanId = `loan_${application.customer_id}_${Date.now()}`;
    const product = await this.productConfigService.getProduct(tenantId, application.product_id);

    if (product) {
      if (product.min_principal && application.requested_amount < product.min_principal) {
        throw new Error(`Requested amount below product minimum of ${product.min_principal}`);
      }
      if (product.max_principal && application.requested_amount > product.max_principal) {
        throw new Error(`Requested amount above product maximum of ${product.max_principal}`);
      }
      if (product.min_term_months && application.requested_term_months < product.min_term_months) {
        throw new Error(`Requested term below product minimum of ${product.min_term_months} months`);
      }
      if (product.max_term_months && application.requested_term_months > product.max_term_months) {
        throw new Error(`Requested term above product maximum of ${product.max_term_months} months`);
      }
    }

    const loan: Loan = {
      id: loanId,
      tenant_id: tenantId,
      customer_id: application.customer_id,
      product_id: application.product_id,
      loan_type: application.loan_type,
      principal_amount: application.requested_amount,
      disbursed_amount: 0,
      term_months: application.requested_term_months,
      monthly_rate: 0,
      annual_rate: 0,
      interest_method: 'SIMPLE',
      origination_fee_percent: product?.origination_fee || 2.0,
      origination_fee_amount: 0,
      late_payment_fee_percent: product?.late_payment_fee || 5.0,
      monthly_payment: 0,
      total_interest: 0,
      total_repayable: 0,
      grace_months: 0,
      status: LoanStatus.PENDING_APPROVAL,
      application_date: new Date(),
      total_paid_principal: 0,
      total_paid_interest: 0,
      total_paid_fees: 0,
      remaining_balance: application.requested_amount,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await this.store.saveLoan(tenantId, loan);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'loan.applied',
      entity_type: 'loan',
      entity_id: loanId,
      phase: 'OBSERVE',
      metadata: {
        customer_id: loan.customer_id,
        principal: loan.principal_amount,
        term_months: loan.term_months,
      },
    });

    console.log(`✓ Loan application created: ${loanId}`);
    return loan;
  }

  /**
   * Evaluate loan application against rules and auto-approve/reject
   */
  async approveLoan(
    tenantId: string,
    loan: Loan,
    customerCredit: {
      credit_score: number;
      income: number;
      employment_years: number;
    },
  ): Promise<LoanApprovalResult> {
    // Evaluate rules
    const ruleResults = await this.rulesEngine.evaluateRules(loan.product_id, {
      tenant_id: tenantId,
      customer_id: loan.customer_id,
      customer_credit_score: customerCredit.credit_score,
      customer_income: customerCredit.income,
      customer_employment_years: customerCredit.employment_years,
      customer_kyc_status: 'VERIFIED',
      transaction_amount: loan.principal_amount,
      stage: 'ORIGINATION' satisfies OODAStage,
    });

    const passed = ruleResults.filter((r) => r.passed).length;
    const failed = ruleResults.filter((r) => !r.passed).length;

    // Auto-approve if all critical rules pass
    const criticalRulesFailed = ruleResults.filter(
      (r) => !r.passed && ['CREDIT_SCORE_MIN', 'KYC_REQUIRED'].includes(r.rule_type as any),
    );

    const approved = criticalRulesFailed.length === 0 && passed > failed;

    if (approved) {
      const product = await this.productConfigService.getProduct(tenantId, loan.product_id);
      const tierRule = ruleResults.find((result) => result.rule_type === 'INTEREST_RATE_TIER');
      const tierRate = tierRule?.actions.find((action) => action.action === 'tiers')?.value;
      const baseRatePercent = product?.default_interest_rate || 2.5;
      const tieredRatePercent = Array.isArray(tierRate)
        ? tierRate.find((tier: any) => loan.principal_amount >= tier.min && loan.principal_amount <= tier.max)?.rate
        : undefined;
      const monthlyRate = (tieredRatePercent || baseRatePercent) / 100;
      const graceRule = ruleResults.find((result) => result.rule_type === 'GRACE_PERIOD');
      const graceMonths = Number(graceRule?.actions.find((action) => action.action === 'grace_months')?.value || 0);

      const monthlyPayment = calculatePMT(loan.principal_amount, monthlyRate, loan.term_months);

      loan.status = LoanStatus.APPROVED;
      loan.monthly_rate = monthlyRate;
      loan.annual_rate = monthlyRate * 12;
      loan.monthly_payment = monthlyPayment;
      loan.total_interest = monthlyPayment * loan.term_months - loan.principal_amount;
      loan.total_repayable = monthlyPayment * loan.term_months;
      loan.origination_fee_amount = loan.principal_amount * (loan.origination_fee_percent / 100);
      loan.grace_months = graceMonths;
      loan.approval_date = new Date();
      loan.updated_at = new Date();
      await this.store.saveLoan(tenantId, loan);
      this.auditTrail.record({
        tenant_id: tenantId,
        action: 'loan.approved',
        entity_type: 'loan',
        entity_id: loan.id,
        phase: 'DECIDE',
        metadata: {
          monthly_rate: loan.monthly_rate,
          monthly_payment: loan.monthly_payment,
          grace_months: loan.grace_months,
        },
      });

      console.log(
        `✓ Loan approved: ${loan.id} (Monthly: ${monthlyPayment.toFixed(2)}, Rate: ${(monthlyRate * 100).toFixed(2)}%)`,
      );
    } else {
      loan.status = LoanStatus.REJECTED;
      loan.updated_at = new Date();
      await this.store.saveLoan(tenantId, loan);
      this.auditTrail.record({
        tenant_id: tenantId,
        action: 'loan.rejected',
        entity_type: 'loan',
        entity_id: loan.id,
        phase: 'DECIDE',
        metadata: {
          failed_rules: ruleResults.filter((result) => !result.passed).map((result) => result.rule_type),
        },
      });
      console.log(`✗ Loan rejected: ${loan.id} (Failed rules: ${failed})`);
    }

    return {
      loan_id: loan.id,
      status: loan.status,
      approved,
      approved_amount: approved ? loan.principal_amount : undefined,
      approved_term_months: approved ? loan.term_months : undefined,
      approved_rate: approved ? loan.monthly_rate : undefined,
      reason: !approved ? `Failed ${failed} rule checks` : undefined,
      rules_passed: passed,
      rules_failed: failed,
    };
  }

  /**
   * Disburse loan (transfer principal to customer account)
   */
  async disburseLoan(
    tenantId: string,
    loan: Loan,
    options: { idempotencyKey?: string } = {},
  ): Promise<{
    success: boolean;
    disbursement_id: string;
    idempotent?: boolean;
  }> {
    if (loan.status !== LoanStatus.APPROVED) {
      const replay = options.idempotencyKey
        ? await this.store.getTransactionByIdempotencyKey(tenantId, options.idempotencyKey)
        : undefined;
      if (replay?.metadata?.settlement_result?.posting_status === 'SUCCESS') {
        return {
          success: true,
          disbursement_id: replay.id,
          idempotent: true,
        };
      }

      throw new Error(`Loan must be APPROVED status to disburse (current: ${loan.status})`);
    }

    // Process disbursement transaction
    const result = await this.transactionService.processDisbursement({
      tenantId,
      customerId: loan.customer_id,
      loanId: loan.id,
      principal: loan.principal_amount,
      originationFee: loan.origination_fee_amount,
      currency: 'MZN',
      idempotencyKey: options.idempotencyKey,
    });

    if (result.posting_status === 'SUCCESS') {
      if (result.idempotent) {
        return {
          success: true,
          disbursement_id: result.transaction_id,
          idempotent: true,
        };
      }

      loan.status = LoanStatus.ACTIVE;
      loan.disbursement_date = new Date();
      loan.disbursed_amount = loan.principal_amount;
      loan.remaining_balance = loan.principal_amount;
      loan.maturity_date = new Date();
      loan.maturity_date.setMonth(loan.maturity_date.getMonth() + loan.term_months);
      loan.updated_at = new Date();
      await this.store.saveLoan(tenantId, loan);
      await this.outbox.append(
        this.domainEvents.loanDisbursed({
          tenantId,
          loan,
          transactionId: result.transaction_id,
          currency: 'MZN',
          idempotencyKey: options.idempotencyKey,
        }),
      );
      this.auditTrail.record({
        tenant_id: tenantId,
        action: 'loan.disbursed',
        entity_type: 'loan',
        entity_id: loan.id,
        phase: 'ACT',
        metadata: {
          transaction_id: result.transaction_id,
          amount: loan.disbursed_amount,
        },
      });

      console.log(`✓ Loan disbursed: ${loan.id} (Amount: ${loan.principal_amount})`);

      return {
        success: true,
        disbursement_id: result.transaction_id,
      };
    }

    throw new Error(`Disbursement failed: ${result.error}`);
  }

  /**
   * Generate amortization schedule for customer (preview or post-approval)
   */
  generateAmortizationSchedule(loan: Loan): Array<any> {
    if (!loan.monthly_rate || !loan.term_months) {
      throw new Error('Loan must have monthly_rate and term_months set');
    }

    return generateAmortizationSchedule({
      principal: loan.principal_amount,
      monthlyRate: loan.monthly_rate,
      n: loan.term_months,
      startDate: loan.approval_date || new Date(),
      originationFeePercent: loan.origination_fee_percent,
      monthlyFee: 0,
    });
  }

  /**
   * Process loan payment
   */
  async processLoanPayment(
    tenantId: string,
    loan: Loan,
    paymentAmount: number,
    options: { idempotencyKey?: string } = {},
  ): Promise<{
    success: boolean;
    principal_paid: number;
    interest_paid: number;
    balance_remaining: number;
    idempotent?: boolean;
  }> {
    if (loan.status !== LoanStatus.ACTIVE && loan.status !== LoanStatus.DEFAULTED) {
      throw new Error(`Cannot process payment for loan in ${loan.status} status`);
    }

    // Calculate interest due
    const schedule = this.generateAmortizationSchedule(loan);
    const nextInstallment =
      schedule.find((item) => item.closing_balance < loan.remaining_balance + 0.0001) || schedule[0];
    const interestDue = nextInstallment?.interest || loan.remaining_balance * loan.monthly_rate;
    const principalDue = nextInstallment?.principal || Math.max(paymentAmount - interestDue, 0);
    const feeDue = loan.total_paid_fees === 0 ? loan.origination_fee_amount : 0;

    const result = await this.transactionService.processPayment({
      tenantId,
      customerId: loan.customer_id,
      accountId: `CUST_${loan.customer_id}`,
      loanId: loan.id,
      paymentAmount,
      currency: 'MZN',
      productId: loan.product_id,
      principalDue,
      interestDue,
      feesDue: feeDue,
      currentBalance: loan.remaining_balance,
      idempotencyKey: options.idempotencyKey,
    });

    if (result.posting_status === 'SUCCESS') {
      if (result.idempotent && result.allocation) {
        return {
          success: true,
          principal_paid: result.allocation.principal_payment,
          interest_paid: result.allocation.interest_payment,
          balance_remaining: Math.max(result.allocation.balance_after, 0),
          idempotent: true,
        };
      }

      const allocation = allocatePayment({
        payment_amount: paymentAmount,
        interest_due: interestDue,
        principal_due: principalDue,
        fees_due: feeDue,
        current_balance: loan.remaining_balance,
      });
      const principalPaid = allocation.principal_payment;
      const interestPaid = allocation.interest_payment;
      const feePaid = allocation.fee_payment;
      loan.total_paid_principal += principalPaid;
      loan.total_paid_interest += interestPaid;
      loan.total_paid_fees += feePaid;
      loan.remaining_balance = allocation.balance_after;
      loan.updated_at = new Date();

      if (loan.remaining_balance <= 0) {
        loan.status = LoanStatus.PAID_UP;
      }
      await this.store.saveLoan(tenantId, loan);
      await this.outbox.append(
        this.domainEvents.lendingPaymentPosted({
          tenantId,
          loan,
          transactionId: result.transaction_id,
          sourceAccountId: `CUST_${loan.customer_id}`,
          paymentAmount,
          currency: 'MZN',
          allocation,
          idempotencyKey: options.idempotencyKey,
        }),
      );
      this.auditTrail.record({
        tenant_id: tenantId,
        action: 'loan.payment.recorded',
        entity_type: 'loan',
        entity_id: loan.id,
        phase: 'ACT',
        metadata: {
          payment_amount: paymentAmount,
          principal_paid: principalPaid,
          interest_paid: interestPaid,
          fee_paid: feePaid,
          remaining_balance: loan.remaining_balance,
        },
      });

      return {
        success: true,
        principal_paid: principalPaid,
        interest_paid: interestPaid,
        balance_remaining: Math.max(loan.remaining_balance, 0),
      };
    }

    throw new Error(`Payment failed: ${result.error}`);
  }

  /**
   * Generate comparison scenarios (for customer to choose terms)
   */
  generateLoanScenarios(principal: number, minRate: number, maxRate: number, months: number): Array<any> {
    const minMonthlyRate = getMonthlyRateFromAPR(minRate);
    const maxMonthlyRate = getMonthlyRateFromAPR(maxRate);

    return generateLoanScenarios(
      principal,
      minMonthlyRate,
      maxMonthlyRate,
      months,
      5, // 5 scenarios
    );
  }

  /**
   * Get loan details and current status
   */
  getLoanStatus(loan: Loan): {
    loan_id: string;
    status: string;
    principal_amount: number;
    remaining_balance: number;
    monthly_payment: number;
    next_payment_date?: Date;
    total_paid: number;
    progress_percent: number;
    maturity_date?: Date;
  } {
    const totalPaid = loan.total_paid_principal + loan.total_paid_interest;
    const progressPercent = (loan.total_paid_principal / loan.principal_amount) * 100;

    const nextPaymentDate = loan.disbursement_date ? new Date(loan.disbursement_date) : undefined;
    if (nextPaymentDate && loan.grace_months > 0) {
      nextPaymentDate.setMonth(nextPaymentDate.getMonth() + loan.grace_months + 1);
    }

    return {
      loan_id: loan.id,
      status: loan.status,
      principal_amount: loan.principal_amount,
      remaining_balance: loan.remaining_balance,
      monthly_payment: loan.monthly_payment,
      next_payment_date: nextPaymentDate,
      total_paid: totalPaid,
      progress_percent: progressPercent,
      maturity_date: loan.maturity_date,
    };
  }

  listLoans(tenantId: string): Promise<Loan[]> {
    return this.store.listLoans(tenantId);
  }

  getLoan(tenantId: string, loanId: string): Promise<Loan | undefined> {
    return this.store.getLoan(tenantId, loanId);
  }
}
