import { PostgresCacheService } from '../postgres-cache.service.js';
import type { ItemRow, ItemStockLocationRow } from '../types.js';

const itemId = '00000000-0000-4000-8000-000000000001';
const stockId = '00000000-0000-4000-8000-000000000002';

const item = (): ItemRow => ({
  item_id: itemId,
  name: 'Current API item',
  quantity: 7,
  cache_source: 'api',
  source_api_version: '3',
});

const stock = (): ItemStockLocationRow => ({
  stock_row_id: stockId,
  item_id: itemId,
  quantity_on_hand: 7,
  quantity_reserved: null,
  quantity_available: null,
  quantity_incoming: null,
  in_transit: null,
  cache_source: 'api',
  source_api_version: '3',
});

type QueryResult = { rows: Record<string, unknown>[] };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult>;

function serviceWith(handler: QueryHandler) {
  const query = jest.fn(handler);
  const client = { query, release: jest.fn() };
  const service = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
  Object.assign(service as object, {
    opened: true,
    expectedBinding: {
      accountIdentity: 'salesbinder:acme',
      accountSubdomain: 'acme',
      createdAt: 1,
    },
    syncLockClients: new Map(),
    pool: { connect: jest.fn(async () => client) },
  });
  return { service, query };
}

function boundCacheState() {
  return {
    schemaVersion: 8,
    lastSync: 40,
    lastFullSync: 20,
    documentCount: 3,
    itemDocumentCount: 4,
    accountName: 'acme',
    inventorySourceApiVersion: '3',
  };
}

describe('PostgresCacheService replaceApiInventoryBundle', () => {
  it('atomically replaces only API stock and invalidates inventory snapshot authority', async () => {
    const { service, query } = serviceWith(async (sql) => {
      if (sql.includes('FROM cache_account_binding')) {
        return {
          rows: [
            { account_identity: 'salesbinder:acme', account_subdomain: 'acme', created_at: 1 },
          ],
        };
      }
      if (sql.includes('WHERE stock_row_id = ANY')) return { rows: [] };
      if (sql.includes("key = 'state' FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(boundCacheState()) }] };
      }
      return { rows: [] };
    });

    await service.replaceApiInventoryBundle(item(), [stock()]);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('COMMIT');
    expect(statements).toContain(
      'DELETE FROM item_stock_locations WHERE item_id = $1 AND cache_source = \'api\''
    );
    expect(statements).not.toContain('DELETE FROM item_stock_locations WHERE item_id = $1');
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).startsWith('DELETE FROM cache_meta') &&
          params?.[0] === 'inventory_cache.v7.snapshot'
      )
    ).toBe(true);
    const stateWrite = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ('state', $1)"));
    expect(JSON.parse(String(stateWrite?.[1]?.[0])).inventorySourceApiVersion).toBeUndefined();
  });

  it('rejects a CSV stock identity collision before changing the item bundle', async () => {
    const { service, query } = serviceWith(async (sql) => {
      if (sql.includes('FROM cache_account_binding')) {
        return {
          rows: [
            { account_identity: 'salesbinder:acme', account_subdomain: 'acme', created_at: 1 },
          ],
        };
      }
      if (sql.includes('WHERE stock_row_id = ANY')) return { rows: [{ stock_row_id: stockId }] };
      return { rows: [] };
    });

    await expect(service.replaceApiInventoryBundle(item(), [stock()])).rejects.toThrow(
      'API inventory stock identity conflict'
    );

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.some((sql) => sql.startsWith('INSERT INTO items'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM item_stock_locations'))).toBe(false);
  });

  it('rolls back if a replacement write fails', async () => {
    const { service, query } = serviceWith(async (sql) => {
      if (sql.includes('FROM cache_account_binding')) {
        return {
          rows: [
            { account_identity: 'salesbinder:acme', account_subdomain: 'acme', created_at: 1 },
          ],
        };
      }
      if (sql.includes('WHERE stock_row_id = ANY')) return { rows: [] };
      if (sql.startsWith('DELETE FROM item_stock_locations')) throw new Error('injected delete failure');
      return { rows: [] };
    });

    await expect(service.replaceApiInventoryBundle(item(), [stock()])).rejects.toThrow(
      'injected delete failure'
    );

    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
  });

  it('rejects invalid API rows before opening a database transaction', async () => {
    const { service, query } = serviceWith(async () => ({ rows: [] }));
    const invalid = { ...item(), cache_source: 'csv' as const };

    await expect(service.replaceApiInventoryBundle(invalid, [stock()])).rejects.toThrow(
      'API inventory bundle is invalid: item'
    );
    expect(query).not.toHaveBeenCalled();
  });
});
