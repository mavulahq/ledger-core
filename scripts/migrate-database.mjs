#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const migrationUrl = required('LEDGER_CORE_MIGRATION_DATABASE_URL');
const env = { ...process.env, DATABASE_URL: migrationUrl };
const prisma = new PrismaClient({ datasources: { db: { url: migrationUrl } } });

try {
  const [state] = await prisma.$queryRawUnsafe(`
    SELECT
      to_regclass('public.tenants') IS NOT NULL AS "hasLedgerSchema",
      to_regclass('public._prisma_migrations') IS NOT NULL AS "hasMigrationHistory"
  `);

  if (state.hasLedgerSchema && !state.hasMigrationHistory) {
    if (process.env.LEDGER_CORE_ACCEPT_BASELINE !== 'true') {
      throw new Error(
        'Existing ledger schema has no Prisma history; verify it and set LEDGER_CORE_ACCEPT_BASELINE=true once',
      );
    }
    runPrisma([
      'migrate', 'diff',
      '--from-schema-datasource', 'prisma/baseline.schema.prisma',
      '--to-schema-datamodel', 'prisma/baseline.schema.prisma',
      '--exit-code',
    ]);
    runPrisma(['migrate', 'resolve', '--applied', '20260714000100_baseline']);
  }

  runPrisma(['migrate', 'deploy']);
} finally {
  await prisma.$disconnect();
}

function runPrisma(args) {
  const result = spawnSync('prisma', args, { cwd: process.cwd(), env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} failed with status ${result.status}`);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
