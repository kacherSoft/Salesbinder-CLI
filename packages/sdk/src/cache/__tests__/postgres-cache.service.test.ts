import { PostgresCacheService } from '../postgres-cache.service.js';
import type {
  CacheAccountBinding,
  CacheState,
  CategorySnapshot,
  InventorySnapshot,
} from '../types.js';

const binding: CacheAccountBinding = {
  accountIdentity: 'salesbinder:acme',
  accountSubdomain: 'acme',
  createdAt: 100,
};

const state = (schemaVersion = 7): CacheState => ({
  lastSync: 1,
  lastFullSync: 1,
  documentCount: 0,
  itemDocumentCount: 0,
  accountName: 'alias-can-change',
  schemaVersion,
});

const snapshot = (): CategorySnapshot => ({
  rows: [
    {
      category_id: 'parent', name: 'Parent', item_count: 1, parent_id: null,
      parent_name: null, created: '2026-01-01', modified: 10,
      inventory_type: 'quantity', custom_fields_json: '[]',
      cache_source: 'api', source_api_version: '3', imported_at: 20,
    },
    {
      category_id: 'child', name: 'Child', item_count: null, parent_id: 'parent',
      parent_name: 'Parent', created: null, modified: null,
      inventory_type: null, custom_fields_json: null,
      cache_source: 'api', source_api_version: '3', imported_at: 20,
    },
  ],
  meta: {
    version: 1,
    status: 'complete',
    accountIdentity: binding.accountIdentity,
    startedAt: 19,
    completedAt: 20,
    count: 2,
    page: 1,
    pages: 1,
    sourceRowCount: 2,
    storedRowCount: 2,
    schemaVersion: 7,
    sourceApiVersion: '3',
    generation: 'generation-1',
    fingerprint: 'sha256:test',
  },
});

const inventorySnapshot = (): InventorySnapshot => ({
  items: [{
    item_id: 'item-api', name: 'API item', quantity: 8, quantity_reserved: 2,
    quantity_available: null, quantity_incoming: 4, in_transit: 1,
    cache_source: 'api', source_api_version: '3', imported_at: 30,
  }],
  stockRows: [{
    stock_row_id: 'stock-api', item_id: 'item-api', quantity_on_hand: 8,
    quantity_reserved: 2, quantity_available: null, quantity_incoming: 4,
    in_transit: 1, cache_source: 'api', source_api_version: '3', imported_at: 30,
  }],
  meta: {
    version: 1, status: 'complete', accountIdentity: binding.accountIdentity,
    startedAt: 29, completedAt: 30, itemCount: 1, stockRowCount: 1,
    schemaVersion: 7, sourceApiVersion: '3', generation: 'inventory-generation-1',
    fingerprint: 'sha256:inventory-test',
  },
});

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult>;

function makeService(handler: QueryHandler, expected: CacheAccountBinding | null = binding) {
  const query = jest.fn(handler);
  const client = { query, release: jest.fn() };
  const service = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
  Object.assign(service as object, {
    connectionString: 'postgres://example/cache',
    opened: true,
    syncLockClients: new Map(),
    expectedBinding: expected,
    pool: { connect: jest.fn(async () => client), query },
  });
  return { service, client, query };
}

function bindingRow(value: CacheAccountBinding = binding) {
  return {
    account_identity: value.accountIdentity,
    account_subdomain: value.accountSubdomain,
    created_at: value.createdAt ?? 100,
  };
}

