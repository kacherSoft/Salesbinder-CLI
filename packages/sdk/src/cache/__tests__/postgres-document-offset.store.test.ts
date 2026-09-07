import { PostgresCacheService } from '../postgres-cache.service.js';
import { OFFSET_CURRENT_KEY, offsetTaskKey } from '../postgres-document-offset.validation.js';
import type { DocumentOffsetRun, DocumentOffsetTask } from '../document-offset-sync.types.js';
import type { DocumentRow, ItemRow, ItemStockLocationRow } from '../types.js';
import { CACHE_SCHEMA_VERSION, INVENTORY_SNAPSHOT_META_KEY } from '../types.js';

const run: DocumentOffsetRun = {
  version: 1,
  runId: 'run-1',
  accountIdentity: 'salesbinder:acme',
  startedAt: 100,
  cutoff: 0,
  days: 30,
  updatedAt: 100,
  discoveryComplete: false,
  status: 'running',
};
const documentTask: DocumentOffsetTask = {
  id: 'api-doc',
  contextId: 5,
  documentNumber: 42,
  selectedModified: 90,
  status: 'pending',
  attempts: 1,
};
const itemTask: DocumentOffsetTask = { id: 'new-item', status: 'pending', attempts: 1 };
const document: DocumentRow = {
  doc_id: 'api-doc',
  api_doc_id: 'api-doc',
  context_id: 5,
  doc_number: 42,
  issue_date: '2026-09-06',
  customer_id: 'customer',
  modified: 90,
  cache_source: 'api',
};
const item: ItemRow = {
  item_id: 'new-item',
  name: 'Current item',
  quantity: 4,
  cache_source: 'api',
  source_api_version: '3',
};
const stock: ItemStockLocationRow = {
  stock_row_id: 'new-stock',
  item_id: 'new-item',
  quantity_on_hand: 4,
  quantity_reserved: null,
  quantity_available: null,
  quantity_incoming: null,
  in_transit: null,
  cache_source: 'api',
  source_api_version: '3',
};

function harness() {
  let meta = new Map<string, string>([[OFFSET_CURRENT_KEY, JSON.stringify(run)]]);
  let before = new Map(meta);
  const query = jest.fn(
    async (sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
      if (sql.startsWith('BEGIN')) before = new Map(meta);
      if (sql === 'ROLLBACK') meta = new Map(before);
      if (sql.includes('FROM cache_account_binding'))
        return {
          rows: [
            { account_identity: run.accountIdentity, account_subdomain: 'acme', created_at: 1 },
          ],
        };
      if (sql.includes('starts_with(key'))
        return {
          rows: [...meta]
            .filter(([key]) => key.startsWith(String(params[0])))
            .map(([key, value]) => ({ key, value })),
        };
      if (sql.startsWith('SELECT value FROM cache_meta')) {
        const key = sql.includes("key = 'state'") ? 'state' : String(params[0]);
        return { rows: meta.has(key) ? [{ value: meta.get(key) }] : [] };
      }
      if (sql.startsWith('INSERT INTO cache_meta')) {
        if (sql.includes("VALUES ('state'")) meta.set('state', String(params[0]));
        else meta.set(String(params[0]), String(params[1]));
      }
      if (sql.startsWith('DELETE FROM cache_meta')) meta.delete(String(params[0]));
      if (sql.startsWith('SELECT doc_id, api_doc_id, archived, user_id, salesperson_name FROM documents'))
        return { rows: [{ doc_id: 'canonical-doc', api_doc_id: 'api-doc', archived: 1 }] };
      if (sql.startsWith('SELECT item_id FROM item_documents'))
        return { rows: [{ item_id: 'removed-item' }, { item_id: 'new-item' }] };
      return { rows: [] };
    }
  );
  const service = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
  Object.assign(service, {
    opened: true,
    syncLockClients: new Map(),
    expectedBinding: {
      accountIdentity: run.accountIdentity,
      accountSubdomain: 'acme',
      createdAt: 1,
    },
    pool: { connect: async () => ({ query, release: jest.fn() }) },
  });
  const putTask = (task: DocumentOffsetTask, kind: 'document' | 'item' = 'document') =>
    meta.set(offsetTaskKey(run.runId, kind, task), JSON.stringify(task));
  const getTask = (task: DocumentOffsetTask, kind: 'document' | 'item' = 'document') =>
    JSON.parse(
      meta.get(offsetTaskKey(run.runId, kind, task)) ?? 'null'
    ) as DocumentOffsetTask | null;
  return { service, query, putTask, getTask, meta: () => meta };
}

