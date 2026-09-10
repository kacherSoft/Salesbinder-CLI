import { OfficialV3SyncService } from '../official-v3-sync.service.js';
import type {
  OfficialV3SyncMarker,
  OfficialV3SyncPage,
  OfficialV3SyncRun,
  OfficialV3SyncState,
  OfficialV3SyncStore,
  OfficialV3SyncTask,
} from '../official-v3-sync.types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const accountIdentity = 'salesbinder:acme';
const itemA = '05c86ce5-c234-438b-9908-f518e42d42e4';
const itemB = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const docId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const lineId = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';
const batchIds = Array.from(
  { length: 12 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
);

function itemResult(id: string): V3ExactItemHydrationResult {
  return {
    id,
    status: 'found_current',
    fingerprint: `fp:${id}`,
    bundle: {
      item: { item_id: id, name: id, cache_source: 'api', source_api_version: '3' },
      stockRows: [
        {
          stock_row_id: `api:${id}`,
          item_id: id,
          quantity_on_hand: 1,
          quantity_reserved: 0,
          quantity_available: 1,
          quantity_incoming: 0,
          in_transit: 0,
          cache_source: 'api',
          source_api_version: '3',
        },
      ],
    },
  };
}

function invoice(id = docId): Record<string, unknown> {
  return {
    object: 'invoice',
    id,
    invoice_number: 123,
    customer_id: itemB,
    customer_name: 'Acme',
    customer_kind: 'customer',
    salesperson_id: 'b16f844f-4b40-4f05-a468-407106563e03',
    status_id: 9,
    status: 'Sent',
    issue_date: '2026-09-06',
    updated_at: '2026-09-06T12:00:00Z',
    party: { account_number: null },
    subtotal: '10.00',
    total: '10.00',
    lines: [
      {
        object: 'invoice_line',
        id: lineId,
        invoice_id: id,
        item_id: itemA,
        line_type: 'inventory',
        quantity: '1',
        unit_price: '10.00',
        subtotal: '10.00',
        unit_cost: '10.00',
        total_cost: '10.00',
      },
    ],
  };
}

function documentPayload(
  resource: 'invoice' | 'estimate' | 'purchase_order',
  id = docId
): Record<string, unknown> {
  if (resource === 'invoice') return invoice(id);
  const numberKey = resource === 'estimate' ? 'estimate_number' : 'purchase_order_number';
  const parentKey = resource === 'estimate' ? 'estimate_id' : 'purchase_order_id';
  const object = resource === 'estimate' ? 'estimate' : 'purchase_order';
  const lineObject = resource === 'estimate' ? 'estimate_line' : 'purchase_order_line';
  const payload = {
    ...invoice(id),
    object,
    [numberKey]: 123,
    [resource === 'estimate' ? 'customer_id' : 'supplier_id']: itemB,
    [resource === 'estimate' ? 'customer_name' : 'supplier_name']: 'Acme',
    lines: [
      {
        object: lineObject,
        id: lineId,
        [parentKey]: id,
        item_id: itemA,
        line_type: 'inventory',
        quantity: '1',
        unit_price: '10.00',
        subtotal: '10.00',
        unit_cost: '10.00',
        total_cost: '10.00',
      },
    ],
  };
  if (resource === 'purchase_order') {
    delete payload.salesperson_id;
    payload.assigned_user_id = 'b16f844f-4b40-4f05-a468-407106563e03';
  }
  return payload;
}

function harness(options: { pageLimit?: number } = {}) {
  const store = new MemoryOfficialStore();
  const pages = new Map<string, { changes: OfficialV3SyncMarker[]; has_more: boolean; next_cursor: string }>();
  const sync = {
    read: jest.fn(async (params: { since?: string | number; cursor?: string }) => {
      const key = params.since !== undefined ? `since:${params.since}` : `cursor:${params.cursor}`;
      const page = pages.get(key);
      if (!page) throw new Error(`missing page ${key}`);
      return {
        object: 'sync_page' as const,
        resources: ['item', 'invoice', 'estimate', 'purchase_order'] as const,
        changes: page.changes,
        has_more: page.has_more,
        next_cursor: page.next_cursor,
      };
    }),
  };
  const hydrate = jest.fn(async (ids: readonly string[]): Promise<V3ExactItemHydrationResult[]> =>
    ids.map((id) => (id === itemB ? { id, status: 'missing_unproven' } : itemResult(id)))
  );
  const documents = { get: jest.fn(async () => invoice()) };
  const service = new OfficialV3SyncService({
    store,
    sync,
    hydrator: { hydrate },
    documents,
    now: () => 100,
    pageLimit: options.pageLimit,
  });
  return { service, store, pages, sync, hydrate, documents };
}

describe('OfficialV3SyncService', () => {
  it('seals later pages and keeps applied coverage behind an earlier record gap', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'item', id: itemB, operation: 'upsert' }],
      has_more: true,
      next_cursor: 'cursor-1',
    });
    h.pages.set('cursor:cursor-1', {
      changes: [{ resource: 'item', id: itemA, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-2',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(result.run.status).toBe('success_with_warnings');
    expect(result.state).toMatchObject({ hasIngestionCursor: true, hasAppliedCursor: false, cursorGap: true });
    expect(result.tasks).toMatchObject({ discovered: 2, applied: 1, failed: 1 });
    expect(result.failures).toEqual([
      { taskId: 'm:1:0', resource: 'item', id: itemB, code: 'missing_unproven' },
    ]);
    expect(JSON.stringify(result)).not.toContain('cursor-');
  });

  it('resume can ingest a later finite cycle from ingestion cursor while an old gap remains', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'item', id: itemB, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    await h.service.sync({ accountIdentity, since: 1788670542 });
    h.pages.set('cursor:cursor-1', {
      changes: [{ resource: 'item', id: itemA, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-2',
    });

    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.sync.read).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 100 });
    expect(result.run.entry).toEqual({ kind: 'cursor' });
    expect(result.state).toMatchObject({ hasIngestionCursor: true, hasAppliedCursor: false, cursorGap: true });
    expect(result.tasks.applied).toBe(1);
  });

  it('marks older failed work superseded before it can regress a newer receipt', async () => {
    const h = harness();
    h.store.seedState('cursor-2');
    h.store.seedRun('run-old', 'failed');
    h.store.seedTask({ taskId: 'old-delete', runId: 'run-old', page: 1, ordinal: 0, generation: 1, kind: 'marker', resource: 'item', id: itemA, operation: 'delete', status: 'failed', attempts: 1 });
    h.store.seedTask({ taskId: 'new-upsert', runId: 'run-new', page: 1, ordinal: 0, generation: 2, kind: 'marker', resource: 'item', id: itemA, operation: 'upsert', status: 'done', attempts: 1 });
    h.store.seedRun('run-old', 'running');

    const stale = (await h.store.listTasks('run-old'))[0]!;
    await h.store.markSupersededIfStale('run-old', stale);

    expect((await h.store.listTasks('run-old'))[0]).toMatchObject({ status: 'superseded' });
    expect(h.store.deletedItems).toEqual([]);
  });

  it.each([
    ['invoice' as const, 5],
    ['estimate' as const, 4],
    ['purchase_order' as const, 11],
  ])('applies %s documents without item hydration or child tasks', async (resource, contextId) => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource, id: docId, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.documents.get.mockResolvedValueOnce(documentPayload(resource));

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.documents.get).toHaveBeenCalledWith(contextId, docId);
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 1, applied: 1, failed: 0, pending: 0 });
    expect(result.state.cursorGap).toBe(false);
  });

  it('does not invoke OC shipping hydration for a purchase order with a factory-shaped reader', async () => {
    const h = harness();
    const getSalesOrder = jest.fn(async () => { throw new Error('PO must not read a sales order'); });
    Object.assign(h.documents, { getSalesOrder });
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'purchase_order', id: docId, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-po',
    });
    h.documents.get.mockResolvedValueOnce(documentPayload('purchase_order'));

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).resolves.toMatchObject({
      run: { status: 'success' }, tasks: { applied: 1, failed: 0 },
    });
    expect(getSalesOrder).not.toHaveBeenCalled();
  });

  it('applies document deletes without item hydration or child tasks', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'invoice', id: docId, operation: 'delete' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.documents.get).not.toHaveBeenCalled();
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(h.store.events).toEqual([`document-delete:${docId}`]);
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 1, applied: 1, failed: 0, pending: 0 });
  });

  it('applies a document that succeeds on retry without deriving item refreshes', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'invoice', id: docId, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.documents.get
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } })
      .mockResolvedValueOnce(invoice());

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.documents.get).toHaveBeenCalledTimes(2);
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 1, applied: 1, failed: 0, pending: 0 });
  });

  it('resumes from original since when the first source page fails before sealing', async () => {
    const h = harness();
    h.sync.read.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401 } });

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'authentication_failed',
    });
    expect(h.store.currentRun).toMatchObject({
      status: 'failed',
      entry: { kind: 'since', value: '1788670542' },
      pageCount: 0,
    });

    h.pages.set('since:1788670542', {
      changes: [],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.sync.read).toHaveBeenLastCalledWith({
      since: '1788670542',
      resources: ['item', 'invoice', 'estimate', 'purchase_order'],
      limit: 100,
    });
    expect(result.run.status).toBe('success');
    expect(result.state.cursorGap).toBe(false);
  });

  it('hydrates contiguous pending item work in batches of ten and then the remainder', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: batchIds.map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([
      batchIds.slice(0, 10),
      batchIds.slice(10),
    ]);
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 12, applied: 12, failed: 0, pending: 0 });
  });

  it('batches item markers across document markers but not item deletes', async () => {
    const h = harness();
    const [first, second, deleted, fourth, fifth] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [
        { resource: 'item', id: first!, operation: 'upsert' },
        { resource: 'item', id: second!, operation: 'upsert' },
        { resource: 'item', id: deleted!, operation: 'delete' },
        { resource: 'item', id: fourth!, operation: 'upsert' },
        { resource: 'invoice', id: docId, operation: 'upsert' },
        { resource: 'item', id: fifth!, operation: 'upsert' },
      ],
      has_more: false,
      next_cursor: 'cursor-1',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([
      [first, second],
      [fourth, fifth],
    ]);
    expect(h.store.events).toEqual([
      `upsert:${first}`,
      `upsert:${second}`,
      `delete:${deleted}`,
      `upsert:${fourth}`,
      `upsert:${fifth}`,
      `document:${docId}`,
    ]);
    expect(result.run.status).toBe('success');
  });

  it('saves local item failures independently and retries them once without replaying done items', async () => {
    const h = harness();
    const [first, failed, third] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, failed!, third!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.hydrate
      .mockResolvedValueOnce([
        itemResult(first!),
        { id: failed!, status: 'local_failure', failure: { code: 'invalid_record', message: 'bad item' } },
        itemResult(third!),
      ])
      .mockResolvedValueOnce([itemResult(failed!)]);

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([[first, failed, third], [failed]]);
    expect(h.store.events).toEqual([
      `upsert:${first}`,
      `failure:${failed}:invalid_record`,
      `upsert:${third}`,
      `upsert:${failed}`,
    ]);
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 3, applied: 3, failed: 0, pending: 0 });
  });

  it('retains pending item tasks when the root batch request fails fatally', async () => {
    const h = harness();
    const [first, second] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, second!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.hydrate.mockRejectedValueOnce(new Error('transport down'));

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'operation_failed',
    });

    expect([...h.store.tasks.values()].map((task) => task.status)).toEqual(['pending', 'pending']);
  });

  it('does not replay a committed item after interruption before the batch checkpoint', async () => {
    const h = harness();
    const [first, second] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, second!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    const originalApply = h.store.applyItemUpsert.bind(h.store);
    let calls = 0;
    h.store.applyItemUpsert = jest.fn(async (...args) => {
      await originalApply(...args);
      calls++;
      if (calls === 1) throw new Error('lock lost after commit');
    });

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'operation_failed',
    });

    h.store.applyItemUpsert = originalApply;
    h.pages.set('cursor:cursor-1', { changes: [], has_more: false, next_cursor: 'cursor-2' });
    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([[first, second], [second]]);
    expect(h.store.events).toEqual([`upsert:${first}`, `upsert:${second}`]);
    expect(result.run.status).toBe('success');
  });

  it('retires unfinished legacy item refresh tasks without inventory writes and closes waiting parents', async () => {
    const h = harness();
    h.store.seedState('cursor-1');
    h.store.seedRun('run-legacy', 'running');
    h.store.seedTask({
      taskId: 'doc-parent',
      runId: 'run-legacy',
      page: 1,
      ordinal: 0,
      generation: 1,
      kind: 'marker',
      resource: 'invoice',
      id: docId,
      operation: 'upsert',
      status: 'waiting_children',
      attempts: 1,
    });
    h.store.seedTask({
      taskId: 'doc-parent:refresh:pending',
      runId: 'run-legacy',
      page: 1,
      ordinal: 0,
      generation: 1,
      kind: 'item_refresh',
      parentTaskId: 'doc-parent',
      resource: 'item',
      id: itemA,
      operation: 'refresh',
      status: 'pending',
      attempts: 1,
    });
    h.store.seedTask({
      taskId: 'source-failed',
      runId: 'run-legacy',
      page: 1,
      ordinal: 1,
      generation: 2,
      kind: 'marker',
      resource: 'item',
      id: itemB,
      operation: 'upsert',
      status: 'failed',
      attempts: 1,
      errorCode: 'missing_unproven',
    });
    h.hydrate.mockResolvedValueOnce([{ id: itemB, status: 'missing_unproven' }]);

    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([[itemB]]);
    expect(h.store.events).toEqual([
      `retire:${itemA}`,
      `failure:${itemB}:missing_unproven`,
    ]);
    expect(result.run.status).toBe('success_with_warnings');
    expect(await h.store.listTasks('run-legacy')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'doc-parent', status: 'done' }),
        expect.objectContaining({ taskId: 'doc-parent:refresh:pending', status: 'superseded' }),
        expect.objectContaining({ taskId: 'source-failed', status: 'failed' }),
      ])
    );
  });

  it('falls back to single-item isolation when the batch request has a classified source failure', async () => {
    const h = harness();
    const [first, second] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, second!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.hydrate
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 500 } })
      .mockResolvedValueOnce([itemResult(first!)])
      .mockResolvedValueOnce([{ id: second!, status: 'missing_unproven' }])
      .mockResolvedValueOnce([itemResult(second!)]);

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([
      [first, second],
      [first],
      [second],
      [second],
    ]);
    expect(h.store.events).toEqual([
      `upsert:${first}`,
      `failure:${second}:missing_unproven`,
      `upsert:${second}`,
    ]);
    expect(result.run.status).toBe('success');
  });

  it('treats duplicate item IDs as a batch boundary while preserving ordered work', async () => {
    const h = harness();
    const [first, second, third] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [
        { resource: 'item', id: first!, operation: 'upsert' },
        { resource: 'item', id: second!, operation: 'upsert' },
        { resource: 'item', id: first!, operation: 'upsert' },
        { resource: 'item', id: third!, operation: 'upsert' },
      ],
      has_more: false,
      next_cursor: 'cursor-1',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.hydrate.mock.calls.map(([ids]) => ids)).toEqual([
      [first, second],
      [first, third],
    ]);
    expect(h.store.events).toEqual([
      `upsert:${first}`,
      `upsert:${second}`,
      `upsert:${first}`,
      `upsert:${third}`,
    ]);
    expect(result.run.status).toBe('success');
  });

  it('fatally aborts before publishing when batch result identities are invalid', async () => {
    const h = harness();
    const [first, second] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, second!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.hydrate.mockResolvedValueOnce([itemResult(first!), itemResult(first!)]);

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'operation_failed',
    });

    expect(h.store.events).toEqual([]);
    expect([...h.store.tasks.values()].map((task) => task.status)).toEqual(['pending', 'pending']);
  });

  it('fatally aborts without publishing later siblings when a hydrated bundle ID mismatches', async () => {
    const h = harness();
    const [first, second] = batchIds;
    h.pages.set('since:1788670542', {
      changes: [first!, second!].map((id) => ({ resource: 'item', id, operation: 'upsert' })),
      has_more: false,
      next_cursor: 'cursor-1',
    });
    const mismatched = itemResult(first!);
    if (mismatched.status !== 'found_current') throw new Error('expected found fixture');
    mismatched.bundle.item.item_id = second!;
    h.hydrate.mockResolvedValueOnce([mismatched, itemResult(second!)]);

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'operation_failed',
    });

    expect(h.store.events).toEqual([]);
    expect([...h.store.tasks.values()].map((task) => task.status)).toEqual(['pending', 'pending']);
  });

  it('uses default page limit 100 and preserves explicit maximum 500', async () => {
    const defaultHarness = harness();
    defaultHarness.pages.set('since:1788670542', {
      changes: [],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    await defaultHarness.service.sync({ accountIdentity, since: 1788670542 });
    expect(defaultHarness.sync.read).toHaveBeenCalledWith({
      since: '1788670542',
      resources: ['item', 'invoice', 'estimate', 'purchase_order'],
      limit: 100,
    });

    const maxHarness = harness({ pageLimit: 500 });
    maxHarness.pages.set('since:1788670542', {
      changes: [],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    await maxHarness.service.sync({ accountIdentity, since: 1788670542 });
    expect(maxHarness.sync.read).toHaveBeenCalledWith({
      since: '1788670542',
      resources: ['item', 'invoice', 'estimate', 'purchase_order'],
      limit: 500,
    });
  });

  it('continues through an empty page with has_more true using the validated next cursor', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [],
      has_more: true,
      next_cursor: 'cursor-1',
    });
    h.pages.set('cursor:cursor-1', {
      changes: [{ resource: 'item', id: itemA, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-2',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.sync.read.mock.calls).toEqual([
      [
        {
          since: '1788670542',
          resources: ['item', 'invoice', 'estimate', 'purchase_order'],
          limit: 100,
        },
      ],
      [{ cursor: 'cursor-1', limit: 100 }],
    ]);
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 1, applied: 1 });
  });
});

