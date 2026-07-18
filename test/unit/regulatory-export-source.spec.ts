import { RegulatoryExportSourceService } from '../../src/regulatory/regulatory-export-source.service';
import { TransactionStatus, TransactionType } from '../../src/transactions/transaction.service';

describe('RegulatoryExportSourceService', () => {
  const transactions = [
    {
      id: 'txn_2', tenant_id: 'tenant_1', transaction_type: TransactionType.LOAN_PAYMENT,
      status: TransactionStatus.POSTED, from_account_id: 'account_1', loan_id: 'loan_1', amount: 1200,
      currency: 'MZN', created_at: new Date('2026-07-15T10:00:01Z'), posted_at: new Date('2026-07-15T10:00:02Z'),
      created_by: 'operator_1', metadata: { customer_id: 'customer_1', correlation_id: 'corr_2', instruction_method: 'BATCH' },
    },
    {
      id: 'txn_pending', tenant_id: 'tenant_1', transaction_type: TransactionType.TRANSFER,
      status: TransactionStatus.PENDING, from_account_id: 'account_1', amount: 1, currency: 'MZN',
      created_at: new Date('2026-07-15T10:00:00Z'), created_by: 'operator_1', metadata: {},
    },
  ];
  const store = {
    pageRegulatoryTransactions: jest.fn(async () => transactions.filter((transaction) => transaction.status === TransactionStatus.POSTED)),
  } as any;
  const service = new RegulatoryExportSourceService(store);
  const request = {
    tenant_id: 'tenant_1', institution_id: 'institution_1', period_from: '2026-07-01', period_to: '2026-07-31',
    legal_basis_code: 'MZ-AML-14-2023-ART-43', retention_until: '2036-07-15', limit: 500,
  };

  it('returns only posted transactions without mutating financial state', async () => {
    const result = await service.page(request);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ transaction_id: 'txn_2', amount_minor: '120000', currency: 'MZN' });
    expect(result.rejections).toEqual([]);
    expect(store.pageRegulatoryTransactions).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant_1', limit: 501,
    }));
  });

  it('normalizes persisted ISO timestamps from transaction JSON', async () => {
    store.pageRegulatoryTransactions.mockResolvedValueOnce([{
      ...transactions[0], created_at: '2026-07-15T10:00:01.000Z', posted_at: '2026-07-15T10:00:02.000Z',
    }]);
    const result = await service.page(request);
    expect(result.records[0]).toMatchObject({
      occurred_at: '2026-07-15T10:00:02.000Z', recorded_at: '2026-07-15T10:00:01.000Z',
    });
  });

  it('fails closed with a deterministic rejection for incomplete mapping', async () => {
    store.pageRegulatoryTransactions.mockResolvedValueOnce([{ ...transactions[0], loan_id: undefined }]);
    const result = await service.page(request);
    expect(result.records).toEqual([]);
    expect(result.rejections).toEqual([{ transaction_id: 'txn_2', field: 'destination_account_id', code: 'REQUIRED_SOURCE_FIELD_MISSING' }]);
  });

  it('rejects unsupported currency scales and excessive page sizes', async () => {
    store.pageRegulatoryTransactions.mockResolvedValueOnce([{ ...transactions[0], currency: 'JPY' }]);
    await expect(service.page({ ...request, limit: 501 })).rejects.toThrow('limit must be between 1 and 500');
    const result = await service.page(request);
    expect(result.rejections[0].code).toBe('CURRENCY_SCALE_UNSUPPORTED');
  });

  it('rejects impossible period and retention dates', async () => {
    await expect(service.page({ ...request, period_from: '2026-02-30' })).rejects.toThrow('valid calendar dates');
    await expect(service.page({ ...request, retention_until: '2036-02-30' })).rejects.toThrow('valid calendar dates');
  });
});
