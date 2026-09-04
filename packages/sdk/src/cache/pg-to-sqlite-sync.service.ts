/**
 * PG → SQLite sync service
 *
 * Pulls data from a shared PostgreSQL cache into the local SQLite mirror.
 * SQLite is the optional local mirror for offline reads.
 * PostgreSQL is the shared source of truth (populated by `cache sync`).
 */

import { randomUUID } from 'node:crypto';
import type {
  AccountRow,
  CacheAccountBinding,
  CacheState,
  CacheSyncStatus,
  DocumentRow,
  InventoryCacheMeta,
  ItemDocumentRow,
  ItemRow,
  ItemStockLocationRow,
} from './types.js';
import type {
  CacheSyncPhase,
  CacheSyncProgress,
  CacheSyncProgressEventType,
  CacheSyncRateLimitProgress,
} from './cache-sync-progress.types.js';
import type { SyncRecordIssue, SyncRecordIssueCode } from './sync-record-issue.types.js';
import type { PaymentTransactionRow } from './payment-sync.types.js';
import { PostgresCacheService, PostgresSyncLockLostError } from './postgres-cache.service.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';
import { loadConfig } from '../config/config.loader.js';
import {
  CACHE_SCHEMA_VERSION,
  createInventorySnapshotFingerprint,
  createSalesBinderAccountBinding,
  DocumentContextId,
} from './types.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

/** Result of a PG → SQLite pull */
export interface PgPullResult {
  success: boolean;
  accountsPulled: number;
  categoriesPulled: number;
  documentsPulled: number;
  itemDocumentsPulled: number;
  paymentTransactionsPulled: number;
  itemsPulled: number;
  stockRowsPulled: number;
  duration: string;
  skipped?: boolean;
  skipReason?: string;
}

/** Pull outcome reported while the required PostgreSQL and SQLite writer locks remain held. */
export type PgPullSettlement =
  | { status: 'success'; result: Readonly<PgPullResult> }
  | { status: 'failed'; error: unknown };

interface PgPullLifecycleCallbacks {
  /** Awaited exactly once after required locks are held and the pull settles. */
  onSettledWhileLocked?: (settlement: PgPullSettlement) => void | Promise<void>;
  /** Awaited at most once if mirror finalization fails after a success settlement was requested. */
  onPostSuccessFailureWhileLocked?: (error: unknown) => void | Promise<void>;
}

export type PgPullLifecycleOptions = PgPullLifecycleCallbacks &
  (
    | {
        /** Reuse the caller-owned PostgreSQL writer lock. */
        pgLockAlreadyHeld: true;
        /** Owner-session loss signal required while reusing the writer lock. */
        lockLossSignal: AbortSignal;
      }
    | {
        pgLockAlreadyHeld?: false;
        lockLossSignal?: never;
      }
  );

/**
 * Pull all data from PostgreSQL into the local SQLite cache.
 *
 * Strategy: full replace — wipe SQLite tables then bulk-insert from PG.
 * This is safe because SQLite is only a read mirror; the canonical data lives in PG.
 */
