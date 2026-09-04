import type {
  ActiveChangeFeedSyncRun,
  ChangeFeedContractPreflight,
} from '../../../../sdk/src/change-feed/change-feed.types.js';
import type {
  InventoryCacheMeta,
  InventoryChangeFeedState,
} from '../../../../sdk/src/cache/types.js';
import type { ChangeFeedConfig } from './change-feed-config.js';
import {
  InventorySyncModeError,
  selectInventorySyncMode,
  type InventorySyncModeSelectorInput,
} from './inventory-sync-mode-selector.js';

const CACHE_SCHEMA_VERSION = 8;
const SALESBINDER_CLI_INVENTORY_CONSUMER = 'salesbinder-cli-inventory-v1';
const INVENTORY_CHANGE_FEED_EVENT_TYPES = [
  'inventory.item_created',
  'inventory.item_deleted',
  'inventory.item_updated',
  'inventory.low_stock',
] as const;
const ACCOUNT = 'phuthaitech';
const LEDGER_ID = '01234567-89ab-cdef-0123-456789abcdef';
const BASELINE_GENERATION = 'inventory-generation-1';
const SYNC_RUN_ID = '11111111-1111-4111-8111-111111111111';

jest.mock(
  '@salesbinder/sdk',
  () => ({
    CACHE_SCHEMA_VERSION: 8,
    INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX: 'inventory.',
    INVENTORY_CHANGE_FEED_EVENT_TYPES: [
      'inventory.item_created',
      'inventory.item_deleted',
      'inventory.item_updated',
      'inventory.low_stock',
    ],
    SALESBINDER_CLI_INVENTORY_CONSUMER: 'salesbinder-cli-inventory-v1',
  }),
  { virtual: true }
);

