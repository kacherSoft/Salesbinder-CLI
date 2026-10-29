import { PostgresOfficialV3SyncStore } from '../postgres-official-v3-sync.store.js';
import type { OfficialV3SyncRun, OfficialV3SyncTask } from '../official-v3-sync.types.js';
import { officialLatestReceiptKey, officialTaskKey } from '../official-v3-sync.validation.js';
import type { DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from '../types.js';

const accountIdentity = 'salesbinder:acme';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const oldItemId = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const apiDocId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const localDocId = '67a862bf-8ba2-43d7-8706-4d0a048e9007';

describe('PostgresOfficialV3SyncStore', () => {
  it('atomically records verified absence without rewriting the source task operation', async () => {
    const h = harness();
    const run = officialRun();
    const upsert = task(run.runId, 'absent-item', 1, 'upsert');
    h.seedRun(run);
    h.seedTask(upsert, 'failed');

    await h.store.applyItemAbsence(run.runId, { ...upsert, attempts: 2 });

    expect(h.deletedItems).toEqual([itemId]);
    expect(h.task(upsert)).toMatchObject({
      kind: 'marker',
      operation: 'upsert',
      status: 'done',
      attempts: 2,
    });
    expect(JSON.parse(h.meta.get(officialLatestReceiptKey('item', itemId))!)).toEqual({
      generation: 1,
      runId: run.runId,
      taskId: upsert.taskId,
      operation: 'absent',
      sourceOperation: 'upsert',
    });
    expect(h.event(upsert)).toMatchObject({ version: 1, runId: run.runId, taskId: upsert.taskId,
      resource: 'item', id: itemId, operation: 'absent', observedAt: expect.any(Number),
      stockHistory: 'not_applicable', uncertainty: null });
  });

  it.each([
    {
      label: 'source delete marker',
      change: { operation: 'delete' as const },
    },
    {
      label: 'legacy item refresh',
      change: { kind: 'item_refresh' as const, operation: 'refresh' as const },
    },
    {
      label: 'document marker',
      change: { resource: 'invoice' as const },
    },
  ])('rejects verified absence for a $label', async ({ change }) => {
    const h = harness();
    const run = officialRun();
    const invalid = { ...task(run.runId, `invalid-${change.operation ?? change.resource}`, 1, 'upsert'), ...change };
    h.seedRun(run);
    h.seedTask(invalid);

    await expect(h.store.applyItemAbsence(run.runId, invalid)).rejects.toThrow(
      'Official V3 verified item absence task is invalid.'
    );

    expect(h.deletedItems).toEqual([]);
    expect(h.task(invalid)).toMatchObject({ status: 'pending' });
    expect(h.meta.has(officialLatestReceiptKey(invalid.resource, invalid.id))).toBe(false);
  });

  it('does not remove inventory when a newer same-item receipt already exists', async () => {
    const h = harness();
    const run = officialRun();
    const stale = task(run.runId, 'stale-absence', 1, 'upsert');
    h.seedRun(run);
    h.seedTask(stale, 'failed');
    h.meta.set(officialLatestReceiptKey('item', itemId), JSON.stringify({
      generation: 2,
      runId: run.runId,
      taskId: 'newer-item',
      operation: 'upsert',
    }));

    await h.store.applyItemAbsence(run.runId, { ...stale, attempts: 2 });

    expect(h.deletedItems).toEqual([]);
    expect(h.task(stale)).toMatchObject({ operation: 'upsert', status: 'superseded' });
    expect(h.event(stale)).toBeNull();
  });

  it.each(['done', 'superseded'] as const)(
    'does not repeat removal for an already %s absence task',
    async (status) => {
      const h = harness();
      const run = officialRun();
      const completed = task(run.runId, `already-${status}`, 1, 'upsert');
      h.seedRun(run);
      h.seedTask(completed, status);

      await h.store.applyItemAbsence(run.runId, completed);

      expect(h.deletedItems).toEqual([]);
      expect(h.task(completed)).toMatchObject({ operation: 'upsert', status });
    }
  );

  it('allows a newer absence receipt to supersede stale stock reconciliation', async () => {
    const h = harness();
    const run = officialRun();
    const stockTask: OfficialV3SyncTask = {
      ...task(run.runId, 'stock-refresh', 1, 'refresh'),
      kind: 'stock_reconciliation',
      operation: 'refresh',
      parentTaskId: 'document-parent',
      notBefore: 100,
    };
    h.seedRun(run);
    h.seedTask(stockTask, 'failed');
    h.meta.set(officialLatestReceiptKey('item', itemId), JSON.stringify({
      generation: 2,
      runId: run.runId,
      taskId: 'newer-absence',
      operation: 'absent',
      sourceOperation: 'upsert',
    }));

    await expect(h.store.markSupersededIfStale(run.runId, stockTask)).resolves.toBe(true);

    expect(h.task(stockTask)).toMatchObject({ status: 'superseded' });
    expect(h.deletedItems).toEqual([]);
  });

  it('records stock-reconciliation absence without rewriting its refresh operation', async () => {
    const h = harness();
    const run = officialRun();
    const stockTask: OfficialV3SyncTask = {
      ...task(run.runId, 'stock-absence', 1, 'refresh'),
      kind: 'stock_reconciliation',
      operation: 'refresh',
      parentTaskId: 'document-parent',
      notBefore: 100,
    };
    h.seedRun(run);
    h.seedTask(stockTask);

    await h.store.applyItemAbsence(run.runId, stockTask);

    expect(h.deletedItems).toEqual([itemId]);
    expect(h.task(stockTask)).toMatchObject({ operation: 'refresh', status: 'done' });
    expect(JSON.parse(h.meta.get(officialLatestReceiptKey('item', itemId))!)).toMatchObject({
      operation: 'absent',
      sourceOperation: 'refresh',
    });
  });

  it('fails closed before removal when the latest receipt is malformed', async () => {
    const h = harness();
    const run = officialRun();
    const upsert = task(run.runId, 'malformed-receipt', 1, 'upsert');
    h.seedRun(run);
    h.seedTask(upsert);
    h.meta.set(officialLatestReceiptKey('item', itemId), JSON.stringify({
      generation: null,
      runId: run.runId,
      taskId: 'bad-receipt',
    }));

    await expect(h.store.applyItemAbsence(run.runId, upsert)).rejects.toThrow(
      'Invalid persisted official V3 latest receipt.'
    );

    expect(h.deletedItems).toEqual([]);
    expect(h.task(upsert)).toMatchObject({ operation: 'upsert', status: 'pending' });
  });

  it('marks stale retry work superseded from the latest receipt key without mutating cache', async () => {
    const h = harness();
    const run = officialRun();
    const oldDelete = task(run.runId, 'old-delete', 1, 'delete');
    const newUpsert = task(run.runId, 'new-upsert', 2, 'upsert');
    h.seedRun(run);
    h.seedTask(oldDelete, 'failed');
    h.seedTask(newUpsert, 'done');
    h.meta.set(officialLatestReceiptKey('item', itemId), JSON.stringify({
      generation: newUpsert.generation,
      runId: run.runId,
      taskId: newUpsert.taskId,
    }));

    await expect(h.store.markSupersededIfStale(run.runId, oldDelete)).resolves.toBe(true);

    expect(h.deletedItems).toEqual([]);
    expect(h.task(oldDelete)).toMatchObject({ status: 'superseded' });
  });

  it('queues stock reconciliation children with the caller-provided eligibility time', async () => {
    const h = harness();
    const run = officialRun();
    const upsertTask = task(run.runId, 'upsert-doc', 1, 'upsert', 'invoice', apiDocId);
    h.seedRun(run);
    h.seedTask(upsertTask);

    await h.store.applyDocumentUpsert(
      run.runId, upsertTask, document(apiDocId), [line(apiDocId, oldItemId)],
      undefined, undefined, undefined, 130
    );

    expect(h.documentWrites).toEqual([{ docId: apiDocId, itemIds: [oldItemId] }]);
    expect(h.task(upsertTask)).toMatchObject({ status: 'waiting_children' });
    expect(await h.store.listTasks(run.runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'stock_reconciliation', id: oldItemId, notBefore: 130, status: 'pending',
      }),
    ]));
    expect(h.client.query).not.toHaveBeenCalledWith(
      'SELECT item_id FROM item_documents WHERE doc_id = $1',
      expect.anything()
    );
  });

  it.each(['invoice', 'purchase_order'] as const)('resumes a failed %s deletion and preserves missing stock history', async (resource) => {
    const h = harness();
    const run = officialRun();
    const deleteTask = task(run.runId, 'delete-doc', 1, 'delete', resource, apiDocId);
    h.seedRun(run);
    h.seedTask(deleteTask, 'failed');
    if (resource === 'invoice') h.apiDocuments.set(apiDocId, localDocId);
    await h.store.applyDocumentDelete(run.runId, { ...deleteTask, attempts: 2 });
    expect(h.task(deleteTask)).toMatchObject({ status: 'done', attempts: 2 });
    expect(h.task(deleteTask).errorCode).toBeUndefined();
    expect(await h.store.listTasks(run.runId)).toHaveLength(1);
    expect(h.event(deleteTask)).toMatchObject({ resource, id: apiDocId, operation: 'delete',
      stockHistory: 'unknown', uncertainty: 'stock_history_missing' });
    expect(h.deletedDocuments).toEqual(resource === 'invoice' ? [localDocId] : []);
    const first = h.meta.get(eventKey(deleteTask));
    await h.store.applyDocumentDelete(run.runId, { ...deleteTask, attempts: 3 });
    expect(h.meta.get(eventKey(deleteTask))).toBe(first);
  });

  it('advances the applied cursor after an unknown-history deletion resumes', async () => {
    const h = harness();
    const run = officialRun();
    const deletion = task(run.runId, 'stuck-delete', 1, 'delete', 'invoice', apiDocId);
    h.seedRun(run);
    h.seedTask(deletion, 'failed');
    h.meta.set(`official_v3_sync.page.v1:${run.runId}:0000000001`, JSON.stringify({
      runId: run.runId, page: 1, firstGeneration: 1, lastGeneration: 1,
      request: run.entry, nextCursor: 'cursor-1', hasMore: false, markerCount: 1,
      status: 'blocked', responseHash: `sha256:${'0'.repeat(64)}`,
    }));
    await h.store.applyDocumentDelete(run.runId, { ...deletion, attempts: 2 });
    await expect(h.store.advanceAppliedPrefix(run.runId)).resolves.toMatchObject({
      appliedCursor: 'cursor-1', appliedGeneration: 1, coverage: 'partial_catch_up',
    });
    expect(h.event(deletion)).toMatchObject({ stockHistory: 'unknown', uncertainty: 'stock_history_missing' });
  });

  it.each([['invoice', 5], ['purchase_order', 11]] as const)(
    'waits for exact stock reconciliation before recording a known-history %s deletion', async (resource, contextId) => {
      const h = harness();
      const run = officialRun();
      const deletion = task(run.runId, 'known-doc', 1, 'delete', resource, apiDocId);
      h.seedRun(run);
      h.seedTask(deletion);
      h.meta.set(`official_v3_sync.document_stock.v1:${apiDocId}`, JSON.stringify({
        version: 1, contextId, cancelled: false, stockState: 'active', dateSent: null,
        lines: [{ itemId: oldItemId, quantity: 1, quantityReceived: null, quantityShipped: null,
          itemLocation: null, locationId: null, variationLocationId: null }],
      }));
      await h.store.applyDocumentDelete(run.runId, deletion, 130);
      expect(h.task(deletion).status).toBe('waiting_children');
      expect(h.event(deletion)).toBeNull();
      const child = (await h.store.listTasks(run.runId)).find((entry) => entry.parentTaskId === deletion.taskId)!;
      expect(child).toMatchObject({ id: oldItemId, status: 'pending', notBefore: 130 });
      await h.store.applyDocumentDelete(run.runId, deletion, 130);
      expect((await h.store.listTasks(run.runId)).filter((entry) => entry.parentTaskId === deletion.taskId)).toHaveLength(1);
      h.seedTask(child, 'done');
      await h.store.completeTaskGroup(run.runId, deletion);
      expect(h.task(deletion).status).toBe('done');
      expect(h.event(deletion)).toMatchObject({ resource, stockHistory: 'known', uncertainty: null });
    }
  );

  it.each(['item', 'estimate'] as const)('records an idempotent %s delete marker', async (resource) => {
    const h = harness();
    const run = officialRun();
    const deletion = task(run.runId, 'simple-delete', 1, 'delete', resource, itemId);
    h.seedRun(run);
    h.seedTask(deletion);
    const apply = () => resource === 'item' ? h.store.applyItemDelete(run.runId, deletion)
      : h.store.applyDocumentDelete(run.runId, deletion);
    await apply();
    const event = h.meta.get(eventKey(deletion));
    await apply();
    expect(h.meta.get(eventKey(deletion))).toBe(event);
    expect(h.event(deletion)).toMatchObject({ resource, operation: 'delete', stockHistory: 'not_applicable', uncertainty: null });
    if (resource === 'item') expect(h.deletedItems).toEqual([itemId]);
  });

  it('rolls back deletion and completion when audit insertion fails', async () => {
    const h = harness();
    const run = officialRun();
    const deletion = task(run.runId, 'rollback-delete', 1, 'delete');
    h.seedRun(run);
    h.seedTask(deletion);
    h.failEventWrite = true;
    await expect(h.store.applyItemDelete(run.runId, deletion)).rejects.toThrow('event write failed');
    expect(h.deletedItems).toEqual([]);
    expect(h.task(deletion).status).toBe('pending');
    expect(h.event(deletion)).toBeNull();
    expect(h.meta.has(officialLatestReceiptKey('item', itemId))).toBe(false);
  });

  it('retires unfinished legacy item refresh children without inventory writes or latest item receipts', async () => {
    const h = harness();
    const run = officialRun();
    const parent = task(run.runId, 'doc-parent', 1, 'upsert', 'invoice', apiDocId);
    const pendingChild = legacyRefresh(run.runId, parent, oldItemId, 'pending');
    const failedChild = legacyRefresh(run.runId, parent, itemId, 'failed');
    const completedChild = legacyRefresh(run.runId, parent, '37b6ffdb-7458-47db-a945-fc1f6b81c665', 'done');
    const failedSource = task(run.runId, 'source-failed', 4, 'upsert', 'item', itemId);
    h.seedRun(run);
    h.seedTask(parent, 'waiting_children');
    h.seedTask(pendingChild, 'pending');
    h.seedTask(failedChild, 'failed');
    h.seedTask(completedChild, 'done');
    h.seedTask(failedSource, 'failed');

    await h.store.retireLegacyItemRefreshTasks(run.runId);

    expect(h.inventoryWrites).toEqual([]);
    expect(h.task(pendingChild)).toMatchObject({ status: 'superseded' });
    expect(h.task(failedChild)).toMatchObject({ status: 'superseded' });
    expect(h.task(completedChild)).toMatchObject({ status: 'done' });
    expect(h.task(parent)).toMatchObject({ status: 'done' });
    expect(h.task(failedSource)).toMatchObject({ status: 'failed' });
    expect(h.meta.has(officialLatestReceiptKey('item', oldItemId))).toBe(false);
    expect(h.meta.has(officialLatestReceiptKey('item', itemId))).toBe(false);
  });

  it('rolls back inventory writes and task receipts when an atomic mutation fails', async () => {
    const h = harness();
    const run = officialRun();
    const upsert = task(run.runId, 'upsert-item', 1, 'upsert');
    h.seedRun(run);
    h.seedTask(upsert);
    h.failInventoryWrite = true;

    await expect(
      h.store.applyItemUpsert(run.runId, upsert, item(itemId), [stock(itemId)])
    ).rejects.toThrow('inventory write failed');

    expect(h.inventoryWrites).toEqual([]);
    expect(h.task(upsert)).toMatchObject({ status: 'pending' });
    expect(h.meta.has(officialLatestReceiptKey('item', itemId))).toBe(false);
  });
});

