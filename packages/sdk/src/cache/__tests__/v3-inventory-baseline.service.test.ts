import type {
  ActiveChangeFeedSyncRun,
  ChangeFeedContractPreflight,
  ChangeFeedProgress,
  ChangeFeedRepository,
} from '../../change-feed/change-feed.types.js';
import { SALESBINDER_CLI_INVENTORY_CONSUMER } from '../../change-feed/change-feed.constants.js';
import {
  V3InventoryBaselineService,
  type V3InventoryBoundedReplayResult,
} from '../v3-inventory-baseline.service.js';
import { V3InventoryRootDiscovery } from '../v3-inventory-root-discovery.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import {
  CACHE_SCHEMA_VERSION,
  createInventoryBaselineRootFingerprint,
  createInventorySnapshotFingerprint,
  type CacheState,
  type InventoryBaselinePromotion,
  type InventoryBaselinePromotionResult,
  type InventoryBaselineRun,
  type InventoryChangeFeedBinding,
  type InventoryStagedItemBundle,
  type InventoryStagingFailure,
  type InventoryStagingProgress,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';

const binding: InventoryChangeFeedBinding = {
  accountIdentity: 'salesbinder:acme',
  ledgerDatabaseId: '11111111-1111-4111-8111-111111111111',
  consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
};

