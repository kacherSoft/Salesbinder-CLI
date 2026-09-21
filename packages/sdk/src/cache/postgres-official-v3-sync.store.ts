import type { PoolClient } from 'pg';
import type { DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';
import type { OCShippingPatch } from './postgres-oc-shipping.store.js';
import {
  applyOCShippingPatch,
  clearOCShippingEstimateUnknown,
  clearOCShippingAuthority,
  clearOCShippingDeletedSource,
  reconcileOCShippingAuthority,
} from './postgres-oc-shipping.store.js';
import {
  deleteOCShippingWarning,
  writeOCShippingWarning,
  type OCShippingWarning,
} from './postgres-oc-shipping-warning.store.js';
import type {
  OfficialV3SyncMarker,
  OfficialV3SyncPage,
  OfficialV3ShippingPrerequisite,
  OfficialV3SyncRun,
  OfficialV3SyncState,
  OfficialV3SyncStore,
  OfficialV3SyncTask,
} from './official-v3-sync.types.js';
import {
  OFFICIAL_V3_SYNC_RESOURCES,
} from './official-v3-sync.types.js';
import {
  createOfficialV3DocumentStockSignature,
  parseOfficialV3DocumentStockSignature,
  stockReconciliationItemIds,
  type OfficialV3DocumentStockSignature,
} from './official-v3-stock-reconciliation.js';
import {
  OFFICIAL_V3_SYNC_CURRENT_KEY,
  OFFICIAL_V3_SYNC_CURRENT_RUN_KEY,
  assertMarker,
  assertOfficialPage,
  assertOfficialRun,
  assertOfficialState,
  assertOfficialTask,
  officialPageKey,
  officialLatestReceiptKey,
  officialRunKey,
  officialTaskKey,
  officialTaskPrefix,
} from './official-v3-sync.validation.js';

type Transaction = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface PostgresOfficialV3SyncStoreOptions {
  withVerifiedWrite: Transaction;
  withReadOnlyTransaction: Transaction;
  accountIdentity: () => string;
  resolveDocument: (client: PoolClient, doc: DocumentRow) => Promise<DocumentRow>;
  resolveDocumentIdByApiId: (client: PoolClient, apiDocId: string) => Promise<string | null>;
  writeDocument: (
    client: PoolClient,
    doc: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[]
  ) => Promise<void>;
  deleteDocument: (client: PoolClient, docId: string) => Promise<void>;
  validateInventory: (item: ItemRow, rows: ItemStockLocationRow[]) => void;
  writeInventory: (
    client: PoolClient,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ) => Promise<void>;
  deleteApiInventory: (client: PoolClient, itemId: string) => Promise<void>;
}

export class PostgresOfficialV3SyncStore implements OfficialV3SyncStore {
  constructor(private readonly options: PostgresOfficialV3SyncStoreOptions) {}

  getState(): Promise<OfficialV3SyncState | null> {
    return this.options.withReadOnlyTransaction((client) => this.readState(client));
  }

  getRun(): Promise<OfficialV3SyncRun | null> {
    return this.options.withReadOnlyTransaction((client) => this.readCurrentRun(client));
  }

  async beginRun(run: OfficialV3SyncRun): Promise<void> {
    assertOfficialRun(run);
    this.assertAccount(run.accountIdentity);
    await this.options.withVerifiedWrite(async (client) => {
      const current = await this.readCurrentRun(client);
      if (current?.status === 'running' && current.runId !== run.runId) {
        throw new Error('An official V3 sync run is already running.');
      }
      const state = await this.readState(client, true);
      if (state && state.accountIdentity !== run.accountIdentity) {
        throw new Error('Official V3 sync account binding mismatch.');
      }
      if (run.entry.kind === 'since' && state && !canResumeInitialSinceRun(current, state, run)) {
        throw new Error('Official V3 sync since cannot replace existing state.');
      }
      await putJson(client, officialRunKey(run.runId), run);
      await putJson(client, OFFICIAL_V3_SYNC_CURRENT_RUN_KEY, run);
      if (!state) await putJson(client, OFFICIAL_V3_SYNC_CURRENT_KEY, initialState(run));
    });
  }

  async sealPage(
    runId: string,
    request: OfficialV3SyncPage['request'],
    page: Omit<OfficialV3SyncPage, 'request' | 'status' | 'firstGeneration' | 'lastGeneration'>,
    markers: readonly OfficialV3SyncMarker[]
  ): Promise<OfficialV3SyncRun> {
    markers.forEach(assertMarker);
    return this.options.withVerifiedWrite(async (client) => {
      const run = await this.requireRun(client, runId);
      const state = await this.requireState(client, true);
      if (page.page !== run.pageCount + 1) throw new Error('Official V3 sync page is out of order.');
      const existing = await readJson(client, officialPageKey(runId, page.page));
      if (existing) throw new Error('Official V3 sync page was already sealed.');
      const firstGeneration = state.nextGeneration;
      const reservedGenerations = Math.max(markers.length, 1);
      const fullPage: OfficialV3SyncPage = {
        ...page,
        request,
        firstGeneration,
        lastGeneration: firstGeneration + reservedGenerations - 1,
        status: 'sealed',
      };
      assertOfficialPage(fullPage);
      await putJson(client, officialPageKey(runId, page.page), fullPage);
      markers.forEach((marker, index) => {
        const task = markerTask(runId, page.page, index, firstGeneration + index, marker);
        assertOfficialTask(task);
      });
      for (let index = 0; index < markers.length; index++) {
        const task = markerTask(runId, page.page, index, firstGeneration + index, markers[index]!);
        await putJson(client, officialTaskKey(runId, task.taskId), task);
      }
      const timestamp = nowSeconds();
      const nextRun = {
        ...run,
        ingestionComplete: !page.hasMore,
        pageCount: page.page,
        updatedAt: timestamp,
      };
      const nextState = {
        ...state,
        ingestionCursor: page.nextCursor,
        nextGeneration: firstGeneration + reservedGenerations,
        updatedAt: timestamp,
      };
      await putJson(client, officialRunKey(runId), nextRun);
      await putJson(client, OFFICIAL_V3_SYNC_CURRENT_RUN_KEY, nextRun);
      await putJson(client, OFFICIAL_V3_SYNC_CURRENT_KEY, nextState);
      return nextRun;
    });
  }

  listTasks(runId: string): Promise<OfficialV3SyncTask[]> {
    return this.options.withReadOnlyTransaction((client) => this.readTasks(client, runId));
  }

  async saveTaskFailure(runId: string, task: OfficialV3SyncTask, code: string): Promise<void> {
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      await putJson(client, officialTaskKey(runId, task.taskId), {
        ...persisted,
        attempts: Math.max(persisted.attempts, task.attempts),
        status: 'failed',
        errorCode: code,
      });
    });
  }

  async markSupersededIfStale(runId: string, task: OfficialV3SyncTask): Promise<boolean> {
    return this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (await this.hasNewerReceipt(client, persisted)) {
        await this.complete(client, runId, persisted, 'superseded');
        return true;
      }
      return false;
    });
  }

  applyItemUpsert(
    runId: string,
    task: OfficialV3SyncTask,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ): Promise<void> {
    return this.applyInventory(runId, task, item, rows);
  }

  applyItemRefresh(
    runId: string,
    task: OfficialV3SyncTask,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ): Promise<void> {
    return this.applyInventory(runId, task, item, rows);
  }

  async applyItemDelete(runId: string, task: OfficialV3SyncTask): Promise<void> {
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (await this.completeIfStale(client, runId, persisted)) return;
      await this.options.deleteApiInventory(client, persisted.id);
      await this.complete(client, runId, persisted, 'done', task.attempts);
    });
  }

  async applyDocumentUpsert(
    runId: string,
    task: OfficialV3SyncTask,
    document: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[],
    shippingPatch?: OCShippingPatch | null,
    shippingWarning?: OCShippingWarning | null,
    stockSignature?: OfficialV3DocumentStockSignature | null,
    stockReconciliationNotBefore?: number,
    shippingPrerequisite?: OfficialV3ShippingPrerequisite | null
  ): Promise<void> {
    assertDocumentTask(task, document, lines);
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (await this.completeIfStale(client, runId, persisted)) return;
      const before = await this.readDocumentStockSignature(client, persisted.id);
      const resolved = await this.options.resolveDocument(client, document);
      const shippingPrerequisiteApplied = shippingPatch && shippingPrerequisite
        ? await this.alignShippingPrerequisite(client, shippingPrerequisite, shippingPatch)
        : true;
      const after = stockSignature ?? createOfficialV3DocumentStockSignature(resolved, lines);
      const stockItemIds = before.source === 'fallback'
        ? bootstrapStockReconciliationItemIds(before.signature, after)
        : stockReconciliationItemIds(before.signature, after);
      await this.options.writeDocument(
        client,
        resolved,
        lines.map((line) => ({ ...line, doc_id: resolved.doc_id }))
      );
      await reconcileOCShippingAuthority(
        client,
        resolved.api_doc_id ?? resolved.doc_id,
        resolved.associated_document_id ?? null
      );
      const deferredShippingWarning = shippingPatch && !shippingPrerequisiteApplied;
      const effectiveShippingWarning = shippingWarning ?? (deferredShippingWarning
        ? {
            contextId: resolved.context_id as 4 | 5,
            documentId: resolved.api_doc_id ?? resolved.doc_id,
            code: 'shipping_unknown' as const,
            updatedAt: nowSeconds(),
          }
        : null);
      if (effectiveShippingWarning) {
        if (effectiveShippingWarning.contextId !== resolved.context_id || effectiveShippingWarning.documentId !== (resolved.api_doc_id ?? resolved.doc_id)) {
          throw new Error('OC shipping warning does not match the document task.');
        }
        if (resolved.context_id === 5) await clearOCShippingAuthority(client, resolved.api_doc_id ?? resolved.doc_id);
        else await clearOCShippingEstimateUnknown(client, resolved.api_doc_id ?? resolved.doc_id);
        if (shippingPatch && !deferredShippingWarning) await applyOCShippingPatch(client, shippingPatch);
        await writeOCShippingWarning(client, effectiveShippingWarning);
      } else {
        if (shippingPatch) await applyOCShippingPatch(client, shippingPatch);
        if (resolved.context_id === 4 || resolved.context_id === 5) {
          await deleteOCShippingWarning(client, resolved.context_id, resolved.api_doc_id ?? resolved.doc_id);
        }
      }
      await this.writeDocumentStockSignature(client, persisted.id, after);
      if (stockItemIds.length > 0) {
        await this.queueStockReconciliationTasks(
          client, runId, persisted, stockItemIds,
          requireStockReconciliationNotBefore(stockReconciliationNotBefore)
        );
        await putJson(client, officialTaskKey(runId, persisted.taskId), {
          ...persisted,
          status: 'waiting_children',
          attempts: Math.max(persisted.attempts, task.attempts),
        });
      } else {
        await this.complete(client, runId, persisted, 'done', task.attempts);
      }
    });
  }

  async applyDocumentDelete(
    runId: string,
    task: OfficialV3SyncTask,
    stockReconciliationNotBefore?: number
  ): Promise<void> {
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (await this.completeIfStale(client, runId, persisted)) return;
      const resolvedDocId = await this.options.resolveDocumentIdByApiId(client, persisted.id);
      const before = await this.readDocumentStockSignature(client, persisted.id);
      const stockItemIds = stockReconciliationItemIds(before.signature, null);
      if (!before.signature && !resolvedDocId && persisted.resource !== 'estimate') {
        await this.saveTaskFailureInTransaction(client, runId, persisted, 'stock_history_missing');
        return;
      }
      await clearOCShippingDeletedSource(client, persisted.id);
      if (persisted.resource === 'invoice') await deleteOCShippingWarning(client, 5, persisted.id);
      if (persisted.resource === 'estimate') await deleteOCShippingWarning(client, 4, persisted.id);
      if (resolvedDocId) await this.options.deleteDocument(client, resolvedDocId);
      await this.deleteDocumentStockSignature(client, persisted.id);
      if (stockItemIds.length > 0) {
        await this.queueStockReconciliationTasks(
          client, runId, persisted, stockItemIds,
          requireStockReconciliationNotBefore(stockReconciliationNotBefore)
        );
        await putJson(client, officialTaskKey(runId, persisted.taskId), {
          ...persisted,
          status: 'waiting_children',
          attempts: Math.max(persisted.attempts, task.attempts),
        });
      } else {
        await this.complete(client, runId, persisted, 'done', task.attempts);
      }
    });
  }

  async retireLegacyItemRefreshTasks(runId: string): Promise<void> {
    await this.options.withVerifiedWrite(async (client) => {
      await this.requireRun(client, runId);
      let changed = false;
      for (const task of await this.readTasks(client, runId)) {
        if (isRetirableLegacyRefresh(task)) {
          await this.complete(client, runId, task, 'superseded', task.attempts);
          changed = true;
        }
      }
      if (changed) await this.completeWaitingParents(client, runId);
    });
  }

  async completeTaskGroup(runId: string, task: OfficialV3SyncTask): Promise<void> {
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (persisted.status !== 'waiting_children') return;
      await this.completeWaitingParents(client, runId, persisted.taskId);
    });
  }

  async advanceAppliedPrefix(_runId: string): Promise<OfficialV3SyncState | null> {
    return this.options.withVerifiedWrite(async (client) => {
      const state = await this.readState(client, true);
      if (!state) return null;
      const pages = await this.readAllPages(client);
      for (const page of pages) {
        if (page.lastGeneration <= state.appliedGeneration) continue;
        const tasks = (await this.readTasks(client, page.runId)).filter((task) => task.page === page.page);
        const complete = tasks.every((task) => task.status === 'done' || task.status === 'superseded');
        if (!complete) {
          await putJson(client, officialPageKey(page.runId, page.page), { ...page, status: 'blocked' });
          return state;
        }
        const nextState = {
          ...state,
          appliedCursor: page.nextCursor,
          appliedGeneration: page.lastGeneration,
          updatedAt: nowSeconds(),
        };
        await putJson(client, officialPageKey(page.runId, page.page), { ...page, status: 'complete' });
        await putJson(client, OFFICIAL_V3_SYNC_CURRENT_KEY, nextState);
        Object.assign(state, nextState);
      }
      return state;
    });
  }

  async finishRun(run: OfficialV3SyncRun): Promise<void> {
    assertOfficialRun(run);
    await this.options.withVerifiedWrite(async (client) => {
      const current = await this.requireRun(client, run.runId, false);
      if (run.status === 'success') {
        const tasks = await this.readTasks(client, run.runId);
        if (!run.ingestionComplete || tasks.some((task) => !['done', 'superseded'].includes(task.status))) {
          throw new Error('Official V3 sync success requires all tasks to have receipts.');
        }
      }
      await putJson(client, officialRunKey(run.runId), { ...current, ...run });
      await putJson(client, OFFICIAL_V3_SYNC_CURRENT_RUN_KEY, { ...current, ...run });
    });
  }

  private async applyInventory(
    runId: string,
    task: OfficialV3SyncTask,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ): Promise<void> {
    if (task.id !== item.item_id) throw new Error('Official V3 item identity mismatch.');
    this.options.validateInventory(item, rows);
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, task);
      if (await this.completeIfStale(client, runId, persisted)) return;
      await this.options.writeInventory(client, item, rows);
      await this.complete(client, runId, persisted, 'done', task.attempts);
    });
  }

  /**
   * A linked invoice may be current while its estimate marker is absent from
   * the same partial catch-up. Align only an older exact cached estimate using
   * the detail response that already proved the shipping relation.
   */
  private async alignShippingPrerequisite(
    client: PoolClient,
    prerequisite: OfficialV3ShippingPrerequisite,
    patch: OCShippingPatch
  ): Promise<boolean> {
    return alignOCShippingPrerequisite(client, prerequisite, patch, {
      resolveDocument: this.options.resolveDocument,
      writeDocument: this.options.writeDocument,
      onAligned: () => this.writeDocumentStockSignature(client, patch.estimateId, prerequisite.stockSignature),
    });
  }

  private async readState(client: PoolClient, forUpdate = false): Promise<OfficialV3SyncState | null> {
    const state = await readJson(client, OFFICIAL_V3_SYNC_CURRENT_KEY, forUpdate);
    if (state !== null) {
      assertOfficialState(state);
      this.assertAccount(state.accountIdentity);
    }
    return state;
  }

  private async requireState(client: PoolClient, forUpdate = false): Promise<OfficialV3SyncState> {
    const state = await this.readState(client, forUpdate);
    if (!state) throw new Error('Official V3 sync state does not exist.');
    return state;
  }

  private async readCurrentRun(client: PoolClient): Promise<OfficialV3SyncRun | null> {
    const run = await readJson(client, OFFICIAL_V3_SYNC_CURRENT_RUN_KEY);
    if (run !== null) {
      assertOfficialRun(run);
      this.assertAccount(run.accountIdentity);
    }
    return run;
  }

  private async requireRun(client: PoolClient, runId: string, active = true): Promise<OfficialV3SyncRun> {
    const run = await this.readCurrentRun(client);
    if (!run || run.runId !== runId || (active && run.status !== 'running')) {
      throw new Error('Official V3 sync run is not current and active.');
    }
    return run;
  }

  private async readRunById(client: PoolClient, runId: string): Promise<OfficialV3SyncRun> {
    const run = await readJson(client, officialRunKey(runId));
    assertOfficialRun(run);
    this.assertAccount(run.accountIdentity);
    return run;
  }

  private async readTasks(client: PoolClient, runId: string): Promise<OfficialV3SyncTask[]> {
    await this.readRunById(client, runId);
    const rows = await selectPrefix(client, officialTaskPrefix(runId));
    return rows.map((row) => {
      const task = parseJson(row.value);
      assertOfficialTask(task);
      return task;
    }).sort(compareTasks);
  }

  private async readAllPages(client: PoolClient): Promise<OfficialV3SyncPage[]> {
    const rows = await selectPrefix(client, 'official_v3_sync.page.v1:');
    return rows.map((row) => {
      const page = parseJson(row.value);
      assertOfficialPage(page);
      return page;
    }).sort((left, right) => left.firstGeneration - right.firstGeneration || left.page - right.page);
  }

  private async requireTask(
    client: PoolClient,
    runId: string,
    task: OfficialV3SyncTask
  ): Promise<OfficialV3SyncTask> {
    await this.requireRun(client, runId);
    const persisted = await readJson(client, officialTaskKey(runId, task.taskId), true);
    assertOfficialTask(persisted);
    if (persisted.runId !== runId || persisted.taskId !== task.taskId) {
      throw new Error('Official V3 sync task identity mismatch.');
    }
    return persisted;
  }

  private async completeIfStale(
    client: PoolClient,
    runId: string,
    task: OfficialV3SyncTask
  ): Promise<boolean> {
    if (!(await this.hasNewerReceipt(client, task))) return false;
    await this.complete(client, runId, task, 'superseded');
    return true;
  }

  private async saveTaskFailureInTransaction(
    client: PoolClient,
    runId: string,
    task: OfficialV3SyncTask,
    code: string
  ): Promise<void> {
    await putJson(client, officialTaskKey(runId, task.taskId), {
      ...task,
      status: 'failed',
      errorCode: code,
    });
  }

  private async hasNewerReceipt(client: PoolClient, task: OfficialV3SyncTask): Promise<boolean> {
    const latest = await readJson(client, officialLatestReceiptKey(task.resource, task.id));
    if (!latest) return false;
    const receipt = latest as { generation?: unknown; operation?: unknown };
    if (typeof receipt.generation !== 'number' || receipt.generation <= task.generation) return false;
    if (task.kind === 'stock_reconciliation') return receipt.operation === 'delete';
    return true;
  }

  private async readDocumentStockSignature(
    client: PoolClient,
    apiDocId: string
  ): Promise<DocumentStockSignatureRead> {
    const persisted = await readJson(client, officialDocumentStockSignatureKey(apiDocId));
    if (persisted !== null) {
      const signature = parseOfficialV3DocumentStockSignature(persisted);
      if (!signature) throw new Error('Invalid persisted official V3 document stock signature.');
      return { signature, source: 'sidecar' };
    }
    const resolvedDocId = await this.options.resolveDocumentIdByApiId(client, apiDocId);
    if (!resolvedDocId) return { signature: null, source: 'missing' };
    const doc = await client.query<{
      context_id: number;
      is_cancelled: number | null;
      status_name: string | null;
      status_id: number | null;
      date_sent: string | null;
    }>('SELECT context_id, is_cancelled, status_name, status_id, date_sent FROM documents WHERE doc_id = $1', [resolvedDocId]);
    if (!doc.rows[0]) return { signature: null, source: 'missing' };
    const lines = await client.query<{
      item_id: string;
      quantity: string | number | null;
      quantity_received: string | number | null;
      quantity_shipped: string | number | null;
      item_location: string | null;
    }>(
      `SELECT item_id, quantity, quantity_received, quantity_shipped, item_location
       FROM item_documents WHERE doc_id = $1`,
      [resolvedDocId]
    );
    return { signature: createOfficialV3DocumentStockSignature(
      {
        context_id: doc.rows[0].context_id,
        is_cancelled: doc.rows[0].is_cancelled,
        status_name: doc.rows[0].status_name,
        status_id: doc.rows[0].status_id,
        date_sent: doc.rows[0].date_sent,
      } as Pick<DocumentRow, 'context_id' | 'is_cancelled' | 'status_name' | 'status_id' | 'date_sent'>,
      lines.rows.map((line) => ({
        item_id: line.item_id,
        quantity: numeric(line.quantity),
        quantity_received: numeric(line.quantity_received),
        quantity_shipped: numeric(line.quantity_shipped),
        item_location: line.item_location,
      }))
    ), source: 'fallback' };
  }

  private async writeDocumentStockSignature(
    client: PoolClient,
    apiDocId: string,
    signature: OfficialV3DocumentStockSignature
  ): Promise<void> {
    await putJson(client, officialDocumentStockSignatureKey(apiDocId), signature);
  }

  private async deleteDocumentStockSignature(client: PoolClient, apiDocId: string): Promise<void> {
    await client.query('DELETE FROM cache_meta WHERE key = $1', [
      officialDocumentStockSignatureKey(apiDocId),
    ]);
  }

  private async queueStockReconciliationTasks(
    client: PoolClient,
    runId: string,
    parent: OfficialV3SyncTask,
    itemIds: readonly string[],
    notBefore: number
  ): Promise<void> {
    const unique = [...new Set(itemIds)].sort();
    for (let index = 0; index < unique.length; index++) {
      const id = unique[index]!;
      const child: OfficialV3SyncTask = {
        taskId: `${parent.taskId}:stock:${id}`,
        runId,
        page: parent.page,
        ordinal: parent.ordinal,
        generation: parent.generation,
        kind: 'stock_reconciliation',
        parentTaskId: parent.taskId,
        resource: 'item',
        id,
        operation: 'refresh',
        status: 'pending',
        attempts: 0,
        notBefore,
      };
      assertOfficialTask(child);
      const key = officialTaskKey(runId, child.taskId);
      const existing = await readJson(client, key);
      if (existing) {
        assertOfficialTask(existing);
        if (existing.status === 'done' || existing.status === 'superseded') continue;
      }
      await putJson(client, key, existing ? { ...child, attempts: (existing as OfficialV3SyncTask).attempts } : child);
    }
  }

  private async completeWaitingParents(
    client: PoolClient,
    runId: string,
    taskId?: string
  ): Promise<void> {
    const tasks = await this.readTasks(client, runId);
    const parents = tasks.filter(
      (task) => task.status === 'waiting_children' && (!taskId || task.taskId === taskId)
    );
    for (const parent of parents) {
      const children = tasks.filter((child) => child.parentTaskId === parent.taskId);
      if (
        children.length > 0 &&
        children.every((child) => child.status === 'done' || child.status === 'superseded')
      ) {
        await this.complete(client, runId, parent, 'done', parent.attempts);
      }
    }
  }

  private async complete(
    client: PoolClient,
    runId: string,
    task: OfficialV3SyncTask,
    status: 'done' | 'superseded',
    attempts = task.attempts
  ): Promise<void> {
    const done = { ...task, status, attempts: Math.max(task.attempts, attempts) };
    delete done.errorCode;
    await putJson(client, officialTaskKey(runId, task.taskId), done);
    if (status === 'done') {
      await putLatestReceipt(client, runId, task);
    }
  }

  private assertAccount(accountIdentity: string): void {
    if (accountIdentity !== this.options.accountIdentity()) {
      throw new Error('Official V3 sync account binding mismatch.');
    }
  }
}

