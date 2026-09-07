/**
 * Cache management commands
 */

import type { Command } from 'commander';
import type {
  CacheService,
  CacheSyncStatus,
  CategorySnapshot,
  DeletedLogSyncResult,
  PaymentSyncStatus,
  SyncRecordIssue,
  SyncResult,
} from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { registerCachePaymentSyncCommand } from './cache-payment-sync.command.js';
import { CacheSyncProgressController } from './cache-sync-progress-controller.js';
import {
  FullResumeCheckpointStore,
  buildFullResumeCacheIdentity,
  buildPaymentSyncStatusFingerprint,
  type FullResumeCheckpoint,
  type FullResumePhase,
  type ResumeCacheSnapshot,
} from './full-resume-checkpoint.js';
import {
  canonicalSyncRecordIssueMessage,
  requireCanonicalSyncRecordIssueId,
  type FullResumeDocumentTombstone,
} from './full-resume-phase-results.js';
import {
  awaitWhileSyncLockHeld,
  createSyncLockLossGuard,
  type SyncLockLossGuard,
} from './postgres-sync-lock-loss.guard.js';
import {
  closePreparedInventorySync,
  normalizeCompatibilityInventorySyncResult,
  prepareInventorySync,
  runPreparedInventorySync,
  type PreparedInventorySync,
} from './cache-sync-orchestrator.js';
import { registerCacheStatusCommand } from './cache-status.command.js';
import { registerCacheOffsetSyncCommand } from './cache-offset-sync.command.js';
import { registerCacheV3SyncCommand } from './cache-v3-sync.command.js';

type ActiveFullResume = {
  checkpoint: FullResumeCheckpoint;
  store: FullResumeCheckpointStore;
};

type PostgresSyncLockService = CacheService & {
  tryAcquireSyncLock(
    lockKey: string,
    options?: { onLost?: (error: Error) => void }
  ): Promise<boolean>;
};

/**
 * Register cache management commands
 */
