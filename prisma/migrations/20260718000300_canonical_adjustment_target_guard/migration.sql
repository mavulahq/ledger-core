CREATE OR REPLACE FUNCTION public.enforce_single_adjustment_per_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('PENDING_APPROVAL', 'APPLIED') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW."tenantId" || ':' || NEW."targetJournalEntryId", 0)
    );

    IF EXISTS (
      SELECT 1
      FROM public.financial_adjustment_requests AS existing
      WHERE existing."tenantId" = NEW."tenantId"
        AND existing."targetJournalEntryId" = NEW."targetJournalEntryId"
        AND existing.status IN ('PENDING_APPROVAL', 'APPLIED')
        AND existing.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'Financial journal entry already has an active or applied adjustment'
        USING ERRCODE = '23505',
              CONSTRAINT = 'financial_adjustment_requests_one_active_canonical_target_key';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_single_adjustment_per_journal_entry() FROM PUBLIC;

CREATE TRIGGER financial_adjustment_requests_canonical_target_guard
BEFORE INSERT OR UPDATE OF "tenantId", "targetJournalEntryId", status
ON public.financial_adjustment_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_single_adjustment_per_journal_entry();
