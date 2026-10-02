GRANT SELECT, DELETE ON public.idempotency_receipts TO ledger_core_maintenance;
CREATE POLICY maintenance_idempotency_receipts ON public.idempotency_receipts
  TO ledger_core_maintenance USING (true);

ALTER FUNCTION public.cleanup_expired_idempotency_receipts(integer) OWNER TO ledger_core_maintenance;
ALTER FUNCTION public.idempotency_receipt_status_totals() OWNER TO ledger_core_maintenance;
ALTER FUNCTION public.delete_expired_idempotency_receipt(text, text, text) OWNER TO ledger_core_maintenance;
REVOKE ALL ON FUNCTION public.cleanup_expired_idempotency_receipts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idempotency_receipt_status_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_expired_idempotency_receipt(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_idempotency_receipts(integer) TO ledger_core_app;
GRANT EXECUTE ON FUNCTION public.idempotency_receipt_status_totals() TO ledger_core_app;
GRANT EXECUTE ON FUNCTION public.delete_expired_idempotency_receipt(text, text, text) TO ledger_core_app;

DROP INDEX IF EXISTS public.financial_adjustment_requests_one_active_target_key;
CREATE UNIQUE INDEX financial_adjustment_requests_one_active_canonical_target_key
  ON public.financial_adjustment_requests("tenantId", "targetJournalEntryId")
  WHERE status IN ('PENDING_APPROVAL', 'APPLIED');