export function registerCacheCommands(program: Command): void {
  const cache = program.command('cache').description('Local cache management');
  registerCachePaymentSyncCommand(cache, program);
  registerCacheOffsetSyncCommand(cache, program);
  registerCacheV3SyncCommand(cache, program);

  // Sync command
  cache
    .command('sync')
    .description(
      `Sync cache with SalesBinder API

Examples:
  salesbinder cache sync
  salesbinder cache sync --full
  salesbinder cache sync --pull
  salesbinder cache sync --full-resume

When a PostgreSQL backend is configured: syncs API → PostgreSQL.
Use --pull to also refresh the local SQLite mirror after PostgreSQL sync.
Otherwise: syncs API → SQLite directly.
Use --full to force complete resync.
Use --full-resume for an on-demand checkpointed rebuild attempt.`
    )
    .option('--full', 'Force full sync (re-download all documents)')
    .option(
      '--full-resume',
      'Checkpointed full rebuild attempt; resumes completed phases after failures'
    )
    .option('--reset-checkpoint', 'Reset full-resume checkpoint before starting')
    .option('--pull', 'After PostgreSQL sync, pull PostgreSQL into local SQLite')
    .action(
      async (options: {
        full?: boolean;
        fullResume?: boolean;
        resetCheckpoint?: boolean;
        pull?: boolean;
      }) => {
        let cacheService: import('@salesbinder/sdk').CacheService | null = null;
        let syncLockKey: string | null = null;
        let syncTarget: 'postgresql' | 'sqlite' | null = null;
        let lockAcquired = false;
        let checkpointStore: FullResumeCheckpointStore | null = null;
        let checkpoint: FullResumeCheckpoint | null = null;
        let progressReporter: import('@salesbinder/sdk').CacheSyncProgressReporter | null = null;
        let progressController: CacheSyncProgressController | null = null;
        let terminalRequested = false;
        let checkpointFailureRecorded = false;
        let lockLoss: SyncLockLossGuard | null = null;
        let postSuccessFailureStatus: CacheSyncStatus | null = null;
        let postSuccessFailureAttempted = false;
        let preparedInventorySync: PreparedInventorySync | null = null;

        try {
          const {
            SalesBinderClient,
            SalesBinderV3Client,
            AccountIndexerService,
            CategoryIndexerService,
            DocumentIndexerService,
            DeletedLogSyncService,
            CacheSyncProgressReporter,
            createPostgresCacheService,
            SQLiteCacheService,
            pullFromPostgres,
            loadPreferences,
            resolveSyncLookbackSeconds,
            loadConfig,
            createSalesBinderAccountBinding,
            CACHE_SCHEMA_VERSION,
          } = await import('@salesbinder/sdk');

          const accountName = program.opts().account || 'default';
          const accountConfig = loadConfig(accountName);
          if (!accountConfig.v3ApiKey) {
            throw new Error(
              'SalesBinder API v3 key is required for cache sync category and inventory snapshots. ' +
                'Add v3ApiKey to this account config or rerun config:init with --v3-api-key.'
            );
          }
          const accountBinding = createSalesBinderAccountBinding(accountConfig.subdomain);
          const prefs = loadPreferences();
          const lookbackEnv = process.env[['SALESBINDER', 'SYNC', 'LOOKBACK', 'SECONDS'].join('_')];
          const syncLookbackSeconds = resolveSyncLookbackSeconds(
            lookbackEnv ?? prefs?.syncLookbackSeconds
          );
          const dbUrl = process.env.SALESBINDER_DB_URL;

          // Determine sync target: PG if available, else SQLite
          const pgService = await createPostgresCacheService();
          if (pgService) {
            syncTarget = 'postgresql';
            cacheService = pgService;
            await pgService.ensureAccountBinding(accountBinding);
            console.error('Syncing API → PostgreSQL...');
            syncLockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
            const activeLockLoss = createSyncLockLossGuard();
            const activeLockKey = syncLockKey;
            lockLoss = activeLockLoss;
            lockAcquired = await awaitWhileSyncLockHeld(activeLockLoss, () =>
              pgService.tryAcquireSyncLock(activeLockKey, {
                onLost: activeLockLoss.onLost,
              })
            );
            if (!lockAcquired) {
              throw new Error('Another cache sync is already running for this account.');
            }
          } else {
            syncTarget = 'sqlite';
            const sqliteService = new SQLiteCacheService(accountName);
            cacheService = sqliteService;
            await sqliteService.ensureAccountBinding(accountBinding);
            console.error('Syncing API → SQLite...');
            syncLockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
            lockAcquired = await sqliteService.tryAcquireSyncLock(syncLockKey);
            if (!lockAcquired) {
              throw new Error('Another cache sync is already running for this account.');
            }
          }

          const activeCacheService = cacheService;
          // Decide before accounts can create state in an empty cache. Local aliases
          // are display names; the immutable account binding above owns identity.
          const initialState = await awaitWhileSyncLockHeld(lockLoss, () =>
            activeCacheService.getCacheState()
          );
          const effectiveFull = Boolean(options.full || options.fullResume || !initialState);
          if (options.fullResume || options.resetCheckpoint) {
            checkpointStore = new FullResumeCheckpointStore({
              accountName,
              syncTarget,
              schemaVersion: CACHE_SCHEMA_VERSION,
              cacheIdentity: buildFullResumeCacheIdentity({
                accountName,
                syncTarget,
                databaseUrl: dbUrl,
              }),
            });
            if (options.resetCheckpoint) checkpointStore.reset();
            if (options.fullResume) {
              checkpoint = checkpointStore.loadOrCreate();
              if (checkpoint.completedPhases.length > 0) {
                checkpointStore.validateCompletedPhases(
                  checkpoint,
                  await awaitWhileSyncLockHeld(lockLoss, () =>
                    captureFullResumeCacheSnapshot(
                      activeCacheService,
                      accountName,
                      CACHE_SCHEMA_VERSION
                    )
                  )
                );
              }
            }
          }

          preparedInventorySync = await prepareInventorySync({
            backend: syncTarget,
            cache: activeCacheService,
            accountIdentity: accountBinding.accountIdentity,
            forceFull: Boolean(options.full),
            assertWriterLockHeld: () => lockLoss?.assertHeld(),
          });
          const activePreparedInventorySync = preparedInventorySync;

          const syncStartedAtMs = Date.now();
          const currentSyncRunId = `sync-${syncStartedAtMs}-${randomUUID()}`;
          const startedAtSeconds = Math.floor(syncStartedAtMs / 1000);
          // Resumed completed phases may have been scanned in an earlier attempt.
          const safeSyncCutoff = checkpoint?.startedAt ?? startedAtSeconds;
          const syncReporter = new CacheSyncProgressReporter(cacheService, {
            runId: currentSyncRunId,
            accountName,
            syncTarget,
            startedAt: startedAtSeconds,
            syncType: effectiveFull ? 'full' : 'delta',
          });
          progressReporter = syncReporter;
          const syncProgress = new CacheSyncProgressController({ reporter: syncReporter });
          progressController = syncProgress;
          const onProgressEvent = syncProgress.onProgressEvent;
          const onProgressHeartbeat = syncProgress.onProgressHeartbeat;
          const clientOptions = {
            rateLimitObserver: syncProgress.rateLimitObserver,
            ...(lockLoss ? { signal: lockLoss.signal } : {}),
          };
          const client = new SalesBinderClient(accountName, clientOptions);
          const v3Client = new SalesBinderV3Client(accountName, clientOptions);
          await awaitWhileSyncLockHeld(lockLoss, () =>
            syncReporter.markRunning({
              message: 'Sync running',
            })
          );

          const accountIndexer = new AccountIndexerService(
            client,
            cacheService,
            accountName,
            syncLookbackSeconds
          );
          const categoryIndexer = new CategoryIndexerService(
            v3Client,
            cacheService,
            accountBinding.accountIdentity,
            '3'
          );
          const indexer = new DocumentIndexerService(
            client,
            cacheService,
            accountName,
            prefs?.cacheStaleSeconds,
            syncLookbackSeconds,
            { deferGlobalWatermark: true }
          );
          const deletedLogSync = new DeletedLogSyncService(
            client,
            cacheService,
            accountName,
            syncLookbackSeconds
          );
          const activeResume: ActiveFullResume | null =
            checkpoint && checkpointStore ? { checkpoint, store: checkpointStore } : null;
          const captureCheckpointSnapshot = () =>
            captureFullResumeCacheSnapshot(activeCacheService, accountName, CACHE_SCHEMA_VERSION);
          const runFullResumePhase = async <T extends object>(
            phase: FullResumePhase,
            runPhase: () => Promise<T>
          ): Promise<T> => {
            lockLoss?.assertHeld();
            if (!activeResume) {
              return await awaitWhileSyncLockHeld(lockLoss, runPhase);
            }
            if (activeResume.store.isPhaseComplete(activeResume.checkpoint, phase)) {
              console.error(`Skipping ${phase} phase: full-resume checkpoint already complete`);
              return activeResume.store.getPhaseResult(
                activeResume.checkpoint,
                phase
              ) as unknown as T;
            }
            activeResume.store.markPhaseStarted(activeResume.checkpoint, phase);
            const phaseResult = await awaitWhileSyncLockHeld(lockLoss, runPhase);
            const snapshot = await awaitWhileSyncLockHeld(lockLoss, captureCheckpointSnapshot);
            activeResume.store.markPhaseComplete(
              activeResume.checkpoint,
              phase,
              phaseResult,
              snapshot
            );
            return phaseResult;
          };

          const accountResult = await runFullResumePhase('accounts', () =>
            accountIndexer.sync({
              full: effectiveFull,
              onProgressEvent,
            })
          );

          const categoryResult = await runFullResumePhase<{
            categoriesProcessed: number;
            snapshot: CategorySnapshot | null;
          }>('categories', () => categoryIndexer.sync({ onProgressEvent }));

          const result = await runFullResumePhase<SyncResult>('documents', () =>
            indexer.sync({
              full: effectiveFull,
              resume: activeResume
                ? {
                    documents: activeResume.checkpoint.documents,
                    onDocumentCheckpoint: (position) =>
                      activeResume.store.markDocumentPosition(activeResume.checkpoint, position),
                  }
                : undefined,
              onProgressEvent,
            })
          );

          const runInventory = () =>
            runPreparedInventorySync({
              prepared: activePreparedInventorySync,
              cache: activeCacheService,
              client: v3Client,
              accountName,
              accountIdentity: accountBinding.accountIdentity,
              signal: lockLoss?.signal ?? new AbortController().signal,
              assertWriterLockHeld: () => lockLoss?.assertHeld(),
              onProgressEvent,
              onProgressHeartbeat,
            });
          // Feed-backed inventory owns a durable PostgreSQL checkpoint. Keep the
          // file checkpoint for accounts/categories/documents only.
          const itemResult =
            activePreparedInventorySync.selection.mode === 'compatibility_snapshot'
              ? normalizeCompatibilityInventorySyncResult(
                  await runFullResumePhase('items', runInventory)
                )
              : await awaitWhileSyncLockHeld(lockLoss, runInventory);

          const indexedRecordIssues = collectSyncRecordIssues(result, itemResult);
          let deletedResult: DeletedLogSyncResult;
          let recordIssues: SyncRecordIssue[];
          if (!activeResume) {
            deletedResult = await awaitWhileSyncLockHeld(lockLoss, () =>
              deletedLogSync.sync({
                onProgressEvent,
                includeItemDeletes: false,
              })
            );
            recordIssues = reconcileDeletedDocumentWarnings(
              indexedRecordIssues,
              deletedResult.documentTombstones
            );
            await awaitWhileSyncLockHeld(lockLoss, () =>
              finalizeResolvedInvoicePaymentStatus(
                activeCacheService,
                result.type,
                indexedRecordIssues,
                recordIssues
              )
            );
          } else {
            const restoredDeletedLogPhase = activeResume.store.isPhaseComplete(
              activeResume.checkpoint,
              'deleted-log'
            );
            const cacheStateBeforeDeletedLog = restoredDeletedLogPhase
              ? null
              : await awaitWhileSyncLockHeld(lockLoss, () => activeCacheService.getCacheState());
            if (restoredDeletedLogPhase) {
              console.error('Skipping deleted-log phase: full-resume checkpoint already complete');
            } else {
              activeResume.store.markPhaseStarted(activeResume.checkpoint, 'deleted-log');
            }
            let paymentStatusBeforeFinalization: PaymentSyncStatus | null = null;
            const checkpointBeforeCompletion = {
              phase: activeResume.checkpoint.phase,
              updatedAt: activeResume.checkpoint.updatedAt,
              completedPhases: [...activeResume.checkpoint.completedPhases],
              phaseEvidence: { ...activeResume.checkpoint.phaseEvidence },
              phaseResults: { ...activeResume.checkpoint.phaseResults },
            };
            try {
              deletedResult = restoredDeletedLogPhase
                ? activeResume.store.getPhaseResult(activeResume.checkpoint, 'deleted-log')
                : await awaitWhileSyncLockHeld(lockLoss, () =>
                    deletedLogSync.sync({
                      onProgressEvent,
                      includeItemDeletes: false,
                    })
                  );
              recordIssues = reconcileDeletedDocumentWarnings(
                indexedRecordIssues,
                deletedResult.documentTombstones
              );
              const previousPaymentStatus = await awaitWhileSyncLockHeld(lockLoss, () =>
                finalizeResolvedInvoicePaymentStatus(
                  activeCacheService,
                  result.type,
                  indexedRecordIssues,
                  recordIssues,
                  (status) => {
                    paymentStatusBeforeFinalization = status;
                  }
                )
              );
              if (!restoredDeletedLogPhase || previousPaymentStatus) {
                const snapshot = await awaitWhileSyncLockHeld(lockLoss, captureCheckpointSnapshot);
                activeResume.store.markPhaseComplete(
                  activeResume.checkpoint,
                  'deleted-log',
                  deletedResult,
                  snapshot
                );
              }
            } catch (error) {
              Object.assign(activeResume.checkpoint, checkpointBeforeCompletion);
              if (paymentStatusBeforeFinalization) {
                try {
                  await activeCacheService.setPaymentSyncStatus(paymentStatusBeforeFinalization);
                } catch {
                  // Preserve the finalization failure; resume remains fail-closed if rollback fails.
                }
              }
              if (!restoredDeletedLogPhase) {
                try {
                  const latestState = await activeCacheService.getCacheState();
                  if (latestState) {
                    const restoredState = { ...latestState };
                    if (cacheStateBeforeDeletedLog?.lastDeletedSync === undefined) {
                      delete restoredState.lastDeletedSync;
                    } else {
                      restoredState.lastDeletedSync = cacheStateBeforeDeletedLog.lastDeletedSync;
                    }
                    await activeCacheService.setCacheState(restoredState);
                  }
                } catch {
                  // Preserve the finalization failure; resume remains fail-closed if rollback fails.
                }
              }
              throw error;
            }
          }
          const failedDocuments = recordIssues.filter((issue) => issue.resource === 'document');
          const failedItems = recordIssues.filter((issue) => issue.resource === 'item');
          const hasWarnings =
            recordIssues.length > 0 || itemResult.status === 'success_with_warnings';
          const cloudSyncFinishedAt = Math.floor(Date.now() / 1000);

          const finalState = await awaitWhileSyncLockHeld(lockLoss, () =>
            activeCacheService.getCacheState()
          );
          const categoryMeta = await awaitWhileSyncLockHeld(lockLoss, () =>
            activeCacheService.getCategoryCacheMeta()
          );
          const [documentCount, itemDocumentCount, itemCount, categoryCount, stockLocationCount] =
            await awaitWhileSyncLockHeld(lockLoss, () =>
              Promise.all([
                activeCacheService.getDocumentCount(),
                activeCacheService.getItemDocumentCount(),
                activeCacheService.getItemCount(),
                activeCacheService.getCategoryCount(),
                activeCacheService.getStockLocationCount(),
              ])
            );
          const baseState = finalState ?? {
            accountName,
            schemaVersion: CACHE_SCHEMA_VERSION,
            documentCount: 0,
            itemDocumentCount: 0,
            lastSync: 0,
            lastFullSync: 0,
          };
          await awaitWhileSyncLockHeld(lockLoss, () =>
            activeCacheService.setCacheState({
              ...baseState,
              // Warning runs retain the last clean global watermarks so unresolved
              // records are reconsidered on the next attempt.
              ...(hasWarnings
                ? {}
                : {
                    lastSync: safeSyncCutoff,
                    ...(effectiveFull ? { lastFullSync: safeSyncCutoff } : {}),
                  }),
              lastSyncAttempt: cloudSyncFinishedAt,
              documentCount,
              itemDocumentCount,
              accountName,
              schemaVersion: CACHE_SCHEMA_VERSION,
              itemCount,
              categoryCount,
              lastCategorySync: categoryMeta?.completedAt ?? finalState?.lastCategorySync,
              stockLocationCount,
            })
          );

          // If we synced to PG, also pull PG → SQLite
          let pullInfo: {
            pulled: boolean;
            accounts?: number;
            categories?: number;
            documents?: number;
            itemDocuments?: number;
            paymentTransactions?: number;
            items?: number;
            stockRows?: number;
            duration?: string;
          } = { pulled: false };
          const terminalSummary = {
            message: hasWarnings ? 'Sync completed with warnings' : 'Sync completed',
            syncType: result.type,
            documentsProcessed: result.documentsProcessed,
            lineItemsProcessed: result.lineItemsProcessed,
            itemsProcessed: itemResult.itemsProcessed,
            categoriesProcessed: categoryResult.categoriesProcessed,
            stockRowsProcessed: itemResult.stockRowsProcessed,
            deletedRecordsProcessed: deletedResult.deletedRecordsProcessed,
          };
          const terminalSyncTarget = syncTarget;
          if (!terminalSyncTarget) throw new Error('Cache sync target is not initialized.');
          const recordCheckpointFailure = (error: unknown): void => {
            if (!checkpointStore || !checkpoint) return;
            checkpointFailureRecorded = true;
            try {
              checkpointStore.recordFailure(checkpoint, error);
            } catch {
              // The original sync failure remains authoritative.
            }
          };
          const markSuccessfulTerminal = async (): Promise<void> => {
            syncProgress.onProgressEvent({
              phase: 'finalizing',
              event: 'phase_started',
              recordsProcessed: 0,
              recordsTotal: null,
              indeterminate: true,
            });
            syncProgress.onProgressEvent({
              phase: 'finalizing',
              event: 'phase_completed',
              recordsProcessed: recordIssues.length,
              recordsTotal: recordIssues.length,
              indeterminate: false,
            });
            const failedAt = Math.max(Math.floor(Date.now() / 1000), startedAtSeconds);
            postSuccessFailureStatus = {
              status: 'failed',
              runId: currentSyncRunId,
              accountName,
              syncTarget: terminalSyncTarget,
              startedAt: startedAtSeconds,
              updatedAt: failedAt,
              finishedAt: failedAt,
              syncType: effectiveFull ? 'full' : 'delta',
              message: 'Sync failed',
              error: 'Cache sync failed.',
            };
            await awaitWhileSyncLockHeld(lockLoss, async () => {
              await (hasWarnings
                ? syncReporter.markSuccessWithWarnings(terminalSummary, recordIssues)
                : syncReporter.markSuccess(terminalSummary));
              terminalRequested = true;
            });
          };
          const markFailedTerminal = async (error: unknown): Promise<void> => {
            recordCheckpointFailure(error);
            if (postSuccessFailureStatus) {
              postSuccessFailureAttempted = true;
              terminalRequested = true;
              await activeCacheService.setSyncStatus(postSuccessFailureStatus);
              return;
            }
            await syncReporter.markFailure(error, { message: 'Sync failed' });
            terminalRequested = true;
          };
          if (pgService && dbUrl && options.pull) {
            const inheritedLockLoss = lockLoss;
            if (!inheritedLockLoss) {
              throw new Error('PostgreSQL sync lock guard is not initialized.');
            }
            syncProgress.onProgressEvent({
              phase: 'pg-to-sqlite-pull',
              event: 'phase_started',
              recordsProcessed: 0,
              recordsTotal: null,
              indeterminate: true,
            });
            await awaitWhileSyncLockHeld(lockLoss, () => syncReporter.flush());
            // Keep the outer PostgreSQL writer lock continuously held. The pull
            // service locks SQLite but reuses this run's PG lock ownership.
            console.error('Pulling PostgreSQL → SQLite...');
            inheritedLockLoss.assertHeld();
            await pullFromPostgres(dbUrl, accountName, undefined, accountBinding, {
              pgLockAlreadyHeld: true,
              lockLossSignal: inheritedLockLoss.signal,
              onSettledWhileLocked: async (settlement) => {
                if (settlement.status === 'failed') {
                  await markFailedTerminal(settlement.error);
                  return;
                }
                inheritedLockLoss.assertHeld();
                const pullResult = settlement.result;
                pullInfo = {
                  pulled: true,
                  accounts: pullResult.accountsPulled,
                  categories: pullResult.categoriesPulled,
                  documents: pullResult.documentsPulled,
                  itemDocuments: pullResult.itemDocumentsPulled,
                  paymentTransactions: pullResult.paymentTransactionsPulled,
                  items: pullResult.itemsPulled,
                  stockRows: pullResult.stockRowsPulled,
                  duration: pullResult.duration,
                };
                console.error(
                  `Pull complete: ${pullResult.documentsPulled} docs in ${pullResult.duration}`
                );
                syncProgress.onProgressEvent({
                  phase: 'pg-to-sqlite-pull',
                  event: 'phase_completed',
                  recordsProcessed: pullResult.documentsPulled,
                  recordsTotal: pullResult.documentsPulled,
                  indeterminate: false,
                });
                await markSuccessfulTerminal();
              },
              onPostSuccessFailureWhileLocked: markFailedTerminal,
            });
            inheritedLockLoss.assertHeld();
          } else {
            await markSuccessfulTerminal();
          }

          const duration = `${((Date.now() - syncStartedAtMs) / 1000).toFixed(1)}s`;

          const output = {
            success: true,
            status: hasWarnings ? 'success_with_warnings' : 'success',
            sync_target: syncTarget,
            sync_type: result.type,
            sync_lookback_seconds: result.syncLookbackSeconds,
            inventory_source_api_version: '3',
            inventory_sync: {
              mode: itemResult.mode,
              status: itemResult.status,
              baseline_generation: itemResult.baselineGeneration,
              baseline_promoted: itemResult.baselinePromoted,
              ledger_promoted: itemResult.ledgerPromoted,
              target_event_seq: itemResult.targetEventSeq,
              observed_through_event_seq: itemResult.observedThroughEventSeq,
              applied_through_event_seq: itemResult.appliedThroughEventSeq,
              blocked_by_event_seq: itemResult.blockedByEventSeq,
              events_claimed: itemResult.eventsClaimed,
              events_completed: itemResult.eventsCompleted,
              events_failed: itemResult.eventsFailed,
              issues: itemResult.feedIssues,
            },
            accounts_processed: accountResult.accountsProcessed,
            customers_processed: accountResult.customersProcessed,
            suppliers_processed: accountResult.suppliersProcessed,
            documents_processed: result.documentsProcessed,
            documents_deleted: result.documentsDeleted || 0,
            line_items_processed: result.lineItemsProcessed,
            items_processed: itemResult.itemsProcessed,
            categories_processed: categoryResult.categoriesProcessed,
            categories: categoryMeta ?? 'not_initialized',
            stock_rows_processed: itemResult.stockRowsProcessed,
            deleted_records_processed: deletedResult.deletedRecordsProcessed,
            failed_documents: failedDocuments,
            failed_items: failedItems,
            duration,
            document_sync_duration: result.duration,
            ...(pgService &&
              !options.pull && {
                pg_to_sqlite_pull: {
                  skipped: true,
                  reason: 'Use --pull to refresh the local SQLite mirror after PostgreSQL sync.',
                },
              }),
            ...(pullInfo.pulled && {
              pg_to_sqlite_pull: {
                accounts: pullInfo.accounts,
                categories: pullInfo.categories,
                documents: pullInfo.documents,
                item_documents: pullInfo.itemDocuments,
                payment_transactions: pullInfo.paymentTransactions,
                items: pullInfo.items,
                stock_rows: pullInfo.stockRows,
                duration: pullInfo.duration,
              },
            }),
            ...(options.fullResume && {
              full_resume: {
                checkpoint_path: checkpointStore?.checkpointPath,
                completed_phases: checkpoint?.completedPhases ?? [],
                granularity:
                  itemResult.mode === 'compatibility_snapshot'
                    ? 'phase+document-replay+atomic-v3-inventory-snapshot'
                    : 'phase+document-replay+database-backed-inventory-resume',
                document_position: checkpoint?.documents,
                item_position: checkpoint?.items,
              },
            }),
            message: hasWarnings
              ? `Sync completed with ${recordIssues.length} unresolved record warning(s) in ${duration}`
              : `Sync complete: ${result.documentsProcessed} documents, ${categoryResult.categoriesProcessed} categories, ${itemResult.itemsProcessed} items in ${duration}`,
          };

          lockLoss?.assertHeld();
          syncProgress.finish();
          console.log(formatJson(output));
          const retainDocumentCheckpointForFeedRetry =
            options.fullResume &&
            itemResult.mode !== 'compatibility_snapshot' &&
            itemResult.status === 'success_with_warnings';
          if (options.fullResume && checkpointStore && !retainDocumentCheckpointForFeedRetry) {
            try {
              lockLoss?.assertHeld();
              checkpointStore.removeAfterSuccess();
            } catch {
              console.error(
                'Sync completed, but the full-resume checkpoint could not be removed. ' +
                  'It was retained for a validated retry; use --reset-checkpoint to clear it.'
              );
            }
          } else if (retainDocumentCheckpointForFeedRetry) {
            console.error(
              'Inventory change-feed work remains resumable; retaining the document checkpoint for the next --full-resume attempt.'
            );
          }
        } catch (error) {
          const safeError = toSafeCacheSyncError(error, Boolean(progressReporter));
          if (checkpointStore && checkpoint && !checkpointFailureRecorded) {
            try {
              checkpointStore.recordFailure(checkpoint, safeError);
            } catch {
              // Preserve the original sync error when checkpoint persistence fails.
            }
          }
          try {
            if (cacheService && postSuccessFailureStatus && !postSuccessFailureAttempted) {
              postSuccessFailureAttempted = true;
              terminalRequested = true;
              try {
                await cacheService.setSyncStatus(postSuccessFailureStatus);
              } catch {
                // Same-run compensation is best-effort and must not mask the pull failure.
              }
            } else if (progressReporter && !terminalRequested) {
              await progressReporter.markFailure(safeError, { message: 'Sync failed' });
              terminalRequested = true;
            }
          } catch {
            // Preserve original sync error.
          }
          progressController?.finish();
          console.error(formatError(safeError));
          process.exitCode = 1;
        } finally {
          try {
            await closePreparedInventorySync(preparedInventorySync);
          } catch {
            // Cache lock release remains mandatory even if the ledger pool close fails.
          }
          await releaseCacheWriterLockAndClose(cacheService, syncLockKey, lockAcquired);
        }
      }
    );

  // Clear command
  cache
    .command('clear')
    .description(
      `Delete or truncate local cache

Example:
  salesbinder cache clear
  salesbinder cache clear --force-unbound

For SQLite: removes the local cache file.
For PostgreSQL: truncates all cache tables.
Use --force-unbound only to delete a legacy SQLite cache that has no account-binding markers.
It never overrides an existing binding.
Next sync will perform a full resync.`
    )
    .option(
      '--force-unbound',
      'Delete a legacy SQLite cache only when account-binding markers are absent'
    )
    .action(async (options: { forceUnbound?: boolean }) => {
      let cacheService: CacheService | null = null;
      let lockKey: string | null = null;
      let lockAcquired = false;
      let lockLoss: SyncLockLossGuard | null = null;

      try {
        const dbUrl = process.env.SALESBINDER_DB_URL;
        const accountName = program.opts().account || 'default';

        if (dbUrl) {
          if (options.forceUnbound) {
            throw new Error('--force-unbound applies only to the SQLite cache backend.');
          }
          // PostgreSQL: truncate tables
          const { PostgresCacheService, createSalesBinderAccountBinding, loadConfig } =
            await import('@salesbinder/sdk');
          const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
          const pgCache = new PostgresCacheService(dbUrl);
          cacheService = pgCache;
          await pgCache.ensureSchema();
          await pgCache.ensureAccountBinding(accountBinding);
          lockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
          const activeLockLoss = createSyncLockLossGuard();
          const activeLockKey = lockKey;
          lockLoss = activeLockLoss;
          lockAcquired = await awaitWhileSyncLockHeld(activeLockLoss, () =>
            pgCache.tryAcquireSyncLock(activeLockKey, { onLost: activeLockLoss.onLost })
          );
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
          await awaitWhileSyncLockHeld(lockLoss, () => pgCache.truncateAll());
          activeLockLoss.assertHeld();
          console.log(
            formatJson({
              success: true,
              message: 'PostgreSQL cache tables truncated',
              backend: 'postgresql',
              next_sync: 'full',
            })
          );
        } else {
          // SQLite: delete file
          const sanitizedAccount = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const cacheDir = join(homedir(), '.salesbinder', 'cache');
          const cacheFile = join(cacheDir, `salesbinder-${sanitizedAccount}.db`);

          // Also check for WAL and SHM files
          const walFile = `${cacheFile}-wal`;
          const shmFile = `${cacheFile}-shm`;

          if (!existsSync(cacheFile)) {
            console.log(
              formatJson({
                success: true,
                message: 'Cache file does not exist',
                cache_file: cacheFile,
              })
            );
            return;
          }

          const { SQLiteCacheService } = await import('@salesbinder/sdk');
          const sqliteCache = new SQLiteCacheService(accountName);
          cacheService = sqliteCache;
          if (options.forceUnbound) {
            await sqliteCache.verifyUnboundForDeletion();
            lockKey = `salesbinder-cache-file:${cacheFile}`;
          } else {
            const { createSalesBinderAccountBinding, loadConfig } =
              await import('@salesbinder/sdk');
            const accountBinding = createSalesBinderAccountBinding(
              loadConfig(accountName).subdomain
            );
            await sqliteCache.verifyAccountBinding(accountBinding);
            lockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
          }
          lockAcquired = await sqliteCache.tryAcquireSyncLock(lockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }

          // Get file size before deletion
          const stats = statSync(cacheFile);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

          // Close SQLite while retaining the external lock. This checkpoints
          // WAL state and prevents unlinking an actively-open database handle.
          sqliteCache.closeDatabaseForDeletion();

          // Delete cache file and related files
          unlinkSync(cacheFile);
          if (existsSync(walFile)) unlinkSync(walFile);
          if (existsSync(shmFile)) unlinkSync(shmFile);

          console.log(
            formatJson({
              success: true,
              message: `Cache deleted (${sizeMB} MB)`,
              cache_file: cacheFile,
              next_sync: 'full',
            })
          );
        }
      } catch (error) {
        console.error(formatError(lockLoss?.safeError(error) ?? (error as Error)));
        process.exitCode = 1;
      } finally {
        await releaseCacheWriterLockAndClose(cacheService, lockKey, lockAcquired);
      }
    });

  // CSV export import command
  cache
    .command('import-export <directory>')
    .description(
      `Seed cache from local SalesBinder CSV exports

Examples:
  salesbinder cache import-export data/ --dry-run
  salesbinder cache import-export data/
  salesbinder cache import-export data/ --target postgresql

Validates and imports local customer, supplier, invoice, PO, and inventory exports.
No historical SalesBinder API requests are made.`
    )
    .option('--dry-run', 'Validate files and report counts without writing')
    .option('--target <backend>', 'Cache backend: sqlite or postgresql')
    .action(async (directory: string, options: { dryRun?: boolean; target?: string }) => {
      let cacheService: CacheService | null = null;
      let ensurePostgresSchema: (() => Promise<void>) | null = null;
      let postgresCacheService: PostgresSyncLockService | null = null;
      let lockKey: string | null = null;
      let lockAcquired = false;
      let lockLoss: SyncLockLossGuard | null = null;

      try {
        const {
          CsvCacheImportService,
          SQLiteCacheService,
          PostgresCacheService,
          createSalesBinderAccountBinding,
          loadConfig,
        } = await import('@salesbinder/sdk');
        const accountName = program.opts().account || 'default';
        const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
        const databaseUrlEnv = ['SALESBINDER', 'DB', 'URL'].join('_');
        const dbUrl = process.env[databaseUrlEnv];
        const target = (options.target || (dbUrl ? 'postgresql' : 'sqlite')).toLowerCase();

        if (!['sqlite', 'postgresql'].includes(target)) {
          throw new Error('Invalid --target. Use sqlite or postgresql.');
        }

        if (target === 'postgresql') {
          if (!dbUrl)
            throw new Error(
              'Database URL environment variable is required for --target postgresql.'
            );
          const pgCache = new PostgresCacheService(dbUrl);
          cacheService = pgCache;
          postgresCacheService = pgCache;
          ensurePostgresSchema = () => pgCache.ensureSchema();
        } else {
          cacheService = new SQLiteCacheService(accountName);
        }

        if (!options.dryRun) {
          if (ensurePostgresSchema) await ensurePostgresSchema();
          const activeCacheService = cacheService;
          await activeCacheService.ensureAccountBinding(accountBinding);
          lockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
          if (postgresCacheService) {
            const activePostgresCacheService = postgresCacheService;
            const activeLockLoss = createSyncLockLossGuard();
            const activeLockKey = lockKey;
            lockLoss = activeLockLoss;
            lockAcquired = await awaitWhileSyncLockHeld(activeLockLoss, () =>
              activePostgresCacheService.tryAcquireSyncLock(activeLockKey, {
                onLost: activeLockLoss.onLost,
              })
            );
          } else {
            lockAcquired = await activeCacheService.tryAcquireSyncLock(lockKey);
          }
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        }
        console.error(`${options.dryRun ? 'Validating' : 'Importing'} CSV exports -> ${target}...`);
        const activeCacheService = cacheService;
        const importer = new CsvCacheImportService(activeCacheService);
        const result = await awaitWhileSyncLockHeld(lockLoss, () =>
          importer.importDirectory(directory, {
            dryRun: options.dryRun,
            accountName,
          })
        );
        lockLoss?.assertHeld();
        console.log(formatJson({ ...result, backend: target }));
      } catch (error) {
        console.error(formatError(lockLoss?.safeError(error) ?? (error as Error)));
        process.exitCode = 1;
      } finally {
        await releaseCacheWriterLockAndClose(cacheService, lockKey, lockAcquired);
      }
    });

  registerCacheStatusCommand(cache, program);

  // Pull command (PG → SQLite)
  cache
    .command('pull')
    .description(
      `Pull data from PostgreSQL into local SQLite cache

Examples:
  salesbinder cache pull

Requires SALESBINDER_DB_URL environment variable.
Downloads all cached data from shared PostgreSQL into local SQLite for fast offline reads.
This pull is explicit; normal cache reads and normal cache sync do not refresh SQLite.`
    )
    .action(async () => {
      try {
        const dbUrl = process.env.SALESBINDER_DB_URL;
        if (!dbUrl) {
          console.error(
            formatError(
              new Error('SALESBINDER_DB_URL is not set. Pull requires a PostgreSQL backend.')
            )
          );
          process.exitCode = 1;
          return;
        }

        const { createSalesBinderAccountBinding, loadConfig, pullFromPostgres } =
          await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
        console.error('Pulling PostgreSQL → SQLite...');

        const result = await pullFromPostgres(dbUrl, accountName, undefined, accountBinding);

        console.log(
          formatJson({
            success: true,
            accounts_pulled: result.accountsPulled,
            categories_pulled: result.categoriesPulled,
            documents_pulled: result.documentsPulled,
            item_documents_pulled: result.itemDocumentsPulled,
            payment_transactions_pulled: result.paymentTransactionsPulled,
            items_pulled: result.itemsPulled,
            stock_rows_pulled: result.stockRowsPulled,
            duration: result.duration,
            message: `Pull complete: ${result.documentsPulled} documents, ${result.itemDocumentsPulled} line items, ${result.paymentTransactionsPulled} payments in ${result.duration}`,
          })
        );
      } catch (error) {
        console.error(formatError(error as Error));
        process.exitCode = 1;
      }
    });
}

