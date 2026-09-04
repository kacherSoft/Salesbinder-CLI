import type {
  ChangeFeedProgress,
  ChangeFeedRepository,
  ClaimedChangeFeedEvent,
} from '../../change-feed/change-feed.types.js';
import type { InventoryChangeFeedCache } from '../change-feed-cache.interface.js';
import { InventoryChangeFeedSyncService } from '../inventory-change-feed-sync.service.js';
import {
  createInventoryEventReceiptId,
  type InventoryChangeFeedBinding,
  type InventoryChangeFeedState,
  type InventoryEventReceipt,
  type InventoryItemBundleApplication,
  type InventoryTombstoneApplication,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const binding: InventoryChangeFeedBinding = {
  accountIdentity: 'salesbinder:acme',
  ledgerDatabaseId: '11111111-1111-4111-8111-111111111111',
  consumerName: 'salesbinder-cli-inventory-v1',
};

describe('InventoryChangeFeedSyncService', () => {
  it('drains to a fixed target and ignores newer events until the next run', async () => {
    const older = claimed('100', itemId(1));
    const newer = claimed('101', itemId(2));
    const harness = createHarness({
      target: '100',
      claims: [[older], []],
      progress: { observedThroughEventSeq: '101', appliedThroughEventSeq: '100', blockedByEventSeq: null },
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success',
      clean: true,
      targetEventSeq: '100',
      eventsClaimed: 1,
      eventsCompleted: 1,
    });
    expect(harness.ledger.claim).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'ordinary', throughEventSeq: '100' })
    );
    expect(harness.hydrate).toHaveBeenCalledWith([older.objectId], { categoryNames: undefined });
    expect(JSON.stringify(harness.hydrate.mock.calls)).not.toContain(newer.objectId);
  });

  it('rejects claims above the fixed target before cache mutation or ledger completion', async () => {
    const harness = createHarness({
      target: '100',
      claims: [[claimed('101', itemId(1))]],
    });

    await expect(harness.service.sync()).rejects.toThrow('fixed target');

    expect(harness.hydrate).not.toHaveBeenCalled();
    expect(harness.cache.applyInventoryItemBundle).not.toHaveBeenCalled();
    expect(harness.ledger.complete).not.toHaveBeenCalled();
  });

  it('recovers duplicate delivery from existing receipts and completes leases without rehydration', async () => {
    const duplicate = claimed('42', itemId(1));
    const harness = createHarness({
      target: '42',
      claims: [[duplicate], []],
      existingReceipts: [receipt(duplicate, 'upsert', 'found_current', 'upserted')],
      progress: { observedThroughEventSeq: '42', appliedThroughEventSeq: '42', blockedByEventSeq: null },
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success',
      eventsCompleted: 1,
      itemsProcessed: 0,
      stockRowsProcessed: 0,
    });
    expect(harness.hydrate).not.toHaveBeenCalled();
    expect(harness.cache.applyInventoryItemBundle).not.toHaveBeenCalled();
    expect(harness.ledger.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        eventSeq: '42',
        leaseToken: duplicate.leaseToken,
        receipt: expect.objectContaining({ receiptVerified: true }),
      })
    );
  });

  it('continues peer items after an item-local failure and reports deterministic warnings', async () => {
    const invalid = claimed('50', itemId(1));
    const valid = claimed('51', itemId(2));
    const hydrate = jest.fn(
      async (
        _ids: readonly string[],
        _options?: unknown
      ): Promise<V3ExactItemHydrationResult[]> => [
        {
          id: invalid.objectId,
          status: 'local_failure',
          failure: { code: 'invalid_record', message: 'Item failed source validation' },
        },
        found(valid.objectId),
      ]
    );
    const harness = createHarness({
      target: '51',
      claims: [[invalid, valid], []],
      hydrate,
      failStatus: 'dead_letter',
      progress: { observedThroughEventSeq: '51', appliedThroughEventSeq: '51', blockedByEventSeq: null },
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success_with_warnings',
      clean: false,
      eventsCompleted: 1,
      eventsFailed: 1,
      itemsProcessed: 2,
    });
    expect(result.issues).toEqual([
      {
        itemId: invalid.objectId,
        eventSeq: '50',
        code: 'invalid_record',
        message: 'Item failed source validation',
        outcome: 'dead_letter',
      },
    ]);
    expect(harness.cache.applyInventoryItemBundle).toHaveBeenCalledTimes(1);
    expect(harness.ledger.fail).toHaveBeenCalledWith(
      expect.objectContaining({ eventSeq: '50', leaseToken: invalid.leaseToken, retryable: true })
    );
  });

  it('warns when a fixed target remains blocked after all claimable events are handled', async () => {
    const harness = createHarness({
      target: '60',
      claims: [[]],
      progress: { observedThroughEventSeq: '60', appliedThroughEventSeq: '59', blockedByEventSeq: '60' },
    });

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success_with_warnings',
      clean: false,
      eventsClaimed: 0,
      targetEventSeq: '60',
    });
    expect(result.issues).toEqual([
      {
        itemId: null,
        eventSeq: '60',
        code: 'target_not_reached',
        message: 'Fixed inventory change-feed target remains blocked',
        outcome: 'blocked',
      },
    ]);
    expect(harness.progressEvents.map((event) => event.event)).toContain('blocker_observed');
  });

  it('checks the writer lock before cache mutation and before ledger completion', async () => {
    const entry = claimed('70', itemId(1));
    const order: string[] = [];
    const assertWriterLockHeld = jest.fn(async () => {
      order.push('lock');
    });
    const harness = createHarness({
      target: '70',
      claims: [[entry], []],
      assertWriterLockHeld,
      progress: { observedThroughEventSeq: '70', appliedThroughEventSeq: '70', blockedByEventSeq: null },
    });
    harness.cache.applyInventoryItemBundle.mockImplementationOnce(async (application) => {
      order.push('cache');
      return harness.writeReceipts(application, 'upsert', application.hydrationOutcome, 'upserted');
    });
    harness.ledger.complete.mockImplementationOnce(async () => {
      order.push('complete');
      return 'succeeded';
    });

    await harness.service.sync();

    const cacheIndex = order.indexOf('cache');
    const completeIndex = order.indexOf('complete');
    expect(order).toEqual(expect.arrayContaining(['lock', 'cache', 'complete']));
    expect(order.indexOf('lock')).toBeLessThan(cacheIndex);
    expect(order.slice(0, completeIndex).lastIndexOf('lock')).toBeGreaterThan(cacheIndex);
    expect(order.slice(completeIndex + 1)).toContain('lock');
  });

  it('fails closed on lock loss before cache mutation without completing ledger events', async () => {
    const harness = createHarness({
      target: '80',
      claims: [[claimed('80', itemId(1))]],
    });
    const lockLost = new Error('writer lock lost');
    harness.assertWriterLockHeld
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(lockLost);

    await expect(harness.service.sync()).rejects.toBe(lockLost);

    expect(harness.cache.applyInventoryItemBundle).not.toHaveBeenCalled();
    expect(harness.ledger.complete).not.toHaveBeenCalled();
  });

  it('fails closed on lock loss immediately after cache apply without completing ledger events', async () => {
    const entry = claimed('81', itemId(1));
    let cacheApplied = false;
    const lockLost = new Error('writer lock lost after cache apply');
    const assertWriterLockHeld = jest.fn(async () => {
      if (cacheApplied) throw lockLost;
    });
    const harness = createHarness({
      target: '81',
      claims: [[entry]],
      assertWriterLockHeld,
    });
    harness.cache.applyInventoryItemBundle.mockImplementationOnce(async (application) => {
      cacheApplied = true;
      return harness.writeReceipts(application, 'upsert', application.hydrationOutcome, 'upserted');
    });

    await expect(harness.service.sync()).rejects.toBe(lockLost);

    expect(harness.cache.applyInventoryItemBundle).toHaveBeenCalledTimes(1);
    expect(harness.ledger.complete).not.toHaveBeenCalled();
  });

  it('aborts promptly while cache apply is pending and does not complete the ledger event', async () => {
    const controller = new AbortController();
    const pendingCache = deferred<never>();
    const cacheStarted = deferred<void>();
    const harness = createHarness({
      target: '82',
      claims: [[claimed('82', itemId(1))]],
      signal: controller.signal,
    });
    harness.cache.applyInventoryItemBundle.mockImplementationOnce(async () => {
      cacheStarted.resolve();
      return pendingCache.promise;
    });

    const sync = harness.service.sync();
    await cacheStarted.promise;
    controller.abort(new Error('cancelled during cache apply'));

    await expect(sync).rejects.toThrow('cancelled during cache apply');
    expect(harness.ledger.complete).not.toHaveBeenCalled();
  });

  it('fails unsafe terminal transitions when another active lease cannot renew', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const first = claimed('83', itemId(1), 'inventory.item_updated', Date.now() + 60_000);
      const second = claimed('84', itemId(2), 'inventory.item_updated', Date.now() + 60_000);
      const pendingComplete = deferred<never>();
      const completeStarted = deferred<void>();
      const harness = createHarness({
        target: '84',
        claims: [[first, second]],
        leaseSeconds: 1,
      });
      harness.ledger.renewLease.mockRejectedValueOnce(
        new Error('renew failed during terminal transition')
      );
      harness.ledger.complete.mockImplementationOnce(async () => {
        completeStarted.resolve();
        return pendingComplete.promise;
      });

      const sync = harness.service.sync();
      await completeStarted.promise;
      jest.advanceTimersByTime(334);

      await expect(sync).rejects.toThrow('renew failed during terminal transition');
      expect(harness.ledger.complete).toHaveBeenCalledTimes(1);
      expect(harness.ledger.complete).toHaveBeenCalledWith(
        expect.objectContaining({ eventSeq: '83', leaseToken: first.leaseToken })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not count stock rows for receipt-only or fenced-noop applications', async () => {
    const duplicate = claimed('85', itemId(1));
    const fenced = claimed('86', itemId(1));
    const harness = createHarness({
      target: '86',
      claims: [[duplicate, fenced], []],
      existingReceipts: [receipt(duplicate, 'upsert', 'found_current', 'upserted')],
      progress: { observedThroughEventSeq: '86', appliedThroughEventSeq: '86', blockedByEventSeq: null },
    });
    harness.cache.applyInventoryItemBundle.mockImplementationOnce(async (application) => ({
      ...harness.writeReceipts(
        application,
        'fenced_noop',
        application.hydrationOutcome,
        'superseded'
      ),
      materialized: false,
    }));

    const result = await harness.service.sync();

    expect(result).toMatchObject({
      status: 'success',
      eventsCompleted: 2,
      itemsProcessed: 1,
      stockRowsProcessed: 0,
    });
    expect(harness.cache.applyInventoryItemBundle).toHaveBeenCalledTimes(1);
  });

  it('uses replay claims with the accepted sync-run boundary', async () => {
    const entry = claimed('90', itemId(1));
    const harness = createHarness({
      target: '90',
      claims: [[entry], []],
      progress: { observedThroughEventSeq: '90', appliedThroughEventSeq: '90', blockedByEventSeq: null },
    });

    const result = await harness.service.replayWithResult({
      syncRunId: '33333333-3333-4333-8333-333333333333',
      targetEventSeq: '90',
    });

    expect(result.mode).toBe('replay');
    expect(harness.ledger.captureTarget).not.toHaveBeenCalled();
    expect(harness.ledger.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'replay',
        syncRunId: '33333333-3333-4333-8333-333333333333',
      })
    );
  });
});

