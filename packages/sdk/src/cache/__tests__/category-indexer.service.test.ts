import type { SalesBinderClient } from '../../resources/index.js';
import { CategoryIndexerService, createCategoryFingerprint } from '../category-indexer.service.js';
import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import type { CategoryCacheRow, CategorySnapshot } from '../types.js';
import { MAX_CATEGORY_COUNT, MAX_CATEGORY_PAGES } from '../types.js';
import { ItemIndexerService } from '../item-indexer.service.js';

const category = (id: string, name = id, parentId: string | null = null) => ({
  id,
  name,
  parent_id: parentId,
  item_count: '1',
  created: '2026-01-01',
  modified: '2026-01-02',
});

const v3Category = (id: string, name = id, parentId: string | null = null) => ({
  ...category(id, name, parentId),
  object: 'item_category' as const,
  inventory_type: 'quantity' as const,
  custom_fields: [],
});

describe('CategoryIndexerService', () => {
  it('validates a complete multi-page snapshot before its sole write', async () => {
    const responses = [
      {
        count: '3',
        page: '1',
        pages: '2',
        categories: [[category('root', 'Root'), category('child', 'Child', 'root')]],
      },
      { count: 3, page: 2, pages: 2, categories: [category('orphan', 'Orphan', 'missing')] },
    ];
    const { service, list, replace } = setup(responses);

    const result = await service.sync();

    expect(list.mock.calls.map(([params]) => params.page)).toEqual([1, 2]);
    expect(list).toHaveBeenNthCalledWith(1, { page: 1 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(result.categoriesProcessed).toBe(3);
    expect(result.snapshot.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category_id: 'child',
          parent_name: 'Root',
          modified: 1767312000,
        }),
        expect.objectContaining({ category_id: 'orphan', parent_name: null }),
      ])
    );
    expect(result.snapshot.meta).toMatchObject({
      count: 3,
      page: 2,
      pages: 2,
      sourceRowCount: 3,
      storedRowCount: 3,
      accountIdentity: 'acme',
      generation: expect.any(String),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it.each([0, 1])('accepts coherent empty snapshots with pages=%s', async (pages) => {
    const { service, replace } = setup([
      { count: '0', page: '1', pages: String(pages), categories: [] },
    ]);

    const result = await service.sync();

    expect(result.categoriesProcessed).toBe(0);
    expect(result.snapshot.meta).toMatchObject({ count: 0, page: 1, pages });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('preserves v3 category fields and records their source version', async () => {
    const list = jest.fn(async () => ({
      count: 1,
      page: 1,
      pages: 1,
      categories: [
        {
          ...v3Category('parts', 'Parts'),
          item_count: 1,
          inventory_type: 'unique' as const,
          custom_fields: [
            {
              id: 'field-1',
              name: 'Bin',
              display_order: 0,
              display_on_inventory_list: true,
              publish_on_documents: false,
            },
          ],
        },
      ],
    }));
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;

    const result = await new CategoryIndexerService(
      { categories: { list } },
      cache,
      'acme',
      '3'
    ).sync();

    expect(result.snapshot.rows[0]).toMatchObject({
      category_id: 'parts',
      inventory_type: 'unique',
      source_api_version: '3',
      custom_fields_json: JSON.stringify([
        {
          id: 'field-1',
          name: 'Bin',
          display_order: 0,
          display_on_inventory_list: true,
          publish_on_documents: false,
        },
      ]),
    });
    expect(result.snapshot.meta.sourceApiVersion).toBe('3');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('emits two ID-free observational v3 passes before one atomic publish', async () => {
    const events: CacheSyncProgress[] = [];
    const list = jest.fn(async () => ({
      count: 1,
      page: 1,
      pages: 1,
      categories: [{ ...v3Category('private-id', 'Private name'), item_count: 1 }],
    }));
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;
    const service = new CategoryIndexerService({ categories: { list } }, cache, 'acme', '3');

    await service.sync({ onProgressEvent: (event) => events.push(event) });

    expect(events.map(({ event }) => event)).toEqual([
      'phase_started',
      'pass_started',
      'page_started',
      'record_processed',
      'page_completed',
      'pass_completed',
      'pass_started',
      'page_started',
      'record_processed',
      'page_completed',
      'pass_completed',
      'phase_completed',
    ]);
    expect(events.filter(({ event }) => event === 'pass_started').map(({ pass }) => pass)).toEqual([
      1, 2,
    ]);
    expect(events.filter(({ event }) => event === 'page_completed')).toEqual([
      expect.objectContaining({
        pass: 1,
        page: 1,
        pagesTotal: 1,
        recordsProcessed: 1,
        recordsTotal: 1,
        indeterminate: false,
      }),
      expect.objectContaining({
        pass: 2,
        page: 1,
        pagesTotal: 1,
        recordsProcessed: 1,
        recordsTotal: 1,
        indeterminate: false,
      }),
    ]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(
      /private-id|Private name|contextId|message|fingerprint|generation/
    );
  });

  it('does not publish a v3 snapshot when equal-count membership changes between stability passes', async () => {
    const events: CacheSyncProgress[] = [];
    const list = jest
      .fn()
      .mockResolvedValueOnce({ count: 1, page: 1, pages: 1, categories: [v3Category('first')] })
      .mockResolvedValueOnce({ count: 1, page: 1, pages: 1, categories: [v3Category('second')] });
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;
    const service = new CategoryIndexerService({ categories: { list } }, cache, 'acme', '3');

    await expect(service.sync({ onProgressEvent: (event) => events.push(event) })).rejects.toThrow(
      /stability verification/i
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
    expect(events.some(({ event }) => event === 'phase_completed')).toBe(false);
  });

  it('uses UTF-16 code-unit ordering for v3 stability fingerprints', async () => {
    const firstPass = [v3Category('ä'), v3Category('z'), v3Category('Å')];
    const list = jest
      .fn()
      .mockResolvedValueOnce({ count: 3, page: 1, pages: 1, categories: firstPass })
      .mockResolvedValueOnce({ count: 3, page: 1, pages: 1, categories: [...firstPass].reverse() });
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;
    const service = new CategoryIndexerService({ categories: { list } }, cache, 'acme', '3');
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Category stability fingerprints must not depend on locale collation');
    });

    try {
      await service.sync();
    } finally {
      localeCompare.mockRestore();
    }

    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong object discriminator', { object: 'category' }],
    ['missing object discriminator', { object: undefined }],
    ['whitespace category ID', { id: ' category ' }],
    ['lone high surrogate category ID', { id: 'category-\ud800' }],
    ['missing parent ID', { parent_id: undefined }],
    ['control-character parent ID', { parent_id: 'parent\u0001bad' }],
    ['lone low surrogate parent ID', { parent_id: 'parent-\udc00' }],
    [
      'overlength custom-field ID',
      {
        custom_fields: [
          {
            id: 'a'.repeat(257),
            name: 'Bin',
            display_order: 0,
            display_on_inventory_list: true,
            publish_on_documents: false,
          },
        ],
      },
    ],
  ])('rejects malformed v3 %s before publishing', async (_name, overrides) => {
    const list = jest.fn(async () => ({
      count: 1,
      page: 1,
      pages: 1,
      categories: [{ ...v3Category('category'), ...overrides }],
    }));
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;
    const service = new CategoryIndexerService(
      { categories: { list } } as unknown as SalesBinderClient,
      cache,
      'acme',
      '3'
    );

    await expect(service.sync()).rejects.toThrow(/Invalid category row/);
    expect(replace).not.toHaveBeenCalled();
  });

  it('accepts valid non-BMP v3 category IDs and text', async () => {
    const source = {
      ...v3Category('category-😀', 'Category 😀'),
      custom_fields: [
        {
          id: 'field-😀',
          name: 'Bin 😀',
          display_order: 0,
          display_on_inventory_list: true,
          publish_on_documents: false,
        },
      ],
    };
    const list = jest.fn(async () => ({
      count: 1,
      page: 1,
      pages: 1,
      categories: [source],
    }));
    const replace = jest.fn(async () => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;

    const result = await new CategoryIndexerService(
      { categories: { list } } as unknown as SalesBinderClient,
      cache,
      'acme-😀',
      '3'
    ).sync();

    expect(result.snapshot.rows[0]).toMatchObject({
      category_id: 'category-😀',
      name: 'Category 😀',
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('keeps v2 category IDs on their legacy normalization path', async () => {
    const { service, replace } = setup([
      {
        count: 1,
        page: 1,
        pages: 1,
        categories: [
          {
            ...category(' category ', 'Category', ' parent '),
            custom_fields: [
              {
                id: ' field ',
                name: 'Bin',
                display_order: 0,
                display_on_inventory_list: true,
                publish_on_documents: false,
              },
            ],
          },
        ],
      },
    ]);

    const result = await service.sync();

    expect(result.snapshot.rows[0]).toMatchObject({
      category_id: 'category',
      parent_id: 'parent',
      custom_fields_json: JSON.stringify([
        {
          id: 'field',
          name: 'Bin',
          display_order: 0,
          display_on_inventory_list: true,
          publish_on_documents: false,
        },
      ]),
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing count', { count: undefined }],
    ['fractional count', { count: '1.5' }],
    ['negative count', { count: -1 }],
    ['unsafe count', { count: Number.MAX_SAFE_INTEGER + 1 }],
    ['excess count', { count: MAX_CATEGORY_COUNT + 1 }],
    ['excess pages', { pages: MAX_CATEGORY_PAGES + 1 }],
    ['wrong page', { page: 2 }],
  ])('rejects %s without writes', async (_name, override) => {
    const { service, replace } = setup([
      { count: 1, page: 1, pages: 1, categories: [category('a')], ...override },
    ]);

    await expect(service.sync()).rejects.toThrow(/Invalid category/);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    ['incoherent zero', { count: 0, page: 1, pages: 2, categories: [] }],
    ['non-zero empty page', { count: 1, page: 1, pages: 1, categories: [] }],
    ['count mismatch', { count: 2, page: 1, pages: 1, categories: [category('a')] }],
    ['duplicate id', { count: 2, page: 1, pages: 1, categories: [category('a'), category('a')] }],
    ['missing id', { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), id: '' }] }],
    ['missing name', { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), name: '' }] }],
    [
      'NUL in name',
      { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), name: 'A\0B' }] },
    ],
    [
      'unpaired surrogate in name',
      { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), name: 'A\ud800B' }] },
    ],
    [
      'invalid item count',
      { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), item_count: '-1' }] },
    ],
    [
      'item count exceeding PostgreSQL INTEGER',
      {
        count: 1,
        page: 1,
        pages: 1,
        categories: [{ ...category('a'), item_count: '2147483648' }],
      },
    ],
    [
      'invalid modified',
      { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), modified: 'not-a-date' }] },
    ],
  ])('rejects %s after full validation and before writes', async (_name, response) => {
    const { service, replace } = setup([response]);

    await expect(service.sync()).rejects.toThrow(/Invalid category/);
    expect(replace).not.toHaveBeenCalled();
  });

  it('preserves the old snapshot when a later page fetch fails', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({ count: 2, page: 1, pages: 2, categories: [category('a')] })
      .mockRejectedValueOnce(new Error('network failure'));
    const replace = jest.fn();
    const service = createService(list, replace);

    await expect(service.sync()).rejects.toThrow('network failure');
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a non-v7 cache state before fetching or writing', async () => {
    const list = jest.fn();
    const replace = jest.fn();
    const client = { categories: { list } } as unknown as SalesBinderClient;
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 5 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;

    await expect(new CategoryIndexerService(client, cache, 'acme').sync()).rejects.toThrow(
      'requires cache state schema version 7'
    );
    expect(list).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects metadata changes between pages without writes', async () => {
    const { service, replace } = setup([
      { count: 2, page: 1, pages: 2, categories: [category('a')] },
      { count: 3, page: 2, pages: 2, categories: [category('b')] },
    ]);

    await expect(service.sync()).rejects.toThrow('count/pages changed');
    expect(replace).not.toHaveBeenCalled();
  });

  it('creates a deterministic, order-independent fingerprint covering rows and metadata', () => {
    const rows = [cacheRow('ä', 'A umlaut'), cacheRow('z', 'Zed'), cacheRow('Å', 'A ring')];
    const meta = fingerprintMeta();
    const fingerprint = createCategoryFingerprint(meta, rows, 7);

    expect(createCategoryFingerprint(meta, [...rows].reverse(), 7)).toBe(fingerprint);
    expect(
      createCategoryFingerprint(
        meta,
        [cacheRow('ä', 'Renamed'), cacheRow('z', 'Zed'), cacheRow('Å', 'A ring')],
        7
      )
    ).not.toBe(fingerprint);
    expect(createCategoryFingerprint({ ...meta, generation: 'next' }, rows, 7)).not.toBe(
      fingerprint
    );
    expect(createCategoryFingerprint({ ...meta, pages: 2 }, rows, 7)).not.toBe(fingerprint);
    expect(createCategoryFingerprint({ ...meta, accountIdentity: 'other' }, rows, 7)).not.toBe(
      fingerprint
    );
    expect(createCategoryFingerprint(meta, rows, 5)).not.toBe(fingerprint);
  });
});

