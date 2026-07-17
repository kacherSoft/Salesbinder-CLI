import { prepareAnalyticsCache } from './analytics-cache.js';

const mockCreateCacheService = jest.fn();
const mockSync = jest.fn();
const mockIsCacheStale = jest.fn();
const mockGetPostgresReadUrl = jest.fn();
const CURRENT_SCHEMA = 4;
const successfulStatus = {
  status: 'success',
  runId: 'run-success',
  accountName: 'default',
  syncTarget: 'postgresql',
  startedAt: 1,
  updatedAt: 2,
} as const;

jest.mock('@salesbinder/sdk', () => ({
  createCacheService: mockCreateCacheService,
  CACHE_SCHEMA_VERSION: CURRENT_SCHEMA,
  getPostgresReadUrl: mockGetPostgresReadUrl,
  DocumentIndexerService: jest.fn().mockImplementation(() => ({
    sync: mockSync,
    isCacheStale: mockIsCacheStale,
  })),
}));

const cache = (state: unknown) => ({
  getCacheState: jest.fn().mockResolvedValue(state),
  getSyncStatus: jest.fn().mockResolvedValue(null),
  close: jest.fn().mockResolvedValue(undefined),
});

describe('prepareAnalyticsCache', () => {
  beforeEach(() => {
    mockCreateCacheService.mockReset();
    mockSync.mockReset();
    mockIsCacheStale.mockReset();
    mockGetPostgresReadUrl.mockReset();
    mockGetPostgresReadUrl.mockReturnValue(undefined);
    mockSync.mockResolvedValue({
      success: true,
      type: 'delta',
      documentsProcessed: 0,
      lineItemsProcessed: 0,
      nonItemLinesProcessed: 0,
      failedDocuments: 0,
      retryDocumentIds: [],
      duration: '0s',
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps a fresh analytics cache read-only without competing for the writer lease', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    mockCreateCacheService.mockResolvedValue(reader);
    mockIsCacheStale.mockResolvedValue(false);

    const prepared = await prepareAnalyticsCache({ accountName: 'default', client: {} as never });

    expect(prepared.cache).toBe(reader);
    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenCalledWith('default');
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('closes a stale reader before opening the lease-bound writer', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    const writer = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    mockCreateCacheService.mockResolvedValueOnce(reader).mockResolvedValueOnce(writer);
    mockIsCacheStale.mockResolvedValue(true);

    const prepared = await prepareAnalyticsCache({ accountName: 'default', client: {} as never });

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenNthCalledWith(2, 'default', undefined, true);
    expect(mockSync).toHaveBeenCalledWith({
      full: false,
      preserveExistingEnrichment: true,
    });
    expect(prepared.cache).toBe(writer);
  });

  it.each([
    ['stale cache', false, true],
    ['forced refresh', true, false],
  ])(
    'keeps shared PostgreSQL read-only for %s and requires authoritative cache sync',
    async (_label, forceRefresh, stale) => {
      const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
      reader.getSyncStatus.mockResolvedValue(successfulStatus);
      mockCreateCacheService.mockResolvedValue(reader);
      mockGetPostgresReadUrl.mockReturnValue('postgresql://shared-cache');
      mockIsCacheStale.mockResolvedValue(stale);

      await expect(prepareAnalyticsCache({
        accountName: 'default',
        client: {} as never,
        forceRefresh,
      })).rejects.toThrow(/shared PostgreSQL.*whole-cache.*cache sync/i);

      expect(reader.close).toHaveBeenCalledTimes(1);
      expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
      expect(mockSync).not.toHaveBeenCalled();
    }
  );

  it('never opens a shared PostgreSQL writer when the stale probe fails', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    reader.getSyncStatus.mockResolvedValue(successfulStatus);
    mockCreateCacheService.mockResolvedValue(reader);
    mockGetPostgresReadUrl.mockReturnValue('postgresql://shared-cache');
    mockIsCacheStale.mockRejectedValue(new Error('stale probe failed'));

    await expect(prepareAnalyticsCache({
      accountName: 'default',
      client: {} as never,
    })).rejects.toThrow(/shared PostgreSQL.*whole-cache.*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('fails closed when shared PostgreSQL has no successful sync status', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    mockCreateCacheService.mockResolvedValue(reader);
    mockGetPostgresReadUrl.mockReturnValue('postgresql://shared-cache');

    await expect(prepareAnalyticsCache({
      accountName: 'default',
      client: {} as never,
    })).rejects.toThrow(/PostgreSQL.*no successful sync status.*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('fails closed on a fresh obsolete schema and instructs a full cache sync', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA - 1 });
    mockCreateCacheService.mockResolvedValue(reader);
    mockIsCacheStale.mockResolvedValue(false);

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow(/obsolete.*run .*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('fails closed while a whole-cache full sync is pending', async () => {
    const reader = cache({
      accountName: 'default',
      schemaVersion: CURRENT_SCHEMA,
      fullSyncPending: true,
    });
    mockCreateCacheService.mockResolvedValue(reader);

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow(/incomplete full sync.*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed'] as const)(
    'fails closed while cache sync status is %s',
    async (status) => {
      const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
      reader.getSyncStatus.mockResolvedValue({
        status,
        runId: 'run-1',
        accountName: 'default',
        syncTarget: 'sqlite',
        startedAt: 1,
        updatedAt: 1,
      });
      mockCreateCacheService.mockResolvedValue(reader);

      await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
        .rejects.toThrow(new RegExp(`sync is ${status}.*cache sync`, 'i'));

      expect(reader.close).toHaveBeenCalledTimes(1);
      expect(mockIsCacheStale).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    }
  );

  it('fails closed on a current-schema cache with an unfinished document checkpoint', async () => {
    const reader = cache({
      accountName: 'default',
      schemaVersion: CURRENT_SCHEMA,
      documentSyncCheckpoint: {
        accountName: 'default',
        syncType: 'delta',
        phase: 'primary',
        startedAt: 1,
        sourceModifiedSince: 0,
        nextContextIndex: 1,
        nextPage: 2,
        retryDocumentIds: [],
      },
    });
    reader.getSyncStatus.mockResolvedValue({
      status: 'success',
      runId: 'prior-success',
      accountName: 'default',
      syncTarget: 'sqlite',
      startedAt: 1,
      updatedAt: 1,
    });
    mockCreateCacheService.mockResolvedValue(reader);

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow(/incomplete document sync.*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('opens a writer only after a missing or obsolete reader probe fails', async () => {
    mockCreateCacheService.mockRejectedValueOnce(new Error('missing cache'));

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow(/uninitialized.*run .*cache sync/i);

    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('fails closed when cache metadata is uninitialized', async () => {
    const reader = cache(null);
    mockCreateCacheService.mockResolvedValue(reader);

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow(/uninitialized.*run .*cache sync/i);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('closes the writer and rejects an incomplete document sync', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    const writer = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    mockCreateCacheService.mockResolvedValueOnce(reader).mockResolvedValueOnce(writer);
    mockIsCacheStale.mockResolvedValue(true);
    mockSync.mockResolvedValue({
      success: false,
      type: 'delta',
      documentsProcessed: 1,
      lineItemsProcessed: 1,
      nonItemLinesProcessed: 0,
      failedDocuments: 1,
      retryDocumentIds: ['doc-1'],
      duration: '1s',
    });

    await expect(prepareAnalyticsCache({ accountName: 'default', client: {} as never }))
      .rejects.toThrow('Document sync incomplete: 1 document(s) require retry');

    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalledWith('Sync complete');
  });

  it('honors cached-only mode without checking freshness or opening a writer', async () => {
    const reader = cache({ accountName: 'default', schemaVersion: CURRENT_SCHEMA });
    mockCreateCacheService.mockResolvedValue(reader);

    await prepareAnalyticsCache({ accountName: 'default', client: {} as never, useCachedOnly: true });

    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(reader.getCacheState).toHaveBeenCalledTimes(1);
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it.each([
    ['uninitialized', null, /uninitialized.*cache sync/i],
    [
      'obsolete',
      { accountName: 'default', schemaVersion: CURRENT_SCHEMA - 1 },
      /obsolete.*cache sync/i,
    ],
    [
      'wrong account',
      { accountName: 'other', schemaVersion: CURRENT_SCHEMA },
      /belongs to account "other".*separate database\/cache.*explicitly clear/i,
    ],
  ])('rejects %s metadata in cached-only mode', async (_label, state, expectedError) => {
    const reader = cache(state);
    mockCreateCacheService.mockResolvedValue(reader);

    await expect(prepareAnalyticsCache({
      accountName: 'default',
      client: {} as never,
      useCachedOnly: true,
    })).rejects.toThrow(expectedError);

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });
});
