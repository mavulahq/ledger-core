# Composability And Governed No-Code

## Composable Boundaries

- Expose capabilities through owner-controlled, versioned APIs, commands, events,
  and file contracts with explicit schemas, permissions, errors, and idempotency.
- Prefer additive evolution. Breaking changes require a new version, migration
  window, consumer inventory, compatibility tests, and deprecation evidence.
- Keep provider, cloud, channel, and legacy specifics behind adapters. Domain
  modules depend on stable ports and business contracts, not vendor SDK objects.
- Use correlation and causation across boundaries. Do not leak database models,
  internal enums, queue payloads, secrets, or unnecessary PII into public contracts.
- SDKs and Developer Docs are generated or verified against owner contracts and
  provenance locks. Documentation cannot redefine owner behavior.

## Configuration Lifecycle

1. Create a tenant-scoped draft from an approved schema.
2. Validate syntax, types, references, permissions, limits, effective dates,
   compatibility, and deterministic evaluation before persistence.
3. Preview or dry-run with synthetic or authorized data and no external side effects.
4. Require maker-checker for configurations that can change financial behavior,
   access, settlement routing, compliance output, or external communication.
5. Publish an immutable version with actor, reason, correlation, content digest,
   approval, and effective window.
6. Activate atomically. Running operations retain the exact version they used.
7. Roll back by activating a compatible prior version; never rewrite history.

## Runtime Safety

- Prohibit `eval`, `new Function`, arbitrary scripts, unrestricted templates,
  dynamic SQL, filesystem/network access, and reflection-based class loading.
- Use an allowlisted expression or decision runtime with typed inputs/outputs,
  deterministic time and rounding, complexity limits, execution timeout, memory
  budget, recursion limit, and side-effect isolation.
- Validate money precision, currency, timezone, calendars, rate boundaries,
  fee ordering, rule conflicts, workflow cycles, and unreachable states.
- Enforce authorization and tenant context during authoring, approval, activation,
  execution, export, and rollback. A UI is not a security boundary.

## No-Code Meaning

For MAVULA, no-code means governed declarative products, rules, schemas, and
workflows. It does not mean arbitrary user code, direct database editing, or
unreviewed production activation. A future visual builder must emit the same
versioned contracts and pass the same validation and approval pipeline.
