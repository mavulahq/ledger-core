export type WorkerJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface EnqueueEngineEventInput {
  tenant_id: string;
  event_type: string;
  payload?: Record<string, any>;
  idempotency_key?: string;
  max_attempts?: number;
}

export interface EngineWorkerJob {
  id: string;
  queue: 'platform';
  type: 'FENGINE_EVENT';
  tenant_id: string;
  payload: Record<string, any> & { event_type: string };
  status: WorkerJobStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  result?: any;
  last_error?: string;
}

export interface EngineEventCallback {
  job_id: string;
  tenant_id: string;
  event_type: string;
  payload?: Record<string, any>;
}
