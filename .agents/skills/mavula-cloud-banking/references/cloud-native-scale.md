# Cloud-Native Scale

## Service Readiness Budget

Every production service or material change must document:

- availability and latency SLOs with measured indicators and error-budget owner;
- normal, peak, burst, and degraded workload plus concurrency and tenant skew;
- data volume, growth, retention, hot-key or hot-tenant risk, and capacity horizon;
- RTO, RPO, backup frequency, restore procedure, and last recovery-test evidence;
- regional and zonal failure domains, dependency assumptions, and degradation mode;
- load, soak, fault, retry-storm, and recovery evidence at the claimed envelope.

Do not invent one platform-wide number. Missing budgets invalidate production-ready
and scalable claims.

## Kubernetes-Neutral Baseline

- Keep domain services stateless between requests. Persist authority in owner
  PostgreSQL and durable queues or stores designed for the required semantics.
- Define requests and limits, startup/readiness/liveness probes, graceful shutdown,
  termination budgets, PodDisruptionBudget, topology spread, anti-affinity, and
  horizontal scaling from measured saturation or backlog signals.
- Apply restricted workload security, non-root execution, read-only filesystems
  where possible, explicit service accounts, NetworkPolicy, controlled egress,
  signed immutable images, SBOM/provenance, and admission policy.
- Separate migrations from runtime rollout. Use expand/contract migrations,
  bounded locks, compatibility windows, and tested rollback or forward-fix paths.
- Autoscaling must account for database connections, queue visibility/leases,
  partition ordering, idempotency contention, and provider rate limits.

## Data And Messaging Scale

- Size PostgreSQL pools across all replicas; inspect plans, indexes, lock duration,
  vacuum pressure, transaction age, replication lag, and backup/restore throughput.
- Partition only with a documented key, pruning evidence, migration path, and
  tenant-skew analysis. Sharding never weakens owner invariants or auditability.
- Redis is non-authoritative. Namespace keys, define TTL and eviction behavior,
  cap retries, monitor memory and queue lag, and design poison-message isolation.
- Outbox/Inbox publishers use leases, bounded batches, retry backoff, dedupe, and
  backlog metrics. Backpressure must fail predictably instead of dropping work.

## AWS Adapter

- Keep AWS-specific resources in `operations`. Map the neutral baseline to EKS,
  managed PostgreSQL, managed Redis, KMS, workload identity, Secrets Manager or
  External Secrets, object storage, load balancing, and native audit telemetry.
- Verify multi-AZ behavior, encryption keys, IAM least privilege, private network
  paths, egress controls, database failover, backup retention, restore testing,
  quota limits, cost alarms, and regional recovery assumptions.

## Observability And Operations

Correlate tenant-safe metrics, logs, and traces with request, job, event,
idempotency, causation, and provider references. Alert on SLO burn, error rate,
latency, saturation, connection exhaustion, queue lag, DLQ, Outbox backlog,
projection lag, failed or expired payment processes, reconciliation mismatch,
migration failure, backup failure, and certificate or key expiry.
