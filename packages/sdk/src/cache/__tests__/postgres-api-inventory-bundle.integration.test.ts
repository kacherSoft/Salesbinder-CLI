import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import {
  CACHE_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_META_KEY,
  createSalesBinderAccountBinding,
  type CacheState,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('api-bundle-integration-test');

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const guardedUrl = (): string => {
  if (!testUrl) throw new Error('SALESBINDER_OFFSET_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('API inventory bundle integration tests require a localhost PostgreSQL URL.');
  }
  if (!/(offset|test|integration)/i.test(database)) {
    throw new Error(
      'API inventory bundle integration tests require an isolated test database name.'
    );
  }
  return url.toString();
};

const scopedUrl = (baseUrl: string, schema: string): string => {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-api-bundle-${schema.slice(-24)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
};

describeIfPostgres('PostgresCacheService API inventory bundle integration', () => {
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

  it('replaces only API stock, preserves CSV stock, normalizes omitted fields, and invalidates snapshot authority', async () => {
    const ctx = await createContext('replace_preserve');
    const state: CacheState = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastSync: 40,
      lastFullSync: 20,
      lastItemSync: 30,
      lastFullItemSync: 25,
      documentCount: 3,
      itemDocumentCount: 4,
      accountName: binding.accountSubdomain,
      inventorySourceApiVersion: '3',
    };

    await ctx.service.setCacheState(state);
    await putMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY, JSON.stringify({ prior: true }));
    await ctx.service.insertItem(item('bundle-item', { name: 'Prior item', quantity: 1 }));
    await ctx.service.insertItemStockLocation(
      stock('old-api-stock', 'bundle-item', { quantity_on_hand: 1 })
    );
    await ctx.service.insertItemStockLocation(
      stock('csv-stock', 'bundle-item', {
        cache_source: 'csv',
        source_api_version: null,
        quantity_on_hand: 22,
      })
    );

    await ctx.service.replaceApiInventoryBundle(
      item('bundle-item', { name: 'Current API item', quantity: 7 }),
      [stock('new-api-stock', 'bundle-item', { quantity_on_hand: 7 })]
    );

    await expect(ctx.service.getItem('bundle-item')).resolves.toMatchObject({
      item_id: 'bundle-item',
      name: 'Current API item',
      quantity: 7,
      archived: null,
      cache_source: 'api',
      source_api_version: '3',
    });
    await expect(readItemOptionalFields(ctx.pool, 'bundle-item')).resolves.toMatchObject({
      description: null,
      sku: null,
      category_id: null,
      threshold: null,
    });
    await expect(ctx.service.getItemStockLocations('bundle-item')).resolves.toEqual([
      expect.objectContaining({
        stock_row_id: 'csv-stock',
        cache_source: 'csv',
        quantity_on_hand: 22,
      }),
      expect.objectContaining({
        stock_row_id: 'new-api-stock',
        cache_source: 'api',
        quantity_on_hand: 7,
      }),
    ]);
    await expect(ctx.service.getItemStockLocations('bundle-item')).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ stock_row_id: 'old-api-stock' })])
    );
    await expect(readMeta(ctx.pool, INVENTORY_SNAPSHOT_META_KEY)).resolves.toBeNull();
    await expect(ctx.service.getCacheState()).resolves.toMatchObject({
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastSync: 40,
      lastFullSync: 20,
      lastItemSync: 30,
      lastFullItemSync: 25,
      documentCount: 3,
      itemDocumentCount: 4,
    });
    expect((await ctx.service.getCacheState())?.inventorySourceApiVersion).toBeUndefined();
  });

  it('rolls back when the replacement stock ID collides with preserved CSV stock', async () => {
    const ctx = await createContext('collision_rollback');

    await ctx.service.insertItem(item('collision-item', { name: 'Prior item', quantity: 3 }));
    await ctx.service.insertItemStockLocation(
      stock('prior-api-stock', 'collision-item', { quantity_on_hand: 3 })
    );
    await ctx.service.insertItemStockLocation(
      stock('colliding-stock', 'collision-item', {
        cache_source: 'csv',
        source_api_version: null,
        quantity_on_hand: 13,
      })
    );

    await expect(
      ctx.service.replaceApiInventoryBundle(
        item('collision-item', { name: 'Rejected item', quantity: 9 }),
        [stock('colliding-stock', 'collision-item', { quantity_on_hand: 9 })]
      )
    ).rejects.toThrow('API inventory stock identity conflict');

    await expect(ctx.service.getItem('collision-item')).resolves.toMatchObject({
      name: 'Prior item',
      quantity: 3,
    });
    const rows = await ctx.service.getItemStockLocations('collision-item');
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stock_row_id: 'colliding-stock',
          cache_source: 'csv',
          quantity_on_hand: 13,
        }),
        expect.objectContaining({
          stock_row_id: 'prior-api-stock',
          cache_source: 'api',
          quantity_on_hand: 3,
        }),
      ])
    );
  });

  it('rejects invalid API source rows before mutating the stored bundle', async () => {
    const ctx = await createContext('source_validation');

    await ctx.service.insertItem(item('validated-item', { name: 'Prior item', quantity: 2 }));
    await ctx.service.insertItemStockLocation(
      stock('validated-stock', 'validated-item', { quantity_on_hand: 2 })
    );

    await expect(
      ctx.service.replaceApiInventoryBundle(
        item('validated-item', { cache_source: 'csv' as const }),
        [stock('replacement-stock', 'validated-item')]
      )
    ).rejects.toThrow('API inventory bundle is invalid: item');

    await expect(
      ctx.service.replaceApiInventoryBundle(item('validated-item'), [
        stock('replacement-stock', 'validated-item', {
          source_api_version: '2.0',
        }),
      ])
    ).rejects.toThrow('API inventory bundle is invalid: stock');

    await expect(ctx.service.getItem('validated-item')).resolves.toMatchObject({
      name: 'Prior item',
      quantity: 2,
    });
    await expect(ctx.service.getItemStockLocations('validated-item')).resolves.toEqual([
      expect.objectContaining({ stock_row_id: 'validated-stock', quantity_on_hand: 2 }),
    ]);
  });

  it('fails closed with no partial publish after the retained writer-lock backend is terminated', async () => {
    const ctx = await createContext('lock_loss');
    const blockerKey = `api-bundle-block-${randomUUID()}`;
    const blocker = await ctx.pool.connect();

    await ctx.service.insertItem(item('locked-item', { name: 'Prior item', quantity: 5 }));
    await ctx.service.insertItemStockLocation(
      stock('prior-locked-stock', 'locked-item', { quantity_on_hand: 5 })
    );
    await expect(ctx.service.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    await installBlockingStockTrigger(ctx.pool, blockerKey, 'blocked-api-stock');

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [blockerKey]);
      const inFlight = ctx.service
        .replaceApiInventoryBundle(item('locked-item', { name: 'Blocked item', quantity: 11 }), [
          stock('blocked-api-stock', 'locked-item', { quantity_on_hand: 11 }),
        ])
        .then(() => ({ completed: true, error: undefined }))
        .catch((error: Error) => ({ completed: false, error }));

      const pid = await waitForBlockedOwner(ctx.pool, ctx.applicationName);
      await ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await inFlight;

      expect(result.completed).toBe(false);
      expect(result.error?.message).toBe('PostgreSQL sync lock lost.');
      await expect(ctx.service.getItem('locked-item')).resolves.toMatchObject({
        name: 'Prior item',
        quantity: 5,
      });
      await expect(ctx.service.getItemStockLocations('locked-item')).resolves.toEqual([
        expect.objectContaining({ stock_row_id: 'prior-locked-stock', quantity_on_hand: 5 }),
      ]);
      await expect(
        ctx.service.replaceApiInventoryBundle(item('locked-item'), [
          stock('after-loss-stock', 'locked-item'),
        ])
      ).rejects.toThrow('PostgreSQL sync lock lost.');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('PostgreSQL admin pool was not initialized.');
    const schema = `api_bundle_${label}_${randomUUID().replaceAll('-', '_')}`;
    const applicationName = `sb-api-bundle-${schema.slice(-24)}`;
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

function item(id: string, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: id,
    name: id,
    quantity: 2,
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

function stock(
  id: string,
  itemId: string,
  overrides: Partial<ItemStockLocationRow> = {}
): ItemStockLocationRow {
  const quantity = overrides.quantity_on_hand ?? 2;
  return {
    stock_row_id: id,
    item_id: itemId,
    quantity_on_hand: quantity,
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

async function putMeta(pool: InstanceType<typeof Pool>, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function readMeta(pool: InstanceType<typeof Pool>, key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    'SELECT value FROM cache_meta WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value ?? null;
}

async function readItemOptionalFields(
  pool: InstanceType<typeof Pool>,
  itemId: string
): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT description, sku, category_id, threshold FROM items WHERE item_id = $1`,
    [itemId]
  );
  return result.rows[0] ?? {};
}

async function installBlockingStockTrigger(
  pool: InstanceType<typeof Pool>,
  lockKey: string,
  stockRowId: string
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION block_api_bundle_stock_insert_fn()
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
    CREATE TRIGGER block_api_bundle_stock_insert
    BEFORE INSERT ON item_stock_locations
    FOR EACH ROW EXECUTE FUNCTION block_api_bundle_stock_insert_fn();
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
