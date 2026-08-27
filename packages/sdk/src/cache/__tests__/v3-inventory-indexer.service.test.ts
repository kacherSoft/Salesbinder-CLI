import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import { V3InventoryIndexerService, type V3InventoryClient } from '../v3-inventory-indexer.service.js';

describe('V3InventoryIndexerService', () => {
  it('publishes archived-complete items and authoritative variation-location balances atomically', async () => {
    const item = v3Item({ variation_count: 1, archived: true });
    const variation = v3Variation();
    const list = jest.fn(async () => page([item]));
    const listVariations = jest.fn(async () => page([variation]));
    const published: any[] = [];
    const cache = fakeCache({ replaceInventorySnapshot: async (snapshot: unknown) => { published.push(snapshot); } });
    const service = new V3InventoryIndexerService(
      { items: { list, listVariations } }, cache, 'default', 'salesbinder:acme',
    );

    const result = await service.sync();

    expect(list).toHaveBeenCalledWith({ page: 1, limit: 100, archived: 'all' });
    expect(list).toHaveBeenCalledTimes(2);
    expect(listVariations).toHaveBeenCalledWith(item.id, { page: 1, limit: 100, include: 'locations' });
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ itemsProcessed: 1, stockRowsProcessed: 1 });
    expect(published).toHaveLength(1);
    expect(published[0].items[0]).toMatchObject({
      item_id: item.id, archived: 1, quantity_reserved: 3,
      quantity_available: null, quantity_incoming: 5, in_transit: 2,
      source_api_version: '3',
    });
    expect(published[0].stockRows[0]).toMatchObject({
      stock_row_id: '42', variation_location_id: '42',
      quantity_on_hand: 12, quantity_reserved: 3, quantity_available: null,
      quantity_incoming: 5, in_transit: 2, source_api_version: '3',
    });
    expect(published[0].meta).toMatchObject({
      accountIdentity: 'salesbinder:acme', sourceApiVersion: '3',
      itemCount: 1, stockRowCount: 1, schemaVersion: 7,
    });
  });

  it('does not publish when equal-count item balances and content change between stability passes', async () => {
    const list = jest.fn()
      .mockResolvedValueOnce(page([v3Item({ name: 'Before', cost: '2.0000', quantity: 4, quantity_reserved: 1 })]))
      .mockResolvedValueOnce(page([v3Item({ name: 'After', cost: '3.0000', quantity: 9, quantity_reserved: 2 })]));
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      { items: { list, listVariations: jest.fn() } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(service.sync()).rejects.toThrow(/stability verification/i);

    expect(list).toHaveBeenCalledTimes(2);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when nested variation-location balances change with stable membership', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const listVariations = jest.fn()
      .mockResolvedValueOnce(page([v3Variation()]))
      .mockResolvedValueOnce(page([v3Variation({
        quantity: 13,
        locations: [{
          ...v3Variation().locations![0],
          quantity: 13,
        }],
      })]));
    const service = new V3InventoryIndexerService(
      { items: { list: jest.fn(async () => page([item])), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(service.sync()).rejects.toThrow(/stability verification/i);
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when a variation snapshot is incomplete', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const client: V3InventoryClient = {
      items: {
        list: jest.fn(async () => page([item])),
        listVariations: jest.fn(async () => page([], { total_records: 1 })),
      },
    };
    const service = new V3InventoryIndexerService(
      client, fakeCache({ replaceInventorySnapshot }), 'default', 'salesbinder:acme',
    );

    await expect(service.sync()).rejects.toThrow(/incomplete v3 variations/i);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish malformed archive state or inconsistent page totals', async () => {
    const replaceInventorySnapshot = jest.fn();
    const malformedItem = { ...v3Item(), archived: undefined } as unknown as V3Item;
    const malformedService = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([malformedItem])),
          listVariations: jest.fn(),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(malformedService.sync()).rejects.toThrow('Invalid v3 item archived');
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();

    const incompleteService = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => ({
            ...page([v3Item()], {
              per_page: 100,
              total_pages: 2,
              total_records: 101,
            }),
            has_more: true,
          })),
          listVariations: jest.fn(),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(incompleteService.sync()).rejects.toThrow(/Incomplete v3 items page 1/);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when equal-count item membership changes between stability passes', async () => {
    const replaceInventorySnapshot = jest.fn();
    const list = jest.fn()
      .mockResolvedValueOnce(page([v3Item({ id: 'item-first' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-second' })]));
    const service = new V3InventoryIndexerService(
      { items: { list, listVariations: jest.fn() } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(service.sync()).rejects.toThrow(/stability verification/i);
    expect(list).toHaveBeenCalledTimes(2);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when equal-count variation membership changes between stability passes', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const listVariations = jest.fn()
      .mockResolvedValueOnce(page([v3Variation({ id: 'variation-first' })]))
      .mockResolvedValueOnce(page([v3Variation({ id: 'variation-second' })]));
    const service = new V3InventoryIndexerService(
      { items: { list: jest.fn(async () => page([item])), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme',
    );

    await expect(service.sync()).rejects.toThrow(/stability verification/i);
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });
});

function fakeCache(overrides: Record<string, unknown>): CacheService {
  return {
    getCacheState: jest.fn(async () => ({
      lastSync: 0, lastFullSync: 0, documentCount: 0, itemDocumentCount: 0,
      accountName: 'default', schemaVersion: 7,
    })),
    getCategorySnapshot: jest.fn(async () => null),
    replaceInventorySnapshot: jest.fn(async () => undefined),
    getItemCount: jest.fn(async () => 1),
    getStockLocationCount: jest.fn(async () => 1),
    setCacheState: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CacheService;
}

function page<T>(
  data: T[],
  pagination: Partial<V3ListResponse<T>['pagination']> = {},
): V3ListResponse<T> {
  const totalRecords = pagination.total_records ?? data.length;
  return {
    object: 'list', url: '/api/v3/test', has_more: false, data,
    pagination: {
      page: pagination.page ?? 1,
      per_page: pagination.per_page ?? 100,
      total_pages: pagination.total_pages ?? 1,
      total_records: totalRecords,
    },
  };
}

function v3Item(overrides: Partial<V3Item> = {}): V3Item {
  return {
    id: 'item-1', object: 'item', item_number: 1, name: 'Widget',
    description: null, sku: null, barcode: null, serial_number: null,
    inventory_type: 'quantity', category_id: null, category_name: null,
    status_id: 12, location_id: null, price: '3.0000', cost: '2.0000',
    quantity: 12, quantity_reserved: 3, quantity_incoming: 5, threshold: 1,
    variation_count: 0, published: true, archived: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function v3Variation(overrides: Partial<V3ItemVariation> = {}): V3ItemVariation {
  return {
    id: 'variation-1', object: 'item_variation', item_id: 'item-1', barcode: 'W-1',
    quantity: 12, quantity_reserved: 3, quantity_incoming: 5, in_transit: 2,
    location_count: 1,
    locations: [{
      object: 'item_variation_location', item_variation_location_id: 42,
      location_id: 'location-1', location_name: 'Main', quantity: 12,
      quantity_reserved: 3, quantity_incoming: 5, in_transit: 2, threshold: 1,
    }],
    ...overrides,
  };
}
