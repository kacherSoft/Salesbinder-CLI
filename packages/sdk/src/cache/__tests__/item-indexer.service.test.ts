import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SalesBinderClient } from '../../resources/index.js';
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
    ['cache is absent', null],
    ['account differs', cacheState({ accountName: 'other', lastItemSync: 1_000 })],
    ['schema differs', cacheState({ schemaVersion: CACHE_SCHEMA_VERSION - 1, lastItemSync: 1_000 })],
    ['item watermark is absent', cacheState({ lastSync: 9_000, lastItemSync: undefined })],
  ] as Array<[string, CacheState | null]>)('uses a full item list when %s', async (_label, initialState) => {
    if (initialState) await cache.setCacheState(initialState);
    const { client, list } = fakeClient();
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    await new ItemIndexerService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ modifiedSince: 0 }));
    expect(await cache.getCacheState()).toMatchObject({
      accountName: 'test',
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastItemSync: 2_000,
      lastFullItemSync: 2_000,
    });
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

  it('does not publish item watermarks when an effective full sync fails', async () => {
    const initial = cacheState({ lastItemSync: undefined, lastFullItemSync: undefined });
    await cache.setCacheState(initial);
    const list = jest.fn().mockRejectedValue(new Error('source unavailable'));
    const client = { items: { list, get: jest.fn() } } as unknown as SalesBinderClient;
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    await expect(new ItemIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow('source unavailable');

    expect(await cache.getCacheState()).toEqual(initial);
  });
});

function fakeClient(
  listImplementation: () => Promise<{ items: []; pages: number }> = async () => ({ items: [], pages: 1 })
): { client: SalesBinderClient; list: jest.Mock } {
  const list = jest.fn(listImplementation);
  return {
    client: { items: { list, get: jest.fn() } } as unknown as SalesBinderClient,
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
