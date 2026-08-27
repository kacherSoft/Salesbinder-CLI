import type { CacheService } from '../cache.interface.js';
import { CsvCacheImportService } from '../csv-cache-import.service.js';

describe('CsvCacheImportService category precedence', () => {
  it('preserves API-backed item ID/name while leaving new CSV-only names as weak display data', async () => {
    const cache = {
      getItem: jest.fn(async (id: string) => id === 'api-item' ? {
        item_id: id,
        name: 'Existing',
        category_id: 'category-api',
        category_name: 'Canonical',
        cache_source: 'api',
      } : undefined),
    } as unknown as CacheService;
    const importer = new CsvCacheImportService(cache);

    const rows = await (importer as any).preserveApiCategoryIdentity([
      { item_id: 'api-item', name: 'Imported', category_name: 'Weak CSV', cache_source: 'csv' },
      { item_id: 'csv-item', name: 'CSV only', category_name: 'Display only', cache_source: 'csv' },
    ]);

    expect(rows[0]).toMatchObject({
      category_id: 'category-api', category_name: 'Canonical', cache_source: 'api',
    });
    expect(rows[1]).toMatchObject({ category_name: 'Display only', cache_source: 'csv' });
    expect(rows[1].category_id).toBeUndefined();
  });

  it('preserves an API stock category name on an ID collision', async () => {
    const cache = {
      getItemStockLocations: jest.fn(async () => [{
        stock_row_id: 'stock-1', item_id: 'item-1', category_name: 'Canonical',
        quantity_on_hand: 1, quantity_reserved: 0, quantity_available: 1,
        quantity_incoming: 0, in_transit: 0, cache_source: 'api',
      }]),
    } as unknown as CacheService;
    const importer = new CsvCacheImportService(cache);

    const rows = await (importer as any).preserveApiStockCategoryNames([{
      stock_row_id: 'stock-1', item_id: 'item-1', category_name: 'Weak CSV',
      quantity_on_hand: 2, quantity_reserved: 0, quantity_available: 2,
      quantity_incoming: 0, in_transit: 0, cache_source: 'csv',
    }]);

    expect(rows[0]).toMatchObject({ category_name: 'Canonical', cache_source: 'api' });
  });
});
