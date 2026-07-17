import { PostgresCacheService } from '../postgres-cache.service.js';
import { CACHE_WRITER_LOCK_KEY } from '../types.js';

const heldResult = { rows: [{ held: true }] };
const emptyResult = { rows: [] };

function successfulLeaseQuery(sql: unknown): Promise<typeof heldResult | typeof emptyResult> {
  return Promise.resolve(String(sql).includes('FROM pg_locks') ? heldResult : emptyResult);
}

describe('PostgresCacheService writer lease', () => {
  it('rejects every public cache mutation before issuing an unlocked query', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const mutations: Array<() => Promise<void>> = [
      () => cache.insertDocument({} as any),
      () => cache.deleteDocument('doc'),
      () => cache.batchInsertDocuments([]),
      () => cache.batchDeleteDocuments([]),
      () => cache.replaceDocumentSnapshot({} as any),
      () => cache.insertItemDocument({} as any),
      () => cache.deleteItemDocuments('doc'),
      () => cache.batchInsertItemDocuments([]),
      () => cache.insertDocumentNonItemLine({} as any),
      () => cache.deleteDocumentNonItemLines('doc'),
      () => cache.batchInsertDocumentNonItemLines([]),
      () => cache.insertAccount({} as any),
      () => cache.batchInsertAccounts([]),
      () => cache.deleteAccount('account'),
      () => cache.insertItem({} as any),
      () => cache.batchInsertItems([]),
      () => cache.deleteItem('item'),
      () => cache.insertItemStockLocation({} as any),
      () => cache.replaceItemStockLocations('item', []),
      () => cache.batchInsertItemStockLocations([]),
      () => cache.deleteItemStockLocations('item'),
      () => cache.setCacheState({} as any),
      () => cache.setSyncStatus({} as any),
      () => cache.clearAll(),
      () => cache.truncateAll(),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow(/requires the global cache writer lock/i);
    }
    await cache.close();
  });

  it('executes metadata and schema mutations on the advisory-lock-owning client', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const poolQuery = jest.spyOn((cache as any).pool, 'query');
    const leaseClient = {
      query: jest.fn().mockImplementation(successfulLeaseQuery),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await cache.setCacheState({ accountName: 'default' } as any);
    await cache.ensureSchema('default');

    expect(leaseClient.query).toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    const schemaQueries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    const guardQuery = schemaQueries.findIndex((sql) => (
      sql.includes('cache_schema_version_monotonic_guard')
      && sql.includes('NEW.value::INTEGER < OLD.value::INTEGER')
    ));
    const publishQuery = schemaQueries.findIndex((sql) => (
      sql.includes("VALUES ('cache_schema_version'")
    ));
    expect(guardQuery).toBeGreaterThan(-1);
    expect(publishQuery).toBeGreaterThan(guardQuery);
    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('rejects a different cache owner before issuing schema DDL', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ cache_meta: true, documents: true }] });
        }
        if (text.includes("FROM cache_meta WHERE key = 'state'")) {
          return Promise.resolve({
            rows: [{ value: JSON.stringify({ accountName: 'other-account' }) }],
          });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await expect(cache.ensureSchema('requested-account')).rejects.toThrow(
      /belongs to account "other-account"/i
    );
    const queries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join('\n')).not.toMatch(/\bCREATE\b|\bALTER\b|\bDROP\b|VALUES \('cache_schema_version'/i);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('rejects ownerless populated legacy rows before issuing schema DDL', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ cache_meta: true, documents: true }] });
        }
        if (text.includes("FROM cache_meta WHERE key = 'state'")) {
          return Promise.resolve(emptyResult);
        }
        if (text.includes('SELECT EXISTS (SELECT 1 FROM documents')) {
          return Promise.resolve({ rows: [{ populated: true }] });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await expect(cache.ensureSchema('requested-account')).rejects.toThrow(
      /contains data with no account ownership metadata/i
    );
    const queries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join('\n')).not.toMatch(/\bCREATE\b|\bALTER\b|\bDROP\b|VALUES \('cache_schema_version'/i);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('rejects malformed ownership metadata before issuing schema DDL', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ cache_meta: true }] });
        }
        if (text.includes("FROM cache_meta WHERE key = 'state'")) {
          return Promise.resolve({ rows: [{ value: '{"accountName":' }] });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await expect(cache.ensureSchema('requested-account')).rejects.toThrow(
      /ownership metadata is malformed/i
    );
    const queries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join('\n')).not.toMatch(/\bCREATE\b|\bALTER\b|\bDROP\b|VALUES \('cache_schema_version'/i);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('allows a matching cache owner to proceed with schema migration', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ cache_meta: true, documents: true }] });
        }
        if (text.includes("FROM cache_meta WHERE key = 'state'")) {
          return Promise.resolve({
            rows: [{ value: JSON.stringify({ accountName: 'requested-account' }) }],
          });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await expect(cache.ensureSchema('requested-account')).resolves.toBeUndefined();
    const queries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join('\n')).toMatch(/\bCREATE TABLE IF NOT EXISTS\b/i);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('rejects a newer cache schema version before issuing schema DDL', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ cache_meta: true }] });
        }
        if (text.includes("WHERE key = 'state'")) {
          return Promise.resolve({
            rows: [{ value: JSON.stringify({ accountName: 'requested-account' }) }],
          });
        }
        if (text.includes("WHERE key = 'cache_schema_version'")) {
          return Promise.resolve({ rows: [{ value: '5' }] });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    await expect(cache.ensureSchema('requested-account')).rejects.toThrow(
      /schema version 5 is newer.*writer version 4/i
    );
    const queries = leaseClient.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join('\n')).not.toMatch(/\bCREATE\b|\bALTER\b|\bDROP\b|VALUES \('cache_schema_version'/i);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('never falls back to a pooled session after the writer connection is lost', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const poolQuery = jest.spyOn((cache as any).pool, 'query');
    const invalidate = jest.fn(() => {
      (cache as any).syncLockClients.delete(CACHE_WRITER_LOCK_KEY);
    });
    const leaseClient = {
      query: jest.fn()
        .mockResolvedValueOnce(heldResult)
        .mockRejectedValue(new Error('writer backend terminated')),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate,
    });

    await expect(cache.setCacheState({ accountName: 'default' } as any))
      .rejects.toThrow('writer backend terminated');

    expect(poolQuery).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    await expect(cache.setCacheState({ accountName: 'late' } as any))
      .rejects.toThrow(/requires the global cache writer lock/i);
    await cache.close();
  });

  it('rejects a lease client that no longer owns the exact global lock', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const poolQuery = jest.spyOn((cache as any).pool, 'query');
    const invalidate = jest.fn(() => {
      (cache as any).syncLockClients.delete(CACHE_WRITER_LOCK_KEY);
    });
    const leaseClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ held: false }] }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate,
    });

    await expect(cache.setCacheState({ accountName: 'default' } as any))
      .rejects.toThrow(/writer lease was lost/i);

    expect(leaseClient.query).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    await expect(cache.setCacheState({ accountName: 'late' } as any))
      .rejects.toThrow(/requires the global cache writer lock/i);
    await cache.close();
  });

  it('serializes complete writer callbacks on the leased session', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    let finishFirstQuery!: (value: { rows: never[] }) => void;
    let markFirstQueryStarted!: () => void;
    const firstQueryStarted = new Promise<void>((resolve) => { markFirstQueryStarted = resolve; });
    let firstMutation = true;
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        if (String(sql).includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (firstMutation) {
          firstMutation = false;
          markFirstQueryStarted();
          return new Promise((resolve) => { finishFirstQuery = resolve; });
        }
        return Promise.resolve(emptyResult);
      }),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    const first = cache.setCacheState({ accountName: 'first' } as any);
    const second = cache.setSyncStatus({ phase: 'second' } as any);
    await firstQueryStarted;

    expect(leaseClient.query).toHaveBeenCalledTimes(2);
    finishFirstQuery({ rows: [] });
    await Promise.all([first, second]);
    expect(leaseClient.query).toHaveBeenCalledTimes(4);

    (cache as any).syncLockClients.clear();
    await cache.close();
  });

  it('defers advisory unlock until an active mutation finishes', async () => {
    const cache = new PostgresCacheService('postgres://invalid:invalid@127.0.0.1:1/invalid');
    let finishMutation!: (value: { rows: never[] }) => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
    const leaseClient = {
      query: jest.fn().mockImplementation((sql: unknown) => {
        if (String(sql).includes('FROM pg_locks')) return Promise.resolve(heldResult);
        if (String(sql).includes("VALUES ('state'")) {
          markMutationStarted();
          return new Promise((resolve) => { finishMutation = resolve; });
        }
        return Promise.resolve(emptyResult);
      }),
      removeListener: jest.fn(),
      release: jest.fn(),
    };
    (cache as any).syncLockClients.set(CACHE_WRITER_LOCK_KEY, {
      client: leaseClient,
      invalidate: jest.fn(),
    });

    const mutation = cache.setCacheState({ accountName: 'default' } as any);
    const release = cache.releaseSyncLock('ignored');
    await mutationStarted;
    expect(leaseClient.query).toHaveBeenCalledTimes(2);

    finishMutation({ rows: [] });
    await Promise.all([mutation, release]);
    expect(leaseClient.query.mock.calls[2][0]).toMatch(/pg_advisory_unlock/);
    await expect(cache.setCacheState({ accountName: 'late' } as any))
      .rejects.toThrow(/requires the global cache writer lock/i);

    await cache.close();
  });
});
