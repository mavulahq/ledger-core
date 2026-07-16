ALTER TABLE public.tenants ADD COLUMN "institutionId" text;
CREATE UNIQUE INDEX "tenants_institutionId_key" ON public.tenants("institutionId");

DROP INDEX public."domain_inbox_events_eventId_consumerName_key";
CREATE UNIQUE INDEX "domain_inbox_events_tenantId_eventId_consumerName_key"
  ON public.domain_inbox_events("tenantId", "eventId", "consumerName");

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_core_app') THEN
    CREATE ROLE ledger_core_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_core_maintenance') THEN
    CREATE ROLE ledger_core_maintenance NOLOGIN;
  END IF;

  ALTER ROLE ledger_core_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ALTER ROLE ledger_core_maintenance NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fengine_app') THEN
    ALTER ROLE fengine_app NOLOGIN NOBYPASSRLS;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM fengine_app;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM fengine_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM fengine_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM fengine_app;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ledger_core_app', current_database());
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ledger_core_app, ledger_core_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ledger_core_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledger_core_app;
GRANT SELECT ON public.domain_outbox_events TO ledger_core_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ledger_core_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ledger_core_app;

DO $$
DECLARE
  table_name text;
  policy_name text;
  tenant_tables constant text[] := ARRAY[
    'tenants',
    'accounts',
    'products',
    'tenant_configs',
    'loans',
    'financial_transactions',
    'ledger_accounts',
    'journal_entries',
    'custom_entity_schemas',
    'workflow_definitions',
    'rules',
    'audit_trail_events',
    'domain_outbox_events',
    'domain_inbox_events',
    'read_projections',
    'projection_checkpoints'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    FOR policy_name IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', policy_name, table_name);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'tenants' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I TO ledger_core_app USING (id = public.current_tenant_id()) WITH CHECK (id = public.current_tenant_id())',
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I TO ledger_core_app USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id())',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

CREATE POLICY maintenance_outbox_discovery ON public.domain_outbox_events
  FOR SELECT TO ledger_core_maintenance
  USING (true);

CREATE OR REPLACE FUNCTION public.pending_domain_outbox_tenants(requested_limit integer)
RETURNS TABLE("tenantId" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT event."tenantId"
  FROM public.domain_outbox_events AS event
  WHERE (event.status = 'PENDING' AND event."availableAt" <= now())
     OR (event.status = 'PUBLISHING' AND event."lockedUntil" <= now())
  ORDER BY event."tenantId"
  LIMIT LEAST(GREATEST(requested_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION public.domain_outbox_status_totals()
RETURNS TABLE(status text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT event.status, count(*)
  FROM public.domain_outbox_events AS event
  GROUP BY event.status
$$;

ALTER FUNCTION public.pending_domain_outbox_tenants(integer) OWNER TO ledger_core_maintenance;
ALTER FUNCTION public.domain_outbox_status_totals() OWNER TO ledger_core_maintenance;
REVOKE ALL ON FUNCTION public.pending_domain_outbox_tenants(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.domain_outbox_status_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_domain_outbox_tenants(integer) TO ledger_core_app;
GRANT EXECUTE ON FUNCTION public.domain_outbox_status_totals() TO ledger_core_app;
