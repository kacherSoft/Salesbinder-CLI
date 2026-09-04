import type { ChangeFeedProgress, ChangeFeedRepository } from '../change-feed/change-feed.types.js';
import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import type {
  InventoryBaselinePromotionResult,
  InventoryBaselineRun,
  InventoryChangeFeedBinding,
} from './types.js';

type GuardedOperation = <T>(operation: () => Promise<T>) => Promise<T>;
type ReceiptCache = Pick<InventoryChangeFeedCache, 'getInventoryBaselineRun'>;

export interface V3InventoryBoundedReplayRequest {
  syncRunId: string;
  /** Canonical positive ledger sequence, or "0" when the captured ledger is empty. */
  targetEventSeq: string;
}

export interface V3InventoryBoundedReplayPort {
  replayWithResult(
    request: V3InventoryBoundedReplayRequest
  ): Promise<V3InventoryBoundedReplayResult>;
}

export interface V3InventoryBoundedReplayIssue {
  itemId: string | null;
  eventSeq: string | null;
  code: string;
  message: string;
  outcome: 'retry' | 'dead_letter' | 'blocked';
}

export interface V3InventoryBoundedReplayResult {
  status: 'success' | 'success_with_warnings';
  clean: boolean;
  targetEventSeq: string | null;
  observedThroughEventSeq: string | null;
  appliedThroughEventSeq: string | null;
  blockedByEventSeq: string | null;
  issues: V3InventoryBoundedReplayIssue[];
}

export interface V3InventoryBaselineCutoverResult {
  targetEventSeq: string | null;
  ledgerPromoted: boolean;
  replay: V3InventoryBoundedReplayResult;
}

export interface V3InventoryBaselineCutoverDependencies {
  cache: ReceiptCache;
  ledger: ChangeFeedRepository;
  replay: V3InventoryBoundedReplayPort;
  guarded: GuardedOperation;
  ledgerLockTimeoutMs: number;
  onTargetCaptured?: (targetEventSeq: string) => void;
}

export interface V3InventoryBaselineResumeEvidence {
  targetCaptured: boolean;
  targetEventSeq: string | null;
  baselineReceiptId: string | null;
  baselineCacheGeneration: string | null;
}

export class V3InventoryBaselineCutover {
  constructor(private readonly dependencies: V3InventoryBaselineCutoverDependencies) {}

  async complete(
    binding: InventoryChangeFeedBinding,
    run: InventoryBaselineRun,
    promotion: InventoryBaselinePromotionResult,
    resume: V3InventoryBaselineResumeEvidence
  ): Promise<V3InventoryBaselineCutoverResult> {
    await this.verifyPromotedReceipt(binding, promotion);
    assertLedgerReceiptEvidence(resume, promotion);
    await this.dependencies.guarded(() =>
      this.dependencies.ledger.verifyBaseline(run.runId, {
        receiptId: promotion.run.runId,
        cacheGeneration: promotion.meta.generation,
        receiptVerified: true,
        coverageComplete: true,
        unresolvedExclusions: [],
      })
    );
    const target = resume.targetCaptured
      ? resume.targetEventSeq
      : await this.dependencies.guarded(() =>
          this.dependencies.ledger.captureSyncTarget(
            run.runId,
            this.dependencies.ledgerLockTimeoutMs
          )
        );
    if (target !== null && BigInt(target) < BigInt(run.startEventSeq)) {
      throw new Error('Inventory cutover target precedes its baseline start barrier');
    }
    this.dependencies.onTargetCaptured?.(normalizeBarrier(target));
    await this.dependencies.guarded(() => this.dependencies.ledger.coverBaseline(run.runId));
    const replay = await this.dependencies.guarded(() =>
      this.dependencies.replay.replayWithResult({
        syncRunId: run.runId,
        targetEventSeq: normalizeBarrier(target),
      })
    );
    assertReplayResult(target, replay);
    const progress = await this.dependencies.guarded(() =>
      this.dependencies.ledger.refreshProgress()
    );
    if (!replay.clean) {
      return { targetEventSeq: target, ledgerPromoted: false, replay };
    }
    assertTargetApplied(target, progress);
    await this.dependencies.guarded(() => this.dependencies.ledger.promoteSyncRun(run.runId));
    return { targetEventSeq: target, ledgerPromoted: true, replay };
  }

  private async verifyPromotedReceipt(
    binding: InventoryChangeFeedBinding,
    promotion: InventoryBaselinePromotionResult
  ): Promise<void> {
    const receipt = await this.dependencies.guarded(() =>
      this.dependencies.cache.getInventoryBaselineRun(binding, promotion.run.runId)
    );
    if (
      !receipt ||
      receipt.status !== 'promoted' ||
      receipt.runId !== promotion.run.runId ||
      receipt.generation !== promotion.meta.generation ||
      promotion.meta.version !== 2 ||
      promotion.meta.status !== 'complete' ||
      promotion.meta.warningCount !== 0 ||
      promotion.meta.omittedItemCount !== 0
    ) {
      throw new Error('Inventory baseline receipt readback did not prove clean promotion');
    }
  }
}

function assertReplayResult(
  target: string | null,
  replay: V3InventoryBoundedReplayResult
): void {
  const expectedTarget = normalizeBarrier(target);
  if (
    normalizeBarrier(replay.targetEventSeq) !== expectedTarget ||
    replay.status !== (replay.clean ? 'success' : 'success_with_warnings') ||
    (replay.clean ? replay.issues.length !== 0 : replay.issues.length === 0)
  ) {
    throw new Error('Inventory replay returned inconsistent bounded-cutover evidence');
  }
}

function assertLedgerReceiptEvidence(
  resume: V3InventoryBaselineResumeEvidence,
  promotion: InventoryBaselinePromotionResult
): void {
  const hasReceipt = resume.baselineReceiptId !== null;
  const hasGeneration = resume.baselineCacheGeneration !== null;
  if (
    hasReceipt !== hasGeneration ||
    (hasReceipt && resume.baselineReceiptId !== promotion.run.runId) ||
    (hasGeneration && resume.baselineCacheGeneration !== promotion.meta.generation) ||
    (resume.targetCaptured && (!hasReceipt || !hasGeneration))
  ) {
    throw new Error('Ledger baseline evidence conflicts with the promoted cache receipt');
  }
}

function assertTargetApplied(target: string | null, progress: ChangeFeedProgress): void {
  if (target === null) return;
  if (
    progress.appliedThroughEventSeq === null ||
    BigInt(progress.appliedThroughEventSeq) < BigInt(target) ||
    (progress.blockedByEventSeq !== null && BigInt(progress.blockedByEventSeq) <= BigInt(target))
  ) {
    throw new Error('Inventory cutover target is not fully applied or remains blocked');
  }
}

function normalizeBarrier(value: string | null): string {
  return value ?? '0';
}