export async function pullFromPostgres(
  pgConnectionString: string,
  sqliteAccountName: string,
  sqliteCustomPath?: string,
  accountBinding?: CacheAccountBinding,
  lifecycle: PgPullLifecycleOptions = {}
): Promise<PgPullResult> {
  if (lifecycle.pgLockAlreadyHeld && !lifecycle.lockLossSignal) {
    throw new Error('PostgreSQL lock-loss signal is required when reusing the writer lock.');
  }
  const start = Date.now();
  const resolvedBinding =
    accountBinding ?? createSalesBinderAccountBinding(loadConfig(sqliteAccountName).subdomain);
  let settlementHookInvoked = false;
  let successSettlementRequested = false;
  let postSuccessFailureHookInvoked = false;
  let pg: PostgresCacheService | null = null;
  let sqlite: SQLiteCacheService | null = null;
  let pgLockAcquired = false;
  let sqliteLockAcquired = false;
  let pullFailed = false;
  let pgCloseAttempted = false;
  let replacementCommitted = false;
  let sourceSyncStatus: CacheSyncStatus | null = null;
  let compensationSyncStatus: CacheSyncStatus | null = null;
  const lockLoss = createPullLockLossGuard(lifecycle.lockLossSignal);
  const lockKey = `salesbinder-cache-sync:${resolvedBinding.accountIdentity}`;
  const notifySettlementWhileLocked = async (
    settlement: PgPullSettlement,
    suppressHookFailure = false
  ): Promise<void> => {
    if (settlementHookInvoked || !lifecycle.onSettledWhileLocked) return;
    settlementHookInvoked = true;
    successSettlementRequested = settlement.status === 'success';
    if (!suppressHookFailure) {
      await lifecycle.onSettledWhileLocked(settlement);
      return;
    }
    try {
      await lifecycle.onSettledWhileLocked(settlement);
    } catch {
      // Preserve the primary pull failure; cleanup still runs in the outer finally.
    }
  };
  const notifyPostSuccessFailureWhileLocked = async (error: unknown): Promise<void> => {
    if (
      !successSettlementRequested ||
      postSuccessFailureHookInvoked ||
      !lifecycle.onPostSuccessFailureWhileLocked
    ) {
      return;
    }
    postSuccessFailureHookInvoked = true;
    try {
      await lifecycle.onPostSuccessFailureWhileLocked(error);
    } catch {
      // Preserve the mirror failure; the outer owner compensation is best-effort.
    }
  };

  try {
    lockLoss.assertHeld();
    // Open both connections
    const pgService = new PostgresCacheService(pgConnectionString);
    pg = pgService;
    await lockLoss.runCheckedOperation(() => pgService.ensureSchema());
    await lockLoss.runAbortablePgOperation(() => pgService.verifyAccountBinding(resolvedBinding));
    if (!lifecycle.pgLockAlreadyHeld) {
      const acquisition = pgService.tryAcquireSyncLock(lockKey, { onLost: lockLoss.onLost });
      try {
        pgLockAcquired = await lockLoss.runAbortablePgOperation(() => acquisition);
      } catch (error) {
        void acquisition.then(
          async (acquired) => {
            if (acquired) await pgService.releaseSyncLock(lockKey).catch(() => undefined);
          },
          () => undefined
        );
        throw error;
      }
      if (!pgLockAcquired)
        throw new Error('Another cache sync is already running for this account.');
    }
    const sqliteService = new SQLiteCacheService(sqliteAccountName, sqliteCustomPath);
    sqlite = sqliteService;
    await lockLoss.runCheckedOperation(() => sqliteService.verifyAccountBinding(resolvedBinding));
    sqliteLockAcquired = await lockLoss.runCheckedOperation(() =>
      sqliteService.tryAcquireSyncLock(lockKey)
    );
    if (!sqliteLockAcquired)
      throw new Error('Another local cache writer is already running for this account.');

    try {
      // 1. Pull all documents from PG
      const allDocs = await lockLoss.runAbortablePgOperation(() => getAllDocuments(pgService));
      const allItems = await getAllItemDocuments(pgService, allDocs, lockLoss);
      const allPayments = await lockLoss.runAbortablePgOperation(() =>
        getAllPaymentTransactions(pgService)
      );
      const allAccounts = await lockLoss.runAbortablePgOperation(() => getAllAccounts(pgService));
      const categorySnapshot = await lockLoss.runAbortablePgOperation(() =>
        pgService.getCategorySnapshot()
      );
      const inventoryCacheMeta = await lockLoss.runAbortablePgOperation(() =>
        pgService.getInventoryCacheMeta()
      );
      const allMasterItems = await lockLoss.runAbortablePgOperation(() => getAllItems(pgService));
      const allStockRows = await lockLoss.runAbortablePgOperation(() => getAllStockRows(pgService));
      const pgState = await lockLoss.runAbortablePgOperation(() => pgService.getCacheState());
      const localInventoryCacheMeta = createLocalInventoryCacheMeta(
        inventoryCacheMeta,
        pgState,
        resolvedBinding.accountIdentity,
        allMasterItems,
        allStockRows,
        Math.floor(Date.now() / 1_000)
      );
      const pgPaymentSyncStatus = await lockLoss.runAbortablePgOperation(() =>
        pgService.getPaymentSyncStatus()
      );
      sourceSyncStatus = projectSyncStatusForMirror(
        await lockLoss.runAbortablePgOperation(() => pgService.getSyncStatus()),
        false
      );
      compensationSyncStatus = sourceSyncStatus;
      if (lifecycle.onSettledWhileLocked && !sourceSyncStatus) {
        throw new Error('PostgreSQL sync status is missing before pull settlement.');
      }

      // Replace data and metadata together so readers see either the old or new mirror.
      await lockLoss.runCheckedOperation(async () => {
        await sqliteService.replaceMirror({
          accounts: allAccounts,
          categorySnapshot,
          inventoryCacheMeta: localInventoryCacheMeta,
          items: allMasterItems,
          itemStockLocations: allStockRows,
          documents: allDocs,
          itemDocuments: allItems,
          paymentTransactions: allPayments,
          cacheState: pgState,
          paymentSyncStatus: pgPaymentSyncStatus,
          syncStatus: sourceSyncStatus,
          pulledAt: Date.now(),
        });
        replacementCommitted = true;
      });

      const duration = ((Date.now() - start) / 1000).toFixed(1);
      const result: PgPullResult = {
        success: true,
        accountsPulled: allAccounts.length,
        categoriesPulled: categorySnapshot?.rows.length ?? 0,
        documentsPulled: allDocs.length,
        itemDocumentsPulled: allItems.length,
        paymentTransactionsPulled: allPayments.length,
        itemsPulled: allMasterItems.length,
        stockRowsPulled: allStockRows.length,
        duration: `${duration}s`,
      };
      const requireTerminalStatus = lifecycle.onSettledWhileLocked !== undefined;
      if (requireTerminalStatus) {
        await lockLoss.runCheckedOperation(() =>
          notifySettlementWhileLocked({ status: 'success', result })
        );
        const terminalStatus = projectSyncStatusForMirror(
          await lockLoss.runAbortablePgOperation(() => pgService.getSyncStatus()),
          true
        );
        if (!terminalStatus) throw new Error('PostgreSQL terminal sync status is missing.');
        compensationSyncStatus = terminalStatus;
        await lockLoss.runCheckedOperation(() => sqliteService.setSyncStatus(terminalStatus));
      }
      if (lifecycle.pgLockAlreadyHeld) {
        pgCloseAttempted = true;
        try {
          await pgService.close();
        } catch {
          // Connection cleanup is best-effort; lock loss remains authoritative.
        }
        lockLoss.assertHeld();
      }
      return result;
    } catch (error) {
      let safeError = lockLoss.safeError(error);
      if (replacementCommitted && lifecycle.onSettledWhileLocked && compensationSyncStatus) {
        const failedStatus = createCompensatingFailureStatus(compensationSyncStatus);
        await compensatePostReplaceFailure(
          sqliteService,
          failedStatus,
          pgLockAcquired ? pgService : null
        );
      }
      safeError = lockLoss.safeError(safeError);
      if (successSettlementRequested) {
        await notifyPostSuccessFailureWhileLocked(safeError);
      } else {
        await notifySettlementWhileLocked({ status: 'failed', error: safeError }, true);
      }
      throw lockLoss.safeError(safeError);
    }
  } catch (error) {
    pullFailed = true;
    throw error;
  } finally {
    try {
      if (sqlite && sqliteLockAcquired) await sqlite.releaseSyncLock(lockKey);
    } catch {
      /* ignore */
    }
    try {
      if (pg && pgLockAcquired) await pg.releaseSyncLock(lockKey);
    } catch {
      /* ignore */
    }
    try {
      if (pg && !pgCloseAttempted) {
        const close = pg.close();
        if (pullFailed && lockLoss.isLost() && lockLoss.hasPendingAbortablePgOperations()) {
          void close.catch(() => undefined);
        } else await close;
      }
    } catch {
      /* ignore */
    }
    try {
      if (sqlite) await sqlite.close();
    } catch {
      /* ignore */
    }
    lockLoss.dispose();
  }
}

