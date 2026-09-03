import { createHash } from 'node:crypto';
import { ItemIndexerService } from '../item-indexer.service.js';
import type { CacheService } from '../cache.interface.js';
import type { SalesBinderClient } from '../../resources/index.js';
import {
  createInventorySnapshotFingerprint,
  inventorySnapshotFingerprintMatches,
  type InventoryCacheMeta,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import { compareSourceIds } from '../v3-inventory-source-validation.js';

describe('inventory API source correctness', () => {
  const indexer = new ItemIndexerService({} as SalesBinderClient, {} as CacheService, 'test');

  it('preserves observed variation-location balances instead of fabricating zeroes', () => {
    const item = {
      id: 'item-1',
      item_number: 1,
      name: 'Widget',
      quantity: 12,
      threshold: 1,
      cost: 2,
      price: 3,
      created: '2026-01-01',
      modified: '2026-01-02',
      item_variations: [
        {
          id: 'variation-1',
          item_id: 'item-1',
          item_variations_locations: [
            {
              id: 42,
              location_id: 'location-1',
              quantity: 12,
              quantity_reserved: 3,
              quantity_incoming: 5,
              in_transit: 2,
            },
          ],
        },
      ],
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
      id: 'item-2',
      item_number: 2,
      name: 'No variation',
      quantity: 7,
      threshold: 0,
      cost: 2,
      price: 3,
      category_id: 'category-1',
      category_name: 'Hardware',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      archived: true,
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
        lastSync: 1,
        lastFullSync: 1,
        documentCount: 0,
        itemDocumentCount: 0,
        accountName: 'test',
        schemaVersion: 7,
        inventorySourceApiVersion: '3',
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

    expect(cache.setCacheState).toHaveBeenCalledWith(
      expect.objectContaining({
        inventorySourceApiVersion: '2.0',
      })
    );
  });

  it('orders v3 source IDs by UTF-16 code units', () => {
    expect(['ä', 'z', 'Å'].sort(compareSourceIds)).toEqual(['z', 'Å', 'ä']);
  });

  it('creates current inventory fingerprints without locale collation', () => {
    const items: ItemRow[] = [
      { item_id: 'ä', name: 'A umlaut' },
      { item_id: 'z', name: 'Zed' },
      { item_id: 'Å', name: 'A ring' },
    ];
    const stockRows: ItemStockLocationRow[] = [
      stockRow('ä', 'ä'),
      stockRow('z', 'z'),
      stockRow('Å', 'Å'),
    ];
    const legacyMeta = {
      version: 1 as const,
      status: 'complete' as const,
      accountIdentity: 'salesbinder:test',
      startedAt: 1,
      completedAt: 2,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      schemaVersion: 7 as const,
      sourceApiVersion: '3' as const,
      generation: 'generation',
      fingerprint: 'sha256:not-a-match',
    };
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Inventory fingerprints must not depend on locale collation');
    });
    const fingerprints: string[] = [];

    try {
      fingerprints.push(
        createInventorySnapshotFingerprint(
          legacyMeta.accountIdentity,
          legacyMeta.generation,
          items,
          stockRows
        )
      );
      fingerprints.push(
        createInventorySnapshotFingerprint(
          legacyMeta.accountIdentity,
          legacyMeta.generation,
          [...items].reverse(),
          [...stockRows].reverse()
        )
      );
    } finally {
      localeCompare.mockRestore();
    }

    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(inventorySnapshotFingerprintMatches(legacyMeta, items, stockRows)).toBe(false);
  });

  it('verifies bounded legacy locale families across reader locales without enabling v2 fallback', () => {
    const fixture = historicalInventoryFixture();
    const enMeta = historicalInventoryMeta('en-US', fixture);
    const svMeta = historicalInventoryMeta('sv-SE', fixture);
    const daMeta = historicalInventoryMeta('da-DK', fixture);
    const omittedLocationMeta = historicalInventoryMeta('en-US', fixture, true);
    const codeUnitFixture = historicalInventoryFixture(['A', 'a', 'B']);
    const codeUnitMeta = historicalInventoryMeta('code-unit', codeUnitFixture);

    expect(withMockedDefaultLocale('sv-SE', () => matches(enMeta, fixture))).toBe(true);
    expect(withMockedDefaultLocale('en-US', () => matches(svMeta, fixture))).toBe(true);
    expect(withMockedDefaultLocale('en-US', () => matches(daMeta, fixture))).toBe(true);
    expect(withMockedDefaultLocale('sv-SE', () => matches(omittedLocationMeta, fixture))).toBe(
      true
    );
    expect(withMockedDefaultLocale('en-US', () => matches(codeUnitMeta, codeUnitFixture))).toBe(
      true
    );

    const v2Meta = {
      ...enMeta,
      version: 2 as const,
      freshItemCount: fixture.items.length,
      preservedItemCount: 0,
      omittedItemCount: 0,
      warningCount: 0,
      lastCompleteAt: enMeta.completedAt,
    };
    expect(withMockedDefaultLocale('sv-SE', () => matches(v2Meta, fixture))).toBe(false);
    expect(
      withMockedDefaultLocale('sv-SE', () =>
        matches(enMeta, {
          ...fixture,
          items: fixture.items.map((item) =>
            item.item_id === 'z' ? { ...item, name: 'Tampered' } : item
          ),
        })
      )
    ).toBe(false);
  });

  it('rejects non-finite numeric inventory fingerprint fields', () => {
    const fixture = historicalInventoryFixture();
    const itemFields: Array<keyof ItemRow> = [
      'item_number',
      'quantity',
      'quantity_reserved',
      'quantity_available',
      'quantity_incoming',
      'in_transit',
      'threshold',
      'cost',
      'price',
      'valuation',
      'published',
      'archived',
      'modified',
      'imported_at',
    ];
    const stockFields: Array<keyof ItemStockLocationRow> = [
      'item_number',
      'quantity_on_hand',
      'quantity_reserved',
      'quantity_available',
      'quantity_incoming',
      'in_transit',
      'price',
      'cost',
      'valuation',
      'imported_at',
    ];
    const invalidNumbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    itemFields.forEach((field, index) => {
      const items = [
        { ...fixture.items[0], [field]: invalidNumbers[index % invalidNumbers.length] } as ItemRow,
        ...fixture.items.slice(1),
      ];
      expect(() => fingerprint(items, fixture.stockRows)).toThrow(/must be finite/);
    });
    stockFields.forEach((field, index) => {
      const stockRows = [
        {
          ...fixture.stockRows[0],
          [field]: invalidNumbers[index % invalidNumbers.length],
        } as ItemStockLocationRow,
        ...fixture.stockRows.slice(1),
      ];
      expect(() => fingerprint(fixture.items, stockRows)).toThrow(/must be finite/);
    });
  });
});

