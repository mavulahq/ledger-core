-- Match the declarative Prisma index: Prisma does not represent this partial index
-- in the schema model, so keep the database definition non-partial as well.
DROP INDEX IF EXISTS public.financial_transactions_tenant_posted_loan_idx;
CREATE INDEX financial_transactions_tenant_posted_loan_idx
  ON public.financial_transactions("tenantId", "loanId", "postedAt", id);
