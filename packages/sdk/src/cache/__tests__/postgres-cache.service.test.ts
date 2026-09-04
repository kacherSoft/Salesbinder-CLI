import { PostgresCacheService } from '../postgres-cache.service.js';
import { createCategoryFingerprint } from '../category-indexer.service.js';
import { createInventorySnapshotFingerprint } from '../types.js';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  CacheAccountBinding,
  CacheState,
  CacheSyncStatus,
  CategoryCacheMeta,
  CategorySnapshot,
  DocumentRow,
  InventorySnapshot,
  ItemRow,
  ItemStockLocationRow,
} from '../types.js';
import type { PaymentTransactionRow } from '../payment-sync.types.js';

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

const snapshot = (): CategorySnapshot => {
  const rows = [
    {
      category_id: 'parent',
      name: 'Parent',
      item_count: 1,
      parent_id: null,
      parent_name: null,
      created: '2026-01-01',
      modified: 10,
      inventory_type: 'quantity',
      custom_fields_json: '[]',
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 20,
    },
    {
      category_id: 'child',
      name: 'Child',
      item_count: null,
      parent_id: 'parent',
      parent_name: 'Parent',
      created: null,
      modified: null,
      inventory_type: null,
      custom_fields_json: null,
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 20,
    },
  ] satisfies CategorySnapshot['rows'];
  const meta = {
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
  } satisfies Omit<CategoryCacheMeta, 'fingerprint'>;
  return {
    rows,
    meta: {
      ...meta,
      fingerprint: createCategoryFingerprint(meta, rows, 7),
    },
  };
};

const refreshCategoryFingerprint = (categorySnapshot: CategorySnapshot): void => {
  categorySnapshot.meta.fingerprint = createCategoryFingerprint(
    categorySnapshot.meta,
    categorySnapshot.rows,
    7
  );
};

const inventorySnapshot = (): InventorySnapshot => {
  const items = [
    {
      item_id: 'item-api',
      name: 'API item',
      quantity: 8,
      quantity_reserved: 2,
      quantity_available: null,
      quantity_incoming: 4,
      in_transit: 1,
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 30,
    },
  ] satisfies InventorySnapshot['items'];
  const stockRows = [
    {
      stock_row_id: 'stock-api',
      item_id: 'item-api',
      quantity_on_hand: 8,
      quantity_reserved: 2,
      quantity_available: null,
      quantity_incoming: 4,
      in_transit: 1,
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 30,
    },
  ] satisfies InventorySnapshot['stockRows'];
  const generation = 'inventory-generation-1';
  return {
    items,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity: binding.accountIdentity,
      startedAt: 29,
      completedAt: 30,
      itemCount: 1,
      stockRowCount: 1,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: createInventorySnapshotFingerprint(
        binding.accountIdentity,
        generation,
        items,
        stockRows
      ),
    },
  };
};

describe('PostgresCacheService connection lifecycle', () => {
  it('installs a pool error listener so idle network errors are handled', () => {
    const service = new PostgresCacheService('postgres://example/cache');
    const pool = (service as unknown as { pool: { listenerCount(event: string): number } }).pool;

    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });
});

const refreshInventoryFingerprint = (snapshot: InventorySnapshot): void => {
  snapshot.meta.fingerprint = createInventorySnapshotFingerprint(
    snapshot.meta.accountIdentity,
    snapshot.meta.generation,
    snapshot.items,
    snapshot.stockRows
  );
};

const historicalV1InventorySnapshot = (accountIdentity: string): InventorySnapshot => {
  const ids = ['z', 'Å', 'ä'];
  const items: ItemRow[] = ids.map((id) => ({
    item_id: id,
    item_number: null,
    name: `Item ${id}`,
    description: null,
    sku: null,
    serial_number: null,
    barcode: null,
    category_id: null,
    category_name: null,
    quantity: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    quantity_incoming: 0,
    in_transit: null,
    threshold: 0,
    cost: null,
    price: null,
    published: 1,
    archived: 0,
    created: '2026-01-01',
    modified: 1,
    cache_source: 'api' as const,
    source_api_version: '3' as const,
  }));
  const stockRows: ItemStockLocationRow[] = ids.map((id) => ({
    stock_row_id: id,
    item_id: id,
    item_number: null,
    location_id: null,
    location_name: null,
    category_name: null,
    quantity_on_hand: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    quantity_incoming: 0,
    in_transit: null,
    price: null,
    cost: null,
    barcode: null,
    cache_source: 'api' as const,
    source_api_version: '3' as const,
  }));
  const generation = 'historical-v1-unicode';
  const canonical = {
    accountIdentity,
    generation,
    items: [...items].sort((left, right) => left.item_id.localeCompare(right.item_id)),
    stockRows: [...stockRows].sort((left, right) =>
      left.stock_row_id.localeCompare(right.stock_row_id)
    ),
  };
  return {
    items,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity,
      startedAt: 1,
      completedAt: 2,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
    },
  };
};

const payment = (transactionId: string, docId: string): PaymentTransactionRow => ({
  transaction_id: transactionId,
  doc_id: docId,
  amount: 25.5,
  transaction_date: '2026-02-01',
  reference: null,
  imported_at: 1770000000,
});

const payloadDocumentMutations = (statements: string[]): string[] =>
  statements.filter((sql) =>
    /^(?:INSERT INTO documents|DELETE FROM item_documents|INSERT INTO item_documents|DELETE FROM payment_transactions|INSERT INTO payment_transactions)/.test(
      sql
    )
  );

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult>;
type PostgresSyncLockOptions = { onLost?: (error: Error) => void | Promise<void> };
type SyncLockAwarePostgresCacheService = PostgresCacheService & {
  tryAcquireSyncLock(lockKey: string, options?: PostgresSyncLockOptions): Promise<boolean>;
};
type EventedClient = EventEmitter & {
  label: string;
  query: jest.Mock<Promise<QueryResult>, [string, unknown[]?]>;
  release: jest.Mock<void, [boolean?]>;
};
type EventedClientHandler = (
  client: EventedClient,
  sql: string,
  params?: unknown[]
) => Promise<QueryResult>;

const lockAware = (service: PostgresCacheService): SyncLockAwarePostgresCacheService =>
  service as SyncLockAwarePostgresCacheService;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

function makeEventedClient(label: string, handler: EventedClientHandler): EventedClient {
  const client = new EventEmitter() as EventedClient;
  client.label = label;
  client.query = jest.fn((sql: string, params?: unknown[]) => handler(client, sql, params));
  client.release = jest.fn();
  return client;
}

function makeEventedService(
  clients: EventedClient[],
  expected: CacheAccountBinding | null = binding
) {
  const service = new PostgresCacheService('postgres://example/cache');
  const pool = {
    connect: jest.fn(async () => {
      const client = clients.shift();
      if (!client) throw new Error('No mock PostgreSQL client is available.');
      return client;
    }),
    query: jest.fn(async () => ({ rows: [] })),
    end: jest.fn(async () => undefined),
  };
  Object.assign(service as object, {
    opened: true,
    expectedBinding: expected,
    pool,
  });
  return { service: lockAware(service), pool };
}

const syncStatus = (runId: string, message: string): CacheSyncStatus => ({
  status: 'running',
  runId,
  accountName: 'acme',
  syncTarget: 'postgresql',
  startedAt: 100,
  updatedAt: 100,
  message,
});

const failedSyncStatus = (runId: string): CacheSyncStatus => ({
  status: 'failed',
  runId,
  accountName: 'acme',
  syncTarget: 'postgresql',
  startedAt: 100,
  updatedAt: 120,
  finishedAt: 120,
  message: 'Cache sync failed.',
  error: 'PostgreSQL sync lock lost.',
});

function bindingRow(value: CacheAccountBinding = binding) {
  return {
    account_identity: value.accountIdentity,
    account_subdomain: value.accountSubdomain,
    created_at: value.createdAt ?? 100,
  };
}

