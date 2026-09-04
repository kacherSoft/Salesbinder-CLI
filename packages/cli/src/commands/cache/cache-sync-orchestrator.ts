import {
  CACHE_SCHEMA_VERSION,
  InventoryChangeFeedSyncService,
  PostgresChangeFeedRepository,
  SALESBINDER_CLI_INVENTORY_CONSUMER,
  V3ExactItemHydratorService,
  V3InventoryBaselineService,
  type ActiveChangeFeedSyncRun,
  type CacheService,
  type CacheSyncProgressCallback,
  type ChangeFeedContractPreflight,
  type ChangeFeedRepository,
  type InventoryChangeFeedCache,
  type InventoryChangeFeedState,
  type InventoryChangeFeedSyncIssue,
  type SyncRecordIssue,
  type V3InventoryBaselineClient,
  type V3InventoryClient,
} from '@salesbinder/sdk';
import { loadChangeFeedConfig, type ChangeFeedConfig } from './change-feed-config.js';
import {
  InventorySyncModeError,
  selectInventorySyncMode,
  type InventorySyncMode,
  type InventorySyncModeSelection,
} from './inventory-sync-mode-selector.js';
import { formatInventoryChangeFeedIssues } from './inventory-sync-result-formatter.js';
import { runCompatibilityInventorySync } from './cache-sync-compatibility-runner.js';

type FeedCache = CacheService & InventoryChangeFeedCache;
type SelectedMode = Extract<InventorySyncModeSelection, { kind: 'selected' }>;

export interface PreparedInventorySync {
  config: ChangeFeedConfig | null;
  selection: SelectedMode;
  ledger: ChangeFeedRepository | null;
  preflight: ChangeFeedContractPreflight | null;
  activeRun: ActiveChangeFeedSyncRun | null;
  feedState: InventoryChangeFeedState | null;
}

export interface OrchestratedInventorySyncResult {
  mode: 'compatibility_snapshot' | 'baseline' | 'replay' | 'incremental';
  status: 'success' | 'success_with_warnings';
  itemsProcessed: number;
  stockRowsProcessed: number;
  recordIssues: SyncRecordIssue[];
  feedIssues: ReturnType<typeof formatInventoryChangeFeedIssues>;
  targetEventSeq: string | null;
  observedThroughEventSeq: string | null;
  appliedThroughEventSeq: string | null;
  blockedByEventSeq: string | null;
  eventsClaimed: number;
  eventsCompleted: number;
  eventsFailed: number;
  baselineGeneration: string | null;
  baselinePromoted: boolean | null;
  ledgerPromoted: boolean | null;
}

/** Resolve fail-closed inventory mode before the persisted sync status becomes running. */
export async function prepareInventorySync(input: {
  backend: 'sqlite' | 'postgresql';
  cache: CacheService;
  accountIdentity: string;
  forceFull: boolean;
  assertWriterLockHeld: () => void | Promise<void>;
}): Promise<PreparedInventorySync> {
  const config = loadChangeFeedConfig();
  const feedCache = input.backend === 'postgresql' ? asFeedCache(input.cache) : null;
  if (config && input.backend === 'postgresql' && !feedCache) {
    throw new InventorySyncModeError(
      'change_feed_requires_postgresql',
      'Change-feed inventory sync requires the PostgreSQL cache backend.'
    );
  }
  const cacheState = await guarded(input.assertWriterLockHeld, () => input.cache.getCacheState());
  const feedState = feedCache
    ? await guarded(input.assertWriterLockHeld, () =>
        feedCache.getInventoryChangeFeedStateByConsumer(
          input.accountIdentity,
          SALESBINDER_CLI_INVENTORY_CONSUMER
        )
      )
    : null;
  let ledger: ChangeFeedRepository | null = null;
  try {
    let preflight: ChangeFeedContractPreflight | null = null;
    let activeRun: ActiveChangeFeedSyncRun | null = null;
    if (config && input.backend === 'postgresql') {
      ledger = new PostgresChangeFeedRepository({
        databaseUrl: config.databaseUrl,
        accountIdentity: input.accountIdentity,
        ...(feedState ? { expectedLedgerDatabaseId: feedState.ledgerDatabaseId } : {}),
      });
      const activeLedger = ledger;
      preflight = await guarded(input.assertWriterLockHeld, () => activeLedger.preflight());
      activeRun = await guarded(input.assertWriterLockHeld, () => activeLedger.getActiveSyncRun());
    }
    const baseline = await guarded(input.assertWriterLockHeld, () =>
      input.cache.getInventoryCacheMeta()
    );
    const selection = selectInventorySyncMode({
      backend: input.backend,
      feedConfig: config,
      accountIdentity: input.accountIdentity,
      cacheSchemaVersion: cacheState?.schemaVersion ?? CACHE_SCHEMA_VERSION,
      feedBinding: feedState,
      baseline,
      ledgerPreflight: preflight,
      activeRun,
      forceFull: input.forceFull,
    });
    if (selection.kind === 'fatal') throw selection.error;
    return { config, selection, ledger, preflight, activeRun, feedState };
  } catch (error) {
    await ledger?.close().catch(() => undefined);
    throw error;
  }
}

