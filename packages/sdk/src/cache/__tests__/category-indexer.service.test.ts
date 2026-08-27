import type { SalesBinderClient } from '../../resources/index.js';
import { CategoryIndexerService, createCategoryFingerprint } from '../category-indexer.service.js';
import type { CacheService } from '../cache.interface.js';
import type { CategoryCacheRow, CategorySnapshot } from '../types.js';
import { MAX_CATEGORY_COUNT, MAX_CATEGORY_PAGES } from '../types.js';
import { ItemIndexerService } from '../item-indexer.service.js';

const category = (id: string, name = id, parentId: string | null = null) => ({
  id, name, parent_id: parentId, item_count: '1', created: '2026-01-01', modified: '2026-01-02',
});

describe('CategoryIndexerService', () => {
  it('validates a complete multi-page snapshot before its sole write', async () => {
    const responses = [
      { count: '3', page: '1', pages: '2', categories: [[category('root', 'Root'), category('child', 'Child', 'root')]] },
      { count: 3, page: 2, pages: 2, categories: [category('orphan', 'Orphan', 'missing')] },
    ];
    const { service, list, replace } = setup(responses);

    const result = await service.sync();

    expect(list.mock.calls.map(([params]) => params.page)).toEqual([1, 2]);
    expect(list).toHaveBeenNthCalledWith(1, { page: 1 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(result.categoriesProcessed).toBe(3);
    expect(result.snapshot.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ category_id: 'child', parent_name: 'Root', modified: 1767312000 }),
      expect.objectContaining({ category_id: 'orphan', parent_name: null }),
    ]));
    expect(result.snapshot.meta).toMatchObject({
      count: 3, page: 2, pages: 2, sourceRowCount: 3, storedRowCount: 3,
      accountIdentity: 'acme', generation: expect.any(String),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it.each([0, 1])('accepts coherent empty snapshots with pages=%s', async (pages) => {
    const { service, replace } = setup([{ count: '0', page: '1', pages: String(pages), categories: [] }]);

    const result = await service.sync();

    expect(result.categoriesProcessed).toBe(0);
    expect(result.snapshot.meta).toMatchObject({ count: 0, page: 1, pages });
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
    const { service, replace } = setup([{ count: 1, page: 1, pages: 1, categories: [category('a')], ...override }]);

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
    ['NUL in name', { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), name: 'A\0B' }] }],
    ['invalid item count', { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), item_count: '-1' }] }],
    ['invalid modified', { count: 1, page: 1, pages: 1, categories: [{ ...category('a'), modified: 'not-a-date' }] }],
  ])('rejects %s after full validation and before writes', async (_name, response) => {
    const { service, replace } = setup([response]);

    await expect(service.sync()).rejects.toThrow(/Invalid category/);
    expect(replace).not.toHaveBeenCalled();
  });

  it('preserves the old snapshot when a later page fetch fails', async () => {
    const list = jest.fn()
      .mockResolvedValueOnce({ count: 2, page: 1, pages: 2, categories: [category('a')] })
      .mockRejectedValueOnce(new Error('network failure'));
    const replace = jest.fn();
    const service = createService(list, replace);

    await expect(service.sync()).rejects.toThrow('network failure');
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a non-v6 cache state before fetching or writing', async () => {
    const list = jest.fn();
    const replace = jest.fn();
    const client = { categories: { list } } as unknown as SalesBinderClient;
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: 5 })),
      replaceCategorySnapshot: replace,
    } as unknown as CacheService;

    await expect(new CategoryIndexerService(client, cache, 'acme').sync())
      .rejects.toThrow('requires cache state schema version 6');
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
    const rows = [cacheRow('b', 'B'), cacheRow('a', 'A')];
    const meta = fingerprintMeta();
    const fingerprint = createCategoryFingerprint(meta, rows, 6);

    expect(createCategoryFingerprint(meta, [...rows].reverse(), 6)).toBe(fingerprint);
    expect(createCategoryFingerprint(meta, [cacheRow('b', 'Renamed'), cacheRow('a', 'A')], 6)).not.toBe(fingerprint);
    expect(createCategoryFingerprint({ ...meta, generation: 'next' }, rows, 6)).not.toBe(fingerprint);
    expect(createCategoryFingerprint({ ...meta, pages: 2 }, rows, 6)).not.toBe(fingerprint);
    expect(createCategoryFingerprint({ ...meta, accountIdentity: 'other' }, rows, 6)).not.toBe(fingerprint);
    expect(createCategoryFingerprint(meta, rows, 5)).not.toBe(fingerprint);
  });
});

describe('ItemIndexerService category names', () => {
  it('uses canonical snapshot names for known IDs and suppresses unmatched embedded names', async () => {
    const known = await syncItem('known', authoritativeSnapshot([cacheRow('known', 'Canonical')]));
    const unknown = await syncItem('unknown', authoritativeSnapshot([cacheRow('known', 'Canonical')]));

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
    getCacheState: jest.fn(async () => ({ schemaVersion: 6 })),
    replaceCategorySnapshot: replace,
  } as unknown as CacheService;
  return new CategoryIndexerService(client, cache, 'acme');
}

function cacheRow(id: string, name: string): CategoryCacheRow {
  return {
    category_id: id, name, item_count: 1, parent_id: null, parent_name: null,
    created: '2026-01-01', modified: 1, cache_source: 'api', imported_at: 1,
  };
}

function fingerprintMeta() {
  return {
    version: 1 as const, status: 'complete' as const, accountIdentity: 'acme',
    startedAt: 1, completedAt: 2, count: 2, page: 1, pages: 1,
    sourceRowCount: 2, storedRowCount: 2, schemaVersion: 6 as const, generation: 'fixed',
  };
}

function authoritativeSnapshot(rows: CategoryCacheRow[]): CategorySnapshot {
  const base = fingerprintMeta();
  return { rows, meta: { ...base, count: rows.length, sourceRowCount: rows.length, storedRowCount: rows.length, fingerprint: 'sha256:test' } };
}

async function syncItem(categoryId: string, snapshot: CategorySnapshot | null) {
  const inserted: any[] = [];
  const stocks: any[] = [];
  const item = {
    id: `item-${categoryId}`, item_number: 1, name: 'Item', quantity: 1, threshold: 0,
    cost: 1, price: 2, category_id: categoryId, category: { id: categoryId, name: 'Embedded' },
    created: '2026-01-01', modified: '2026-01-02',
  };
  const cache = {
    getCacheState: jest.fn(async () => null), getCategorySnapshot: jest.fn(async () => snapshot),
    insertItem: jest.fn(async (row) => inserted.push(row)),
    replaceItemStockLocations: jest.fn(async (_id, rows) => stocks.push(...rows)),
    getItemCount: jest.fn(async () => 1), getStockLocationCount: jest.fn(async () => 1),
    setCacheState: jest.fn(async () => undefined),
  } as unknown as CacheService;
  const client = {
    items: { list: jest.fn(async () => ({ items: [item], pages: 1 })), get: jest.fn(async () => item) },
  } as unknown as SalesBinderClient;

  await new ItemIndexerService(client, cache, 'test').sync(true);
  return { item: inserted[0], stock: stocks };
}
