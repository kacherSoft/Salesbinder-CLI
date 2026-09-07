import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { offsetTaskKey } from '../postgres-document-offset.validation.js';
import {
  CACHE_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_META_KEY,
  createSalesBinderAccountBinding,
  type CacheState,
  type DocumentRow,
  type ItemDocumentRow,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import type { DocumentOffsetRun, DocumentOffsetTask } from '../document-offset-sync.types.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('offset-integration-test');

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const guardedUrl = (): string => {
  if (!testUrl) throw new Error('SALESBINDER_OFFSET_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Offset integration tests require a localhost PostgreSQL URL.');
  }
  if (!/(offset|test|integration)/i.test(database)) {
    throw new Error('Offset integration tests require an isolated test database name.');
  }
  return url.toString();
};

const scopedUrl = (baseUrl: string, schema: string): string => {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-offset-${schema.slice(-30)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
};

describeIfPostgres('PostgresCacheService document offset integration', () => {
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

  it('atomically replaces document lines, preserves payments, and queues old plus new item refs', async () => {
    const ctx = await createContext('doc-union');
    const run = offsetRun();
    const task = documentTask('doc-a', 1001);
    const oldLine: Omit<ItemDocumentRow, 'id'> = line('old-item', task.id);
    const paymentId = `payment-${randomUUID()}`;

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'document', [task]);
    await ctx.service.insertDocument(document(task, { document_name: 'Original' }));
    await ctx.service.insertItemDocument(oldLine);
    await ctx.pool.query(
      `INSERT INTO payment_transactions
       (transaction_id, doc_id, amount, transaction_date, imported_at)
       VALUES ($1, $2, 5, '2026-09-06', 100)`,
      [paymentId, task.id]
    );

    await ctx.service.applyOffsetDocumentBundle(
      run.runId,
      task,
      document(task, { document_name: 'Updated' }),
      [line('new-item', task.id)],
      250
    );

    await expect(ctx.service.getDocument(task.id)).resolves.toMatchObject({
      doc_id: task.id,
      document_name: 'Updated',
    });
    await expect(ctx.service.getItemDocuments(task.id)).resolves.toEqual([
      expect.objectContaining({ item_id: 'new-item', quantity: 2 }),
    ]);
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'document')).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: 'done' }),
    ]);
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'item')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'old-item', status: 'pending', verifyAfter: 250 }),
        expect.objectContaining({ id: 'new-item', status: 'pending', verifyAfter: 250 }),
      ])
    );
    await expect(readPaymentCount(ctx.pool, paymentId)).resolves.toBe(1);
  });

  it('rolls back queued item tasks and document writes when the document transaction fails', async () => {
    const ctx = await createContext('doc-rollback');
    const run = offsetRun();
    const task = documentTask('doc-b', 1002);

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'document', [task]);
    await installThrowingTrigger(ctx.pool, 'documents', 'fail_document_offset_write');

    await expect(
      ctx.service.applyOffsetDocumentBundle(
        run.runId,
        task,
        document(task),
        [line('new-item', task.id)],
        300
      )
    ).rejects.toThrow('fail_document_offset_write');

    await expect(ctx.service.getDocument(task.id)).resolves.toBeUndefined();
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'document')).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: 'pending' }),
    ]);
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'item')).resolves.toEqual([]);
  });

  it('replaces only API stock, preserves CSV stock, and clears legacy inventory provenance', async () => {
    const ctx = await createContext('item-replace');
    const run = offsetRun();
    const task: DocumentOffsetTask = { id: 'item-a', status: 'pending', attempts: 1 };
    const state: CacheState = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastSync: 40,
      lastFullSync: 20,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: binding.accountSubdomain,
      lastItemSync: 30,
      inventorySourceApiVersion: '2.0',
    };

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'item', [task]);
    await ctx.service.setCacheState(state);
    await putMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY, JSON.stringify({ prior: true }));
    await ctx.service.insertItem(item(task.id, { name: 'Prior item', quantity: 1 }));
    await ctx.service.insertItemStockLocation(stock('old-api-stock', task.id, { quantity_on_hand: 1 }));
    await ctx.service.insertItemStockLocation(
      stock('csv-stock', task.id, { cache_source: 'csv', source_api_version: null })
    );

    await ctx.service.applyOffsetInventoryBundle(
      run.runId,
      task,
      item(task.id, { name: 'Current item', quantity: 9 }),
      [stock('new-api-stock', task.id, { quantity_on_hand: 9 })]
    );

    await expect(ctx.service.getItem(task.id)).resolves.toMatchObject({
      item_id: task.id,
      name: 'Current item',
      quantity: 9,
      source_api_version: '3',
    });
    await expect(ctx.service.getItemStockLocations(task.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stock_row_id: 'csv-stock', cache_source: 'csv' }),
        expect.objectContaining({ stock_row_id: 'new-api-stock', cache_source: 'api' }),
      ])
    );
    await expect(ctx.service.getItemStockLocations(task.id)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ stock_row_id: 'old-api-stock' })])
    );
    await expect(ctx.service.getCacheState()).resolves.toMatchObject({
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastSync: 40,
      lastFullSync: 20,
      lastItemSync: 30,
    });
    expect((await ctx.service.getCacheState())?.inventorySourceApiVersion).toBeUndefined();
    await expect(readMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY)).resolves.toBeNull();
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'item')).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: 'done' }),
    ]);
  });

  it('rolls back an item transaction failure, leaving the prior bundle and pending task', async () => {
    const ctx = await createContext('item-rollback');
    const run = offsetRun();
    const task: DocumentOffsetTask = { id: 'item-b', status: 'pending', attempts: 2 };
    const state: CacheState = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastSync: 80,
      lastFullSync: 70,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: binding.accountSubdomain,
    };

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'item', [task]);
    await ctx.service.setCacheState(state);
    await ctx.service.insertItem(item(task.id, { name: 'Prior item', quantity: 1 }));
    await ctx.service.insertItemStockLocation(stock('prior-api-stock', task.id));
    await putMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY, JSON.stringify({ prior: true }));
    await installTaskCompletionFailure(ctx.pool, run.runId, task);

    await expect(
      ctx.service.applyOffsetInventoryBundle(
        run.runId,
        task,
        item(task.id, { name: 'Failed item', quantity: 7 }),
        [stock('failed-api-stock', task.id, { quantity_on_hand: 7 })]
      )
    ).rejects.toThrow('fail_item_task_completion');

    await expect(ctx.service.getItem(task.id)).resolves.toMatchObject({
      name: 'Prior item',
      quantity: 1,
    });
    await expect(ctx.service.getItemStockLocations(task.id)).resolves.toEqual([
      expect.objectContaining({ stock_row_id: 'prior-api-stock' }),
    ]);
    await expect(readMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY)).resolves.toBe(
      JSON.stringify({ prior: true })
    );
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'item')).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: 'pending', attempts: 2 }),
    ]);
  });

  it('resumes after close and reopen with the original cutoff and completed task state', async () => {
    const ctx = await createContext('resume');
    const run = offsetRun({ cutoff: 12345, startedAt: 20000, updatedAt: 20000, days: 17 });
    const task = documentTask('doc-c', 1003);
    const url = ctx.url;

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'document', [task]);
    await ctx.service.applyOffsetDocumentBundle(run.runId, task, document(task), [line('item-c', task.id)], 0);
    await ctx.service.close();

    ctx.service = new PostgresCacheService(url);
    await ctx.service.verifyAccountBinding(binding);

    await expect(ctx.service.getOffsetSyncRun()).resolves.toMatchObject({
      runId: run.runId,
      cutoff: 12345,
      days: 17,
      status: 'running',
    });
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'document')).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: 'done' }),
    ]);
    await expect(ctx.service.listOffsetSyncTasks(run.runId, 'item')).resolves.toEqual([
      expect.objectContaining({ id: 'item-c', status: 'pending' }),
    ]);
  });

  it('fences offset writes after a real sync-lock owner backend is terminated', async () => {
    const ctx = await createContext('lock-loss');
    const run = offsetRun();
    const task: DocumentOffsetTask = { id: 'blocked-item', status: 'pending', attempts: 1 };
    const blockerKey = `offset-block-${randomUUID()}`;
    const blocker = await ctx.pool.connect();

    await ctx.service.saveOffsetSyncRun(run);
    await ctx.service.saveOffsetSyncTasks(run.runId, 'item', [task]);
    await expect(ctx.service.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    await installBlockingStockTrigger(ctx.pool, blockerKey, 'blocked-stock');

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [blockerKey]);
      const inFlight = ctx.service
        .applyOffsetInventoryBundle(
          run.runId,
          task,
          item(task.id),
          [stock('blocked-stock', task.id)]
        )
        .then(() => ({ completed: true, error: undefined }))
        .catch((error: Error) => ({ completed: false, error }));

      const pid = await waitForBlockedOwner(ctx.pool, ctx.applicationName);
      await ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await inFlight;

      expect(result.completed).toBe(false);
      expect(result.error?.message).toBe('PostgreSQL sync lock lost.');
      await expect(ctx.service.saveOffsetSyncTasks(run.runId, 'item', [task])).rejects.toThrow(
        'PostgreSQL sync lock lost.'
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('PostgreSQL admin pool was not initialized.');
    const schema = `offset_${label.replaceAll('-', '_')}_${randomUUID().replaceAll('-', '_')}`;
    const applicationName = `sb-offset-${schema.slice(-30)}`;
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const url = scopedUrl(baseUrl, schema);
    const service = new PostgresCacheService(url);
    const pool = new Pool({ connectionString: url });
    const ctx = { schema, url, applicationName, service, pool };
    contexts.push(ctx);
    await service.ensureAccountBinding(binding);
    return ctx;
  }

  async function cleanup(ctx: TestContext | undefined): Promise<void> {
    if (!ctx || !adminPool) return;
    await ctx.service.close().catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(ctx.schema)} CASCADE`).catch(() => undefined);
  }
});

interface TestContext {
  schema: string;
  url: string;
  applicationName: string;
  service: PostgresCacheService;
  pool: InstanceType<typeof Pool>;
}

function offsetRun(overrides: Partial<DocumentOffsetRun> = {}): DocumentOffsetRun {
  return {
    version: 1,
    runId: `run-${randomUUID()}`,
    accountIdentity: binding.accountIdentity,
    startedAt: 100,
    cutoff: 10,
    days: 30,
    updatedAt: 100,
    discoveryComplete: false,
    status: 'running',
    ...overrides,
  };
}

function documentTask(id: string, documentNumber: number): DocumentOffsetTask {
  return {
    id,
    contextId: 5,
    documentNumber,
    selectedModified: 90,
    status: 'pending',
    attempts: 1,
  };
}

function document(task: DocumentOffsetTask, overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    doc_id: task.id,
    api_doc_id: task.id,
    context_id: task.contextId ?? 5,
    doc_number: task.documentNumber ?? 1,
    issue_date: '2026-09-06',
    customer_id: 'offset-customer',
    modified: task.selectedModified ?? 90,
    cache_source: 'api',
    imported_at: 100,
    ...overrides,
  };
}

function line(itemId: string, docId: string): Omit<ItemDocumentRow, 'id'> {
  return { item_id: itemId, doc_id: docId, quantity: 2, price: 5, item_name: itemId };
}

function item(id: string, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: id,
    name: id,
    quantity: 2,
    quantity_reserved: 0,
    quantity_available: 2,
    quantity_incoming: 0,
    in_transit: 0,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
    ...overrides,
  };
}

function stock(
  id: string,
  itemId: string,
  overrides: Partial<ItemStockLocationRow> = {}
): ItemStockLocationRow {
  return {
    stock_row_id: id,
    item_id: itemId,
    quantity_on_hand: 2,
    quantity_reserved: 0,
    quantity_available: 2,
    quantity_incoming: 0,
    in_transit: 0,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
    ...overrides,
  };
}

async function putMeta(pool: InstanceType<typeof Pool>, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function readMeta(pool: InstanceType<typeof Pool>, key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>('SELECT value FROM cache_meta WHERE key = $1', [
    key,
  ]);
  return result.rows[0]?.value ?? null;
}

async function readPaymentCount(pool: InstanceType<typeof Pool>, id: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM payment_transactions WHERE transaction_id = $1',
    [id]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function installThrowingTrigger(
  pool: InstanceType<typeof Pool>,
  table: string,
  message: string
): Promise<void> {
  const functionName = `${message}_fn`;
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${quoteIdentifier(functionName)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION ${quoteLiteral(message)};
    END;
    $$;
    CREATE TRIGGER ${quoteIdentifier(message)}
    BEFORE INSERT OR UPDATE ON ${quoteIdentifier(table)}
    FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(functionName)}();
  `);
}

async function installTaskCompletionFailure(
  pool: InstanceType<typeof Pool>,
  runId: string,
  task: DocumentOffsetTask
): Promise<void> {
  const key = offsetTaskKey(runId, 'item', task);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_item_task_completion_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.key = ${quoteLiteral(key)} AND NEW.value::jsonb ->> 'status' = 'done' THEN
        RAISE EXCEPTION 'fail_item_task_completion';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_item_task_completion
    BEFORE INSERT OR UPDATE ON cache_meta
    FOR EACH ROW EXECUTE FUNCTION fail_item_task_completion_fn();
  `);
}

async function installBlockingStockTrigger(
  pool: InstanceType<typeof Pool>,
  lockKey: string,
  stockRowId: string
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION block_offset_stock_insert_fn()
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
    CREATE TRIGGER block_offset_stock_insert
    BEFORE INSERT ON item_stock_locations
    FOR EACH ROW EXECUTE FUNCTION block_offset_stock_insert_fn();
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
  throw new Error('Timed out waiting for blocked sync-lock owner.');
}
