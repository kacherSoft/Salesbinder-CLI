import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CacheService, CacheState, SyncResult } from '@salesbinder/sdk';
import {
  markAuthoritativeFullSyncPending,
  markDocumentSnapshotPending,
  publishCompletedCacheState,
  publishCompletedDocumentState,
  requiresAuthoritativeFullSync,
  runCacheSyncStages,
} from './cache.commands.js';

const CURRENT_SCHEMA = 4;
const PENDING_SCHEMA = 0;

function readyState(overrides: Partial<CacheState> = {}): CacheState {
  return {
    lastSync: 100,
    lastFullSync: 100,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'default',
    schemaVersion: CURRENT_SCHEMA,
    lastAccountSync: 100,
    lastDocumentSync: 100,
    lastFullDocumentSync: 100,
    lastDeletedSync: 100,
    lastItemSync: 100,
    lastFullItemSync: 100,
    ...overrides,
  };
}

function fakeCache(initialState: CacheState | null) {
  let state = initialState;
  const cache = {
    getCacheState: jest.fn(async () => state),
    setCacheState: jest.fn(async (next: CacheState) => { state = next; }),
    getDocumentCount: jest.fn(async () => 11),
    getItemDocumentCount: jest.fn(async () => 22),
    getDocumentNonItemLineCount: jest.fn(async () => 3),
    getAccountCount: jest.fn(async (contextId?: number) => (
      contextId === 2 ? 4 : contextId === 10 ? 2 : 6
    )),
    getItemCount: jest.fn(async () => 7),
    getStockLocationCount: jest.fn(async () => 8),
  } as unknown as CacheService;
  return { cache, state: () => state };
}

function successfulDocumentResult(): SyncResult {
  return {
    success: true,
    type: 'full',
    documentsProcessed: 0,
    documentsDeleted: 0,
    lineItemsProcessed: 0,
    nonItemLinesProcessed: 0,
    failedDocuments: 0,
    retryDocumentIds: [],
    duration: '0s',
    syncLookbackSeconds: 0,
  };
}