function createCompensatingFailureStatus(terminalStatus: CacheSyncStatus): CacheSyncStatus {
  const timestamp = Math.max(Math.floor(Date.now() / 1_000), terminalStatus.updatedAt);
  const failedStatus: CacheSyncStatus = {
    ...terminalStatus,
    status: 'failed',
    updatedAt: timestamp,
    finishedAt: timestamp,
    message: 'Sync failed',
    error: 'Cache sync failed.',
  };
  delete failedStatus.recordIssues;
  return failedStatus;
}

async function compensatePostReplaceFailure(
  sqlite: SQLiteCacheService,
  failedStatus: CacheSyncStatus,
  postgresLockOwner: PostgresCacheService | null
): Promise<void> {
  try {
    await sqlite.setSyncStatus(failedStatus);
  } catch {
    // Preserve the primary pull failure while the SQLite writer lock is still held.
  }
  if (!postgresLockOwner) return;
  try {
    await postgresLockOwner.setSyncStatus(failedStatus);
  } catch {
    // Preserve the primary mirror failure; lifecycle callers still receive it.
  }
}

const SYNC_STATUS_MESSAGES: Record<CacheSyncStatus['status'], string> = {
  running: 'Sync running',
  success: 'Sync completed',
  success_with_warnings: 'Sync completed with warnings',
  failed: 'Sync failed',
};

