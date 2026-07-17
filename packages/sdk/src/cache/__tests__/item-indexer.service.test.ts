import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SalesBinderClient } from '../../resources/index.js';
import type { Item } from '../../types/items.types.js';
import { ItemIndexerService } from '../item-indexer.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { CACHE_SCHEMA_VERSION, type CacheState } from '../types.js';

describe('ItemIndexerService', () => {
  let cache: SQLiteCacheService;
  let dbPath: string;
  const delayEnvKey = ['SALESBINDER', 'ITEM', 'DETAIL', 'DELAY', 'MS'].join('_');
  let previousDelay: string | undefined;

  beforeEach(() => {
    dbPath = join(tmpdir(), `item-indexer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cache = new SQLiteCacheService('test', dbPath, true);
    previousDelay = process.env[delayEnvKey];
    process.env[delayEnvKey] = '0';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (previousDelay === undefined) delete process.env[delayEnvKey];
    else process.env[delayEnvKey] = previousDelay;
    await cache.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.maintenance-lock`, { force: true });
  });

  it.each([
    ['cache is absent', null, 0],
    [
      'schema differs',
      cacheState({ schemaVersion: CACHE_SCHEMA_VERSION - 1, lastItemSync: 1_000 }),
      CACHE_SCHEMA_VERSION - 1,
    ],
    [
      'item watermark is absent',
      cacheState({ lastSync: 9_000, lastItemSync: undefined }),
      CACHE_SCHEMA_VERSION,
    ],
  ] as Array<[string, CacheState | null, number]>)('uses a full item list when %s', async (
    _label,
    initialState,
    expectedSchemaVersion
  ) => {
    if (initialState) await cache.setCacheState(initialState);
    const { client, list } = fakeClient();
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ modifiedSince: 0 }));
    expect(await cache.getCacheState()).toMatchObject({
      accountName: 'test',
      schemaVersion: expectedSchemaVersion,
      lastItemSync: 2_000,
      lastFullItemSync: 2_000,
    });
  });

  it('does not let a direct item-only sync publish whole-cache schema readiness', async () => {
    const previousSchema = CACHE_SCHEMA_VERSION - 1;
    await cache.setCacheState(cacheState({
      schemaVersion: previousSchema,
      lastItemSync: 1_000,
    }));
    const { client } = fakeClient();

    await new ItemIndexerService(client, cache, 'test', 100).sync(true, false);

    expect((await cache.getCacheState())?.schemaVersion).toBe(previousSchema);
  });

  it('uses only the item watermark for deltas and stores the sync-start watermark', async () => {
    await cache.setCacheState(cacheState({
      lastSync: 9_000,
      lastItemSync: 1_000,
      lastFullItemSync: 500,
    }));
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const { client, list } = fakeClient(async () => {
      now.mockReturnValue(3_000_000);
      return { items: [], pages: 1 };
    });

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ modifiedSince: 900 }));
    expect(await cache.getCacheState()).toMatchObject({
      lastItemSync: 2_000,
      lastFullItemSync: 500,
    });
  });

  it('reconciles renamed categories even when no item changed', async () => {
    await cache.setCacheState(cacheState({ lastItemSync: 1_000 }));
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Old Brand',
      cache_source: 'api',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'stock-1',
      item_id: 'item-1',
      item_number: 5001,
      location_id: 'location-1',
      location_name: 'Warehouse',
      category_name: 'Old Brand',
      quantity_on_hand: 5,
      quantity_reserved: 0,
      quantity_available: 5,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
    });
    const itemList = jest.fn().mockResolvedValue({ items: [], pages: 1 });
    const categories = categoryList('category-1', 'Renamed Brand');
    const client = {
      items: { list: itemList, get: jest.fn() },
      categories: { list: categories },
    } as unknown as SalesBinderClient;
    const allStockRows = jest.spyOn(cache, 'getAllItemStockLocations');
    const perItemStockRows = jest.spyOn(cache, 'getItemStockLocations');
    const replaceStockRows = jest.spyOn(cache, 'replaceItemStockLocations');

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(categories).toHaveBeenCalledTimes(1);
    expect(allStockRows).toHaveBeenCalledTimes(1);
    expect(perItemStockRows).not.toHaveBeenCalled();
    expect(replaceStockRows).toHaveBeenCalledTimes(1);
    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: 'category-1',
      category_name: 'Renamed Brand',
    });
    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({ category_name: 'Renamed Brand' }),
    ]);
  });

  it('preserves legacy Brand without an ID on omission and honors an explicit ID clear', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'CSV item',
      category_id: null,
      category_name: 'Legacy Brand',
      cache_source: 'csv',
    });
    const listed = sourceItem() as unknown as Record<string, unknown>;
    const detailed = sourceItem() as unknown as Record<string, unknown>;
    for (const source of [listed, detailed]) {
      delete source.category_id;
      delete source.category;
    }
    const emptyCategories = jest.fn().mockResolvedValue({ categories: [], pages: 1 });

    await new ItemIndexerService(
      populatedClient(
        listed as unknown as Item,
        detailed as unknown as Item,
        emptyCategories
      ),
      cache,
      'test',
      100
    ).sync();

    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: null,
      category_name: 'Legacy Brand',
    });

    const clearingDetail = sourceItem();
    (clearingDetail as unknown as Record<string, unknown>).category_id = null;
    await new ItemIndexerService(
      populatedClient(
        listed as unknown as Item,
        clearingDetail,
        emptyCategories
      ),
      cache,
      'test',
      100
    ).sync();

    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: null,
      category_name: null,
    });
  });

  it('does not publish an item watermark when category reconciliation cannot load', async () => {
    const initialState = cacheState({ lastItemSync: 1_000 });
    await cache.setCacheState(initialState);
    const itemList = jest.fn().mockResolvedValue({ items: [], pages: 1 });
    const categoryError = new Error('category source unavailable');
    const client = {
      items: { list: itemList, get: jest.fn() },
      categories: { list: jest.fn().mockRejectedValue(categoryError) },
    } as unknown as SalesBinderClient;

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow('category source unavailable');

    expect(await cache.getCacheState()).toEqual(initialState);
  });

  it('defaults fresh top-level available stock to resolved on-hand quantity', async () => {
    await cache.setCacheState(cacheState());
    const client = populatedClient(
      sourceItem({ category_id: 'category-1', quantity: 10 }),
      sourceItem({ category_id: 'category-1', quantity: 10 }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        quantity_on_hand: 10,
        quantity_available: 10,
      }),
    ]);
  });

  it('does not publish item watermarks when an effective full sync fails', async () => {
    const initial = cacheState({ lastItemSync: undefined, lastFullItemSync: undefined });
    await cache.setCacheState(initial);
    const list = jest.fn().mockRejectedValue(new Error('source unavailable'));
    const client = {
      items: { list, get: jest.fn() },
      categories: { list: jest.fn().mockResolvedValue({ categories: [], pages: 1 }) },
    } as unknown as SalesBinderClient;
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow('source unavailable');

    expect(await cache.getCacheState()).toEqual(initial);
  });

  it.each([
    [
      'detail item',
      sourceItem({ id: 'wrong-item', category_id: 'category-1' }),
      'Item detail identity mismatch for item-1',
    ],
    [
      'variation parent',
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'wrong-item',
          item_variations_locations: [],
        }],
      }),
      'Variation variation-1 belongs to item wrong-item, not item-1',
    ],
    [
      'variation-location parent',
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [{
            id: 10,
            item_variation_id: 'wrong-variation',
            location_id: 'location-1',
            quantity: 1,
          }],
        }],
      }),
      'Variation location 10 belongs to variation wrong-variation, not variation-1',
    ],
  ])('rejects a mismatched %s identity before publishing item state', async (
    _label,
    detailed,
    expectedError
  ) => {
    const initial = cacheState({ lastItemSync: 100 });
    await cache.setCacheState(initial);
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      detailed,
      categoryList('category-1', 'Brand')
    );

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow(expectedError);

    expect(await cache.getAllItems()).toEqual([]);
    expect(await cache.getCacheState()).toEqual(initial);
  });

  it('does not reuse an old listed category name after detail changes category identity', async () => {
    await cache.setCacheState(cacheState());
    const client = populatedClient(
      sourceItem({
        category_id: 'category-old',
        category: { id: 'category-old', name: 'Old Brand' },
      }),
      sourceItem({
        category_id: 'category-new',
        category: { id: 'category-old', name: 'Stale Detail Brand' },
      }),
      categoryList('category-new', 'New Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: 'category-new',
      category_name: 'New Brand',
    });
  });

  it('prefers the authoritative category map over stale same-id embedded names', async () => {
    await cache.setCacheState(cacheState());
    const client = populatedClient(
      sourceItem({
        category_id: 'category-1',
        category: { id: 'category-1', name: 'Old Brand' },
      }),
      sourceItem({
        category_id: 'category-1',
        category: { id: 'category-1', name: 'Old Brand' },
      }),
      categoryList('category-1', 'Renamed Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: 'category-1',
      category_name: 'Renamed Brand',
    });
    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({ category_name: 'Renamed Brand' }),
    ]);
  });

  it('resolves paginated categories and preserves omitted item and stock enrichment', async () => {
    await cache.setCacheState(cacheState({ schemaVersion: CACHE_SCHEMA_VERSION - 1 }));
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      description: 'Cached description',
      category_id: 'category-1',
      category_name: 'Cached Brand',
      quantity: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 4,
      in_transit: 2,
      valuation: 900,
      imported_at: 77,
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'legacy-stock',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Cached Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 4,
      in_transit: 2,
      valuation: 900,
      imported_at: 77,
      cache_source: 'csv',
    });
    const listed = sourceItem({ category_id: 'category-1', item_variations: undefined });
    const detailed = sourceItem({
      category_id: 'category-1',
      category: undefined,
      quantity: 12,
      item_variations: [{
        id: 'variation-1',
        item_id: 'item-1',
        item_variations_locations: [{
          id: 10,
          item_variation_id: 'variation-1',
          location_id: 'location-1',
          quantity: 12,
        }],
      }],
    });
    Object.assign(detailed, { description: null });
    const categoryList = jest.fn(async ({ page }: { page: number }) => page === 1
      ? {
          categories: [[{
            id: 'other',
            name: 'Other',
            item_count: 0,
            parent_id: null,
            created: '',
            modified: '',
          }]],
          pages: '2',
        }
      : {
          categories: [[{
            id: 'category-1',
            name: 'Resolved Brand',
            item_count: 1,
            parent_id: null,
            created: '',
            modified: '',
          }]],
          pages: '2',
        });
    const client = populatedClient(listed, detailed, categoryList);

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(categoryList).toHaveBeenCalledTimes(2);
    expect(await cache.getItem('item-1')).toMatchObject({
      category_id: 'category-1',
      category_name: 'Resolved Brand',
      description: null,
      quantity: 12,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 4,
      in_transit: 2,
      valuation: 900,
      imported_at: 77,
      cache_source: 'api',
    });
    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: '10',
        location_name: 'Main warehouse',
        category_name: 'Resolved Brand',
        quantity_on_hand: 12,
        quantity_reserved: 3,
        quantity_available: 7,
        quantity_incoming: 4,
        in_transit: 2,
        valuation: 900,
        imported_at: 77,
      }),
    ]);
    expect((await cache.getCacheState())?.schemaVersion).toBe(CACHE_SCHEMA_VERSION - 1);
  });

  it('propagates API-resolved item price, cost, and barcode to compatible stock rows', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      price: 10,
      cost: 5,
      barcode: 'OLD',
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: '10',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      category_name: 'Brand',
      quantity_on_hand: 5,
      quantity_reserved: 0,
      quantity_available: 5,
      quantity_incoming: 0,
      in_transit: 0,
      price: 10,
      cost: 5,
      barcode: 'OLD',
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        price: 25,
        cost: 9,
        barcode: 'NEW',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [{
            id: 10,
            item_variation_id: 'variation-1',
            location_id: 'location-1',
            quantity: 8,
          }],
        }],
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({ price: 25, cost: 9, barcode: 'NEW' }),
    ]);
  });

  it('replaces stale variation rows when the source explicitly clears variations', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      price: 10,
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'legacy-location',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 4,
      in_transit: 2,
      price: 10,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1', item_variations: [] }),
      sourceItem({
        category_id: 'category-1',
        price: 20,
        item_variations: [],
        location: { id: 'current-location', name: 'Current warehouse' },
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        variation_id: null,
        variation_location_id: null,
        location_id: 'current-location',
        location_name: 'Current warehouse',
        imported_at: null,
        price: 20,
      }),
    ]);
  });

  it('merges partial top-level location payloads by nested field presence', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      quantity_reserved: 3,
      price: 10,
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'top-level-stock',
      item_id: 'item-1',
      item_number: 5001,
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      price: 10,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1', item_variations: [] }),
      sourceItem({
        category_id: 'category-1',
        price: 20,
        item_variations: [],
        location: { name: 'Renamed warehouse' },
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: 'top-level-stock',
        location_id: 'location-1',
        location_name: 'Renamed warehouse',
        quantity_reserved: 3,
        imported_at: 77,
        price: 20,
      }),
    ]);

    const clearingClient = populatedClient(
      sourceItem({ category_id: 'category-1', item_variations: [] }),
      sourceItem({
        category_id: 'category-1',
        item_variations: [],
        location: null,
      }),
      categoryList('category-1', 'Brand')
    );
    await new ItemIndexerService(clearingClient, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: 'top-level-stock',
        location_id: null,
        location_name: null,
        imported_at: 77,
      }),
    ]);
  });

  it('applies authoritative top-level fields when variations are omitted and attribution is unique', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      quantity: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'top-level-stock',
      item_id: 'item-1',
      item_number: 5001,
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        quantity: 20,
        quantity_reserved: 5,
        quantity_available: 15,
        location: { name: 'Updated warehouse' },
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: 'top-level-stock',
        location_id: 'location-1',
        location_name: 'Updated warehouse',
        quantity_on_hand: 20,
        quantity_reserved: 5,
        quantity_available: 15,
        imported_at: 77,
      }),
    ]);
  });

  it('retains existing stock rows when item detail omits the location collection', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'api',
    });
    for (const [id, location] of [['stock-a', 'A'], ['stock-b', 'B']] as const) {
      await cache.insertItemStockLocation({
        stock_row_id: id,
        item_id: 'item-1',
        item_number: 5001,
        location_id: location,
        location_name: `Warehouse ${location}`,
        category_name: 'Brand',
        quantity_on_hand: 5,
        quantity_reserved: 1,
        quantity_available: 4,
        quantity_incoming: 0,
        in_transit: 0,
        cache_source: 'api',
      });
    }
    const listed = sourceItem({ category_id: 'category-1', item_variations: undefined });
    const detailed = sourceItem({ category_id: 'category-1', item_variations: undefined });
    delete listed.item_variations;
    delete detailed.item_variations;
    const client = populatedClient(
      listed,
      detailed,
      jest.fn().mockResolvedValue({
        categories: [[{
          id: 'category-1',
          name: 'Brand',
          item_count: 1,
          parent_id: null,
          created: '',
          modified: '',
        }]],
        pages: '1',
      })
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ stock_row_id: 'stock-a', location_name: 'Warehouse A' }),
      expect.objectContaining({ stock_row_id: 'stock-b', location_name: 'Warehouse B' }),
    ]));
    expect(await cache.getStockLocationCount()).toBe(2);
  });

  it.each([
    ['omission preserves it', undefined, '10'],
    ['explicit null clears it', null, null],
  ])('%s for a compatible variation-location identity', async (
    _label,
    sourceLocationId,
    expectedVariationLocationId
  ) => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: '10',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'csv',
    });
    const location: Record<string, unknown> = {
      item_variation_id: 'variation-1',
      location_id: 'location-1',
      quantity: 12,
    };
    if (sourceLocationId !== undefined) location.id = sourceLocationId;
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [location as never],
        }],
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        variation_location_id: expectedVariationLocationId,
        location_name: 'Main warehouse',
      }),
    ]);
  });

  it('uses a unique same-variation row when location identities are omitted', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'stable-stock',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [{
            item_variation_id: 'variation-1',
            location: { name: 'Renamed warehouse' },
            quantity: 12,
          }],
        }],
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: 'stable-stock',
        variation_location_id: '10',
        location_id: 'location-1',
        location_name: 'Renamed warehouse',
        quantity_reserved: 3,
        imported_at: 77,
      }),
    ]);
  });

  it('clears variation location id and name when the nested location is explicitly null', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: '10',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-1',
      location_name: 'Main warehouse',
      category_name: 'Brand',
      quantity_on_hand: 10,
      quantity_reserved: 3,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [{
            item_variation_id: 'variation-1',
            location: null,
            quantity: 12,
          }],
        }],
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: '10',
        variation_location_id: '10',
        location_id: null,
        location_name: null,
        quantity_reserved: 3,
        imported_at: 77,
      }),
    ]);
  });

  it('rejects a mismatched account before item cache or source mutation', async () => {
    const initialState = cacheState({ accountName: 'other-account' });
    await cache.setCacheState(initialState);
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Other account item',
      description: 'Other account description',
      category_id: 'category-1',
      category_name: 'Other account brand',
      quantity_reserved: 9,
      imported_at: 77,
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: 'other-stock',
      item_id: 'item-1',
      item_number: 5001,
      location_id: 'other-location',
      location_name: 'Other warehouse',
      category_name: 'Other account brand',
      quantity_on_hand: 10,
      quantity_reserved: 9,
      quantity_available: 1,
      quantity_incoming: 0,
      in_transit: 0,
      imported_at: 77,
      cache_source: 'csv',
    });
    const list = jest.fn();
    const get = jest.fn();
    const client = { items: { list, get } } as unknown as SalesBinderClient;

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/separate database\/cache.*explicitly clear/i);

    expect(await cache.getItem('item-1')).toMatchObject({
      description: 'Other account description',
      quantity_reserved: 9,
      imported_at: 77,
      category_name: 'Other account brand',
    });
    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        location_id: 'other-location',
        location_name: 'Other warehouse',
        quantity_reserved: 9,
        imported_at: 77,
      }),
    ]);
    expect(await cache.getCacheState()).toEqual(initialState);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects item mutation when populated rows have no ownership state', async () => {
    await cache.insertItem({
      item_id: 'orphan-item',
      name: 'Unknown owner',
    });
    const list = jest.fn();
    const get = jest.fn();
    const client = { items: { list, get } } as unknown as SalesBinderClient;

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/no account ownership metadata.*explicitly clear/i);

    expect(await cache.getItem('orphan-item')).toBeDefined();
    expect(await cache.getCacheState()).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('honors a pre-run identity mismatch after another sync stage updates cache state', async () => {
    await cache.setCacheState(cacheState({ accountName: 'test' }));
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Previous account item',
      description: 'Previous account description',
      category_id: 'category-1',
      category_name: 'Previous account brand',
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1', item_variations: [] }),
      sourceItem({ category_id: 'category-1', item_variations: [] }),
      categoryList('category-1', 'Current Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync(true, false);

    expect(await cache.getItem('item-1')).toMatchObject({
      description: null,
      category_name: 'Current Brand',
      imported_at: null,
    });
  });

  it('does not copy stock enrichment across changed variation and location identities', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'api',
    });
    await cache.insertItemStockLocation({
      stock_row_id: '10',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'old-variation',
      variation_location_id: '10',
      location_id: 'old-location',
      location_name: 'Old warehouse',
      category_name: 'Brand',
      quantity_on_hand: 5,
      quantity_reserved: 4,
      quantity_available: 1,
      quantity_incoming: 3,
      in_transit: 2,
      valuation: 500,
      imported_at: 77,
      cache_source: 'csv',
    });
    const listed = sourceItem({ category_id: 'category-1' });
    const detailed = sourceItem({
      category_id: 'category-1',
      item_variations: [{
        id: 'new-variation',
        item_id: 'item-1',
        item_variations_locations: [{
          id: 10,
          item_variation_id: 'new-variation',
          location_id: 'new-location',
          quantity: 8,
        }],
      }],
    });
    const client = populatedClient(
      listed,
      detailed,
      jest.fn().mockResolvedValue({
        categories: [[{
          id: 'category-1',
          name: 'Brand',
          item_count: 1,
          parent_id: null,
          created: '',
          modified: '',
        }]],
        pages: '1',
      })
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: '10',
        variation_id: 'new-variation',
        location_id: 'new-location',
        location_name: null,
        quantity_on_hand: 8,
        quantity_reserved: 0,
        quantity_available: 8,
        quantity_incoming: 0,
        in_transit: 0,
        valuation: null,
        imported_at: null,
      }),
    ]);
  });

  it('ignores a nested location name when its identity conflicts with location_id', async () => {
    await cache.setCacheState(cacheState());
    await cache.insertItem({
      item_id: 'item-1',
      item_number: 5001,
      name: 'Cached item',
      category_id: 'category-1',
      category_name: 'Brand',
      cache_source: 'csv',
    });
    await cache.insertItemStockLocation({
      stock_row_id: '10',
      item_id: 'item-1',
      item_number: 5001,
      variation_id: 'variation-1',
      variation_location_id: '10',
      location_id: 'location-a',
      location_name: 'Cached A',
      category_name: 'Brand',
      quantity_on_hand: 5,
      quantity_reserved: 4,
      quantity_available: 1,
      quantity_incoming: 3,
      in_transit: 2,
      imported_at: 77,
      cache_source: 'csv',
    });
    const client = populatedClient(
      sourceItem({ category_id: 'category-1' }),
      sourceItem({
        category_id: 'category-1',
        item_variations: [{
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [{
            id: 10,
            item_variation_id: 'variation-1',
            location_id: 'location-a',
            location: { id: 'location-b', name: 'Warehouse B' },
            quantity: 8,
          }],
        }],
      }),
      categoryList('category-1', 'Brand')
    );

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getItemStockLocations('item-1')).toEqual([
      expect.objectContaining({
        stock_row_id: '10',
        location_id: 'location-a',
        location_name: null,
        quantity_on_hand: 8,
        quantity_reserved: 0,
        imported_at: null,
      }),
    ]);
  });

  it('fails without publishing a watermark when a referenced category cannot be resolved', async () => {
    const initial = cacheState({ lastItemSync: 100 });
    await cache.setCacheState(initial);
    const listed = sourceItem({ category_id: 'missing-category' });
    const detailed = sourceItem({ category_id: 'missing-category', category: undefined });
    const client = populatedClient(
      listed,
      detailed,
      jest.fn().mockResolvedValue({ categories: [], pages: '1' })
    );

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow('Unable to resolve category missing-category');

    expect(await cache.getItem('item-1')).toBeUndefined();
    expect(await cache.getCacheState()).toEqual(initial);
  });
});