describe('V3InventoryBaselineService', () => {
  it('captures the start barrier before two root scans and hydrates only after stable membership', async () => {
    const ids = [itemId(1), itemId(2)];
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids });

    await harness.service.sync();

    expect(harness.order).toEqual(
      expect.arrayContaining(['ledger.preflight', 'ledger.beginSyncRun', 'items.list', 'items.getMany'])
    );
    expect(harness.order.indexOf('ledger.preflight')).toBeLessThan(
      harness.order.indexOf('ledger.beginSyncRun')
    );
    expect(harness.order.indexOf('ledger.beginSyncRun')).toBeLessThan(
      harness.order.indexOf('items.list')
    );
    expect(harness.order.filter((entry) => entry === 'items.list')).toHaveLength(2);
    expect(harness.order.lastIndexOf('items.list')).toBeLessThan(
      harness.order.indexOf('items.getMany')
    );
    expect(harness.cache.beginInventoryBaselineRun).toHaveBeenCalledWith(
      expect.objectContaining({ startEventSeq: '40', rootItemIds: ids })
    );
  });

  it('retries root drift with root-only reads and preserves accepted details', async () => {
    const stableIds = [itemId(1), itemId(2)];
    const harness = createHarness({
      rootPages: [[itemId(1), itemId(2)], [itemId(1), itemId(3)], stableIds, stableIds],
      itemIds: stableIds,
      rootRetryDelayMs: 0,
    });

    await harness.service.sync();

    expect(harness.client.items.list).toHaveBeenCalledTimes(4);
    expect(harness.client.items.getMany).toHaveBeenCalledTimes(1);
    expect(harness.client.items.getMany).toHaveBeenCalledWith(stableIds);
    expect(harness.stagedItemIds()).toEqual(stableIds);
  });

  it('hydrates baseline details in exact batches of fifty', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => itemId(index + 1));
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids });

    const result = await harness.service.sync();

    expect(result).toMatchObject({ status: 'success', itemsProcessed: 51, stockRowsProcessed: 51 });
    expect(harness.client.items.getMany.mock.calls.map(([requested]) => requested.length)).toEqual([
      50,
      1,
    ]);
  });

  it('resumes a durable active run by hydrating pending ids only', async () => {
    const ids = [itemId(1), itemId(2), itemId(3)];
    const existing = baselineRun({ rootItemIds: ids });
    const harness = createHarness({
      activeRun: activeRun({ status: 'running', startEventSeq: '40' }),
      existingRuns: [existing],
      itemIds: ids,
      stagedBundles: [stagedBundle(existing, itemId(1))],
    });

    await harness.service.sync();

    expect(harness.client.items.list).not.toHaveBeenCalled();
    expect(harness.client.items.getMany).toHaveBeenCalledWith([itemId(2), itemId(3)]);
    expect(harness.stagedItemIds()).toEqual(ids);
  });

  it('retries unresolved hydration once per invocation and reports cumulative evidence', async () => {
    const ids = [itemId(1)];
    const previousFailure = stagingFailure(baselineRun({ rootItemIds: ids }), ids[0], 4);
    const harness = createHarness({
      rootPages: [ids, ids],
      itemIds: ids,
      omittedItemIds: new Set(ids),
      failures: [previousFailure],
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success_with_warnings',
      baselinePromoted: false,
      ledgerPromoted: false,
    });
    expect(result.warnings).toEqual([
      {
        id: ids[0],
        code: 'not_found',
        message: 'Item unavailable during baseline hydration',
        invocationAttempts: 2,
        totalAttemptCount: 6,
      },
    ]);
    expect(harness.client.items.getMany).toHaveBeenCalledTimes(2);
    expect(harness.cache.promoteInventoryBaselineRun).not.toHaveBeenCalled();
    expect(harness.ledger.verifyBaseline).not.toHaveBeenCalled();
  });

  it('promotes a clean cache receipt, replays the S-to-T interval, and promotes the ledger run', async () => {
    const ids = [itemId(1), itemId(2)];
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids, targetEventSeq: '45' });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success',
      startEventSeq: '40',
      targetEventSeq: '45',
      baselinePromoted: true,
      ledgerPromoted: true,
    });
    expect(harness.ledger.verifyBaseline).toHaveBeenCalledWith('baseline-run-1', {
      receiptId: 'baseline-run-1',
      cacheGeneration: 'generation-1',
      receiptVerified: true,
      coverageComplete: true,
      unresolvedExclusions: [],
    });
    expect(harness.ledger.captureSyncTarget).toHaveBeenCalledWith('baseline-run-1', 5000);
    expect(harness.ledger.coverBaseline).toHaveBeenCalledWith('baseline-run-1');
    expect(harness.replay.replayWithResult).toHaveBeenCalledWith({
      syncRunId: 'baseline-run-1',
      targetEventSeq: '45',
    });
    expect(harness.ledger.promoteSyncRun).toHaveBeenCalledWith('baseline-run-1');
    expect(harness.order.indexOf('cache.promote')).toBeLessThan(
      harness.order.indexOf('ledger.verifyBaseline')
    );
    expect(harness.order.indexOf('ledger.captureSyncTarget')).toBeLessThan(
      harness.order.indexOf('replay.replayWithResult')
    );
  });

  it('returns replay warnings without promoting the ledger run', async () => {
    const ids = [itemId(1)];
    const harness = createHarness({
      rootPages: [ids, ids],
      itemIds: ids,
      targetEventSeq: '50',
      replayResult: {
        status: 'success_with_warnings',
        clean: false,
        targetEventSeq: '50',
        observedThroughEventSeq: '50',
        appliedThroughEventSeq: '49',
        blockedByEventSeq: '50',
        issues: [
          {
            itemId: ids[0],
            eventSeq: '50',
            code: 'blocked',
            message: 'Replay blocked at fixed target',
            outcome: 'blocked',
          },
        ],
      },
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success_with_warnings',
      baselinePromoted: true,
      ledgerPromoted: false,
      targetEventSeq: '50',
    });
    expect(result.replayIssues).toHaveLength(1);
    expect(harness.ledger.promoteSyncRun).not.toHaveBeenCalled();
    expect(harness.ledgerState.promoted).toBe(false);
  });

  it('resumes a fixed target from ledger evidence without recapturing or rehydrating', async () => {
    const ids = [itemId(1)];
    const promoted = baselineRun({ rootItemIds: ids, status: 'promoted', promotedAt: 200 });
    const harness = createHarness({
      activeRun: activeRun({
        status: 'replaying',
        startEventSeq: '40',
        cutoverTargetEventSeq: '55',
        baselineReceiptId: promoted.runId,
        baselineCacheGeneration: promoted.generation,
      }),
      existingRuns: [promoted],
      itemIds: ids,
      stagedBundles: [stagedBundle(promoted, ids[0])],
      targetEventSeq: '99',
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({ status: 'success', targetEventSeq: '55' });
    expect(harness.client.items.list).not.toHaveBeenCalled();
    expect(harness.client.items.getMany).not.toHaveBeenCalled();
    expect(harness.ledger.captureSyncTarget).not.toHaveBeenCalled();
    expect(harness.replay.replayWithResult).toHaveBeenCalledWith({
      syncRunId: promoted.runId,
      targetEventSeq: '55',
    });
  });

  it('fails closed when cache recovery state mismatches the active ledger run', async () => {
    const ids = [itemId(1)];
    const harness = createHarness({
      activeRun: activeRun({ status: 'running', startEventSeq: '40' }),
      existingRuns: [baselineRun({ rootItemIds: ids, startEventSeq: '39' })],
      itemIds: ids,
    });

    await expect(harness.service.sync()).rejects.toThrow(
      'Inventory baseline recovery state does not match the active ledger run'
    );
    expect(harness.client.items.getMany).not.toHaveBeenCalled();
    expect(harness.cache.promoteInventoryBaselineRun).not.toHaveBeenCalled();
  });

  it('fails closed when replaying ledger evidence conflicts with the promoted cache receipt', async () => {
    const ids = [itemId(1)];
    const promoted = baselineRun({ rootItemIds: ids, status: 'promoted', promotedAt: 200 });
    const harness = createHarness({
      activeRun: activeRun({
        status: 'replaying',
        startEventSeq: '40',
        cutoverTargetEventSeq: '55',
        baselineReceiptId: promoted.runId,
        baselineCacheGeneration: 'other-generation',
      }),
      existingRuns: [promoted],
      itemIds: ids,
      stagedBundles: [stagedBundle(promoted, ids[0])],
    });

    await expect(harness.service.sync()).rejects.toThrow(
      'Ledger baseline evidence conflicts with the promoted cache receipt'
    );
    expect(harness.ledger.coverBaseline).not.toHaveBeenCalled();
    expect(harness.replay.replayWithResult).not.toHaveBeenCalled();
  });

  it('keeps progress events free of run and item identifiers', async () => {
    const ids = [itemId(1)];
    const harness = createHarness({
      rootPages: [ids, ids],
      itemIds: ids,
      omittedItemIds: new Set(ids),
    });

    await harness.service.sync();

    const progressJson = JSON.stringify(harness.progressEvents);
    expect(progressJson).not.toContain('baseline-run-1');
    expect(progressJson).not.toContain(ids[0]);
    expect(harness.progressEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining(['phase_started', 'checkpoint_saved', 'retry_pass_started'])
    );
  });

  it('fails before root reads when the writer lock is lost at a boundary', async () => {
    const ids = [itemId(1)];
    const lockLost = new Error('writer lock lost before root');
    const assertWriterLockHeld = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(lockLost);
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids, assertWriterLockHeld });

    await expect(harness.service.sync()).rejects.toBe(lockLost);

    expect(harness.client.items.list).not.toHaveBeenCalled();
    expect(harness.client.items.getMany).not.toHaveBeenCalled();
  });

  it('fails after cache promotion before ledger verification when the writer lock is lost', async () => {
    const ids = [itemId(1)];
    let promotionCommitted = false;
    const lockLost = new Error('writer lock lost after promotion');
    const assertWriterLockHeld = jest.fn(async () => {
      if (promotionCommitted) throw lockLost;
    });
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids, assertWriterLockHeld });
    harness.cache.promoteInventoryBaselineRun.mockImplementationOnce(async (promotion) => {
      const result = harness.promote(promotion);
      promotionCommitted = true;
      return result;
    });

    await expect(harness.service.sync()).rejects.toBe(lockLost);

    expect(harness.ledger.verifyBaseline).not.toHaveBeenCalled();
    expect(harness.ledger.captureSyncTarget).not.toHaveBeenCalled();
    expect(harness.replay.replayWithResult).not.toHaveBeenCalled();
  });

  it('aborts before preflight without touching ledger, cache, or source APIs', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before baseline'));
    const ids = [itemId(1)];
    const harness = createHarness({ rootPages: [ids, ids], itemIds: ids, signal: controller.signal });

    await expect(harness.service.sync()).rejects.toThrow('cancelled before baseline');

    expect(harness.ledger.preflight).not.toHaveBeenCalled();
    expect(harness.cache.getCacheState).not.toHaveBeenCalled();
    expect(harness.client.items.list).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  rootPages?: string[][];
  itemIds?: string[];
  activeRun?: ActiveChangeFeedSyncRun | null;
  existingRuns?: InventoryBaselineRun[];
  stagedBundles?: InventoryStagedItemBundle[];
  failures?: InventoryStagingFailure[];
  omittedItemIds?: Set<string>;
  targetEventSeq?: string | null;
  replayResult?: ReplayResult;
  progress?: ChangeFeedProgress;
  rootRetryDelayMs?: number;
  assertWriterLockHeld?: jest.Mock<Promise<void>, []>;
  signal?: AbortSignal;
} = {}) {
  const order: string[] = [];
  const rootPages = [...(options.rootPages ?? [])];
  const knownItemIds = options.itemIds ?? options.rootPages?.flat() ?? [];
  const runs = new Map<string, InventoryBaselineRun>(
    options.existingRuns?.map((run) => [run.runId, { ...run, rootItemIds: [...run.rootItemIds] }]) ??
      []
  );
  const staged = new Map<string, InventoryStagedItemBundle>();
  for (const bundle of options.stagedBundles ?? []) staged.set(bundle.item.item_id, bundle);
  const failures = new Map<string, InventoryStagingFailure>();
  for (const failure of options.failures ?? []) failures.set(failure.itemId, { ...failure });
  const ledgerState = { promoted: false };
  const assertWriterLockHeld = options.assertWriterLockHeld ?? jest.fn(async () => undefined);
  const cacheState: CacheState = {
    lastSync: 0,
    lastFullSync: 0,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'acme',
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
  const preflight: ChangeFeedContractPreflight = {
    contractVersion: 2,
    ledgerDatabaseId: binding.ledgerDatabaseId,
    accountIdentity: binding.accountIdentity,
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    eventTypePrefix: 'inventory.',
    subscribedEventTypes: [
      'inventory.item_created',
      'inventory.item_updated',
      'inventory.low_stock',
      'inventory.item_deleted',
    ],
  };
  const client = {
    items: {
      list: jest.fn(async (): Promise<V3ListResponse<V3Item>> => {
        order.push('items.list');
        return listResponse(rootPages.shift() ?? []);
      }),
      getMany: jest.fn(async (ids: readonly string[]) => {
        order.push('items.getMany');
        return {
          items: ids
            .filter((id) => !options.omittedItemIds?.has(id))
            .map((id) => v3Item(id, knownItemIds.indexOf(id) + 1)),
          omittedIds: ids.filter((id) => options.omittedItemIds?.has(id)),
        };
      }),
      listVariations: jest.fn(
        async (
          _itemId: string,
          params: { page: number; limit: number; include: 'locations' }
        ): Promise<V3ListResponse<V3ItemVariation>> => {
          order.push('items.listVariations');
          return {
            object: 'list',
            url: '/api/v3/items/variations',
            has_more: false,
            data: [],
            pagination: {
              page: params.page,
              per_page: params.limit,
              total_pages: 0,
              total_records: 0,
            },
          };
        }
      ),
    },
  };
  const promote = (promotion: InventoryBaselinePromotion): InventoryBaselinePromotionResult => {
    order.push('cache.promote');
    const run = runs.get(promotion.runId);
    if (!run) throw new Error('Missing fake baseline run');
    const progress = stagingProgress(run);
    if (progress.pendingItemIds.length > 0) {
      throw new Error('Inventory baseline cannot promote incomplete or failed staging.');
    }
    const promoted: InventoryBaselineRun = {
      ...run,
      status: 'promoted',
      promotedAt: run.promotedAt ?? promotion.promotedAt,
      updatedAt: promotion.promotedAt,
    };
    runs.set(promoted.runId, promoted);
    const stagedItems = promoted.rootItemIds.map((id) => staged.get(id)?.item ?? item(id));
    const stockRows = promoted.rootItemIds.map((id) => staged.get(id)?.stockRows[0] ?? stock(id));
    return {
      run: promoted,
      meta: {
        version: 2,
        status: 'complete',
        accountIdentity: binding.accountIdentity,
        startedAt: promoted.startedAt,
        completedAt: promoted.promotedAt ?? promotion.promotedAt,
        itemCount: stagedItems.length,
        stockRowCount: stockRows.length,
        freshItemCount: stagedItems.length,
        preservedItemCount: 0,
        omittedItemCount: 0,
        warningCount: 0,
        lastCompleteAt: promoted.promotedAt ?? promotion.promotedAt,
        schemaVersion: CACHE_SCHEMA_VERSION,
        sourceApiVersion: '3',
        generation: promoted.generation,
        fingerprint: createInventorySnapshotFingerprint(
          binding.accountIdentity,
          promoted.generation,
          stagedItems,
          stockRows
        ),
      },
    };
  };
  const stagingProgress = (run: InventoryBaselineRun): InventoryStagingProgress => {
    const completedItemIds = run.rootItemIds.filter((id) => staged.has(id));
    const pendingItemIds = run.rootItemIds.filter((id) => !staged.has(id));
    return {
      ...binding,
      runId: run.runId,
      expectedItemCount: run.expectedItemCount,
      stagedItemCount: completedItemIds.length,
      failedItemCount: [...failures.values()].filter((failure) => pendingItemIds.includes(failure.itemId))
        .length,
      completedItemIds,
      pendingItemIds,
      failures: [...failures.values()].map((failure) => ({
        itemId: failure.itemId,
        attemptCount: failure.attemptCount,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        updatedAt: failure.updatedAt,
      })),
    };
  };
  const cache = {
    getCacheState: jest.fn(async () => {
      order.push('cache.getCacheState');
      return cacheState;
    }),
    ensureInventoryChangeFeedState: jest.fn(async () => ({
      ...binding,
      baselineGeneration: null,
      observedThroughEventSeq: null,
      appliedThroughEventSeq: null,
      highestAppliedEventSeq: null,
      blockedByEventSeq: null,
      updatedAt: 100,
    })),
    getCategorySnapshot: jest.fn(async () => null),
    beginInventoryBaselineRun: jest.fn(async (run: InventoryBaselineRun) => {
      order.push('cache.beginInventoryBaselineRun');
      runs.set(run.runId, { ...run, rootItemIds: [...run.rootItemIds] });
      return run;
    }),
    getInventoryBaselineRun: jest.fn(async (_bound: InventoryChangeFeedBinding, runId: string) => {
      order.push('cache.getInventoryBaselineRun');
      const run = runs.get(runId);
      return run ? { ...run, rootItemIds: [...run.rootItemIds] } : null;
    }),
    getInventoryStagingProgress: jest.fn(async (_bound: InventoryChangeFeedBinding, runId: string) => {
      const run = runs.get(runId);
      return run ? stagingProgress(run) : null;
    }),
    stageInventoryBaselineItem: jest.fn(async (bundle: InventoryStagedItemBundle) => {
      staged.set(bundle.item.item_id, bundle);
    }),
    recordInventoryStagingFailure: jest.fn(async (failure: InventoryStagingFailure) => {
      failures.set(failure.itemId, { ...failure });
    }),
    promoteInventoryBaselineRun: jest.fn(async (promotion: InventoryBaselinePromotion) =>
      promote(promotion)
    ),
  };
  const ledger = {
    preflight: jest.fn(async () => {
      order.push('ledger.preflight');
      return preflight;
    }),
    getActiveSyncRun: jest.fn(async () => options.activeRun ?? null),
    beginSyncRun: jest.fn(async () => {
      order.push('ledger.beginSyncRun');
      return { syncRunId: 'baseline-run-1', eventSeq: '40' };
    }),
    verifyBaseline: jest.fn(async () => {
      order.push('ledger.verifyBaseline');
    }),
    captureSyncTarget: jest.fn(async () => {
      order.push('ledger.captureSyncTarget');
      return options.targetEventSeq ?? '45';
    }),
    coverBaseline: jest.fn(async () => {
      order.push('ledger.coverBaseline');
      return '40';
    }),
    refreshProgress: jest.fn(async () => ({
      observedThroughEventSeq: options.targetEventSeq ?? '45',
      appliedThroughEventSeq: options.targetEventSeq ?? '45',
      blockedByEventSeq: null,
      ...(options.progress ?? {}),
    })),
    promoteSyncRun: jest.fn(async () => {
      order.push('ledger.promoteSyncRun');
      ledgerState.promoted = true;
    }),
  };
  const replay = {
    replayWithResult: jest.fn(async ({ targetEventSeq }: { targetEventSeq: string }) => {
      order.push('replay.replayWithResult');
      const result: V3InventoryBoundedReplayResult = options.replayResult ?? {
        status: 'success',
        clean: true,
        targetEventSeq,
        observedThroughEventSeq: targetEventSeq,
        appliedThroughEventSeq: targetEventSeq,
        blockedByEventSeq: null,
        issues: [],
      };
      return result;
    }),
  };
  const progressEvents: CacheSyncProgress[] = [];
  const service = new V3InventoryBaselineService({
    accountIdentity: binding.accountIdentity,
    client,
    cache: cache as never,
    ledger: ledger as unknown as ChangeFeedRepository,
    replay,
    signal: options.signal ?? new AbortController().signal,
    assertWriterLockHeld,
    now: () => 200,
    createGeneration: () => 'generation-1',
    rootDiscovery:
      options.rootRetryDelayMs === undefined
        ? undefined
        : {
            discover: (rootOptions) =>
              new V3InventoryRootDiscovery(client).discover({
                ...rootOptions,
                retryDelayMs: options.rootRetryDelayMs,
              }),
          },
    onProgressEvent: (event) => progressEvents.push(event),
  });
  return {
    service,
    client,
    cache,
    ledger,
    replay,
    order,
    progressEvents,
    assertWriterLockHeld,
    ledgerState,
    promote,
    stagedItemIds: () => [...staged.keys()].sort(),
  };
}

type ReplayResult = V3InventoryBoundedReplayResult;

function activeRun(overrides: Partial<ActiveChangeFeedSyncRun> = {}): ActiveChangeFeedSyncRun {
  return {
    syncRunId: 'baseline-run-1',
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    runKind: 'initial_full_sync',
    status: 'running',
    accountIdentity: binding.accountIdentity,
    startEventSeq: '40',
    cutoverTargetEventSeq: null,
    baselineReceiptId: null,
    baselineCacheGeneration: null,
    baselineVerifiedAt: null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

function baselineRun(overrides: {
  rootItemIds: string[];
  startEventSeq?: string;
  status?: InventoryBaselineRun['status'];
  promotedAt?: number | null;
}): InventoryBaselineRun {
  return {
    ...binding,
    runId: 'baseline-run-1',
    generation: 'generation-1',
    startEventSeq: overrides.startEventSeq ?? '40',
    rootFingerprint: createInventoryBaselineRootFingerprint(
      binding.accountIdentity,
      overrides.rootItemIds
    ),
    rootItemIds: overrides.rootItemIds,
    expectedItemCount: overrides.rootItemIds.length,
    status: overrides.status ?? 'active',
    startedAt: 100,
    updatedAt: 100,
    promotedAt: overrides.promotedAt ?? null,
    failureCode: null,
  };
}

function stagedBundle(run: InventoryBaselineRun, id: string): InventoryStagedItemBundle {
  return {
    ...binding,
    runId: run.runId,
    item: item(id),
    stockRows: [stock(id)],
    stagedAt: 150,
  };
}

function stagingFailure(
  run: InventoryBaselineRun,
  itemIdValue: string,
  attemptCount: number
): InventoryStagingFailure {
  return {
    ...binding,
    runId: run.runId,
    itemId: itemIdValue,
    attemptCount,
    errorCode: 'not_found',
    errorMessage: 'Item unavailable during baseline hydration',
    updatedAt: 150,
  };
}

function listResponse(ids: string[]): V3ListResponse<V3Item> {
  return {
    object: 'list',
    url: '/api/v3/items',
    has_more: false,
    data: ids.map((id, index) => v3Item(id, index + 1)),
    pagination: {
      page: 1,
      per_page: 100,
      total_pages: ids.length === 0 ? 0 : 1,
      total_records: ids.length,
    },
  };
}

function v3Item(id: string, index: number): V3Item {
  return {
    id,
    object: 'item',
    item_number: index,
    name: `Item ${index}`,
    description: null,
    sku: null,
    barcode: null,
    serial_number: null,
    inventory_type: 'quantity',
    category_id: null,
    category_name: null,
    status_id: 1,
    location_id: null,
    price: '10.00',
    cost: '4.00',
    quantity: 1,
    quantity_reserved: 0,
    quantity_incoming: 0,
    threshold: 0,
    variation_count: 0,
    published: true,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function item(id: string): ItemRow {
  return {
    item_id: id,
    item_number: 1,
    name: `Item ${id.slice(-1)}`,
    description: null,
    sku: null,
    serial_number: null,
    barcode: null,
    category_id: null,
    category_name: null,
    quantity: 1,
    quantity_reserved: 0,
    quantity_available: null,
    quantity_incoming: 0,
    in_transit: null,
    threshold: 0,
    cost: 4,
    price: 10,
    published: 1,
    archived: 0,
    created: '2026-01-01T00:00:00Z',
    modified: 1767225600,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function stock(id: string): ItemStockLocationRow {
  return {
    stock_row_id: `sha256:${id}`,
    item_id: id,
    location_id: null,
    location_name: null,
    quantity_on_hand: 1,
    quantity_reserved: 0,
    quantity_available: null,
    quantity_incoming: 0,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function itemId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