describe('PostgresCacheService v7 schema and binding', () => {
  it('repairs exact category and binding schemas transactionally and idempotently', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
    }));

    await service.ensureSchema();
    await service.ensureSchema();

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cache_account_binding');
    expect(sql).toContain('CONSTRAINT cache_account_binding_singleton_check CHECK (id = 1)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS categories');
    expect(sql).toContain('item_count INTEGER NULL');
    expect(sql).toContain('modified BIGINT NULL');
    expect(sql).toContain('inventory_type TEXT NULL');
    expect(sql).toContain('custom_fields_json TEXT NULL');
    expect(sql).toContain('source_api_version TEXT NULL');
    for (const column of [
      'quantity_reserved', 'quantity_available', 'quantity_incoming', 'in_transit',
    ]) {
      expect(sql).toContain(`${column} NUMERIC NULL`);
      expect(sql).toContain(`ALTER COLUMN ${column} DROP DEFAULT`);
      expect(sql).toContain(`ALTER COLUMN ${column} DROP NOT NULL`);
      expect(sql).not.toContain(`${column} NUMERIC NOT NULL DEFAULT`);
    }
    expect(sql).toContain("WHERE cache_source = 'api'");
    expect(sql).toContain("schema.v7.inventory-nullability-migrated");
    expect(sql).toMatch(/UPDATE items\s+SET quantity_reserved = NULL,[\s\S]+WHERE cache_source = 'api'/);
    expect(sql).toContain('IF NOT EXISTS (');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS category_cache_meta');
    expect(sql).toContain('ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_name TEXT NULL');
    expect(sql).toContain('ALTER TABLE category_cache_meta ADD COLUMN IF NOT EXISTS value TEXT');
    expect(sql).toContain("primary_key_columns IS DISTINCT FROM ARRAY['id']::TEXT[]");
    expect(sql).toContain("primary_key_columns IS DISTINCT FROM ARRAY['category_id']::TEXT[]");
    expect(sql).toContain("primary_key_columns IS DISTINCT FROM ARRAY['key']::TEXT[]");
    expect(sql).toContain("check_constraint.definition <> 'CHECK ((id = 1))'");
    expect(sql).not.toContain("LIKE '%id = 1%'");
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.filter(([statement]) => statement === 'COMMIT')).toHaveLength(4);
    expect(sql).not.toMatch(/DELETE FROM cache_account_binding|UPDATE cache_account_binding/);
  });

  it('binds an empty database once and compares stable identity, not cache alias', async () => {
    let persisted = false;
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: persisted ? [bindingRow()] : [] };
      if (sql.includes('AS populated')) return { rows: [{ populated: false }] };
      if (sql.includes('INSERT INTO cache_account_binding')) persisted = true;
      return { rows: [] };
    }, null);

    await service.ensureAccountBinding(binding);
    await service.setCacheState(state());

    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO cache_account_binding'))).toBe(true);
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).includes("VALUES ('state'") && String(params?.[0]).includes('alias-can-change'))).toBe(true);
  });

  it('fails populated-unbound and mismatched databases without data or metadata mutation', async () => {
    for (const mode of ['populated', 'mismatch'] as const) {
      const { service, query } = makeService(async (sql) => {
        if (sql.includes('SELECT account_identity')) {
          return { rows: mode === 'mismatch' ? [bindingRow({
            accountIdentity: 'salesbinder:other', accountSubdomain: 'other', createdAt: 1,
          })] : [] };
        }
        if (sql.includes('to_regclass')) {
          return { rows: [{ relation: mode === 'populated' ? 'accounts' : null }] };
        }
        if (sql.includes('SELECT EXISTS (SELECT 1 FROM accounts')) {
          return { rows: [{ populated: true }] };
        }
        return { rows: [] };
      }, null);

      await expect(service.ensureAccountBinding(binding)).rejects.toThrow(
        mode === 'populated' ? /populated but has no account binding/ : /not bound to salesbinder:acme/,
      );
      const mutations = query.mock.calls.map(([sql]) => String(sql)).filter((sql) =>
        /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql));
      expect(mutations).toEqual([]);
      const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).not.toMatch(/ALTER TABLE categories|ALTER TABLE documents|DELETE FROM categories/);
    }
  });

  it('rechecks binding before a write and rolls back mismatch with zero payload mutation', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow({
        accountIdentity: 'salesbinder:other', accountSubdomain: 'other', createdAt: 1,
      })] : [],
    }));

    await expect(service.insertItem({ item_id: 'item-1', name: 'Never written' }))
      .rejects.toThrow(/not bound to salesbinder:acme/);
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) => sql.startsWith('INSERT INTO items')))
      .toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('verifies reader binding without inserting when binding is empty or mismatched', async () => {
    for (const mode of ['empty', 'mismatch'] as const) {
      const { service, query } = makeService(async (sql) => ({
        rows: sql.includes('SELECT account_identity') && mode === 'mismatch' ? [bindingRow({
          accountIdentity: 'salesbinder:other', accountSubdomain: 'other', createdAt: 1,
        })] : [],
      }), null);

      await expect(service.verifyAccountBinding(binding)).rejects.toThrow(
        mode === 'empty' ? /Run cache sync.*use the correctly bound database/ : /not bound to salesbinder:acme/,
      );
      expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) =>
        /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql))).toBe(false);
      expect((service as unknown as { expectedBinding: CacheAccountBinding | null }).expectedBinding).toBeNull();
    }
  });

  it('activates reader binding only after a persisted stable identity match', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
    }), null);

    await service.verifyAccountBinding(binding);

    expect((service as unknown as { expectedBinding: CacheAccountBinding }).expectedBinding).toEqual(binding);
    expect(query.mock.calls.map(([sql]) => String(sql))).toHaveLength(1);
  });
});

