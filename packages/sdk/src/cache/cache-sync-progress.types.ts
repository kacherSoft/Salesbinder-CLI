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
  | 'phase_completed';

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
  pass?: number;
  page?: number;
  pagesTotal?: number | null;
  recordsProcessed: number;
  recordsTotal: number | null;
  indeterminate: boolean;
  apiVersion?: '2.0' | '3';
  timestamp?: number;
  rateLimit?: CacheSyncRateLimitProgress;
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