function harness() {
  let beforeMeta = new Map<string, string>();
  const meta = new Map<string, string>();
  const apiDocuments = new Map<string, string>();
  const documentRefs = new Map<string, string[]>();
  const deletedDocuments: string[] = [];
  const deletedItems: string[] = [];
  const inventoryWrites: string[] = [];
  const documentWrites: { docId: string; itemIds: string[] }[] = [];
  let failInventoryWrite = false;
  let failEventWrite = false;
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'ROLLBACK') meta.clear();
      if (sql.startsWith('SELECT value FROM cache_meta')) {
        const value = meta.get(String(params[0]));
        return { rows: value ? [{ value }] : [] };
      }
      if (sql.startsWith('SELECT key, value FROM cache_meta WHERE starts_with')) {
        return {
          rows: [...meta.entries()]
            .filter(([key]) => key.startsWith(String(params[0])))
            .map(([key, value]) => ({ key, value })),
        };
      }
      if (sql.startsWith('INSERT INTO cache_meta')) {
        if (String(params[0]).startsWith('official_v3_sync.deletion_event.v1:') && failEventWrite) throw new Error('event write failed');
        if (sql.includes('DO NOTHING') && meta.has(String(params[0]))) return { rows: [] };
        meta.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT item_id FROM item_documents')) {
        return { rows: (documentRefs.get(String(params[0])) ?? []).map((item_id) => ({ item_id })) };
      }
      return { rows: [] };
    }),
  };
  const store = new PostgresOfficialV3SyncStore({
    accountIdentity: () => accountIdentity,
    withReadOnlyTransaction: (run) => run(client as never),
    withVerifiedWrite: async (run) => {
      beforeMeta = new Map(meta);
      const beforeDeletedItems = deletedItems.length;
      const beforeDeletedDocuments = deletedDocuments.length;
      try {
        return await run(client as never);
      } catch (error) {
        meta.clear();
        for (const entry of beforeMeta) meta.set(...entry);
        deletedItems.length = beforeDeletedItems;
        deletedDocuments.length = beforeDeletedDocuments;
        throw error;
      }
    },
    resolveDocument: async (_client, doc) => doc,
    resolveDocumentIdByApiId: async (_client, id) => apiDocuments.get(id) ?? null,
    writeDocument: async (_client, doc, lines) => {
      documentWrites.push({ docId: doc.doc_id, itemIds: lines.map((line) => line.item_id) });
    },
    deleteDocument: async (_client, id) => {
      deletedDocuments.push(id);
    },
    validateInventory: () => undefined,
    writeInventory: async (_client, itemRow) => {
      if (failInventoryWrite) throw new Error('inventory write failed');
      inventoryWrites.push(itemRow.item_id);
    },
    deleteApiInventory: async (_client, id) => {
      deletedItems.push(id);
    },
  });
  return {
    store,
    client,
    meta,
    apiDocuments,
    documentRefs,
    deletedDocuments,
    deletedItems,
    inventoryWrites,
    documentWrites,
    get failInventoryWrite() { return failInventoryWrite; },
    set failInventoryWrite(value: boolean) { failInventoryWrite = value; },
    set failEventWrite(value: boolean) { failEventWrite = value; },
    event: (value: OfficialV3SyncTask) => {
      const record = meta.get(eventKey(value));
      return record ? JSON.parse(record) : null;
    },
    seedRun: (run: OfficialV3SyncRun) => {
      meta.set('official_v3_sync.current_run.v1', JSON.stringify(run));
      meta.set(`official_v3_sync.run.v1:${run.runId}`, JSON.stringify(run));
      meta.set('official_v3_sync.state.v1', JSON.stringify({
        version: 1,
        accountIdentity,
        resources: ['item', 'invoice', 'estimate', 'purchase_order'],
        ingestionCursor: 'cursor-1',
        appliedGeneration: 0,
        nextGeneration: 10,
        coverage: 'partial_catch_up',
        updatedAt: 100,
      }));
    },
    seedTask: (value: OfficialV3SyncTask, status: OfficialV3SyncTask['status'] = 'pending') => {
      meta.set(officialTaskKey(value.runId, value.taskId), JSON.stringify({ ...value, status }));
    },
    task: (value: OfficialV3SyncTask) =>
      JSON.parse(meta.get(officialTaskKey(value.runId, value.taskId))!) as OfficialV3SyncTask,
  };
}

