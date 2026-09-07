import { PostgresOfficialV3SyncStore } from '../postgres-official-v3-sync.store.js';
import type { OfficialV3SyncRun, OfficialV3SyncTask } from '../official-v3-sync.types.js';
import { officialLatestReceiptKey, officialTaskKey } from '../official-v3-sync.validation.js';
import type { ItemRow, ItemStockLocationRow } from '../types.js';

const accountIdentity = 'salesbinder:acme';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const oldItemId = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const apiDocId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const localDocId = '67a862bf-8ba2-43d7-8706-4d0a048e9007';

describe('PostgresOfficialV3SyncStore', () => {
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

  it('resolves document deletes through API identity, queues old refs, and avoids CSV-only rows', async () => {
    const h = harness();
    const run = officialRun();
    const deleteTask = task(run.runId, 'delete-doc', 1, 'delete', 'invoice', apiDocId);
    h.apiDocuments.set(apiDocId, localDocId);
    h.documentRefs.set(localDocId, [oldItemId]);
    h.seedRun(run);
    h.seedTask(deleteTask);

    await h.store.applyDocumentDeleteAndQueueRefreshes(run.runId, deleteTask);

    expect(h.deletedDocuments).toEqual([localDocId]);
    expect(await h.store.listTasks(run.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentTaskId: deleteTask.taskId, id: oldItemId, status: 'pending' }),
        expect.objectContaining({ taskId: deleteTask.taskId, status: 'waiting_children' }),
      ])
    );

    const missing = task(run.runId, 'missing-doc', 2, 'delete', 'invoice', localDocId);
    h.seedTask(missing);
    await h.store.applyDocumentDeleteAndQueueRefreshes(run.runId, missing);
    expect(h.deletedDocuments).toEqual([localDocId]);
    expect(h.task(missing)).toMatchObject({ status: 'done' });
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
  let failInventoryWrite = false;
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
      try {
        return await run(client as never);
      } catch (error) {
        meta.clear();
        for (const entry of beforeMeta) meta.set(...entry);
        throw error;
      }
    },
    resolveDocument: async (_client, doc) => doc,
    resolveDocumentIdByApiId: async (_client, id) => apiDocuments.get(id) ?? null,
    writeDocument: async () => undefined,
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
    meta,
    apiDocuments,
    documentRefs,
    deletedDocuments,
    deletedItems,
    inventoryWrites,
    get failInventoryWrite() { return failInventoryWrite; },
    set failInventoryWrite(value: boolean) { failInventoryWrite = value; },
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
