jest.mock(
  '@salesbinder/sdk',
  () => ({
    readPublicCacheSyncAuthority: (cache: unknown, options: unknown) =>
      jest.requireActual('../../../../sdk/src/cache/public-sync-authority.js')
        .readPublicCacheSyncAuthority(cache, options),
  }),
  { virtual: true }
);
import type { CacheService, CacheState } from '@salesbinder/sdk';
import {
  assertAnalyticsCacheReadable,
  assertAnalyticsReadOptions,
  isLegacyAnalyticsCacheStale,
  resolveAnalyticsStaleThreshold,
} from './analytics-cache-binding.js';

function cache(overrides: Partial<CacheService> = {}): CacheService {
  return {
    getCacheState: jest.fn(async () => null),
    getSyncStatus: jest.fn(async () => null),
    ...overrides,
  } as CacheService;
}

function freshState(): CacheState {
  return {
    lastSync: Math.floor(Date.now() / 1000), lastFullSync: 100,
    documentCount: 1, itemDocumentCount: 1,
    accountName: 'old-alias', schemaVersion: 8,
  };
}

describe('read-only analytics readiness', () => {
  it('rejects an uninitialized legacy cache with explicit writer guidance', async () => {
    await expect(assertAnalyticsCacheReadable(cache(), {}, 3600))
      .rejects.toThrow(/uninitialized.*read-only.*cache sync/);
  });

  it('rejects stale legacy state rather than syncing', async () => {
    const service = cache({ getCacheState: jest.fn(async () => ({ ...freshState(), lastSync: 1 })) });
    await expect(assertAnalyticsCacheReadable(service, {}, 3600))
      .rejects.toThrow(/stale.*read-only.*cache sync/);
  });

  it.each(['running', 'failed', 'success_with_warnings'] as const)(
    'rejects fresh timestamps when legacy sync is %s', async (status) => {
      const service = cache({
        getCacheState: jest.fn(async () => freshState()),
        getSyncStatus: jest.fn(async () => ({
          status, runId: 'run-1', accountName: 'acme', syncTarget: 'sqlite' as const,
          startedAt: 1, updatedAt: 2,
        })),
      });
      await expect(assertAnalyticsCacheReadable(service, {}, 3600)).rejects.toThrow(status);
    }
  );

  it('accepts a fresh legacy cache regardless of local alias', async () => {
    const service = cache({ getCacheState: jest.fn(async () => freshState()) });
    await expect(assertAnalyticsCacheReadable(service, {}, 3600)).resolves.toBeUndefined();
  });

  it('accepts healthy official state without consulting legacy metadata', async () => {
    const service = officialCache('success');
    await expect(assertAnalyticsCacheReadable(service, {}, 3600)).resolves.toBeUndefined();
    expect(service.getCacheState).not.toHaveBeenCalled();
    expect(service.getSyncStatus).not.toHaveBeenCalled();
  });

  it.each(['failed', 'success_with_warnings'] as const)(
    'requires explicit cached mode for official %s state', async (status) => {
      const service = officialCache(status);
      await expect(assertAnalyticsCacheReadable(service, {}, 3600))
        .rejects.toThrow(/Official V3.*cache sync-v3 --resume.*--cached/);
      expect(service.getCacheState).not.toHaveBeenCalled();
    }
  );

  it('keeps unavailable official state authoritative over legacy metadata', async () => {
    const service = officialCache('success');
    Object.assign(service, { getOfficialV3SyncState: async () => { throw new Error('unreadable'); } });
    await expect(assertAnalyticsCacheReadable(service, {}, 3600))
      .rejects.toThrow(/Official V3 cache is unavailable.*cache sync-v3 --status/);
    expect(service.getCacheState).not.toHaveBeenCalled();
  });

  it('uses cached mode without reading freshness metadata', async () => {
    const service = cache();
    await expect(assertAnalyticsCacheReadable(service, { cached: true }, 3600)).resolves.toBeUndefined();
    expect(service.getCacheState).not.toHaveBeenCalled();
    expect(service.getSyncStatus).not.toHaveBeenCalled();
  });

  it.each([{}, { cached: true }])('rejects refresh before inspecting the cache: %j', async (options) => {
    const service = cache();
    expect(() => assertAnalyticsReadOptions({ ...options, refresh: true }))
      .toThrow(/read-only.*--refresh.*cache sync-v3.*cache sync/);
    await expect(assertAnalyticsCacheReadable(service, { ...options, refresh: true }, 3600))
      .rejects.toThrow(/read-only/);
    expect(service.getCacheState).not.toHaveBeenCalled();
  });

  it('rejects a missing metadata table instead of initializing it', async () => {
    const service = cache({ getCacheState: jest.fn(async () => { throw new Error('no such table: cache_meta'); }) });
    await expect(assertAnalyticsCacheReadable(service, {}, 3600)).rejects.toThrow(/no such table/);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('treats invalid last-sync %s as stale', (lastSync) => {
    expect(isLegacyAnalyticsCacheStale({ ...freshState(), lastSync }, 3600)).toBe(true);
  });

  it('uses the cache-status environment threshold precedence', () => {
    const previous = process.env.SALESBINDER_CACHE_STALE_SECONDS;
    try {
      process.env.SALESBINDER_CACHE_STALE_SECONDS = '0';
      expect(resolveAnalyticsStaleThreshold(7_200)).toBe(0);
      process.env.SALESBINDER_CACHE_STALE_SECONDS = 'invalid';
      expect(resolveAnalyticsStaleThreshold(7_200)).toBe(3600);
      delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
      expect(resolveAnalyticsStaleThreshold(7_200)).toBe(7_200);
    } finally {
      if (previous === undefined) delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
      else process.env.SALESBINDER_CACHE_STALE_SECONDS = previous;
    }
  });
});

function officialCache(status: 'success' | 'failed' | 'success_with_warnings'): CacheService {
  const now = Math.floor(Date.now() / 1000);
  const run = {
    version: 1 as const,
    runId: 'run-1',
    accountIdentity: 'salesbinder:acme',
    entry: { kind: 'cursor' as const, value: 'cursor' },
    status,
    ingestionComplete: true,
    pageCount: 1,
    startedAt: now - 10,
    updatedAt: now,
    ...(status === 'success'
      ? { finishedAt: now }
      : { finishedAt: now, errorCode: 'failed' }),
  };
  const state = {
    version: 1 as const,
    accountIdentity: 'salesbinder:acme',
    resources: ['item'] as const,
    ingestionCursor: 'cursor',
    appliedCursor: status === 'success' ? 'cursor' : 'previous',
    appliedGeneration: 1,
    nextGeneration: 1,
    coverage: 'partial_catch_up' as const,
    updatedAt: now - 1,
  };
  return cache({
    getOfficialV3SyncState: jest.fn(async () => state),
    getOfficialV3SyncRun: jest.fn(async () => run),
    getOfficialV3SyncStatus: jest.fn(async () => ({
      run,
      state: {
        ...state,
        hasIngestionCursor: true,
        hasAppliedCursor: true,
        cursorGap: state.ingestionCursor !== state.appliedCursor,
      },
      tasks: {
        discovered: 1,
        applied: status === 'success' ? 1 : 0,
        failed: status === 'failed' ? 1 : 0,
        pending: status === 'success_with_warnings' ? 1 : 0,
        superseded: 0,
      },
      failures: [],
      coverage: 'partial_catch_up' as const,
    })),
  } as never);
}
