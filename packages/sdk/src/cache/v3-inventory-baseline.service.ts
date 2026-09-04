import { randomUUID } from 'node:crypto';
import type { CacheService } from './cache.interface.js';
import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type {
  ActiveChangeFeedSyncRunStatus,
  ChangeFeedRepository,
  ChangeFeedSyncKind,
} from '../change-feed/change-feed.types.js';
import type { InventoryBaselineRun, InventoryChangeFeedBinding } from './types.js';
import { CACHE_SCHEMA_VERSION, createInventoryBaselineRootFingerprint } from './types.js';
import type { V3ExactItemHydratorClient } from './v3-exact-item-hydrator.service.js';
import {
  V3InventoryBaselineCutover,
  type V3InventoryBoundedReplayPort,
  type V3InventoryBoundedReplayIssue,
  type V3InventoryBoundedReplayRequest,
  type V3InventoryBoundedReplayResult,
} from './v3-inventory-baseline-cutover.js';
import {
  V3InventoryBaselineHydration,
  type V3InventoryBaselineWarning,
} from './v3-inventory-baseline-hydration.js';
import {
  V3InventoryRootDiscovery,
  type V3InventoryRootClient,
  type V3InventoryRootDiscoveryPort,
} from './v3-inventory-root-discovery.js';

const DEFAULT_LEDGER_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_ROOT_REFRESH_LIMIT = 1;

type BaselineCache = CacheService & InventoryChangeFeedCache;

export type V3InventoryBaselineClient = {
  items: V3ExactItemHydratorClient['items'] & V3InventoryRootClient['items'];
};

export type {
  V3InventoryBoundedReplayIssue,
  V3InventoryBoundedReplayPort,
  V3InventoryBoundedReplayRequest,
  V3InventoryBoundedReplayResult,
};
export type { V3InventoryBaselineWarning };

export interface V3InventoryBaselineDependencies {
  accountIdentity: string;
  client: V3InventoryBaselineClient;
  cache: BaselineCache;
  ledger: ChangeFeedRepository;
  replay: V3InventoryBoundedReplayPort;
  signal: AbortSignal;
  assertWriterLockHeld: () => void | Promise<void>;
  ledgerLockTimeoutMs?: number;
  now?: () => number;
  createGeneration?: () => string;
  rootDiscovery?: V3InventoryRootDiscoveryPort;
  runKind?: Extract<ChangeFeedSyncKind, 'initial_full_sync' | 'reconciliation'>;
  onProgressEvent?: CacheSyncProgressCallback;
}

export interface V3InventoryBaselineResult {
  status: 'success' | 'success_with_warnings';
  syncRunId: string;
  generation: string;
  startEventSeq: string;
  targetEventSeq: string | null;
  itemsProcessed: number;
  stockRowsProcessed: number;
  warnings: V3InventoryBaselineWarning[];
  replayIssues: V3InventoryBoundedReplayIssue[];
  baselinePromoted: boolean;
  ledgerPromoted: boolean;
}

interface LedgerRunBarrier {
  syncRunId: string;
  eventSeq: string | null;
  status: ActiveChangeFeedSyncRunStatus | 'new';
  cutoverTargetEventSeq: string | null;
  baselineReceiptId: string | null;
  baselineCacheGeneration: string | null;
}

export class V3InventoryBaselineService {
  private readonly hydration: V3InventoryBaselineHydration;
  private readonly cutover: V3InventoryBaselineCutover;
  private readonly rootDiscovery: V3InventoryRootDiscoveryPort;
  private readonly now: () => number;
  private readonly createGeneration: () => string;
  private readonly ledgerLockTimeoutMs: number;

  constructor(private readonly dependencies: V3InventoryBaselineDependencies) {
    this.rootDiscovery =
      dependencies.rootDiscovery ?? new V3InventoryRootDiscovery(dependencies.client);
    this.now = dependencies.now ?? nowSeconds;
    this.createGeneration = dependencies.createGeneration ?? randomUUID;
    this.ledgerLockTimeoutMs = dependencies.ledgerLockTimeoutMs ?? DEFAULT_LEDGER_LOCK_TIMEOUT_MS;
    const guarded = <T>(operation: () => Promise<T>) => this.checkedBoundary(operation);
    this.hydration = new V3InventoryBaselineHydration(
      dependencies.client,
      dependencies.cache,
      guarded,
      this.now,
      dependencies.onProgressEvent
    );
    this.cutover = new V3InventoryBaselineCutover({
      cache: dependencies.cache,
      ledger: dependencies.ledger,
      replay: dependencies.replay,
      guarded,
      ledgerLockTimeoutMs: this.ledgerLockTimeoutMs,
      onTargetCaptured: (targetEventSeq) =>
        this.emit('target_captured', 0, null, { targetEventSeq }),
    });
  }