describe('PostgresCacheService read-only transaction lifecycle', () => {
  it('rejects a checked-out read client error and destroys the client', async () => {
    const clientError = new Error('read socket failed');
    const readClient = makeEventedClient('read', async (client, sql) => {
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] };
      if (sql.includes('FROM category_cache_meta AS snapshot')) {
        expect(() => client.emit('error', clientError)).not.toThrow();
        return { rows: [] };
      }
      if (sql === 'COMMIT') return { rows: [] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([readClient]);

    await expect(service.getCategorySnapshot()).rejects.toBe(clientError);

    expect(readClient.release).toHaveBeenCalledTimes(1);
    expect(readClient.release).toHaveBeenCalledWith(true);
    expect(readClient.listenerCount('error')).toBe(0);
  });

  it('preserves an inventory read error when rollback fails and destroys the client', async () => {
    const primaryError = new Error('inventory read failed');
    const rollbackError = new Error('inventory rollback failed');
    const { service, client } = makeService(async (sql) => {
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] };
      if (sql === 'ROLLBACK') throw rollbackError;
      throw primaryError;
    });

    await expect(service.getInventoryCacheMeta()).rejects.toBe(primaryError);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it.each([
    [
      'category snapshot BEGIN',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      (service: PostgresCacheService) => service.getCategorySnapshot(),
    ],
    [
      'category metadata COMMIT',
      'COMMIT',
      (service: PostgresCacheService) => service.getCategoryCacheMeta(),
    ],
    [
      'inventory metadata BEGIN',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      (service: PostgresCacheService) => service.getInventoryCacheMeta(),
    ],
    [
      'inventory snapshot COMMIT',
      'COMMIT',
      (service: PostgresCacheService) => service.getInventorySnapshot(),
    ],
  ])('destroys the checked-out client when %s rejects', async (_name, rejectedSql, read) => {
    const primaryError = new Error(`${rejectedSql} failed`);
    const { service, client, query } = makeService(async (sql) => {
      if (sql === rejectedSql) throw primaryError;
      return { rows: [] };
    });

    await expect(read(service)).rejects.toBe(primaryError);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(rejectedSql === 'COMMIT');
  });
});

describe('PostgresCacheService sync lock owner-session loss', () => {
  it('attaches checked-out lock-client error and end handlers', async () => {
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([lockClient]);

    await expect(service.tryAcquireSyncLock('alias')).resolves.toBe(true);

    expect(lockClient.listenerCount('error')).toBe(1);
    expect(lockClient.listenerCount('end')).toBe(1);
  });

  it('handles ETIMEDOUT once and reports one sanitized stable lock-loss error', async () => {
    const onLost = jest.fn<void, [Error]>();
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([lockClient]);
    await service.tryAcquireSyncLock('alias', { onLost });

    const networkError = Object.assign(new Error('read ETIMEDOUT from database socket'), {
      code: 'ETIMEDOUT',
    });
    expect(() => lockClient.emit('error', networkError)).not.toThrow();
    lockClient.emit('end');

    expect(onLost).toHaveBeenCalledTimes(1);
    const lostError = onLost.mock.calls[0]?.[0];
    expect(lostError).toBeInstanceOf(Error);
    expect(lostError?.name).toBe('PostgresSyncLockLostError');
    expect(lostError?.message).toBe('PostgreSQL sync lock lost.');
    expect(lostError?.message).not.toMatch(/ETIMEDOUT|database socket|postgres:\/\//i);
  });

  it('absorbs a rejected async loss callback and notifies only once', async () => {
    const unhandledRejections: unknown[] = [];
    const handleUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', handleUnhandledRejection);
    const onLost = jest.fn(async (): Promise<void> => {
      throw new Error('loss observer failed');
    });
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([lockClient]);

    try {
      await service.tryAcquireSyncLock('alias', { onLost });

      expect(() => lockClient.emit('error', new Error('socket failure'))).not.toThrow();
      expect(() => lockClient.emit('error', new Error('repeated socket failure'))).not.toThrow();
      lockClient.emit('end');
      lockClient.emit('end');
      await nextTick();

      expect(onLost).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', handleUnhandledRejection);
    }
  });

  it('drains a deferred pool connection before concurrent closes end the pool', async () => {
    const connectedClient = deferred<EventedClient>();
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      throw new Error(`Unexpected ${client.label} query after close began: ${sql}`);
    });
    const service = new PostgresCacheService('postgres://example/cache');
    const pool = {
      connect: jest.fn(() => connectedClient.promise),
      query: jest.fn(async () => ({ rows: [] })),
      end: jest.fn(async () => undefined),
    };
    Object.assign(service as object, {
      opened: true,
      expectedBinding: binding,
      pool,
    });
    const lockService = lockAware(service);

    const acquisition = lockService.tryAcquireSyncLock('alias');
    let closesSettled = false;
    const closes = Promise.all([lockService.close(), lockService.close()]).then(() => {
      closesSettled = true;
    });
    await nextTick();

    expect(closesSettled).toBe(false);
    expect(pool.end).not.toHaveBeenCalled();

    connectedClient.resolve(lockClient);
    await expect(acquisition).resolves.toBe(false);
    await expect(closes).resolves.toBeUndefined();

    expect(lockClient.query).not.toHaveBeenCalled();
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledWith();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it.each(['pg_try_advisory_lock', 'binding verification'] as const)(
    'drains a deferred %s acquisition before concurrent closes end the pool',
    async (deferredStep) => {
      const queryStarted = deferred<void>();
      const queryCanFinish = deferred<void>();
      const lockClient = makeEventedClient('lock', async (client, sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (deferredStep === 'pg_try_advisory_lock') {
            queryStarted.resolve();
            await queryCanFinish.promise;
          }
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes('SELECT account_identity')) {
          if (deferredStep === 'binding verification') {
            queryStarted.resolve();
            await queryCanFinish.promise;
          }
          return { rows: [bindingRow()] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`Unexpected ${client.label} query: ${sql}`);
      });
      const { service, pool } = makeEventedService([lockClient]);

      const acquisition = service.tryAcquireSyncLock('alias');
      await queryStarted.promise;
      let closesSettled = false;
      const closes = Promise.all([service.close(), service.close()]).then(() => {
        closesSettled = true;
      });
      await nextTick();

      expect(closesSettled).toBe(false);
      expect(pool.end).not.toHaveBeenCalled();

      queryCanFinish.resolve();
      await expect(acquisition).resolves.toBe(false);
      await expect(closes).resolves.toBeUndefined();

      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(lockClient.release).toHaveBeenCalledTimes(1);
      expect(lockClient.release).toHaveBeenCalledWith();
      expect(
        lockClient.query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'))
      ).toHaveLength(1);
      expect(
        (service as unknown as { syncLockClients: Map<string, unknown> }).syncLockClients.size
      ).toBe(0);
    }
  );

  it('destroys a client after an advisory-lock query rejects without reporting ownership', async () => {
    const primaryError = new Error('injected advisory-lock timeout');
    const onLost = jest.fn<void, [Error]>();
    const failedClient = makeEventedClient('failed-lock', async (_client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) throw primaryError;
      throw new Error(`Unexpected query after advisory-lock timeout: ${sql}`);
    });
    const successorClient = makeEventedClient('successor-lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([failedClient, successorClient]);

    await expect(service.tryAcquireSyncLock('alias', { onLost })).rejects.toBe(primaryError);

    expect(failedClient.release).toHaveBeenCalledTimes(1);
    expect(failedClient.release).toHaveBeenCalledWith(true);
    expect(onLost).not.toHaveBeenCalled();
    await expect(service.tryAcquireSyncLock('alias')).resolves.toBe(true);
    await expect(service.releaseSyncLock('alias')).resolves.toBeUndefined();
    expect(successorClient.release).toHaveBeenCalledTimes(1);
    expect(successorClient.release).toHaveBeenCalledWith();
  });

  it('removes service loss listeners after error-only loss but swallows client errors until end', async () => {
    const onLost = jest.fn<void, [Error]>();
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([lockClient]);
    await service.tryAcquireSyncLock('alias', { onLost });

    lockClient.emit('error', new Error('socket timeout before end event'));

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledWith(true);
    expect(lockClient.listenerCount('error')).toBe(1);
    expect(lockClient.listenerCount('end')).toBe(1);
    expect(() => lockClient.emit('error', new Error('late socket error'))).not.toThrow();
    expect(onLost).toHaveBeenCalledTimes(1);

    lockClient.emit('end');
    expect(lockClient.listenerCount('error')).toBe(0);
    expect(lockClient.listenerCount('end')).toBe(0);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('serializes writes through the retained owner client while the lock is held', async () => {
    const firstInsertCanFinish = deferred<void>();
    const statusInsertOrder: string[] = [];
    const handler: EventedClientHandler = async (client, sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("VALUES ('sync_status'")) {
        const status = JSON.parse(String(params?.[0])) as CacheSyncStatus;
        statusInsertOrder.push(`${client.label}:${status.message ?? status.runId}`);
        if (status.message === 'first') await firstInsertCanFinish.promise;
      }
      return { rows: [] };
    };
    const lockClient = makeEventedClient('lock', handler);
    const freshClientA = makeEventedClient('fresh-a', handler);
    const freshClientB = makeEventedClient('fresh-b', handler);
    const { service, pool } = makeEventedService([lockClient, freshClientA, freshClientB]);
    await service.tryAcquireSyncLock('alias');

    const firstWrite = service.setSyncStatus(syncStatus('run-1', 'first'));
    await nextTick();
    expect(statusInsertOrder).toEqual(['lock:first']);

    const secondWrite = service.setSyncStatus(syncStatus('run-2', 'second'));
    await nextTick();
    expect(statusInsertOrder).toEqual(['lock:first']);

    firstInsertCanFinish.resolve();
    await expect(firstWrite).resolves.toBeUndefined();
    await expect(secondWrite).resolves.toBeUndefined();
    expect(statusInsertOrder).toEqual(['lock:first', 'lock:second']);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(freshClientA.query).not.toHaveBeenCalled();
    expect(freshClientB.query).not.toHaveBeenCalled();
  });

  it('loses and destroys a retained lock when rollback fails without a client event', async () => {
    const onLost = jest.fn<void, [Error]>();
    const primaryError = new Error('injected retained write failure');
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("VALUES ('sync_status'")) throw primaryError;
      if (sql === 'ROLLBACK') throw new Error('injected retained rollback failure');
      if (sql.includes('pg_advisory_unlock')) {
        throw new Error(`Unexpected unlock on ${client.label} after rollback failure.`);
      }
      return { rows: [] };
    });
    const { service } = makeEventedService([lockClient]);
    await service.tryAcquireSyncLock('alias', { onLost });

    await expect(service.setSyncStatus(syncStatus('run-1', 'first'))).rejects.toThrow(
      'PostgreSQL sync lock lost.'
    );

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]?.[0].message).toBe('PostgreSQL sync lock lost.');
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledWith(true);
    const queryCountAfterLoss = lockClient.query.mock.calls.length;

    await expect(service.setSyncStatus(syncStatus('run-2', 'second'))).rejects.toThrow(
      'PostgreSQL sync lock lost.'
    );
    expect(lockClient.query).toHaveBeenCalledTimes(queryCountAfterLoss);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
  });

  it.each(['BEGIN', 'COMMIT'] as const)(
    'loses and destroys a retained lock when %s rejects without a client event',
    async (failedStatement) => {
      const onLost = jest.fn<void, [Error]>();
      const primaryError = new Error(`injected retained ${failedStatement} failure`);
      const lockClient = makeEventedClient('lock', async (client, sql) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
        if (sql === failedStatement) throw primaryError;
        if (sql.includes('pg_advisory_unlock')) {
          throw new Error(`Unexpected unlock on ${client.label} after boundary failure.`);
        }
        return { rows: [] };
      });
      const { service } = makeEventedService([lockClient]);
      await service.tryAcquireSyncLock('alias', { onLost });

      await expect(service.setSyncStatus(syncStatus('run-1', 'first'))).rejects.toThrow(
        'PostgreSQL sync lock lost.'
      );

      const statements = lockClient.query.mock.calls.map(([sql]) => String(sql));
      expect(statements.includes('ROLLBACK')).toBe(failedStatement === 'COMMIT');
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost.mock.calls[0]?.[0].message).toBe('PostgreSQL sync lock lost.');
      expect(lockClient.release).toHaveBeenCalledTimes(1);
      expect(lockClient.release).toHaveBeenCalledWith(true);
      const queryCountAfterLoss = lockClient.query.mock.calls.length;

      await expect(service.setSyncStatus(syncStatus('run-2', 'second'))).rejects.toThrow(
        'PostgreSQL sync lock lost.'
      );
      expect(lockClient.query).toHaveBeenCalledTimes(queryCountAfterLoss);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(lockClient.release).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['BEGIN', 'COMMIT'] as const)(
    'destroys a fresh client but preserves the primary %s error when the boundary rejects',
    async (failedStatement) => {
      const primaryError = new Error(`injected fresh ${failedStatement} failure`);
      const { service, client, query } = makeService(async (sql) => {
        if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
        if (sql === failedStatement) throw primaryError;
        return { rows: [] };
      });

      await expect(service.setSyncStatus(syncStatus('run-1', 'first'))).rejects.toBe(primaryError);

      const statements = query.mock.calls.map(([sql]) => String(sql));
      expect(statements.includes('ROLLBACK')).toBe(failedStatement === 'COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(true);
    }
  );

  it.each(['operation', 'commit'] as const)(
    'destroys a fresh client but preserves the primary %s error when rollback fails',
    async (failurePoint) => {
      const primaryError = new Error(`injected ${failurePoint} failure`);
      const { service, client, query } = makeService(async (sql) => {
        if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
        if (failurePoint === 'operation' && sql.includes("VALUES ('sync_status'")) {
          throw primaryError;
        }
        if (failurePoint === 'commit' && sql === 'COMMIT') throw primaryError;
        if (sql === 'ROLLBACK') throw new Error('injected fresh rollback failure');
        return { rows: [] };
      });

      await expect(service.setSyncStatus(syncStatus('run-1', 'first'))).rejects.toBe(primaryError);

      expect(query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(true);
    }
  );

  it('fails closed after lock loss without falling back or publishing inventory', async () => {
    const handler: EventedClientHandler = async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(state(7)) }] };
      }
      if (sql.includes('AS item_count')) {
        return { rows: [{ item_count: '1', stock_row_count: '1' }] };
      }
      if (client.label === 'fresh-after-loss' && sql.includes('inventory_cache.v7.snapshot')) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    const lockClient = makeEventedClient('lock', handler);
    const freshAfterLoss = makeEventedClient('fresh-after-loss', handler);
    const { service, pool } = makeEventedService([lockClient, freshAfterLoss]);
    await service.tryAcquireSyncLock('alias');

    lockClient.emit('end');
    const result = await service
      .replaceInventorySnapshot(inventorySnapshot())
      .then(() => ({ completed: true, error: null }))
      .catch((error: Error) => ({ completed: false, error }));
    const statements = [lockClient, freshAfterLoss].flatMap((client) =>
      client.query.mock.calls.map(([sql]) => String(sql))
    );

    expect({
      completed: result.completed,
      openedFreshClients: pool.connect.mock.calls.length - 1,
      publishedInventorySnapshot: statements.some((sql) =>
        sql.includes('inventory_cache.v7.snapshot')
      ),
      deletedApiInventory: statements.some((sql) =>
        sql.includes("DELETE FROM items WHERE cache_source = 'api'")
      ),
    }).toEqual({
      completed: false,
      openedFreshClients: 0,
      publishedInventorySnapshot: false,
      deletedApiInventory: false,
    });
    expect(result.error?.message).toBe('PostgreSQL sync lock lost.');
  });

  it('persists failed sync status after lock loss when the stored run ID still matches', async () => {
    const failedStatus = failedSyncStatus('run-that-lost-lock');
    const handler: EventedClientHandler = async (client, sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'sync_status' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(syncStatus(failedStatus.runId, 'running')) }] };
      }
      if (sql.includes("UPDATE cache_meta SET value = $1 WHERE key = 'sync_status'")) {
        expect(client.label).toBe('failed-status');
        expect(JSON.parse(String(params?.[0]))).toEqual(failedStatus);
      }
      return { rows: [] };
    };
    const lockClient = makeEventedClient('lock', handler);
    const failedStatusClient = makeEventedClient('failed-status', handler);
    const { service, pool } = makeEventedService([lockClient, failedStatusClient]);
    await service.tryAcquireSyncLock('alias');

    lockClient.emit('end');
    await expect(service.setSyncStatus(failedStatus)).resolves.toBeUndefined();

    const statements = failedStatusClient.query.mock.calls.map(([sql]) => String(sql));
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(statements).toContain('BEGIN');
    expect(
      statements.some((sql) =>
        sql.includes("SELECT value FROM cache_meta WHERE key = 'sync_status'")
      )
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("UPDATE cache_meta SET value = $1 WHERE key = 'sync_status'")
      )
    ).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(failedStatusClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects failed sync status after lock loss when a successor run ID is stored', async () => {
    const staleFailedStatus = failedSyncStatus('run-that-lost-lock');
    const handler: EventedClientHandler = async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'sync_status' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(syncStatus('successor-run', 'running')) }] };
      }
      if (client.label === 'failed-status' && sql.includes('UPDATE cache_meta')) {
        throw new Error('stale failed status must not update successor status');
      }
      return { rows: [] };
    };
    const lockClient = makeEventedClient('lock', handler);
    const failedStatusClient = makeEventedClient('failed-status', handler);
    const { service } = makeEventedService([lockClient, failedStatusClient]);
    await service.tryAcquireSyncLock('alias');

    lockClient.emit('end');
    await expect(service.setSyncStatus(staleFailedStatus)).rejects.toThrow(
      'PostgreSQL sync status belongs to another run.'
    );

    const statements = failedStatusClient.query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.some((sql) =>
        sql.includes("UPDATE cache_meta SET value = $1 WHERE key = 'sync_status'")
      )
    ).toBe(false);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(failedStatusClient.release).toHaveBeenCalledTimes(1);
  });

  it('releases a broken lost lock once without unlock query or secondary error', async () => {
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('pg_advisory_unlock')) {
        throw new Error(`Unexpected unlock on ${client.label} after loss.`);
      }
      return { rows: [] };
    });
    const { service } = makeEventedService([lockClient]);
    await service.tryAcquireSyncLock('alias');

    lockClient.emit('end');
    await expect(service.releaseSyncLock('alias')).resolves.toBeUndefined();

    expect(
      lockClient.query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_unlock'))
    ).toBe(false);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledWith(true);
  });

  it.each([
    ['returns false', async () => ({ rows: [{ pg_advisory_unlock: false }] })],
    [
      'throws',
      async () => {
        throw new Error('unlock connection failure');
      },
    ],
  ] as const)('destroys the lock client when advisory unlock %s', async (_label, unlockResult) => {
    const lockClient = makeEventedClient('lock', async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('pg_advisory_unlock')) return unlockResult();
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    });
    const { service } = makeEventedService([lockClient]);
    await service.tryAcquireSyncLock('alias');

    await expect(service.releaseSyncLock('alias')).resolves.toBeUndefined();
    await expect(service.releaseSyncLock('alias')).resolves.toBeUndefined();

    expect(
      lockClient.query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'))
    ).toHaveLength(1);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledWith(true);
    expect(
      (service as unknown as { syncLockClients: Map<string, unknown> }).syncLockClients.size
    ).toBe(0);
    await expect(service.tryAcquireSyncLock('alias')).rejects.toThrow('PostgreSQL sync lock lost.');
  });

  it('detaches normal release listeners and reacquires with a new client', async () => {
    const handler: EventedClientHandler = async (client, sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      throw new Error(`Unexpected ${client.label} query: ${sql}`);
    };
    const firstLockClient = makeEventedClient('first-lock', handler);
    const secondLockClient = makeEventedClient('second-lock', handler);
    const { service, pool } = makeEventedService([firstLockClient, secondLockClient]);

    await expect(service.tryAcquireSyncLock('alias')).resolves.toBe(true);
    expect(firstLockClient.listenerCount('error')).toBe(1);
    expect(firstLockClient.listenerCount('end')).toBe(1);

    await service.releaseSyncLock('alias');
    expect(firstLockClient.listenerCount('error')).toBe(0);
    expect(firstLockClient.listenerCount('end')).toBe(0);
    expect(firstLockClient.release).toHaveBeenCalledTimes(1);

    await expect(service.tryAcquireSyncLock('alias')).resolves.toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(secondLockClient.listenerCount('error')).toBe(1);
    expect(secondLockClient.listenerCount('end')).toBe(1);
  });
});

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
      'quantity_reserved',
      'quantity_available',
      'quantity_incoming',
      'in_transit',
    ]) {
      expect(sql).toContain(`${column} NUMERIC NULL`);
      expect(sql).toContain(`ALTER COLUMN ${column} DROP DEFAULT`);
      expect(sql).toContain(`ALTER COLUMN ${column} DROP NOT NULL`);
      expect(sql).not.toContain(`${column} NUMERIC NOT NULL DEFAULT`);
    }
    expect(sql).toContain("WHERE cache_source = 'api'");
    expect(sql).toContain('schema.v7.inventory-nullability-migrated');
    expect(sql).toMatch(
      /UPDATE items\s+SET quantity_reserved = NULL,[\s\S]+WHERE cache_source = 'api'/
    );
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

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO cache_account_binding'))
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes("VALUES ('state'") &&
          String(params?.[0]).includes('alias-can-change')
      )
    ).toBe(true);
  });

  it('fails populated-unbound and mismatched databases without data or metadata mutation', async () => {
    for (const mode of ['populated', 'mismatch'] as const) {
      const { service, query } = makeService(async (sql) => {
        if (sql.includes('SELECT account_identity')) {
          return {
            rows:
              mode === 'mismatch'
                ? [
                    bindingRow({
                      accountIdentity: 'salesbinder:other',
                      accountSubdomain: 'other',
                      createdAt: 1,
                    }),
                  ]
                : [],
          };
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
        mode === 'populated'
          ? /populated but has no account binding/
          : /not bound to salesbinder:acme/
      );
      const mutations = query.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql));
      expect(mutations).toEqual([]);
      const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).not.toMatch(
        /ALTER TABLE categories|ALTER TABLE documents|DELETE FROM categories/
      );
    }
  });

  it('rechecks binding before a write and rolls back mismatch with zero payload mutation', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity')
        ? [
            bindingRow({
              accountIdentity: 'salesbinder:other',
              accountSubdomain: 'other',
              createdAt: 1,
            }),
          ]
        : [],
    }));

    await expect(service.insertItem({ item_id: 'item-1', name: 'Never written' })).rejects.toThrow(
      /not bound to salesbinder:acme/
    );
    expect(
      query.mock.calls
        .map(([sql]) => String(sql))
        .some((sql) => sql.startsWith('INSERT INTO items'))
    ).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('verifies reader binding without inserting when binding is empty or mismatched', async () => {
    for (const mode of ['empty', 'mismatch'] as const) {
      const { service, query } = makeService(
        async (sql) => ({
          rows:
            sql.includes('SELECT account_identity') && mode === 'mismatch'
              ? [
                  bindingRow({
                    accountIdentity: 'salesbinder:other',
                    accountSubdomain: 'other',
                    createdAt: 1,
                  }),
                ]
              : [],
        }),
        null
      );

      await expect(service.verifyAccountBinding(binding)).rejects.toThrow(
        mode === 'empty'
          ? /Run cache sync.*use the correctly bound database/
          : /not bound to salesbinder:acme/
      );
      expect(
        query.mock.calls
          .map(([sql]) => String(sql))
          .some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql))
      ).toBe(false);
      expect(
        (service as unknown as { expectedBinding: CacheAccountBinding | null }).expectedBinding
      ).toBeNull();
    }
  });

  it('activates reader binding only after a persisted stable identity match', async () => {
    const { service, query } = makeService(
      async (sql) => ({
        rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
      }),
      null
    );

    await service.verifyAccountBinding(binding);

    expect(
      (service as unknown as { expectedBinding: CacheAccountBinding }).expectedBinding
    ).toEqual(binding);
    expect(query.mock.calls.map(([sql]) => String(sql))).toHaveLength(1);
  });
});

