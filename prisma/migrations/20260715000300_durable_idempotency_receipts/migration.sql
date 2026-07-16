CREATE TABLE public.idempotency_receipts (
  id text NOT NULL,
  "tenantId" text NOT NULL,
  operation text NOT NULL,
  "keyDigest" text NOT NULL,
  "requestHash" text NOT NULL,
  "actorId" text NOT NULL,
  "correlationId" text,
  "httpStatus" integer NOT NULL,
  "responseBody" jsonb NOT NULL,
  "completedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" timestamp(3) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT idempotency_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT idempotency_receipts_tenant_fkey
    FOREIGN KEY ("tenantId") REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT idempotency_receipts_operation_check
    CHECK (operation ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  CONSTRAINT idempotency_receipts_key_digest_check
    CHECK ("keyDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT idempotency_receipts_request_hash_check
    CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT idempotency_receipts_http_status_check
    CHECK ("httpStatus" BETWEEN 200 AND 299),
  CONSTRAINT idempotency_receipts_expiry_check
    CHECK ("expiresAt" > "completedAt")
);

CREATE UNIQUE INDEX idempotency_receipts_tenant_operation_key_key
  ON public.idempotency_receipts("tenantId", operation, "keyDigest");
CREATE INDEX idempotency_receipts_expires_at_idx
  ON public.idempotency_receipts("expiresAt");
CREATE INDEX idempotency_receipts_tenant_completed_at_idx
  ON public.idempotency_receipts("tenantId", "completedAt" DESC);

ALTER TABLE public.idempotency_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.idempotency_receipts TO ledger_core_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

GRANT SELECT, INSERT ON public.idempotency_receipts TO ledger_core_app;
REVOKE UPDATE, DELETE ON public.idempotency_receipts FROM ledger_core_app;

CREATE OR REPLACE FUNCTION public.cleanup_expired_idempotency_receipts(batch_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF batch_limit < 1 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 5000';
  END IF;

  WITH expired AS (
    SELECT id
    FROM public.idempotency_receipts
    WHERE "expiresAt" <= clock_timestamp()
    ORDER BY "expiresAt", id
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.idempotency_receipts AS receipt
  USING expired
  WHERE receipt.id = expired.id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.idempotency_receipt_status_totals()
RETURNS TABLE(active bigint, expired bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*) FILTER (WHERE "expiresAt" > CURRENT_TIMESTAMP) AS active,
    count(*) FILTER (WHERE "expiresAt" <= CURRENT_TIMESTAMP) AS expired
  FROM public.idempotency_receipts;
$$;

CREATE OR REPLACE FUNCTION public.delete_expired_idempotency_receipt(
  requested_tenant_id text,
  requested_operation text,
  requested_key_digest text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM public.current_tenant_id() THEN
    RAISE EXCEPTION 'tenant context does not match expired receipt request';
  END IF;
  DELETE FROM public.idempotency_receipts
  WHERE "tenantId" = requested_tenant_id
    AND operation = requested_operation
    AND "keyDigest" = requested_key_digest
    AND "expiresAt" <= clock_timestamp();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_idempotency_receipts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idempotency_receipt_status_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_expired_idempotency_receipt(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_idempotency_receipts(integer) TO ledger_core_app;
GRANT EXECUTE ON FUNCTION public.idempotency_receipt_status_totals() TO ledger_core_app;
GRANT EXECUTE ON FUNCTION public.delete_expired_idempotency_receipt(text, text, text) TO ledger_core_app;
