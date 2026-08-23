import { allocatePayment } from '../../src/calculations/financial-calculations';

describe('allocatePayment', () => {
  it('does not credit more principal than the outstanding balance', () => {
    const allocation = allocatePayment({
      payment_amount: 2437.18,
      interest_due: 59.44,
      principal_due: 2377.74,
      fees_due: 0,
      current_balance: 1065.54,
    });

    expect(allocation.principal_payment).toBe(1065.54);
    expect(allocation.interest_payment).toBe(59.44);
    expect(allocation.fee_payment).toBe(0);
    expect(allocation.balance_after).toBe(0);
  });

  it('applies extra cash to principal when the loan still has a remaining balance', () => {
    const allocation = allocatePayment({
      payment_amount: 4000,
      interest_due: 625,
      principal_due: 1812.18,
      fees_due: 500,
      current_balance: 25000,
    });

    expect(allocation.fee_payment).toBe(500);
    expect(allocation.interest_payment).toBe(625);
    expect(allocation.principal_payment).toBe(2875);
    expect(allocation.balance_after).toBe(22125);
  });
});