export async function alignOCShippingPrerequisite(
  client: PoolClient,
  prerequisite: OfficialV3ShippingPrerequisite,
  patch: OCShippingPatch,
  options: Pick<PostgresOfficialV3SyncStoreOptions, 'resolveDocument' | 'writeDocument'> & {
    onAligned?: () => Promise<void>;
  }
): Promise<boolean> {
  assertShippingPrerequisite(prerequisite, patch);
  const cached = await client.query<{
    api_doc_id: string | null;
    context_id: number;
    doc_number: number;
    customer_id: string | null;
    modified: string | number;
  }>(
    `SELECT api_doc_id, context_id, doc_number, customer_id, modified
     FROM documents WHERE api_doc_id = $1 FOR UPDATE`,
    [patch.estimateId]
  );
  const existing = cached.rows[0];
  if (existing) {
    if (
      existing.api_doc_id !== patch.estimateId ||
      existing.context_id !== 4 ||
      existing.doc_number !== patch.estimateNumber ||
      Number(existing.modified) > patch.estimateModified ||
      (Number(existing.modified) === patch.estimateModified && existing.customer_id !== patch.customerId)
    ) return false;
    if (Number(existing.modified) === patch.estimateModified) return true;
  }
  const resolved = await options.resolveDocument(client, prerequisite.document);
  assertShippingPrerequisite({ ...prerequisite, document: resolved }, patch);
  await options.writeDocument(
    client,
    resolved,
    prerequisite.lines.map((line) => ({ ...line, doc_id: resolved.doc_id }))
  );
  await options.onAligned?.();
  return true;
}

