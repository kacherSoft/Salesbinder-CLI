import type { ListParams, ListResponse } from './common.types.js';

export interface DeletedLogEntry {
  id: number;
  context_id: number;
  record_id: string;
  created: string;
}

export interface DeletedLogListParams extends ListParams {
  contextId?: number;
  deletedSince?: number;
}

export interface DeletedLogListResponse extends ListResponse {
  deletedlog?: DeletedLogEntry[][];
  deleted_log?: DeletedLogEntry[][];
}