/** Run only the inventory slice; accounts, categories, documents and deleted-log stay in the CLI flow. */
export async function runPreparedInventorySync(input: {
  prepared: PreparedInventorySync;
  cache: CacheService;
  client: V3InventoryBaselineClient & V3InventoryClient;
  accountName: string;
  accountIdentity: string;
  signal: AbortSignal;
  assertWriterLockHeld: () => void | Promise<void>;
  onProgressEvent?: CacheSyncProgressCallback;
  onProgressHeartbeat?: () => void;
}): Promise<OrchestratedInventorySyncResult> {
  if (input.prepared.selection.mode === 'compatibility_snapshot') {
    const result = await runCompatibilityInventorySync({ ...input, cache: input.cache });
    return {
      ...emptyFeedResult(result.mode),
      ...result,
      baselineGeneration: null,
    };
  }
  const ledger = input.prepared.ledger;
  const preflight = input.prepared.preflight;
  if (!ledger || !preflight) throw new Error('Change-feed inventory preflight is unavailable.');
  const feedCache = requireFeedCache(input.cache);
  const binding = {
    accountIdentity: input.accountIdentity,
    ledgerDatabaseId: preflight.ledgerDatabaseId,
    consumerName: preflight.consumerName,
  };
  const categorySnapshot = await guarded(input.assertWriterLockHeld, () =>
    input.cache.getCategorySnapshot()
  );
  const worker = new InventoryChangeFeedSyncService({
    binding,
    ledger,
    cache: feedCache,
    hydrator: new V3ExactItemHydratorService(input.client),
    directItemReader: input.client,
    signal: input.signal,
    assertWriterLockHeld: input.assertWriterLockHeld,
    onProgress: input.onProgressEvent,
    categoryNames: categorySnapshot
      ? new Map(categorySnapshot.rows.map((row) => [row.category_id, row.name]))
      : null,
  });
  const selected = input.prepared.selection;
  if (selected.mode === 'incremental') return fromFeedResult(await worker.sync(), selected);

  const baseline = await new V3InventoryBaselineService({
    accountIdentity: input.accountIdentity,
    client: input.client,
    cache: feedCache,
    ledger,
    replay: worker,
    signal: input.signal,
    assertWriterLockHeld: input.assertWriterLockHeld,
    runKind: selected.runKind ?? 'initial_full_sync',
    onProgressEvent: input.onProgressEvent
      ? (event) =>
          input.onProgressEvent?.({
            ...event,
            mode: selected.mode === 'replay_resume' ? 'replay' : event.mode,
          })
      : undefined,
  }).sync();
  const replayProgress = baseline.baselinePromoted
    ? await guarded(input.assertWriterLockHeld, () => ledger.refreshProgress())
    : null;
  const replayItemIssues = baseline.replayIssues.filter(
    (issue): issue is typeof issue & { itemId: string; eventSeq: string } =>
      issue.itemId !== null && issue.eventSeq !== null
  );
  return {
    ...emptyFeedResult(publicMode(selected.mode)),
    status: baseline.status,
    itemsProcessed: baseline.itemsProcessed,
    stockRowsProcessed: baseline.stockRowsProcessed,
    recordIssues: [
      ...baseline.warnings.map((warning) => baselineWarning(warning, selected)),
      ...replayItemIssues.map(feedRecordIssue),
    ],
    feedIssues: formatInventoryChangeFeedIssues(
      replayItemIssues.map((issue) => ({
        itemId: issue.itemId,
        eventSeq: issue.eventSeq,
        state: issue.outcome,
        reason: issue.message,
      }))
    ),
    targetEventSeq: baseline.targetEventSeq,
    observedThroughEventSeq: replayProgress?.observedThroughEventSeq ?? null,
    appliedThroughEventSeq: replayProgress?.appliedThroughEventSeq ?? null,
    blockedByEventSeq: replayProgress?.blockedByEventSeq ?? null,
    baselineGeneration: baseline.baselinePromoted
      ? baseline.generation
      : selected.baselineGeneration,
    baselinePromoted: baseline.baselinePromoted,
    ledgerPromoted: baseline.ledgerPromoted,
  };
}