  async sync(): Promise<V3InventoryBaselineResult> {
    const preflight = await this.ledgerBoundary(() => this.dependencies.ledger.preflight());
    if (preflight.accountIdentity !== this.dependencies.accountIdentity) {
      throw new Error('Ledger account does not match the requested inventory baseline account');
    }
    const binding: InventoryChangeFeedBinding = {
      accountIdentity: this.dependencies.accountIdentity,
      ledgerDatabaseId: preflight.ledgerDatabaseId,
      consumerName: preflight.consumerName,
    };
    await this.assertCacheSchema();
    await this.cacheBoundary(() => this.dependencies.cache.ensureInventoryChangeFeedState(binding));

    let staleRootRefreshes = 0;
    for (;;) {
      const barrier = await this.beginOrResumeLedgerRun();
      const startEventSeq = normalizeBarrier(barrier.eventSeq);
      this.emit('phase_started', 0, null);
      let run = await this.cacheBoundary(() =>
        this.dependencies.cache.getInventoryBaselineRun(binding, barrier.syncRunId)
      );
      if (!run) run = await this.beginCacheRun(binding, barrier, startEventSeq);
      assertRunMatches(run, binding, barrier.syncRunId, startEventSeq);
      if (barrier.status !== 'running' && barrier.status !== 'new' && run.status !== 'promoted') {
        throw new Error('Ledger baseline state is ahead of the cache baseline receipt');
      }

      if (run.status === 'active') {
        const categorySnapshot = await this.cacheBoundary(() =>
          this.dependencies.cache.getCategorySnapshot()
        );
        const categoryNames = categorySnapshot
          ? new Map(categorySnapshot.rows.map((row) => [row.category_id, row.name]))
          : null;
        const warnings = await this.hydration.hydratePending(run, binding, categoryNames);
        if (warnings.length > 0) {
          this.emit(
            'phase_completed',
            run.expectedItemCount - warnings.length,
            run.expectedItemCount
          );
          if (
            staleRootRefreshes < DEFAULT_STALE_ROOT_REFRESH_LIMIT &&
            (await this.shouldRefreshStaleRoot(run, binding, warnings))
          ) {
            staleRootRefreshes++;
            await this.cacheBoundary(() =>
              this.dependencies.cache.deleteInventoryBaselineRun(binding, run.runId)
            );
            this.emit('checkpoint_saved', 0, null);
            continue;
          }
          return warningResult(run, warnings);
        }
      }

      const promotion = await this.cacheBoundary(() =>
        this.dependencies.cache.promoteInventoryBaselineRun({
          ...binding,
          runId: run.runId,
          promotedAt: this.now(),
        })
      );
      const cutover = await this.cutover.complete(binding, promotion.run, promotion, {
        targetCaptured: barrier.status === 'replaying',
        targetEventSeq: barrier.cutoverTargetEventSeq,
        baselineReceiptId: barrier.baselineReceiptId,
        baselineCacheGeneration: barrier.baselineCacheGeneration,
      });
      if (!cutover.ledgerPromoted) {
        this.emit('blocker_observed', promotion.meta.itemCount, promotion.meta.itemCount, {
          targetEventSeq: normalizeBarrier(cutover.targetEventSeq),
          observedThroughEventSeq: cutover.replay.observedThroughEventSeq ?? undefined,
          appliedThroughEventSeq: cutover.replay.appliedThroughEventSeq ?? undefined,
          blockedByEventSeq: cutover.replay.blockedByEventSeq,
        });
      }
      this.emit('phase_completed', promotion.meta.itemCount, promotion.meta.itemCount, {
        targetEventSeq: normalizeBarrier(cutover.targetEventSeq),
      });

      return {
        status: cutover.ledgerPromoted ? 'success' : 'success_with_warnings',
        syncRunId: run.runId,
        generation: promotion.meta.generation,
        startEventSeq,
        targetEventSeq: cutover.targetEventSeq,
        itemsProcessed: promotion.meta.itemCount,
        stockRowsProcessed: promotion.meta.stockRowCount,
        warnings: [],
        replayIssues: cutover.replay.issues,
        baselinePromoted: true,
        ledgerPromoted: cutover.ledgerPromoted,
      };
    }
  }

  private async shouldRefreshStaleRoot(
    run: InventoryBaselineRun,
    binding: InventoryChangeFeedBinding,
    warnings: V3InventoryBaselineWarning[]
  ): Promise<boolean> {
    if (warnings.length === 0 || warnings.some((warning) => warning.code !== 'not_found')) {
      return false;
    }
    const missingIds = new Set(warnings.map((warning) => warning.id));
    const refreshed = await this.rootDiscovery.discover({
      accountIdentity: binding.accountIdentity,
      signal: this.dependencies.signal,
      assertWriterLockHeld: this.dependencies.assertWriterLockHeld,
    });
    return (
      refreshed.fingerprint !== run.rootFingerprint &&
      [...missingIds].every((itemId) => !refreshed.itemIds.includes(itemId))
    );
  }

