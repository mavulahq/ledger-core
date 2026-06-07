/*
 * getfluxo.io - Financial Calculations Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 * 
 * Core financial calculations: PMT, interest, amortization, compound interest
 * Ported from creditflow-core with enhancements for multi-tenant, multi-currency
 */

import Decimal from 'decimal.js';

export interface LoanSimulation {
  principal: number;
  monthlyRate: number;
  installmentCount: number;
  originationFeePercent?: number;
}

export interface LoanScheduleItem {
  installment: number;
  payment_date: Date;
  opening_balance: number;
  payment: number;
  principal: number;
  interest: number;
  fees: number;
  closing_balance: number;
}

export interface PaymentAllocation {
  principal_payment: number;
  interest_payment: number;
  fee_payment: number;
  balance_after: number;
}

/**
 * Calculate PMT (Payment) for amortizing loan
 * Formula: PMT = (Principal × r × (1 + r)^n) / ((1 + r)^n - 1)
 * where r = monthly rate, n = number of payments
 */
export function calculatePMT(
  principal: number,
  monthlyRate: number,
  installmentCount: number
): number {
  const amount = new Decimal(principal);
  const rate = new Decimal(monthlyRate);

  if (rate.eq(0)) {
    return amount.div(installmentCount).toDecimalPlaces(2).toNumber();
  }

  const onePlusRatePow = rate.plus(1).pow(installmentCount);
  const numerator = amount.mul(rate).mul(onePlusRatePow);
  const denominator = onePlusRatePow.minus(1);

  return numerator.div(denominator).toDecimalPlaces(2).toNumber();
}

/**
 * Calculate total repayable amount (all payments)
 */
export function calculateTotalRepayable(monthlyPayment: number, installmentCount: number): number {
  return new Decimal(monthlyPayment).mul(installmentCount).toDecimalPlaces(2).toNumber();
}

/**
 * Calculate total interest paid
 */
export function calculateTotalInterest(totalRepayable: number, principal: number): number {
  return new Decimal(totalRepayable).minus(principal).toDecimalPlaces(2).toNumber();
}

/**
 * Generate complete amortization schedule
 */
export function generateAmortizationSchedule(params: {
  principal: number;
  monthlyRate: number;
  n: number;
  startDate: Date;
  originationFeePercent?: number;
  monthlyFee?: number;
}): LoanScheduleItem[] {
  const pmt = calculatePMT(params.principal, params.monthlyRate, params.n);
  const schedule: LoanScheduleItem[] = [];

  let balance = new Decimal(params.principal);

  for (let i = 1; i <= params.n; i++) {
    const payment_date = new Date(params.startDate);
    payment_date.setMonth(payment_date.getMonth() + i);

    const interest = balance.mul(params.monthlyRate).toDecimalPlaces(2);
    const principal_payment = new Decimal(pmt).minus(interest).toDecimalPlaces(2);
    const fees = new Decimal(params.monthlyFee || 0).toDecimalPlaces(2);
    const closing_balance = Decimal.max(balance.minus(principal_payment), 0).toDecimalPlaces(2);

    schedule.push({
      installment: i,
      payment_date,
      opening_balance: balance.toDecimalPlaces(2).toNumber(),
      payment: new Decimal(pmt).toDecimalPlaces(2).toNumber(),
      principal: principal_payment.toNumber(),
      interest: interest.toNumber(),
      fees: fees.toNumber(),
      closing_balance: closing_balance.toNumber(),
    });

    balance = closing_balance;
  }

  return schedule;
}

/**
 * Calculate compound interest (for savings accounts)
 * Formula: A = P(1 + r/n)^(nt)
 * where P = principal, r = annual rate, n = compounds per year, t = years
 */
export function calculateCompoundInterest(params: {
  principal: number;
  annualRate: number;
  compoundingFrequency: number;  // 1 = annually, 12 = monthly, 365 = daily
  timeInYears: number;
}): number {
  const { principal, annualRate, compoundingFrequency, timeInYears } = params;
  const amount = new Decimal(principal).mul(
    new Decimal(1).plus(new Decimal(annualRate).div(compoundingFrequency)).pow(
      compoundingFrequency * timeInYears,
    ),
  );
  return amount.minus(principal).toDecimalPlaces(2).toNumber();
}

/**
 * Calculate daily accrual interest (for current/savings accounts)
 */