function initialState(run: OfficialV3SyncRun): OfficialV3SyncState {
  return {
    version: 1,
    accountIdentity: run.accountIdentity,
    resources: OFFICIAL_V3_SYNC_RESOURCES,
    appliedGeneration: 0,
    nextGeneration: 1,
    coverage: 'partial_catch_up',
    updatedAt: run.updatedAt,
  };
}

function markerTask(
  runId: string,
  page: number,
  ordinal: number,
  generation: number,
  marker: OfficialV3SyncMarker
): OfficialV3SyncTask {
  return {
    taskId: `m:${page}:${ordinal}`,
    runId,
    page,
    ordinal,
    generation,
    kind: 'marker',
    resource: marker.resource,
    id: marker.id,
    operation: marker.operation,
    status: 'pending',
    attempts: 0,
  };
}

function officialDocumentStockSignatureKey(apiDocId: string): string {
  return `official_v3_sync.document_stock.v1:${apiDocId}`;
}

function numeric(value: string | number | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface DocumentStockSignatureRead {
  signature: OfficialV3DocumentStockSignature | null;
  source: 'sidecar' | 'fallback' | 'missing';
}

function bootstrapStockReconciliationItemIds(
  before: OfficialV3DocumentStockSignature | null,
  after: OfficialV3DocumentStockSignature
): string[] {
  const contextId = after.contextId ?? before?.contextId;
  if (contextId !== 5 && contextId !== 11) return [];
  if (before?.stockState !== 'active' && after.stockState !== 'active') return [];
  return [...new Set([...(before?.lines ?? []), ...after.lines].map((line) => line.itemId))].sort();
}

function requireStockReconciliationNotBefore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Official V3 stock reconciliation eligibility time is invalid.');
  }
  return value;
}

