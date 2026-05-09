RLS & Schema-per-tenant Migration Runbook

This folder documents the recommended zero-downtime migration strategy when using schema-per-tenant or shared tables with RLS.

Key patterns:

1. Adding columns with non-deterministic defaults (e.g., now())
   - Step A: Add nullable column
   - Step B: Backfill values in batches
   - Step C: Add NOT VALID check constraint or set NOT NULL (fast)
   - Step D: Set column default if needed

2. Adding constraints
   - Step A: Create constraint NOT VALID (fast)
   - Step B: Validate constraint in a separate operation

3. Adding indexes
   - Use CREATE INDEX CONCURRENTLY on large tables

4. Foreign keys
   - Add foreign key NOT VALID, then VALIDATE

5. Moving tables to tenant schemas
   - Create tenant schema
   - Create table in tenant schema
   - Backfill data from shared table in batches (INSERT INTO tenant_schema.table SELECT ... FROM public.table WHERE tenant_id = '...')

Always test on a staging copy and create backups or point-in-time restores before running operations in production.