describe('ItemIndexerService category names', () => {
  it('uses canonical snapshot names for known IDs and suppresses unmatched embedded names', async () => {
    const known = await syncItem('known', authoritativeSnapshot([cacheRow('known', 'Canonical')]));
    const unknown = await syncItem(
      'unknown',
      authoritativeSnapshot([cacheRow('known', 'Canonical')])
    );

    expect(known.item.category_name).toBe('Canonical');
    expect(known.stock[0].category_name).toBe('Canonical');
    expect(unknown.item.category_name).toBeNull();
    expect(unknown.stock[0].category_name).toBeNull();
  });

  it('uses embedded category names only without an authoritative snapshot', async () => {
    const result = await syncItem('known', null);

    expect(result.item.category_name).toBe('Embedded');
    expect(result.stock[0].category_name).toBe('Embedded');
  });
});

function setup(responses: unknown[]) {
  const list = jest.fn();
  responses.forEach((response) => list.mockResolvedValueOnce(response));
  const replace = jest.fn(async () => undefined);
  return { service: createService(list, replace), list, replace };
}

function createService(list: jest.Mock, replace: jest.Mock): CategoryIndexerService {
  const client = { categories: { list } } as unknown as SalesBinderClient;
  const cache = {
    getCacheState: jest.fn(async () => ({ schemaVersion: 7 })),
    replaceCategorySnapshot: replace,
  } as unknown as CacheService;
  return new CategoryIndexerService(client, cache, 'acme');
}