function createHarness(options: {
  target?: string | null;
  claims?: ClaimedChangeFeedEvent[][];
  progress?: ChangeFeedProgress;
  existingReceipts?: InventoryEventReceipt[];
  hydrate?: jest.Mock<Promise<V3ExactItemHydrationResult[]>, [readonly string[], unknown?]>;
  failStatus?: 'retry' | 'dead_letter';
  assertWriterLockHeld?: jest.Mock<Promise<void>, []>;
  signal?: AbortSignal;
  leaseSeconds?: number;
} = {}) {
  const receiptsBySeq = new Map<string, InventoryEventReceipt>(
    options.existingReceipts?.map((entry) => [entry.eventSeq, entry]) ?? []
  );
  const feedState: InventoryChangeFeedState = {
    ...binding,
    baselineGeneration: 'generation-1',
    observedThroughEventSeq: '0',
    appliedThroughEventSeq: '0',
    highestAppliedEventSeq: '0',
    blockedByEventSeq: null,
    updatedAt: 100,
  };
  const claimQueue = [...(options.claims ?? [])];
  const progressEvents: Array<{ event: string }> = [];
  const assertWriterLockHeld = options.assertWriterLockHeld ?? jest.fn(async () => undefined);
  const ledger = {
    captureTarget: jest.fn(async () => options.target ?? '0'),
    claim: jest.fn(async () => claimQueue.shift() ?? []),
    renewLease: jest.fn(async () => new Date(Date.now() + 60_000)),
    complete: jest.fn(async () => 'succeeded' as const),
    fail: jest.fn(async () => ({
      status: options.failStatus ?? 'retry',
      nextAttemptAt: new Date(Date.now() + 1_000),
    })),
    refreshProgress: jest.fn(async () => options.progress ?? {
      observedThroughEventSeq: options.target ?? '0',
      appliedThroughEventSeq: options.target ?? '0',
      blockedByEventSeq: null,
    }),
  };
  const writeReceipts = (
    application: InventoryItemBundleApplication | InventoryTombstoneApplication,
    appliedAction: InventoryEventReceipt['appliedAction'],
    hydrationOutcome: InventoryEventReceipt['hydrationOutcome'],
    materializationOutcome: InventoryEventReceipt['materializationOutcome']
  ) => {
    const written = application.events.map((entry) => {
      const receiptEntry: InventoryEventReceipt = {
        ...binding,
        receiptId: createInventoryEventReceiptId(binding, entry.eventSeq),
        eventSeq: entry.eventSeq,
        eventType: entry.eventType,
        objectId: entry.objectId,
        appliedAction,
        hydrationOutcome,
        materializationOutcome,
        cacheGeneration: application.cacheGeneration,
        sourceFingerprint: appliedAction === 'upsert' ? 'sha256:bundle' : null,
        committedAt: application.committedAt,
      };
      receiptsBySeq.set(entry.eventSeq, receiptEntry);
      return receiptEntry;
    });
    return { duplicate: false, materialized: true, receipts: written };
  };
  const cache = {
    getInventoryChangeFeedState: jest.fn(async () => feedState),
    updateInventoryChangeFeedState: jest.fn(async (update) => Object.assign(feedState, update)),
    getInventoryEventReceipts: jest.fn(async (_bound: InventoryChangeFeedBinding, seqs: string[]) =>
      seqs.flatMap((seq) => {
        const existing = receiptsBySeq.get(seq);
        return existing ? [existing] : [];
      })
    ),
    applyInventoryItemBundle: jest.fn(async (application: InventoryItemBundleApplication) =>
      writeReceipts(application, 'upsert', application.hydrationOutcome, 'upserted')
    ),
    applyInventoryTombstone: jest.fn(async (application: InventoryTombstoneApplication) =>
      writeReceipts(application, 'tombstone', 'expected_tombstone', 'tombstoned')
    ),
  };
  const hydrate = options.hydrate ?? jest.fn(async (ids: readonly string[]) => ids.map(found));
  const service = new InventoryChangeFeedSyncService({
    binding,
    ledger: ledger as unknown as ChangeFeedRepository,
    cache: cache as unknown as InventoryChangeFeedCache,
    hydrator: { hydrate },
    directItemReader: { items: { get: jest.fn(), listVariations: jest.fn() } },
    signal: options.signal ?? new AbortController().signal,
    assertWriterLockHeld,
    leaseOwner: 'test-owner',
    leaseSeconds: options.leaseSeconds ?? 30,
    claimBatchSize: 10,
    now: () => 200,
    onProgress: (event) => progressEvents.push({ event: event.event }),
  });
  return {
    service,
    ledger,
    cache,
    hydrate,
    progressEvents,
    assertWriterLockHeld,
    writeReceipts,
  };
}

