import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import type { CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type {
  InventoryBaselineRun,
  InventoryChangeFeedBinding,
  InventoryStagingProgress,
} from './types.js';
import {
  V3ExactItemHydratorService,
  type V3ExactItemHydrationResult,
  type V3ExactItemHydratorClient,
} from './v3-exact-item-hydrator.service.js';

const EXACT_BATCH_LIMIT = 50;

type GuardedOperation = <T>(operation: () => Promise<T>) => Promise<T>;
type StagingCache = Pick<
  InventoryChangeFeedCache,
  'getInventoryStagingProgress' | 'recordInventoryStagingFailure' | 'stageInventoryBaselineItem'
>;

export interface V3InventoryBaselineWarning {
  id: string;
  code: string;
  message: string;
  invocationAttempts: 2;
  totalAttemptCount: number;
}

export class V3InventoryBaselineHydration {
  private readonly hydrator: V3ExactItemHydratorService;

  constructor(
    client: V3ExactItemHydratorClient,
    private readonly cache: StagingCache,
    private readonly guarded: GuardedOperation,
    private readonly now: () => number,
    private readonly onProgressEvent?: CacheSyncProgressCallback
  ) {
    this.hydrator = new V3ExactItemHydratorService(client);
  }

  async hydratePending(
    run: InventoryBaselineRun,
    binding: InventoryChangeFeedBinding,
    categoryNames: Map<string, string> | null
  ): Promise<V3InventoryBaselineWarning[]> {
    let progress = await this.requireProgress(binding, run.runId);
    this.emit('checkpoint_saved', progress.stagedItemCount, progress.expectedItemCount);
    const attemptCounts = new Map(
      progress.failures.map((failure) => [failure.itemId, failure.attemptCount])
    );
    const failedOnce = await this.hydrateAndStage(
      progress.pendingItemIds,
      run.runId,
      binding,
      categoryNames,
      attemptCounts,
      1
    );
    if (failedOnce.length > 0) {
      this.emit('retry_pass_started', 0, failedOnce.length, 2);
      await this.hydrateAndStage(
        failedOnce,
        run.runId,
        binding,
        categoryNames,
        attemptCounts,
        2
      );
    }
    progress = await this.requireProgress(binding, run.runId);
    return warningsFromProgress(progress);
  }

  private async hydrateAndStage(
    ids: readonly string[],
    runId: string,
    binding: InventoryChangeFeedBinding,
    categoryNames: Map<string, string> | null,
    attemptCounts: Map<string, number>,
    pass: 1 | 2
  ): Promise<string[]> {
    const failures: string[] = [];
    for (let offset = 0; offset < ids.length; offset += EXACT_BATCH_LIMIT) {
      const batch = ids.slice(offset, offset + EXACT_BATCH_LIMIT);
      const results = await this.guarded(() => this.hydrator.hydrate(batch, { categoryNames }));
      for (const [resultIndex, result] of results.entries()) {
        const attemptCount = (attemptCounts.get(result.id) ?? 0) + 1;
        attemptCounts.set(result.id, attemptCount);
        if (result.status === 'found_current' || result.status === 'found_archived') {
          await this.guarded(() =>
            this.cache.stageInventoryBaselineItem({
              ...binding,
              runId,
              item: result.bundle.item,
              stockRows: result.bundle.stockRows,
              stagedAt: this.now(),
            })
          );
          this.emit(
            pass === 2 ? 'record_retry_succeeded' : 'record_processed',
            offset + resultIndex + 1,
            ids.length,
            pass
          );
          continue;
        }
        const failure = failureDetails(result);
        failures.push(result.id);
        await this.guarded(() =>
          this.cache.recordInventoryStagingFailure({
            ...binding,
            runId,
            itemId: result.id,
            attemptCount,
            errorCode: failure.code,
            errorMessage: failure.message,
            updatedAt: this.now(),
          })
        );
        this.emit(
          pass === 2 ? 'record_retry_failed' : 'record_failed_collected',
          offset + resultIndex + 1,
          ids.length,
          pass
        );
      }
      this.emit('checkpoint_saved', Math.min(offset + batch.length, ids.length), ids.length);
    }
    return failures;
  }

  private async requireProgress(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryStagingProgress> {
    const progress = await this.guarded(() =>
      this.cache.getInventoryStagingProgress(binding, runId)
    );
    if (!progress) throw new Error('Inventory baseline staging progress is unavailable');
    return progress;
  }

  private emit(
    event: Parameters<CacheSyncProgressCallback>[0]['event'],
    recordsProcessed: number,
    recordsTotal: number,
    pass?: number
  ): void {
    this.onProgressEvent?.({
      phase: 'inventory',
      apiVersion: '3',
      mode: 'baseline',
      event,
      ...(pass === undefined ? {} : { pass }),
      recordsProcessed,
      recordsTotal,
      indeterminate: false,
    });
  }
}

function failureDetails(result: V3ExactItemHydrationResult): { code: string; message: string } {
  return result.status === 'local_failure'
    ? result.failure
    : { code: 'not_found', message: 'Item unavailable during baseline hydration' };
}

function warningsFromProgress(progress: InventoryStagingProgress): V3InventoryBaselineWarning[] {
  const pending = new Set(progress.pendingItemIds);
  return progress.failures
    .filter((failure) => pending.has(failure.itemId))
    .map((failure) => ({
      id: failure.itemId,
      code: failure.errorCode,
      message: failure.errorMessage,
      invocationAttempts: 2,
      totalAttemptCount: failure.attemptCount,
    }));
}
