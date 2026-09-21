import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock(
  '@salesbinder/sdk',
  () => ({
    readPublicCacheSyncAuthority: (cache: unknown, options: unknown) =>
      jest
        .requireActual('../../../../sdk/src/cache/public-sync-authority.js')
        .readPublicCacheSyncAuthority(cache, options),
  }),
  { virtual: true }
);
import type { CacheService } from '@salesbinder/sdk';
import { SQLiteCacheService } from '../../../../sdk/src/cache/sqlite-cache.service.js';
import { createSalesBinderAccountBinding } from '../../../../sdk/src/cache/types.js';
import {
  ensureAnalyticsCacheBinding,
  getAnalyticsSyncDecision,
  resolveAnalyticsStaleThreshold,
} from './analytics-cache-binding.js';

const binding = { accountIdentity: 'salesbinder:acme', accountSubdomain: 'acme' };

function cache(overrides: Partial<CacheService> = {}): CacheService {
  return {
    ensureAccountBinding: jest.fn(async () => undefined),
    verifyAccountBinding: jest.fn(async () => undefined),
    ...overrides,
  } as CacheService;
}

describe('ensureAnalyticsCacheBinding', () => {
  it('ensures the canonical binding before a refresh path', async () => {
    const service = cache();

    await ensureAnalyticsCacheBinding(service, binding);

    expect(service.ensureAccountBinding).toHaveBeenCalledWith(binding);
    expect(service.verifyAccountBinding).not.toHaveBeenCalled();
  });

  it('rejects a mismatched bound cache before refresh writes', async () => {
    const service = cache({
      ensureAccountBinding: jest.fn(async () => {
        throw new Error('SQLite cache database is not bound to salesbinder:acme.');
      }),
    });

    await expect(ensureAnalyticsCacheBinding(service, binding)).rejects.toThrow(
      /not bound to salesbinder:acme/
    );
  });

  it('rejects a mismatched real SQLite binding without changing its payload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'salesbinder-analytics-binding-'));
    const path = join(directory, 'cache.db');
    const owner = new SQLiteCacheService('owner', path);
    await owner.ensureAccountBinding(createSalesBinderAccountBinding('owner'));
    await owner.insertItem({ item_id: 'bound-item', name: 'Bound item' });
    await owner.close();

    const mismatched = new SQLiteCacheService('renamed-alias', path);
    try {
      await expect(
        ensureAnalyticsCacheBinding(
          mismatched,
          createSalesBinderAccountBinding('different-account')
        )
      ).rejects.toThrow(/not bound to salesbinder:different-account/);
      expect(await mismatched.getItem('bound-item')).toBeDefined();
    } finally {
      await mismatched.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('analytics command sync decision', () => {
  const originalStaleThreshold = process.env.SALESBINDER_CACHE_STALE_SECONDS;

  afterEach(() => {
    if (originalStaleThreshold === undefined) delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
    else process.env.SALESBINDER_CACHE_STALE_SECONDS = originalStaleThreshold;
  });

  function decisionInput(overrides: Partial<Parameters<typeof getAnalyticsSyncDecision>[0]> = {}) {
    return {
      cache: cache(),
      forceRefresh: false,
      state: null,
      readLegacyCacheStale: jest.fn(async () => true),
      staleThresholdSeconds: 3600,
      ...overrides,
    };
  }

  it('selects a full sync for an initial uncached legacy cache', async () => {
    await expect(getAnalyticsSyncDecision(decisionInput())).resolves.toEqual({
      shouldSync: true,
      full: true,
    });
  });

  it('does not sync only because a local alias differs from cache state', async () => {
    const state = {
      lastSync: 100,
      lastFullSync: 100,
      documentCount: 1,
      itemDocumentCount: 1,
      accountName: 'old-alias',
      schemaVersion: 8,
    };

    await expect(
      getAnalyticsSyncDecision(
        decisionInput({ state, readLegacyCacheStale: jest.fn(async () => false) })
      )
    ).resolves.toEqual({
      shouldSync: false,
      full: false,
    });
  });

  it('uses healthy official state without reading legacy freshness or syncing', async () => {
    const readLegacyCacheStale = jest.fn(async () => true);
    const official = officialCache('success');

    await expect(
      getAnalyticsSyncDecision(decisionInput({ cache: official, readLegacyCacheStale }))
    ).resolves.toEqual({ shouldSync: false, full: false });
    expect(readLegacyCacheStale).not.toHaveBeenCalled();
  });

  it.each(['failed', 'success_with_warnings'] as const)(
    'requires explicit cached mode for official %s state without reading legacy freshness',
    async (status) => {
      const readLegacyCacheStale = jest.fn(async () => false);
      await expect(
        getAnalyticsSyncDecision(
          decisionInput({ cache: officialCache(status), readLegacyCacheStale })
        )
      ).resolves.toEqual(
        expect.objectContaining({ shouldSync: false, error: expect.stringContaining('--cached') })
      );
      expect(readLegacyCacheStale).not.toHaveBeenCalled();
    }
  );

  it('refuses explicit refresh on an official cache without calling legacy freshness', async () => {
    const readLegacyCacheStale = jest.fn(async () => false);
    await expect(
      getAnalyticsSyncDecision(
        decisionInput({ cache: officialCache('success'), forceRefresh: true, readLegacyCacheStale })
      )
    ).resolves.toEqual(
      expect.objectContaining({ shouldSync: false, error: expect.stringContaining('cache sync-v3') })
    );
    expect(readLegacyCacheStale).not.toHaveBeenCalled();
  });

  it('uses the cache-status environment threshold precedence', () => {
    process.env.SALESBINDER_CACHE_STALE_SECONDS = '0';
    expect(resolveAnalyticsStaleThreshold(7_200)).toBe(0);
    process.env.SALESBINDER_CACHE_STALE_SECONDS = 'invalid';
    expect(resolveAnalyticsStaleThreshold(7_200)).toBe(3600);
    delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
    expect(resolveAnalyticsStaleThreshold(7_200)).toBe(7_200);
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
