import type { DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';

export const OFFICIAL_V3_SYNC_RESOURCES = [
  'item',
  'invoice',
  'estimate',
  'purchase_order',
] as const;

export type OfficialV3SyncResource = (typeof OFFICIAL_V3_SYNC_RESOURCES)[number];
export type OfficialV3SyncOperation = 'upsert' | 'delete' | 'refresh';
export type OfficialV3SyncStatus = 'running' | 'success' | 'success_with_warnings' | 'failed';
export type OfficialV3SyncTaskStatus =
  | 'pending'
  | 'waiting_children'
  | 'done'
  | 'superseded'
  | 'failed';

export interface OfficialV3SyncState {
  version: 1;
  accountIdentity: string;
  resources: readonly OfficialV3SyncResource[];
  ingestionCursor?: string;
  appliedCursor?: string;
  appliedGeneration: number;
  nextGeneration: number;
  coverage: 'partial_catch_up';
  updatedAt: number;
}

export interface OfficialV3SyncRun {
  version: 1;
  runId: string;
  accountIdentity: string;
  entry: { kind: 'since' | 'cursor'; value: string };
  status: OfficialV3SyncStatus;
  ingestionComplete: boolean;
  pageCount: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  errorCode?: string;
}

export interface OfficialV3SyncPage {
  runId: string;
  page: number;
  firstGeneration: number;
  lastGeneration: number;
  request: { kind: 'since' | 'cursor'; value: string };
  nextCursor: string;
  hasMore: boolean;
  markerCount: number;
  status: 'sealed' | 'complete' | 'blocked';
  responseHash: string;
}

export interface OfficialV3SyncTask {
  taskId: string;
  runId: string;
  page: number;
  ordinal: number;
  generation: number;
  kind: 'marker' | 'item_refresh';
  parentTaskId?: string;
  resource: OfficialV3SyncResource;
  id: string;
  operation: OfficialV3SyncOperation;
  status: OfficialV3SyncTaskStatus;
  attempts: number;
  errorCode?: string;
}

export interface OfficialV3SyncStore {
  getState(): Promise<OfficialV3SyncState | null>;
  getRun(): Promise<OfficialV3SyncRun | null>;
  beginRun(run: OfficialV3SyncRun): Promise<void>;
  sealPage(
    runId: string,
    request: OfficialV3SyncPage['request'],
    page: Omit<OfficialV3SyncPage, 'request' | 'status' | 'firstGeneration' | 'lastGeneration'>,
    markers: readonly OfficialV3SyncMarker[]
  ): Promise<OfficialV3SyncRun>;
  listTasks(runId: string): Promise<OfficialV3SyncTask[]>;
  saveTaskFailure(runId: string, task: OfficialV3SyncTask, code: string): Promise<void>;
  markSupersededIfStale(runId: string, task: OfficialV3SyncTask): Promise<boolean>;
  applyItemUpsert(
    runId: string,
    task: OfficialV3SyncTask,
    item: ItemRow,
    stockRows: ItemStockLocationRow[]
  ): Promise<void>;
  applyItemDelete(runId: string, task: OfficialV3SyncTask): Promise<void>;
  applyDocumentUpsertAndQueueRefreshes(
    runId: string,
    task: OfficialV3SyncTask,
    document: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[]
  ): Promise<void>;
  applyDocumentDeleteAndQueueRefreshes(
    runId: string,
    task: OfficialV3SyncTask
  ): Promise<void>;
  applyItemRefresh(
    runId: string,
    task: OfficialV3SyncTask,
    item: ItemRow,
    stockRows: ItemStockLocationRow[]
  ): Promise<void>;
  completeTaskGroup(runId: string, task: OfficialV3SyncTask): Promise<void>;
  advanceAppliedPrefix(runId: string): Promise<OfficialV3SyncState | null>;
  finishRun(run: OfficialV3SyncRun): Promise<void>;
}

export interface OfficialV3SyncMarker {
  resource: OfficialV3SyncResource;
  id: string;
  operation: 'upsert' | 'delete';
}

export interface OfficialV3SyncPageEnvelope {
  object: 'sync_page';
  resources: readonly OfficialV3SyncResource[];
  changes: readonly OfficialV3SyncMarker[];
  has_more: boolean;
  next_cursor: string;
}

export interface OfficialV3SyncTaskCounts {
  discovered: number;
  applied: number;
  failed: number;
  pending: number;
  superseded: number;
}

export type OfficialV3SyncRunSummary = Omit<OfficialV3SyncRun, 'entry'> & {
  entry: { kind: 'since'; value: string } | { kind: 'cursor' };
};

export interface OfficialV3SyncResult {
  run: OfficialV3SyncRunSummary;
  state: Omit<OfficialV3SyncState, 'ingestionCursor' | 'appliedCursor'> & {
    hasIngestionCursor: boolean;
    hasAppliedCursor: boolean;
    cursorGap: boolean;
  };
  tasks: OfficialV3SyncTaskCounts;
  failures: { taskId: string; resource: OfficialV3SyncResource; id: string; code: string }[];
  coverage: 'partial_catch_up';
}

export type OfficialV3SyncStatusSummary = Pick<
  OfficialV3SyncResult,
  'run' | 'state' | 'tasks' | 'failures' | 'coverage'
>;
