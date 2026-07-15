import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { FengineStoreService } from '../services/fengine-store.service';
import { TransactionStatus, type Transaction } from '../transactions/transaction.service';

const MAX_PAGE_SIZE = 500;
const TWO_DECIMAL_CURRENCIES = new Set(['MZN', 'USD', 'EUR', 'GBP', 'ZAR']);

export interface RegulatoryExportSourceRequest {
  tenant_id: string;
  institution_id: string;
  period_from: string;
  period_to: string;
  legal_basis_code: string;
  retention_until: string;
  cursor?: string;
  limit?: number;
}

export interface RegulatoryTransactionRecord {
  record_id: string;
  transaction_id: string;
  transaction_type: string;
  instruction_method: string;
  source_party_id: string;
  source_account_id: string;
  destination_party_id: string;
  destination_account_id: string;
  counterparty_id: string;
  amount_minor: string;
  currency: string;
  occurred_at: string;
  recorded_at: string;
  correlation_id: string;
  retention_until: string;
  legal_basis_code: string;
  adjustment_type?: string;
  original_transaction_id?: string;
  reversal_transaction_id?: string;
  replacement_transaction_id?: string;
}

export interface RegulatorySourceRejection {
  transaction_id: string;
  code: string;
  field: string;
}

@Injectable()
export class RegulatoryExportSourceService {
  constructor(private readonly store: FengineStoreService) {}

