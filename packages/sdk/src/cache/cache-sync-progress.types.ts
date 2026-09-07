import type { DocumentContextId } from '../types/common.types.js';

/** Cache sync phases exposed to live progress consumers. */
export type CacheSyncPhase =
  | 'initializing'
  | 'accounts'
  | 'categories'
  | 'documents'
  | 'inventory'
  | 'deleted-log'
  | 'pg-to-sqlite-pull'
  | 'finalizing';

/** Typed progress events emitted by cache indexers and orchestration. */
export type CacheSyncProgressEventType =
  | 'phase_started'
  | 'pass_started'
  | 'page_started'
  | 'record_processed'
  | 'record_failed_collected'
  | 'page_completed'
  | 'pass_completed'
  | 'retry_pass_started'
  | 'record_retry_succeeded'
  | 'record_retry_failed'
  | 'waiting_rate_limit'
  | 'target_captured'
  | 'batch_claimed'
  | 'batch_applied'
  | 'lease_renewed'
  | 'checkpoint_saved'
  | 'blocker_observed'
  | 'phase_completed';

/** Inventory execution mode, exposed without ledger or item identities. */
export type CacheSyncInventoryMode = 'baseline' | 'replay' | 'incremental';

/** Redacted rate-limit details safe to persist or render. */
export interface CacheSyncRateLimitProgress {
  waitMs?: number;
  waitUntil?: number;
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

/**
 * Public, ID-free cache sync progress.
 *
 * Keep this allowlist deliberately narrow. Record identifiers and diagnostic
 * text belong only in terminal SyncRecordIssue values.
 */
export interface CacheSyncProgress {
  phase: CacheSyncPhase;
  event: CacheSyncProgressEventType;
  /** Operation mode for phases that have a full/delta distinction. */
  phaseMode?: 'full' | 'delta';
  /** Document context represented by this event (4=estimate, 5=invoice, 11=PO). */
  contextId?: DocumentContextId;
  /** Count within the current document context, not an aggregate across contexts. */
  contextRecordsProcessed?: number;
  /** Context total when the source provides a coherent total; otherwise null. */
  contextRecordsTotal?: number | null;
  pass?: number;
  page?: number;
  pagesTotal?: number | null;
  recordsProcessed: number;
  recordsTotal: number | null;
  indeterminate: boolean;
  apiVersion?: '2.0' | '3';
  timestamp?: number;
  rateLimit?: CacheSyncRateLimitProgress;
  mode?: CacheSyncInventoryMode;
  targetEventSeq?: string;
  observedThroughEventSeq?: string;
  appliedThroughEventSeq?: string;
  blockedByEventSeq?: string | null;
  batchEventCount?: number;
  batchItemCount?: number;
  queueCount?: number;
  retryCount?: number;
  deadLetterCount?: number;
  lastEventAt?: number;
}

export type CacheSyncProgressCallback = (event: CacheSyncProgress) => void;

/** Structural subset accepted from the transport rate-limit observer. */
export interface CacheSyncRateLimitObservation {
  type: 'wait' | 'cooldown' | 'headers' | 'retry';
  apiVersion: 'v2' | 'v3';
  waitMs?: number;
  waitUntil?: number;
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}
