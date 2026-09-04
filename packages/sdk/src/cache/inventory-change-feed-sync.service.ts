import { randomUUID } from 'node:crypto';
import type {
  ChangeFeedProgress,
  ChangeFeedRepository,
  ClaimedChangeFeedEvent,
  ClaimChangeFeedOptions,
} from '../change-feed/change-feed.types.js';
import type {
  CacheSyncProgressCallback,
  CacheSyncInventoryMode,
} from './cache-sync-progress.types.js';
import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import type { InventoryChangeFeedBinding, InventoryChangeFeedState } from './types.js';
import { isInventoryEventSequence } from './types.js';
import { type V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';
import {
  coalesceInventoryEvents,
  compareClaimedEvents,
  compareEventSequences,
  processInventoryGroups,
  verifyInventoryReceipt,
  type InventoryChangeFeedSyncIssue,
  type V3DirectItemReadPort,
} from './inventory-change-feed-batch.js';
import { InventoryChangeFeedLeaseRenewal } from './inventory-change-feed-lease-renewal.js';
import type { V3InventoryBoundedReplayRequest } from './v3-inventory-baseline-cutover.js';

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_CLAIM_BATCH_SIZE = 100;

export type { InventoryChangeFeedSyncIssue, V3DirectItemReadPort };

export interface InventoryChangeFeedSyncResult extends ChangeFeedProgress {
  status: 'success' | 'success_with_warnings';
  clean: boolean;
  mode: Extract<CacheSyncInventoryMode, 'incremental' | 'replay'>;
  targetEventSeq: string | null;
  eventsClaimed: number;
  eventsCompleted: number;
  eventsFailed: number;
  itemsProcessed: number;
  stockRowsProcessed: number;
  issues: InventoryChangeFeedSyncIssue[];
}

export interface InventoryChangeFeedSyncDependencies {
  binding: InventoryChangeFeedBinding;
  ledger: ChangeFeedRepository;
  cache: InventoryChangeFeedCache;
  hydrator: Pick<V3ExactItemHydratorService, 'hydrate'>;
  directItemReader: V3DirectItemReadPort;
  signal: AbortSignal;
  assertWriterLockHeld: () => void | Promise<void>;
  onProgress?: CacheSyncProgressCallback;
  categoryNames?: Map<string, string> | null;
  targetEventSeq?: string | null;
  leaseOwner?: string;
  leaseSeconds?: number;
  claimBatchSize?: number;
  maxAttempts?: number;
  now?: () => number;
}

interface DrainContext {
  mode: 'incremental' | 'replay';
  target: string | null;
  syncRunId?: string;
  state: InventoryChangeFeedState;
  generation: string;
  claimed: number;
  completed: number;
  failed: number;
  items: number;
  stockRows: number;
  issues: InventoryChangeFeedSyncIssue[];
}

export class InventoryChangeFeedSyncService {
  readonly #leaseOwner: string;
  readonly #leaseSeconds: number;
  readonly #claimBatchSize: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  #lastReplayResult?: InventoryChangeFeedSyncResult;

  constructor(private readonly dependencies: InventoryChangeFeedSyncDependencies) {
    this.#leaseOwner = dependencies.leaseOwner ?? randomUUID();
    this.#leaseSeconds = boundedInteger(dependencies.leaseSeconds, DEFAULT_LEASE_SECONDS, 1, 900);
    this.#claimBatchSize = boundedInteger(
      dependencies.claimBatchSize,
      DEFAULT_CLAIM_BATCH_SIZE,
      1,
      500
    );
    this.#maxAttempts = boundedInteger(dependencies.maxAttempts, 5, 1, 100);
    this.#now = dependencies.now ?? nowSeconds;
  }

  async sync(): Promise<InventoryChangeFeedSyncResult> {
    const target =
      this.dependencies.targetEventSeq === undefined
        ? await this.guarded(() => this.dependencies.ledger.captureTarget(5_000))
        : this.dependencies.targetEventSeq;
    return this.drain('incremental', normalizeTarget(target));
  }

  async replay(request: V3InventoryBoundedReplayRequest): Promise<void> {
    this.#lastReplayResult = await this.replayWithResult(request);
  }

  replayWithResult(
    request: V3InventoryBoundedReplayRequest
  ): Promise<InventoryChangeFeedSyncResult> {
    if (!request.syncRunId.trim()) throw new Error('Inventory replay sync-run ID is required');
    return this.drain('replay', normalizeTarget(request.targetEventSeq), request.syncRunId);
  }

  get lastReplayResult(): InventoryChangeFeedSyncResult | undefined {
    return this.#lastReplayResult;
  }

  private async drain(
    mode: DrainContext['mode'],
    target: string | null,
    syncRunId?: string
  ): Promise<InventoryChangeFeedSyncResult> {
    this.throwIfAborted();
    const state = await this.guarded(() =>
      this.dependencies.cache.getInventoryChangeFeedState(this.dependencies.binding)
    );
    if (!state?.baselineGeneration) {
      throw new Error('Inventory change-feed cache has no verified baseline generation');
    }
    const context: DrainContext = {
      mode,
      target,
      syncRunId,
      state,
      generation: state.baselineGeneration,
      claimed: 0,
      completed: 0,
      failed: 0,
      items: 0,
      stockRows: 0,
      issues: [],
    };
    this.emit(context, 'target_captured');
    if (target !== null && target !== '0') await this.claimLoop(context);
    const progress = await this.checkpointProgress(context);
    if (!targetReached(target, progress) && context.issues.length === 0) {
      context.issues.push({
        itemId: null,
        eventSeq: progress.blockedByEventSeq,
        code: 'target_not_reached',
        message: 'Fixed inventory change-feed target remains blocked',
        outcome: 'blocked',
      });
      this.emit(context, 'blocker_observed', progress);
    }
    const clean = context.issues.length === 0 && targetReached(target, progress);
    this.emit(context, 'phase_completed', progress);
    return {
      status: clean ? 'success' : 'success_with_warnings',
      clean,
      mode,
      targetEventSeq: target,
      ...progress,
      eventsClaimed: context.claimed,
      eventsCompleted: context.completed,
      eventsFailed: context.failed,
      itemsProcessed: context.items,
      stockRowsProcessed: context.stockRows,
      issues: context.issues.sort(compareIssues),
    };
  }

  private async claimLoop(context: DrainContext): Promise<void> {
    let shouldClaim = true;
    while (shouldClaim) {
      const claim = await this.guarded(() =>
        this.dependencies.ledger.claim(this.claimOptions(context))
      );
      if (claim.length === 0) {
        shouldClaim = false;
        continue;
      }
      assertClaimBounds(claim, context.target);
      context.claimed += claim.length;
      this.emit(
        context,
        'batch_claimed',
        undefined,
        claim.length,
        new Set(claim.map((e) => e.objectId)).size
      );
      const renewal = this.createRenewal(context);
      renewal.add(claim);
      try {
        await this.processClaim(context, claim, renewal);
        await renewal.checkpoint();
      } finally {
        renewal.stop();
      }
      await this.checkpointProgress(context);
    }
  }

  private async processClaim(
    context: DrainContext,
    claim: ClaimedChangeFeedEvent[],
    renewal: InventoryChangeFeedLeaseRenewal
  ): Promise<void> {
    const existing = await this.critical(renewal, () =>
      this.dependencies.cache.getInventoryEventReceipts(
        this.dependencies.binding,
        claim.map((event) => event.eventSeq)
      )
    );
    const eventsBySeq = new Map(claim.map((event) => [event.eventSeq, event]));
    const receiptSeqs = new Set<string>();
    for (const receipt of existing) {
      const event = eventsBySeq.get(receipt.eventSeq);
      if (!event) throw new Error('Inventory receipt readback included an unclaimed event');
      const verified = verifyInventoryReceipt(
        receipt,
        event,
        this.dependencies.binding,
        context.generation
      );
      await this.completeEvent(event, verified, renewal);
      receiptSeqs.add(event.eventSeq);
      context.completed++;
    }
    const pending = claim.filter((event) => !receiptSeqs.has(event.eventSeq));
    const summary = await processInventoryGroups(
      coalesceInventoryEvents(pending),
      context.state,
      renewal,
      {
        binding: this.dependencies.binding,
        cache: this.dependencies.cache,
        hydrator: this.dependencies.hydrator,
        directItemReader: this.dependencies.directItemReader,
        categoryNames: this.dependencies.categoryNames,
        generation: context.generation,
        maxAttempts: this.#maxAttempts,
        now: this.#now,
        critical: (operation) => this.critical(renewal, operation),
        complete: (event, receipt) => this.completeEvent(event, receipt, renewal),
        fail: (event, reason) => this.failEvent(event, reason, renewal),
        onApplied: (count) => this.emit(context, 'batch_applied', undefined, count, 1),
      }
    );
    context.completed += summary.completed;
    context.failed += summary.failed;
    context.items += summary.items;
    context.stockRows += summary.stockRows;
    context.issues.push(...summary.issues);
    context.state.highestAppliedEventSeq = summary.highestAppliedEventSeq;
  }

  private async completeEvent(
    event: ClaimedChangeFeedEvent,
    receipt: ReturnType<typeof verifyInventoryReceipt>,
    renewal: InventoryChangeFeedLeaseRenewal
  ): Promise<void> {
    await renewal.beginTransition(event.eventSeq);
    await this.critical(renewal, (operationSignal) =>
      this.dependencies.ledger.complete({
        eventSeq: event.eventSeq,
        leaseOwner: this.#leaseOwner,
        leaseToken: event.leaseToken,
        receipt,
        operationSignal,
      })
    );
    renewal.finishTransition(event.eventSeq);
  }

  private async failEvent(
    event: ClaimedChangeFeedEvent,
    reason: { code: string; message: string },
    renewal: InventoryChangeFeedLeaseRenewal
  ): Promise<'retry' | 'dead_letter'> {
    await renewal.beginTransition(event.eventSeq);
    const failed = await this.critical(renewal, (operationSignal) =>
      this.dependencies.ledger.fail({
        eventSeq: event.eventSeq,
        leaseOwner: this.#leaseOwner,
        leaseToken: event.leaseToken,
        errorCode: reason.code,
        sanitizedErrorMessage: reason.message,
        retryable: true,
        maxAttempts: this.#maxAttempts,
        baseDelaySeconds: 5,
        maxDelaySeconds: 300,
        operationSignal,
      })
    );
    renewal.finishTransition(event.eventSeq);
    return failed.status;
  }

  private async checkpointProgress(context: DrainContext): Promise<ChangeFeedProgress> {
    const progress = await this.guarded(() => this.dependencies.ledger.refreshProgress());
    context.state = await this.critical(undefined, (operationSignal) =>
      this.dependencies.cache.updateInventoryChangeFeedState({
        ...this.dependencies.binding,
        observedThroughEventSeq: progress.observedThroughEventSeq,
        appliedThroughEventSeq: progress.appliedThroughEventSeq,
        highestAppliedEventSeq: context.state.highestAppliedEventSeq,
        blockedByEventSeq: progress.blockedByEventSeq,
        updatedAt: this.#now(),
        operationSignal,
      })
    );
    this.emit(context, 'checkpoint_saved', progress);
    return progress;
  }

  private claimOptions(context: DrainContext): ClaimChangeFeedOptions {
    const common = {
      leaseOwner: this.#leaseOwner,
      batchSize: this.#claimBatchSize,
      leaseSeconds: this.#leaseSeconds,
    };
    if (context.mode === 'replay') {
      if (!context.syncRunId) throw new Error('Inventory replay sync-run ID is required');
      return { ...common, mode: 'replay', syncRunId: context.syncRunId };
    }
    if (context.target === null) throw new Error('Inventory incremental target is required');
    return { ...common, mode: 'ordinary', throughEventSeq: context.target };
  }

  private createRenewal(context: DrainContext): InventoryChangeFeedLeaseRenewal {
    return new InventoryChangeFeedLeaseRenewal({
      ledger: this.dependencies.ledger,
      leaseOwner: this.#leaseOwner,
      leaseSeconds: this.#leaseSeconds,
      signal: this.dependencies.signal,
      assertWriterLockHeld: this.dependencies.assertWriterLockHeld,
      onRenewed: (count) => this.emit(context, 'lease_renewed', undefined, count),
    });
  }

  private guarded<T>(operation: (operationSignal: AbortSignal) => Promise<T>): Promise<T> {
    return this.critical(undefined, operation);
  }

  private async critical<T>(
    renewal: InventoryChangeFeedLeaseRenewal | undefined,
    operation: (operationSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    await this.boundary(renewal);
    const controller = new AbortController();
    const abortOperation = (): void => controller.abort(this.abortReason());
    this.dependencies.signal.addEventListener('abort', abortOperation, { once: true });
    if (this.dependencies.signal.aborted) abortOperation();
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const pending = this.raceAbort(operationPromise);
    try {
      const result = await (renewal ? renewal.race(pending) : pending);
      await this.boundary(renewal);
      return result;
    } catch (error) {
      controller.abort(error);
      // A database adapter that supports cancellation will tear down its checked-out
      // connection. Keep a rejection handler for non-cooperative test/adapter promises.
      void operationPromise.catch(() => undefined);
      throw error;
    } finally {
      this.dependencies.signal.removeEventListener('abort', abortOperation);
    }
  }

  private raceAbort<T>(operation: Promise<T>): Promise<T> {
    if (this.dependencies.signal.aborted) {
      return Promise.reject(this.abortReason());
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.abortReason());
      this.dependencies.signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => {
        this.dependencies.signal.removeEventListener('abort', abort);
      });
    });
  }

  private async boundary(renewal?: InventoryChangeFeedLeaseRenewal): Promise<void> {
    this.throwIfAborted();
    await renewal?.checkpoint();
    this.throwIfAborted();
    await this.dependencies.assertWriterLockHeld();
    this.throwIfAborted();
  }

  private throwIfAborted(): void {
    if (!this.dependencies.signal.aborted) return;
    throw this.abortReason();
  }

  private abortReason(): Error {
    if (this.dependencies.signal.reason instanceof Error) return this.dependencies.signal.reason;
    const error = new Error('Inventory change-feed sync was aborted');
    error.name = 'AbortError';
    return error;
  }

  private emit(
    context: DrainContext,
    event:
      | 'target_captured'
      | 'batch_claimed'
      | 'batch_applied'
      | 'lease_renewed'
      | 'checkpoint_saved'
      | 'blocker_observed'
      | 'phase_completed',
    progress?: ChangeFeedProgress,
    batchEventCount?: number,
    batchItemCount?: number
  ): void {
    this.dependencies.onProgress?.({
      phase: 'inventory',
      event,
      mode: context.mode,
      targetEventSeq: context.target ?? undefined,
      observedThroughEventSeq: progress?.observedThroughEventSeq ?? undefined,
      appliedThroughEventSeq: progress?.appliedThroughEventSeq ?? undefined,
      blockedByEventSeq: progress?.blockedByEventSeq,
      batchEventCount,
      batchItemCount,
      recordsProcessed: context.items,
      recordsTotal: null,
      indeterminate: true,
      apiVersion: '3',
      timestamp: this.#now(),
    });
  }
}