describe('PostgresCacheService v7 inventory authority', () => {
  it('preserves SQL NULL on stock writes and reads instead of coercing it to zero', async () => {
    const source = inventorySnapshot().stockRows[0];
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('SELECT * FROM item_stock_locations')) {
        return {
          rows: [
            {
              ...source,
              quantity_on_hand: '8',
              quantity_reserved: '2',
              quantity_available: null,
              quantity_incoming: null,
              in_transit: null,
              price: null,
              cost: null,
              valuation: null,
            },
          ],
        };
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
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO item_stock_locations')
    );
    expect(insert?.[1]?.slice(9, 13)).toEqual([null, null, null, null]);

    expect(await service.getAllItemStockLocations()).toEqual([
      {
        ...source,
        quantity_reserved: 2,
        quantity_available: null,
        quantity_incoming: null,
        in_transit: null,
        price: null,
        cost: null,
        valuation: null,
      },
    ]);
  });

  it('atomically replaces API inventory, preserves CSV-only rows, and resolves ID collisions to API', async () => {
    const source = inventorySnapshot();
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE"))
        return { rows: [{ value: JSON.stringify(state(6)) }] };
      if (sql.includes('AS item_count'))
        return { rows: [{ item_count: '2', stock_row_count: '2' }] };
      return { rows: [] };
    });

    await service.replaceInventorySnapshot(source);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("DELETE FROM item_stock_locations WHERE cache_source = 'api'");
    expect(statements).toContain("DELETE FROM items WHERE cache_source = 'api'");
    const preserveCsvParent = statements.find((sql) => sql.includes('UPDATE items AS item')) ?? '';
    expect(preserveCsvParent).toContain("SET cache_source = 'csv', source_api_version = NULL");
    expect(preserveCsvParent).toContain("stock.cache_source = 'csv'");
    expect(statements.indexOf(preserveCsvParent)).toBeLessThan(
      statements.indexOf("DELETE FROM items WHERE cache_source = 'api'")
    );
    expect(statements).not.toContain('DELETE FROM item_stock_locations');
    expect(statements).not.toContain('DELETE FROM items');
    expect(statements.findIndex((sql) => sql.startsWith('INSERT INTO items'))).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('INSERT INTO item_stock_locations'))
    );
    expect(statements.find((sql) => sql.startsWith('INSERT INTO items'))).toContain(
      'ON CONFLICT (item_id) DO UPDATE'
    );
    expect(statements.find((sql) => sql.startsWith('INSERT INTO item_stock_locations'))).toContain(
      'ON CONFLICT (stock_row_id) DO UPDATE'
    );
    expect(
      query.mock.calls.some(
        ([, params]) =>
          params?.[0] === 'inventory_cache.v7.snapshot' &&
          params?.[1] === JSON.stringify(source.meta)
      )
    ).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0]))).toEqual(
      expect.objectContaining({
        schemaVersion: 7,
        itemCount: 2,
        stockLocationCount: 2,
        inventorySourceApiVersion: '3',
        lastFullItemSync: 30,
        lastSyncAttempt: 30,
      })
    );
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('rejects invalid snapshots before connecting and rolls back metadata failures', async () => {
    const invalid = inventorySnapshot();
    invalid.stockRows[0].quantity_available = Number.NaN;
    const rejected = makeService(async () => ({ rows: [] }));
    await expect(rejected.service.replaceInventorySnapshot(invalid)).rejects.toThrow(
      /invalid.*stock/i
    );
    expect(
      (rejected.service as unknown as { pool: { connect: jest.Mock } }).pool.connect
    ).not.toHaveBeenCalled();

    const source = inventorySnapshot();
    const failing = makeService(async (sql, params) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (params?.[0] === 'inventory_cache.v7.snapshot')
        throw new Error('injected inventory meta failure');
      return { rows: [] };
    });
    await expect(failing.service.replaceInventorySnapshot(source)).rejects.toThrow(
      'injected inventory meta failure'
    );
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failing.query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
  });

  it('rolls back inventory publication when the atomic attempt-watermark write fails', async () => {
    const source = inventorySnapshot();
    const failing = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify({ ...state(7), lastSyncAttempt: 10 }) }] };
      }
      if (sql.includes('AS item_count')) {
        return { rows: [{ item_count: '1', stock_row_count: '1' }] };
      }
      if (sql.includes("VALUES ('state', $1)")) {
        throw new Error('injected inventory state failure');
      }
      return { rows: [] };
    });

    await expect(failing.service.replaceInventorySnapshot(source)).rejects.toThrow(
      'injected inventory state failure'
    );
    const stateWrite = failing.query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0]))).toMatchObject({
      lastSyncAttempt: source.meta.completedAt,
      lastItemSync: source.meta.completedAt,
      lastFullItemSync: source.meta.completedAt,
    });
    expect(failing.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failing.query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
  });

  it('rejects incomplete item bundles before connecting or mutating prior authority', async () => {
    const incomplete = inventorySnapshot();
    const generation = 'inventory-missing-stock-row';
    incomplete.stockRows = [];
    incomplete.meta = {
      ...incomplete.meta,
      generation,
      stockRowCount: 0,
      fingerprint: createInventorySnapshotFingerprint(
        binding.accountIdentity,
        generation,
        incomplete.items,
        []
      ),
    };
    const { service, query } = makeService(async () => ({ rows: [] }));

    await expect(service.replaceInventorySnapshot(incomplete)).rejects.toThrow(
      /at least one stock row for every item/i
    );
    expect(
      (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
    ).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid inventory numerics and binary flags before connecting', async () => {
    const invalidValues = [
      ['item', 'quantity', Number.NaN],
      ['item', 'quantity', null],
      ['item', 'quantity', undefined],
      ['item', 'quantity_reserved', Number.POSITIVE_INFINITY],
      ['item', 'cost', Number.NEGATIVE_INFINITY],
      ['item', 'item_number', 1.5],
      ['item', 'published', 7],
      ['item', 'archived', 9],
      ['item', 'modified', -1],
      ['item', 'imported_at', 1.5],
      ['stock', 'quantity_on_hand', Number.NaN],
      ['stock', 'quantity_on_hand', null],
      ['stock', 'quantity_on_hand', undefined],
      ['stock', 'quantity_available', Number.POSITIVE_INFINITY],
      ['stock', 'valuation', Number.NEGATIVE_INFINITY],
      ['stock', 'item_number', 1.5],
      ['stock', 'imported_at', -1],
    ] as const;

    for (const [target, field, value] of invalidValues) {
      const candidate = inventorySnapshot();
      const row = target === 'item' ? candidate.items[0] : candidate.stockRows[0];
      (row as unknown as Record<string, unknown>)[field] = value;
      const { service, query } = makeService(async () => ({ rows: [] }));

      await expect(service.replaceInventorySnapshot(candidate)).rejects.toThrow(/invalid/i);
      expect(
        (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('rejects correctly fingerprinted inventory text containing NUL before connecting', async () => {
    for (const [target, field] of [
      ['item', 'description'],
      ['stock', 'location_name'],
    ] as const) {
      const candidate = inventorySnapshot();
      const row = target === 'item' ? candidate.items[0] : candidate.stockRows[0];
      (row as unknown as Record<string, unknown>)[field] = 'before\0after';
      candidate.meta.fingerprint = createInventorySnapshotFingerprint(
        candidate.meta.accountIdentity,
        candidate.meta.generation,
        candidate.items,
        candidate.stockRows
      );
      const { service, query } = makeService(async () => ({ rows: [] }));

      await expect(service.replaceInventorySnapshot(candidate)).rejects.toThrow(/invalid/i);
      expect(
        (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('rejects unpaired inventory text before connecting and accepts non-BMP pairs', async () => {
    for (const [target, value] of [
      ['item', 'item-\ud800'],
      ['stock', 'location-\udc00'],
      ['meta', 'generation-\ud800'],
    ] as const) {
      const candidate = inventorySnapshot();
      if (target === 'item') candidate.items[0].name = value;
      else if (target === 'stock') candidate.stockRows[0].location_name = value;
      else candidate.meta.generation = value;
      refreshInventoryFingerprint(candidate);
      const rejected = makeService(async () => ({ rows: [] }));

      await expect(rejected.service.replaceInventorySnapshot(candidate)).rejects.toThrow(
        /invalid|metadata/i
      );
      expect(
        (rejected.service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(rejected.query).not.toHaveBeenCalled();
    }

    const valid = inventorySnapshot();
    valid.items[0].name = 'Item 🚀';
    valid.stockRows[0].location_name = 'Warehouse 🚀';
    refreshInventoryFingerprint(valid);
    const accepted = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(state(7)) }] };
      }
      if (sql.includes('AS item_count')) {
        return { rows: [{ item_count: '1', stock_row_count: '1' }] };
      }
      return { rows: [] };
    });

    await expect(accepted.service.replaceInventorySnapshot(valid)).resolves.toBeUndefined();
    expect(accepted.query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });

  it('rejects correctly fingerprinted noncanonical IDs and incoherent stock rows before connecting', async () => {
    const invalidCandidates: Array<(snapshot: InventorySnapshot) => void> = [
      (snapshot) => {
        snapshot.items[0].item_id = ' item-with-leading-space';
        snapshot.stockRows[0].item_id = snapshot.items[0].item_id;
      },
      (snapshot) => {
        snapshot.items[0].category_id = 'category\ncontrol';
      },
      (snapshot) => {
        snapshot.stockRows[0].stock_row_id = 's'.repeat(257);
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation-with-trailing-space ';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_location_id = 'variation-location';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].variation_location_id = 'variation-location';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].location_id = 'location';
      },
      (snapshot) => {
        snapshot.stockRows[0].stock_row_id = '01';
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].variation_location_id = '01';
        snapshot.stockRows[0].location_id = 'location';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].variation_location_id = '42';
        snapshot.stockRows[0].location_id = 'location';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].variation_location_id = 'variation-location\u007f';
      },
      (snapshot) => {
        snapshot.stockRows[0].location_id = 'location\tcontrol';
      },
      (snapshot) => {
        snapshot.items[0].item_number = 1;
        snapshot.stockRows[0].item_number = 2;
      },
      (snapshot) => {
        snapshot.items[0].item_number = 2_147_483_648;
        snapshot.stockRows[0].item_number = 2_147_483_648;
      },
      (snapshot) => {
        snapshot.items[0].category_name = 'Parent category';
        snapshot.stockRows[0].category_name = 'Different category';
      },
      (snapshot) => {
        snapshot.items[0].price = 10;
        snapshot.stockRows[0].price = 11;
      },
      (snapshot) => {
        snapshot.items[0].cost = 5;
        snapshot.stockRows[0].cost = 6;
      },
      (snapshot) => {
        snapshot.stockRows[0].quantity_on_hand = 7;
      },
      (snapshot) => {
        snapshot.items[0].quantity_reserved = 1;
        snapshot.stockRows[0].quantity_reserved = 2;
      },
      (snapshot) => {
        snapshot.items[0].quantity_available = 8;
        snapshot.stockRows[0].quantity_available = 7;
      },
      (snapshot) => {
        snapshot.items[0].quantity_incoming = 1;
        snapshot.stockRows[0].quantity_incoming = 2;
      },
      (snapshot) => {
        snapshot.items[0].in_transit = 1;
        snapshot.stockRows[0].in_transit = 2;
      },
      (snapshot) => {
        snapshot.items[0].barcode = 'parent-barcode';
        snapshot.stockRows[0].barcode = 'different-barcode';
      },
      (snapshot) => {
        snapshot.stockRows.push({ ...snapshot.stockRows[0], stock_row_id: 'second-parent-stock' });
        snapshot.meta.stockRowCount = 2;
      },
      (snapshot) => {
        snapshot.stockRows.push({
          ...snapshot.stockRows[0],
          stock_row_id: 'variation-stock',
          variation_id: 'variation',
        });
        snapshot.meta.stockRowCount = 2;
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows.push({
          ...snapshot.stockRows[0],
          stock_row_id: 'second-aggregate-stock',
        });
        snapshot.meta.stockRowCount = 2;
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows.push({
          ...snapshot.stockRows[0],
          stock_row_id: '42',
          variation_location_id: '42',
          location_id: 'location',
        });
        snapshot.meta.stockRowCount = 2;
      },
    ];

    for (const mutate of invalidCandidates) {
      const candidate = inventorySnapshot();
      mutate(candidate);
      refreshInventoryFingerprint(candidate);
      const { service, query } = makeService(async () => ({ rows: [] }));

      await expect(service.replaceInventorySnapshot(candidate)).rejects.toThrow(/invalid/i);
      expect(
        (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('accepts normalized aggregate and explicit variation-only inventory bundles', async () => {
    for (const mutate of [
      (candidate: InventorySnapshot) => {
        candidate.stockRows[0].variation_id = 'variation';
      },
      (candidate: InventorySnapshot) => {
        candidate.stockRows[0].stock_row_id = '42';
        candidate.stockRows[0].variation_id = 'variation';
        candidate.stockRows[0].variation_location_id = '42';
        candidate.stockRows[0].location_id = 'location';
      },
    ]) {
      const candidate = inventorySnapshot();
      mutate(candidate);
      refreshInventoryFingerprint(candidate);
      const { service, query } = makeService(async (sql) => {
        if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
        if (sql.includes("key = 'state' FOR UPDATE")) {
          return { rows: [{ value: JSON.stringify(state(7)) }] };
        }
        if (sql.includes('SELECT (SELECT COUNT(*) FROM items)')) {
          return { rows: [{ item_count: '1', stock_row_count: '1' }] };
        }
        return { rows: [] };
      });

      await expect(service.replaceInventorySnapshot(candidate)).resolves.toBeUndefined();
      expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
    }
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
      api_item_count: '1',
      api_stock_row_count: '1',
      ...overrides,
    });
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) return { rows: [authorityRow()] };
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: source.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: source.items };
      }
      return { rows: [] };
    });
    expect(await service.getInventoryCacheMeta()).toEqual(source.meta);
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain(
      "source_api_version = '3'"
    );

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

  it('reads authoritative warning metadata v2 without weakening row-count checks', async () => {
    const source = inventorySnapshot();
    const warningMeta = {
      ...source.meta,
      version: 2 as const,
      status: 'complete_with_warnings' as const,
      completedAt: 40,
      freshItemCount: 0,
      preservedItemCount: 1,
      omittedItemCount: 2,
      warningCount: 3,
      lastCompleteAt: 30,
    };
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(warningMeta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: source.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: source.items };
      }
      return { rows: [] };
    });

    expect(await service.getInventoryCacheMeta()).toEqual(warningMeta);

    query.mockImplementation(async () => ({
      rows: [
        {
          snapshot_value: JSON.stringify(warningMeta),
          state_value: JSON.stringify(authoritativeState),
          account_identity: binding.accountIdentity,
          item_count: '0',
          stock_row_count: '1',
          api_item_count: '1',
          api_stock_row_count: '1',
        },
      ],
    }));
    expect(await service.getInventoryCacheMeta()).toBeNull();
  });

  it('reads genuine historical v1 Unicode fingerprints but rejects uncovered-field tampering', async () => {
    const source = historicalV1InventorySnapshot(binding.accountIdentity);
    const itemRows: ItemRow[] = source.items.map((row) => ({
      ...row,
      valuation: null,
      imported_at: null,
    }));
    const stockRows: ItemStockLocationRow[] = source.stockRows.map((row) => ({
      ...row,
      variation_id: null,
      variation_location_id: null,
      valuation: null,
      imported_at: null,
    }));
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '3',
              stock_row_count: '3',
              api_item_count: '3',
              api_stock_row_count: '3',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: itemRows };
      }
      return { rows: [] };
    });

    expect((await service.getInventorySnapshot())?.meta).toEqual(source.meta);

    itemRows[0].valuation = 99;
    expect(await service.getInventorySnapshot()).toBeNull();
    itemRows[0].valuation = null;
    itemRows[0].imported_at = 99;
    expect(await service.getInventorySnapshot()).toBeNull();
    itemRows[0].imported_at = null;
    stockRows[0].valuation = 99;
    expect(await service.getInventorySnapshot()).toBeNull();
    stockRows[0].valuation = null;
    stockRows[0].imported_at = 99;
    expect(await service.getInventorySnapshot()).toBeNull();
    stockRows[0].imported_at = null;
    stockRows[0].variation_location_id = 'tampered';
    expect(await service.getInventorySnapshot()).toBeNull();
  });

  it('returns authoritative inventory rows and metadata from one repeatable-read snapshot', async () => {
    const source = inventorySnapshot();
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot'))
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: [{ ...source.stockRows[0], quantity_on_hand: '8', imported_at: '30' }] };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: [{ ...source.items[0], quantity: '8', imported_at: '30' }] };
      }
      return { rows: [] };
    });

    const result = await service.getInventorySnapshot();
    expect(result?.meta).toEqual(source.meta);
    expect(result?.items).toEqual([expect.objectContaining(source.items[0])]);
    expect(result?.stockRows).toEqual([expect.objectContaining(source.stockRows[0])]);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(
      expect.arrayContaining(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'])
    );
  });

  it('rejects inventory authority when distinct API v2 rows exist outside the v3 snapshot', async () => {
    const source = inventorySnapshot();
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '2',
              api_stock_row_count: '2',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: source.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: source.items };
      }
      return { rows: [] };
    });

    expect(await service.getInventorySnapshot()).toBeNull();
  });

  it('fails closed when authoritative metadata covers an item with no stock row', async () => {
    const source = inventorySnapshot();
    const generation = 'stored-inventory-missing-stock-row';
    const meta = {
      ...source.meta,
      generation,
      stockRowCount: 0,
      fingerprint: createInventorySnapshotFingerprint(
        binding.accountIdentity,
        generation,
        source.items,
        []
      ),
    };
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '0',
              api_item_count: '1',
              api_stock_row_count: '0',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: [] };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: source.items };
      }
      return { rows: [] };
    });

    await expect(service.getInventorySnapshot()).resolves.toBeNull();
    await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
  });

  it('treats a PostgreSQL NUMERIC NaN tamper as unauthoritative without leaking an error', async () => {
    const source = inventorySnapshot();
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: source.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: [{ ...source.items[0], cost: 'NaN' as unknown as number }] };
      }
      return { rows: [] };
    });

    await expect(service.getInventorySnapshot()).resolves.toBeNull();
    await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
  });

  it('treats a correctly fingerprinted NUL-bearing stored text value as unauthoritative', async () => {
    const source = inventorySnapshot();
    source.items[0].description = 'before\0after';
    source.meta.fingerprint = createInventorySnapshotFingerprint(
      source.meta.accountIdentity,
      source.meta.generation,
      source.items,
      source.stockRows
    );
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: source.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: source.items };
      }
      return { rows: [] };
    });

    await expect(service.getInventorySnapshot()).resolves.toBeNull();
    await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
  });

  it('treats correctly fingerprinted unpaired stored text and metadata as unauthoritative', async () => {
    for (const target of ['row', 'meta'] as const) {
      const source = inventorySnapshot();
      if (target === 'row') source.items[0].description = 'stored-\ud800';
      else source.meta.generation = 'stored-generation-\udc00';
      refreshInventoryFingerprint(source);
      const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
      const { service } = makeService(async (sql) => {
        if (sql.includes('FROM cache_meta AS snapshot')) {
          return {
            rows: [
              {
                snapshot_value: JSON.stringify(source.meta),
                state_value: JSON.stringify(authoritativeState),
                account_identity: binding.accountIdentity,
                item_count: '1',
                stock_row_count: '1',
                api_item_count: '1',
                api_stock_row_count: '1',
              },
            ],
          };
        }
        if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
          return { rows: source.stockRows };
        }
        if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
          return { rows: source.items };
        }
        return { rows: [] };
      });

      await expect(service.getInventorySnapshot()).resolves.toBeNull();
      await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
    }
  });

  it('treats correctly fingerprinted noncanonical IDs and incoherent stock rows as unauthoritative', async () => {
    const invalidCandidates: Array<(snapshot: InventorySnapshot) => void> = [
      (snapshot) => {
        snapshot.items[0].item_id = 'item\ncontrol';
        snapshot.stockRows[0].item_id = snapshot.items[0].item_id;
      },
      (snapshot) => {
        snapshot.items[0].cost = 5;
        snapshot.stockRows[0].cost = 6;
      },
      (snapshot) => {
        snapshot.stockRows[0].quantity_on_hand = 7;
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_location_id = 'variation-location';
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows[0].location_id = 'location';
      },
      (snapshot) => {
        snapshot.items[0].item_number = 2_147_483_648;
        snapshot.stockRows[0].item_number = 2_147_483_648;
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows.push({
          ...snapshot.stockRows[0],
          stock_row_id: 'second-aggregate-stock',
        });
        snapshot.meta.stockRowCount = 2;
      },
      (snapshot) => {
        snapshot.stockRows[0].variation_id = 'variation';
        snapshot.stockRows.push({
          ...snapshot.stockRows[0],
          stock_row_id: '42',
          variation_location_id: '42',
          location_id: 'location',
        });
        snapshot.meta.stockRowCount = 2;
      },
    ];

    for (const mutate of invalidCandidates) {
      const source = inventorySnapshot();
      mutate(source);
      refreshInventoryFingerprint(source);
      const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
      const { service } = makeService(async (sql) => {
        if (sql.includes('FROM cache_meta AS snapshot')) {
          return {
            rows: [
              {
                snapshot_value: JSON.stringify(source.meta),
                state_value: JSON.stringify(authoritativeState),
                account_identity: binding.accountIdentity,
                item_count: String(source.items.length),
                stock_row_count: String(source.stockRows.length),
                api_item_count: String(source.items.length),
                api_stock_row_count: String(source.stockRows.length),
              },
            ],
          };
        }
        if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
          return { rows: source.stockRows };
        }
        if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
          return { rows: source.items };
        }
        return { rows: [] };
      });

      await expect(service.getInventorySnapshot()).resolves.toBeNull();
      await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
    }
  });

  it('propagates inventory row read failures and rolls back the repeatable-read snapshot', async () => {
    const source = inventorySnapshot();
    const authoritativeState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, client, query } = makeService(async (sql) => {
      if (sql.includes('FROM cache_meta AS snapshot')) {
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(source.meta),
              state_value: JSON.stringify(authoritativeState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        throw new Error('injected inventory row read failure');
      }
      return { rows: [] };
    });

    await expect(service.getInventoryCacheMeta()).rejects.toThrow(
      'injected inventory row read failure'
    );
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
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
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('DELETE FROM cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
    expect(
      statements.indexOf(statements.find((sql) => sql.startsWith('INSERT INTO items'))!)
    ).toBeLessThan(statements.findIndex((sql) => sql.startsWith('DELETE FROM cache_meta')));
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

    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('DELETE FROM cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });
});

describe('PostgresCacheService atomic document bundles', () => {
  const document: DocumentRow = {
    doc_id: 'api-doc',
    api_doc_id: 'api-doc',
    context_id: 5,
    doc_number: 9001,
    issue_date: '2026-02-01',
    customer_id: 'customer-1',
    modified: 2,
  };

  it('rolls back document, line, and supplied payment mutations as one transaction', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) {
        return { rows: [{ doc_id: 'stored-doc', api_doc_id: document.api_doc_id }] };
      }
      if (sql.startsWith('INSERT INTO payment_transactions')) {
        throw new Error('injected document bundle payment failure');
      }
      return { rows: [] };
    });

    await expect(
      service.replaceDocumentBundle(
        document,
        [{ item_id: 'replacement-line', doc_id: document.doc_id, quantity: 2, price: 20 }],
        [payment('replacement-payment', document.doc_id)]
      )
    ).rejects.toThrow('injected document bundle payment failure');

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^INSERT INTO documents/),
        'DELETE FROM item_documents WHERE doc_id = $1',
        expect.stringMatching(/^INSERT INTO item_documents/),
        'DELETE FROM payment_transactions WHERE doc_id = $1',
        expect.stringMatching(/^INSERT INTO payment_transactions/),
        'ROLLBACK',
      ])
    );
    expect(statements).not.toContain('COMMIT');
    expect(
      query.mock.calls.find(([sql]) => sql === 'DELETE FROM item_documents WHERE doc_id = $1')?.[1]
    ).toEqual(['stored-doc']);
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO item_documents')
      )?.[1]?.[1]
    ).toBe('stored-doc');
    expect(
      query.mock.calls.find(
        ([sql]) => sql === 'DELETE FROM payment_transactions WHERE doc_id = $1'
      )?.[1]
    ).toEqual(['stored-doc']);
  });

  it('does not touch existing payment rows when payments are omitted', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) {
        return { rows: [{ doc_id: 'stored-doc', api_doc_id: document.api_doc_id }] };
      }
      return { rows: [] };
    });

    await service.replaceDocumentBundle(document, []);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).not.toContain('DELETE FROM payment_transactions WHERE doc_id = $1');
    expect(statements.some((sql) => sql.startsWith('INSERT INTO payment_transactions'))).toBe(
      false
    );
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('rejects a number-key takeover before document, child, or payment mutation', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) return { rows: [] };
      if (sql.includes('WHERE context_id = $1 AND doc_number = $2')) {
        return { rows: [{ doc_id: 'stored-doc', api_doc_id: 'other-api-doc' }] };
      }
      return { rows: [] };
    });

    await expect(
      service.replaceDocumentBundle(
        document,
        [{ item_id: 'new-line', doc_id: document.doc_id, quantity: 2, price: 20 }],
        [payment('new-payment', document.doc_id)]
      )
    ).rejects.toThrow(/document identity conflict/i);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SELECT doc_id, api_doc_id FROM documents WHERE api_doc_id'),
        expect.stringContaining(
          'SELECT doc_id, api_doc_id FROM documents WHERE context_id = $1 AND doc_number = $2'
        ),
        'ROLLBACK',
      ])
    );
    expect(payloadDocumentMutations(statements)).toEqual([]);
    expect(statements).not.toContain('COMMIT');
  });

  it('rejects distinct API and number owners even when the API lookup succeeds', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) {
        return { rows: [{ doc_id: 'api-owner', api_doc_id: document.api_doc_id }] };
      }
      if (sql.includes('WHERE context_id = $1 AND doc_number = $2')) {
        return { rows: [{ doc_id: 'number-owner', api_doc_id: null }] };
      }
      return { rows: [] };
    });

    await expect(service.replaceDocumentBundle(document, [])).rejects.toThrow(
      /document identity conflict/i
    );

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.some((sql) => sql.includes('WHERE context_id = $1 AND doc_number = $2'))
    ).toBe(true);
    expect(payloadDocumentMutations(statements)).toEqual([]);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('adopts a legacy null API identity and remaps the complete bundle', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) return { rows: [] };
      if (sql.includes('WHERE context_id = $1 AND doc_number = $2')) {
        return { rows: [{ doc_id: 'legacy-doc', api_doc_id: null }] };
      }
      return { rows: [] };
    });

    await service.replaceDocumentBundle(
      document,
      [{ item_id: 'new-line', doc_id: document.doc_id, quantity: 2, price: 20 }],
      [payment('new-payment', document.doc_id)]
    );

    const documentInsert = query.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO documents')
    );
    expect(documentInsert?.[1]?.[0]).toBe('legacy-doc');
    expect(documentInsert?.[1]?.[6]).toBe(document.api_doc_id);
    expect(
      query.mock.calls.find(([sql]) => sql === 'DELETE FROM item_documents WHERE doc_id = $1')?.[1]
    ).toEqual(['legacy-doc']);
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO item_documents')
      )?.[1]?.[1]
    ).toBe('legacy-doc');
    expect(
      query.mock.calls.find(
        ([sql]) => sql === 'DELETE FROM payment_transactions WHERE doc_id = $1'
      )?.[1]
    ).toEqual(['legacy-doc']);
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO payment_transactions')
      )?.[1]?.[1]
    ).toBe('legacy-doc');
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });

  it.each(['\ud800', '\udc00'])(
    'rejects an unpaired document API surrogate %# before lookup',
    async (suffix) => {
      const malformed = `api-${suffix}`;
      const { service, query } = makeService(async (sql) => ({
        rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
      }));

      await expect(
        service.replaceDocumentBundle({ ...document, api_doc_id: malformed }, [])
      ).rejects.toThrow(/API identity is invalid/i);

      const statements = query.mock.calls.map(([sql]) => String(sql));
      expect(query.mock.calls.flatMap(([, params]) => params ?? [])).not.toContain(malformed);
      expect(payloadDocumentMutations(statements)).toEqual([]);
      expect(statements.at(-1)).toBe('ROLLBACK');
    }
  );

  it('rejects a malformed stored API identity and accepts a valid non-BMP identity', async () => {
    const malformed = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) return { rows: [] };
      if (sql.includes('WHERE context_id = $1 AND doc_number = $2')) {
        return { rows: [{ doc_id: 'stored-doc', api_doc_id: 'bad-\ud800' }] };
      }
      return { rows: [] };
    });
    await expect(malformed.service.replaceDocumentBundle(document, [])).rejects.toThrow(
      /cached document identity is invalid/i
    );
    expect(
      payloadDocumentMutations(malformed.query.mock.calls.map(([sql]) => String(sql)))
    ).toEqual([]);

    const validDocument = { ...document, api_doc_id: 'api-🚀' };
    const valid = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('WHERE api_doc_id = $1')) return { rows: [] };
      if (sql.includes('WHERE context_id = $1 AND doc_number = $2')) {
        return { rows: [{ doc_id: 'legacy-doc', api_doc_id: null }] };
      }
      return { rows: [] };
    });
    await expect(valid.service.replaceDocumentBundle(validDocument, [])).resolves.toBeUndefined();
    expect(valid.query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });
});

