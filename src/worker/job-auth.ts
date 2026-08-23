import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { EngineWorkerJob, WorkerJobAuth } from './worker.types';

export const JOB_AUTH_ALG = 'HS256';

const TEST_SIGNING_SECRET = 'workbench-test-job-signing-secret';

export function getJobSigningSecret(): string {
  const secret = process.env.JOB_SIGNING_SECRET || '';
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === 'test') {
    return TEST_SIGNING_SECRET;
  }
  throw new Error('JOB_SIGNING_SECRET is required');
}

export function signWorkerJob(
  job: Pick<EngineWorkerJob, 'id' | 'type' | 'tenant_id' | 'created_at' | 'payload'>,
  secret = getJobSigningSecret(),
): WorkerJobAuth {
  return {
    alg: JOB_AUTH_ALG,
    signature: createHmac('sha256', secret).update(jobSigningMaterial(job)).digest('hex'),
  };
}

export function jobSigningMaterial(
  job: Pick<EngineWorkerJob, 'id' | 'type' | 'tenant_id' | 'created_at' | 'payload'>,
): string {
  const payloadDigest = createHash('sha256').update(stableJson(job.payload || {})).digest('hex');
  return [job.id, job.type, job.tenant_id, job.created_at, payloadDigest].join('\n');
}

export function assertWorkerJobAuthenticated(
  job: EngineWorkerJob,
  secret = getJobSigningSecret(),
): void {
  if (!job.auth || job.auth.alg !== JOB_AUTH_ALG || typeof job.auth.signature !== 'string') {
    throw new Error('worker job is not signed');
  }
  const expected = signWorkerJob(job, secret).signature;
  if (!safeEqualHex(job.auth.signature, expected)) {
    throw new Error('worker job signature is invalid');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

function safeEqualHex(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.length > 0 && leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}