function fakeClient(
  listImplementation: () => Promise<{ items: []; pages: number }> = async () => ({ items: [], pages: 1 })
): { client: SalesBinderClient; list: jest.Mock } {
  const list = jest.fn(listImplementation);
  return {
    client: {
      items: { list, get: jest.fn() },
      categories: { list: jest.fn().mockResolvedValue({ categories: [], pages: 1 }) },
    } as unknown as SalesBinderClient,
    list,
  };
}

function cacheState(overrides: Partial<CacheState> = {}): CacheState {
  return {
    lastSync: 100,
    lastFullSync: 100,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'test',
    schemaVersion: CACHE_SCHEMA_VERSION,
    lastItemSync: 100,
    ...overrides,
  };
}

function sourceItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    item_number: 5001,
    name: 'API item',
    quantity: 10,
    threshold: 1,
    cost: 5,
    price: 10,
    created: '2026-07-16T00:00:00.000Z',
    modified: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function populatedClient(listed: Item, detailed: Item, categoryList: jest.Mock): SalesBinderClient {
  const list = jest.fn(async ({ page }: { page: number }) => page === 1
    ? { items: [listed], pages: '1' }
    : { items: [], pages: '1' });
  return {
    items: { list, get: jest.fn().mockResolvedValue(detailed) },
    categories: { list: categoryList },
  } as unknown as SalesBinderClient;
}

function categoryList(id: string, name: string): jest.Mock {
  return jest.fn().mockResolvedValue({
    categories: [[{
      id,
      name,
      item_count: 1,
      parent_id: null,
      created: '',
      modified: '',
    }]],
    pages: '1',
  });
}
