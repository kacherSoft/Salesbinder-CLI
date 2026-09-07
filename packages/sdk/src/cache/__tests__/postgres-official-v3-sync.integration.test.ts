import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { OfficialV3SyncService } from '../official-v3-sync.service.js';
import { officialPagePrefix } from '../official-v3-sync.validation.js';
import { PostgresCacheService } from '../postgres-cache.service.js';
import type {
  OfficialV3SyncMarker,
  OfficialV3SyncPage,
  OfficialV3SyncPageEnvelope,
  OfficialV3SyncRun,
  OfficialV3SyncTask,
} from '../official-v3-sync.types.js';
import type {
  OfficialV3SyncDependencies,
  OfficialV3SyncTransport,
} from '../official-v3-sync.contracts.js';
import {
  createSalesBinderAccountBinding,
  type DocumentRow,
  type ItemDocumentRow,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const { Pool } = pg;
const testUrl =
  process.env.SALESBINDER_OFFICIAL_V3_SYNC_TEST_DB_URL ??
  process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('official-v3-sync-test');
const itemA = '05c86ce5-c234-438b-9908-f518e42d42e4';
const itemB = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const itemC = '6c9c9d55-9cc1-4311-8c28-c53bd7d8a6f2';
const itemD = '7fb6a3a8-d591-4761-98e5-b5275d20f5e4';
const docId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const customerId = '90b266c8-628f-48ce-a83c-21013cb740f6';
const lineNew = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';

describeIfPostgres('PostgresCacheService official V3 sync integration', () => {
  jest.setTimeout(45_000);
  let baseUrl = '';
  let adminPool: InstanceType<typeof Pool> | undefined;
  const contexts: TestContext[] = [];

  beforeAll(() => {
    baseUrl = guardedUrl();
    adminPool = new Pool({ connectionString: baseUrl });
  });

  afterEach(async () => {
    while (contexts.length) await cleanup(contexts.pop());
  });

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined);
  });

  it('keeps applied cursor behind an earlier failed page and then cascades after receipt', async () => {
    const ctx = await createContext('page-gap');
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(
      run.runId,
      { kind: 'since', value: '1788670542' },
      page(run.runId, 1, 'cursor-1', true),
      [{ resource: 'item', id: itemB, operation: 'upsert' }]
    );
    await store.sealPage(
      run.runId,
      { kind: 'cursor', value: 'cursor-1' },
      page(run.runId, 2, 'cursor-2', false),
      [{ resource: 'item', id: itemA, operation: 'upsert' }]
    );
    const tasks = await store.listTasks(run.runId);
    await store.saveTaskFailure(run.runId, tasks[0]!, 'missing_unproven');
    await store.applyItemUpsert(run.runId, tasks[1]!, item(itemA), [stock(itemA)]);
    await store.advanceAppliedPrefix(run.runId);

    const gapState = await ctx.service.getOfficialV3SyncState();
    expect(gapState).toMatchObject({ ingestionCursor: 'cursor-2' });
    expect(gapState).not.toHaveProperty('appliedCursor');

    await store.applyItemUpsert(run.runId, { ...tasks[0]!, attempts: 2 }, item(itemB), [
      stock(itemB),
    ]);
    await store.advanceAppliedPrefix(run.runId);
    await expect(ctx.service.getOfficialV3SyncState()).resolves.toMatchObject({
      appliedCursor: 'cursor-2',
    });
  });

  it('rolls back item writes when task receipt commit fails', async () => {
    const ctx = await createContext('receipt-rollback');
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(
      run.runId,
      { kind: 'since', value: '1788670542' },
      page(run.runId, 1, 'cursor-1', false),
      [{ resource: 'item', id: itemA, operation: 'upsert' }]
    );
    const task = (await store.listTasks(run.runId))[0]!;
    await installTaskReceiptFailure(ctx.pool, task);

    await expect(
      store.applyItemUpsert(run.runId, task, item(itemA), [stock(itemA)])
    ).rejects.toThrow('fail_official_receipt');

    await expect(ctx.service.getItem(itemA)).resolves.toBeUndefined();
    await expect(store.listTasks(run.runId)).resolves.toEqual([
      expect.objectContaining({ taskId: task.taskId, status: 'pending' }),
    ]);
  });

  it('persists a sanitized failed run when the first source read fails before any page is sealed', async () => {
    const ctx = await createContext('first-read-failure');
    const harness = serviceHarness(ctx, {});
    const authError = Object.assign(new Error('auth failed with secret cursor'), {
      isAxiosError: true,
      response: { status: 401 },
    });
    harness.sync.read.mockRejectedValueOnce(authError);

    await expect(
      harness.service.sync({ accountIdentity: binding.accountIdentity, since: 1788670542 })
    ).rejects.toMatchObject({ code: 'authentication_failed' });

    const failedRun = await ctx.service.getOfficialV3SyncRun();
    const failedState = await ctx.service.getOfficialV3SyncState();
    expect(failedRun).toMatchObject({
      status: 'failed',
      errorCode: 'authentication_failed',
      entry: { kind: 'since', value: '1788670542' },
      pageCount: 0,
    });
    expect(failedState).toMatchObject({ accountIdentity: binding.accountIdentity });
    expect(failedState).not.toHaveProperty('ingestionCursor');

    harness.sync.read.mockClear();
    harness.pages['since:1788670542'] = envelope(
      [{ resource: 'item', id: itemA, operation: 'upsert' }],
      false,
      'cursor-after-auth'
    );

    const resumed = await harness.service.sync({
      accountIdentity: binding.accountIdentity,
      resume: true,
    });

    expect(harness.sync.read).toHaveBeenCalledWith({
      since: '1788670542',
      resources: ['item', 'invoice', 'estimate', 'purchase_order'],
      limit: 500,
    });
    expect(resumed.run.status).toBe('success');
    expect(JSON.stringify(resumed)).not.toContain('cursor-after-auth');
  });

  it('resumes interrupted ingestion from the saved page cursor instead of replaying the initial since', async () => {
    const ctx = await createContext('interrupted-ingestion');
    const pages: PageMap = {
      'since:1788670542': envelope(
        [{ resource: 'item', id: itemA, operation: 'upsert' }],
        true,
        'cursor-page-1'
      ),
      'cursor:cursor-page-1': envelope(
        [{ resource: 'item', id: itemB, operation: 'upsert' }],
        false,
        'cursor-page-2'
      ),
    };
    const harness = serviceHarness(ctx, pages, { maxPagesPerRun: 1 });

    await expect(
      harness.service.sync({ accountIdentity: binding.accountIdentity, since: 1788670542 })
    ).rejects.toMatchObject({ code: 'page_limit_exceeded' });
    await expect(ctx.service.getOfficialV3SyncState()).resolves.toMatchObject({
      ingestionCursor: 'cursor-page-1',
    });

    const resumedHarness = serviceHarness(ctx, pages);
    const resumed = await resumedHarness.service.sync({
      accountIdentity: binding.accountIdentity,
      resume: true,
    });

    expect(resumedHarness.sync.read).toHaveBeenCalledWith({ cursor: 'cursor-page-1', limit: 500 });
    expect(resumed.run.status).toBe('success');
    expect(resumed.tasks).toMatchObject({ discovered: 2, applied: 2, failed: 0 });
    expect(resumed.state).toMatchObject({ hasAppliedCursor: true, cursorGap: false });
  });

  it('drains old and new document item refreshes in the same service invocation before advancing coverage', async () => {
    const ctx = await createContext('doc-refreshes');
    const harness = serviceHarness(ctx, {
      'since:1788670542': envelope(
        [{ resource: 'invoice', id: docId, operation: 'upsert' }],
        false,
        'cursor-doc'
      ),
    });

    await ctx.service.insertDocument(document(docId, { archived: 1, document_name: 'Prior' }));
    await ctx.service.insertItemDocument(line(itemA, docId, 'old-line'));
    harness.documents.get.mockResolvedValueOnce(
      invoicePayload(docId, itemB, { updated_at: '2040-01-02T03:04:05+00:00' })
    );

    const result = await harness.service.sync({
      accountIdentity: binding.accountIdentity,
      since: 1788670542,
    });
    const hydratedIds = harness.hydrator.hydrate.mock.calls.flatMap(([ids]) => [...ids]);

    expect(hydratedIds).toEqual(expect.arrayContaining([itemA, itemB]));
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 3, applied: 3, failed: 0, pending: 0 });
    expect(result.state.cursorGap).toBe(false);
    const updatedDocument = await ctx.service.getDocument(docId);
    expect(updatedDocument).toMatchObject({
      document_name: 'Official invoice',
      archived: 1,
      modified: Math.floor(Date.parse('2040-01-02T03:04:05+00:00') / 1000),
    });
    expect(updatedDocument?.modified).toBeGreaterThan(2_147_483_647);
    await expect(ctx.service.getItemDocuments(docId)).resolves.toEqual([
      expect.objectContaining({ item_id: itemB, document_item_id: lineNew }),
    ]);
    await expect(ctx.service.getItem(itemA)).resolves.toMatchObject({
      item_id: itemA,
      quantity: 1,
    });
    await expect(ctx.service.getItem(itemB)).resolves.toMatchObject({
      item_id: itemB,
      quantity: 1,
    });
  });

  it('retries prior failed work on resume, ingests a new cycle, and advances prefix across runs', async () => {
    const ctx = await createContext('resume-prefix');
    const pages: PageMap = {
      'since:1788670542': envelope(
        [{ resource: 'item', id: itemA, operation: 'upsert' }],
        true,
        'cursor-gap'
      ),
      'cursor:cursor-gap': envelope(
        [{ resource: 'item', id: itemB, operation: 'upsert' }],
        false,
        'cursor-clean'
      ),
    };
    const harness = serviceHarness(ctx, pages);
    let itemAAvailable = false;
    harness.hydrator.hydrate.mockImplementation(async (ids) =>
      ids.map((id) => (id === itemA && !itemAAvailable ? missing(id) : found(id)))
    );

    const warning = await harness.service.sync({
      accountIdentity: binding.accountIdentity,
      since: 1788670542,
    });

    expect(warning.run.status).toBe('success_with_warnings');
    expect(warning.tasks).toMatchObject({ discovered: 2, applied: 1, failed: 1 });
    expect(warning.state).toMatchObject({ hasAppliedCursor: false, cursorGap: true });

    itemAAvailable = true;
    pages['cursor:cursor-clean'] = envelope(
      [{ resource: 'item', id: itemC, operation: 'upsert' }],
      false,
      'cursor-resumed'
    );

    const resumed = await harness.service.sync({
      accountIdentity: binding.accountIdentity,
      resume: true,
    });

    expect(harness.sync.read).toHaveBeenLastCalledWith({ cursor: 'cursor-clean', limit: 500 });
    expect(resumed.run.status).toBe('success');
    expect(resumed.tasks).toMatchObject({ discovered: 3, applied: 3, failed: 0, pending: 0 });
    expect(resumed.state).toMatchObject({ hasAppliedCursor: true, cursorGap: false });

    pages['cursor:cursor-resumed'] = envelope(
      [{ resource: 'item', id: itemD, operation: 'upsert' }],
      false,
      'cursor-next-run'
    );
    const poll = await harness.service.sync({ accountIdentity: binding.accountIdentity });
    const status = await ctx.service.getOfficialV3SyncStatus();

    expect(poll.run.runId).not.toBe(resumed.run.runId);
    expect(poll.run.entry).toEqual({ kind: 'cursor' });
    expect(poll.run.status).toBe('success');
    expect(poll.tasks).toMatchObject({ discovered: 1, applied: 1 });
    expect(status?.state).toMatchObject({ hasAppliedCursor: true, cursorGap: false });
    expect(JSON.stringify(status)).not.toContain('cursor-');
  });

  it('seals empty has-more pages in global order before applying later markers', async () => {
    const ctx = await createContext('empty-pages');
    const harness = serviceHarness(ctx, {
      'since:1788670542': envelope([], true, 'cursor-empty-1'),
      'cursor:cursor-empty-1': envelope([], true, 'cursor-empty-2'),
      'cursor:cursor-empty-2': envelope(
        [{ resource: 'item', id: itemA, operation: 'upsert' }],
        false,
        'cursor-final'
      ),
    });

    const result = await harness.service.sync({
      accountIdentity: binding.accountIdentity,
      since: 1788670542,
    });
    const pages = await readOfficialPages(ctx.pool, result.run.runId);

    expect(harness.sync.read.mock.calls).toEqual([
      [
        {
          since: '1788670542',
          resources: ['item', 'invoice', 'estimate', 'purchase_order'],
          limit: 500,
        },
      ],
      [{ cursor: 'cursor-empty-1', limit: 500 }],
      [{ cursor: 'cursor-empty-2', limit: 500 }],
    ]);
    expect(pages).toEqual([
      expect.objectContaining({
        page: 1,
        firstGeneration: 1,
        lastGeneration: 1,
        markerCount: 0,
        status: 'complete',
      }),
      expect.objectContaining({
        page: 2,
        firstGeneration: 2,
        lastGeneration: 2,
        markerCount: 0,
        status: 'complete',
      }),
      expect.objectContaining({
        page: 3,
        firstGeneration: 3,
        lastGeneration: 3,
        markerCount: 1,
        status: 'complete',
      }),
    ]);
    expect(result.state).toMatchObject({ nextGeneration: 4, cursorGap: false });
  });

  it('supersedes a stale old delete after a newer upsert and preserves CSV inventory rows', async () => {
    const ctx = await createContext('stale-delete');
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();

    await ctx.service.insertItem(item(itemA, 2, { name: 'Prior API' }));
    await ctx.service.insertItemStockLocation(stock(itemA, 2, `old-api:${itemA}`));
    await ctx.service.insertItemStockLocation({
      ...stock(itemA, 17, `csv:${itemA}`),
      cache_source: 'csv',
      source_api_version: null,
    });
    await store.beginRun(run);
    await store.sealPage(
      run.runId,
      { kind: 'since', value: '1788670542' },
      page(run.runId, 1, 'cursor-old-delete', true),
      [{ resource: 'item', id: itemA, operation: 'delete' }]
    );
    await store.sealPage(
      run.runId,
      { kind: 'cursor', value: 'cursor-old-delete' },
      page(run.runId, 2, 'cursor-new-upsert', false),
      [{ resource: 'item', id: itemA, operation: 'upsert' }]
    );
    const [oldDelete, newUpsert] = await store.listTasks(run.runId);

    await store.applyItemUpsert(run.runId, { ...newUpsert!, attempts: 1 }, item(itemA, 9), [
      stock(itemA, 9, `new-api:${itemA}`),
    ]);
    await store.applyItemDelete(run.runId, { ...oldDelete!, attempts: 1 });

    await expect(ctx.service.getItem(itemA)).resolves.toMatchObject({
      item_id: itemA,
      name: itemA,
      quantity: 9,
      cache_source: 'api',
    });
    const rows = await ctx.service.getItemStockLocations(itemA);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stock_row_id: `csv:${itemA}`,
          cache_source: 'csv',
          quantity_on_hand: 17,
        }),
        expect.objectContaining({
          stock_row_id: `new-api:${itemA}`,
          cache_source: 'api',
          quantity_on_hand: 9,
        }),
      ])
    );
    await expect(store.listTasks(run.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: oldDelete!.taskId, status: 'superseded' }),
        expect.objectContaining({ taskId: newUpsert!.taskId, status: 'done' }),
      ])
    );
  });

  it('fails closed on retained writer lock loss without partial official publish', async () => {
    const ctx = await createContext('lock-loss');
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    const blockerKey = `official-v3-block-${randomUUID()}`;
    const blocker = await ctx.pool.connect();

    await ctx.service.insertItem(item(itemA, 5, { name: 'Prior locked item' }));
    await ctx.service.insertItemStockLocation(stock(itemA, 5, `prior-lock:${itemA}`));
    await store.beginRun(run);
    await store.sealPage(
      run.runId,
      { kind: 'since', value: '1788670542' },
      page(run.runId, 1, 'cursor-lock', false),
      [{ resource: 'item', id: itemA, operation: 'upsert' }]
    );
    const task = (await store.listTasks(run.runId))[0]!;
    await installBlockingStockTrigger(ctx.pool, blockerKey, `blocked:${itemA}`);

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [blockerKey]);
      const inFlight = store
        .applyItemUpsert(run.runId, { ...task, attempts: 1 }, item(itemA, 11), [
          stock(itemA, 11, `blocked:${itemA}`),
        ])
        .then(() => ({ completed: true, error: undefined }))
        .catch((error: Error) => ({ completed: false, error }));

      const pid = await waitForBlockedOwner(ctx.pool, ctx.applicationName);
      await ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await inFlight;

      expect(result.completed).toBe(false);
      expect(result.error?.message).toBe('PostgreSQL sync lock lost.');
      await expect(ctx.service.getItem(itemA)).resolves.toMatchObject({
        name: 'Prior locked item',
        quantity: 5,
      });
      await expect(ctx.service.getItemStockLocations(itemA)).resolves.toEqual([
        expect.objectContaining({ stock_row_id: `prior-lock:${itemA}`, quantity_on_hand: 5 }),
      ]);
      await expect(store.listTasks(run.runId)).resolves.toEqual([
        expect.objectContaining({ taskId: task.taskId, status: 'pending', attempts: 0 }),
      ]);
      await expect(
        store.applyItemUpsert(run.runId, { ...task, attempts: 1 }, item(itemA, 12), [
          stock(itemA, 12, `after-loss:${itemA}`),
        ])
      ).rejects.toThrow('PostgreSQL sync lock lost.');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('PostgreSQL admin pool was not initialized.');
    const schema = `official_${label.replaceAll('-', '_')}_${randomUUID().replaceAll('-', '_')}`;
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const url = scopedUrl(baseUrl, schema);
    const service = new PostgresCacheService(url);
    const pool = new Pool({ connectionString: url });
    const applicationName = `sb-official-${schema.slice(-30)}`;
    const ctx = { schema, url, applicationName, service, pool };
    contexts.push(ctx);
    await service.ensureAccountBinding(binding);
    await expect(service.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    return ctx;
  }

  async function cleanup(ctx: TestContext | undefined): Promise<void> {
    if (!ctx || !adminPool) return;
    await ctx.service.close().catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    await adminPool
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(ctx.schema)} CASCADE`)
      .catch(() => undefined);
  }
});

interface TestContext {
  schema: string;
  url: string;
  applicationName: string;
  service: PostgresCacheService;
  pool: InstanceType<typeof Pool>;
}

type PageMap = Record<string, OfficialV3SyncPageEnvelope>;

function serviceHarness(
  ctx: TestContext,
  pages: PageMap,
  overrides: Partial<OfficialV3SyncDependencies> = {}
) {
  const sync: OfficialV3SyncTransport & { read: jest.Mock } = {
    read: jest.fn(async (params: { since?: string | number; cursor?: string }) => {
      const key = params.since !== undefined ? `since:${params.since}` : `cursor:${params.cursor}`;
      const response = pages[key];
      if (!response) throw new Error(`Missing official V3 sync page ${key}`);
      return response;
    }),
  };
  const hydrator = {
    hydrate: jest.fn(async (ids: readonly string[]) => ids.map((id) => found(id))),
  };
  const documents = {
    get: jest.fn(async (_contextId: 4 | 5 | 11, id: string) => invoicePayload(id, itemA)),
  };
  const service = new OfficialV3SyncService({
    store: ctx.service.getOfficialV3SyncStore(),
    sync,
    hydrator,
    documents,
    now: () => 100,
    ...overrides,
  } as OfficialV3SyncDependencies);
  return { service, sync, hydrator, documents, pages };
}

function officialRun(): OfficialV3SyncRun {
  return {
    version: 1,
    runId: `run-${randomUUID()}`,
    accountIdentity: binding.accountIdentity,
    entry: { kind: 'since', value: '1788670542' },
    status: 'running',
    ingestionComplete: false,
    pageCount: 0,
    startedAt: 100,
    updatedAt: 100,
  };
}

function page(runId: string, pageNumber: number, nextCursor: string, hasMore: boolean) {
  return {
    runId,
    page: pageNumber,
    nextCursor,
    hasMore,
    markerCount: 1,
    responseHash: `sha256:${'a'.repeat(64)}`,
  };
}

function item(id: string, quantity = 1, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: id,
    name: id,
    quantity,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
    ...overrides,
  };
}

function stock(itemId: string, quantity = 1, stockRowId = `api:${itemId}`): ItemStockLocationRow {
  return {
    stock_row_id: stockRowId,
    item_id: itemId,
    quantity_on_hand: quantity,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
  };
}

function envelope(
  changes: OfficialV3SyncMarker[],
  hasMore: boolean,
  nextCursor: string
): OfficialV3SyncPageEnvelope {
  return {
    object: 'sync_page',
    resources: ['item', 'invoice', 'estimate', 'purchase_order'],
    changes,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

function found(id: string, quantity = 1): V3ExactItemHydrationResult {
  return {
    id,
    status: 'found_current',
    fingerprint: `fp:${id}`,
    bundle: {
      item: item(id, quantity),
      stockRows: [stock(id, quantity, `stock:${id}`)],
    },
  };
}

function missing(id: string): V3ExactItemHydrationResult {
  return { id, status: 'missing_unproven' };
}

function document(id: string, overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    doc_id: id,
    api_doc_id: id,
    context_id: 5,
    doc_number: 1002,
    issue_date: '2026-09-05',
    customer_id: customerId,
    modified: 1788670542,
    cache_source: 'api',
    imported_at: 100,
    ...overrides,
  };
}

function line(itemId: string, parentDocId: string, lineId: string): Omit<ItemDocumentRow, 'id'> {
  return {
    item_id: itemId,
    doc_id: parentDocId,
    document_item_id: lineId,
    quantity: 2,
    price: 5,
  };
}

function invoicePayload(
  id: string,
  itemId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    object: 'invoice',
    invoice_number: 1002,
    name: 'Official invoice',
    customer_id: customerId,
    customer_name: 'Example Customer',
    customer_kind: 'customer',
    salesperson_id: null,
    issue_date: '2026-09-05',
    updated_at: '2026-09-06T04:00:49+00:00',
    status_id: 9,
    status: 'Sent',
    party: { account_number: '002' },
    subtotal: '10.0000',
    total: '10.0000',
    lines: [
      {
        id: lineNew,
        object: 'invoice_line',
        invoice_id: id,
        item_id: itemId,
        line_type: 'inventory',
        name: 'Widget',
        quantity: 1,
        unit_price: '10.0000',
        subtotal: '10.0000',
      },
    ],
    ...overrides,
  };
}

async function readOfficialPages(
  pool: InstanceType<typeof Pool>,
  runId: string
): Promise<OfficialV3SyncPage[]> {
  const result = await pool.query<{ value: string }>(
    'SELECT value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key',
    [officialPagePrefix(runId)]
  );
  return result.rows.map((row) => JSON.parse(row.value) as OfficialV3SyncPage);
}

async function installTaskReceiptFailure(
  pool: InstanceType<typeof Pool>,
  task: OfficialV3SyncTask
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_official_receipt_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.key LIKE 'official_v3_sync.task.v1:%'
         AND NEW.value::jsonb ->> 'taskId' = ${quoteLiteral(task.taskId)}
         AND NEW.value::jsonb ->> 'status' = 'done' THEN
        RAISE EXCEPTION 'fail_official_receipt';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_official_receipt
    BEFORE INSERT OR UPDATE ON cache_meta
    FOR EACH ROW EXECUTE FUNCTION fail_official_receipt_fn();
  `);
}