function found(id: string): V3ExactItemHydrationResult {
  return {
    id,
    status: 'found_current',
    bundle: { item: item(id), stockRows: [stock(id)] },
    fingerprint: 'sha256:bundle',
  };
}

function claimed(
  eventSeq: string,
  objectId: string,
  eventType: ClaimedChangeFeedEvent['eventType'] = 'inventory.item_updated',
  leasedUntilMs = Date.now() + 60_000
): ClaimedChangeFeedEvent {
  return {
    eventSeq,
    providerEventId: `evt-${eventSeq}`,
    eventType,
    apiVersion: 'v3',
    objectType: 'inventory',
    objectId,
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    receivedAt: new Date('2026-01-01T00:00:01Z'),
    rawBody: Buffer.from('{}'),
    parsedPayload: {},
    attemptCount: 1,
    leasedUntil: new Date(leasedUntilMs),
    leaseToken: `lease-${eventSeq}`,
  };
}

function receipt(
  entry: ClaimedChangeFeedEvent,
  appliedAction: InventoryEventReceipt['appliedAction'],
  hydrationOutcome: InventoryEventReceipt['hydrationOutcome'],
  materializationOutcome: InventoryEventReceipt['materializationOutcome']
): InventoryEventReceipt {
  return {
    ...binding,
    receiptId: createInventoryEventReceiptId(binding, entry.eventSeq),
    eventSeq: entry.eventSeq,
    eventType: entry.eventType,
    objectId: entry.objectId,
    appliedAction,
    hydrationOutcome,
    materializationOutcome,
    cacheGeneration: 'generation-1',
    sourceFingerprint: appliedAction === 'upsert' ? 'sha256:bundle' : null,
    committedAt: 199,
  };
}

function item(id: string): ItemRow {
  return {
    item_id: id,
    name: `Item ${id.slice(-1)}`,
    archived: 0,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 200,
  };
}

function stock(id: string): ItemStockLocationRow {
  return {
    stock_row_id: `${id}:stock`,
    item_id: id,
    quantity_on_hand: 1,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function itemId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
