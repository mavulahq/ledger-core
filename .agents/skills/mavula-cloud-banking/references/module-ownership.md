# Module Ownership

## Authority

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `finance-platform` | Cross-module contracts, policy, submodule revisions, master guardian | Runtime financial or identity state |
| `identity-access` | Institutions, branches, operators, credentials, sessions, memberships, roles, OAuth/OIDC policy | Ledger accounts, payment state, job state |
| `ledger-core` | Tenant financial binding, products, accounts, journals, lending, financial workflows, audit, projections | Credentials, provider settlement state, queue truth |
| `settlements` | Payment processes, provider callbacks, dedupe, reconciliation, settlement Outbox | Journal posting, lending balances, operator identity |
| `workbench` | Jobs, schedules, attempts, leases, DLQ, publisher execution, platform status | Financial aggregates, provider state, identity policy |
| `legacy-connectors` | Copybooks, fixed-width layouts, batch receipts, artifacts, deterministic translation | Direct Identity or Ledger stores, financial mutation |
| `operations` | Kubernetes, AWS adapters, secrets wiring, migrations, backups, monitoring | Business aggregates or domain policy |
| `developer-docs` | Approved public contracts, integration guides, examples, provenance locks | Owner contract invention or private endpoint publication |

## Integration Rules

- Integrate through an owner API, authorized command, active event, or approved
  versioned file contract. Never share or write another owner's tables.
- Commands carry authenticated tenant, actor, correlation, and idempotency
  context. Events carry immutable facts and jobs carry operational work.
- Events use at-least-once delivery. Consumers dedupe persistently before effects.
- Read projections are rebuildable and eventually consistent. They are forbidden
  for posting, balance mutation, lending approval, allocation, or settlement
  decisions requiring current owner state.
- Cross-owner changes require producer and consumer compatibility tests,
  explicit migration order, observability, and a rollback or forward-fix path.
- Ownership changes require an ADR, data migration, compatibility window, and
  accountable approval. A folder move does not transfer authority.
