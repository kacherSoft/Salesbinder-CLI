import type { CacheService, OfficialV3SyncStatusSummary } from '../index.js';
import {
  projectPublicCacheSyncAuthority,
  readPublicCacheSyncAuthority,
} from '../public-sync-authority.js';

function summary(overrides: Partial<OfficialV3SyncStatusSummary> = {}): OfficialV3SyncStatusSummary {
  return {
    run: {
      version: 1,
      runId: 'run-1',
      accountIdentity: 'salesbinder:acme',
      entry: { kind: 'cursor' },
      status: 'success',
      ingestionComplete: true,
      pageCount: 1,
      startedAt: 900,
      updatedAt: 1_000,
      finishedAt: 1_000,
    },
    state: {
      version: 1,
      accountIdentity: 'salesbinder:acme',
      resources: ['item'],
      appliedGeneration: 1,
      nextGeneration: 1,
      coverage: 'partial_catch_up',
      updatedAt: 999,
      hasIngestionCursor: true,
      hasAppliedCursor: true,
      cursorGap: false,
    },
    tasks: { discovered: 1, applied: 1, failed: 0, pending: 0, superseded: 0 },
    failures: [],
    coverage: 'partial_catch_up',
    ...overrides,
  };
}

test('projects a clean official completion from its verified terminal timestamp, not state update time', () => {
  const authority = projectPublicCacheSyncAuthority(summary(), {
    staleThresholdSeconds: 60,
    nowSeconds: 1_030,
  });

  expect(authority).toMatchObject({
    authority: 'official_v3',
    syncHealth: 'healthy',
    freshness: 'FRESH',
    lastAppliedAt: 1_000,
    lastAttemptAt: 1_000,
  });
});

test.each([
  ['failed', { failed: 1, pending: 0 }, false, 'failed'],
  ['success_with_warnings', { failed: 0, pending: 280 }, true, 'incomplete'],
] as const)('does not call failed or incomplete %s state fresh', (status, tasks, cursorGap, health) => {
  const base = summary();
  const authority = projectPublicCacheSyncAuthority(
    summary({
      run: { ...base.run, status, finishedAt: 1_020 },
      state: { ...base.state, cursorGap },
      tasks: { ...base.tasks, ...tasks },
    }),
    { staleThresholdSeconds: 3_600, nowSeconds: 1_030 }
  );

  expect(authority).toMatchObject({ syncHealth: health, freshness: 'STALE', lastAppliedAt: null });
});

test('requires completed ingestion before a raw monitor summary can be healthy', () => {
  const base = summary();
  const authority = projectPublicCacheSyncAuthority(
    summary({ run: { ...base.run, ingestionComplete: false } }),
    { staleThresholdSeconds: 60, nowSeconds: 1_030 }
  );
  expect(authority).toMatchObject({ syncHealth: 'incomplete', freshness: 'STALE' });
});

test('uses legacy only when official state and run are both absent', async () => {
  const service = officialCache(null, null, null);
  await expect(readPublicCacheSyncAuthority(service, { staleThresholdSeconds: 60 })).resolves.toEqual({
    authority: 'legacy',
  });
});

test('fails closed when one official record is missing or status read fails', async () => {
  const partial = officialCache(summary().state, null, null);
  const corrupt = officialCache(summary().state, summary().run, null, new Error('private database error'));

  for (const service of [partial, corrupt]) {
    await expect(readPublicCacheSyncAuthority(service, { staleThresholdSeconds: 60 })).resolves.toMatchObject({
      authority: 'official_v3',
      status: 'unavailable',
      syncHealth: 'unavailable',
      isStale: true,
    });
  }
});

function officialCache(
  state: OfficialV3SyncStatusSummary['state'] | null,
  run: OfficialV3SyncStatusSummary['run'] | null,
  status: OfficialV3SyncStatusSummary | null,
  error?: Error
): CacheService {
  return {
    getOfficialV3SyncState: jest.fn(async () => state),
    getOfficialV3SyncRun: jest.fn(async () => run),
    getOfficialV3SyncStatus: jest.fn(async () => {
      if (error) throw error;
      return status;
    }),
  } as unknown as CacheService;
}