const SYNC_PHASES = new Set<CacheSyncPhase>([
  'initializing',
  'accounts',
  'categories',
  'documents',
  'inventory',
  'deleted-log',
  'pg-to-sqlite-pull',
  'finalizing',
]);

const SYNC_PROGRESS_EVENTS = new Set<CacheSyncProgressEventType>([
  'phase_started',
  'pass_started',
  'page_started',
  'record_processed',
  'record_failed_collected',
  'page_completed',
  'pass_completed',
  'retry_pass_started',
  'record_retry_succeeded',
  'record_retry_failed',
  'waiting_rate_limit',
  'phase_completed',
]);

function projectSyncStatusForMirror(
  value: unknown,
  requireTerminal: boolean
): CacheSyncStatus | null {
  if (value == null) {
    if (requireTerminal) throw new Error('PostgreSQL terminal sync status is missing.');
    return null;
  }
  if (!isRecord(value) || !isSyncStatus(value.status)) {
    throw new Error('PostgreSQL sync status is invalid.');
  }
  if (requireTerminal && value.status === 'running') {
    throw new Error('PostgreSQL sync status was not terminal after pull settlement.');
  }

  const projected: CacheSyncStatus = {
    status: value.status,
    runId: requireSafeText(value.runId),
    accountName: requireSafeText(value.accountName),
    syncTarget: requireSyncTarget(value.syncTarget),
    startedAt: requireNonNegativeInteger(value.startedAt),
    updatedAt: requireNonNegativeInteger(value.updatedAt),
    message: SYNC_STATUS_MESSAGES[value.status],
  };
  copyOptionalInteger(value, projected, 'finishedAt');
  copyOptionalInteger(value, projected, 'progressUpdatedAt');
  for (const key of [
    'documentsProcessed',
    'lineItemsProcessed',
    'itemsProcessed',
    'categoriesProcessed',
    'stockRowsProcessed',
    'deletedRecordsProcessed',
  ] as const) {
    copyOptionalInteger(value, projected, key);
  }
  if (value.syncType === 'full' || value.syncType === 'delta') projected.syncType = value.syncType;

  const progress = projectSyncProgress(value.progress);
  if (progress) {
    projected.progress = progress;
    projected.phase = progress.phase;
  } else if (isSyncPhase(value.phase)) {
    projected.phase = value.phase;
  }

  const recordIssues = projectSyncRecordIssues(value.recordIssues);
  if (value.status === 'success_with_warnings' && recordIssues.length === 0) {
    throw new Error('PostgreSQL warning sync status has no valid record issues.');
  }
  if (recordIssues.length > 0) projected.recordIssues = recordIssues;
  if (value.status === 'failed') projected.error = 'Cache sync failed.';
  return projected;
}

function projectSyncRecordIssues(value: unknown): SyncRecordIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('PostgreSQL sync record issues are invalid.');
  const issues = new Map<string, SyncRecordIssue>();
  for (const candidate of value) {
    const issue = projectSyncRecordIssue(candidate);
    const key = `${issue.resource}:${issue.id}`;
    if (issues.has(key))
      throw new Error('PostgreSQL sync record issues contain duplicate identities.');
    issues.set(key, issue);
  }
  return [...issues.values()].sort(
    (left, right) =>
      compareCodeUnits(left.resource, right.resource) ||
      (left.context_id ?? -1) - (right.context_id ?? -1) ||
      compareCodeUnits(left.id, right.id)
  );
}

