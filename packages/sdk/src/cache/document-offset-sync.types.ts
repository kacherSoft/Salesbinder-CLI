import type { DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';

export type OffsetTaskKind = 'document' | 'item';
export type OffsetTaskStatus = 'pending' | 'done' | 'failed';

export interface DocumentOffsetRun {
  version: 1;
  runId: string;
  accountIdentity: string;
  startedAt: number;
  cutoff: number;
  days: number;
  updatedAt: number;
  discoveryComplete: boolean;
  status: 'running' | 'success' | 'success_with_warnings' | 'failed';
  finishedAt?: number;
  errorCode?: string;
}

export interface DocumentOffsetTask {
  id: string;
  contextId?: 4 | 5 | 11;
  documentNumber?: number;
  selectedModified?: number;
  status: OffsetTaskStatus;
  attempts: number;
  errorCode?: string;
  /** Earliest time for the final inventory refresh after a PO document read. */
  verifyAfter?: number;
}

export interface DocumentOffsetStore {
  getOffsetSyncRun(): Promise<DocumentOffsetRun | null>;
  saveOffsetSyncRun(run: DocumentOffsetRun): Promise<void>;
  listOffsetSyncTasks(runId: string, kind: OffsetTaskKind): Promise<DocumentOffsetTask[]>;
  saveOffsetSyncTasks(runId: string, kind: OffsetTaskKind, tasks: DocumentOffsetTask[]): Promise<void>;
  /** Atomically retain old/new item references, replace document lines, and complete task. */
  applyOffsetDocumentBundle(
    runId: string, task: DocumentOffsetTask, document: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[], refreshNotBefore: number
  ): Promise<void>;
  /** Atomically replace this item's API subtree and complete its durable task. */
  applyOffsetInventoryBundle(
    runId: string, task: DocumentOffsetTask, item: ItemRow, rows: ItemStockLocationRow[]
  ): Promise<void>;
}
