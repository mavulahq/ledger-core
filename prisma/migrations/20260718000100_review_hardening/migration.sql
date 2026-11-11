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

-- Keep an applied adjustment as historical truth; only pending duplicates need
-- to be reconciled before enforcing one pending request per canonical target.
WITH ranked AS (
  SELECT id, "tenantId", status,
         row_number() OVER (
           PARTITION BY "tenantId", "targetJournalEntryId"
           ORDER BY CASE WHEN status = 'APPLIED' THEN 0 ELSE 1 END,
                    "createdAt" ASC, id ASC
         ) AS duplicate_rank
  FROM public.financial_adjustment_requests
  WHERE status IN ('PENDING_APPROVAL', 'APPLIED')
)
UPDATE public.financial_adjustment_requests AS request
SET status = 'FAILED',
    "failureReason" = COALESCE(request."failureReason", 'Superseded during canonical-target uniqueness migration'),
    "decidedAt" = COALESCE(request."decidedAt", now()),
    "updatedAt" = now()
FROM ranked
WHERE request.id = ranked.id
  AND request."tenantId" = ranked."tenantId"
  AND ranked.duplicate_rank > 1
  AND ranked.status = 'PENDING_APPROVAL';

DROP INDEX IF EXISTS public.financial_adjustment_requests_one_active_target_key;
CREATE UNIQUE INDEX financial_adjustment_requests_one_active_canonical_target_key
  ON public.financial_adjustment_requests("tenantId", "targetJournalEntryId")
  WHERE status = 'PENDING_APPROVAL';
