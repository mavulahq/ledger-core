import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Loan } from '../loans/loan.service';
import { DomainEventEnvelope, LoanDisbursedPayload } from './domain-event.types';

@Injectable()
export class DomainEventFactory {
  loanDisbursed(input: {
    tenantId: string;
    loan: Loan;
    transactionId: string;
    currency: string;
    idempotencyKey?: string;
    occurredAt?: Date;
  }): DomainEventEnvelope<LoanDisbursedPayload> {
    const occurredAt = input.occurredAt || new Date();
    const eventId = `evt_${randomUUID()}`;
    const idempotencyKey =
      input.idempotencyKey || `${input.tenantId}:${input.loan.id}:disbursement:${input.transactionId}`;

    return {
      event_id: eventId,
      event_type: 'lending.loan_disbursed',
      event_version: 1,
      occurred_at: occurredAt.toISOString(),
      tenant_id: input.tenantId,
      aggregate: {
        type: 'loan',
        id: input.loan.id,
        version: this.aggregateVersion(input.loan),
      },
      correlation_id: `corr_${input.transactionId}`,
      causation_id: input.idempotencyKey || input.transactionId,
      idempotency_key: idempotencyKey,
      payload: {
        transaction_id: input.transactionId,
        destination_account_id: `CUST_${input.loan.customer_id}`,
        money: {
          amount: input.loan.disbursed_amount.toFixed(2),
          currency: input.currency,
        },
      },
      metadata: {
        producer: 'fengine',
        data_classification: 'restricted',
        schema_uri: 'contracts/domain-events/payloads/lending.loan_disbursed.v1.schema.json',
      },
    };
  }

  private aggregateVersion(loan: Loan): number {
    if (loan.updated_at instanceof Date) {
      return Math.max(1, Math.floor(loan.updated_at.getTime() / 1000));
    }
    return 1;
  }
}
