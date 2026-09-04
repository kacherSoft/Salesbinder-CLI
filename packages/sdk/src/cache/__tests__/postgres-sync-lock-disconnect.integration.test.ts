import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import {
  createInventorySnapshotFingerprint,
  createSalesBinderAccountBinding,
  type CacheAccountBinding,
  type CacheSyncStatus,
  type InventorySnapshot,
} from '../types.js';

const { Pool } = pg;

type PostgresSyncLockOptions = { onLost?: (error: Error) => void };
type SyncLockAwarePostgresCacheService = PostgresCacheService & {
  tryAcquireSyncLock(lockKey: string, options?: PostgresSyncLockOptions): Promise<boolean>;
};

const disconnectTestUrl = process.env.SALESBINDER_POSTGRES_DISCONNECT_TEST_URL;
const describeIfPostgres = disconnectTestUrl ? describe : describe.skip;

const lockAware = (service: PostgresCacheService): SyncLockAwarePostgresCacheService =>
  service as SyncLockAwarePostgresCacheService;

const testBinding: CacheAccountBinding = createSalesBinderAccountBinding('lock-loss-integration');

const syncStatus = (
  runId: string,
  status: CacheSyncStatus['status'],
  timestamp: number
): CacheSyncStatus => ({
  status,
  runId,
  accountName: 'lock-loss-integration',
  syncTarget: 'postgresql',
  startedAt: timestamp,
  updatedAt: timestamp,
  ...(status === 'running' ? {} : { finishedAt: timestamp }),
  syncType: 'delta',
  message: status === 'running' ? 'Sync running' : 'Sync failed',
  ...(status === 'failed' ? { error: 'Cache sync failed.' } : {}),
});

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const scopedConnectionString = (
  baseUrl: string,
  schema: string,
  applicationName: string
): string => {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', applicationName);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
};

const integrationInventorySnapshot = (
  accountIdentity: string,
  options: {
    itemId?: string;
    itemName?: string;
    quantity?: number;
    stockRowId?: string;
    importedAt?: number;
  } = {}
): InventorySnapshot => {
  const generation = `integration-generation-${randomUUID()}`;
  const itemId = options.itemId ?? 'integration-item';
  const stockRowId = options.stockRowId ?? 'integration-stock';
  const quantity = options.quantity ?? 3;
  const importedAt = options.importedAt ?? 100;
  const items = [
    {
      item_id: itemId,
      name: options.itemName ?? 'Integration item',
      quantity,
      quantity_reserved: 0,
      quantity_available: quantity,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api' as const,
      source_api_version: '3' as const,
      imported_at: importedAt,
    },
  ];
  const stockRows = [
    {
      stock_row_id: stockRowId,
      item_id: itemId,
      quantity_on_hand: quantity,
      quantity_reserved: 0,
      quantity_available: quantity,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api' as const,
      source_api_version: '3' as const,
      imported_at: importedAt,
    },
  ];
  return {
    items,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity,
      startedAt: 90,
      completedAt: 100,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: createInventorySnapshotFingerprint(
        accountIdentity,
        generation,
        items,
        stockRows
      ),
    },
  };
};

const waitFor = async <T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 5000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