async function releaseCacheWriterLockAndClose(
  cacheService: CacheService | null,
  lockKey: string | null,
  lockAcquired: boolean
): Promise<void> {
  try {
    if (cacheService && lockKey && lockAcquired) {
      await cacheService.releaseSyncLock(lockKey);
    }
  } catch {
    // Closing the service below is the final lock-release fallback.
  }
  try {
    if (cacheService) await cacheService.close();
  } catch {
    // Ignore cleanup errors after the command result is set.
  }
}

async function captureFullResumeCacheSnapshot(
  cacheService: CacheService,
  accountName: string,
  schemaVersion: number
): Promise<ResumeCacheSnapshot> {
  const state = await cacheService.getCacheState();
  const categoryMeta = await cacheService.getCategoryCacheMeta();
  const inventoryMeta = await cacheService.getInventoryCacheMeta();
  const [
    accountCount,
    categoryCount,
    documentCount,
    itemDocumentCount,
    paymentTransactionCount,
    paymentSyncStatus,
    itemCount,
    stockLocationCount,
  ] = await Promise.all([
    cacheService.getAccountCount(),
    cacheService.getCategoryCount(),
    cacheService.getDocumentCount(),
    cacheService.getItemDocumentCount(),
    cacheService.getPaymentTransactionCount(),
    cacheService.getPaymentSyncStatus(),
    cacheService.getItemCount(),
    cacheService.getStockLocationCount(),
  ]);
  return {
    accountName,
    schemaVersion: state?.schemaVersion ?? schemaVersion,
    accountCount,
    categoryCount,
    categoryStatus: categoryMeta ? 'complete' : 'uninitialized',
    categoryCompletedAt: categoryMeta?.completedAt ?? null,
    categorySchemaVersion: categoryMeta?.schemaVersion ?? null,
    categoryGeneration: categoryMeta?.generation ?? null,
    categoryFingerprint: categoryMeta?.fingerprint ?? null,
    inventoryStatus: inventoryMeta?.status ?? 'uninitialized',
    inventoryCompletedAt: inventoryMeta?.completedAt ?? null,
    inventorySchemaVersion: inventoryMeta?.schemaVersion ?? null,
    inventorySourceApiVersion: inventoryMeta?.sourceApiVersion ?? null,
    inventoryGeneration: inventoryMeta?.generation ?? null,
    inventoryFingerprint: inventoryMeta?.fingerprint ?? null,
    documentCount,
    itemDocumentCount,
    paymentTransactionCount,
    paymentSyncStatusFingerprint: buildPaymentSyncStatusFingerprint(paymentSyncStatus),
    itemCount,
    stockLocationCount,
    lastAccountSync: state?.lastAccountSync ?? null,
    lastDocumentSync: state?.lastDocumentSync ?? null,
    lastItemSync: state?.lastItemSync ?? null,
    lastDeletedSync: state?.lastDeletedSync ?? null,
  };
}