class MemoryOfficialStore implements OfficialV3SyncStore {
  state: OfficialV3SyncState | null = null;
  currentRun: OfficialV3SyncRun | null = null;
  pages: OfficialV3SyncPage[] = [];
  tasks = new Map<string, OfficialV3SyncTask>();
  deletedItems: string[] = [];
  events: string[] = [];

  async getState() { return this.state ? structuredClone(this.state) : null; }
  async getRun() { return this.currentRun ? structuredClone(this.currentRun) : null; }
  async beginRun(run: OfficialV3SyncRun) {
    this.currentRun = structuredClone(run);
    this.state ??= { version: 1, accountIdentity, resources: ['item', 'invoice', 'estimate', 'purchase_order'], appliedGeneration: 0, nextGeneration: 1, coverage: 'partial_catch_up', updatedAt: 100 };
  }
  async sealPage(runId: string, request: OfficialV3SyncPage['request'], page: Omit<OfficialV3SyncPage, 'request' | 'status' | 'firstGeneration' | 'lastGeneration'>, markers: readonly OfficialV3SyncMarker[]) {
    const firstGeneration = this.state!.nextGeneration;
    this.pages.push({ ...page, request, firstGeneration, lastGeneration: firstGeneration + Math.max(markers.length, 1) - 1, status: 'sealed' });
    markers.forEach((marker, index) => this.tasks.set(this.key(runId, `m:${page.page}:${index}`), { taskId: `m:${page.page}:${index}`, runId, page: page.page, ordinal: index, generation: firstGeneration + index, kind: 'marker', resource: marker.resource, id: marker.id, operation: marker.operation, status: 'pending', attempts: 0 }));
    this.state = { ...this.state!, ingestionCursor: page.nextCursor, nextGeneration: firstGeneration + Math.max(markers.length, 1) };
    this.currentRun = { ...this.currentRun!, ingestionComplete: !page.hasMore, pageCount: page.page, status: 'running' };
    return structuredClone(this.currentRun);
  }
  async listTasks(runId: string) { return [...this.tasks.values()].filter((task) => task.runId === runId).sort((a, b) => a.page - b.page || a.ordinal - b.ordinal || a.taskId.localeCompare(b.taskId)).map((task) => structuredClone(task)); }
  async markSupersededIfStale(_runId: string, task: OfficialV3SyncTask) {
    const newer = [...this.tasks.values()].some((other) => other.resource === task.resource && other.id === task.id && other.generation > task.generation && ['done', 'superseded'].includes(other.status));
    if (newer) this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'superseded' });
    return newer;
  }
  async saveTaskFailure(_runId: string, task: OfficialV3SyncTask, code: string) {
    this.events.push(`failure:${task.id}:${code}`);
    this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'failed', errorCode: code });
  }
  async applyItemUpsert(runId: string, task: OfficialV3SyncTask) { this.events.push(`upsert:${task.id}`); await this.done(runId, task); }
  async applyItemRefresh(runId: string, task: OfficialV3SyncTask) { this.events.push(`refresh:${task.id}`); await this.done(runId, task); await this.completeParents(runId); }
  async applyItemDelete(runId: string, task: OfficialV3SyncTask) { this.deletedItems.push(task.id); this.events.push(`delete:${task.id}`); await this.done(runId, task); }
  async applyDocumentUpsert(runId: string, task: OfficialV3SyncTask) {
    this.events.push(`document:${task.id}`);
    await this.done(runId, task);
  }
  async applyDocumentDelete(runId: string, task: OfficialV3SyncTask) {
    this.events.push(`document-delete:${task.id}`);
    await this.done(runId, task);
  }
  async retireLegacyItemRefreshTasks(runId: string) {
    let changed = false;
    for (const task of [...this.tasks.values()]) {
      if (
        task.runId === runId &&
        task.kind === 'item_refresh' &&
        task.resource === 'item' &&
        task.operation === 'refresh' &&
        (task.status === 'pending' || task.status === 'failed')
      ) {
        this.events.push(`retire:${task.id}`);
        this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'superseded' });
        changed = true;
      }
    }
    if (changed) await this.completeParents(runId);
  }
  async completeTaskGroup(runId: string, task: OfficialV3SyncTask) { await this.completeParents(runId, task); }
  async advanceAppliedPrefix() {
    for (const page of this.pages.sort((a, b) => a.firstGeneration - b.firstGeneration)) {
      const tasks = [...this.tasks.values()].filter((task) => task.runId === page.runId && task.page === page.page);
      if (!tasks.every((task) => ['done', 'superseded'].includes(task.status))) return structuredClone(this.state);
      this.state = { ...this.state!, appliedCursor: page.nextCursor, appliedGeneration: page.lastGeneration };
    }
    return structuredClone(this.state);
  }
  async finishRun(run: OfficialV3SyncRun) { this.currentRun = structuredClone(run); }
  seedState(cursor: string) { this.state = { version: 1, accountIdentity, resources: ['item', 'invoice', 'estimate', 'purchase_order'], ingestionCursor: cursor, appliedGeneration: 0, nextGeneration: 3, coverage: 'partial_catch_up', updatedAt: 100 }; }
  seedRun(runId: string, status: OfficialV3SyncRun['status']) { this.currentRun = { version: 1, runId, accountIdentity, entry: { kind: 'cursor', value: 'cursor-2' }, status, ingestionComplete: true, pageCount: 1, startedAt: 100, updatedAt: 100 }; }
  seedTask(task: OfficialV3SyncTask) { this.tasks.set(this.key(task.runId, task.taskId), structuredClone(task)); }
  private async done(_runId: string, task: OfficialV3SyncTask) { this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'done' }); }
  private async completeParents(runId: string, task?: OfficialV3SyncTask) {
    const parents = [...this.tasks.values()].filter((candidate) => candidate.runId === runId && candidate.status === 'waiting_children' && (!task || candidate.taskId === task.taskId));
    for (const parent of parents) {
      const children = [...this.tasks.values()].filter((child) => child.parentTaskId === parent.taskId);
      if (children.every((child) => ['done', 'superseded'].includes(child.status))) this.tasks.set(this.key(parent.runId, parent.taskId), { ...parent, status: 'done' });
    }
  }
  private key(runId: string, taskId: string) { return `${runId}:${taskId}`; }
}