describe('selectInventorySyncMode', () => {
  it('keeps SQLite and PostgreSQL compatibility snapshots for unbound caches without config', () => {
    for (const backend of ['sqlite', 'postgresql'] as const) {
      expect(selectInventorySyncMode(input({ backend, feedConfig: null }))).toEqual({
        kind: 'selected',
        mode: 'compatibility_snapshot',
        runKind: null,
        syncRunId: null,
        baselineGeneration: null,
      });
    }
  });

  it('fails a feed-bound cache with missing config instead of falling back to a snapshot', () => {
    expectFatal(
      selectInventorySyncMode(input({ feedConfig: null, feedBinding: feedState() })),
      'feed_binding_requires_configuration'
    );
  });

  it('requires PostgreSQL, current cache schema, and completed ledger preflight before feed modes', () => {
    expectFatal(
      selectInventorySyncMode(input({ backend: 'sqlite' })),
      'change_feed_requires_postgresql'
    );
    expectFatal(
      selectInventorySyncMode(input({ cacheSchemaVersion: CACHE_SCHEMA_VERSION - 1 })),
      'cache_schema_mismatch'
    );
    expectFatal(selectInventorySyncMode(input({ ledgerPreflight: null })), 'ledger_preflight_required');
  });

  it.each([
    ['contract version', { contractVersion: 1 }, 'ledger_schema_mismatch'],
    ['event type prefix', { eventTypePrefix: 'stock.' }, 'ledger_schema_mismatch'],
    ['missing subscribed type', { subscribedEventTypes: INVENTORY_CHANGE_FEED_EVENT_TYPES.slice(1) }, 'ledger_schema_mismatch'],
    [
      'duplicate subscribed type replacing one required type',
      {
        subscribedEventTypes: [
          INVENTORY_CHANGE_FEED_EVENT_TYPES[0],
          INVENTORY_CHANGE_FEED_EVENT_TYPES[0],
          INVENTORY_CHANGE_FEED_EVENT_TYPES[1],
          INVENTORY_CHANGE_FEED_EVENT_TYPES[2],
        ],
      },
      'ledger_schema_mismatch',
    ],
    [
      'duplicate subscribed type appended to the full set',
      {
        subscribedEventTypes: [
          ...INVENTORY_CHANGE_FEED_EVENT_TYPES,
          INVENTORY_CHANGE_FEED_EVENT_TYPES[0],
        ],
      },
      'ledger_schema_mismatch',
    ],
    ['ledger account', { accountIdentity: 'other-account' }, 'account_binding_mismatch'],
    ['ledger consumer', { consumerName: 'other-consumer' }, 'consumer_binding_mismatch'],
  ])('fails %s preflight mismatch', (_label, overrides, code) => {
    expectFatal(
      selectInventorySyncMode(
        input({
          ledgerPreflight: preflight(overrides as Partial<ChangeFeedContractPreflight>),
        })
      ),
      code
    );
  });

  it('accepts the exact subscription set in any order', () => {
    expect(
      selectInventorySyncMode(
        input({
          ledgerPreflight: preflight({
            subscribedEventTypes: [
              INVENTORY_CHANGE_FEED_EVENT_TYPES[3],
              INVENTORY_CHANGE_FEED_EVENT_TYPES[1],
              INVENTORY_CHANGE_FEED_EVENT_TYPES[0],
              INVENTORY_CHANGE_FEED_EVENT_TYPES[2],
            ],
          }),
        })
      )
    ).toMatchObject({ kind: 'selected', mode: 'baseline_start', runKind: 'initial_full_sync' });
  });

  it('fails cache and config binding mismatches without silent fallback', () => {
    expectFatal(
      selectInventorySyncMode(
        input({ feedBinding: feedState({ accountIdentity: 'other-account' }) })
      ),
      'account_binding_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(
        input({ feedBinding: feedState({ consumerName: 'other-consumer' }) })
      ),
      'consumer_binding_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(
        input({ feedBinding: feedState({ ledgerDatabaseId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }) })
      ),
      'ledger_binding_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(input({ feedConfig: config('other-consumer') })),
      'consumer_binding_mismatch'
    );
  });

  it('starts or resumes baseline and replay work from active ledger runs', () => {
    expect(selectInventorySyncMode(input({ activeRun: activeRun({ status: 'running' }) }))).toEqual({
      kind: 'selected',
      mode: 'baseline_resume',
      runKind: 'initial_full_sync',
      syncRunId: SYNC_RUN_ID,
      baselineGeneration: null,
    });

    expect(
      selectInventorySyncMode(
        input({
          feedBinding: feedState({ baselineGeneration: BASELINE_GENERATION }),
          baseline: baseline(),
          activeRun: activeRun({
            status: 'baseline_succeeded',
            baselineCacheGeneration: BASELINE_GENERATION,
          }),
        })
      )
    ).toEqual({
      kind: 'selected',
      mode: 'replay_resume',
      runKind: 'initial_full_sync',
      syncRunId: SYNC_RUN_ID,
      baselineGeneration: BASELINE_GENERATION,
    });

    expect(
      selectInventorySyncMode(
        input({
          feedBinding: feedState({ baselineGeneration: BASELINE_GENERATION }),
          baseline: baseline(),
          activeRun: activeRun({
            runKind: 'reconciliation',
            status: 'replaying',
            baselineCacheGeneration: BASELINE_GENERATION,
          }),
        })
      )
    ).toMatchObject({
      kind: 'selected',
      mode: 'replay_resume',
      runKind: 'reconciliation',
    });
  });

  it('rejects active runs with incompatible bindings or unverified replay baselines', () => {
    expectFatal(
      selectInventorySyncMode(input({ activeRun: activeRun({ accountIdentity: 'other-account' }) })),
      'account_binding_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(
        input({ activeRun: activeRun({ consumerName: 'other-consumer' as never }) })
      ),
      'consumer_binding_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(input({ activeRun: activeRun({ runKind: 'cutover_replay' }) })),
      'active_run_mismatch'
    );
    expectFatal(
      selectInventorySyncMode(
        input({
          feedBinding: feedState({ baselineGeneration: BASELINE_GENERATION }),
          baseline: baseline({ generation: 'different-generation' }),
          activeRun: activeRun({
            status: 'baseline_succeeded',
            baselineCacheGeneration: BASELINE_GENERATION,
          }),
        })
      ),
      'verified_baseline_mismatch'
    );
  });

  it('chooses initial baseline, verified incremental, and forced reconciliation modes explicitly', () => {
    expect(selectInventorySyncMode(input())).toMatchObject({
      kind: 'selected',
      mode: 'baseline_start',
      runKind: 'initial_full_sync',
    });

    expect(
      selectInventorySyncMode(
        input({
          feedBinding: feedState({ baselineGeneration: BASELINE_GENERATION }),
          baseline: baseline(),
        })
      )
    ).toEqual({
      kind: 'selected',
      mode: 'incremental',
      runKind: null,
      syncRunId: null,
      baselineGeneration: BASELINE_GENERATION,
    });

    expect(selectInventorySyncMode(input({ forceFull: true }))).toEqual({
      kind: 'selected',
      mode: 'baseline_start',
      runKind: 'reconciliation',
      syncRunId: null,
      baselineGeneration: null,
    });
  });

  it.each([
    ['warning baseline', { warningCount: 1, status: 'complete_with_warnings' }],
    ['omitted baseline', { omittedItemCount: 1 }],
    ['preserved baseline', { preservedItemCount: 1 }],
    ['stale last-complete timestamp', { lastCompleteAt: 999 }],
    ['legacy baseline', { version: 1 }],
  ])('does not treat a %s as verified incremental evidence', (_label, baselineOverrides) => {
    expect(
      selectInventorySyncMode(
        input({
          feedBinding: feedState({ baselineGeneration: BASELINE_GENERATION }),
          baseline: baseline(baselineOverrides as Partial<InventoryCacheMeta>),
        })
      )
    ).toMatchObject({ kind: 'selected', mode: 'baseline_start', runKind: 'initial_full_sync' });
  });
});

