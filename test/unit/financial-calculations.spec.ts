import { allocatePayment } from '../../src/calculations/financial-calculations';

describe('allocatePayment', () => {
  it('applies cash above the current installment to outstanding principal', () => {
    const allocation = allocatePayment({
      payment_amount: 5000,
      interest_due: 625,
      principal_due: 1875,
      fees_due: 0,
      current_balance: 25000,
    });

    expect(allocation).toEqual({
      fee_payment: 0,
      interest_payment: 625,
      principal_payment: 4375,
      balance_after: 20625,
    });
  });

  it('does not allocate more principal than the remaining balance', () => {
    const allocation = allocatePayment({
      payment_amount: 20000,
      interest_due: 100,
      principal_due: 500,
      fees_due: 0,
      current_balance: 1000,
    });

    expect(allocation).toEqual({
      fee_payment: 0,
      interest_payment: 100,
      principal_payment: 1000,
      balance_after: 0,
    });
  });
});
