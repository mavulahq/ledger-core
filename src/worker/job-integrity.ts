/*
 * MAVULA Ledger Core Job Integrity
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JobIntegrityFields {
  id: string;
  type: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  integrity?: string;
}

export function resolveJobSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.JOB_SIGNING_KEY?.trim()
    || env.WORKBENCH_JOB_SIGNING_KEY?.trim()
    || env.LEDGER_CORE_JOB_SIGNING_KEY?.trim();
  if (key) {
    return key;
  }
  if ((env.NODE_ENV || 'development') === 'test') {
    return 'test-job-signing-key';
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('JOB_SIGNING_KEY is required in production');
  }
  return 'dev-job-signing-key';
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function signWorkerJob(job: JobIntegrityFields, env: NodeJS.ProcessEnv = process.env): string {
  const body = JSON.stringify({
    id: job.id,
    type: job.type,
    tenant_id: job.tenant_id,
    payload: canonicalize(job.payload || {}),
  });
  return createHmac('sha256', resolveJobSigningKey(env)).update(body).digest('hex');
}

export function assertWorkerJobIntegrity(job: JobIntegrityFields, env: NodeJS.ProcessEnv = process.env): void {
  const expected = signWorkerJob(job, env);
  const provided = typeof job.integrity === 'string' ? job.integrity : '';
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new Error('worker job integrity check failed');
  }
}

export function assertRedisUrlAuthenticated(redisUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL must be a valid redis URL');
  }
  if (!parsed.password) {
    throw new Error('REDIS_URL must include a password in production');
  }
}