function collectSyncRecordIssues(...results: object[]): SyncRecordIssue[] {
  const unique = new Map<string, SyncRecordIssue>();
  for (const result of results) {
    if (!('recordIssues' in result) || result.recordIssues === undefined) continue;
    if (!Array.isArray(result.recordIssues))
      throw new Error('Cache indexer returned invalid record issues.');
    for (const candidate of result.recordIssues) {
      const issue = projectSyncRecordIssue(candidate);
      const key = `${issue.resource}:${issue.id}`;
      const previous = unique.get(key);
      if (previous) {
        const merged = mergeDuplicateSyncRecordIssue(previous, issue);
        if (merged) {
          unique.set(key, merged);
          continue;
        }
        if (JSON.stringify(previous) !== JSON.stringify(issue)) {
          throw new Error(`Cache indexer returned conflicting warnings for ${key}.`);
        }
        throw new Error(`Cache indexer returned duplicate warnings for ${key}.`);
      }
      unique.set(key, issue);
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareUtf16CodeUnits(left.resource, right.resource) ||
      (left.context_id ?? -1) - (right.context_id ?? -1) ||
      compareUtf16CodeUnits(left.id, right.id)
  );
}

function mergeDuplicateSyncRecordIssue(
  previous: SyncRecordIssue,
  next: SyncRecordIssue
): SyncRecordIssue | null {
  if (previous.resource !== 'item' || next.resource !== 'item') return null;
  return compareItemRecordIssueSeverity(next, previous) < 0 ? next : previous;
}

function compareItemRecordIssueSeverity(
  left: Extract<SyncRecordIssue, { resource: 'item' }>,
  right: Extract<SyncRecordIssue, { resource: 'item' }>
): number {
  return (
    itemOutcomePriority(right.outcome) - itemOutcomePriority(left.outcome) ||
    itemIssueCodePriority(right.code) - itemIssueCodePriority(left.code) ||
    compareUtf16CodeUnits(left.message, right.message)
  );
}

function itemOutcomePriority(outcome: SyncRecordIssue['outcome']): number {
  return outcome === 'preserved_last_known_good' ? 1 : 0;
}

function itemIssueCodePriority(
  code: Extract<SyncRecordIssue, { resource: 'item' }>['code']
): number {
  return { not_found: 0, content_changed: 1, invalid_variations: 2, invalid_record: 3 }[code];
}

function reconcileDeletedDocumentWarnings(
  recordIssues: SyncRecordIssue[],
  value: unknown
): SyncRecordIssue[] {
  const tombstones = projectDeletedDocumentTombstones(value);
  const identities = new Set(
    tombstones.map(({ contextId, apiDocumentId }) => JSON.stringify([contextId, apiDocumentId]))
  );
  return recordIssues.filter(
    (issue) =>
      issue.resource !== 'document' ||
      issue.context_id === undefined ||
      !identities.has(JSON.stringify([issue.context_id, issue.id]))
  );
}

function projectDeletedDocumentTombstones(value: unknown): FullResumeDocumentTombstone[] {
  if (!Array.isArray(value)) {
    throw new Error('Deleted-log sync returned invalid document tombstones.');
  }
  const tombstones: FullResumeDocumentTombstone[] = [];
  const identities = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.contextId !== 4 && candidate.contextId !== 5 && candidate.contextId !== 11)
    ) {
      throw new Error('Deleted-log sync returned an invalid document tombstone.');
    }
    const tombstone = {
      contextId: candidate.contextId,
      apiDocumentId: requireCanonicalSyncRecordIssueId(candidate.apiDocumentId),
    } satisfies FullResumeDocumentTombstone;
    const identity = JSON.stringify([tombstone.contextId, tombstone.apiDocumentId]);
    if (identities.has(identity)) {
      throw new Error('Deleted-log sync returned a duplicate document tombstone.');
    }
    identities.add(identity);
    tombstones.push(tombstone);
  }
  return tombstones.sort(
    (left, right) =>
      left.contextId - right.contextId ||
      compareUtf16CodeUnits(left.apiDocumentId, right.apiDocumentId)
  );
}

