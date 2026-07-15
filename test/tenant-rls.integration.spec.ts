import { PrismaClient } from '@prisma/client';
import { FinancialAdjustmentsService } from '../src/adjustments/financial-adjustments.service';
import { DomainEventFactory } from '../src/domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../src/domain-events/domain-outbox.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { AccountsService } from '../src/services/accounts.service';
import { AuditTrailService } from '../src/services/audit-trail.service';
import { FengineStoreService } from '../src/services/fengine-store.service';
import { PrismaService } from '../src/services/prisma.service';

const describeRls = process.env.LEDGER_CORE_RLS_TEST === 'true' ? describe : describe.skip;

describeRls('PostgreSQL tenant RLS', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const tenantA = `rls_a_${suffix}`;
  const tenantB = `rls_b_${suffix}`;
  const institutionA = `institution_a_${suffix}`;
  const institutionB = `institution_b_${suffix}`;
  let admin: PrismaClient;
  let app: PrismaClient;
  let scoped: PrismaService;
  let adjustments: FinancialAdjustmentsService;
  let accounts: AccountsService;
  let ledger: LedgerService;

  beforeAll(async () => {
    const migrationUrl = required('LEDGER_CORE_MIGRATION_DATABASE_URL');
    const appUrl = required('DATABASE_URL');
    admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    app = new PrismaClient({ datasources: { db: { url: withSingleConnection(appUrl) } } });
    scoped = new PrismaService();
    await admin.$connect();
    await app.$connect();
    await scoped.onModuleInit();
    await scoped.bindTenantReference({ tenantId: tenantA, institutionId: institutionA });
    await scoped.bindTenantReference({ tenantId: tenantB, institutionId: institutionB });
    const store = new FengineStoreService(scoped);
    const audit = new AuditTrailService(scoped);
    accounts = new AccountsService(scoped, store, audit);
    const eventFactory = new DomainEventFactory();
    const outbox = new DomainOutboxService(scoped);
    ledger = new LedgerService(scoped, store, audit, eventFactory, outbox, accounts);
    adjustments = new FinancialAdjustmentsService(
      scoped,
      store,
      ledger,
      accounts,
      audit,
      eventFactory,
      outbox,
    );
  });

  afterAll(async () => {
    await admin.$executeRaw`DELETE FROM public.tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await scoped.onModuleDestroy();
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('uses a non-bypass runtime role', async () => {
    const [role] = await admin.$queryRaw<Array<Record<string, boolean>>>`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
      FROM pg_roles WHERE rolname = 'ledger_core_app'
    `;
    expect(role).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolbypassrls: false,
    });
  });

  it('isolates reads and WITH CHECK writes between tenants', async () => {
    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.accounts (id, "tenantId", name, balance)
      VALUES (${`account_a_${suffix}`}, ${tenantA}, 'Tenant A account', 10)
    `);
    await scoped.withTenant(tenantB, (tx) => tx.$executeRaw`
      INSERT INTO public.accounts (id, "tenantId", name, balance)
      VALUES (${`account_b_${suffix}`}, ${tenantB}, 'Tenant B account', 20)
    `);

    const rowsA = await scoped.withTenant(tenantA, (tx) => tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM public.accounts ORDER BY id
    `);
    expect(rowsA).toEqual([{ tenantId: tenantA }]);

    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.accounts (id, "tenantId", name, balance)
      VALUES (${`cross_${suffix}`}, ${tenantB}, 'Cross tenant account', 30)
    `)).rejects.toThrow();

    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.account_lifecycle_requests (
        id, "tenantId", "accountId", transition, "fromStatus", "targetStatus",
        "expectedAccountVersion", reason, "requestedBy", "requestedRoles",
        "institutionId", "correlationId"
      ) VALUES (
        ${`request_a_${suffix}`}, ${tenantA}, ${`account_a_${suffix}`}, 'FREEZE',
        'ACTIVE', 'FROZEN', 1, 'RLS lifecycle request', 'maker_a', '[]'::jsonb,
        ${institutionA}, 'corr_rls_a'
      )
    `);
    const lifecycleRows = await scoped.withTenant(tenantA, (tx) => tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM public.account_lifecycle_requests
    `);
    expect(lifecycleRows).toEqual([{ tenantId: tenantA }]);
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.account_lifecycle_requests (
        id, "tenantId", "accountId", transition, "fromStatus", "targetStatus",
        "expectedAccountVersion", reason, "requestedBy", "requestedRoles",
        "institutionId", "correlationId"
      ) VALUES (
        ${`cross_request_${suffix}`}, ${tenantB}, ${`account_b_${suffix}`}, 'FREEZE',
        'ACTIVE', 'FROZEN', 1, 'Cross tenant request', 'maker_a', '[]'::jsonb,
        ${institutionB}, 'corr_cross'
      )
    `)).rejects.toThrow();
  });

  it('keeps account entries append-only for the runtime role', async () => {
    const entryId = `entry_a_${suffix}`;
    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.account_entries (
        id, "tenantId", "accountId", "postingKey", "entryType", direction,
        amount, currency, "balanceAfter", "createdBy", "postedAt"
      ) VALUES (
        ${entryId}, ${tenantA}, ${`account_a_${suffix}`}, ${`posting_a_${suffix}`},
        'POSTING', 'CREDIT', 10, 'MZN', 10, 'SYSTEM', now()
      )
    `);
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      UPDATE public.account_entries SET amount = 20
      WHERE "tenantId" = ${tenantA} AND id = ${entryId}
    `)).rejects.toThrow();
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      DELETE FROM public.account_entries
      WHERE "tenantId" = ${tenantA} AND id = ${entryId}
    `)).rejects.toThrow();
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      DELETE FROM public.accounts
      WHERE "tenantId" = ${tenantA} AND id = ${`account_a_${suffix}`}
    `)).rejects.toThrow();
  });

  it('isolates adjustment requests and keeps structured audit events append-only', async () => {
    const requestId = `adjustment_a_${suffix}`;
    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.financial_adjustment_requests (
        id, "tenantId", "targetType", "targetId", "adjustmentType", status,
        reason, "targetJournalEntryId", "requestedBy", "requestedRoles",
        "institutionId", "correlationId"
      ) VALUES (
        ${requestId}, ${tenantA}, 'JOURNAL_ENTRY', ${`journal_a_${suffix}`},
        'REVERSAL', 'PENDING_APPROVAL', 'RLS adjustment request',
        ${`journal_a_${suffix}`}, 'maker_a', '["operations_maker"]'::jsonb,
        ${institutionA}, ${`corr_adjustment_a_${suffix}`}
      )
    `);
    const requests = await scoped.withTenant(tenantA, (tx) => tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM public.financial_adjustment_requests
    `);
    expect(requests).toEqual([{ tenantId: tenantA }]);
    await expect(scoped.withTenant(tenantB, (tx) => tx.$queryRaw`
      SELECT * FROM public.financial_adjustment_requests WHERE id = ${requestId}
    `)).resolves.toEqual([]);
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.financial_adjustment_requests (
        id, "tenantId", "targetType", "targetId", "adjustmentType", status,
        reason, "targetJournalEntryId", "requestedBy", "requestedRoles",
        "institutionId", "correlationId"
      ) VALUES (
        ${`adjustment_duplicate_${suffix}`}, ${tenantA}, 'JOURNAL_ENTRY', ${`journal_a_${suffix}`},
        'REVERSAL', 'APPLIED', 'Duplicate active adjustment',
        ${`journal_a_${suffix}`}, 'maker_b', '[]'::jsonb,
        ${institutionA}, ${`corr_adjustment_duplicate_${suffix}`}
      )
    `)).rejects.toThrow();

    const auditId = `audit_adjustment_a_${suffix}`;
    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.audit_trail_events (
        id, "tenantId", action, "entityType", "entityId", stage, result, source,
        "actorId", "actorRoles", "institutionId", reason, "correlationId",
        "approvalReference", metadata
      ) VALUES (
        ${auditId}, ${tenantA}, 'financial.adjustment.requested', 'financial_adjustment',
        ${requestId}, 'REQUESTED', 'PENDING', 'API', 'maker_a',
        '["operations_maker"]'::jsonb, ${institutionA}, 'RLS adjustment request',
        ${`corr_adjustment_a_${suffix}`}, ${requestId}, '{}'::jsonb
      )
    `);
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      UPDATE public.audit_trail_events SET result = 'SUCCEEDED' WHERE id = ${auditId}
    `)).rejects.toThrow();
    await expect(scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      DELETE FROM public.audit_trail_events WHERE id = ${auditId}
    `)).rejects.toThrow();
  });

  it('applies reversal and replacement atomically through the runtime role', async () => {
    const productId = `product_adjustment_${suffix}`;
    await scoped.withTenant(tenantA, (tx) => tx.$executeRaw`
      INSERT INTO public.products (id, "tenantId", type, name, enabled, config)
      VALUES (${productId}, ${tenantA}, 'CHECKING', 'Adjustment Product', true, '{}'::jsonb)
    `);
    await ledger.initializeChartOfAccounts(tenantA);
    const account = await accounts.createAccount(tenantA, {
      customer_id: `customer_adjustment_${suffix}`,
      product_id: productId,
      name: 'Adjustment account',
      currency: 'MZN',
    }, {
      subject: 'maker_database',
      roles: ['operations_maker'],
      permissions: ['finance.write'],
      institutionId: institutionA,
      correlationId: `corr_account_${suffix}`,
    });
    const originalId = `journal_adjustment_${suffix}`;
    await ledger.postJournalEntry(tenantA, {
      entry_id: originalId,
      entry_date: new Date(),
      transaction_id: `transaction_adjustment_${suffix}`,
      description: 'Original database adjustment posting',
      posted_by: 'maker_database',
      posting_date: new Date(),
      entries: [
        { account_code: '10010', debit_amount: 100 },
        { account_code: '20010', credit_amount: 100 },
      ],
      account_postings: [{
        accountId: account.id,
        direction: 'CREDIT',
        amount: '100.00',
        currency: 'MZN',
      }],
      status: 'DRAFT',
      metadata: {},
    });
    const request = await adjustments.submit(tenantA, {
      targetType: 'JOURNAL_ENTRY',
      targetId: originalId,
      adjustmentType: 'CORRECTION',
      reason: 'Correct database posting amount',
      correction: {
        journal: {
          ledgerLines: [
            { account_code: '10010', debit_amount: 75 },
            { account_code: '20010', credit_amount: 75 },
          ],
          accountPostings: [{
            accountId: account.id,
            direction: 'CREDIT',
            amount: '75.00',
            currency: 'MZN',
          }],
        },
      },
    }, {
      subject: 'maker_database',
      roles: ['operations_maker'],
      permissions: ['finance.write'],
      institutionId: institutionA,
      correlationId: `corr_adjustment_database_${suffix}`,
    });

    const applied = await adjustments.approve(tenantA, request.id, 'Database evidence approved', {
      subject: 'checker_database',
      roles: ['operations_checker'],
      permissions: ['finance.approve'],
      institutionId: institutionA,
      correlationId: `corr_adjustment_database_${suffix}`,
    });

    expect(applied).toMatchObject({
      status: 'APPLIED',
      reversalJournalEntryId: expect.any(String),
      replacementJournalEntryId: expect.any(String),
    });
    await expect(accounts.getBalance(tenantA, account.id)).resolves.toMatchObject({ balance: '75.00' });
    await expect(ledger.generateTrialBalance(tenantA, new Date())).resolves.toMatchObject({ is_balanced: true });
    const state = await scoped.withTenant(tenantA, async (tx) => {
      const journals = await tx.$queryRaw<Array<{ id: string; adjustmentRequestId: string | null }>>`
        SELECT id, "adjustmentRequestId" FROM public.journal_entries
        WHERE "tenantId" = ${tenantA} AND (id = ${originalId} OR "adjustmentRequestId" = ${request.id})
        ORDER BY id
      `;
      const events = await tx.$queryRaw<Array<{ eventType: string }>>`
        SELECT "eventType" FROM public.domain_outbox_events
        WHERE "tenantId" = ${tenantA} AND "idempotencyKey" = ${`${tenantA}:${request.id}:ledger.adjustment_posted:v1`}
      `;
      return { journals, events };
    });
    expect(state.journals).toHaveLength(3);
    expect(state.journals.find((entry) => entry.id === originalId)?.adjustmentRequestId).toBeNull();
    expect(state.journals.filter((entry) => entry.adjustmentRequestId === request.id)).toHaveLength(2);
    expect(state.events).toEqual([{ eventType: 'ledger.adjustment_posted' }]);
  });

  it('does not leak SET LOCAL context through a reused connection', async () => {
    for (const tenantId of [tenantA, tenantB, tenantA, tenantB]) {
      const visible = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ tenantId: string }>>`SELECT "tenantId" FROM public.accounts`;
      });
      expect(visible.every((row) => row.tenantId === tenantId)).toBe(true);
      const [outside] = await app.$queryRaw<Array<{ currentTenant: string | null }>>`
        SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS "currentTenant"
      `;
      expect(outside.currentTenant).toBeNull();
    }
  });

  it('rejects a different institution after the first trusted binding', async () => {
    await expect(scoped.bindTenantReference({
      tenantId: tenantA,
      institutionId: institutionB,
    })).rejects.toThrow('Authenticated tenant and institution do not match');
  });
});

function withSingleConnection(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