  private async beginOrResumeLedgerRun(): Promise<LedgerRunBarrier> {
    const active = await this.ledgerBoundary(() => this.dependencies.ledger.getActiveSyncRun());
    const expectedKind = this.dependencies.runKind ?? 'initial_full_sync';
    if (active) {
      if (active.runKind !== expectedKind) {
        throw new Error('Active ledger sync run does not match the requested baseline kind');
      }
      return {
        syncRunId: active.syncRunId,
        eventSeq: active.startEventSeq,
        status: active.status,
        cutoverTargetEventSeq: active.cutoverTargetEventSeq,
        baselineReceiptId: active.baselineReceiptId,
        baselineCacheGeneration: active.baselineCacheGeneration,
      };
    }
    const created = await this.ledgerBoundary(() =>
      this.dependencies.ledger.beginSyncRun({
        runKind: expectedKind,
        lockTimeoutMs: this.ledgerLockTimeoutMs,
      })
    );
    return {
      ...created,
      status: 'new',
      cutoverTargetEventSeq: null,
      baselineReceiptId: null,
      baselineCacheGeneration: null,
    };
  }

  private async beginCacheRun(
    binding: InventoryChangeFeedBinding,
    barrier: LedgerRunBarrier,
    startEventSeq: string
  ): Promise<InventoryBaselineRun> {
    const root = await this.rootDiscovery.discover({
      accountIdentity: binding.accountIdentity,
      signal: this.dependencies.signal,
      assertWriterLockHeld: this.dependencies.assertWriterLockHeld,
    });
    const startedAt = this.now();
    const run = await this.cacheBoundary(() =>
      this.dependencies.cache.beginInventoryBaselineRun({
        ...binding,
        runId: barrier.syncRunId,
        generation: this.createGeneration(),
        startEventSeq,
        rootFingerprint: root.fingerprint,
        rootItemIds: root.itemIds,
        expectedItemCount: root.itemIds.length,
        status: 'active',
        startedAt,
        updatedAt: startedAt,
        promotedAt: null,
        failureCode: null,
      })
    );
    this.emit('checkpoint_saved', 0, run.expectedItemCount);
    return run;
  }

  private async assertCacheSchema(): Promise<void> {
    const state = await this.cacheBoundary(() => this.dependencies.cache.getCacheState());
    if (state?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(`Inventory baseline requires cache schema version ${CACHE_SCHEMA_VERSION}`);
    }
  }

  private cacheBoundary<T>(operation: () => Promise<T>): Promise<T> {
    return this.checkedBoundary(operation);
  }

  private ledgerBoundary<T>(operation: () => Promise<T>): Promise<T> {
    return this.checkedBoundary(operation);
  }

  private async checkedBoundary<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfAborted();
    await this.dependencies.assertWriterLockHeld();
    this.throwIfAborted();
    const result = await operation();
    this.throwIfAborted();
    await this.dependencies.assertWriterLockHeld();
    this.throwIfAborted();
    return result;
  }

  private throwIfAborted(): void {
    if (!this.dependencies.signal.aborted) return;
    if (this.dependencies.signal.reason instanceof Error) throw this.dependencies.signal.reason;
    const error = new Error('V3 inventory baseline was aborted');
    error.name = 'AbortError';
    throw error;
  }

  private emit(
    event: Parameters<CacheSyncProgressCallback>[0]['event'],
    recordsProcessed: number,
    recordsTotal: number | null,
    extra: Partial<
      Pick<
        CacheSyncProgress,
        | 'targetEventSeq'
        | 'observedThroughEventSeq'
        | 'appliedThroughEventSeq'
        | 'blockedByEventSeq'
      >
    > = {}
  ): void {
    this.dependencies.onProgressEvent?.({
      phase: 'inventory',
      apiVersion: '3',
      mode: 'baseline',
      event,
      recordsProcessed,
      recordsTotal,
      indeterminate: recordsTotal === null,
      ...extra,
    });
  }
}

function warningResult(
  run: InventoryBaselineRun,
  warnings: V3InventoryBaselineWarning[]
): V3InventoryBaselineResult {
  return {
    status: 'success_with_warnings',
    syncRunId: run.runId,
    generation: run.generation,
    startEventSeq: run.startEventSeq,
    targetEventSeq: null,
    itemsProcessed: 0,
    stockRowsProcessed: 0,
    warnings,
    replayIssues: [],
    baselinePromoted: false,
    ledgerPromoted: false,
  };
}

function assertRunMatches(
  run: InventoryBaselineRun,
  binding: InventoryChangeFeedBinding,
  runId: string,
  startEventSeq: string
): void {
  if (
    run.accountIdentity !== binding.accountIdentity ||
    run.ledgerDatabaseId.toLowerCase() !== binding.ledgerDatabaseId.toLowerCase() ||
    run.consumerName !== binding.consumerName ||
    run.runId !== runId ||
    run.startEventSeq !== startEventSeq ||
    run.expectedItemCount !== run.rootItemIds.length ||
    run.rootFingerprint !==
      createInventoryBaselineRootFingerprint(run.accountIdentity, run.rootItemIds) ||
    (run.status !== 'active' && run.status !== 'promoted')
  ) {
    throw new Error('Inventory baseline recovery state does not match the active ledger run');
  }
}

function normalizeBarrier(value: string | null): string {
  return value ?? '0';
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
