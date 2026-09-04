import type { Pool, PoolConfig } from 'pg';
import type {
  ChangeFeedInventoryEventType,
  SALESBINDER_CLI_INVENTORY_CONSUMER,
} from './change-feed.constants.js';

export type ChangeFeedEventSequence = string;
export type ChangeFeedHydrationOutcome = 'found_current' | 'found_archived' | 'expected_tombstone';
export type ChangeFeedTerminalStatus = 'succeeded' | 'superseded_by_succeeded';
export type ChangeFeedFailureStatus = 'retry' | 'dead_letter';
export type ChangeFeedSyncKind = 'initial_full_sync' | 'cutover_replay' | 'reconciliation';
export type ActiveChangeFeedSyncRunStatus = 'running' | 'baseline_succeeded' | 'replaying';

export interface ChangeFeedContractPreflight {
  contractVersion: 2;
  ledgerDatabaseId: string;
  accountIdentity: string;
  consumerName: typeof SALESBINDER_CLI_INVENTORY_CONSUMER;
  eventTypePrefix: 'inventory.';
  subscribedEventTypes: readonly ChangeFeedInventoryEventType[];
}

export interface ClaimedChangeFeedEvent {
  eventSeq: ChangeFeedEventSequence;
  providerEventId: string;
  eventType: ChangeFeedInventoryEventType;
  apiVersion: 'v3';
  objectType: 'inventory';
  objectId: string;
  providerCreatedAt: Date;
  receivedAt: Date;
  rawBody: Buffer;
  parsedPayload: Readonly<Record<string, unknown>>;
  attemptCount: number;
  leasedUntil: Date;
  leaseToken: string;
}

interface ClaimChangeFeedBaseOptions {
  leaseOwner: string;
  batchSize: number;
  leaseSeconds: number;
}

export type ClaimChangeFeedOptions =
  | (ClaimChangeFeedBaseOptions & {
      mode: 'ordinary';
      throughEventSeq: ChangeFeedEventSequence;
      syncRunId?: never;
    })
  | (ClaimChangeFeedBaseOptions & {
      mode: 'replay';
      syncRunId: string;
      throughEventSeq?: never;
    });

export interface RenewChangeFeedLease {
  eventSeq: ChangeFeedEventSequence;
  leaseOwner: string;
  leaseToken: string;
  leaseSeconds: number;
}

export interface VerifiedCacheReceipt {
  receiptId: string;
  cacheGeneration: string;
  committedAt: Date;
  hydrationOutcome: ChangeFeedHydrationOutcome;
  receiptVerified: true;
}

export interface CompleteChangeFeedEvent {
  eventSeq: ChangeFeedEventSequence;
  leaseOwner: string;
  leaseToken: string;
  receipt: VerifiedCacheReceipt;
  /** Cancels the checked-out PostgreSQL operation when the worker fence becomes unsafe. */
  operationSignal?: AbortSignal;
}

export interface FailChangeFeedEvent {
  eventSeq: ChangeFeedEventSequence;
  leaseOwner: string;
  leaseToken: string;
  errorCode: string;
  sanitizedErrorMessage: string;
  retryable: boolean;
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** Cancels the checked-out PostgreSQL operation when the worker fence becomes unsafe. */
  operationSignal?: AbortSignal;
}

export interface ChangeFeedFailureResult {
  status: ChangeFeedFailureStatus;
  nextAttemptAt: Date;
}

export interface ChangeFeedProgress {
  observedThroughEventSeq: ChangeFeedEventSequence | null;
  appliedThroughEventSeq: ChangeFeedEventSequence | null;
  blockedByEventSeq: ChangeFeedEventSequence | null;
}

export interface ChangeFeedConsumerStatus extends ChangeFeedProgress {
  queuedCount: string;
  retryCount: string;
  deadLetterCount: string;
  lastEventReceivedAt: Date | null;
}

export interface BeginChangeFeedSyncRun {
  runKind: ChangeFeedSyncKind;
  lockTimeoutMs: number;
}

export interface ChangeFeedSyncBarrier {
  syncRunId: string;
  eventSeq: ChangeFeedEventSequence | null;
}

export interface ActiveChangeFeedSyncRun {
  syncRunId: string;
  consumerName: typeof SALESBINDER_CLI_INVENTORY_CONSUMER;
  runKind: ChangeFeedSyncKind;
  status: ActiveChangeFeedSyncRunStatus;
  accountIdentity: string;
  startEventSeq: ChangeFeedEventSequence | null;
  cutoverTargetEventSeq: ChangeFeedEventSequence | null;
  baselineReceiptId: string | null;
  baselineCacheGeneration: string | null;
  baselineVerifiedAt: Date | null;
  startedAt: Date;
  updatedAt: Date;
}

export interface VerifiedBaselineReceipt {
  receiptId: string;
  cacheGeneration: string;
  receiptVerified: true;
  coverageComplete: true;
  unresolvedExclusions: readonly [];
}

export interface FailChangeFeedSyncRun {
  syncRunId: string;
  failureCode: string;
  sanitizedReason: string;
}

interface ChangeFeedRepositoryBinding {
  accountIdentity: string;
  expectedLedgerDatabaseId?: string;
}

export type PostgresChangeFeedRepositoryOptions = ChangeFeedRepositoryBinding &
  (
    | {
        databaseUrl: string;
        pool?: never;
        maxConnections?: number;
        connectionTimeoutMs?: number;
        statementTimeoutMs?: number;
        ssl?: PoolConfig['ssl'];
        onIdleClientError?: () => void;
      }
    | {
        pool: Pool;
        databaseUrl?: never;
        closeInjectedPoolOnClose?: boolean;
        onIdleClientError?: () => void;
      }
  );

export interface ChangeFeedRepository {
  preflight(): Promise<ChangeFeedContractPreflight>;
  getActiveSyncRun(): Promise<ActiveChangeFeedSyncRun | null>;
  captureTarget(lockTimeoutMs: number): Promise<ChangeFeedEventSequence | null>;
  claim(options: ClaimChangeFeedOptions): Promise<ClaimedChangeFeedEvent[]>;
  renewLease(input: RenewChangeFeedLease): Promise<Date>;
  complete(input: CompleteChangeFeedEvent): Promise<ChangeFeedTerminalStatus>;
  fail(input: FailChangeFeedEvent): Promise<ChangeFeedFailureResult>;
  refreshProgress(): Promise<ChangeFeedProgress>;
  getStatus(): Promise<ChangeFeedConsumerStatus>;
  beginSyncRun(input: BeginChangeFeedSyncRun): Promise<ChangeFeedSyncBarrier>;
  verifyBaseline(syncRunId: string, receipt: VerifiedBaselineReceipt): Promise<void>;
  captureSyncTarget(
    syncRunId: string,
    lockTimeoutMs: number
  ): Promise<ChangeFeedEventSequence | null>;
  coverBaseline(syncRunId: string): Promise<string>;
  promoteSyncRun(syncRunId: string): Promise<void>;
  failSyncRun(input: FailChangeFeedSyncRun): Promise<void>;
  close(): Promise<void>;
}