export async function closePreparedInventorySync(
  prepared: PreparedInventorySync | null
): Promise<void> {
  await prepared?.ledger?.close();
}

/** Upgrade legacy file-checkpoint item results to the current command result shape. */
export function normalizeCompatibilityInventorySyncResult(
  result: OrchestratedInventorySyncResult
): OrchestratedInventorySyncResult {
  if (result.mode === 'compatibility_snapshot') return result;
  return {
    ...emptyFeedResult('compatibility_snapshot'),
    status: result.recordIssues.length > 0 ? 'success_with_warnings' : 'success',
    itemsProcessed: result.itemsProcessed,
    stockRowsProcessed: result.stockRowsProcessed,
    recordIssues: result.recordIssues,
    baselineGeneration: null,
  };
}

function fromFeedResult(
  result: Awaited<ReturnType<InventoryChangeFeedSyncService['sync']>>,
  selected: SelectedMode
): OrchestratedInventorySyncResult {
  const itemIssues = result.issues.filter(
    (issue): issue is InventoryChangeFeedSyncIssue & { itemId: string; eventSeq: string } =>
      issue.itemId !== null && issue.eventSeq !== null
  );
  return {
    mode: publicMode(selected.mode),
    status: result.status,
    itemsProcessed: result.itemsProcessed,
    stockRowsProcessed: result.stockRowsProcessed,
    recordIssues: itemIssues.map(feedRecordIssue),
    feedIssues: formatInventoryChangeFeedIssues(
      itemIssues.map((issue) => ({
        itemId: issue.itemId,
        eventSeq: issue.eventSeq,
        state: issue.outcome,
        reason: issue.message,
      }))
    ),
    targetEventSeq: result.targetEventSeq,
    observedThroughEventSeq: result.observedThroughEventSeq,
    appliedThroughEventSeq: result.appliedThroughEventSeq,
    blockedByEventSeq: result.blockedByEventSeq,
    eventsClaimed: result.eventsClaimed,
    eventsCompleted: result.eventsCompleted,
    eventsFailed: result.eventsFailed,
    baselineGeneration: selected.baselineGeneration,
    baselinePromoted: true,
    ledgerPromoted: true,
  };
}

function emptyFeedResult(mode: OrchestratedInventorySyncResult['mode']) {
  return {
    mode,
    feedIssues: [],
    targetEventSeq: null,
    observedThroughEventSeq: null,
    appliedThroughEventSeq: null,
    blockedByEventSeq: null,
    eventsClaimed: 0,
    eventsCompleted: 0,
    eventsFailed: 0,
    baselinePromoted: null,
    ledgerPromoted: null,
  };
}

function publicMode(mode: InventorySyncMode): OrchestratedInventorySyncResult['mode'] {
  if (mode === 'compatibility_snapshot' || mode === 'incremental') return mode;
  return mode === 'replay_resume' ? 'replay' : 'baseline';
}

function baselineWarning(
  warning: { id: string; code: string; message: string },
  selected: SelectedMode
): SyncRecordIssue {
  return {
    resource: 'item',
    id: warning.id,
    code: normalizeIssueCode(warning.code),
    message: warning.message,
    attempts: 2,
    outcome: selected.baselineGeneration ? 'preserved_last_known_good' : 'omitted_new',
  };
}

function feedRecordIssue(issue: {
  itemId: string;
  code: string;
  message: string;
}): SyncRecordIssue {
  return {
    resource: 'item',
    id: issue.itemId,
    code: normalizeIssueCode(issue.code),
    message: issue.message,
    attempts: 2,
    outcome: 'preserved_last_known_good',
  };
}

function normalizeIssueCode(code: string): SyncRecordIssue['code'] {
  return code === 'invalid_record' || code === 'invalid_variations' || code === 'content_changed'
    ? code
    : 'not_found';
}

function requireFeedCache(cache: CacheService): FeedCache {
  const candidate = asFeedCache(cache);
  if (!candidate) {
    throw new Error('Change-feed inventory sync requires the PostgreSQL cache backend.');
  }
  return candidate;
}

function asFeedCache(cache: CacheService): FeedCache | null {
  const candidate = cache as Partial<InventoryChangeFeedCache>;
  return typeof candidate.getInventoryChangeFeedStateByConsumer === 'function' &&
    typeof candidate.applyInventoryItemBundle === 'function' &&
    typeof candidate.promoteInventoryBaselineRun === 'function'
    ? (cache as FeedCache)
    : null;
}

async function guarded<T>(
  assertWriterLockHeld: () => void | Promise<void>,
  operation: () => Promise<T>
): Promise<T> {
  await assertWriterLockHeld();
  const result = await operation();
  await assertWriterLockHeld();
  return result;
}
