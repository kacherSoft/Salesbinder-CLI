import { ItemIndexerService } from '../item-indexer.service.js';
import type { CacheService } from '../cache.interface.js';
import type { SalesBinderClient } from '../../resources/index.js';

describe('inventory API source correctness', () => {
  const indexer = new ItemIndexerService(
    {} as SalesBinderClient,
    {} as CacheService,
    'test',
  );

  it('preserves observed variation-location balances instead of fabricating zeroes', () => {
    const item = {
      id: 'item-1', item_number: 1, name: 'Widget', quantity: 12, threshold: 1,
      cost: 2, price: 3, created: '2026-01-01', modified: '2026-01-02',
      item_variations: [{
        id: 'variation-1', item_id: 'item-1',
        item_variations_locations: [{
          id: 42, location_id: 'location-1', quantity: 12,
          quantity_reserved: 3, quantity_incoming: 5, in_transit: 2,
        }],
      }],
    };

    const [row] = (indexer as any).toStockRows(item, null);

    expect(row).toMatchObject({
      quantity_on_hand: 12,
      quantity_reserved: 3,
      quantity_available: null,
      quantity_incoming: 5,
      in_transit: 2,
    });
  });

  it('keeps unavailable balances unknown and accepts a flat v3 category name', () => {
    const item = {
      id: 'item-2', item_number: 2, name: 'No variation', quantity: 7, threshold: 0,
      cost: 2, price: 3, category_id: 'category-1', category_name: 'Hardware',
      created_at: '2026-01-01', updated_at: '2026-01-02', archived: true,
    };

    const master = (indexer as any).toItemRow(item, null);
    const [stock] = (indexer as any).toStockRows(item, null);

    expect(master).toMatchObject({
      category_name: 'Hardware',
      quantity_reserved: null,
      quantity_available: null,
      quantity_incoming: null,
      in_transit: null,
      archived: 1,
    });
    expect(stock).toMatchObject({
      quantity_on_hand: 7,
      quantity_reserved: null,
      quantity_available: null,
      quantity_incoming: null,
      in_transit: null,
    });
  });

  it('records v2 authority after fallback indexing instead of retaining v3 state', async () => {
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 1, lastFullSync: 1, documentCount: 0, itemDocumentCount: 0,
        accountName: 'test', schemaVersion: 7, inventorySourceApiVersion: '3',
      })),
      getCategorySnapshot: jest.fn(async () => null),
      insertItem: jest.fn(async () => undefined),
      replaceItemStockLocations: jest.fn(async () => undefined),
      getItemCount: jest.fn(async () => 1),
      getStockLocationCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      items: {
        list: jest.fn(async () => ({ items: [], page: 1, pages: 1 })),
      },
    } as unknown as SalesBinderClient;
    const fallback = new ItemIndexerService(client, cache, 'test');

    await fallback.sync();

    expect(cache.setCacheState).toHaveBeenCalledWith(expect.objectContaining({
      inventorySourceApiVersion: '2.0',
    }));
  });
});
