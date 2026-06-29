-- getfluxo.io fengine tenant isolation baseline.
-- Run after Prisma creates the shared-schema tables.
-- Runtime code must set app.current_tenant_id on each DB transaction/session.

CREATE OR REPLACE FUNCTION public.set_current_tenant(tenant_id text)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_tenant_id', tenant_id, true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS text AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '');
END;
$$ LANGUAGE plpgsql STABLE;

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_entity_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_trail_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.read_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projection_checkpoints ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.loans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.custom_entity_schemas FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_trail_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.domain_outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.domain_inbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.read_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projection_checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_accounts ON public.accounts;
CREATE POLICY tenant_isolation_accounts ON public.accounts
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_products ON public.products;
CREATE POLICY tenant_isolation_products ON public.products
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_tenant_configs ON public.tenant_configs;
CREATE POLICY tenant_isolation_tenant_configs ON public.tenant_configs
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_loans ON public.loans;
CREATE POLICY tenant_isolation_loans ON public.loans
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_financial_transactions ON public.financial_transactions;
CREATE POLICY tenant_isolation_financial_transactions ON public.financial_transactions
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_ledger_accounts ON public.ledger_accounts;
CREATE POLICY tenant_isolation_ledger_accounts ON public.ledger_accounts
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_journal_entries ON public.journal_entries;
CREATE POLICY tenant_isolation_journal_entries ON public.journal_entries
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_custom_entity_schemas ON public.custom_entity_schemas;
CREATE POLICY tenant_isolation_custom_entity_schemas ON public.custom_entity_schemas
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_workflow_definitions ON public.workflow_definitions;
CREATE POLICY tenant_isolation_workflow_definitions ON public.workflow_definitions
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_rules ON public.rules;
CREATE POLICY tenant_isolation_rules ON public.rules
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_audit_trail_events ON public.audit_trail_events;
CREATE POLICY tenant_isolation_audit_trail_events ON public.audit_trail_events
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_domain_outbox_events ON public.domain_outbox_events;
CREATE POLICY tenant_isolation_domain_outbox_events ON public.domain_outbox_events
  USING ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*')
  WITH CHECK ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*');

DROP POLICY IF EXISTS tenant_isolation_domain_inbox_events ON public.domain_inbox_events;
CREATE POLICY tenant_isolation_domain_inbox_events ON public.domain_inbox_events
  USING ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*')
  WITH CHECK ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*');

DROP POLICY IF EXISTS tenant_isolation_read_projections ON public.read_projections;
CREATE POLICY tenant_isolation_read_projections ON public.read_projections
  USING ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*')
  WITH CHECK ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*');

DROP POLICY IF EXISTS tenant_isolation_projection_checkpoints ON public.projection_checkpoints;
CREATE POLICY tenant_isolation_projection_checkpoints ON public.projection_checkpoints
  USING ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*')
  WITH CHECK ("tenantId" = public.current_tenant_id() OR public.current_tenant_id() = '*');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fengine_app') THEN
    CREATE ROLE fengine_app LOGIN PASSWORD 'fengine_dev';
  END IF;
END;
$$;

ALTER ROLE fengine_app NOBYPASSRLS;
GRANT CONNECT ON DATABASE getfluxo TO fengine_app;
GRANT USAGE ON SCHEMA public TO fengine_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fengine_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fengine_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fengine_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fengine_app;