function canResumeInitialSinceRun(
  current: OfficialV3SyncRun | null,
  state: OfficialV3SyncState,
  run: OfficialV3SyncRun
): boolean {
  return (
    current?.runId === run.runId &&
    current.entry.kind === 'since' &&
    current.entry.value === run.entry.value &&
    current.pageCount === 0 &&
    run.pageCount === 0 &&
    !state.ingestionCursor
  );
}

function isRetirableLegacyRefresh(task: OfficialV3SyncTask): boolean {
  return (
    task.kind === 'item_refresh' &&
    task.resource === 'item' &&
    task.operation === 'refresh' &&
    (task.status === 'pending' || task.status === 'failed')
  );
}

function assertDocumentTask(
  task: OfficialV3SyncTask,
  document: DocumentRow,
  lines: Omit<ItemDocumentRow, 'id'>[]
): void {
  if (document.api_doc_id !== task.id || document.doc_id !== task.id || document.cache_source !== 'api') {
    throw new Error('Official V3 document identity mismatch.');
  }
  if (lines.some((line) => line.doc_id !== document.doc_id)) {
    throw new Error('Official V3 document line identity mismatch.');
  }
}

function assertShippingPrerequisite(
  prerequisite: OfficialV3ShippingPrerequisite,
  patch: OCShippingPatch
): void {
  const { document, lines, stockSignature } = prerequisite;
  if (
    document.api_doc_id !== patch.estimateId ||
    document.doc_id !== patch.estimateId ||
    document.cache_source !== 'api' ||
    document.context_id !== 4 ||
    document.doc_number !== patch.estimateNumber ||
    document.customer_id !== patch.customerId ||
    document.modified !== patch.estimateModified ||
    stockSignature.contextId !== 4 ||
    lines.some((line) => line.doc_id !== document.doc_id)
  ) {
    throw new Error('Official V3 shipping prerequisite identity mismatch.');
  }
}