const UNRESOLVED_INVOICE_PAYMENT_ERROR =
  'Invoice document refresh completed with unresolved records.';

async function finalizeResolvedInvoicePaymentStatus(
  cacheService: CacheService,
  syncType: SyncResult['type'],
  beforeReconciliation: SyncRecordIssue[],
  afterReconciliation: SyncRecordIssue[],
  beforeChange?: (status: PaymentSyncStatus) => void
): Promise<PaymentSyncStatus | null> {
  const hadInvoiceWarnings = beforeReconciliation.some(isInvoiceWarning);
  if (!hadInvoiceWarnings || afterReconciliation.some(isInvoiceWarning)) return null;

  const paymentStatus = await cacheService.getPaymentSyncStatus();
  if (!isResolvableInvoicePaymentFailure(paymentStatus, syncType)) return null;
  const previousPaymentStatus: PaymentSyncStatus = { ...paymentStatus };
  const completedAt = Math.max(Math.floor(Date.now() / 1000), paymentStatus.updatedAt);
  beforeChange?.(previousPaymentStatus);
  await cacheService.setPaymentSyncStatus({
    status: 'complete',
    mode: paymentStatus.mode,
    startedAt: paymentStatus.startedAt,
    updatedAt: completedAt,
    finishedAt: completedAt,
    lastSuccessfulSync: completedAt,
    cursor: paymentStatus.cursor,
    processedDocuments: paymentStatus.processedDocuments,
    totalDocuments: paymentStatus.totalDocuments,
  });
  return previousPaymentStatus;
}

