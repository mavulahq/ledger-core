ALTER TABLE public.accounts
  ADD COLUMN "customerId" text,
  ADD COLUMN "productId" text,
  ADD COLUMN "currency" text NOT NULL DEFAULT 'MZN',
  ADD COLUMN "status" text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "createdBy" text,
  ADD COLUMN "frozenAt" timestamp(3),
  ADD COLUMN "frozenBy" text,
  ADD COLUMN "freezeReason" text,
  ADD COLUMN "closedAt" timestamp(3),
  ADD COLUMN "closedBy" text,
  ADD COLUMN "closeReason" text,
  ADD COLUMN "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_status_check
    CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  ADD CONSTRAINT accounts_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT accounts_tenant_product_fkey
    FOREIGN KEY ("tenantId", "productId")
    REFERENCES public.products("tenantId", id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX accounts_tenantId_id_key
  ON public.accounts("tenantId", id);
CREATE INDEX accounts_tenantId_customerId_idx
  ON public.accounts("tenantId", "customerId");
CREATE INDEX accounts_tenantId_productId_idx
  ON public.accounts("tenantId", "productId");
CREATE INDEX accounts_tenantId_status_idx
  ON public.accounts("tenantId", status);

CREATE TABLE public.account_entries (
  id text NOT NULL,
  "tenantId" text NOT NULL,
  "accountId" text NOT NULL,
  "journalEntryId" text,
  "transactionId" text,
  "postingKey" text NOT NULL,
  "entryType" text NOT NULL,
  direction text NOT NULL,
  amount numeric(65,30) NOT NULL,
  currency text NOT NULL,
  "balanceAfter" numeric(65,30) NOT NULL,
  reference text,
  "createdBy" text NOT NULL,
  "postedAt" timestamp(3) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_entries_pkey PRIMARY KEY (id),
  CONSTRAINT account_entries_tenant_fkey
    FOREIGN KEY ("tenantId") REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT account_entries_account_fkey
    FOREIGN KEY ("tenantId", "accountId")
    REFERENCES public.accounts("tenantId", id) ON DELETE CASCADE,
  CONSTRAINT account_entries_journal_fkey
    FOREIGN KEY ("tenantId", "journalEntryId")
    REFERENCES public.journal_entries("tenantId", id) ON DELETE RESTRICT,
  CONSTRAINT account_entries_type_check
    CHECK ("entryType" IN ('OPENING_BALANCE', 'POSTING')),
  CONSTRAINT account_entries_direction_check
    CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT account_entries_amount_check
    CHECK (amount > 0),
  CONSTRAINT account_entries_currency_check
    CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX account_entries_tenantId_id_key
  ON public.account_entries("tenantId", id);
CREATE UNIQUE INDEX account_entries_tenantId_postingKey_key
  ON public.account_entries("tenantId", "postingKey");
CREATE INDEX account_entries_tenantId_accountId_postedAt_id_idx
  ON public.account_entries("tenantId", "accountId", "postedAt" DESC, id DESC);
CREATE INDEX account_entries_tenantId_journalEntryId_idx
  ON public.account_entries("tenantId", "journalEntryId");
CREATE INDEX account_entries_tenantId_transactionId_idx
  ON public.account_entries("tenantId", "transactionId");

INSERT INTO public.account_entries (
  id, "tenantId", "accountId", "postingKey", "entryType", direction,
  amount, currency, "balanceAfter", reference, "createdBy", "postedAt"
)
SELECT
  'opening_' || md5(account."tenantId" || ':' || account.id),
  account."tenantId",
  account.id,
  'migration:opening:' || account.id,
  'OPENING_BALANCE',
  CASE WHEN account.balance < 0 THEN 'DEBIT' ELSE 'CREDIT' END,
  abs(account.balance),
  account.currency,
  account.balance,
  'LEGACY_OPENING_BALANCE',
  'MIGRATION',
  account."createdAt"
FROM public.accounts AS account
WHERE account.balance <> 0;

CREATE TABLE public.account_lifecycle_requests (
  id text NOT NULL,
  "tenantId" text NOT NULL,
  "accountId" text NOT NULL,
  transition text NOT NULL,
  "fromStatus" text NOT NULL,
  "targetStatus" text NOT NULL,
  "expectedAccountVersion" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL',
  reason text NOT NULL,
  "requestedBy" text NOT NULL,
  "requestedRoles" jsonb NOT NULL,
  "institutionId" text NOT NULL,
  "branchId" text,
  "correlationId" text NOT NULL,
  "decidedBy" text,
  "decisionReason" text,
  "decidedAt" timestamp(3),
  "appliedAt" timestamp(3),
  "failureReason" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_lifecycle_requests_pkey PRIMARY KEY (id),
  CONSTRAINT account_lifecycle_requests_tenant_fkey
    FOREIGN KEY ("tenantId") REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT account_lifecycle_requests_account_fkey
    FOREIGN KEY ("tenantId", "accountId")
    REFERENCES public.accounts("tenantId", id) ON DELETE CASCADE,
  CONSTRAINT account_lifecycle_requests_transition_check
    CHECK (transition IN ('FREEZE', 'UNFREEZE', 'CLOSE')),
  CONSTRAINT account_lifecycle_requests_status_check
    CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'FAILED')),
  CONSTRAINT account_lifecycle_requests_from_status_check
    CHECK ("fromStatus" IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  CONSTRAINT account_lifecycle_requests_target_status_check
    CHECK ("targetStatus" IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  CONSTRAINT account_lifecycle_requests_reason_check
    CHECK (length(reason) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX account_lifecycle_requests_tenantId_id_key
  ON public.account_lifecycle_requests("tenantId", id);
CREATE UNIQUE INDEX account_lifecycle_requests_one_pending_per_account_key
  ON public.account_lifecycle_requests("tenantId", "accountId")
  WHERE status = 'PENDING_APPROVAL';
CREATE INDEX account_lifecycle_requests_tenantId_status_createdAt_idx
  ON public.account_lifecycle_requests("tenantId", status, "createdAt" DESC);
CREATE INDEX account_lifecycle_requests_tenantId_accountId_createdAt_idx
  ON public.account_lifecycle_requests("tenantId", "accountId", "createdAt" DESC);

ALTER TABLE public.account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.account_entries TO ledger_core_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

ALTER TABLE public.account_lifecycle_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_lifecycle_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.account_lifecycle_requests TO ledger_core_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

GRANT SELECT, INSERT ON public.account_entries TO ledger_core_app;
REVOKE UPDATE, DELETE ON public.account_entries FROM ledger_core_app;
REVOKE DELETE ON public.accounts FROM ledger_core_app;
GRANT SELECT, INSERT, UPDATE ON public.account_lifecycle_requests TO ledger_core_app;
REVOKE DELETE ON public.account_lifecycle_requests FROM ledger_core_app;
