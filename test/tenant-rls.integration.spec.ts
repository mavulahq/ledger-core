import { PrismaClient } from '@prisma/client';
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
