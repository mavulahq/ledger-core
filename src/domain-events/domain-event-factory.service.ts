import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Loan } from '../loans/loan.service';
import type { ProductSchema } from '../products/product-config.service';
import {
  DomainEventEnvelope,
  LendingPaymentPostedPayload,
  LoanDisbursedPayload,
  ProductsConfigurationPublishedPayload,
} from './domain-event.types';

@Injectable()
export class DomainEventFactory {
  loanDisbursed(input: {
    tenantId: string;
    loan: Loan;
    transactionId: string;
    currency: string;
    idempotencyKey?: string;
    occurredAt?: Date;
    aggregateVersion?: number;
  }): DomainEventEnvelope<LoanDisbursedPayload> {
    const occurredAt = input.occurredAt || new Date();
    const eventId = `evt_${randomUUID()}`;
    const idempotencyKey =
      input.idempotencyKey ||
      `${input.tenantId}:${input.loan.id}:disbursement:${input.transactionId}`;

    return {
      event_id: eventId,
      event_type: 'lending.loan_disbursed',
      event_version: 1,
      occurred_at: occurredAt.toISOString(),
      tenant_id: input.tenantId,
      aggregate: {
        type: 'loan',
        id: input.loan.id,
        version: this.aggregateVersion(input.loan, input.aggregateVersion),
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
        schema_uri: 'contracts/domain-events/event-envelope.schema.json',
      },
    };
  }

  lendingPaymentPosted(input: {
    tenantId: string;
    loan: Loan;
    transactionId: string;
    sourceAccountId: string;
    paymentAmount: number;
    currency: string;
    allocation: {
      principal_payment: number;
      interest_payment: number;
      fee_payment: number;
      balance_after: number;
    };
    idempotencyKey?: string;
    occurredAt?: Date;
    aggregateVersion?: number;
  }): DomainEventEnvelope<LendingPaymentPostedPayload> {
    const occurredAt = input.occurredAt || new Date();
    const eventId = `evt_${randomUUID()}`;
    const idempotencyKey =
      input.idempotencyKey || `${input.tenantId}:${input.loan.id}:payment:${input.transactionId}`;

    return {
      event_id: eventId,
      event_type: 'lending.payment_posted',
      event_version: 1,
      occurred_at: occurredAt.toISOString(),
      tenant_id: input.tenantId,
      aggregate: {
        type: 'loan',
        id: input.loan.id,
        version: this.aggregateVersion(input.loan, input.aggregateVersion),
      },
      correlation_id: `corr_${input.transactionId}`,
      causation_id: input.idempotencyKey || input.transactionId,
      idempotency_key: idempotencyKey,
      payload: {
        transaction_id: input.transactionId,
        source_account_id: input.sourceAccountId,
        money: {
          amount: input.paymentAmount.toFixed(2),
          currency: input.currency,
        },
        allocation: {
          principal: input.allocation.principal_payment.toFixed(2),
          interest: input.allocation.interest_payment.toFixed(2),
          fees: input.allocation.fee_payment.toFixed(2),
        },
        balance_after: Math.max(input.allocation.balance_after, 0).toFixed(2),
      },
      metadata: {
        producer: 'fengine',
        data_classification: 'restricted',
        schema_uri: 'contracts/domain-events/event-envelope.schema.json',
      },
    };
  }

  productsConfigurationPublished(input: {
    tenantId: string;
    product: ProductSchema;
    idempotencyKey?: string;
    occurredAt?: Date;
  }): DomainEventEnvelope<ProductsConfigurationPublishedPayload> {
    const occurredAt = input.occurredAt || new Date();
    const eventId = `evt_${randomUUID()}`;
    const idempotencyKey =
      input.idempotencyKey ||
      `${input.tenantId}:${input.product.product_id}:configuration:${input.product.version}`;

    return {
      event_id: eventId,
      event_type: 'products.configuration_published',
      event_version: 1,
      occurred_at: occurredAt.toISOString(),
      tenant_id: input.tenantId,
      aggregate: {
        type: 'product_configuration',
        id: input.product.product_id,
        version: this.productAggregateVersion(input.product),
      },
      correlation_id: `corr_${input.product.product_id}_${input.product.version}`,
      causation_id: idempotencyKey,
      idempotency_key: idempotencyKey,
      payload: {
        product_id: input.product.product_id,
        product_type: input.product.type,
        name: input.product.name,
        enabled: input.product.enabled,
        configuration_version: this.productAggregateVersion(input.product),
      },
      metadata: {
        producer: 'fengine',
        data_classification: 'internal',
        schema_uri: 'contracts/domain-events/event-envelope.schema.json',
      },
    };
  }

  private aggregateVersion(loan: Loan, override?: number): number {
    if (Number.isInteger(override) && override > 0) {
      return override;
    }
    if (Number.isInteger(loan.version) && loan.version > 0) {
      return loan.version;
    }
    if (loan.updated_at instanceof Date) {
      return Math.max(1, loan.updated_at.getTime());
    }
    return 1;
  }

  private productAggregateVersion(product: ProductSchema): number {
    if (Number.isInteger(product.version) && product.version > 0) {
      return product.version;
    }
    if (product.updated_at instanceof Date) {
      return Math.max(1, product.updated_at.getTime());
    }
    return 1;
  }
}
