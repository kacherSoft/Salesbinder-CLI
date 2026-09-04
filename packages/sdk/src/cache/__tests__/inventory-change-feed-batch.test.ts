import { AxiosError } from 'axios';
import type { ClaimedChangeFeedEvent } from '../../change-feed/change-feed.types.js';
import type { InventoryChangeFeedCache } from '../change-feed-cache.interface.js';
import {
  coalesceInventoryEvents,
  compareEventSequences,
  type InventoryGroupProcessorDependencies,
  processInventoryGroups,
} from '../inventory-change-feed-batch.js';
import type { InventoryChangeFeedLeaseRenewal } from '../inventory-change-feed-lease-renewal.js';
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

describe('inventory change-feed batch processing', () => {
  it('coalesces object events with BigInt ordering beyond JavaScript safe integers', () => {
    const groups = coalesceInventoryEvents([
      event('9007199254740994', itemId(2)),
      event('9007199254740993', itemId(1), 'inventory.item_created'),
      event('9007199254740995', itemId(1), 'inventory.item_deleted'),
    ]);

    expect(groups.map((group) => group.maxEventSeq)).toEqual([
      '9007199254740994',
      '9007199254740995',
    ]);
    expect(groups[1]?.events.map((entry) => entry.eventSeq)).toEqual([
      '9007199254740993',
      '9007199254740995',
    ]);
    expect(compareEventSequences('9007199254740993', '9007199254740995')).toBe(-1);
  });

  it('hydrates groups in exact-ID chunks of at most 50 and never asks for full inventory lists', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => itemId(index + 1));
    const hydrate = jest.fn(async (requested: readonly string[]) =>
      requested.map((id) => found(id))
    );
    const dependencies = processor({
      hydrator: { hydrate },
    });

    const result = await processInventoryGroups(
      coalesceInventoryEvents(ids.map((id, index) => event(String(index + 1), id))),
      state(),
      renewal(),
      dependencies
    );

    expect(result).toMatchObject({ completed: 51, failed: 0, items: 51 });
    expect(hydrate.mock.calls.map(([requested]) => requested.length)).toEqual([50, 1]);
  });

  it('requires newest delete evidence plus direct V3 404 proof before tombstoning omitted IDs', async () => {
    const id = itemId(1);
    const appliedTombstones: InventoryTombstoneApplication[] = [];
    const completed: ClaimedChangeFeedEvent[] = [];
    const hydrate = jest.fn(async (): Promise<V3ExactItemHydrationResult[]> => [
      { id, status: 'missing_unproven' },
    ]);
    const dependencies = processor({
      hydrator: { hydrate },
      directItemReader: {
        items: {
          get: jest.fn(async () => {
            throw notFound();
          }),
          listVariations: jest.fn(),
        },
      },
      cache: {
        applyInventoryTombstone: jest.fn(async (application) => {
          appliedTombstones.push(application);
          return receipts(application, 'tombstone', 'expected_tombstone', 'tombstoned');
        }),
      },
      complete: jest.fn(async (entry, _receipt) => {
        completed.push(entry);
      }),
    });
    const events = [
      event('12', id, 'inventory.item_deleted'),
      event('10', id, 'inventory.item_created'),
      event('11', id, 'inventory.item_updated'),
    ];

    const result = await processInventoryGroups(
      coalesceInventoryEvents(events),
      state({ highestAppliedEventSeq: '9' }),
      renewal(),
      dependencies
    );

    expect(result).toMatchObject({ completed: 3, failed: 0, highestAppliedEventSeq: '12' });
    expect(appliedTombstones).toHaveLength(1);
    expect(appliedTombstones[0]).toMatchObject({
      objectId: id,
      proof: { deleteEventSeq: '12', confirmation: 'v3_exact_404' },
      expectedHighestAppliedEventSeq: '9',
    });
    expect(appliedTombstones[0]?.events.map((entry) => entry.eventSeq)).toEqual(['10', '11', '12']);
    expect(completed.map((entry) => entry.eventSeq)).toEqual(['10', '11', '12']);
  });

  it('treats omitted create/update IDs as retryable failures instead of tombstones', async () => {
    const id = itemId(1);
    const hydrate = jest.fn(async (): Promise<V3ExactItemHydrationResult[]> => [
      { id, status: 'missing_unproven' },
    ]);
    const dependencies = processor({
      hydrator: { hydrate },
      cache: { applyInventoryTombstone: jest.fn() },
      fail: jest.fn(async () => 'retry' as const),
    });

    const result = await processInventoryGroups(
      coalesceInventoryEvents([event('20', id, 'inventory.item_updated')]),
      state(),
      renewal(),
      dependencies
    );

    expect(result).toMatchObject({ completed: 0, failed: 1 });
    expect(result.issues).toEqual([
      {
        itemId: id,
        eventSeq: '20',
        code: 'missing_unproven',
        message: 'Item was omitted by exact V3 hydration',
        outcome: 'retry',
      },
    ]);
    expect(dependencies.cache.applyInventoryTombstone).not.toHaveBeenCalled();
  });

  it('continues valid items after item-local retry/dead-letter failures', async () => {
    const invalid = itemId(1);
    const valid = itemId(2);
    const hydrate = jest.fn(async (): Promise<V3ExactItemHydrationResult[]> => [
      {
        id: invalid,
        status: 'local_failure',
        failure: { code: 'invalid_record', message: 'Item failed source validation' },
      },
      found(valid),
    ]);
    const dependencies = processor({
      hydrator: { hydrate },
      fail: jest.fn(async () => 'dead_letter' as const),
    });

    const result = await processInventoryGroups(
      coalesceInventoryEvents([
        event('30', invalid, 'inventory.item_updated'),
        event('31', valid, 'inventory.low_stock'),
      ]),
      state({ highestAppliedEventSeq: '29' }),
      renewal(),
      dependencies
    );

    expect(result).toMatchObject({
      completed: 1,
      failed: 1,
      items: 2,
      highestAppliedEventSeq: '31',
    });
    expect(result.issues).toEqual([
      {
        itemId: invalid,
        eventSeq: '30',
        code: 'invalid_record',
        message: 'Item failed source validation',
        outcome: 'dead_letter',
      },
    ]);
    expect(dependencies.cache.applyInventoryItemBundle).toHaveBeenCalledTimes(1);
  });
});

