import { DomainEventFactory } from '../../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../../src/domain-events/domain-outbox.service';
import { LedgerService } from '../../src/ledger/ledger.service';

describe('ledger posting persistence', () => {
  it('does not update balances when a configured journal entry already exists', async () => {
    const tenantId = 'tenant_001';
    const entryId = 'je_txn_001';
    const entryDate = new Date('2026-06-29T08:00:00.000Z');
    const postingDate = new Date('2026-06-29T08:01:00.000Z');
    const existingEntry = {
      id: entryId,
      tenantId,
      transactionId: 'txn_001',
      description: 'Existing journal posting',
      postedBy: 'SYSTEM',
      status: 'POSTED',
      entryDate,
      postingDate,
      lines: [
        { account_code: '10010', debit_amount: 2500 },
        { account_code: '11100', credit_amount: 2500 },
      ],
      metadata: {},
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([existingEntry])
        .mockResolvedValueOnce([{ currency: 'MZN' }])
        .mockResolvedValueOnce([{ currency: 'MZN' }]),
    };
    const prisma = {
      isConfigured: true,
      withTenant: jest.fn(async (_tenantId: string, handler: (transaction: any) => Promise<unknown>) => handler(tx)),
    };
    const auditTrail = { record: jest.fn() };
    const service = new LedgerService(
      prisma as any,
      {} as any,
      auditTrail as any,
      new DomainEventFactory(),
      new DomainOutboxService({ isConfigured: false } as any),
    );

    const result = await service.postJournalEntry(tenantId, {
      entry_id: entryId,
      entry_date: entryDate,
      transaction_id: 'txn_001',
      description: 'Duplicate journal posting',
      posted_by: 'SYSTEM',
      posting_date: postingDate,
      entries: [
        { account_code: '10010', debit_amount: 2500 },
        { account_code: '11100', credit_amount: 2500 },
      ],
      status: 'DRAFT',
      metadata: {},
    });

    const executedSql = tx.$executeRaw.mock.calls
      .map(([strings]) => Array.from(strings as TemplateStringsArray).join(' '))
      .join('\n');
    const queriedSql = tx.$queryRaw.mock.calls
      .map(([strings]) => Array.from(strings as TemplateStringsArray).join(' '))
      .join('\n');

    expect(result).toMatchObject({
      entry_id: entryId,
      transaction_id: 'txn_001',
      status: 'POSTED',
    });
    expect(auditTrail.record).not.toHaveBeenCalled();
    expect(queriedSql).toContain('INSERT INTO "journal_entries"');
    expect(executedSql).toContain('INSERT INTO "domain_outbox_events"');
    expect(executedSql).not.toContain('UPDATE "ledger_accounts"');
  });
});
