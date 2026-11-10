-- Add a covering index for the regulatory export / list queries that paginate by
-- tenant, status, and created timestamp while filtering by loan-linked effects.
CREATE INDEX IF NOT EXISTS financial_transactions_tenant_status_posted_created_idx
  ON public.financial_transactions("tenantId", status, "postedAt", id);

CREATE INDEX IF NOT EXISTS financial_transactions_tenant_posted_loan_idx
  ON public.financial_transactions("tenantId", "loanId", "postedAt", id)
  WHERE "loanId" IS NOT NULL;