describe('PostgresCacheService v7 inventory authority', () => {
  it('preserves SQL NULL on stock writes and reads instead of coercing it to zero', async () => {
    const source = inventorySnapshot().stockRows[0];
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('SELECT * FROM item_stock_locations')) {
        return { rows: [{
          ...source,
          quantity_on_hand: '8', quantity_reserved: '2', quantity_available: null,
          quantity_incoming: null, in_transit: null, price: null, cost: null, valuation: null,
        }] };
      }
      return { rows: [] };
    });

    await service.insertItemStockLocation({
      ...source,
      quantity_reserved: null,
      quantity_available: null,
      quantity_incoming: null,
      in_transit: null,
    });
    const insert = query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO item_stock_locations'));
    expect(insert?.[1]?.slice(9, 13)).toEqual([null, null, null, null]);

    expect(await service.getAllItemStockLocations()).toEqual([{
      ...source,
      quantity_reserved: 2,
      quantity_available: null,
      quantity_incoming: null,
      in_transit: null,
      price: null,
      cost: null,
      valuation: null,
    }]);
  });

  it('atomically replaces API inventory, preserves CSV-only rows, and resolves ID collisions to API', async () => {
    const source = inventorySnapshot();
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) return { rows: [{ value: JSON.stringify(state(6)) }] };
      if (sql.includes('AS item_count')) return { rows: [{ item_count: '2', stock_row_count: '2' }] };
      return { rows: [] };
    });

    await service.replaceInventorySnapshot(source);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("DELETE FROM item_stock_locations WHERE cache_source = 'api'");
    expect(statements).toContain("DELETE FROM items WHERE cache_source = 'api'");
    const preserveCsvParent = statements.find((sql) => sql.includes('UPDATE items AS item')) ?? '';
    expect(preserveCsvParent).toContain("SET cache_source = 'csv', source_api_version = NULL");
    expect(preserveCsvParent).toContain("stock.cache_source = 'csv'");
    expect(statements.indexOf(preserveCsvParent))
      .toBeLessThan(statements.indexOf("DELETE FROM items WHERE cache_source = 'api'"));
    expect(statements).not.toContain('DELETE FROM item_stock_locations');
    expect(statements).not.toContain('DELETE FROM items');
    expect(statements.findIndex((sql) => sql.startsWith('INSERT INTO items')))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith('INSERT INTO item_stock_locations')));
    expect(statements.find((sql) => sql.startsWith('INSERT INTO items')))
      .toContain('ON CONFLICT (item_id) DO UPDATE');
    expect(statements.find((sql) => sql.startsWith('INSERT INTO item_stock_locations')))
      .toContain('ON CONFLICT (stock_row_id) DO UPDATE');
    expect(query.mock.calls.some(([, params]) =>
      params?.[0] === 'inventory_cache.v7.snapshot'
      && params?.[1] === JSON.stringify(source.meta))).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ('state', $1)"));
    expect(JSON.parse(String(stateWrite?.[1]?.[0]))).toEqual(expect.objectContaining({
      schemaVersion: 7,
      itemCount: 2,
      stockLocationCount: 2,
      inventorySourceApiVersion: '3',
      lastFullItemSync: 30,
    }));
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('rejects invalid snapshots before connecting and rolls back metadata failures', async () => {
    const invalid = inventorySnapshot();
    invalid.stockRows[0].quantity_available = Number.NaN;
    const rejected = makeService(async () => ({ rows: [] }));
    await expect(rejected.service.replaceInventorySnapshot(invalid)).rejects.toThrow(/invalid.*stock/i);
    expect((rejected.service as unknown as { pool: { connect: jest.Mock } }).pool.connect)
      .not.toHaveBeenCalled();

    const source = inventorySnapshot();
    const failing = makeService(async (sql, params) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (params?.[0] === 'inventory_cache.v7.snapshot') throw new Error('injected inventory meta failure');
      return { rows: [] };
    });
    await expect(failing.service.replaceInventorySnapshot(source))
      .rejects.toThrow('injected inventory meta failure');
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failing.query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
  });

  it('returns inventory metadata only when binding, schema, source state, and counts all match', async () => {
    const source = inventorySnapshot();
    const authoritativeState = {
      ...state(7),
      inventorySourceApiVersion: '3' as const,
    };
    const authorityRow = (overrides: Record<string, unknown> = {}) => ({
      snapshot_value: JSON.stringify(source.meta),
      state_value: JSON.stringify(authoritativeState),
      account_identity: binding.accountIdentity,
      item_count: '1',
      stock_row_count: '1',
      ...overrides,
    });
    const { service, query } = makeService(async () => ({ rows: [authorityRow()] }));
    expect(await service.getInventoryCacheMeta()).toEqual(source.meta);
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain("source_api_version = '3'");

    for (const row of [
      authorityRow({ account_identity: 'salesbinder:other' }),
      authorityRow({ state_value: JSON.stringify(state(6)) }),
      authorityRow({ state_value: JSON.stringify(state(7)) }),
      authorityRow({ item_count: '2' }),
      authorityRow({ stock_row_count: '2' }),
      authorityRow({ snapshot_value: '{invalid' }),
    ]) {
      query.mockImplementation(async () => ({ rows: [row] }));
      expect(await service.getInventoryCacheMeta()).toBeNull();
    }
  });

  it('invalidates inventory authority transactionally after non-snapshot item writes', async () => {
    const currentState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(currentState) }] };
      }
      return { rows: [] };
    });

    await service.insertItem(inventorySnapshot().items[0]);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).startsWith('DELETE FROM cache_meta')
      && params?.[0] === 'inventory_cache.v7.snapshot')).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ('state', $1)"));
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
    expect(statements.indexOf(statements.find((sql) => sql.startsWith('INSERT INTO items'))!))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith('DELETE FROM cache_meta')));
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('invalidates inventory authority transactionally after non-snapshot stock writes', async () => {
    const currentState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(currentState) }] };
      }
      return { rows: [] };
    });

    await service.replaceItemStockLocations('item-api', inventorySnapshot().stockRows);

    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).startsWith('DELETE FROM cache_meta')
      && params?.[0] === 'inventory_cache.v7.snapshot')).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ('state', $1)"));
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });
});

