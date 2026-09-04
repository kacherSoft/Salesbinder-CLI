import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import { CACHE_SCHEMA_VERSION } from '../types.js';
import { V3InventoryIndexerService } from '../v3-inventory-indexer.service.js';
import { normalizeV3InventoryItem } from '../v3-inventory-normalizer.js';
import { assertCanonicalV3SourceId } from '../v3-inventory-source-validation.js';

describe('v3 inventory numeric source validation', () => {
  it.each(['item-\ud800', 'item-\udc00'])(
    'rejects an unpaired surrogate in canonical source ID %j',
    (id) => {
      expect(() => assertCanonicalV3SourceId(id, 'item')).toThrow(/identity/);
    }
  );

  it('accepts a valid non-BMP canonical source ID and item text', () => {
    expect(() => assertCanonicalV3SourceId('item-😀', 'item')).not.toThrow();
    expect(
      normalizeV3InventoryItem(item({ id: 'item-😀', name: 'Widget 😀' }), [], null).item
    ).toMatchObject({ item_id: 'item-😀', name: 'Widget 😀' });
  });

  it.each([
    ['name', 'Widget \ud800'],
    ['description', 'Description \udc00'],
  ] as const)('rejects an unpaired surrogate in item %s as a record error', (field, value) => {
    expectValidationError(
      () => normalizeV3InventoryItem(item({ [field]: value }), [], null),
      'record'
    );
  });

  it.each([
    ['quantity', '0x10'],
    ['quantity', '12'],
    ['threshold', '1'],
    ['item_number', '1'],
    ['item_number', 2_147_483_648],
  ] as const)('rejects non-contract %s value %s as a record error', (field, value) => {
    expectValidationError(
      () =>
        normalizeV3InventoryItem(item({ [field]: value } as unknown as Partial<V3Item>), [], null),
      'record'
    );
  });

  it.each([
    ['price', '0x10'],
    ['price', '1e2'],
    ['price', ''],
    ['cost', 10],
  ] as const)('rejects invalid decimal %s value %s', (field, value) => {
    expectValidationError(
      () =>
        normalizeV3InventoryItem(item({ [field]: value } as unknown as Partial<V3Item>), [], null),
      'record'
    );
  });

  it('accepts finite plain-decimal price and cost strings', () => {
    const normalized = normalizeV3InventoryItem(
      item({ price: '10.2500', cost: '-0.50' }),
      [],
      null
    );

    expect(normalized.item).toMatchObject({ price: 10.25, cost: -0.5 });
    expect(normalized.stockRows[0]).toMatchObject({ price: 10.25, cost: -0.5 });
  });

  it.each([
    ['variation quantity', { quantity: '12' }],
    [
      'variation-location ID',
      {
        locations: [
          {
            ...variation().locations![0],
            item_variation_location_id: '042',
          },
        ],
      },
    ],
  ])('rejects a malformed %s with variations scope', (_label, overrides) => {
    expectValidationError(
      () =>
        normalizeV3InventoryItem(
          item(),
          [variation(overrides as unknown as Partial<V3ItemVariation>)],
          null
        ),
      'variations'
    );
  });

  it('reuses canonical item and variation-location integers in emitted rows', () => {
    const normalized = normalizeV3InventoryItem(item({ item_number: 42 }), [variation()], null);

    expect(normalized.item.item_number).toBe(42);
    expect(normalized.stockRows[0]).toMatchObject({
      item_number: 42,
      stock_row_id: '42',
      variation_location_id: '42',
    });
  });

  it('retries malformed numbers once while preserving, omitting, and continuing peers', async () => {
    const preserved = item({
      id: 'item-preserve',
      item_number: 2_147_483_648,
    });
    const omitted = item({
      id: 'item-omit',
      item_number: 2,
      quantity: '0x10' as unknown as number,
    });
    const valid = item({ id: 'item-valid', item_number: 3 });
    const get = jest.fn(async (id: string) => (id === preserved.id ? preserved : omitted));
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: preserved.id,
      item_number: 1,
      name: 'Last known good',
      quantity: 9,
      archived: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const priorStock = {
      stock_row_id: 'old-stock',
      item_id: preserved.id,
      item_number: 1,
      quantity_on_hand: 9,
      quantity_reserved: 0,
      quantity_available: 9,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([preserved, omitted, valid])),
          get,
          listVariations: jest.fn(async () => variationPage([])),
        },
      },
      fakeCache({
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
      }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get.mock.calls.map(([id]) => id)).toEqual(['item-omit', 'item-preserve']);
    expect(result.recordIssues).toEqual([
      expect.objectContaining({ id: omitted.id, outcome: 'omitted_new', attempts: 2 }),
      expect.objectContaining({
        id: preserved.id,
        outcome: 'preserved_last_known_good',
        attempts: 2,
      }),
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ item_id: preserved.id, name: 'Last known good' }),
          expect.objectContaining({ item_id: valid.id }),
        ]),
        meta: expect.objectContaining({
          freshItemCount: 1,
          preservedItemCount: 1,
          omittedItemCount: 1,
        }),
      })
    );
  });
});

function expectValidationError(action: () => void, sourceScope: 'record' | 'variations'): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiResponseValidationError);
  expect(thrown).toMatchObject({ sourceScope });
}

function item(overrides: Partial<V3Item> = {}): V3Item {
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

function variation(overrides: Partial<V3ItemVariation> = {}): V3ItemVariation {
  return {
    id: 'variation-1',
    object: 'item_variation',
    item_id: 'item-1',
    barcode: 'W-1',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    in_transit: 2,
    location_count: 1,
    locations: [
      {
        object: 'item_variation_location',
        item_variation_location_id: 42,
        location_id: 'location-1',
        location_name: 'Main',
        quantity: 12,
        quantity_reserved: 3,
        quantity_incoming: 5,
        in_transit: 2,
        threshold: 1,
      },
    ],
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

function variationPage(
  data: import('../../types/items.types.js').V3ItemVariation[]
): import('../../types/items.types.js').V3ListResponse<
  import('../../types/items.types.js').V3ItemVariation
> {
  return {
    object: 'list',
    url: '/api/v3/items/item-1/variations',
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
      schemaVersion: CACHE_SCHEMA_VERSION,
    })),
    getCategorySnapshot: jest.fn(async () => null),
    getInventorySnapshot: jest.fn(async () => null),
    replaceInventorySnapshot: jest.fn(),
    getItemCount: jest.fn(async () => 2),
    getStockLocationCount: jest.fn(async () => 2),
    setCacheState: jest.fn(),
    ...overrides,
  } as unknown as CacheService;
}