describe('PostgresCacheService v7 category authority', () => {
  it('rejects a wrong category fingerprint before any category, metadata, or inventory mutation', async () => {
    const invalid = snapshot();
    invalid.rows[0].name = 'Renamed parent';
    invalid.rows[1].parent_name = 'Renamed parent';
    invalid.meta.fingerprint = 'sha256:wrong';
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
    }));

    await expect(service.replaceCategorySnapshot(invalid)).rejects.toThrow(/fingerprint/i);
    expect(
      (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
    ).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects non-exact rows and parent names not derived from the new snapshot before connecting', async () => {
    const { service } = makeService(async () => ({ rows: [] }));
    const invalidExtra = snapshot();
    (invalidExtra.rows[0] as unknown as Record<string, unknown>).raw = {};
    await expect(service.replaceCategorySnapshot(invalidExtra)).rejects.toThrow(
      /invalid or duplicate/
    );

    const invalidParent = snapshot();
    invalidParent.rows[1].parent_name = 'Stale parent';
    await expect(service.replaceCategorySnapshot(invalidParent)).rejects.toThrow(
      /derived from the same/
    );
    expect(
      (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
    ).not.toHaveBeenCalled();
  });

  it('rejects category strings containing NUL before fingerprinted rows can diverge in PostgreSQL', async () => {
    const { service } = makeService(async () => ({ rows: [] }));
    const invalid = snapshot();
    invalid.rows[0].name = 'A\0B';

    await expect(service.replaceCategorySnapshot(invalid)).rejects.toThrow(/invalid or duplicate/);
    expect(
      (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
    ).not.toHaveBeenCalled();
  });

  it.each(['category-\ud800', 'category-\udc00'])(
    'rejects correctly fingerprinted unpaired category text before connecting %#',
    async (name) => {
      const invalid = snapshot();
      invalid.rows[0].name = name;
      invalid.rows[1].parent_name = name;
      refreshCategoryFingerprint(invalid);
      const { service, query } = makeService(async () => ({ rows: [] }));

      await expect(service.replaceCategorySnapshot(invalid)).rejects.toThrow(/invalid/i);
      expect(
        (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  );

  it('accepts well-formed non-BMP category text', async () => {
    const valid = snapshot();
    valid.rows[0].name = 'Parent 🚀';
    valid.rows[1].parent_name = 'Parent 🚀';
    refreshCategoryFingerprint(valid);
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(state(7)) }] };
      }
      return { rows: [] };
    });

    await expect(service.replaceCategorySnapshot(valid)).resolves.toBeUndefined();
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('COMMIT');
  });

  it('rejects correctly fingerprinted noncanonical category IDs and mixed source versions before connecting', async () => {
    const invalidCandidates: Array<(categorySnapshot: CategorySnapshot) => void> = [
      (categorySnapshot) => {
        categorySnapshot.rows[1].category_id = 'child-with-trailing-space ';
      },
      (categorySnapshot) => {
        categorySnapshot.rows[1].parent_id = 'parent\ncontrol';
        categorySnapshot.rows[1].parent_name = null;
      },
      (categorySnapshot) => {
        categorySnapshot.rows[0].source_api_version = '2.0';
      },
      (categorySnapshot) => {
        categorySnapshot.meta.sourceApiVersion = '2.0';
      },
      (categorySnapshot) => {
        categorySnapshot.rows[0].item_count = 2_147_483_648;
      },
    ];

    for (const mutate of invalidCandidates) {
      const invalid = snapshot();
      mutate(invalid);
      refreshCategoryFingerprint(invalid);
      const { service, query } = makeService(async () => ({ rows: [] }));

      await expect(service.replaceCategorySnapshot(invalid)).rejects.toThrow(/invalid/i);
      expect(
        (service as unknown as { pool: { connect: jest.Mock } }).pool.connect
      ).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('atomically replaces rows, meta, state, marker, and reconciles item plus stock names', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE"))
        return { rows: [{ value: JSON.stringify(state(6)) }] };
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
    expect(
      query.mock.calls.some(
        ([, params]) =>
          params?.[0] === 'category_cache.v7.generation' && params?.[1] === 'generation-1'
      )
    ).toBe(true);
    expect(
      query.mock.calls.some(([, params]) => params?.[0] === 'inventory_cache.v7.snapshot')
    ).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('clears stale v3 state while reconciling category names', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return {
          rows: [
            {
              value: JSON.stringify({
                ...state(7),
                inventorySourceApiVersion: '3',
              }),
            },
          ],
        };
      }
      return { rows: [] };
    });

    await service.replaceCategorySnapshot(snapshot());

    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
  });

  it('preserves authoritative inventory with a refreshed generation after category reconciliation', async () => {
    const inventory = inventorySnapshot();
    inventory.items[0].category_id = 'parent';
    inventory.items[0].category_name = 'Parent';
    inventory.stockRows[0].category_name = 'Parent';
    inventory.meta.fingerprint = createInventorySnapshotFingerprint(
      inventory.meta.accountIdentity,
      inventory.meta.generation,
      inventory.items,
      inventory.stockRows
    );
    const currentState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('FROM cache_meta AS snapshot'))
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(inventory.meta),
              state_value: JSON.stringify(currentState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(currentState) }] };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: inventory.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: inventory.items };
      }
      return { rows: [] };
    });

    await service.replaceCategorySnapshot(snapshot());

    const inventoryWrite = query.mock.calls.find(
      ([, params]) =>
        params?.[0] === 'inventory_cache.v7.snapshot' && typeof params?.[1] === 'string'
    );
    const refreshedMeta = JSON.parse(String(inventoryWrite?.[1]?.[1]));
    expect(refreshedMeta).toMatchObject({
      version: inventory.meta.version,
      status: inventory.meta.status,
      startedAt: inventory.meta.startedAt,
      completedAt: inventory.meta.completedAt,
      itemCount: inventory.meta.itemCount,
      stockRowCount: inventory.meta.stockRowCount,
    });
    expect(refreshedMeta.generation).not.toBe(inventory.meta.generation);
    expect(refreshedMeta.fingerprint).not.toBe(inventory.meta.fingerprint);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('DELETE FROM cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(false);
    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBe('3');
  });

  it('invalidates same-count tampered inventory instead of refreshing its fingerprint', async () => {
    const inventory = inventorySnapshot();
    const currentState = { ...state(7), inventorySourceApiVersion: '3' as const };
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes('FROM cache_meta AS snapshot'))
        return {
          rows: [
            {
              snapshot_value: JSON.stringify(inventory.meta),
              state_value: JSON.stringify(currentState),
              account_identity: binding.accountIdentity,
              item_count: '1',
              stock_row_count: '1',
              api_item_count: '1',
              api_stock_row_count: '1',
            },
          ],
        };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(currentState) }] };
      }
      if (sql.includes('FROM item_stock_locations') && sql.includes('ORDER BY stock_row_id')) {
        return { rows: inventory.stockRows };
      }
      if (sql.includes('FROM items') && sql.includes('ORDER BY item_id')) {
        return { rows: [{ ...inventory.items[0], name: 'Tampered item' }] };
      }
      return { rows: [] };
    });

    expect(await service.getInventoryCacheMeta()).toBeNull();
    expect(await service.getInventorySnapshot()).toBeNull();
    query.mockClear();
    await service.replaceCategorySnapshot(snapshot());

    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('DELETE FROM cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('INSERT INTO cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(false);
    const stateWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("VALUES ('state', $1)")
    );
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
  });

  it('rolls back a snapshot failure without committing partial authority', async () => {
    const { service, query } = makeService(async (sql) => {
      if (sql.includes('SELECT account_identity')) return { rows: [bindingRow()] };
      if (sql.includes("key = 'state' FOR UPDATE")) return { rows: [] };
      if (sql.includes('INSERT INTO category_cache_meta')) throw new Error('injected meta failure');
      return { rows: [] };
    });

    await expect(service.replaceCategorySnapshot(snapshot())).rejects.toThrow(
      'injected meta failure'
    );
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
      if (sql.includes("VALUES ('state'"))
        persistedVersion = JSON.parse(String(params?.[0])).schemaVersion;
      return { rows: [] };
    });

    await service.setCacheState(state(7));
    const firstDeletes = query.mock.calls.filter(
      ([sql, params]) =>
        String(sql).startsWith('DELETE FROM cache_meta') &&
        params?.[0] === 'category_cache.v7.generation'
    );
    expect(firstDeletes).toHaveLength(1);

    query.mockClear();
    await service.setCacheState({ ...state(7), lastSync: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM cache_meta'))).toBe(
      false
    );
  });

  it('reads authority fail-closed without mutation and coerces valid PostgreSQL numerics', async () => {
    const source = snapshot();
    const authorityRow = (schemaVersion: number, marker = source.meta.generation) => ({
      snapshot_value: JSON.stringify(source.meta),
      marker_value: marker,
      state_value: JSON.stringify(state(schemaVersion)),
      account_identity: binding.accountIdentity,
      account_subdomain: binding.accountSubdomain,
    });
    const { service, query } = makeService(async () => ({ rows: [authorityRow(6)] }));

    expect(await service.getCategoryCacheMeta()).toBeNull();
    expect(
      query.mock.calls
        .map(([sql]) => String(sql))
        .some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql))
    ).toBe(false);

    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM category_cache_meta')
        ? [authorityRow(7)]
        : source.rows.map((row) => ({
            ...row,
            item_count: row.item_count == null ? null : String(row.item_count),
            modified: row.modified == null ? null : String(row.modified),
            imported_at: String(row.imported_at),
          })),
    }));
    expect(await service.getCategorySnapshot()).toEqual(source);
  });

  it('does not report complete metadata when physical category row count differs', async () => {
    const source = snapshot();
    const authority = {
      snapshot_value: JSON.stringify(source.meta),
      marker_value: source.meta.generation,
      state_value: JSON.stringify(state(7)),
      account_identity: binding.accountIdentity,
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

  it('rejects same-count category tampering consistently across metadata and snapshot reads', async () => {
    const source = snapshot();
    const authority = {
      snapshot_value: JSON.stringify(source.meta),
      marker_value: source.meta.generation,
      state_value: JSON.stringify(state(7)),
      account_identity: binding.accountIdentity,
      account_subdomain: binding.accountSubdomain,
    };
    const tamperedRows = source.rows.map((row, index) =>
      index === 0 ? { ...row, name: 'Tampered category' } : row
    );
    const { service } = makeService(async (sql) => {
      if (sql.includes('FROM category_cache_meta')) return { rows: [authority] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
      if (sql.includes('FROM categories ORDER BY')) return { rows: tamperedRows };
      return { rows: [] };
    });

    expect(await service.getCategoryCacheMeta()).toBeNull();
    expect(await service.getCategorySnapshot()).toBeNull();
    expect(await service.getCategory(source.rows[0].category_id)).toBeUndefined();
    expect(await service.getAllCategories()).toEqual([]);
    expect(await service.getCategoryCount()).toBe(0);
  });

  it('fails category readers closed on correctly fingerprinted canonical-ID and source-version violations', async () => {
    for (const mutate of [
      (categorySnapshot: CategorySnapshot) => {
        categorySnapshot.rows[0].name = 'parent-\ud800';
        categorySnapshot.rows[1].parent_name = categorySnapshot.rows[0].name;
      },
      (categorySnapshot: CategorySnapshot) => {
        categorySnapshot.rows[0].category_id = 'parent\ncontrol';
        categorySnapshot.rows[1].parent_id = categorySnapshot.rows[0].category_id;
      },
      (categorySnapshot: CategorySnapshot) => {
        categorySnapshot.rows[0].source_api_version = '2.0';
      },
      (categorySnapshot: CategorySnapshot) => {
        categorySnapshot.meta.sourceApiVersion = '2.0';
      },
      (categorySnapshot: CategorySnapshot) => {
        categorySnapshot.rows[0].item_count = 2_147_483_648;
      },
    ]) {
      const source = snapshot();
      mutate(source);
      refreshCategoryFingerprint(source);
      const authority = {
        snapshot_value: JSON.stringify(source.meta),
        marker_value: source.meta.generation,
        state_value: JSON.stringify(state(7)),
        account_identity: binding.accountIdentity,
        account_subdomain: binding.accountSubdomain,
      };
      const { service } = makeService(async (sql) => {
        if (sql.includes('FROM category_cache_meta')) return { rows: [authority] };
        if (sql.includes('FROM categories ORDER BY')) return { rows: source.rows };
        return { rows: [] };
      });

      await expect(service.getCategoryCacheMeta()).resolves.toBeNull();
      await expect(service.getCategorySnapshot()).resolves.toBeNull();
    }
  });

  it('propagates category row read failures and rolls back the repeatable-read snapshot', async () => {
    const source = snapshot();
    const authority = {
      snapshot_value: JSON.stringify(source.meta),
      marker_value: source.meta.generation,
      state_value: JSON.stringify(state(7)),
      account_identity: binding.accountIdentity,
      account_subdomain: binding.accountSubdomain,
    };
    const { service, client, query } = makeService(async (sql) => {
      if (sql.includes('FROM category_cache_meta')) return { rows: [authority] };
      if (sql.includes('FROM categories ORDER BY')) {
        throw new Error('injected category row read failure');
      }
      return { rows: [] };
    });

    await expect(service.getCategoryCacheMeta()).rejects.toThrow(
      'injected category row read failure'
    );
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
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
    expect(
      first.query.mock.calls.find(([sql]) => String(sql).includes('pg_try_advisory_lock'))?.[1]
    ).toEqual(['salesbinder-cache-sync:salesbinder:acme']);
    await first.service.releaseSyncLock('alias-a');
    expect(await second.service.tryAcquireSyncLock('alias-b')).toBe(true);
    await second.service.releaseSyncLock('alias-b');
  });

  it('clear removes category authority and all cache data while preserving binding', async () => {
    const { service, query } = makeService(async (sql) => ({
      rows: sql.includes('SELECT account_identity') ? [bindingRow()] : [],
    }));

    await service.clearAll();

    const truncate =
      query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('TRUNCATE TABLE')) ??
      '';
    expect(truncate).toContain('categories, category_cache_meta, cache_meta');
    expect(truncate).not.toContain('cache_account_binding');
  });
});
