import { prepareAnalyticsCache } from './analytics-cache.js';

const mockCreateCacheService = jest.fn();
const mockSync = jest.fn();
const mockIsCacheStale = jest.fn();

jest.mock('@salesbinder/sdk', () => ({
  createCacheService: mockCreateCacheService,
  DocumentIndexerService: jest.fn().mockImplementation(() => ({
    sync: mockSync,
    isCacheStale: mockIsCacheStale,
  })),
}));

const cache = (state: unknown) => ({
  getCacheState: jest.fn().mockResolvedValue(state),
  close: jest.fn().mockResolvedValue(undefined),
});

describe('prepareAnalyticsCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps a fresh analytics cache read-only without competing for the writer lease', async () => {
    const reader = cache({ accountName: 'default' });
    mockCreateCacheService.mockResolvedValue(reader);
    mockIsCacheStale.mockResolvedValue(false);

    const prepared = await prepareAnalyticsCache({ accountName: 'default', client: {} as never });

    expect(prepared.cache).toBe(reader);
    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenCalledWith('default');
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('closes a stale reader before opening the lease-bound writer', async () => {
    const reader = cache({ accountName: 'default' });
    const writer = cache({ accountName: 'default' });
    mockCreateCacheService.mockResolvedValueOnce(reader).mockResolvedValueOnce(writer);
    mockIsCacheStale.mockResolvedValue(true);

    const prepared = await prepareAnalyticsCache({ accountName: 'default', client: {} as never });

    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(mockCreateCacheService).toHaveBeenNthCalledWith(2, 'default', undefined, true);
    expect(mockSync).toHaveBeenCalledWith({ full: undefined });
    expect(prepared.cache).toBe(writer);
  });

  it('opens a writer only after a missing or obsolete reader probe fails', async () => {
    const writer = cache(null);
    mockCreateCacheService.mockRejectedValueOnce(new Error('missing cache')).mockResolvedValueOnce(writer);

    const prepared = await prepareAnalyticsCache({ accountName: 'default', client: {} as never });

    expect(mockCreateCacheService).toHaveBeenNthCalledWith(2, 'default', undefined, true);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(prepared.cache).toBe(writer);
  });

  it('honors cached-only mode without checking freshness or opening a writer', async () => {
    const reader = cache({ accountName: 'default' });
    mockCreateCacheService.mockResolvedValue(reader);

    await prepareAnalyticsCache({ accountName: 'default', client: {} as never, useCachedOnly: true });

    expect(mockCreateCacheService).toHaveBeenCalledTimes(1);
    expect(reader.getCacheState).not.toHaveBeenCalled();
    expect(mockIsCacheStale).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
});