describe('PostgreSQL document offset persistence', () => {
  test('retains malformed selection metadata as failed, then resumes discovery and requeues corrected data', async () => {
    const h = harness();
    const invalid: DocumentOffsetTask = {
      id: documentTask.id,
      contextId: 5,
      selectedModified: 90,
      status: 'failed',
      attempts: 0,
      errorCode: 'invalid_selection_record',
    };
    await h.service.saveOffsetSyncTasks(run.runId, 'document', [invalid]);
    expect(h.getTask(documentTask)).toEqual(invalid);
    await expect(
      h.service.applyOffsetDocumentBundle(run.runId, invalid, document, [], 130)
    ).rejects.toThrow('document task');
    await h.service.saveOffsetSyncRun({
      ...run,
      discoveryComplete: true,
      status: 'success_with_warnings',
    });
    await h.service.saveOffsetSyncRun(run);
    await h.service.saveOffsetSyncTasks(run.runId, 'document', [{ ...documentTask, attempts: 0 }]);
    expect(h.getTask(documentTask)).toMatchObject({
      status: 'pending',
      selectedModified: 90,
      documentNumber: 42,
    });
    expect(h.getTask(documentTask)?.errorCode).toBeUndefined();
    await expect(
      h.service.saveOffsetSyncTasks(run.runId, 'document', [{ ...invalid, status: 'pending' }])
    ).rejects.toThrow('document task');
  });

  test('discovery replay preserves completed tasks and attempts, changed version requeues', async () => {
    const h = harness();
    h.putTask({ ...documentTask, status: 'done', attempts: 3 });
    await h.service.saveOffsetSyncTasks(run.runId, 'document', [
      { ...documentTask, status: 'pending', attempts: 0 },
    ]);
    expect(h.getTask(documentTask)).toMatchObject({ status: 'done', attempts: 3 });
    await h.service.saveOffsetSyncTasks(run.runId, 'document', [
      { ...documentTask, selectedModified: 99, attempts: 0 },
    ]);
    expect(h.getTask(documentTask)).toMatchObject({
      status: 'pending',
      selectedModified: 99,
      attempts: 3,
    });
    expect(h.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('retains cutoff and rejects overwrite of an unfinished run', async () => {
    const h = harness();
    await expect(h.service.saveOffsetSyncRun({ ...run, cutoff: 1 })).rejects.toThrow('immutable');
    await expect(h.service.saveOffsetSyncRun({ ...run, runId: 'new-run' })).rejects.toThrow(
      'resumed'
    );
    await expect(
      h.service.saveOffsetSyncRun({ ...run, accountIdentity: 'salesbinder:other' })
    ).rejects.toThrow('binding');
  });

  test('success requires discovery and no unfinished tasks', async () => {
    const h = harness();
    h.putTask(documentTask);
    await expect(
      h.service.saveOffsetSyncRun({ ...run, discoveryComplete: true, status: 'success' })
    ).rejects.toThrow('completed');
    h.putTask({ ...documentTask, status: 'done' });
    await h.service.saveOffsetSyncRun({ ...run, discoveryComplete: true, status: 'success' });
    await h.service.saveOffsetSyncRun({ ...run, runId: 'run-2' });
    expect(h.meta().has('document_offset_sync.run.v1:run-1')).toBe(true);
    expect(h.meta().has(offsetTaskKey(run.runId, 'document', documentTask))).toBe(true);
    await expect(h.service.listOffsetSyncTasks('run-1', 'document')).rejects.toThrow('current');
  });

  test('rejects corrupted storage, wrong kind and malformed source IDs', async () => {
    const h = harness();
    h.meta().set(OFFSET_CURRENT_KEY, '{broken');
    await expect(h.service.getOffsetSyncRun()).rejects.toThrow('persisted');
    await expect(h.service.saveOffsetSyncTasks(run.runId, 'other' as 'item', [])).rejects.toThrow(
      'kind'
    );
    await expect(
      h.service.saveOffsetSyncTasks(run.runId, 'item', [{ ...itemTask, id: 'bad\0id' }])
    ).rejects.toThrow('identity');
  });

  test('queues removed and new references before document write, preserves attempts and delay, omits payments', async () => {
    const h = harness();
    h.putTask(documentTask);
    h.putTask({ ...itemTask, status: 'done', attempts: 4, verifyAfter: 500 }, 'item');
    await h.service.applyOffsetDocumentBundle(
      run.runId,
      documentTask,
      document,
      [{ item_id: 'new-item', doc_id: 'api-doc', quantity: 2, price: 5 }],
      130
    );
    expect(h.getTask({ ...itemTask, id: 'removed-item' }, 'item')).toMatchObject({
      status: 'pending',
      verifyAfter: 130,
    });
    expect(h.getTask(itemTask, 'item')).toMatchObject({
      status: 'pending',
      attempts: 4,
      verifyAfter: 500,
    });
    expect(h.getTask(documentTask)).toMatchObject({ status: 'done', attempts: 1 });
    const calls = h.query.mock.calls;
    const insert = calls.findIndex(([sql]) => sql.startsWith('INSERT INTO documents'));
    const queue = calls.findIndex(([, params]) => String(params?.[0]).includes(':item:'));
    expect(queue).toBeLessThan(insert);
    expect(calls[insert]?.[1]?.[0]).toBe('canonical-doc');
    expect(calls.some(([sql]) => sql.includes('payment_transactions'))).toBe(false);
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
  });

  test('rolls back queued IDs and task completion on document write failure', async () => {
    const h = harness();
    h.putTask(documentTask);
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO documents')) throw new Error('write failed');
      return original(sql, params);
    });
    await expect(
      h.service.applyOffsetDocumentBundle(run.runId, documentTask, document, [], 130)
    ).rejects.toThrow('write failed');
    expect(h.getTask({ ...itemTask, id: 'removed-item' }, 'item')).toBeNull();
    expect(h.getTask(documentTask)?.status).toBe('pending');
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  test.each(['2.0', '3'])(
    'targeted stock invalidates %s snapshot provenance, preserves history and CSV',
    async (version) => {
      const h = harness();
      h.putTask(itemTask, 'item');
      const state = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        inventorySourceApiVersion: version,
        lastFullSync: 20,
        lastInventorySync: 30,
        lastSync: 40,
      };
      h.meta().set('state', JSON.stringify(state));
      h.meta().set(INVENTORY_SNAPSHOT_META_KEY, '{}');
      await h.service.applyOffsetInventoryBundle(run.runId, itemTask, item, [stock]);
      expect(JSON.parse(h.meta().get('state')!)).toEqual({
        schemaVersion: CACHE_SCHEMA_VERSION,
        lastFullSync: 20,
        lastInventorySync: 30,
        lastSync: 40,
      });
      expect(h.meta().has(INVENTORY_SNAPSHOT_META_KEY)).toBe(false);
      expect(h.getTask(itemTask, 'item')?.status).toBe('done');
      const deletes = h.query.mock.calls.filter(([sql]) =>
        sql.startsWith('DELETE FROM item_stock_locations')
      );
      expect(deletes).toEqual([
        [
          "DELETE FROM item_stock_locations WHERE item_id = $1 AND cache_source = 'api'",
          ['new-item'],
        ],
      ]);
      expect(
        h.query.mock.calls.some(
          ([sql]) =>
            sql.includes('inventory_event_receipts') || sql.includes('inventory_change_feed_state')
        )
      ).toBe(false);
    }
  );

  test('rejects CSV stock ID collisions, incomplete bundles, and stale tasks', async () => {
    const h = harness();
    h.putTask(itemTask, 'item');
    await expect(
      h.service.applyOffsetInventoryBundle(run.runId, itemTask, item, [])
    ).rejects.toThrow('invalid');
    await expect(
      h.service.applyOffsetInventoryBundle('other-run', itemTask, item, [stock])
    ).rejects.toThrow('current');
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, params) =>
      sql.startsWith('SELECT stock_row_id')
        ? { rows: [{ stock_row_id: 'new-stock' }] }
        : original(sql, params)
    );
    await expect(
      h.service.applyOffsetInventoryBundle(run.runId, itemTask, item, [stock])
    ).rejects.toThrow('conflict');
    expect(h.getTask(itemTask, 'item')?.status).toBe('pending');
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO items'))).toBe(false);
  });

  test('lost ownership fences all offset writes before publication', async () => {
    const h = harness();
    h.putTask(itemTask, 'item');
    Object.assign(h.service, {
      lostSyncLockErrors: new Map([
        ['salesbinder-cache-sync:salesbinder:acme', new Error('ownership lost')],
      ]),
    });
    await expect(
      h.service.applyOffsetInventoryBundle(run.runId, itemTask, item, [stock])
    ).rejects.toThrow('ownership lost');
    await expect(h.service.saveOffsetSyncTasks(run.runId, 'item', [itemTask])).rejects.toThrow(
      'ownership lost'
    );
    expect(h.query).not.toHaveBeenCalled();
  });

  test('inventory completion failure rolls back authority invalidation and preserves pending task', async () => {
    const h = harness();
    h.putTask(itemTask, 'item');
    const state = JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      inventorySourceApiVersion: '2.0',
      lastSync: 40,
    });
    h.meta().set('state', state);
    h.meta().set(INVENTORY_SNAPSHOT_META_KEY, 'previous-fingerprint');
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO cache_meta') && String(params?.[0]).includes(':item:'))
        throw new Error('task write failed');
      return original(sql, params);
    });
    await expect(
      h.service.applyOffsetInventoryBundle(run.runId, itemTask, item, [stock])
    ).rejects.toThrow('task write failed');
    expect(h.meta().get('state')).toBe(state);
    expect(h.meta().get(INVENTORY_SNAPSHOT_META_KEY)).toBe('previous-fingerprint');
    expect(h.getTask(itemTask, 'item')?.status).toBe('pending');
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
