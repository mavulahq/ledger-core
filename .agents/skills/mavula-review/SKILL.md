---
name: mavula-review
description: Review MAVULA changes across finance-platform, identity-access, ledger-core, workbench, settlements, operations, legacy-connectors, and developer-docs. Use for pull request, security, database, migration, contract, cloud-native, scalability, no-code configuration, and production-readiness reviews in TypeScript, Go, Java, COBOL, Python, PostgreSQL, Redis, Kubernetes, AWS, and CI/CD.
---

# MAVULA Review

Use this skill to review MAVULA changes against the platform's financial,
security, regulatory, and operational invariants. Findings require a concrete
failure mode and evidence; labels such as secure, compliant, cloud-native, or
scalable are never accepted without proof.

## Required Context

Read the relevant references from the companion skill before reviewing:

- Ownership or cross-module changes: `../mavula-cloud-banking/references/module-ownership.md`.
- User or operator workflows: `../mavula-cloud-banking/references/banking-operations.md`.
- Authentication, authorization, data, AML, or regulatory changes: `../mavula-cloud-banking/references/security-regulation.md`.
- Deployments, queues, performance, availability, or production claims: `../mavula-cloud-banking/references/cloud-native-scale.md`.
- Product, rule, schema, workflow, or no-code changes: `../mavula-cloud-banking/references/composability-no-code.md`.
- Language, PostgreSQL, Redis, or batch changes: `../mavula-cloud-banking/references/engineering-data.md`.

## Review Workflow

1. Read the diff, surrounding code, tests, contracts, migrations, and CI configuration touched by the change.
2. Trace the complete operation from authenticated entry to owner transaction,
   emitted contract, asynchronous processing, audit evidence, and recovery path.
3. Verify ownership, tenant isolation, financial invariants, compatibility,
   failure handling, operability, capacity evidence, and regulatory applicability.
4. Confirm the smallest test set that proves the behavior, then run broader
   guardian and CI-equivalent checks when the change crosses boundaries.
5. Report actionable findings only. Do not replace evidence with architecture
   preference, praise, phase narration, or speculative rewrites.

## Findings

Lead with findings, ordered by severity.

Use this shape:

```text
[P1] Short imperative title
path/to/file.ext:line
Impact: concrete failure mode.
Fix: concrete change required.
Verification: command or test that should cover it.
```

Severity guide:

- `P0`: exploitable security issue, cross-tenant disclosure, data loss, financial invariant break, or production-wide outage.
- `P1`: build/CI break, incorrect money movement, authorization bypass, unsafe migration, broken recovery, or production deploy blocker.
- `P2`: realistic runtime bug, replay/idempotency issue, race, capacity risk, observability gap, contract drift, or missing required test.
- `P3`: maintainability issue with concrete future cost.

If there are no findings, say so directly and list residual risk or unrun validation.

## Language

Use the language already used in the pull request, issue, or discussion. If the thread is Portuguese, write formal Portuguese. If the thread is English or mixed technical code review, use concise professional English.

Avoid marketing claims, decorative status symbols, phase narration, and long background explanations in review comments.

## Non-Negotiable Review Gates

- Reject tenant, institution, branch, role, or permission authority derived from
  request payloads instead of verified identity context.
- Reject floating-point money, unbalanced journals, mutable posted entries,
  self-approval, non-atomic audit, or duplicate effects for one idempotency key.
- Reject direct writes to another module's store and jobs or projections used as
  the source of truth for command-side financial decisions.
- Reject webhook effects without signature validation, replay protection,
  durable dedupe, explicit transitions, and reconciliation.
- Reject `eval`, `new Function`, mutable published configuration, or unbounded
  expressions in configurable and no-code runtimes.
- Reject exactly-once assumptions. Require bounded retry, idempotent handlers,
  poison-message handling, DLQ policy, authorized replay, and correlation.
- Reject production-ready or scalable claims without quantified service SLO,
  workload, data growth, RTO/RPO, failure-domain, and capacity-test evidence.
- Reject compliance or certification claims without scope, control evidence,
  responsible approval, and legal validation when required.
- Never expose credentials, tokens, private keys, customer data, or untracked
  `.env` content in code or review output.

## Validation Expectations

Prefer the smallest validation set that proves the change. For this repository family, common checks include:

```bash
pnpm guardian:check
pnpm contracts:check
pnpm -r build
git diff --check
```

For module changes, run the module guardian and targeted tests first. For
cross-repository changes, validate owner contracts, consumer compatibility,
master guardian, and initialized submodule parity.

## Agent Behavior

Do not approve your own change. Do not bypass branch protection unless an
authorized repository owner explicitly requests a narrowly scoped exception for
a concrete blocked merge. Checks and conversation resolution remain mandatory.

When reviewing a pull request, keep the output review-shaped: findings first, then open questions, then validation notes. When implementing a fix, keep edits scoped to the issue, preserve unrelated local work, and update tests or guardian rules when the risk justifies it.