  async page(input: RegulatoryExportSourceRequest): Promise<{
    records: RegulatoryTransactionRecord[];
    rejections: RegulatorySourceRejection[];
    next_cursor?: string;
  }> {
    const periodFrom = startOfUtcDay(input.period_from);
    const periodTo = endOfUtcDay(input.period_to);
    if (periodFrom > periodTo) throw new Error('period_from must not be after period_to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.retention_until)) throw new Error('retention_until must be an ISO date');
    required(input.legal_basis_code, 'legal_basis_code');
    const limit = input.limit ?? MAX_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error('limit must be between 1 and 500');

    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const transactions = (await this.store.listTransactions(input.tenant_id))
      .filter((transaction) => transaction.status === TransactionStatus.POSTED && postedAt(transaction))
      .filter((transaction) => postedAt(transaction)! >= periodFrom && postedAt(transaction)! <= periodTo)
      .sort(compareTransactions)
      .filter((transaction) => !cursor || compareKey(transaction, cursor) > 0);
    const selected = transactions.slice(0, limit);
    const records: RegulatoryTransactionRecord[] = [];
    const rejections: RegulatorySourceRejection[] = [];
    for (const transaction of selected) {
      const mapped = this.map(transaction, input);
      if ('record' in mapped) records.push(mapped.record);
      else rejections.push(mapped.rejection);
    }
    const last = selected.at(-1);
    return {
      records,
      rejections: rejections.sort((left, right) => left.transaction_id.localeCompare(right.transaction_id)
        || left.field.localeCompare(right.field) || left.code.localeCompare(right.code)),
      next_cursor: transactions.length > selected.length && last ? encodeCursor(last) : undefined,
    };
  }

  private map(transaction: Transaction, input: RegulatoryExportSourceRequest):
    | { record: RegulatoryTransactionRecord }
    | { rejection: RegulatorySourceRejection } {
    const metadata = transaction.metadata || {};
    const values = {
      source_party_id: text(metadata.customer_id ?? metadata.source_party_id),
      source_account_id: text(transaction.from_account_id),
      destination_party_id: text(metadata.destination_party_id ?? input.institution_id),
      destination_account_id: text(transaction.to_account_id ?? transaction.loan_id),
      counterparty_id: text(metadata.counterparty_id ?? metadata.destination_party_id ?? input.institution_id),
      correlation_id: text(metadata.correlation_id ?? transaction.id),
      instruction_method: text(metadata.instruction_method ?? 'SYSTEM'),
    };
    for (const [field, value] of Object.entries(values)) {
      if (!value) return { rejection: { transaction_id: transaction.id, field, code: 'REQUIRED_SOURCE_FIELD_MISSING' } };
    }
    const widths: Record<string, number> = {
      transaction_id: 64, transaction_type: 32, instruction_method: 8,
      source_party_id: 64, source_account_id: 64, destination_party_id: 64,
      destination_account_id: 64, counterparty_id: 64, correlation_id: 64,
      legal_basis_code: 64,
    };
    const widthValues: Record<string, string> = {
      transaction_id: transaction.id, transaction_type: transaction.transaction_type,
      ...values, legal_basis_code: input.legal_basis_code,
    };
    for (const [field, maxLength] of Object.entries(widths)) {
      if (!/^[\x20-\x7e]+$/.test(widthValues[field])) {
        return { rejection: { transaction_id: transaction.id, field, code: 'NON_ASCII_SOURCE_FIELD' } };
      }
      if (widthValues[field].length > maxLength) {
        return { rejection: { transaction_id: transaction.id, field, code: 'SOURCE_FIELD_TOO_LONG' } };
      }
    }
    if (!TWO_DECIMAL_CURRENCIES.has(transaction.currency)) {
      return { rejection: { transaction_id: transaction.id, field: 'currency', code: 'CURRENCY_SCALE_UNSUPPORTED' } };
    }
    const amount = new Decimal(transaction.amount).times(100);
    if (!amount.isInteger() || amount.isNegative()) {
      return { rejection: { transaction_id: transaction.id, field: 'amount', code: 'AMOUNT_SCALE_INVALID' } };
    }
    if (amount.toFixed(0).length > 18) {
      return { rejection: { transaction_id: transaction.id, field: 'amount', code: 'AMOUNT_TOO_LARGE' } };
    }
    const occurredAt = postedAt(transaction)!;
    const recordedAt = asDate(transaction.created_at, 'created_at');
    return { record: {
      record_id: `regtxn_${createHash('sha256').update(transaction.id).digest('hex').slice(0, 40)}`,
      transaction_id: transaction.id,
      transaction_type: transaction.transaction_type,
      instruction_method: values.instruction_method,
      source_party_id: values.source_party_id,
      source_account_id: values.source_account_id,
      destination_party_id: values.destination_party_id,
      destination_account_id: values.destination_account_id,
      counterparty_id: values.counterparty_id,
      amount_minor: amount.toFixed(0),
      currency: transaction.currency,
      occurred_at: occurredAt.toISOString(),
      recorded_at: recordedAt.toISOString(),
      correlation_id: values.correlation_id,
      retention_until: input.retention_until,
      legal_basis_code: input.legal_basis_code,
      adjustment_type: transaction.reversal_of_transaction_id
        ? 'REVERSAL'
        : transaction.correction_of_transaction_id ? 'CORRECTION' : undefined,
      original_transaction_id: transaction.reversal_of_transaction_id ?? transaction.correction_of_transaction_id,
      reversal_transaction_id: transaction.reversal_of_transaction_id ? transaction.id : undefined,
      replacement_transaction_id: transaction.correction_of_transaction_id ? transaction.id : undefined,
    } };
  }
}

function startOfUtcDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('period dates must use YYYY-MM-DD');
  return new Date(`${value}T00:00:00.000Z`);
}
function endOfUtcDay(value: string): Date { const date = startOfUtcDay(value); date.setUTCDate(date.getUTCDate() + 1); return new Date(date.valueOf() - 1); }
function compareTransactions(left: Transaction, right: Transaction): number { return compareKey(left, { postedAt: postedAt(right)!.toISOString(), id: right.id }); }
function compareKey(transaction: Transaction, key: { postedAt: string; id: string }): number {
  return postedAt(transaction)!.toISOString().localeCompare(key.postedAt) || transaction.id.localeCompare(key.id);
}
function encodeCursor(transaction: Transaction): string { return Buffer.from(JSON.stringify({ postedAt: postedAt(transaction)!.toISOString(), id: transaction.id })).toString('base64url'); }
function decodeCursor(value: string): { postedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.postedAt !== 'string' || Number.isNaN(new Date(parsed.postedAt).valueOf()) || typeof parsed.id !== 'string' || !parsed.id) throw new Error();
    return parsed;
  } catch { throw new Error('cursor is invalid'); }
}
function required(value: string, field: string): void { if (!value?.trim()) throw new Error(`${field} is required`); }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function postedAt(transaction: Transaction): Date | undefined {
  return transaction.posted_at ? asDate(transaction.posted_at, 'posted_at') : undefined;
}
function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} is invalid`);
  return date;
}