describe('PostgresCacheService v7 category authority', () => {
  it('rejects non-exact rows and parent names not derived from the new snapshot before connecting', async () => {
    const { service } = makeService(async () => ({ rows: [] }));
    const invalidExtra = snapshot();
    (invalidExtra.rows[0] as unknown as Record<string, unknown>).raw = {};
    await expect(service.replaceCategorySnapshot(invalidExtra)).rejects.toThrow(/invalid or duplicate/);

    const invalidParent = snapshot();
    invalidParent.rows[1].parent_name = 'Stale parent';
    await expect(service.replaceCategorySnapshot(invalidParent)).rejects.toThrow(/derived from the same/);
    expect((service as unknown as { pool: { connect: jest.Mock } }).pool.connect).not.toHaveBeenCalled();
  });

  it('rejects category strings containing NUL before fingerprinted rows can diverge in PostgreSQL', async () => {
    const { service } = makeService(async () => ({ rows: [] }));
    const invalid = snapshot();
    invalid.rows[0].name = 'A\0B';

    await expect(service.replaceCategorySnapshot(invalid)).rejects.toThrow(/invalid or duplicate/);
    expect((service as unknown as { pool: { connect: jest.Mock } }).pool.connect).not.toHaveBeenCalled();
  });

  it('atomically replaces rows, meta, state, marker, and reconciles item plus stock names', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) return { rows: [{ value: JSON.stringify(state(6)) }] };
      return { rows: [] };
    });

    await service.replaceCategorySnapshot(snapshot());

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('DELETE FROM categories');
    expect(statements).toContain('DELETE FROM category_cache_meta');
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO categories'))).toHaveLength(2);
    expect(statements.join('\n')).toContain('INSERT INTO category_cache_meta');
    expect(statements.join('\n')).toContain('UPDATE items AS item');
    expect(statements.join('\n')).toContain('UPDATE item_stock_locations AS stock');
    expect(query.mock.calls.some(([, params]) => params?.[0] === 'category_cache.v7.generation'
      && params?.[1] === 'generation-1')).toBe(true);
    expect(query.mock.calls.some(([, params]) => params?.[0] === 'inventory_cache.v7.snapshot')).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('clears stale v3 state while reconciling category names', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify({
          ...state(7), inventorySourceApiVersion: '3',
        }) }] };
      }
      return { rows: [] };
    });

    await service.replaceCategorySnapshot(snapshot());

    const stateWrite = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ('state', $1)"));
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
  });

  it('rolls back a snapshot failure without committing partial authority', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) return { rows: [] };
      if (sql.includes('INSERT INTO category_cache_meta')) throw new Error('injected meta failure');
      return { rows: [] };
    });

    await expect(service.replaceCategorySnapshot(snapshot())).rejects.toThrow('injected meta failure');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
  });

  it('invalidates stale authority only on the serialized non-v7 to v7 state transition', async () => {
    let persistedVersion = 6;
    const { service, query } = makeService(async (sql, params) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(state(persistedVersion)) }] };
      }
      if (sql.includes("VALUES ('state'")) persistedVersion = JSON.parse(String(params?.[0])).schemaVersion;
      return { rows: [] };
    });

    await service.setCacheState(state(7));
    const firstDeletes = query.mock.calls.filter(([sql, params]) =>
      String(sql).startsWith('DELETE FROM cache_meta') && params?.[0] === 'category_cache.v7.generation');
    expect(firstDeletes).toHaveLength(1);

    query.mockClear();
    await service.setCacheState({ ...state(7), lastSync: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM cache_meta'))).toBe(false);
  });

  it('reads authority fail-closed without mutation and coerces valid PostgreSQL numerics', async () => {
    const source = snapshot();
    const authorityRow = (schemaVersion: number, marker = source.meta.generation) => ({
      snapshot_value: JSON.stringify(source.meta), marker_value: marker,
      state_value: JSON.stringify(state(schemaVersion)),
      account_identity: binding.accountIdentity, account_subdomain: binding.accountSubdomain,
    });
    const { service, query } = makeService(async () => ({ rows: [authorityRow(6)] }));

    expect(await service.getCategoryCacheMeta()).toBeNull();
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) =>
      /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql))).toBe(false);

    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM category_cache_meta') ? [authorityRow(7)] : source.rows.map((row) => ({
        ...row, item_count: row.item_count == null ? null : String(row.item_count),
        modified: row.modified == null ? null : String(row.modified), imported_at: String(row.imported_at),
      })),
    }));
    expect(await service.getCategorySnapshot()).toEqual(source);
  });

  it('does not report complete metadata when physical category row count differs', async () => {
    const source = snapshot();
    const authority = {
      snapshot_value: JSON.stringify(source.meta), marker_value: source.meta.generation,
      state_value: JSON.stringify(state(7)), account_identity: binding.accountIdentity,
      account_subdomain: binding.accountSubdomain,
    };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM category_cache_meta')) return { rows: [authority] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.includes('FROM categories ORDER BY')) return { rows: [source.rows[0]] };
      return { rows: [] };
    });

    expect(await service.getCategoryCacheMeta()).toBeNull();
    expect(await service.getCategoryCount()).toBe(0);
    expect(await service.getCategorySnapshot()).toBeNull();
  });

  it('canonicalizes session sync locks to stable binding identity across caller aliases', async () => {
    let held = false;
    const handler: QueryHandler = async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        const acquired = !held;
        held = true;
        return { rows: [{ acquired }] };
      }
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('pg_advisory_unlock')) {
        held = false;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    };
    const first = makeService(handler);
    const second = makeService(handler);

    expect(await first.service.tryAcquireSyncLock('alias-a')).toBe(true);
    expect(await second.service.tryAcquireSyncLock('alias-b')).toBe(false);
    expect(first.query.mock.calls.find(([sql]) => String(sql).includes('pg_try_advisory_lock'))?.[1])
      .toEqual(['salesbinder-cache-sync:salesbinder:acme']);
    await first.service.releaseSyncLock('alias-a');
    expect(await second.service.tryAcquireSyncLock('alias-b')).toBe(true);
    await second.service.releaseSyncLock('alias-b');
  });

  it('clear removes category authority and all cache data while preserving binding', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
    }));

    await service.clearAll();

    const truncate = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('TRUNCATE TABLE')) ?? '';
    expect(truncate).toContain('categories, category_cache_meta, cache_meta');
    expect(truncate).not.toContain('cache_account_binding');
  });
});