async function readJson(client: PoolClient, key: string, forUpdate = false): Promise<unknown> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM cache_meta WHERE key = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [key]
  );
  return result.rows[0] ? parseJson(result.rows[0].value) : null;
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Invalid persisted official V3 sync state.');
  }
}

async function putJson(client: PoolClient, key: string, value: unknown): Promise<void> {
  await client.query(
    'INSERT INTO cache_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}

async function putLatestReceipt(
  client: PoolClient,
  runId: string,
  task: OfficialV3SyncTask
): Promise<void> {
  const key = officialLatestReceiptKey(task.resource, task.id);
  const existing = await readJson(client, key);
  if (existing && typeof (existing as { generation?: unknown }).generation === 'number') {
    if ((existing as { generation: number }).generation >= task.generation) return;
  }
  await putJson(client, key, {
    generation: task.generation,
    runId,
    taskId: task.taskId,
    operation: task.operation,
  });
}

async function selectPrefix(client: PoolClient, prefix: string): Promise<{ key: string; value: string }[]> {
  const result = await client.query<{ key: string; value: string }>(
    'SELECT key, value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key',
    [prefix]
  );
  return result.rows;
}

function compareTasks(left: OfficialV3SyncTask, right: OfficialV3SyncTask): number {
  return left.page - right.page || left.ordinal - right.ordinal || left.taskId.localeCompare(right.taskId);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
