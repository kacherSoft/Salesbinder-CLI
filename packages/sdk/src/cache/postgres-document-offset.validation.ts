import type {
  DocumentOffsetRun,
  DocumentOffsetTask,
  OffsetTaskKind,
} from './document-offset-sync.types.js';
import { assertCanonicalV3SourceId } from './v3-inventory-source-validation.js';

export const OFFSET_CURRENT_KEY = 'document_offset_sync.current.v1';
export const offsetRunKey = (id: string): string => `document_offset_sync.run.v1:${id}`;
export const offsetTaskPrefix = (id: string, kind: OffsetTaskKind): string =>
  `document_offset_sync.task.v1:${id}:${kind}:`;
export const offsetTaskKey = (id: string, kind: OffsetTaskKind, task: DocumentOffsetTask): string =>
  `${offsetTaskPrefix(id, kind)}${kind === 'document' ? `${task.contextId}:` : ''}${encodeURIComponent(task.id)}`;

export function assertOffsetRunId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new Error('Invalid offset run ID.');
  }
}

export function assertOffsetTimestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid offset timestamp.');
}

export function assertOffsetRun(run: DocumentOffsetRun): void {
  if (!run || typeof run !== 'object' || run.version !== 1) throw new Error('Invalid offset run.');
  assertOffsetRunId(run.runId);
  if (
    typeof run.accountIdentity !== 'string' ||
    !/^salesbinder:[a-z0-9-]+$/.test(run.accountIdentity)
  ) {
    throw new Error('Invalid offset account identity.');
  }
  for (const value of [run.startedAt, run.cutoff, run.updatedAt]) assertOffsetTimestamp(value);
  if (run.finishedAt !== undefined) assertOffsetTimestamp(run.finishedAt);
  if (
    !Number.isSafeInteger(run.days) ||
    run.days < 1 ||
    run.days > 365 ||
    run.cutoff > run.startedAt ||
    run.updatedAt < run.startedAt ||
    typeof run.discoveryComplete !== 'boolean' ||
    !['running', 'success', 'success_with_warnings', 'failed'].includes(run.status)
  ) {
    throw new Error('Invalid offset run state.');
  }
  assertErrorCode(run.errorCode);
}

export function assertOffsetKind(kind: OffsetTaskKind): void {
  if (kind !== 'document' && kind !== 'item') throw new Error('Invalid offset task kind.');
}

export function assertOffsetTask(
  kind: OffsetTaskKind,
  task: DocumentOffsetTask,
  requireComplete = false
): void {
  assertOffsetKind(kind);
  if (!task || typeof task !== 'object') throw new Error('Invalid offset task.');
  assertCanonicalV3SourceId(task.id, 'offset task');
  if (kind === 'document') {
    const incompleteSelection =
      !requireComplete && task.status === 'failed' && task.errorCode === 'invalid_selection_record';
    if (
      ![4, 5, 11].includes(task.contextId as number) ||
      (!(incompleteSelection && task.documentNumber === undefined) &&
        (!Number.isSafeInteger(task.documentNumber) || (task.documentNumber as number) < 0))
    ) {
      throw new Error('Invalid offset document task.');
    }
    if (!(incompleteSelection && task.selectedModified === undefined))
      assertOffsetTimestamp(task.selectedModified);
  } else if (
    task.contextId !== undefined ||
    task.documentNumber !== undefined ||
    task.selectedModified !== undefined
  ) {
    throw new Error('Invalid offset item task.');
  }
  if (
    !['pending', 'done', 'failed'].includes(task.status) ||
    !Number.isSafeInteger(task.attempts) ||
    task.attempts < 0
  )
    throw new Error('Invalid offset task state.');
  if (task.verifyAfter !== undefined) assertOffsetTimestamp(task.verifyAfter);
  assertErrorCode(task.errorCode);
}

function assertErrorCode(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value))
  ) {
    throw new Error('Invalid sanitized offset error code.');
  }
}
