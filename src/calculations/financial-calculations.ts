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
  if (monthlyRate === 0) {
    return principal / installmentCount;
  }

  const numerator = principal * monthlyRate * Math.pow(1 + monthlyRate, installmentCount);
  const denominator = Math.pow(1 + monthlyRate, installmentCount) - 1;

  return numerator / denominator;
}

/**
 * Calculate total repayable amount (all payments)
 */
export function calculateTotalRepayable(monthlyPayment: number, installmentCount: number): number {
  return monthlyPayment * installmentCount;
}

/**
 * Calculate total interest paid
 */
export function calculateTotalInterest(totalRepayable: number, principal: number): number {
  return totalRepayable - principal;
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

  let balance = params.principal;
  const originationFee = (params.originationFeePercent || 0) * params.principal / 100;

  for (let i = 1; i <= params.n; i++) {
    const payment_date = new Date(params.startDate);
    payment_date.setMonth(payment_date.getMonth() + i);

    const interest = balance * params.monthlyRate;
    const principal_payment = pmt - interest;
    const fees = params.monthlyFee || 0;
    const closing_balance = Math.max(balance - principal_payment, 0);

    schedule.push({
      installment: i,
      payment_date,
      opening_balance: balance,
      payment: pmt,
      principal: principal_payment,
      interest,
      fees,
      closing_balance,
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
  const amount = principal * Math.pow(
    1 + annualRate / compoundingFrequency,
    compoundingFrequency * timeInYears
  );
  return amount - principal;
}

/**
 * Calculate daily accrual interest (for current/savings accounts)
 */
export function calculateDailyAccrualInterest(params: {
  balance: number;
  dailyRate: number;
  daysInPeriod: number;
}): number {
  return params.balance * params.dailyRate * params.daysInPeriod;
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
  let remaining = params.payment_amount;

  // First, pay fees
  const fee_payment = Math.min(remaining, params.fees_due);
  remaining -= fee_payment;

  // Then, pay interest
  const interest_payment = Math.min(remaining, params.interest_due);
  remaining -= interest_payment;

  // Finally, pay principal
  const principal_payment = Math.min(remaining, params.principal_due);

  return {
    principal_payment,
    interest_payment,
    fee_payment,
    balance_after: params.current_balance - principal_payment,
  };
}

/**
 * Calculate effective annual rate from monthly rate
 * EAR = (1 + monthly_rate)^12 - 1
 */
export function calculateEAR(monthlyRate: number): number {
  return Math.pow(1 + monthlyRate, 12) - 1;
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
  const interestCharged = params.overdraft_amount * params.daily_overdraft_rate * params.daysOverdrawn;
  const fee = params.overdraft_fee || 0;
  return interestCharged + fee;
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
  return pmt * periodsWithInterest - params.principal;
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
  const step = (maxMonthlyRate - minMonthlyRate) / (scenarios - 1);

  for (let i = 0; i < scenarios; i++) {
    const rate = minMonthlyRate + step * i;
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