function input(overrides: Partial<InventorySyncModeSelectorInput> = {}): InventorySyncModeSelectorInput {
  return {
    backend: 'postgresql',
    feedConfig: config(),
    accountIdentity: ACCOUNT,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    feedBinding: null,
    baseline: null,
    ledgerPreflight: preflight(),
    activeRun: null,
    forceFull: false,
    ...overrides,
  };
}

function config(consumerName: string = SALESBINDER_CLI_INVENTORY_CONSUMER): ChangeFeedConfig {
  return {
    databaseUrl: 'postgres://worker:secret@ledger.example/salesbinder',
    consumerName: consumerName as typeof SALESBINDER_CLI_INVENTORY_CONSUMER,
  };
}

function preflight(overrides: Partial<ChangeFeedContractPreflight> = {}): ChangeFeedContractPreflight {
  return {
    contractVersion: 2,
    ledgerDatabaseId: LEDGER_ID,
    accountIdentity: ACCOUNT,
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    eventTypePrefix: 'inventory.',
    subscribedEventTypes: INVENTORY_CHANGE_FEED_EVENT_TYPES,
    ...overrides,
  } as ChangeFeedContractPreflight;
}

function feedState(overrides: Partial<InventoryChangeFeedState> = {}): InventoryChangeFeedState {
  return {
    accountIdentity: ACCOUNT,
    ledgerDatabaseId: LEDGER_ID.toUpperCase(),
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    baselineGeneration: null,
    observedThroughEventSeq: null,
    appliedThroughEventSeq: null,
    highestAppliedEventSeq: null,
    blockedByEventSeq: null,
    updatedAt: 1_000,
    ...overrides,
  };
}

function baseline(overrides: Partial<InventoryCacheMeta> = {}): InventoryCacheMeta {
  return {
    version: 2,
    status: 'complete',
    accountIdentity: ACCOUNT,
    startedAt: 900,
    completedAt: 1_000,
    itemCount: 1,
    stockRowCount: 1,
    schemaVersion: CACHE_SCHEMA_VERSION,
    sourceApiVersion: '3',
    generation: BASELINE_GENERATION,
    fingerprint: 'fingerprint',
    freshItemCount: 1,
    preservedItemCount: 0,
    omittedItemCount: 0,
    warningCount: 0,
    lastCompleteAt: 1_000,
    ...overrides,
  } as InventoryCacheMeta;
}

function activeRun(overrides: Partial<ActiveChangeFeedSyncRun> = {}): ActiveChangeFeedSyncRun {
  return {
    syncRunId: SYNC_RUN_ID,
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    runKind: 'initial_full_sync',
    status: 'running',
    accountIdentity: ACCOUNT,
    startEventSeq: null,
    cutoverTargetEventSeq: null,
    baselineReceiptId: null,
    baselineCacheGeneration: null,
    baselineVerifiedAt: null,
    startedAt: new Date('2026-09-04T00:00:00.000Z'),
    updatedAt: new Date('2026-09-04T00:01:00.000Z'),
    ...overrides,
  } as ActiveChangeFeedSyncRun;
}

function expectFatal(selection: ReturnType<typeof selectInventorySyncMode>, code: string): void {
  expect(selection.kind).toBe('fatal');
  if (selection.kind !== 'fatal') return;
  expect(selection.error).toBeInstanceOf(InventorySyncModeError);
  expect(selection.error).toMatchObject({ code, sanitized: true });
  expect(selection.error.message).not.toMatch(/postgres:\/|worker:|secret|ledger\.example/i);
}
