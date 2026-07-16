ALTER TABLE public.financial_transactions
  ADD COLUMN "adjustmentRequestId" text,
  ADD COLUMN "reversalOfTransactionId" text,
  ADD COLUMN "correctionOfTransactionId" text;

CREATE INDEX financial_transactions_tenant_adjustment_idx
  ON public.financial_transactions("tenantId", "adjustmentRequestId");
CREATE INDEX financial_transactions_tenant_reversal_idx
  ON public.financial_transactions("tenantId", "reversalOfTransactionId");
CREATE INDEX financial_transactions_tenant_correction_idx
  ON public.financial_transactions("tenantId", "correctionOfTransactionId");

ALTER TABLE public.journal_entries
  ADD COLUMN "adjustmentRequestId" text,
  ADD COLUMN "reversalOfEntryId" text,
  ADD COLUMN "correctionOfEntryId" text;

CREATE INDEX journal_entries_tenant_adjustment_idx
  ON public.journal_entries("tenantId", "adjustmentRequestId");
CREATE INDEX journal_entries_tenant_reversal_idx
  ON public.journal_entries("tenantId", "reversalOfEntryId");
CREATE INDEX journal_entries_tenant_correction_idx
  ON public.journal_entries("tenantId", "correctionOfEntryId");

CREATE TABLE public.financial_adjustment_requests (
  id text NOT NULL,
  "tenantId" text NOT NULL,
  "targetType" text NOT NULL,
  "targetId" text NOT NULL,
  "adjustmentType" text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL',
  reason text NOT NULL,
  correction jsonb,
  "targetTransactionId" text,
  "targetJournalEntryId" text NOT NULL,
  "targetLoanId" text,
  "expectedLoanVersion" integer,
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
  "reversalTransactionId" text,
  "reversalJournalEntryId" text,
  "replacementTransactionId" text,
  "replacementJournalEntryId" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT financial_adjustment_requests_pkey PRIMARY KEY (id),
  CONSTRAINT financial_adjustment_requests_tenant_fkey
    FOREIGN KEY ("tenantId") REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT financial_adjustment_requests_target_type_check
    CHECK ("targetType" IN ('TRANSACTION', 'JOURNAL_ENTRY')),
  CONSTRAINT financial_adjustment_requests_type_check
    CHECK ("adjustmentType" IN ('REVERSAL', 'CORRECTION')),
  CONSTRAINT financial_adjustment_requests_status_check
    CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'FAILED')),
  CONSTRAINT financial_adjustment_requests_reason_check
    CHECK (length(reason) BETWEEN 1 AND 500),
  CONSTRAINT financial_adjustment_requests_correction_check
    CHECK (("adjustmentType" = 'CORRECTION' AND correction IS NOT NULL)
      OR ("adjustmentType" = 'REVERSAL' AND correction IS NULL))
);

CREATE UNIQUE INDEX financial_adjustment_requests_tenant_id_key
  ON public.financial_adjustment_requests("tenantId", id);
CREATE UNIQUE INDEX financial_adjustment_requests_one_active_target_key
  ON public.financial_adjustment_requests("tenantId", "targetType", "targetId")
  WHERE status IN ('PENDING_APPROVAL', 'APPLIED');
CREATE INDEX financial_adjustment_requests_tenant_status_created_idx
  ON public.financial_adjustment_requests("tenantId", status, "createdAt" DESC);
CREATE INDEX financial_adjustment_requests_tenant_target_created_idx
  ON public.financial_adjustment_requests("tenantId", "targetType", "targetId", "createdAt" DESC);
CREATE INDEX financial_adjustment_requests_tenant_transaction_idx
  ON public.financial_adjustment_requests("tenantId", "targetTransactionId");
CREATE INDEX financial_adjustment_requests_tenant_journal_idx
  ON public.financial_adjustment_requests("tenantId", "targetJournalEntryId");
CREATE INDEX financial_adjustment_requests_tenant_loan_idx
  ON public.financial_adjustment_requests("tenantId", "targetLoanId");

ALTER TABLE public.financial_adjustment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_adjustment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.financial_adjustment_requests TO ledger_core_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

ALTER TABLE public.account_entries DROP CONSTRAINT account_entries_type_check;
ALTER TABLE public.account_entries ADD CONSTRAINT account_entries_type_check
  CHECK ("entryType" IN ('OPENING_BALANCE', 'POSTING', 'REVERSAL', 'CORRECTION'));

ALTER TABLE public.audit_trail_events
  ADD COLUMN stage text,
  ADD COLUMN result text,
  ADD COLUMN source text,
  ADD COLUMN "actorRoles" jsonb,
  ADD COLUMN "institutionId" text,
  ADD COLUMN "branchId" text,
  ADD COLUMN reason text,
  ADD COLUMN "correlationId" text,
  ADD COLUMN "causationId" text,
  ADD COLUMN "approvalReference" text,
  ADD CONSTRAINT audit_trail_events_stage_check CHECK (
    stage IS NULL OR stage IN (
      'REQUESTED', 'VALIDATED', 'EVALUATED', 'AUTHORIZED',
      'POSTED', 'CONFIGURED', 'DISPATCHED'
    )
  ),
  ADD CONSTRAINT audit_trail_events_result_check CHECK (
    result IS NULL OR result IN ('PENDING', 'SUCCEEDED', 'REJECTED', 'FAILED', 'REVERSED')
  ),
  ADD CONSTRAINT audit_trail_events_source_check CHECK (
    source IS NULL OR source IN ('API', 'WORKER', 'SYSTEM')
  );

CREATE INDEX audit_trail_events_tenant_stage_created_idx
  ON public.audit_trail_events("tenantId", stage, "createdAt" DESC);
CREATE INDEX audit_trail_events_tenant_correlation_idx
  ON public.audit_trail_events("tenantId", "correlationId");

GRANT SELECT, INSERT, UPDATE ON public.financial_adjustment_requests TO ledger_core_app;
REVOKE DELETE ON public.financial_adjustment_requests FROM ledger_core_app;
REVOKE DELETE ON public.financial_transactions FROM ledger_core_app;
REVOKE DELETE ON public.journal_entries FROM ledger_core_app;
REVOKE UPDATE, DELETE ON public.audit_trail_events FROM ledger_core_app;
GRANT SELECT, INSERT ON public.audit_trail_events TO ledger_core_app;