async function installBlockingStockTrigger(
  pool: InstanceType<typeof Pool>,
  lockKey: string,
  stockRowId: string
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION block_official_v3_stock_insert_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.stock_row_id = ${quoteLiteral(stockRowId)} THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(${quoteLiteral(lockKey)}, 0));
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER block_official_v3_stock_insert
    BEFORE INSERT ON item_stock_locations
    FOR EACH ROW EXECUTE FUNCTION block_official_v3_stock_insert_fn();
  `);
}

async function waitForBlockedOwner(
  pool: InstanceType<typeof Pool>,
  applicationName: string
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
       FROM pg_locks AS lock
       JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
       WHERE lock.locktype = 'advisory'
         AND lock.granted = FALSE
         AND activity.application_name = $1
       LIMIT 1`,
      [applicationName]
    );
    const pid = result.rows[0]?.pid;
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for blocked official V3 sync-lock owner.');
}

function guardedUrl(): string {
  if (!testUrl) throw new Error('Official V3 sync PostgreSQL test URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Official integration tests require localhost PostgreSQL.');
  }
  if (!/(offset|official|test|integration)/i.test(database)) {
    throw new Error('Official integration tests require an isolated test database.');
  }
  return url.toString();
}

function scopedUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-official-${schema.slice(-30)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
