import type { DocumentOffsetTask } from './document-offset-sync.types.js';
import type { OffsetExecution } from './document-offset-sync.contracts.js';
import { DocumentOffsetSyncError } from './document-offset-failure.js';
import { isValidSalesBinderTimestampText } from './salesbinder-source-date-validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_LIMIT = 100;

/** Restart enumeration from page one on resume; only receipts are durable cursors. */
export async function discoverOffsetDocuments(execution: OffsetExecution): Promise<void> {
  const { deps, run, guard } = execution;
  const existing = new Map(
    (await deps.store.listOffsetSyncTasks(run.runId, 'document')).map((task) => [key(task), task])
  );
  for (const contextId of [4, 5, 11] as const) {
    const seen = new Set<string>();
    const seenNumbers = new Set<number>();
    let expectedCount: number | undefined;
    let expectedPages: number | undefined;
    for (let page = 1; ; page++) {
      await guard();
      const response = await deps.documentsV2.list({
        contextId,
        modifiedSince: run.cutoff,
        page,
        pageLimit: PAGE_LIMIT,
      });
      const count = paginationInteger(response.count);
      const pages = paginationInteger(response.pages);
      if (paginationInteger(response.page) !== page || page > 10_000 || count > 1_000_000)
        invalid();
      if (
        (count === 0 && pages !== 0 && pages !== 1) ||
        (count > 0 && pages !== Math.ceil(count / PAGE_LIMIT))
      )
        invalid();
      if (expectedCount !== undefined && (count !== expectedCount || pages !== expectedPages))
        invalid();
      expectedCount = count;
      expectedPages = pages;
      if (!Array.isArray(response.documents)) invalid();
      const rows = response.documents.flat() as unknown[];
      const expectedRows =
        count === 0 ? 0 : page < pages ? PAGE_LIMIT : count - (pages - 1) * PAGE_LIMIT;
      if (rows.length !== expectedRows) invalid();
      const tasks = rows.map((row) => {
        if (!row || typeof row !== 'object') invalid();
        const source = row as Record<string, unknown>;
        if (
          typeof source.id !== 'string' ||
          !UUID.test(source.id) ||
          Number(source.context_id) !== contextId
        )
          invalid();
        const parsedNumber = optionalInteger(source.document_number);
        const documentNumber =
          parsedNumber !== undefined && parsedNumber > 0 ? parsedNumber : undefined;
        const modified = isValidSalesBinderTimestampText(source.modified)
          ? Math.floor(Date.parse(source.modified) / 1000)
          : undefined;
        if ((modified !== undefined && modified < run.cutoff) || seen.has(source.id as string))
          invalid();
        if (documentNumber !== undefined && seenNumbers.has(documentNumber)) invalid();
        seen.add(source.id as string);
        if (documentNumber !== undefined) seenNumbers.add(documentNumber);
        const task: DocumentOffsetTask = {
          id: source.id as string,
          contextId,
          documentNumber,
          selectedModified: modified,
          status: documentNumber === undefined || modified === undefined ? 'failed' : 'pending',
          attempts: 0,
        };
        if (task.status === 'failed') task.errorCode = 'invalid_selection_record';
        const previous = existing.get(key(task));
        if (
          previous?.documentNumber !== undefined &&
          documentNumber !== undefined &&
          previous.documentNumber !== documentNumber
        )
          invalid();
        // A newly observed edit must requeue even a previously completed document.
        const merged =
          previous &&
          task.status !== 'failed' &&
          previous.errorCode !== 'invalid_selection_record' &&
          modified !== undefined &&
          (previous.selectedModified ?? 0) >= modified
            ? previous
            : task;
        existing.set(key(task), merged);
        return merged;
      });
      await guard();
      await deps.store.saveOffsetSyncTasks(run.runId, 'document', tasks);
      await execution.progress('discovery', 'page_saved', [...existing.values()]);
      if (page >= pages) {
        if (seen.size !== count) invalid();
        break;
      }
    }
  }
  run.discoveryComplete = true;
  run.updatedAt = execution.now();
  await guard();
  await deps.store.saveOffsetSyncRun(run);
}

function paginationInteger(value: unknown): number {
  const parsed = optionalInteger(value);
  if (parsed === undefined) invalid();
  return parsed;
}

function optionalInteger(value: unknown): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value)))
    return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function key(task: DocumentOffsetTask): string {
  return `${task.contextId}:${task.id}`;
}
function invalid(): never {
  throw new DocumentOffsetSyncError('invalid_discovery');
}
