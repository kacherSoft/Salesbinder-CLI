import type { OfficialV3TaskExecution } from './official-v3-sync.contracts.js';
import { officialV3LocalFailure } from './official-v3-sync-failure.js';
import type { OfficialV3SyncTask } from './official-v3-sync.types.js';
import { normalizeOfficialV3DocumentCacheRows } from './v3-document-cache-normalizer.js';
import type { NormalizedV3InventoryItem } from './v3-inventory-normalizer.js';

const DOCUMENT_CONTEXTS = { invoice: 5, estimate: 4, purchase_order: 11 } as const;

export async function drainOfficialV3Tasks(execution: OfficialV3TaskExecution): Promise<void> {
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
    const task = (await execution.deps.store.listTasks(execution.runId)).find(
      (candidate) => candidate.status === 'pending'
    );
    if (!task) continue;
    await processTask(execution, task);
    await execution.deps.store.advanceAppliedPrefix(execution.runId);
    await execution.progress('task_checkpoint');
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
      else await execution.deps.store.applyDocumentDeleteAndQueueRefreshes(execution.runId, next);
      return;
    }
    if (next.resource === 'item') {
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
  const result = results[0];
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
    await execution.deps.store.applyItemRefresh(
      execution.runId,
      task,
      bundle.item,
      bundle.stockRows
    );
  } else {
    await execution.deps.store.applyItemUpsert(
      execution.runId,
      task,
      bundle.item,
      bundle.stockRows
    );
  }
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
  await execution.deps.store.applyDocumentUpsertAndQueueRefreshes(
    execution.runId,
    task,
    normalized.docRow,
    normalized.itemRows
  );
}
