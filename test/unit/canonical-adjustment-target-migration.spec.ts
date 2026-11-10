import { readFileSync } from 'node:fs';

it('guards canonical journal adjustment uniqueness across target types and applied rows', () => {
  const migration = readFileSync(
    'prisma/migrations/20260718000300_canonical_adjustment_target_guard/migration.sql',
    'utf8',
  );

  expect(migration).toContain('pg_advisory_xact_lock');
  expect(migration).toContain('existing."targetJournalEntryId" = NEW."targetJournalEntryId"');
  expect(migration).toContain("existing.status IN ('PENDING_APPROVAL', 'APPLIED')");
  expect(migration).toContain('BEFORE INSERT OR UPDATE OF "tenantId", "targetJournalEntryId", status');
  expect(migration).toContain("ERRCODE = '23505'");
});