describe('cache sync orchestration', () => {
  it('keeps an ordinary complete cache incremental', () => {
    expect(requiresAuthoritativeFullSync(
      readyState(),
      'default',
      CURRENT_SCHEMA
    )).toBe(false);
  });

  it.each([
    ['explicit request', readyState(), true],
    ['fresh cache', null, false],
    ['schema mismatch', readyState({ schemaVersion: CURRENT_SCHEMA - 1 }), false],
    ['pending retry', readyState({ fullSyncPending: true }), false],
    ['CSV seed without account watermark', readyState({ lastAccountSync: undefined }), false],
    ['missing full document watermark', readyState({ lastFullDocumentSync: undefined }), false],
    ['missing deletion watermark', readyState({ lastDeletedSync: undefined }), false],
    ['missing full item watermark', readyState({ lastFullItemSync: undefined }), false],
  ] as Array<[string, CacheState | null, boolean]>)(
    'requires an authoritative full run for %s',
    (_label, state, explicit) => {
      expect(requiresAuthoritativeFullSync(
        state,
        'default',
        CURRENT_SCHEMA,
        explicit
      )).toBe(true);
    }
  );

  it('persists pending state before stages and publishes fresh counts only after completion', async () => {
    const fixture = fakeCache(readyState({ schemaVersion: CURRENT_SCHEMA - 1 }));

    await markAuthoritativeFullSyncPending(
      fixture.cache,
      fixture.state(),
      'default',
      PENDING_SCHEMA
    );
    expect(fixture.state()).toMatchObject({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
      documentCount: 11,
      itemDocumentCount: 22,
    });

    const stageState = readyState({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
    });
    await fixture.cache.setCacheState(stageState);
    await publishCompletedCacheState(fixture.cache, 'default', CURRENT_SCHEMA);

    expect(fixture.state()).toMatchObject({
      schemaVersion: CURRENT_SCHEMA,
      documentCount: 11,
      itemDocumentCount: 22,
      nonItemDocumentCount: 3,
      accountCount: 6,
      customerCount: 4,
      supplierCount: 2,
      itemCount: 7,
      stockLocationCount: 8,
    });
    expect(fixture.state()?.fullSyncPending).toBeUndefined();
  });

  it('refuses readiness publication while a required stage watermark is absent', async () => {
    const fixture = fakeCache(readyState({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
      lastDeletedSync: undefined,
    }));

    await expect(publishCompletedCacheState(fixture.cache, 'default', CURRENT_SCHEMA))
      .rejects.toThrow(/lastDeletedSync/);
    expect(fixture.state()).toMatchObject({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
    });
  });

  it('publishes document readiness independently while the whole cache remains pending', async () => {
    const fixture = fakeCache(readyState({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
    }));

    await publishCompletedDocumentState(fixture.cache, 'default', CURRENT_SCHEMA);

    expect(fixture.state()).toMatchObject({
      schemaVersion: PENDING_SCHEMA,
      fullSyncPending: true,
      documentSnapshotVersion: CURRENT_SCHEMA,
    });
  });

  it('validates local options before demoting cache readiness', () => {
    const source = readFileSync(resolve(__dirname, 'cache.commands.ts'), 'utf8');
    const detailValidation = source.indexOf(
      "throw new Error('--detail-rate must be a positive number.')"
    );
    const pendingMutation = source.indexOf('await markAuthoritativeFullSyncPending(');

    expect(detailValidation).toBeGreaterThan(-1);
    expect(pendingMutation).toBeGreaterThan(detailValidation);
  });

  it.each(['account', 'deleted', 'item'] as const)(
    'keeps durable pending state and forces every stage full after a %s-stage failure',
    async (failedStage) => {
      const fixture = fakeCache(readyState());
      await markAuthoritativeFullSyncPending(
        fixture.cache,
        fixture.state(),
        'default',
        PENDING_SCHEMA
      );
      const calls: Array<[string, boolean]> = [];
      const fail = (stage: string) => {
        if (stage === failedStage) throw new Error(`${stage} failed`);
      };

      await expect(runCacheSyncStages({
        syncAccounts: async (full) => {
          calls.push(['account', full]);
          fail('account');
          return { accountsProcessed: 0, customersProcessed: 0, suppliersProcessed: 0 };
        },
        markDocumentsPending: async () => markDocumentSnapshotPending(
          fixture.cache,
          'default'
        ),
        syncDocuments: async (full) => {
          calls.push(['document', full]);
          return successfulDocumentResult();
        },
        syncDeleted: async (full) => {
          calls.push(['deleted', full]);
          fail('deleted');
          return { deletedRecordsProcessed: 0 };
        },
        publishDocumentsReady: async () => publishCompletedDocumentState(
          fixture.cache,
          'default',
          CURRENT_SCHEMA
        ),
        syncItems: async (full) => {
          calls.push(['item', full]);
          fail('item');
          return { itemsProcessed: 0, stockRowsProcessed: 0 };
        },
        publishReady: async () => publishCompletedCacheState(
          fixture.cache,
          'default',
          CURRENT_SCHEMA
        ),
      }, true)).rejects.toThrow(`${failedStage} failed`);

      expect(calls.every(([, full]) => full)).toBe(true);
      expect(fixture.state()).toMatchObject({
        schemaVersion: PENDING_SCHEMA,
        fullSyncPending: true,
      });
      expect(fixture.state()?.documentSnapshotVersion)
        .toBe(
          failedStage === 'item'
            ? CURRENT_SCHEMA
            : failedStage === 'deleted'
              ? 0
              : undefined
        );
      expect(requiresAuthoritativeFullSync(
        fixture.state(),
        'default',
        CURRENT_SCHEMA
      )).toBe(true);
    }
  );

  it('routes every analytics command through the read-before-write cache helper', () => {
    const analyticsCommands = [
      'customers.command.ts',
      'forecast.command.ts',
      'inventory.command.ts',
      'item-sales.command.ts',
      'patterns.command.ts',
      'pricing.command.ts',
      'trends.command.ts',
    ];
    for (const file of analyticsCommands) {
      const source = readFileSync(resolve(__dirname, '..', 'analytics', file), 'utf8');
      expect(source).toContain('prepareAnalyticsCache');
      expect(source).not.toContain('createCacheService(accountName, undefined, !options.cached)');
    }
  });
});
