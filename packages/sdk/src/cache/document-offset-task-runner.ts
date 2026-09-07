import type { DocumentOffsetTask, OffsetTaskKind } from './document-offset-sync.types.js';
import type { OffsetExecution } from './document-offset-sync.contracts.js';
import { DocumentOffsetSyncError, localOffsetFailure } from './document-offset-failure.js';
import { normalizeV3DocumentCacheRows } from './v3-document-cache-normalizer.js';
import type { NormalizedV3InventoryItem } from './v3-inventory-normalizer.js';
import { DocumentRecordError } from './document-source-validation.js';

/** Two passes per invocation; a resumed failed record receives a fresh bounded retry. */
export async function drainOffsetTasks(
  execution: OffsetExecution,
  kind: OffsetTaskKind
): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    const tasks = await execution.deps.store.listOffsetSyncTasks(execution.run.runId, kind);
    for (const task of tasks) {
      if (task.status === 'done' || (pass === 1 && task.status !== 'failed')) continue;
      // Unknown selection metadata needs a new discovery read, not an invented detail identity.
      if (kind === 'document' && task.errorCode === 'invalid_selection_record') continue;
      await execution.guard();
      task.attempts++;
      task.status = 'pending';
      delete task.errorCode;
      await execution.deps.store.saveOffsetSyncTasks(execution.run.runId, kind, [task]);
      if (kind === 'document') await refreshDocument(execution, task);
      else await refreshItem(execution, task);
      await execution.progress(
        kind === 'document' ? 'documents' : 'items',
        pass ? 'retry_checkpoint' : 'checkpoint',
        tasks
      );
    }
  }
}

async function refreshDocument(
  execution: OffsetExecution,
  task: DocumentOffsetTask
): Promise<void> {
  if (!task.contextId || !task.documentNumber) throw new DocumentOffsetSyncError('invalid_task');
  let normalized: ReturnType<typeof normalizeV3DocumentCacheRows>;
  try {
    await execution.guard();
    const payload = await execution.deps.documentsV3.get(task.contextId, task.id);
    normalized = normalizeV3DocumentCacheRows(payload, {
      id: task.id,
      contextId: task.contextId,
      documentNumber: task.documentNumber,
    });
    if (normalized.docRow.modified < (task.selectedModified ?? 0)) {
      throw new DocumentRecordError('invalid_record', 'Canonical document predates selected edit');
    }
  } catch (error) {
    const code = localOffsetFailure(error);
    if (!code) throw error;
    await saveFailure(execution, 'document', task, code);
    return;
  }
  await execution.guard();
  // Queueing old references and publishing the new bundle are one fenced transaction.
  await execution.deps.store.applyOffsetDocumentBundle(
    execution.run.runId,
    task,
    normalized.docRow,
    normalized.itemRows,
    execution.now() + (task.contextId === 11 ? 30 : 0)
  );
  task.status = 'done';
}

async function refreshItem(execution: OffsetExecution, task: DocumentOffsetTask): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(task.id)) {
    return saveFailure(execution, 'item', task, 'invalid_item_id');
  }
  const delay = (task.verifyAfter ?? 0) - execution.now();
  if (delay > 0) {
    if (delay > 30) throw new DocumentOffsetSyncError('invalid_refresh_deadline');
    await execution.progress('items', 'waiting_for_purchase_order_balance');
    await execution.sleep(delay * 1000);
    await execution.guard();
    if ((task.verifyAfter ?? 0) > execution.now())
      throw new DocumentOffsetSyncError('refresh_not_due');
  }
  let bundle: NormalizedV3InventoryItem | undefined;
  let failure: string | undefined;
  try {
    await execution.guard();
    // One exact ID makes every completed hydration durable before the next network call.
    const results = await execution.deps.hydrator.hydrate([task.id]);
    if (results.length !== 1 || results[0]?.id !== task.id)
      throw new DocumentOffsetSyncError('invalid_hydration_identity');
    const result = results[0];
    if (result.status === 'missing_unproven') failure = 'missing_unproven';
    else if (result.status === 'local_failure') failure = 'invalid_record';
    else bundle = result.bundle;
  } catch (error) {
    const code = localOffsetFailure(error);
    if (!code) throw error;
    failure = code;
  }
  if (failure) return saveFailure(execution, 'item', task, failure);
  if (!bundle || bundle.item.item_id !== task.id)
    throw new DocumentOffsetSyncError('invalid_hydration_identity');
  await execution.guard();
  // Database/lock errors deliberately escape record recovery and fail the whole invocation.
  await execution.deps.store.applyOffsetInventoryBundle(
    execution.run.runId,
    task,
    bundle.item,
    bundle.stockRows
  );
  task.status = 'done';
}

async function saveFailure(
  execution: OffsetExecution,
  kind: OffsetTaskKind,
  task: DocumentOffsetTask,
  code: string
): Promise<void> {
  await execution.guard();
  await execution.deps.store.saveOffsetSyncTasks(execution.run.runId, kind, [
    { ...task, status: 'failed', errorCode: code },
  ]);
  task.status = 'failed';
  task.errorCode = code;
}
