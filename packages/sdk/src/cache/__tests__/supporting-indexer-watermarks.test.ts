import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SalesBinderClient } from '../../resources/index.js';
import { AccountIndexerService } from '../account-indexer.service.js';
import { DeletedLogSyncService } from '../deleted-log-sync.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { CACHE_SCHEMA_VERSION, type CacheState } from '../types.js';

describe('supporting indexer watermarks', () => {
  let cache: SQLiteCacheService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `supporting-indexers-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cache = new SQLiteCacheService('test', dbPath, true);
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cache.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.maintenance-lock`, { force: true });
  });

  it('does not let a generic watermark hide a required account backfill', async () => {
    await cache.setCacheState(state({
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      lastSync: 9_000,
      lastAccountSync: 8_000,
    }));
    const list = jest.fn().mockResolvedValue({ customers: [], pages: 1 });
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await new AccountIndexerService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledTimes(2);
    for (const [params] of list.mock.calls) expect(params.modifiedSince).toBe(0);
    expect(await cache.getCacheState()).toMatchObject({
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      lastAccountSync: 2_000,
    });
  });

  it('loads deletion history when no API deletion watermark exists', async () => {
    await cache.setCacheState(state({ lastSync: 9_000, lastDeletedSync: undefined }));
    const list = jest.fn().mockResolvedValue({ deletedlog: [], pages: 1 });
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await new DeletedLogSyncService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledTimes(6);
    for (const [params] of list.mock.calls) expect(params.deletedSince).toBe(0);
    expect(await cache.getCacheState()).toMatchObject({ lastDeletedSync: 2_000 });
  });
});

function state(overrides: Partial<CacheState> = {}): CacheState {
  return {
    lastSync: 100,
    lastFullSync: 100,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'test',
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...overrides,
  };
}
