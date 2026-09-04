import type {
  InventoryBaselineRun,
  InventoryBaselinePromotion,
  InventoryBaselinePromotionResult,
  InventoryBaselineFailure,
  InventoryChangeFeedBinding,
  InventoryChangeFeedState,
  InventoryChangeFeedStateUpdate,
  InventoryVerifiedBaselineProof,
  InventoryEventReceipt,
  InventoryEventSequence,
  InventoryItemBundleApplication,
  InventoryReceiptApplicationResult,
  InventoryStagedItemBundle,
  InventoryStagingFailure,
  InventoryStagingProgress,
  InventoryTombstoneApplication,
} from './types.js';

/** PostgreSQL-only capability; intentionally absent from the shared CacheService contract. */
export interface InventoryChangeFeedCache {
  ensureInventoryChangeFeedState(
    binding: InventoryChangeFeedBinding,
    updatedAt?: number
  ): Promise<InventoryChangeFeedState>;
  getInventoryChangeFeedState(
    binding: InventoryChangeFeedBinding
  ): Promise<InventoryChangeFeedState | null>;
  getInventoryChangeFeedStateByConsumer(
    accountIdentity: string,
    consumerName: string
  ): Promise<InventoryChangeFeedState | null>;
  getVerifiedInventoryBaselineProofByConsumer(
    accountIdentity: string,
    consumerName: string
  ): Promise<InventoryVerifiedBaselineProof | null>;
  updateInventoryChangeFeedState(
    update: InventoryChangeFeedStateUpdate
  ): Promise<InventoryChangeFeedState>;

  getInventoryEventReceipt(
    binding: InventoryChangeFeedBinding,
    eventSeq: InventoryEventSequence
  ): Promise<InventoryEventReceipt | null>;
  getInventoryEventReceipts(
    binding: InventoryChangeFeedBinding,
    eventSeqs: InventoryEventSequence[]
  ): Promise<InventoryEventReceipt[]>;
  applyInventoryItemBundle(
    application: InventoryItemBundleApplication
  ): Promise<InventoryReceiptApplicationResult>;
  applyInventoryTombstone(
    application: InventoryTombstoneApplication
  ): Promise<InventoryReceiptApplicationResult>;

  beginInventoryBaselineRun(run: InventoryBaselineRun): Promise<InventoryBaselineRun>;
  getInventoryBaselineRun(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryBaselineRun | null>;
  stageInventoryBaselineItem(bundle: InventoryStagedItemBundle): Promise<void>;
  recordInventoryStagingFailure(failure: InventoryStagingFailure): Promise<void>;
  getInventoryStagingProgress(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryStagingProgress | null>;
  promoteInventoryBaselineRun(
    promotion: InventoryBaselinePromotion
  ): Promise<InventoryBaselinePromotionResult>;
  failInventoryBaselineRun(failure: InventoryBaselineFailure): Promise<InventoryBaselineRun>;
  deleteInventoryBaselineRun(binding: InventoryChangeFeedBinding, runId: string): Promise<void>;
}