export function calculateDailyAccrualInterest(params: {
  balance: number;
  dailyRate: number;
  daysInPeriod: number;
}): number {
  return new Decimal(params.balance)
    .mul(params.dailyRate)
    .mul(params.daysInPeriod)
    .toDecimalPlaces(2)
    .toNumber();
}

/**
 * Allocate payment across principal, interest, and fees
 * Priority: fees → interest → principal
 */
export function allocatePayment(params: {
  payment_amount: number;
  interest_due: number;
  principal_due: number;
  fees_due: number;
  current_balance: number;
}): PaymentAllocation {
  let remaining = new Decimal(params.payment_amount);

  // First, pay fees
  const fee_payment = Decimal.min(remaining, params.fees_due).toDecimalPlaces(2);
  remaining = remaining.minus(fee_payment);

  // Then, pay interest
  const interest_payment = Decimal.min(remaining, params.interest_due).toDecimalPlaces(2);
  remaining = remaining.minus(interest_payment);

  // Finally, pay principal
  const principal_payment = Decimal.min(remaining, params.principal_due).toDecimalPlaces(2);

  return {
    principal_payment: principal_payment.toNumber(),
    interest_payment: interest_payment.toNumber(),
    fee_payment: fee_payment.toNumber(),
    balance_after: Decimal.max(new Decimal(params.current_balance).minus(principal_payment), 0)
      .toDecimalPlaces(2)
      .toNumber(),
  };
}

/**
 * Calculate effective annual rate from monthly rate
 * EAR = (1 + monthly_rate)^12 - 1
 */
export function calculateEAR(monthlyRate: number): number {
  return new Decimal(1).plus(monthlyRate).pow(12).minus(1).toDecimalPlaces(6).toNumber();
}

/**
 * Calculate monthly rate from annual percentage rate
 * monthly_rate = APR / 12 / 100
 */
export function getMonthlyRateFromAPR(aprPercent: number): number {
  return aprPercent / 12 / 100;
}

/**
 * Calculate overdraft interest (for accounts with overdraft enabled)
 */
export function calculateOverdraftInterest(params: {
  overdraft_amount: number;
  daily_overdraft_rate: number;
  daysOverdrawn: number;
  overdraft_fee?: number;
}): number {
  const interestCharged = new Decimal(params.overdraft_amount)
    .mul(params.daily_overdraft_rate)
    .mul(params.daysOverdrawn);
  const fee = new Decimal(params.overdraft_fee || 0);
  return interestCharged.plus(fee).toDecimalPlaces(2).toNumber();
}

/**
 * Calculate grace period interest (0 interest during grace period)
 */
export function calculateInterestWithGrace(params: {
  principal: number;
  monthlyRate: number;
  gracePeriodMonths: number;
  totalMonths: number;
}): number {
  // Grace period: no interest accrual
  const periodsWithInterest = params.totalMonths - params.gracePeriodMonths;
  if (periodsWithInterest <= 0) return 0;

  const pmt = calculatePMT(params.principal, params.monthlyRate, periodsWithInterest);
  return new Decimal(pmt).mul(periodsWithInterest).minus(params.principal).toDecimalPlaces(2).toNumber();
}

/**
 * Validate loan parameters before processing
 */
export function validateLoanParameters(params: LoanSimulation): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (params.principal <= 0) errors.push('Principal must be positive');
  if (params.monthlyRate < 0 || params.monthlyRate > 0.5) errors.push('Monthly rate must be between 0 and 50%');
  if (params.installmentCount < 1 || params.installmentCount > 360) errors.push('Installments must be between 1 and 360');

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Calculate multiple scenarios for comparison (decision support)
 */
export function generateLoanScenarios(
  principal: number,
  minMonthlyRate: number,
  maxMonthlyRate: number,
  installmentCount: number,
  scenarios: number = 5
): Array<{ rate: number; pmt: number; total_interest: number; total_repayable: number }> {
  const results = [];
  const step = new Decimal(maxMonthlyRate).minus(minMonthlyRate).div(Math.max(scenarios - 1, 1));

  for (let i = 0; i < scenarios; i++) {
    const rate = new Decimal(minMonthlyRate).plus(step.mul(i)).toNumber();
    const pmt = calculatePMT(principal, rate, installmentCount);
    const totalRepayable = calculateTotalRepayable(pmt, installmentCount);
    const totalInterest = calculateTotalInterest(totalRepayable, principal);

    results.push({
      rate,
      pmt,
      total_interest: totalInterest,
      total_repayable: totalRepayable,
    });
  }

  return results;
}