function eventKey(value: OfficialV3SyncTask): string {
  return `official_v3_sync.deletion_event.v1:${value.runId}:${value.taskId}`;
}

function officialRun(): OfficialV3SyncRun {
  return {
    version: 1,
    runId: 'run-official',
    accountIdentity,
    entry: { kind: 'since', value: '1788670542' },
    status: 'running',
    ingestionComplete: true,
    pageCount: 1,
    startedAt: 100,
    updatedAt: 100,
  };
}

function task(
  runId: string,
  taskId: string,
  generation: number,
  operation: OfficialV3SyncTask['operation'],
  resource: OfficialV3SyncTask['resource'] = 'item',
  id = itemId
): OfficialV3SyncTask {
  return {
    taskId,
    runId,
    page: 1,
    ordinal: generation,
    generation,
    kind: 'marker',
    resource,
    id,
    operation,
    status: 'pending',
    attempts: 1,
  };
}

function item(id: string): ItemRow {
  return { item_id: id, name: id, cache_source: 'api', source_api_version: '3' };
}

function stock(id: string): ItemStockLocationRow {
  return {
    stock_row_id: `api:${id}`,
    item_id: id,
    quantity_on_hand: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    quantity_incoming: 0,
    in_transit: 0,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function document(id: string): DocumentRow {
  return {
    doc_id: id,
    api_doc_id: id,
    context_id: 5,
    doc_number: 100,
    issue_date: '2026-09-07',
    customer_id: oldItemId,
    modified: 1788670542,
    customer_name: 'Acme',
    status_name: 'Sent',
    cache_source: 'api',
  };
}

function line(docId: string, lineItemId: string): Omit<ItemDocumentRow, 'id'> {
  return {
    doc_id: docId,
    item_id: lineItemId,
    quantity: 1,
    price: 10,
    total_amount: 10,
  };
}

function legacyRefresh(
  runId: string,
  parent: OfficialV3SyncTask,
  id: string,
  status: OfficialV3SyncTask['status']
): OfficialV3SyncTask {
  return {
    taskId: `${parent.taskId}:refresh:${id}`,
    runId,
    page: parent.page,
    ordinal: parent.ordinal,
    generation: parent.generation,
    kind: 'item_refresh',
    parentTaskId: parent.taskId,
    resource: 'item',
    id,
    operation: 'refresh',
    status,
    attempts: 1,
  };
}
