-- Least privilege: cross-tenant pending outbox tenant listing is maintenance-only.
REVOKE EXECUTE ON FUNCTION public.pending_domain_outbox_tenants(integer) FROM ledger_core_app;
GRANT EXECUTE ON FUNCTION public.pending_domain_outbox_tenants(integer) TO ledger_core_maintenance;

-- Reinforce append-only audit trail for the application role.
REVOKE UPDATE, DELETE ON public.audit_trail_events FROM ledger_core_app;
GRANT SELECT, INSERT ON public.audit_trail_events TO ledger_core_app;
