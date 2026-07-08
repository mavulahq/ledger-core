# MAVULA Ledger Core

`@mavula/ledger-core` is the financial source of truth for MAVULA.

Legacy alias: `fengine`.

## Responsibilities

- Tenant products, accounts, loans, rules, schemas and workflows.
- Idempotent financial transactions and double-entry ledger posting.
- PostgreSQL persistence, Redis job publishing, audit trails, health and metrics.
- Transactional Outbox/Inbox and read projections for active domain events.

## Development

```bash
pnpm --filter @mavula/ledger-core build
pnpm --filter @mavula/ledger-core test:all
```

The service defaults to port `3000` and exposes `GET /api/health` and
`GET /api/metrics`.

License: AGPL-3.0-only.
