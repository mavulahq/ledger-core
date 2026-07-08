export interface DomainEventAggregate {
  type: string;
  id: string;
  version: number;
}

export interface DomainEventMetadata {
  producer: 'ledger-core' | 'workbench' | 'settlements' | 'fengine' | 'fwk' | 'fpay';
  data_classification: 'public' | 'internal' | 'confidential' | 'restricted';
  trace_id?: string;
  schema_uri?: string;
  [key: string]: any;
}

export interface DomainEventEnvelope<TPayload extends Record<string, any> = Record<string, any>> {
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: string;
  tenant_id: string;
  aggregate: DomainEventAggregate;
  correlation_id: string;
  causation_id: string;
  idempotency_key?: string;
  payload: TPayload;
  metadata: DomainEventMetadata;
}

export type DomainOutboxStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
export type DomainInboxStatus = 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface DomainOutboxRecord {
  envelope: DomainEventEnvelope;
  status: DomainOutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_until?: Date;
  locked_by?: string;
  published_at?: Date;
  failed_at?: Date;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
}

export interface DomainInboxRecord {
  event_id: string;
  consumer_name: string;
  tenant_id: string;
  status: DomainInboxStatus;
  processed_at?: Date;
  failed_at?: Date;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
}

export interface LoanDisbursedPayload {
  transaction_id: string;
  destination_account_id: string;
  money: {
    amount: string;
    currency: string;
  };
}

export interface LendingPaymentPostedPayload {
  transaction_id: string;
  source_account_id: string;
  money: {
    amount: string;
    currency: string;
  };
  allocation: {
    principal: string;
    interest: string;
    fees: string;
  };
  balance_after: string;
}

export interface ProductsConfigurationPublishedPayload {
  product_id: string;
  product_type: string;
  name: string;
  enabled: boolean;
  configuration_version: number;
}

export interface LedgerJournalPostedPayload {
  journal_entry_id: string;
  transaction_id: string;
  posted_at: string;
  line_count: number;
  totals: Array<{
    currency: string;
    debit: string;
    credit: string;
  }>;
  lines: Array<{
    account_code: string;
    currency: string;
    debit: string;
    credit: string;
  }>;
}

export function assertDomainEventEnvelope(value: any): asserts value is DomainEventEnvelope {
  if (!value || typeof value !== 'object') {
    throw new Error('domain event envelope must be an object');
  }
  if (
    !/^evt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.event_id || '',
    )
  ) {
    throw new Error('domain event event_id must use evt_<uuid>');
  }
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(value.event_type || '')) {
    throw new Error('domain event event_type must use <context>.<fact>');
  }
  if (!Number.isInteger(value.event_version) || value.event_version < 1) {
    throw new Error('domain event event_version must be a positive integer');
  }
  if (
    !value.occurred_at ||
    Number.isNaN(Date.parse(value.occurred_at)) ||
    !String(value.occurred_at).endsWith('Z')
  ) {
    throw new Error('domain event occurred_at must be UTC');
  }
  if (!value.tenant_id) {
    throw new Error('domain event tenant_id is required');
  }
  if (
    !value.aggregate?.type ||
    !value.aggregate?.id ||
    !Number.isInteger(value.aggregate?.version)
  ) {
    throw new Error('domain event aggregate must include type, id, and version');
  }
  if (!value.correlation_id || !value.causation_id) {
    throw new Error('domain event correlation_id and causation_id are required');
  }
  if (!value.payload || typeof value.payload !== 'object') {
    throw new Error('domain event payload must be an object');
  }
  if (!value.metadata?.producer || !value.metadata?.data_classification) {
    throw new Error('domain event metadata producer and data_classification are required');
  }
}
