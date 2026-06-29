export const READ_PROJECTION_NAMES = [
  'loan_activity',
  'ledger_activity',
  'product_publication',
] as const;

export type ReadProjectionName = (typeof READ_PROJECTION_NAMES)[number];

export interface ReadProjectionRecord<TData extends Record<string, any> = Record<string, any>> {
  tenant_id: string;
  projection_name: ReadProjectionName;
  entity_id: string;
  entity_type: string;
  data: TData;
  last_event_id: string;
  last_event_type: string;
  last_event_version: number;
  last_occurred_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectionCheckpoint {
  tenant_id: string;
  projection_name: ReadProjectionName;
  last_event_id?: string;
  last_event_type?: string;
  last_event_version?: number;
  last_occurred_at?: Date;
  event_count: number;
  lag_ms: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectionApplyResult {
  applied: boolean;
  ignored?: boolean;
  idempotent?: boolean;
  projection_name?: ReadProjectionName;
  entity_id?: string;
}

export interface ProjectionRebuildResult {
  rebuilt: number;
  scanned: number;
  projection_names: ReadProjectionName[];
  tenant_id?: string;
}

export function isReadProjectionName(value: string): value is ReadProjectionName {
  return READ_PROJECTION_NAMES.includes(value as ReadProjectionName);
}
