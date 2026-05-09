-- RLS and schema-per-tenant setup (run as superuser or owner)
-- This script creates a tenant schema, moves tables during migration and sets RLS policies as examples.

-- Example: create schema for tenant
CREATE SCHEMA IF NOT EXISTS tenant_inst_0001 AUTHORIZATION CURRENT_USER;

-- Example: create accounts table inside tenant schema (initial)
CREATE TABLE IF NOT EXISTS tenant_inst_0001.accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  balance numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Example: Add RLS policy on a shared table in public schema (if using shared schema)
-- This is an example; prefer schema-per-tenant for stronger isolation
-- ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON public.accounts USING (tenant_id = current_setting('app.current_tenant_id', true));

-- Note: For zero-downtime, create new nullable columns, backfill, add NOT VALID constraints, then set NOT NULL.
-- See migration runbook for patterns
