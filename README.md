# fengine

`fengine` is the configurable financial core of Fluxo, the Banking as a Service (BaaS) platform by getfluxo.io.

## Responsibilities

- Tenant products, accounts, loans, rules, schemas, and workflows.
- Idempotent financial transactions and double-entry ledger posting.
- PostgreSQL persistence, Redis job publishing, audit trails, health, and metrics.

## Development

Use Node.js `22.22.3`, pnpm `10.33.0`, PostgreSQL, and Redis. Run commands from the root of the `getfluxo` workspace:

```bash
pnpm install --frozen-lockfile
pnpm --filter @getfluxo/fengine build
pnpm --filter @getfluxo/fengine test:all
```

Copy the values described in `.env.example` into your local environment. The service defaults to port `3000` and exposes `GET /api/health` and `GET /api/metrics`.

## Repository

The canonical workspace is `git@github.com:getfluxo-io/getfluxo.git`.

Copyright (c) 2026 getfluxo.io. Proprietary software. See `LICENSE`.
