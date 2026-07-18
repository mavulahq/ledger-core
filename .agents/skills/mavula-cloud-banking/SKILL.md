---
name: mavula-cloud-banking
description: Design, implement, operate, and assess MAVULA as regulated cloud-native banking infrastructure. Use for real institutional workflows, module boundaries, financial operations, identity, payments, compliance, configurable and no-code products, composable APIs and events, production security, Kubernetes and AWS operations, resilience, observability, capacity, and high-scale readiness across all MAVULA repositories.
---

# MAVULA Cloud Banking

Use this skill for engineering work that can affect institutional access,
financial state, payment state, regulatory evidence, runtime reliability, or
platform configuration. Ground every decision in repository contracts and
observable failure behavior.

## Workflow

1. Read the context map, invariants, touched contracts, migrations, runtime code,
   tests, and deployment configuration. Distinguish implemented behavior from
   roadmap intent.
2. Name the owner, caller, data classification, tenant boundary, financial
   effect, consistency requirement, idempotency identity, audit evidence, and
   recovery path.
3. Trace the full operation across synchronous APIs, owner transaction,
   Outbox/Inbox, Workbench jobs, projections, monitoring, and operator action.
4. Define compatibility and failure behavior before implementation: timeout,
   duplicate, reordering, partial failure, retry exhaustion, replay, rollback,
   and reconciliation.
5. Quantify production assumptions per service: SLO, workload, peak concurrency,
   data growth, RTO/RPO, failure domains, and capacity-test evidence.
6. Implement within the owner boundary using the repository's established
   language, database, contract, migration, and guardian patterns.
7. Verify invariant tests, contract tests, security boundaries, failure paths,
   observability, operational recovery, and CI-equivalent checks.

## Hard Rules

- Identity context is signed and authoritative. Payload identity never grants
  tenant, institution, branch, role, or permission.
- `ledger-core` alone owns financial invariants and journal posting. Posted
  records are immutable; correction uses controlled reversal or adjustment.
- `settlements` owns external payment state. A settlement event does not mutate
  ledger or lending directly; an authorized ledger command is required.
- `workbench` owns operational jobs, not business truth. Retry is bounded and
  every side effect is idempotent and auditable.
- PostgreSQL and owner aggregates are authoritative. Redis is transport and
  temporary operational state.
- Public APIs and events are versioned contracts. Consumers never depend on
  producer tables, private DTOs, or deployment internals.
- Configuration is declarative, tenant-scoped, versioned, validated, bounded,
  approved where required, and immutable after publication.
- Production claims require measured evidence. Regulatory and certification
  claims require explicit scope and accountable approval.

## References

- Module authority and allowed integration: `references/module-ownership.md`.
- Real institutional workflows and failure paths: `references/banking-operations.md`.
- Security, data protection, and regulatory baseline: `references/security-regulation.md`.
- Kubernetes, AWS, resilience, observability, and capacity: `references/cloud-native-scale.md`.
- API composability and governed no-code configuration: `references/composability-no-code.md`.
- Language, PostgreSQL, Redis, and COBOL rules: `references/engineering-data.md`.

Load only the references relevant to the task. For reviews, use the companion
`mavula-review` skill so findings retain MAVULA severity and evidence format.