function projectSyncRecordIssue(value: unknown): SyncRecordIssue {
  if (
    !isRecord(value) ||
    (value.resource !== 'document' && value.resource !== 'item') ||
    !isIssueCode(value.code) ||
    value.attempts !== 2 ||
    (value.outcome !== 'preserved_last_known_good' && value.outcome !== 'omitted_new')
  ) {
    throw new Error('PostgreSQL sync record issue is invalid.');
  }
  const contextId = value.context_id;
  if (
    contextId !== undefined &&
    (value.resource !== 'document' ||
      !Number.isSafeInteger(contextId) ||
      ![4, 5, 11].includes(Number(contextId)))
  ) {
    throw new Error('PostgreSQL sync record issue context is invalid.');
  }
  const id = requireSafeSourceId(value.id);
  if (value.resource === 'document') {
    if (!isDocumentIssueCode(value.code)) {
      throw new Error('PostgreSQL document sync record issue is invalid.');
    }
    return {
      resource: 'document',
      id,
      ...(contextId === undefined ? {} : { context_id: Number(contextId) }),
      code: value.code,
      message: canonicalIssueMessage('document', value.code),
      attempts: value.attempts,
      outcome: value.outcome,
    };
  }
  return {
    resource: 'item',
    id,
    code: value.code,
    message: canonicalIssueMessage('item', value.code),
    attempts: value.attempts,
    outcome: value.outcome,
  };
}

function canonicalIssueMessage(
  resource: SyncRecordIssue['resource'],
  code: SyncRecordIssueCode
): string {
  if (resource === 'document') {
    return code === 'not_found'
      ? 'Document unavailable during refresh'
      : 'Document failed source validation';
  }
  if (code === 'not_found') return 'Item unavailable during refresh';
  if (code === 'invalid_record') return 'Item failed source validation';
  if (code === 'invalid_variations') return 'Item variations failed source validation';
  return 'Item changed during snapshot verification';
}

function projectSyncProgress(value: unknown): CacheSyncProgress | undefined {
  if (
    !isRecord(value) ||
    !isSyncPhase(value.phase) ||
    !isSyncProgressEvent(value.event) ||
    !isNonNegativeInteger(value.recordsProcessed) ||
    !(value.recordsTotal === null || isNonNegativeInteger(value.recordsTotal)) ||
    typeof value.indeterminate !== 'boolean'
  ) {
    return undefined;
  }
  const projected: CacheSyncProgress = {
    phase: value.phase,
    event: value.event,
    recordsProcessed: value.recordsProcessed,
    recordsTotal: value.recordsTotal,
    indeterminate: value.indeterminate,
  };
  for (const key of ['pass', 'page', 'timestamp'] as const) {
    if (isNonNegativeInteger(value[key])) projected[key] = value[key];
  }
  if (value.pagesTotal === null || isNonNegativeInteger(value.pagesTotal)) {
    projected.pagesTotal = value.pagesTotal;
  }
  if (value.apiVersion === '2.0' || value.apiVersion === '3') {
    projected.apiVersion = value.apiVersion;
  }
  const rateLimit = projectRateLimit(value.rateLimit);
  if (rateLimit) projected.rateLimit = rateLimit;
  return projected;
}

function projectRateLimit(value: unknown): CacheSyncRateLimitProgress | undefined {
  if (!isRecord(value)) return undefined;
  const projected: CacheSyncRateLimitProgress = {};
  for (const key of [
    'waitMs',
    'waitUntil',
    'retryAfterSeconds',
    'limit',
    'remaining',
    'resetSeconds',
  ] as const) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      projected[key] = candidate;
    }
  }
  return projected;
}

function copyOptionalInteger<
  Key extends keyof Pick<
    CacheSyncStatus,
    | 'finishedAt'
    | 'progressUpdatedAt'
    | 'documentsProcessed'
    | 'lineItemsProcessed'
    | 'itemsProcessed'
    | 'categoriesProcessed'
    | 'stockRowsProcessed'
    | 'deletedRecordsProcessed'
  >,
