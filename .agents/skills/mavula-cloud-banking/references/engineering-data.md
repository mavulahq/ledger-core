# Engineering And Data Standards

## TypeScript And Node.js

- Preserve strict public types, validated DTOs, async error propagation, bounded
  concurrency, graceful shutdown, ESM/CJS compatibility, and workspace build order.
- NestJS scopes and guards must not leak request identity. Prisma client/schema/
  migration changes move together. BullMQ handlers are idempotent and lease-aware.

## Go

- Propagate `context.Context`, cancellation, deadlines, trace context, and tenant
  authority through every boundary. Bound goroutines and channels; prove race safety.
- Wrap errors without losing classification. Use explicit interfaces, SQL
  transactions, pool limits, deterministic clocks, and table-driven tests.

## Java

- Define Spring transaction boundaries, isolation, propagation, exception mapping,
  bean scope, thread safety, pool limits, timeouts, and serialization compatibility.
- Avoid hidden lazy-loading, broad transactions, reflection-based configuration,
  and retries around non-idempotent effects. Use contract and concurrency tests.

## COBOL

- Treat copybooks and fixed-width layouts as versioned wire contracts. Verify
  encoding, exact offsets, `PIC` precision/scale, signs, packed decimal, overflow,
  rounding, header/detail/trailer totals, checksums, and golden files.
- Batch execution is restartable from durable checkpoints. Duplicate input,
  partial output, invalid trailer, and resume never duplicate financial effects.

## Python

- Require typed boundaries, reproducible packaging, parameterized SQL, deterministic
  timezone and decimal handling, explicit resource cleanup, isolated tests, and
  bounded memory for reporting or batch workloads.

## PostgreSQL

- Apply tenant RLS inside the same transaction and pooled connection as every
  protected query. Runtime roles do not bypass RLS or own schemas.
- Keep financial effects, durable idempotency receipt, audit, and Outbox atomic.
  Use constraints as invariants, indexes from measured queries, and online-safe
  migrations with lock analysis, compatibility order, and recovery procedure.
- Test concurrent duplicate requests, deadlocks, serialization conflicts, pooled
  connection reuse, cross-tenant access, rollback, and migration from real baselines.

## Redis And Queues

- Redis never becomes financial or identity truth. Namespace by environment and
  tenant where applicable; define TTL, eviction, memory, and failover behavior.
- Jobs carry minimal authorized context, stable idempotency identity, correlation,
  bounded retry/backoff, lease timeout, DLQ reason, replay policy, and metrics.

Go and Java standards are ready for RFC-0003 modules but do not assign ownership
or justify migration by language preference alone. Choose language from workload,
correctness, interoperability, operational maturity, and team support evidence.
