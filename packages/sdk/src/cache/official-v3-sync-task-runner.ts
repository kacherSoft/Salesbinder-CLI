import type { OfficialV3TaskExecution } from './official-v3-sync.contracts.js';
import { officialV3LocalFailure } from './official-v3-sync-failure.js';
import type { OfficialV3SyncTask } from './official-v3-sync.types.js';
import type { V3ExactItemHydrationResult } from './v3-exact-item-hydrator.service.js';
import { normalizeOfficialV3DocumentCacheRows } from './v3-document-cache-normalizer.js';
import type { NormalizedV3InventoryItem } from './v3-inventory-normalizer.js';

const DOCUMENT_CONTEXTS = { invoice: 5, estimate: 4, purchase_order: 11 } as const;
const ITEM_HYDRATION_BATCH_LIMIT = 10;

export async function drainOfficialV3Tasks(execution: OfficialV3TaskExecution): Promise<void> {
  await execution.deps.store.retireLegacyItemRefreshTasks(execution.runId);
  await drainPendingToQuiescence(execution);
  const retried = new Set<string>();
  for (;;) {
    const retry = (await execution.deps.store.listTasks(execution.runId)).find(
      (task) => task.status === 'failed' && !retried.has(task.taskId)
    );
    if (!retry) break;
    retried.add(retry.taskId);
    await completeWaitingParents(execution);
    const task = (await execution.deps.store.listTasks(execution.runId)).find(
      (candidate) => candidate.taskId === retry.taskId && candidate.status === 'failed'
    );
    if (task) {
      await processTask(execution, task);
      await execution.deps.store.advanceAppliedPrefix(execution.runId);
      await execution.progress('task_retry_checkpoint');
    }
    await drainPendingToQuiescence(execution);
  }
  await completeWaitingParents(execution);
}

async function drainPendingToQuiescence(execution: OfficialV3TaskExecution): Promise<void> {
  let progressed = true;
  while (progressed) {
    progressed = false;
    await completeWaitingParents(execution);
    const tasks = await execution.deps.store.listTasks(execution.runId);
    const task = tasks.find((candidate) => candidate.status === 'pending');
    if (!task) continue;
    if (isBatchableItemUpsert(task)) {
      await processItemHydrationBatch(execution, tasks, task);
    } else {
      await processTask(execution, task);
      await checkpointTask(execution, 'task_checkpoint');
    }
    progressed = true;
  }
}

async function completeWaitingParents(execution: OfficialV3TaskExecution): Promise<void> {
  const waiting = (await execution.deps.store.listTasks(execution.runId)).filter(
    (task) => task.status === 'waiting_children'
  );
  for (const task of waiting) await execution.deps.store.completeTaskGroup(execution.runId, task);
}

async function processTask(
  execution: OfficialV3TaskExecution,
  task: OfficialV3SyncTask
): Promise<void> {
  await execution.guard();
  if (await execution.deps.store.markSupersededIfStale(execution.runId, task)) return;
  const next = { ...task, attempts: task.attempts + 1, status: 'pending' as const };
  try {
    if (next.operation === 'delete') {
      if (next.resource === 'item') await execution.deps.store.applyItemDelete(execution.runId, next);
      else await execution.deps.store.applyDocumentDelete(execution.runId, next);
      return;
    }
    if (next.resource === 'item') {
      if (next.kind === 'item_refresh') {
        throw new Error('Official V3 legacy item refresh task was not retired.');
      }
      await applyItemHydration(execution, next);
      return;
    }
    await applyDocumentHydration(execution, next);
  } catch (error) {
    const code = officialV3LocalFailure(error);
    if (!code) throw error;
    await execution.deps.store.saveTaskFailure(execution.runId, next, code);
  }
}

async function processItemHydrationBatch(
  execution: OfficialV3TaskExecution,
  tasks: readonly OfficialV3SyncTask[],
  first: OfficialV3SyncTask
): Promise<void> {
  const selected = selectItemHydrationBatch(tasks, first);
  const runnable: OfficialV3SyncTask[] = [];
  for (const task of selected) {
    await execution.guard();
    if (await execution.deps.store.markSupersededIfStale(execution.runId, task)) {
      await checkpointTask(execution, 'task_checkpoint');
      continue;
    }
    runnable.push({ ...task, attempts: task.attempts + 1, status: 'pending' });
  }
  if (runnable.length === 0) return;

  let results: V3ExactItemHydrationResult[];
  try {
    results = await execution.deps.hydrator.hydrate(
      runnable.map((task) => task.id),
      { categoryNames: execution.deps.categoryNames ?? null }
    );
  } catch (error) {
    const code = officialV3LocalFailure(error);
    if (!code) throw error;
    const originalTasks = new Map(selected.map((task) => [task.taskId, task]));
    for (const task of runnable) {
      await processTask(execution, originalTasks.get(task.taskId) ?? task);
      await checkpointTask(execution, 'task_checkpoint');
    }
    return;
  }
  const byId = itemHydrationResultMap(runnable, results);
  for (const task of runnable) {
    await execution.guard();
    if (await execution.deps.store.markSupersededIfStale(execution.runId, task)) {
      await checkpointTask(execution, 'task_checkpoint');
      continue;
    }
    try {
      await applyItemHydrationResult(execution, task, byId.get(task.id)!);
    } catch (error) {
      const code = officialV3LocalFailure(error);
      if (!code) throw error;
      await execution.deps.store.saveTaskFailure(execution.runId, task, code);
    }
    await checkpointTask(execution, 'task_checkpoint');
  }
}