function isInvoiceWarning(issue: SyncRecordIssue): boolean {
  return issue.resource === 'document' && issue.context_id === 5;
}

function isResolvableInvoicePaymentFailure(
  status: PaymentSyncStatus | null,
  syncType: SyncResult['type']
): status is PaymentSyncStatus & {
  status: 'failed';
  error: typeof UNRESOLVED_INVOICE_PAYMENT_ERROR;
  finishedAt: number;
} {
  return Boolean(
    status &&
    status.status === 'failed' &&
    status.error === UNRESOLVED_INVOICE_PAYMENT_ERROR &&
    status.mode === syncType &&
    isSafeCount(status.startedAt) &&
    isSafeCount(status.updatedAt) &&
    isSafeCount(status.finishedAt) &&
    status.updatedAt >= status.startedAt &&
    status.finishedAt === status.updatedAt &&
    isSafeCount(status.processedDocuments) &&
    status.totalDocuments === status.processedDocuments &&
    (status.lastSuccessfulSync === undefined || isSafeCount(status.lastSuccessfulSync)) &&
    (status.cursor === null || isCanonicalSourceId(status.cursor)) &&
    status.snapshotHash === undefined
  );
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalSourceId(value: unknown): value is string {
  try {
    requireCanonicalSyncRecordIssueId(value);
    return true;
  } catch {
    return false;
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function projectSyncRecordIssue(value: unknown): SyncRecordIssue {
  if (
    !isRecord(value) ||
    (value.resource !== 'document' && value.resource !== 'item') ||
    value.attempts !== 2 ||
    (value.outcome !== 'preserved_last_known_good' && value.outcome !== 'omitted_new')
  ) {
    throw new Error('Cache indexer returned an invalid record warning.');
  }
  const id = requireCanonicalSyncRecordIssueId(value.id);
  const contextId = value.context_id;
  if (
    contextId !== undefined &&
    (value.resource !== 'document' ||
      !Number.isSafeInteger(contextId) ||
      ![4, 5, 11].includes(Number(contextId)))
  ) {
    throw new Error('Cache indexer returned an invalid document warning context.');
  }
  if (value.resource === 'document') {
    if (!isSyncRecordIssueCode('document', value.code)) {
      throw new Error('Cache indexer returned an invalid record warning.');
    }
    const code = value.code;
    return {
      resource: 'document',
      id,
      ...(contextId === undefined ? {} : { context_id: Number(contextId) }),
      code,
      message: canonicalSyncRecordIssueMessage('document', code),
      attempts: 2,
      outcome: value.outcome,
    };
  }
  if (!isSyncRecordIssueCode('item', value.code)) {
    throw new Error('Cache indexer returned an invalid record warning.');
  }
  const code = value.code;
  return {
    resource: 'item',
    id,
    code,
    message: canonicalSyncRecordIssueMessage('item', code),
    attempts: 2,
    outcome: value.outcome,
  };
}

type DocumentSyncRecordIssueCode = Extract<SyncRecordIssue, { resource: 'document' }>['code'];
type ItemSyncRecordIssueCode = Extract<SyncRecordIssue, { resource: 'item' }>['code'];

function isSyncRecordIssueCode(
  resource: 'document',
  value: unknown
): value is DocumentSyncRecordIssueCode;
function isSyncRecordIssueCode(resource: 'item', value: unknown): value is ItemSyncRecordIssueCode;
function isSyncRecordIssueCode(
  resource: SyncRecordIssue['resource'],
  value: unknown
): value is SyncRecordIssue['code'] {
  if (value === 'not_found' || value === 'invalid_record') return true;
  return resource === 'item' && (value === 'invalid_variations' || value === 'content_changed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSafeCacheSyncError(error: unknown, syncStarted: boolean): Error {
  if (error instanceof Error && error.name === 'PostgresSyncLockLostError') {
    return new Error('PostgreSQL sync lock lost.');
  }
  if (error instanceof Error && error.name === 'RateLimitWaitExceededError') {
    return new Error('SalesBinder rate-limit wait exceeded the 15-minute safety ceiling.');
  }
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : '';
  if (
    !syncStarted &&
    (message.startsWith('SalesBinder API v3 key is required') ||
      message === 'Another cache sync is already running for this account.' ||
      message === 'Sync lookback seconds must be a non-negative safe integer.' ||
      message.startsWith('Full-resume checkpoint at ') ||
      errorName === 'ChangeFeedConfigError' ||
      errorName === 'InventorySyncModeError' ||
      errorName === 'ChangeFeedRepositoryError')
  )
    return new Error(message);
  return new Error('Cache sync failed.');
}
