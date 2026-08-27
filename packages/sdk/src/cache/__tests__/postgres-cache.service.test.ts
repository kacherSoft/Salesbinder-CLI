import { PostgresCacheService } from '../postgres-cache.service.js';
import type {
  CacheAccountBinding,
  CacheState,
  CategorySnapshot,
} from '../types.js';

const binding: CacheAccountBinding = {
  accountIdentity: 'salesbinder:acme',
  accountSubdomain: 'acme',
  createdAt: 100,
};

const state = (schemaVersion = 6): CacheState => ({
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
      cache_source: 'api', imported_at: 20,
    },
    {
      category_id: 'child', name: 'Child', item_count: null, parent_id: 'parent',
      parent_name: 'Parent', created: null, modified: null,
      cache_source: 'api', imported_at: 20,
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
    schemaVersion: 6,
    generation: 'generation-1',
    fingerprint: 'sha256:test',
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

describe('PostgresCacheService v6 schema and binding', () => {
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

describe('PostgresCacheService v6 category authority', () => {
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
      if (sql.includes("key = 'state' FOR UPDATE")) return { rows: [{ value: JSON.stringify(state(5)) }] };
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
    expect(query.mock.calls.some(([, params]) => params?.[0] === 'category_cache.v6.generation'
      && params?.[1] === 'generation-1')).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
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

  it('invalidates stale authority only on the serialized non-v6 to v6 state transition', async () => {
    let persistedVersion = 5;
    const { service, query } = makeService(async (sql, params) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(state(persistedVersion)) }] };
      }
      if (sql.includes("VALUES ('state'")) persistedVersion = JSON.parse(String(params?.[0])).schemaVersion;
      return { rows: [] };
    });

    await service.setCacheState(state(6));
    const firstDeletes = query.mock.calls.filter(([sql, params]) =>
      String(sql).startsWith('DELETE FROM cache_meta') && params?.[0] === 'category_cache.v6.generation');
    expect(firstDeletes).toHaveLength(1);

    query.mockClear();
    await service.setCacheState({ ...state(6), lastSync: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM cache_meta'))).toBe(false);
  });

  it('reads authority fail-closed without mutation and coerces valid PostgreSQL numerics', async () => {
    const source = snapshot();
    const authorityRow = (schemaVersion: number, marker = source.meta.generation) => ({
      snapshot_value: JSON.stringify(source.meta), marker_value: marker,
      state_value: JSON.stringify(state(schemaVersion)),
      account_identity: binding.accountIdentity, account_subdomain: binding.accountSubdomain,
    });
    const { service, query } = makeService(async () => ({ rows: [authorityRow(5)] }));

    expect(await service.getCategoryCacheMeta()).toBeNull();
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) =>
      /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql))).toBe(false);

    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM category_cache_meta') ? [authorityRow(6)] : source.rows.map((row) => ({
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
      state_value: JSON.stringify(state(6)), account_identity: binding.accountIdentity,
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
