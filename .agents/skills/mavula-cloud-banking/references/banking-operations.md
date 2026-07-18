# Banking Operations

## Institutional Access

1. `identity-access` authenticates the operator or workload and derives effective
   institution, branch, tenant, roles, and permissions from persisted state.
2. Resource servers validate issuer, audience, signature, expiry, token purpose,
   tenant binding, and operation permission before reading request data.
3. Sensitive actions record actor, effective role, source, correlation, result,
   and maker-checker evidence without placing credentials or unnecessary PII in events.

## Product And Workflow Configuration

1. An authorized configuration operator submits a schema-valid tenant-scoped draft.
2. The owner validates references, deterministic rules, limits, effective dates,
   and approval policy before activation.
3. Publication creates an immutable version and audit record. Runtime operations
   retain the exact product, rule, schema, and workflow versions used.
4. Rollback activates a known compatible version; it never mutates history.

## Accounts, Ledger, And Lending

1. Every write requires authenticated tenant context, correlation, and durable
   idempotency when it can create a financial or external side effect.
2. The owner validates account/product state, currency, precision, limits,
   maker-checker, and later-effect constraints inside one transaction.
3. Journal lines balance by currency. Subledger, audit, receipt, and Outbox are
   committed atomically with the owner state.
4. Freeze, unfreeze, close, reversal, and correction preserve immutable history;
   self-approval and duplicate approval are rejected.

## Payments And Reconciliation

1. Workbench starts an authorized payment job with tenant, correlation, amount,
   rail, parties, and idempotency identity.
2. Settlements persists the process before external interaction and authenticates
   callbacks before durable dedupe and explicit state transition.
3. Reconciliation compares provider, process, and expected ledger references.
   Mismatch remains actionable and cannot be hidden by job success.
4. Settlement completion is recorded in Outbox and published by Workbench.
   Ledger Core records Inbox idempotently and performs no direct financial
   mutation from the event.

## Regulatory And Legacy Processing

1. An authorized compliance operator requests an export with period, legal basis,
   retention, tenant, and idempotency context.
2. Ledger Core provides the approved source contract; Legacy Connectors generates
   deterministic fixed-width content, totals, checksum, receipt, and artifact.
3. Workbench controls leases, bounded retries, DLQ, and delivery recording.
   Imports remain staging and validation only unless a future owner command is approved.

## Incident And Recovery

- Diagnose owner state separately from queue state. A completed job does not prove
  a completed business operation.
- Replay requires authorization, reason, original correlation, dedupe, and audit.
- Recovery verifies database consistency, Outbox/Inbox backlog, queue lag, DLQ,
  settlement reconciliation, projection freshness, and regulatory artifact integrity.
