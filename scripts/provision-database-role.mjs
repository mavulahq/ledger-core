#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const migrationUrl = required('LEDGER_CORE_MIGRATION_DATABASE_URL');
const password = required('LEDGER_CORE_DATABASE_ROLE_PASSWORD');
if (password.length < 16 || password.startsWith('REPLACE_WITH_')) {
  throw new Error('LEDGER_CORE_DATABASE_ROLE_PASSWORD must be a non-placeholder secret of at least 16 characters');
}

const prisma = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
try {
  await prisma.$executeRawUnsafe(
    `ALTER ROLE ledger_core_app WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`,
  );
  const [role] = await prisma.$queryRawUnsafe(`
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
    FROM pg_roles WHERE rolname = 'ledger_core_app'
  `);
  if (
    !role?.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole ||
    role.rolinherit || role.rolbypassrls
  ) {
    throw new Error('ledger_core_app role attributes do not satisfy the runtime security policy');
  }
} finally {
  await prisma.$disconnect();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
