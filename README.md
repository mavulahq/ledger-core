# MAVULA Ledger Core

`@mavula/ledger-core` is the financial source of truth for MAVULA.

Legacy alias: `fengine`.

## Responsibilities

- Tenant products, accounts, loans, rules, schemas and workflows.
- Idempotent financial transactions and double-entry ledger posting.
- PostgreSQL persistence, Redis job publishing, audit trails, health and metrics.
- Transactional Outbox/Inbox and read projections for active domain events.
- Controlled account lifecycle with maker-checker approval and an immutable,
  journal-backed customer-account subledger.

## Account lifecycle

Accounts open in `ACTIVE` state with a zero balance and an enabled account
product. Balance and statement data come from append-only `account_entries`
written in the same transaction as the corresponding journal entry.

`POST /api/accounts/:accountId/status-transitions` submits `FREEZE`, `UNFREEZE`
or `CLOSE` for approval. A different operator with `finance.approve` decides the
request through `/api/account-lifecycle-requests/:requestId/approve` or
`/reject`. Frozen accounts reject debits and closed accounts reject new
postings.

## Development

```bash
pnpm --filter @mavula/ledger-core build
pnpm --filter @mavula/ledger-core test:all
pnpm --filter @mavula/ledger-core test:rls
```

Runtime uses `DATABASE_URL` with the non-bypass `ledger_core_app` role. Schema
migrations require `LEDGER_CORE_MIGRATION_DATABASE_URL`; provisioning the
runtime login additionally requires `LEDGER_CORE_DATABASE_ROLE_PASSWORD`.
Adopting the baseline for an existing database is a one-time explicit action
with `LEDGER_CORE_ACCEPT_BASELINE=true` after drift verification.

The service defaults to port `3000` and exposes `GET /api/health` and
`GET /api/metrics`.

License: AGPL-3.0-only.
