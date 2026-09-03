import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ListResponse } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import { V3InventoryIndexerService } from '../v3-inventory-indexer.service.js';
import { normalizeV3InventoryItem } from '../v3-inventory-normalizer.js';

describe('v3 inventory source dates', () => {
  it.each([
    ['created_at', '03/04/2026'],
    ['created_at', '2025-02-30T00:00:00+00:00'],
    ['created_at', '2026-01-02T03:04:05'],
    ['created_at', '0000-01-01T00:00:00Z'],
    ['created_at', '1'],
    ['updated_at', '03/04/2026'],
    ['updated_at', '2025-02-30T00:00:00+00:00'],
    ['updated_at', '2026-01-02T03:04:05'],
    ['updated_at', '0000-01-01T00:00:00Z'],
    ['updated_at', '1'],
    ['updated_at', '2026-01-02T03:04:05+14:01'],
  ] as const)('rejects malformed %s value %s as a record-local error', (field, value) => {
    try {
      normalizeV3InventoryItem(v3Item({ [field]: value }), [], null);
      throw new Error('Expected source validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiResponseValidationError);
      expect(error).toMatchObject({ sourceScope: 'record' });
    }
  });

  it.each([
    '2026-07-18T18:42:19+00:00',
    '2026-07-18T18:42:19Z',
    '2026-07-18T18:42:19.123456-04:30',
  ])('accepts a documented explicit-zone timestamp %s', (timestamp) => {
    const normalized = normalizeV3InventoryItem(
      v3Item({ created_at: timestamp, updated_at: timestamp }),
      [],
      null
    );

    expect(normalized.item.created).toBe(timestamp);
    expect(normalized.item.modified).toBe(Math.floor(new Date(timestamp).getTime() / 1000));
  });

  it('retries bad timestamps once, preserving an old item and omitting a new item', async () => {
    const preserved = v3Item({
      id: 'item-preserve',
      item_number: 1,
      created_at: '03/04/2026',
    });
    const omitted = v3Item({
      id: 'item-omit',
      item_number: 2,
      updated_at: '2025-02-30T00:00:00+00:00',
    });
    const get = jest.fn(async (id: string) => (id === preserved.id ? preserved : omitted));
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: preserved.id,
      item_number: 1,
      name: 'Last known good',
      quantity: 9,
      cache_source: 'api',
      source_api_version: '3',
    };
    const priorStock = {
      stock_row_id: 'old-stock',
      item_id: preserved.id,
      item_number: 1,
      quantity_on_hand: 9,
      cache_source: 'api',
      source_api_version: '3',
    };
    const cache = fakeCache({
      getInventorySnapshot: jest.fn(async () => ({
        items: [priorItem],
        stockRows: [priorStock],
        meta: {
          version: 1,
          status: 'complete',
          accountIdentity: 'salesbinder:acme',
          startedAt: 10,
          completedAt: 20,
          itemCount: 1,
          stockRowCount: 1,
          schemaVersion: 7,
          sourceApiVersion: '3',
          generation: 'old',
          fingerprint: 'sha256:old',
        },
      })),
      replaceInventorySnapshot,
    });
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([preserved, omitted])),
          get,
          listVariations: jest.fn(),
        },
      },
      cache,
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get.mock.calls.map(([id]) => id)).toEqual(['item-omit', 'item-preserve']);
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: omitted.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
      expect.objectContaining({
        id: preserved.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ item_id: preserved.id, name: 'Last known good' })],
        stockRows: [expect.objectContaining({ item_id: preserved.id })],
        meta: expect.objectContaining({
          preservedItemCount: 1,
          omittedItemCount: 1,
          warningCount: 2,
        }),
      })
    );
  });
});

function v3Item(overrides: Partial<V3Item> = {}): V3Item {
  return {
    id: 'item-1',
    object: 'item',
    item_number: 1,
    name: 'Widget',
    description: null,
    sku: null,
    barcode: null,
    serial_number: null,
    inventory_type: 'quantity',
    category_id: null,
    category_name: null,
    status_id: 12,
    location_id: null,
    price: '3.0000',
    cost: '2.0000',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    threshold: 1,
    variation_count: 0,
    published: true,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function page(data: V3Item[]): V3ListResponse<V3Item> {
  return {
    object: 'list',
    url: '/api/v3/items',
    has_more: false,
    data,
    pagination: { page: 1, per_page: 100, total_pages: 1, total_records: data.length },
  };
}

function fakeCache(overrides: Record<string, unknown>): CacheService {
  return {
    getCacheState: jest.fn(async () => ({
      lastSync: 0,
      lastFullSync: 0,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'default',
      schemaVersion: 7,
    })),
    getCategorySnapshot: jest.fn(async () => null),
    getInventorySnapshot: jest.fn(async () => null),
    replaceInventorySnapshot: jest.fn(),
    getItemCount: jest.fn(async () => 1),
    getStockLocationCount: jest.fn(async () => 1),
    setCacheState: jest.fn(),
    ...overrides,
  } as unknown as CacheService;
}