describeIfPostgres('PostgresCacheService sync lock disconnect integration', () => {
  jest.setTimeout(30_000);

  const schemaName = `salesbinder_lock_loss_${randomUUID().replaceAll('-', '_')}`;
  // PostgreSQL truncates application_name to 63 bytes; keep these identifiers shorter
  // so the admin connection can address the exact lock-owner session deterministically.
  const serviceApplicationName = `sb-lock-owner-${randomUUID()}`;
  const successorApplicationName = `sb-lock-next-${randomUUID()}`;
  const schemaSql = quoteIdentifier(schemaName);
  let adminPool: InstanceType<typeof Pool> | undefined;
  let ownerService: SyncLockAwarePostgresCacheService | undefined;
  let successorService: SyncLockAwarePostgresCacheService | undefined;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: disconnectTestUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaSql}`);
  });

  afterAll(async () => {
    await ownerService?.close().catch(() => undefined);
    await successorService?.close().catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => undefined);
    await adminPool?.end().catch(() => undefined);
  });

  it('terminates the lock owner, fences stale writes, and preserves successor status', async () => {
    if (!disconnectTestUrl || !adminPool) {
      throw new Error('Disconnect integration test URL was not configured.');
    }
    const pool = adminPool;

    ownerService = lockAware(
      new PostgresCacheService(
        scopedConnectionString(disconnectTestUrl, schemaName, serviceApplicationName)
      )
    );
    successorService = lockAware(
      new PostgresCacheService(
        scopedConnectionString(disconnectTestUrl, schemaName, successorApplicationName)
      )
    );

    await ownerService.ensureAccountBinding(testBinding);
    await successorService.verifyAccountBinding(testBinding);

    let lostError: Error | undefined;
    await expect(
      ownerService.tryAcquireSyncLock('cache-sync', {
        onLost: (error) => {
          lostError = error;
        },
      })
    ).resolves.toBe(true);
    await ownerService.setSyncStatus(syncStatus('run-a', 'running', 100));
    const baselineSnapshot = integrationInventorySnapshot(testBinding.accountIdentity, {
      itemId: 'baseline-item',
      itemName: 'Baseline item',
      quantity: 3,
      stockRowId: 'baseline-stock',
      importedAt: 100,
    });
    await ownerService.replaceInventorySnapshot(baselineSnapshot);
    await expect(successorService.getInventoryCacheMeta()).resolves.toEqual(baselineSnapshot.meta);

    const blockerLockKey = `salesbinder-lock-loss-blocker-${randomUUID()}`;
    const blockedItemId = 'blocked-item';
    const blockerClient = await pool.connect();
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION ${schemaSql}.block_inventory_item_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.item_id = ${quoteLiteral(blockedItemId)} THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(${quoteLiteral(blockerLockKey)}, 0));
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await pool.query(`
        DROP TRIGGER IF EXISTS block_inventory_item_insert ON ${schemaSql}.items;
        CREATE TRIGGER block_inventory_item_insert
        BEFORE INSERT ON ${schemaSql}.items
        FOR EACH ROW
        EXECUTE FUNCTION ${schemaSql}.block_inventory_item_insert();
      `);
      await blockerClient.query('BEGIN');
      await blockerClient.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        blockerLockKey,
      ]);

      const inFlightWrite = ownerService
        .replaceInventorySnapshot(
          integrationInventorySnapshot(testBinding.accountIdentity, {
            itemId: blockedItemId,
            itemName: 'Blocked replacement item',
            quantity: 9,
            stockRowId: 'blocked-stock',
            importedAt: 200,
          })
        )
        .then(() => ({ completed: true, error: undefined }))
        .catch((writeError: Error) => ({ completed: false, error: writeError }));
      const blockedOwnerPid = await waitFor(async () => {
        const blocked = await pool.query<{ pid: number }>(
          `
            SELECT activity.pid
            FROM pg_locks AS lock
            JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
            WHERE lock.locktype = 'advisory'
              AND lock.granted = FALSE
              AND activity.application_name = $1
            LIMIT 1
          `,
          [serviceApplicationName]
        );
        return blocked.rows[0]?.pid;
      }, 'inventory replacement blocked inside transaction');

      await pool.query(`SELECT pg_terminate_backend($1)`, [blockedOwnerPid]);
      const writeResult = await inFlightWrite;
      expect(writeResult.completed).toBe(false);
      expect(writeResult.error?.message).toBe('PostgreSQL sync lock lost.');
    } finally {
      await blockerClient.query('ROLLBACK').catch(() => undefined);
      blockerClient.release();
      await pool
        .query(`DROP TRIGGER IF EXISTS block_inventory_item_insert ON ${schemaSql}.items`)
        .catch(() => undefined);
      await pool
        .query(`DROP FUNCTION IF EXISTS ${schemaSql}.block_inventory_item_insert()`)
        .catch(() => undefined);
    }

    const error = await waitFor(() => lostError, 'sync lock loss signal');
    expect(error.name).toBe('PostgresSyncLockLostError');
    expect(error.message).toBe('PostgreSQL sync lock lost.');

    await expect(successorService.getInventoryCacheMeta()).resolves.toEqual(baselineSnapshot.meta);
    await expect(successorService.getAllItems()).resolves.toEqual([
      expect.objectContaining({
        item_id: 'baseline-item',
        name: 'Baseline item',
        quantity: 3,
        cache_source: 'api',
        source_api_version: '3',
      }),
    ]);
    await expect(successorService.getAllItemStockLocations()).resolves.toEqual([
      expect.objectContaining({
        stock_row_id: 'baseline-stock',
        item_id: 'baseline-item',
        quantity_on_hand: 3,
        cache_source: 'api',
        source_api_version: '3',
      }),
    ]);

    const staleWrite = await ownerService
      .replaceInventorySnapshot(integrationInventorySnapshot(testBinding.accountIdentity))
      .then(() => ({ completed: true, error: undefined }))
      .catch((writeError: Error) => ({ completed: false, error: writeError }));
    expect(staleWrite.completed).toBe(false);
    expect(staleWrite.error?.message).toBe('PostgreSQL sync lock lost.');

    const failedRunA = syncStatus('run-a', 'failed', 101);
    await expect(ownerService.setSyncStatus(failedRunA)).resolves.toBeUndefined();
    await expect(successorService.getSyncStatus()).resolves.toEqual(failedRunA);
    await expect(successorService.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    const runningRunB = syncStatus('run-b', 'running', 102);
    await successorService.setSyncStatus(runningRunB);

    await expect(ownerService.setSyncStatus(failedRunA)).rejects.toThrow(
      'PostgreSQL sync status belongs to another run.'
    );
    await expect(successorService.getSyncStatus()).resolves.toEqual(runningRunB);
    await expect(
      successorService.replaceInventorySnapshot(
        integrationInventorySnapshot(testBinding.accountIdentity)
      )
    ).resolves.toBeUndefined();
    await expect(successorService.getInventoryCacheMeta()).resolves.toEqual(
      expect.objectContaining({ status: 'complete', accountIdentity: testBinding.accountIdentity })
    );
    await expect(successorService.releaseSyncLock('cache-sync')).resolves.toBeUndefined();
  });
});