function assertClaimBounds(events: ClaimedChangeFeedEvent[], target: string | null): void {
  events.sort(compareClaimedEvents);
  if (
    target !== null &&
    events.some((event) => compareEventSequences(event.eventSeq, target) > 0)
  ) {
    throw new Error('Change-feed claim exceeded its fixed target');
  }
}

function targetReached(target: string | null, progress: ChangeFeedProgress): boolean {
  if (target === null || target === '0') return true;
  return (
    progress.appliedThroughEventSeq !== null &&
    compareEventSequences(progress.appliedThroughEventSeq, target) >= 0 &&
    (progress.blockedByEventSeq === null ||
      compareEventSequences(progress.blockedByEventSeq, target) > 0)
  );
}

function normalizeTarget(value: string | null): string | null {
  if (value === null) return null;
  if (!isInventoryEventSequence(value)) throw new Error('Inventory change-feed target is invalid');
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`Inventory change-feed option must be between ${min} and ${max}`);
  }
  return resolved;
}

function compareIssues(
  left: InventoryChangeFeedSyncIssue,
  right: InventoryChangeFeedSyncIssue
): number {
  if (left.eventSeq !== null && right.eventSeq !== null)
    return compareEventSequences(left.eventSeq, right.eventSeq);
  if (left.eventSeq !== right.eventSeq) return left.eventSeq === null ? 1 : -1;
  return (left.itemId ?? '').localeCompare(right.itemId ?? '');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
