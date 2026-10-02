# Security And Regulation

## Mandatory Platform Controls

- Default deny at API, service, database, queue, and operator boundaries.
- Verify subject and workload identity for each protected resource; network
  location is not authority.
- Derive tenant and permissions from signed identity context and enforce RLS in
  the same transaction and connection as protected PostgreSQL access.
- Separate runtime, migration, backup, and operator credentials. Runtime roles do
  not own schemas, bypass RLS, or receive migration secrets.
- Use least privilege, short-lived credentials, managed key rotation, TLS, secure
  webhook verification, dependency provenance, and minimal CI permissions.
- Classify data, minimize event payloads, encrypt sensitive data, define retention
  and deletion, and prevent secrets or PII from logs, metrics, traces, examples,
  review comments, and `.env` tracking.
- Record append-only audit evidence for authentication, authorization, approvals,
  configuration, posting, adjustment, settlement, export, replay, and failure.

## Financial API Baseline

- Treat OpenID FAPI 2.0 Security Profile and its attacker model as the target
  baseline for high-value external APIs. Assess PAR, PKCE, sender-constrained
  tokens, client authentication, redirect handling, key lifecycle, and resource
  server behavior before claiming alignment.
- Use NIST SP 800-207 for zero-trust decisions and NIST SP 800-218 for secure
  development and supply-chain evidence.
- Apply PCI DSS v4.0.1 only when cardholder data, sensitive authentication data,
  or systems affecting that environment are in scope. First minimize and document scope.
- Use ISO 20022 for applicable external financial messaging profiles. It does not
  replace MAVULA owner APIs, internal event envelopes, or local regulatory contracts.
- Use CNCF cloud-native security guidance for workload identity, orchestration,
  image, runtime, storage, policy, and observability controls.

## Mozambique Baseline

- Use the primary Banco de Mocambique and statutory sources already approved in
  RFC-0002 for AML/CFT/CPF, transaction records, retention, institutional conduct,
  licensing, and credit-registry requirements.
- AML alerts, decisions, beneficial-owner data, suspicious-operation details, and
  authority references are restricted need-to-know data, not free-form metadata.
- Preserve applicable records and investigations according to approved policy;
  technical defaults never override a legal hold or authority instruction.
- Every legal interpretation, retention exception, reporting obligation, or
  compliance claim requires current source verification and accountable legal or
  compliance approval. Engineering evidence is not a legal opinion.

## Required Threat Cases

Test issuer/audience confusion, stolen or replayed tokens, privilege escalation,
cross-tenant access, self-approval, webhook replay, idempotency fingerprint
conflict, injection, SSRF, unsafe deserialization, secret leakage, dependency
compromise, queue poisoning, unauthorized replay, audit tampering, and backup exposure.
