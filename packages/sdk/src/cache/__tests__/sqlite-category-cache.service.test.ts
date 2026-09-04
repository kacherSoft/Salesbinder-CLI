import Database from 'better-sqlite3';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { createCategoryFingerprint } from '../category-indexer.service.js';
import { CACHE_SCHEMA_VERSION, CATEGORY_GENERATION_META_KEY } from '../types.js';
import type {
  CacheState,
  CategoryCacheMeta,
  CategoryCacheRow,
  CategorySnapshot,
} from '../types.js';

describe('SQLite category cache', () => {
  let path: string;
  let cache: SQLiteCacheService;

  beforeEach(() => {
    path = join(
      tmpdir(),
      `sqlite-category-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    cache = new SQLiteCacheService('local-account', path);
  });

  afterEach(async () => {
    if (cache.isOpen()) await cache.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  });

  it('creates the exact unseeded current category schemas', () => {
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(CACHE_SCHEMA_VERSION);
      expect(tableColumns(db, 'categories')).toEqual([
        ['category_id', 'TEXT', 0, 1],
        ['name', 'TEXT', 1, 0],
        ['item_count', 'INTEGER', 0, 0],
        ['parent_id', 'TEXT', 0, 0],
        ['parent_name', 'TEXT', 0, 0],
        ['inventory_type', 'TEXT', 0, 0],
        ['custom_fields_json', 'TEXT', 0, 0],
        ['created', 'TEXT', 0, 0],
        ['modified', 'INTEGER', 0, 0],
        ['cache_source', 'TEXT', 1, 0],
        ['source_api_version', 'TEXT', 0, 0],
        ['imported_at', 'INTEGER', 1, 0],
      ]);
      expect(tableColumns(db, 'category_cache_meta')).toEqual([
        ['key', 'TEXT', 0, 1],
        ['value', 'TEXT', 1, 0],
      ]);
      expect(count(db, 'category_cache_meta')).toBe(0);
      expect(metaValue(db, CATEGORY_GENERATION_META_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('migrates a genuine v5 database and rolls back a failing v5 migration', async () => {
    await cache.close();
    const db = new Database(path);
    db.exec(`
      DROP INDEX idx_categories_name;
      DROP INDEX idx_categories_parent_id;
      DROP TABLE category_cache_meta;
      DROP TABLE categories;
      PRAGMA user_version = 5;
    `);
    db.close();

    cache = new SQLiteCacheService('local-account', path);
    const migrated = new Database(path, { readonly: true });
    expect(migrated.pragma('user_version', { simple: true })).toBe(CACHE_SCHEMA_VERSION);
    migrated.close();
    await cache.close();

    const broken = new Database(path);
    broken.exec(`
      DROP INDEX idx_categories_name;
      DROP INDEX idx_categories_parent_id;
      DROP TABLE category_cache_meta;
      DROP TABLE categories;
      CREATE TABLE categories (category_id TEXT PRIMARY KEY);
      PRAGMA user_version = 5;
    `);
    broken.close();

    expect(() => new SQLiteCacheService('local-account', path)).toThrow(/no such column: name/);
    const rolledBack = new Database(path, { readonly: true });
    try {
      expect(rolledBack.pragma('user_version', { simple: true })).toBe(5);
      expect(tableExists(rolledBack, 'category_cache_meta')).toBe(false);
      expect(tableColumns(rolledBack, 'categories')).toEqual([['category_id', 'TEXT', 0, 1]]);
    } finally {
      rolledBack.close();
    }
  });

  it('replaces a snapshot atomically and reconciles item and stock names', async () => {
    await cache.setCacheState(state(5));
    await cache.batchInsertItems([
      { item_id: 'known', name: 'Known', category_id: 'child', category_name: 'stale' },
      { item_id: 'missing', name: 'Missing', category_id: 'gone', category_name: 'stale' },
      { item_id: 'weak', name: 'Weak', category_id: null, category_name: 'display-only' },
    ]);
    await cache.batchInsertItemStockLocations([
      stock('known-stock', 'known', 'stale'),
      stock('missing-stock', 'missing', 'stale'),
      stock('weak-stock', 'weak', 'display-only'),
    ]);

    await cache.replaceCategorySnapshot(
      snapshot('gen-1', [
        category('parent', 'Parent'),
        category('child', 'Child', 'parent', 'Parent'),
      ])
    );

    expect(await cache.getAllCategories()).toEqual([
      category('child', 'Child', 'parent', 'Parent'),
      category('parent', 'Parent'),
    ]);
    expect(await cache.getCategoryCacheMeta()).toMatchObject({
      generation: 'gen-1',
      storedRowCount: 2,
    });
    expect(
      (await cache.getAllItems())
        .map(({ item_id, category_name }) => [item_id, category_name])
        .sort()
    ).toEqual([
      ['known', 'Child'],
      ['missing', null],
      ['weak', 'display-only'],
    ]);
    expect(
      (await cache.getAllItemStockLocations())
        .map(({ stock_row_id, category_name }) => [stock_row_id, category_name])
        .sort()
    ).toEqual([
      ['known-stock', 'Child'],
      ['missing-stock', null],
      ['weak-stock', 'display-only'],
    ]);
    expect((await cache.getCacheState())?.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    await cache.setCacheState({ ...(await cache.getCacheState())!, lastSync: 2 });
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBe('gen-1');
  });

  it('rolls back rows, meta, marker, and reconciliation when replacement fails', async () => {
    await cache.replaceCategorySnapshot(snapshot('old-generation', [category('old', 'Old')]));
    await cache.insertItem({
      item_id: 'item',
      name: 'Item',
      category_id: 'old',
      category_name: 'Old',
    });
    const db = new Database(path);
    db.exec(
      `CREATE TRIGGER fail_category_name BEFORE UPDATE OF category_name ON items BEGIN SELECT RAISE(ABORT, 'forced category failure'); END;`
    );
    db.close();

    expect(() =>
      cache.replaceCategorySnapshot(snapshot('new-generation', [category('new', 'New')]))
    ).toThrow(/forced category failure/);
    expect(await cache.getCategorySnapshot()).toEqual(
      snapshot('old-generation', [category('old', 'Old')])
    );
    expect((await cache.getItem('item'))?.category_name).toBe('Old');
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBe('old-generation');
  });

  it.each([
    ['mismatched counts', { count: 2 }],
    ['reversed timestamps', { startedAt: 101, completedAt: 100 }],
    ['extra metadata fields', { unexpected: true }],
  ])('rejects %s before replacing authoritative data', async (_label, metaOverride) => {
    await cache.replaceCategorySnapshot(snapshot('old-generation', [category('old', 'Old')]));
    const candidate = snapshot('invalid-generation', [category('new', 'New')]);
    const invalid = {
      ...candidate,
      meta: { ...candidate.meta, ...metaOverride },
    } as CategorySnapshot;

    expect(() => cache.replaceCategorySnapshot(invalid)).toThrow(/snapshot/i);
    expect(await cache.getCategorySnapshot()).toEqual(
      snapshot('old-generation', [category('old', 'Old')])
    );
  });

  it('rejects category strings containing NUL before persisting fingerprinted rows', async () => {
    const invalid = snapshot('nul-generation', [category('category', 'A\0B')]);

    expect(() => cache.replaceCategorySnapshot(invalid)).toThrow(/invalid row/);
    expect(await cache.getCategorySnapshot()).toBeNull();
  });

  it('fails closed without mutating stale authority, then invalidates it on the current state transition', async () => {
    await cache.replaceCategorySnapshot(snapshot('stale-generation', [category('old', 'Old')]));
    const db = new Database(path);
    db.prepare(`UPDATE cache_meta SET value = ? WHERE key = 'state'`).run(JSON.stringify(state(5)));
    db.close();
    await cache.close();

    cache = new SQLiteCacheService('local-account', path);
    expect(await cache.getCategorySnapshot()).toBeNull();
    expect(await cache.getCategoryCacheMeta()).toBeNull();
    expect(await cache.getAllCategories()).toEqual([]);
    expect(await cache.getCategoryCount()).toBe(0);
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBe('stale-generation');

    await cache.setCacheState(state(CACHE_SCHEMA_VERSION));
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBeUndefined();
    expect(await cache.getCategorySnapshot()).toBeNull();
    await cache.setCacheState({ ...state(CACHE_SCHEMA_VERSION), lastSync: 2 });
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBeUndefined();
  });

  it('clear removes category rows, typed meta, and the generation marker', async () => {
    await cache.replaceCategorySnapshot(snapshot('clear-generation', [category('old', 'Old')]));
    await cache.clearAll();
    const db = new Database(path, { readonly: true });
    try {
      expect(count(db, 'categories')).toBe(0);
      expect(count(db, 'category_cache_meta')).toBe(0);
      expect(metaValue(db, CATEGORY_GENERATION_META_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([true, false])(
    'mirror handles authoritative=%s category data atomically',
    async (authoritative) => {
      await cache.replaceCategorySnapshot(snapshot('old-generation', [category('old', 'Old')]));
      await cache.replaceMirror({
        accounts: [],
        categorySnapshot: authoritative
          ? snapshot('mirror-generation', [category('new', 'Canonical')])
          : null,
        items: [
          { item_id: 'mirror-item', name: 'Mirror', category_id: 'new', category_name: 'Incoming' },
        ],
        itemStockLocations: [stock('mirror-stock', 'mirror-item', 'Incoming')],
        documents: [],
        itemDocuments: [],
        paymentTransactions: [],
        cacheState: state(7),
        paymentSyncStatus: null,
        syncStatus: null,
        pulledAt: 123,
      });

      expect((await cache.getItem('mirror-item'))?.category_name).toBe(
        authoritative ? 'Canonical' : 'Incoming'
      );
      expect((await cache.getItemStockLocations('mirror-item'))[0].category_name).toBe(
        authoritative ? 'Canonical' : 'Incoming'
      );
      expect(await cache.getCategorySnapshot()).toEqual(
        authoritative ? snapshot('mirror-generation', [category('new', 'Canonical')]) : null
      );
      expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBe(
        authoritative ? 'mirror-generation' : undefined
      );
    }
  );

  it('rolls back the complete mirror when category reconciliation fails', async () => {
    await cache.insertItem({
      item_id: 'old-item',
      name: 'Old item',
      category_id: 'old',
      category_name: 'Old',
    });
    await cache.insertItemStockLocation(stock('old-stock', 'old-item', 'Old'));
    await cache.replaceCategorySnapshot(snapshot('old-generation', [category('old', 'Old')]));
    const db = new Database(path);
    db.exec(
      `CREATE TRIGGER fail_mirror_category BEFORE UPDATE OF category_name ON items BEGIN SELECT RAISE(ABORT, 'forced mirror failure'); END;`
    );
    db.close();

    expect(() =>
      cache.replaceMirror({
        accounts: [],
        categorySnapshot: snapshot('new-generation', [category('new', 'New')]),
        items: [
          { item_id: 'new-item', name: 'New item', category_id: 'new', category_name: 'Incoming' },
        ],
        itemStockLocations: [stock('new-stock', 'new-item', 'Incoming')],
        documents: [],
        itemDocuments: [],
        paymentTransactions: [],
        cacheState: state(7),
        paymentSyncStatus: null,
        syncStatus: null,
        pulledAt: 456,
      })
    ).toThrow(/forced mirror failure/);

    expect(await cache.getCategorySnapshot()).toEqual(
      snapshot('old-generation', [category('old', 'Old')])
    );
    expect(await cache.getItem('old-item')).toBeDefined();
    expect(await cache.getItem('new-item')).toBeUndefined();
    expect((await cache.getItemStockLocations('old-item'))[0].category_name).toBe('Old');
    expect(rawMeta(path, CATEGORY_GENERATION_META_KEY)).toBe('old-generation');
  });

  it('durably binds an empty SQLite file and rejects alias-collision account mismatches', async () => {
    const first = { accountIdentity: 'salesbinder:one', accountSubdomain: 'one' };
    const second = { accountIdentity: 'salesbinder:two', accountSubdomain: 'two' };
    await cache.ensureAccountBinding(first);
    await cache.insertItem({ item_id: 'bound-item', name: 'Bound item' });

    await expect(cache.ensureAccountBinding(second)).rejects.toThrow(
      /not bound to salesbinder:two/i
    );
    await expect(cache.verifyAccountBinding(second)).rejects.toThrow(
      /not bound to salesbinder:two/i
    );
    expect(await cache.getItem('bound-item')).toBeDefined();

    await cache.close();
    cache = new SQLiteCacheService('colliding:alias', path);
    await expect(cache.verifyAccountBinding(first)).resolves.toBeUndefined();
    const db = new Database(path, { readonly: true });
    try {
      expect(metaValue(db, 'cache_account_binding.v1.account_identity')).toBe(
        first.accountIdentity
      );
      expect(metaValue(db, 'cache_account_binding.v1.account_subdomain')).toBe(
        first.accountSubdomain
      );
      expect(tableExists(db, 'cache_account_binding')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('refuses to adopt a populated legacy SQLite file without a durable binding', async () => {
    await cache.insertItem({ item_id: 'legacy-item', name: 'Legacy item' });

    await expect(
      cache.ensureAccountBinding({
        accountIdentity: 'salesbinder:one',
        accountSubdomain: 'one',
      })
    ).rejects.toThrow(/populated but has no account binding/i);

    expect(await cache.getItem('legacy-item')).toBeDefined();
  });

  it('preserves the durable account binding when cache payloads are cleared', async () => {
    const binding = { accountIdentity: 'salesbinder:one', accountSubdomain: 'one' };
    await cache.ensureAccountBinding(binding);
    await cache.insertItem({ item_id: 'clear-item', name: 'Clear item' });

    await cache.clearAll();

    await expect(cache.verifyAccountBinding(binding)).resolves.toBeUndefined();
    await expect(
      cache.verifyAccountBinding({
        accountIdentity: 'salesbinder:two',
        accountSubdomain: 'two',
      })
    ).rejects.toThrow(/not bound to salesbinder:two/i);
    expect(await cache.getItem('clear-item')).toBeUndefined();
  });

  it('permits forced deletion only for a completely unbound legacy file', async () => {
    await cache.insertItem({ item_id: 'legacy-delete-item', name: 'Legacy delete item' });
    await expect(cache.verifyUnboundForDeletion()).resolves.toBeUndefined();

    cache.setRawMeta('cache_account_binding.v1.account_identity', 'salesbinder:one');
    cache.setRawMeta('cache_account_binding.v1.account_subdomain', 'one');

    await expect(cache.verifyUnboundForDeletion()).rejects.toThrow(/has an account binding/i);
  });
});

const category = (
  category_id: string,
  name: string,
  parent_id: string | null = null,
  parent_name: string | null = null
): CategoryCacheRow => ({
  category_id,
  name,
  item_count: null,
  parent_id,
  parent_name,
  inventory_type: null,
  custom_fields_json: null,
  created: null,
  modified: null,
  cache_source: 'api',
  source_api_version: '2.0',
  imported_at: 100,
});

const snapshot = (generation: string, rows: CategoryCacheRow[]): CategorySnapshot => {
  const meta = {
    version: 1,
    status: 'complete',
    accountIdentity: 'salesbinder:test',
    startedAt: 90,
    completedAt: 100,
    count: rows.length,
    page: 1,
    pages: rows.length ? 1 : 0,
    sourceRowCount: rows.length,
    storedRowCount: rows.length,
    schemaVersion: CACHE_SCHEMA_VERSION,
    sourceApiVersion: '2.0',
    generation,
  } satisfies Omit<CategoryCacheMeta, 'fingerprint'>;
  return {
    rows,
    meta: {
      ...meta,
      fingerprint: createCategoryFingerprint(meta, rows, CACHE_SCHEMA_VERSION),
    },
  };
};

const state = (schemaVersion: number): CacheState => ({
  lastSync: 1,
  lastFullSync: 1,
  documentCount: 0,
  itemDocumentCount: 0,
  accountName: 'test',
  schemaVersion,
});

const stock = (stock_row_id: string, item_id: string, category_name: string) => ({
  stock_row_id,
  item_id,
  category_name,
  quantity_on_hand: 0,
  quantity_reserved: 0,
  quantity_available: 0,
  quantity_incoming: 0,
  in_transit: 0,
});

const tableColumns = (db: Database.Database, table: string) =>
  (
    db.pragma(`table_info(${table})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>
  ).map(({ name, type, notnull, pk }) => [name, type, notnull, pk]);
const tableExists = (db: Database.Database, table: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count;
const metaValue = (db: Database.Database, key: string) =>
  (
    db.prepare('SELECT value FROM cache_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;
const rawMeta = (dbPath: string, key: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return metaValue(db, key);
  } finally {
    db.close();
  }
};