function cacheRow(id: string, name: string): CategoryCacheRow {
  return {
    category_id: id,
    name,
    item_count: 1,
    parent_id: null,
    parent_name: null,
    inventory_type: null,
    custom_fields_json: null,
    created: '2026-01-01',
    modified: 1,
    cache_source: 'api',
    source_api_version: '2.0',
    imported_at: 1,
  };
}

function fingerprintMeta() {
  return {
    version: 1 as const,
    status: 'complete' as const,
    accountIdentity: 'acme',
    startedAt: 1,
    completedAt: 2,
    count: 2,
    page: 1,
    pages: 1,
    sourceRowCount: 2,
    storedRowCount: 2,
    schemaVersion: 7 as const,
    sourceApiVersion: '2.0' as const,
    generation: 'fixed',
  };
}

function authoritativeSnapshot(rows: CategoryCacheRow[]): CategorySnapshot {
  const base = fingerprintMeta();
  return {
    rows,
    meta: {
      ...base,
      count: rows.length,
      sourceRowCount: rows.length,
      storedRowCount: rows.length,
      fingerprint: 'sha256:test',
    },
  };
}

async function syncItem(categoryId: string, snapshot: CategorySnapshot | null) {
  const inserted: any[] = [];
  const stocks: any[] = [];
  const item = {
    id: `item-${categoryId}`,
    item_number: 1,
    name: 'Item',
    quantity: 1,
    threshold: 0,
    cost: 1,
    price: 2,
    category_id: categoryId,
    category: { id: categoryId, name: 'Embedded' },
    created: '2026-01-01',
    modified: '2026-01-02',
  };
  const cache = {
    getCacheState: jest.fn(async () => null),
    getCategorySnapshot: jest.fn(async () => snapshot),
    insertItem: jest.fn(async (row) => inserted.push(row)),
    replaceItemStockLocations: jest.fn(async (_id, rows) => stocks.push(...rows)),
    getItemCount: jest.fn(async () => 1),
    getStockLocationCount: jest.fn(async () => 1),
    setCacheState: jest.fn(async () => undefined),
  } as unknown as CacheService;
  const client = {
    items: {
      list: jest.fn(async () => ({ items: [item], pages: 1 })),
      get: jest.fn(async () => item),
    },
  } as unknown as SalesBinderClient;

  await new ItemIndexerService(client, cache, 'test').sync(true);
  return { item: inserted[0], stock: stocks };
}