function processor(
  overrides: Omit<Partial<InventoryGroupProcessorDependencies>, 'cache'> & {
    cache?: Partial<InventoryChangeFeedCache>;
  } = {}
): InventoryGroupProcessorDependencies {
  const base = baseProcessor();
  return {
    ...base,
    ...overrides,
    cache: { ...base.cache, ...(overrides.cache ?? {}) } as InventoryChangeFeedCache,
  };
}

function baseProcessor(): InventoryGroupProcessorDependencies {
  const cache = {
    applyInventoryItemBundle: jest.fn(async (application: InventoryItemBundleApplication) =>
      receipts(application, 'upsert', application.hydrationOutcome, 'upserted')
    ),
    applyInventoryTombstone: jest.fn(async (application: InventoryTombstoneApplication) =>
      receipts(application, 'tombstone', 'expected_tombstone', 'tombstoned')
    ),
    getInventoryEventReceipts: jest.fn(async (bound: InventoryChangeFeedBinding, seqs: string[]) =>
      seqs.map((seq) => latestReceipt(bound, seq))
    ),
  };
  return {
    binding,
    cache: cache as unknown as InventoryChangeFeedCache,
    hydrator: { hydrate: jest.fn(async (ids: readonly string[]) => ids.map((id) => found(id))) },
    directItemReader: { items: { get: jest.fn(), listVariations: jest.fn() } },
    generation: 'generation-1',
    maxAttempts: 3,
    now: () => 200,
    critical: async <T>(operation: (operationSignal: AbortSignal) => Promise<T>) =>
      operation(new AbortController().signal),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => 'retry' as const),
    onApplied: jest.fn(),
  };
}

function receipts(
  application: InventoryItemBundleApplication | InventoryTombstoneApplication,
  appliedAction: InventoryEventReceipt['appliedAction'],
  hydrationOutcome: InventoryEventReceipt['hydrationOutcome'],
  materializationOutcome: InventoryEventReceipt['materializationOutcome']
) {
  latestReceipts.length = 0;
  latestReceipts.push(
    ...application.events.map((entry) => ({
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
    }))
  );
  return { duplicate: false, materialized: true, receipts: [...latestReceipts] };
}

const latestReceipts: InventoryEventReceipt[] = [];

function latestReceipt(bound: InventoryChangeFeedBinding, eventSeq: string): InventoryEventReceipt {
  const receipt = latestReceipts.find((entry) => entry.eventSeq === eventSeq);
  if (!receipt) throw new Error(`missing fake receipt ${eventSeq}`);
  return { ...receipt, ...bound };
}

function found(id: string): V3ExactItemHydrationResult {
  return {
    id,
    status: 'found_current',
    bundle: { item: item(id), stockRows: [stock(id)] },
    fingerprint: 'sha256:bundle',
  };
}

function state(overrides: Partial<InventoryChangeFeedState> = {}): InventoryChangeFeedState {
  return {
    ...binding,
    baselineGeneration: 'generation-1',
    observedThroughEventSeq: '0',
    appliedThroughEventSeq: '0',
    highestAppliedEventSeq: '0',
    blockedByEventSeq: null,
    updatedAt: 100,
    ...overrides,
  };
}

function renewal(): InventoryChangeFeedLeaseRenewal {
  return { checkpoint: jest.fn(async () => undefined) } as unknown as InventoryChangeFeedLeaseRenewal;
}

function event(
  eventSeq: string,
  objectId: string,
  eventType: ClaimedChangeFeedEvent['eventType'] = 'inventory.item_updated'
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
    leasedUntil: new Date(Date.now() + 60_000),
    leaseToken: `lease-${eventSeq}`,
  };
}

function item(id = itemId(1)): ItemRow {
  return {
    item_id: id,
    name: `Item ${id.slice(-1)}`,
    archived: 0,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 200,
  };
}

function stock(itemRowId = itemId(1)): ItemStockLocationRow {
  return {
    stock_row_id: `${itemRowId}:stock`,
    item_id: itemRowId,
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

function notFound(): AxiosError {
  return new AxiosError('not found', undefined, undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    headers: {},
    config: {} as never,
    data: {},
  });
}