>(source: Record<string, unknown>, target: CacheSyncStatus, key: Key): void {
  const value = source[key];
  if (isNonNegativeInteger(value)) target[key] = value;
}

function requireSafeText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error('PostgreSQL sync status identifier is invalid.');
  }
  return value;
}

function requireSafeSourceId(value: unknown): string {
  return requireSafeText(value);
}

function requireNonNegativeInteger(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw new Error('PostgreSQL sync status timestamp is invalid.');
  return value;
}

function requireSyncTarget(value: unknown): CacheSyncStatus['syncTarget'] {
  if (value !== 'sqlite' && value !== 'postgresql') {
    throw new Error('PostgreSQL sync status target is invalid.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncStatus(value: unknown): value is CacheSyncStatus['status'] {
  return (
    value === 'running' ||
    value === 'success' ||
    value === 'success_with_warnings' ||
    value === 'failed'
  );
}

function isSyncPhase(value: unknown): value is CacheSyncPhase {
  return typeof value === 'string' && SYNC_PHASES.has(value as CacheSyncPhase);
}

function isSyncProgressEvent(value: unknown): value is CacheSyncProgressEventType {
  return typeof value === 'string' && SYNC_PROGRESS_EVENTS.has(value as CacheSyncProgressEventType);
}

function isIssueCode(value: unknown): value is SyncRecordIssueCode {
  return (
    value === 'not_found' ||
    value === 'invalid_record' ||
    value === 'invalid_variations' ||
    value === 'content_changed'
  );
}

function isDocumentIssueCode(
  value: SyncRecordIssueCode
): value is Extract<SyncRecordIssueCode, 'not_found' | 'invalid_record'> {
  return value === 'not_found' || value === 'invalid_record';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ============ Internal helpers ============

/** Fetch every supported document context, including legacy rows with no modification watermark. */
async function getAllDocuments(pg: PostgresCacheService): Promise<DocumentRow[]> {
  const documentsByContext = await Promise.all(
    [DocumentContextId.Estimate, DocumentContextId.Invoice, DocumentContextId.PurchaseOrder].map(
      (contextId) => pg.getDocumentsByContext(contextId)
    )
  );
  return (
    documentsByContext
      .flat()
      // SQLite's document schema requires a numeric watermark; zero preserves the legacy unknown state.
      .map((document) => (document.modified == null ? { ...document, modified: 0 } : document))
      .sort(
        (left, right) =>
          left.context_id - right.context_id || compareCodeUnits(left.doc_id, right.doc_id)
      )
  );
}

async function getAllAccounts(pg: PostgresCacheService): Promise<AccountRow[]> {
  return pg.getAllAccounts();
}

async function getAllItems(pg: PostgresCacheService): Promise<ItemRow[]> {
  return pg.getAllItems();
}

async function getAllStockRows(pg: PostgresCacheService): Promise<ItemStockLocationRow[]> {
  return pg.getAllItemStockLocations();
}

function createLocalInventoryCacheMeta(
  sourceMeta: InventoryCacheMeta | null,
  sourceState: CacheState | null,
  accountIdentity: string,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[],
  completedAt: number
): InventoryCacheMeta | null {
  if (sourceState?.inventorySourceApiVersion !== '3') return null;
  if (!sourceMeta && sourceState.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  const authoritativeItems = items.filter(isV3ApiInventoryRow);
  const authoritativeStockRows = stockRows.filter(isV3ApiInventoryRow);
  const generation = randomUUID();
  const itemCount = authoritativeItems.length;
  const stockRowCount = authoritativeStockRows.length;
  const localMeta: InventoryCacheMeta = sourceMeta
    ? sourceMeta.version === 1
      ? {
          ...sourceMeta,
          itemCount,
          stockRowCount,
          schemaVersion: CACHE_SCHEMA_VERSION,
          generation,
          fingerprint: '',
        }
      : {
          ...sourceMeta,
          itemCount,
          stockRowCount,
          freshItemCount:
            sourceMeta.status === 'complete'
              ? itemCount
              : itemCount - sourceMeta.preservedItemCount,
          schemaVersion: CACHE_SCHEMA_VERSION,
          generation,
          fingerprint: '',
        }
    : {
        version: 2,
        status: 'complete',
        accountIdentity,
        startedAt: completedAt,
        completedAt,
        itemCount,
        stockRowCount,
        schemaVersion: CACHE_SCHEMA_VERSION,
        sourceApiVersion: '3',
        generation,
        fingerprint: '',
        freshItemCount: itemCount,
        preservedItemCount: 0,
        omittedItemCount: 0,
        warningCount: 0,
        lastCompleteAt: completedAt,
      };
  if (
    localMeta.version === 2 &&
    (localMeta.freshItemCount < 0 ||
      localMeta.freshItemCount + localMeta.preservedItemCount !== itemCount)
  ) {
    return null;
  }
  return {
    ...localMeta,
    schemaVersion: CACHE_SCHEMA_VERSION,
    fingerprint: createInventorySnapshotFingerprint(
      localMeta.accountIdentity,
      generation,
      authoritativeItems,
      authoritativeStockRows
    ),
  };
}

function isV3ApiInventoryRow(value: ItemRow | ItemStockLocationRow): boolean {
  return value.cache_source === 'api' && value.source_api_version === '3';
}

async function getAllPaymentTransactions(
  pg: PostgresCacheService
): Promise<PaymentTransactionRow[]> {
  return pg.getAllPaymentTransactions();
}

/** Fetch all item_documents from PG */
async function getAllItemDocuments(
  pg: PostgresCacheService,
  docs: DocumentRow[],
  lockLoss: PullLockLossGuard
): Promise<Omit<ItemDocumentRow, 'id'>[]> {
  const allItems: Omit<ItemDocumentRow, 'id'>[] = [];

  // Batch by 100 doc_ids to avoid too many round-trips
  const batchSize = 100;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const promises = batch.map((doc) => pg.getItemDocuments(doc.doc_id));
    const results = await lockLoss.runAbortablePgOperation(() => Promise.all(promises));
    for (const items of results) {
      for (const item of items) {
        allItems.push({
          document_item_id: item.document_item_id,
          item_id: item.item_id,
          doc_id: item.doc_id,
          quantity: item.quantity,
          price: item.price,
          item_name: item.item_name,
          item_number: item.item_number,
          item_sku: item.item_sku,
          item_location: item.item_location,
          line_description: item.line_description,
          quantity_received: item.quantity_received,
          quantity_shipped: item.quantity_shipped,
          cost: item.cost,
          total_amount: item.total_amount,
          discounted_price: item.discounted_price,
          discount_percent: item.discount_percent,
        });
      }
    }
  }

  return allItems;
}

type PullLockLossGuard = {
  onLost: (error: Error) => void;
  assertHeld: () => void;
  runAbortablePgOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  runCheckedOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  isLost: () => boolean;
  hasPendingAbortablePgOperations: () => boolean;
  safeError: (error: unknown) => unknown;
  dispose: () => void;
};

function createPullLockLossGuard(externalSignal?: AbortSignal): PullLockLossGuard {
  const controller = new AbortController();
  const pendingAbortablePgOperations = new Set<Promise<unknown>>();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const assertHeld = (): void => {
    if (controller.signal.aborted) throw new PostgresSyncLockLostError();
  };
  return {
    onLost: abort,
    assertHeld,
    runAbortablePgOperation: <T>(operation: () => Promise<T>): Promise<T> => {
      assertHeld();
      const operationPromise = Promise.resolve().then(operation);
      pendingAbortablePgOperations.add(operationPromise);
      void operationPromise.then(
        () => pendingAbortablePgOperations.delete(operationPromise),
        () => pendingAbortablePgOperations.delete(operationPromise)
      );
      let removeAbortListener = (): void => undefined;
      const lockLost = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new PostgresSyncLockLostError());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
        if (controller.signal.aborted) onAbort();
      });
      return Promise.race([operationPromise, lockLost]).finally(removeAbortListener);
    },
    runCheckedOperation: async <T>(operation: () => Promise<T>): Promise<T> => {
      assertHeld();
      const result = await operation();
      assertHeld();
      return result;
    },
    isLost: () => controller.signal.aborted,
    hasPendingAbortablePgOperations: () => pendingAbortablePgOperations.size > 0,
    safeError: (error) => (controller.signal.aborted ? new PostgresSyncLockLostError() : error),
    dispose: () => externalSignal?.removeEventListener('abort', abort),
  };
}