function stockRow(stockRowId: string, itemId: string): ItemStockLocationRow {
  return {
    stock_row_id: stockRowId,
    item_id: itemId,
    quantity_on_hand: 1,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
  };
}

function historicalInventoryFixture(ids = ['z', 'Å', 'ä']) {
  const historicalItems = ids.map((id) => ({
    item_id: id,
    item_number: 1,
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
    archived: 0 as const,
    created: '2026-01-01',
    modified: 1,
    cache_source: 'api' as const,
    source_api_version: '3' as const,
  }));
  const historicalStockRows = ids.map((id) => ({
    stock_row_id: id,
    item_id: id,
    item_number: 1,
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
  return {
    historicalItems,
    historicalStockRows,
    items: historicalItems.map((item) => ({ ...item, valuation: null, imported_at: null })),
    stockRows: historicalStockRows.map((row) => ({
      ...row,
      variation_id: null,
      variation_location_id: null,
      valuation: null,
      imported_at: null,
    })),
  };
}

type HistoricalInventoryFixture = ReturnType<typeof historicalInventoryFixture>;

function historicalInventoryMeta(
  locale: string | 'code-unit',
  fixture: HistoricalInventoryFixture,
  omitParentLocationId = false
) {
  const compare =
    locale === 'code-unit'
      ? (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1)
      : new Intl.Collator(locale).compare;
  const accountIdentity = 'salesbinder:test';
  const generation = `historical-${locale}`;
  const historicalStockRows = omitParentLocationId
    ? fixture.historicalStockRows.map(({ location_id: _locationId, ...row }) => row)
    : fixture.historicalStockRows;
  const canonical = {
    accountIdentity,
    generation,
    items: [...fixture.historicalItems].sort((left, right) => compare(left.item_id, right.item_id)),
    stockRows: [...historicalStockRows].sort((left, right) =>
      compare(left.stock_row_id, right.stock_row_id)
    ),
  };
  return {
    version: 1 as const,
    status: 'complete' as const,
    accountIdentity,
    startedAt: 1,
    completedAt: 2,
    itemCount: fixture.items.length,
    stockRowCount: fixture.stockRows.length,
    schemaVersion: 7 as const,
    sourceApiVersion: '3' as const,
    generation,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
  };
}

function withMockedDefaultLocale<T>(locale: string, operation: () => T): T {
  const compare = new Intl.Collator(locale).compare;
  const mocked = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    other: string
  ) {
    return compare(String(this), other);
  });
  try {
    return operation();
  } finally {
    mocked.mockRestore();
  }
}

function matches(
  meta: InventoryCacheMeta,
  fixture: Pick<HistoricalInventoryFixture, 'items' | 'stockRows'>
): boolean {
  return inventorySnapshotFingerprintMatches(meta, fixture.items, fixture.stockRows);
}

function fingerprint(items: ItemRow[], stockRows: ItemStockLocationRow[]): string {
  return createInventorySnapshotFingerprint('salesbinder:test', 'generation', items, stockRows);
}
