import {
  OFFICIAL_V3_SYNC_RESOURCES,
  type OfficialV3SyncMarker,
  type OfficialV3SyncPage,
  type OfficialV3SyncResource,
  type OfficialV3SyncRun,
  type OfficialV3SyncState,
  type OfficialV3SyncTask,
} from './official-v3-sync.types.js';

export const OFFICIAL_V3_SYNC_CURRENT_KEY = 'official_v3_sync.state.v1';
export const OFFICIAL_V3_SYNC_CURRENT_RUN_KEY = 'official_v3_sync.current_run.v1';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^[0-9a-f-]{36}$|^run-[a-z0-9-]+$/i;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function officialRunKey(runId: string): string {
  assertRunId(runId);
  return `official_v3_sync.run.v1:${runId}`;
}

export function officialPageKey(runId: string, page: number): string {
  assertRunId(runId);
  assertPositiveInteger(page, 'page');
  return `official_v3_sync.page.v1:${runId}:${page.toString().padStart(10, '0')}`;
}

export function officialPagePrefix(runId: string): string {
  assertRunId(runId);
  return `official_v3_sync.page.v1:${runId}:`;
}

export function officialTaskKey(runId: string, taskId: string): string {
  assertRunId(runId);
  assertTaskId(taskId);
  return `official_v3_sync.task.v1:${runId}:${taskId}`;
}

export function officialTaskPrefix(runId: string): string {
  assertRunId(runId);
  return `official_v3_sync.task.v1:${runId}:`;
}

export function officialLatestReceiptKey(resource: string, id: string): string {
  if (!/^[a-z_]+$/.test(resource) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error('Official V3 sync receipt identity is invalid.');
  }
  return `official_v3_sync.latest_receipt.v1:${resource}:${id}`;
}

export function assertOfficialState(value: unknown): asserts value is OfficialV3SyncState {
  const state = record(value, 'state');
  if (
    state.version !== 1 ||
    !isAccountIdentity(state.accountIdentity) ||
    !sameResources(state.resources) ||
    !isOptionalCursor(state.ingestionCursor) ||
    !isOptionalCursor(state.appliedCursor) ||
    !isNonNegativeInteger(state.appliedGeneration) ||
    !isNonNegativeInteger(state.nextGeneration) ||
    state.appliedGeneration > state.nextGeneration ||
    state.coverage !== 'partial_catch_up' ||
    !isNonNegativeInteger(state.updatedAt)
  )
    throw persisted();
}

export function assertOfficialRun(value: unknown): asserts value is OfficialV3SyncRun {
  const run = record(value, 'run');
  if (
    run.version !== 1 ||
    !RUN_ID.test(String(run.runId)) ||
    !isAccountIdentity(run.accountIdentity) ||
    !isEntry(run.entry) ||
    !['running', 'success', 'success_with_warnings', 'failed'].includes(String(run.status)) ||
    typeof run.ingestionComplete !== 'boolean' ||
    !isNonNegativeInteger(run.pageCount) ||
    !isNonNegativeInteger(run.startedAt) ||
    !isNonNegativeInteger(run.updatedAt) ||
    run.updatedAt < run.startedAt ||
    (run.finishedAt !== undefined && !isNonNegativeInteger(run.finishedAt)) ||
    (run.errorCode !== undefined && !SAFE_CODE.test(String(run.errorCode)))
  )
    throw persisted();
}

export function assertOfficialPage(value: unknown): asserts value is OfficialV3SyncPage {
  const page = record(value, 'page');
  if (
    !RUN_ID.test(String(page.runId)) ||
    !isPositiveInteger(page.page) ||
    !isNonNegativeInteger(page.firstGeneration) ||
    !isNonNegativeInteger(page.lastGeneration) ||
    page.lastGeneration + 1 < page.firstGeneration ||
    !isEntry(page.request) ||
    !isCursor(page.nextCursor) ||
    typeof page.hasMore !== 'boolean' ||
    !isNonNegativeInteger(page.markerCount) ||
    !['sealed', 'complete', 'blocked'].includes(String(page.status)) ||
    typeof page.responseHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(page.responseHash)
  )
    throw persisted();
}

export function assertOfficialTask(value: unknown): asserts value is OfficialV3SyncTask {
  const task = record(value, 'task');
  if (
    !isTaskId(task.taskId) ||
    !RUN_ID.test(String(task.runId)) ||
    !isPositiveInteger(task.page) ||
    !isNonNegativeInteger(task.ordinal) ||
    !isNonNegativeInteger(task.generation) ||
    (task.kind !== 'marker' && task.kind !== 'item_refresh') ||
    (task.parentTaskId !== undefined && !isTaskId(task.parentTaskId)) ||
    !isResource(task.resource) ||
    !UUID.test(String(task.id)) ||
    !['upsert', 'delete', 'refresh'].includes(String(task.operation)) ||
    !['pending', 'waiting_children', 'done', 'superseded', 'failed'].includes(String(task.status)) ||
    !isNonNegativeInteger(task.attempts) ||
    (task.errorCode !== undefined && !SAFE_CODE.test(String(task.errorCode)))
  )
    throw persisted();
}

export function assertMarker(value: unknown): asserts value is OfficialV3SyncMarker {
  const marker = record(value, 'marker');
  if (!isResource(marker.resource) || !UUID.test(String(marker.id))) throw persisted();
  if (marker.operation !== 'upsert' && marker.operation !== 'delete') throw persisted();
}

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error('Official V3 sync run identity is invalid.');
}

export function assertTaskId(taskId: string): void {
  if (!isTaskId(taskId)) throw new Error('Official V3 sync task identity is invalid.');
}

function isEntry(value: unknown): value is OfficialV3SyncRun['entry'] {
  return (
    isRecord(value) &&
    (value.kind === 'since' || value.kind === 'cursor') &&
    typeof value.value === 'string' &&
    value.value.length > 0 &&
    value.value.length <= 8_192 &&
    !hasAsciiControlCharacter(value.value)
  );
}

function sameResources(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === OFFICIAL_V3_SYNC_RESOURCES.length &&
    value.every((resource, index) => resource === OFFICIAL_V3_SYNC_RESOURCES[index])
  );
}

function isResource(value: unknown): value is OfficialV3SyncResource {
  return (
    typeof value === 'string' &&
    (OFFICIAL_V3_SYNC_RESOURCES as readonly string[]).includes(value)
  );
}

function isOptionalCursor(value: unknown): boolean {
  return value === undefined || isCursor(value);
}

function isCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8_192 &&
    !hasAsciiControlCharacter(value)
  );
}

export function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9:.-]+$/i.test(value) && value.length <= 200;
}

function isAccountIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^salesbinder:[a-z0-9-]+$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!isPositiveInteger(value)) throw new Error(`Official V3 sync ${label} is invalid.`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid persisted official V3 sync ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function persisted(): Error {
  return new Error('Invalid persisted official V3 sync state.');
}
