import { DocumentOffsetSyncService } from '../document-offset-sync.service.js';
import type {
  DocumentOffsetRun,
  DocumentOffsetStore,
  DocumentOffsetTask,
  OffsetTaskKind,
} from '../document-offset-sync.types.js';
import type { DocumentListResponse } from '../../types/documents.types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const documentId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const oldItemId = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const accountIdentity = 'salesbinder:acme';
const start = Date.parse('2026-09-06T12:00:00Z') / 1000;

function detail(contextId: 4 | 5 | 11 = 5): Record<string, unknown> {
  const object = contextId === 11 ? 'purchase_order' : contextId === 4 ? 'estimate' : 'invoice';
  return {
    id: documentId,
    object,
    [`${object}_number`]: 1002,
    customer_id: oldItemId,
    supplier_id: oldItemId,
    ...(contextId === 11 ? { assigned_user_id: null } : { salesperson_id: null }),
    status: 'Sent',
    issue_date: '2026-09-06',
    updated_at: '2026-09-06T12:00:00Z',
    subtotal: '10.00',
    total: '10.00',
    lines: [
      {
        id: 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58',
        object: `${object}_line`,
        item_id: itemId,
        line_type: 'inventory',
        quantity: 1,
        unit_price: '10.00',
        unit_cost: '10.00',
      },
    ],
  };
}