function selectItemHydrationBatch(
  tasks: readonly OfficialV3SyncTask[],
  first: OfficialV3SyncTask
): OfficialV3SyncTask[] {
  const selected: OfficialV3SyncTask[] = [];
  const seen = new Set<string>();
  const start = tasks.findIndex((task) => task.taskId === first.taskId);
  for (const task of tasks.slice(start)) {
    if (selected.length >= ITEM_HYDRATION_BATCH_LIMIT) break;
    if (task.status !== 'pending') continue;
    if (isBatchableItemUpsert(task)) {
      if (seen.has(task.id)) break;
      selected.push(task);
      seen.add(task.id);
      continue;
    }
    if (task.resource === 'item') break;
  }
  return selected;
}

function isBatchableItemUpsert(task: OfficialV3SyncTask): boolean {
  return (
    task.status === 'pending' &&
    task.kind === 'marker' &&
    task.resource === 'item' &&
    task.operation === 'upsert'
  );
}

function itemHydrationResultMap(
  tasks: readonly OfficialV3SyncTask[],
  results: readonly V3ExactItemHydrationResult[]
): Map<string, V3ExactItemHydrationResult> {
  if (results.length !== tasks.length) throw new Error('Official V3 item hydration identity mismatch');
  const expected = new Set(tasks.map((task) => task.id));
  const byId = new Map<string, V3ExactItemHydrationResult>();
  for (const result of results) {
    if (!expected.has(result.id) || byId.has(result.id)) {
      throw new Error('Official V3 item hydration identity mismatch');
    }
    byId.set(result.id, result);
  }
  return byId;
}

async function checkpointTask(
  execution: OfficialV3TaskExecution,
  event: string
): Promise<void> {
  await execution.deps.store.advanceAppliedPrefix(execution.runId);
  await execution.progress(event);
}

async function applyItemHydration(
  execution: OfficialV3TaskExecution,
  task: OfficialV3SyncTask
): Promise<void> {
  const results = await execution.deps.hydrator.hydrate([task.id], {
    categoryNames: execution.deps.categoryNames ?? null,
  });
  if (results.length !== 1 || results[0]?.id !== task.id) {
    throw new Error('Official V3 item hydration identity mismatch');
  }
  await applyItemHydrationResult(execution, task, results[0]);
}

async function applyItemHydrationResult(
  execution: OfficialV3TaskExecution,
  task: OfficialV3SyncTask,
  result: V3ExactItemHydrationResult
): Promise<void> {
  if (result.id !== task.id) throw new Error('Official V3 item hydration identity mismatch');
  if (result.status === 'missing_unproven') {
    await execution.deps.store.saveTaskFailure(execution.runId, task, 'missing_unproven');
    return;
  }
  if (result.status === 'local_failure') {
    await execution.deps.store.saveTaskFailure(execution.runId, task, result.failure.code);
    return;
  }
  const bundle: NormalizedV3InventoryItem = result.bundle;
  if (bundle.item.item_id !== task.id) throw new Error('Official V3 item bundle identity mismatch');
  if (task.kind === 'item_refresh') {
    throw new Error('Official V3 legacy item refresh task was not retired.');
  }
  await execution.deps.store.applyItemUpsert(
    execution.runId,
    task,
    bundle.item,
    bundle.stockRows
  );
}

async function applyDocumentHydration(
  execution: OfficialV3TaskExecution,
  task: OfficialV3SyncTask
): Promise<void> {
  if (task.resource === 'item') throw new Error('Official V3 item has no document context');
  const resource = task.resource;
  const contextId = DOCUMENT_CONTEXTS[resource];
  const payload = await execution.deps.documents.get(contextId, task.id);
  const normalized = normalizeOfficialV3DocumentCacheRows(payload, {
    id: task.id,
    resource,
  });
  await execution.deps.store.applyDocumentUpsert(
    execution.runId,
    task,
    normalized.docRow,
    normalized.itemRows
  );
}