function found(id: string): V3ExactItemHydrationResult[] {
  return [
    {
      id,
      status: 'found_current',
      fingerprint: 'verified-fixture',
      bundle: {
        item: { item_id: id, name: 'Widget', cache_source: 'api', source_api_version: '3' },
        stockRows: [
          {
            stock_row_id: `api:${id}`,
            item_id: id,
            quantity_on_hand: 1,
            quantity_reserved: 0,
            quantity_available: 1,
            quantity_incoming: 0,
            in_transit: null,
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
      },
    },
  ];
}

function harness(contextId: 4 | 5 | 11 = 5) {
  let run: DocumentOffsetRun | null = null;
  let time = start;
  const tasks = {
    document: new Map<string, DocumentOffsetTask>(),
    item: new Map<string, DocumentOffsetTask>(),
  };
  const key = (kind: OffsetTaskKind, task: DocumentOffsetTask) =>
    kind === 'document' ? `${task.contextId}:${task.id}` : task.id;
  const store: DocumentOffsetStore = {
    getOffsetSyncRun: jest.fn(async () => structuredClone(run)),
    saveOffsetSyncRun: jest.fn(async (value) => {
      run = structuredClone(value);
    }),
    listOffsetSyncTasks: jest.fn(async (_runId, kind) =>
      structuredClone([...tasks[kind].values()])
    ),
    saveOffsetSyncTasks: jest.fn(async (_runId, kind, values) => {
      for (const task of values) tasks[kind].set(key(kind, task), structuredClone(task));
    }),
    applyOffsetDocumentBundle: jest.fn(async (_runId, task, _document, lines, refreshNotBefore) => {
      // In-memory transaction contract; PostgreSQL tests separately exercise real rollback and old-line capture.
      for (const id of new Set([oldItemId, ...lines.map((line) => line.item_id)])) {
        tasks.item.set(id, { id, status: 'pending', attempts: 0, verifyAfter: refreshNotBefore });
      }
      tasks.document.set(key('document', task), { ...task, status: 'done' });
    }),
    applyOffsetInventoryBundle: jest.fn(async (_runId, task) => {
      tasks.item.set(task.id, { ...task, status: 'done' });
    }),
  };
  const list = jest.fn(async (params) => {
    const rows =
      params.contextId === contextId
        ? [
            {
              id: documentId,
              context_id: contextId,
              document_number: 1002,
              modified: '2026-09-06T12:00:00Z',
            },
          ]
        : [];
    return {
      count: String(rows.length),
      page: '1',
      pages: rows.length ? '1' : '0',
      documents: [rows],
    } as DocumentListResponse;
  });
  const get = jest.fn(async (_contextId: 4 | 5 | 11, _id: string) => detail(contextId));
  const hydrate = jest.fn(
    async (ids: readonly string[]): Promise<V3ExactItemHydrationResult[]> => found(ids[0]!)
  );
  const sleep = jest.fn(async (milliseconds: number) => {
    time += milliseconds / 1000;
  });
  const guard = jest.fn(async () => undefined);
  const onProgress = jest.fn();
  const service = new DocumentOffsetSyncService({
    store,
    cache: { getDocumentByApiId: jest.fn(), getDocumentByNumber: jest.fn() },
    documentsV2: { list },
    documentsV3: { get },
    hydrator: { hydrate },
    sleep,
    guard,
    onProgress,
    now: () => time,
  });
  return {
    service,
    store,
    tasks,
    list,
    get,
    hydrate,
    sleep,
    guard,
    onProgress,
    run: () => run,
    advance: (seconds: number) => {
      time += seconds;
    },
  };
}

describe('DocumentOffsetSyncService', () => {
  it('discovers only three bounded V2 contexts and applies exact items without global APIs', async () => {
    const h = harness();
    const result = await h.service.sync({ accountIdentity });
    expect(h.list.mock.calls.map(([params]) => params)).toEqual(
      [4, 5, 11].map((contextId) => ({
        contextId,
        page: 1,
        pageLimit: 100,
        modifiedSince: start - 30 * 86400,
      }))
    );
    expect(result.run.status).toBe('success');
    expect(result.documents).toEqual({ discovered: 1, applied: 1, failed: 0, pending: 0 });
    expect(result.items.applied).toBe(2);
    expect(h.hydrate.mock.calls).toEqual([[[oldItemId]], [[itemId]]]);
    expect(h.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete', completed: 3, total: 3, failed: 0 })
    );
  });

  it.each([0, 366, 1.1, NaN])('rejects invalid days %s before reading state', async (days) => {
    const h = harness();
    await expect(h.service.sync({ accountIdentity, days })).rejects.toMatchObject({
      code: 'invalid_days',
    });
    expect(h.store.getOffsetSyncRun).not.toHaveBeenCalled();
  });

  it('retains a missing item and resumes only with explicit resume and frozen cutoff', async () => {
    const h = harness();
    h.hydrate.mockImplementation(async (ids) =>
      ids[0] === itemId ? [{ id: itemId, status: 'missing_unproven' }] : found(ids[0]!)
    );
    const first = await h.service.sync({ accountIdentity, days: 7 });
    expect(first.run.status).toBe('success_with_warnings');
    expect(first.items).toEqual({ discovered: 2, applied: 1, failed: 1, pending: 0 });
    expect(h.tasks.item.get(itemId)).toMatchObject({
      attempts: 2,
      status: 'failed',
      errorCode: 'missing_unproven',
    });
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'resume_required',
    });
    h.advance(5 * 86400);
    h.hydrate.mockImplementation(async (ids) => found(ids[0]!));
    const final = await h.service.sync({ accountIdentity, resume: true });
    expect(final.run).toMatchObject({
      runId: first.run.runId,
      cutoff: start - 7 * 86400,
      days: 7,
      status: 'success',
    });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(h.hydrate).toHaveBeenCalledTimes(4);
  });

  it('preserves queued work and individually committed inventory when a later write fails', async () => {
    const h = harness();
    const apply = h.store.applyOffsetInventoryBundle as jest.Mock;
    apply.mockImplementationOnce(async (_run, task) => {
      h.tasks.item.set(task.id, { ...task, status: 'done' });
    });
    apply.mockRejectedValueOnce(new Error('private postgres connection information'));
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'operation_failed',
    });
    expect(h.run()?.status).toBe('failed');
    expect(h.tasks.document.values().next().value?.status).toBe('done');
    expect(h.tasks.item.get(oldItemId)?.status).toBe('done');
    expect(h.tasks.item.get(itemId)?.status).toBe('pending');
    const result = await h.service.sync({ accountIdentity, resume: true });
    expect(result.run.status).toBe('success');
    expect(h.hydrate.mock.calls.map(([ids]) => ids[0])).toEqual([oldItemId, itemId, itemId]);
    expect(JSON.stringify(result)).not.toContain('private postgres');
  });

  it('does not treat document transaction failure as a local record failure', async () => {
    const h = harness();
    (h.store.applyOffsetDocumentBundle as jest.Mock).mockRejectedValueOnce(new Error('lock lost'));
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'operation_failed',
    });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(h.tasks.document.values().next().value?.status).toBe('pending');
  });

  it('retries a wrong document identity once without publishing any bundle', async () => {
    const h = harness();
    h.get.mockResolvedValue({ ...detail(), id: oldItemId });
    const result = await h.service.sync({ accountIdentity });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.store.applyOffsetDocumentBundle).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      { kind: 'document', id: documentId, contextId: 5, code: 'invalid_record' },
    ]);
  });

  it('waits until durable PO refresh due time before exact hydration', async () => {
    const h = harness(11);
    const result = await h.service.sync({ accountIdentity });
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.sleep).toHaveBeenCalledWith(30000);
    expect(h.store.applyOffsetDocumentBundle).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.any(Array),
      start + 30
    );
    expect(result.run.status).toBe('success');
  });

  it('restarts interrupted discovery at page one with the original cutoff', async () => {
    const h = harness();
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementation(async (params) => {
      if (params.contextId === 11) throw new Error('network interruption');
      return original(params);
    });
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'operation_failed',
    });
    expect(h.tasks.document.size).toBe(1);
    expect(h.run()?.discoveryComplete).toBe(false);
    h.advance(86400);
    h.list.mockImplementation(original);
    await h.service.sync({ accountIdentity, resume: true });
    expect(h.tasks.document.size).toBe(1);
    expect(
      h.list.mock.calls.every(
        ([params]) => params.page === 1 && params.modifiedSince === start - 30 * 86400
      )
    ).toBe(true);
  });

  it('fails closed on invalid pagination and never declares discovery complete', async () => {
    const h = harness();
    h.list.mockResolvedValue({ count: '101', page: '1', pages: '1', documents: [] });
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'invalid_discovery',
    });
    expect(h.run()?.discoveryComplete).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])('propagates global HTTP %s without a record retry', async (status) => {
    const h = harness();
    h.get.mockRejectedValue({
      isAxiosError: true,
      response: { status },
      config: { password: 'secret' },
    });
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: status === 429 ? 'rate_limit_failed' : 'authentication_failed',
    });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.run())).not.toContain('secret');
  });

  it('completed resume is an API-free no-op', async () => {
    const h = harness();
    const first = await h.service.sync({ accountIdentity });
    const result = await h.service.sync({ accountIdentity, resume: true });
    expect(result.run.runId).toBe(first.run.runId);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('recovers a malformed document on its second bounded attempt', async () => {
    const h = harness();
    h.get.mockResolvedValueOnce({ ...detail(), lines: null });
    const result = await h.service.sync({ accountIdentity });
    expect(result.run.status).toBe('success');
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.tasks.document.values().next().value?.attempts).toBe(2);
  });

  it('keeps legacy non-UUID item references as local failures and refreshes valid items', async () => {
    const h = harness();
    h.tasks.item.set('legacy-item', { id: 'legacy-item', status: 'pending', attempts: 0 });
    const result = await h.service.sync({ accountIdentity });
    expect(result.run.status).toBe('success_with_warnings');
    expect(result.items.applied).toBe(2);
    expect(result.failures).toContainEqual({
      kind: 'item',
      id: 'legacy-item',
      contextId: undefined,
      code: 'invalid_item_id',
    });
    expect(h.hydrate.mock.calls.every(([ids]) => ids[0] !== 'legacy-item')).toBe(true);
  });

  it.each(['2026-07-01T12:00:00Z'])('rejects unsafe selection timestamp %s', async (modified) => {
    const h = harness();
    h.list.mockResolvedValue({
      count: '1',
      page: '1',
      pages: '1',
      documents: [[{ id: documentId, context_id: 4, document_number: 1002, modified }]],
    } as DocumentListResponse);
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'invalid_discovery',
    });
    expect(h.run()?.discoveryComplete).toBe(false);
    expect(h.store.applyOffsetDocumentBundle).not.toHaveBeenCalled();
  });

  it('preserves progress when the writer fence is lost even if failure status cannot be saved', async () => {
    const h = harness();
    h.get.mockImplementation(async () => {
      h.guard.mockRejectedValue(new Error('writer fence lost'));
      return detail();
    });
    await expect(h.service.sync({ accountIdentity })).rejects.toMatchObject({
      code: 'checkpoint_failed',
    });
    expect(h.run()?.status).toBe('running');
    expect(h.tasks.document.size).toBe(1);
    expect(h.store.applyOffsetDocumentBundle).not.toHaveBeenCalled();
  });

  it.each(['document_number', 'modified'])(
    'retains malformed %s locally and rediscovers it on resume',
    async (field) => {
      const h = harness();
      const original = h.list.getMockImplementation()!;
      let corrected = false;
      h.list.mockImplementation(async (params) => {
        const response = await original(params);
        if (params.contextId !== 5) return response;
        const second = {
          id: oldItemId,
          context_id: 5,
          document_number: 1003,
          modified: '2026-09-06T12:00:00Z',
          ...(!corrected ? { [field]: 'malformed' } : {}),
        };
        return {
          ...response,
          count: '2',
          documents: [[...response.documents!.flat(), second]],
        } as DocumentListResponse;
      });
      h.get.mockImplementation(async (_context, id) => ({
        ...detail(),
        id,
        invoice_number: id === oldItemId ? 1003 : 1002,
      }));
      const first = await h.service.sync({ accountIdentity });
      expect(first.run.status).toBe('success_with_warnings');
      expect(first.run.discoveryComplete).toBe(true);
      expect(first.documents).toMatchObject({ applied: 1, failed: 1 });
      expect(first.failures).toContainEqual({
        kind: 'document',
        id: oldItemId,
        contextId: 5,
        code: 'invalid_selection_record',
      });
      expect(h.get).toHaveBeenCalledTimes(1);
      corrected = true;
      h.advance(86400);
      const final = await h.service.sync({ accountIdentity, resume: true });
      expect(final.run.status).toBe('success');
      expect(final.run.cutoff).toBe(start - 30 * 86400);
      expect(final.documents.applied).toBe(2);
      expect(h.get).toHaveBeenCalledTimes(2);
      expect(h.list).toHaveBeenCalledTimes(6);
    }
  );
});
