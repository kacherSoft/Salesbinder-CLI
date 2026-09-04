import type { Command } from 'commander';
import type { CacheService } from '@salesbinder/sdk';
import { formatError, formatJson } from '../../output/json.formatter.js';
import {
  awaitWhileSyncLockHeld,
  createSyncLockLossGuard,
  type SyncLockLossGuard,
} from './postgres-sync-lock-loss.guard.js';

type LockableCacheService = CacheService & {
  tryAcquireSyncLock(
    lockKey: string,
    options?: { onLost?: (error: Error) => void }
  ): Promise<boolean>;
  releaseSyncLock(lockKey: string): Promise<void>;
};

export function registerCachePaymentSyncCommand(cache: Command, program: Command): void {
  cache
    .command('sync-payments')
    .description(
      `Backfill invoice payment transactions from cached invoices

Examples:
  salesbinder cache sync-payments

Fetches invoice detail records in deterministic order, replaces each invoice's
payment transaction set atomically, and resumes automatically from the last cursor
stored in cache_meta.payment_sync_status.`
    )
    .action(async () => {
      let cacheService: CacheService | null = null;
      let lockService: LockableCacheService | null = null;
      let lockKey: string | null = null;
      let lockAcquired = false;
      let lockLoss: SyncLockLossGuard | null = null;

      try {
        const {
          createPostgresCacheService,
          createSalesBinderAccountBinding,
          loadConfig,
          PaymentSyncService,
          SalesBinderClient,
          SQLiteCacheService,
        } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
        const pgService = await createPostgresCacheService();
        const activeCacheService = pgService ?? new SQLiteCacheService(accountName);
        cacheService = activeCacheService;
        await activeCacheService.ensureAccountBinding(accountBinding);

        if (supportsSyncLock(activeCacheService)) {
          lockService = activeCacheService;
          lockKey = `salesbinder-cache-sync:${accountBinding.accountIdentity}`;
          if (pgService) {
            const activeLockLoss = createSyncLockLossGuard();
            const activeLockKey = lockKey;
            lockLoss = activeLockLoss;
            lockAcquired = await awaitWhileSyncLockHeld(activeLockLoss, () =>
              pgService.tryAcquireSyncLock(activeLockKey, {
                onLost: activeLockLoss.onLost,
              })
            );
          } else {
            lockAcquired = await lockService.tryAcquireSyncLock(lockKey);
          }
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        }

        const client = new SalesBinderClient(
          accountName,
          lockLoss ? { signal: lockLoss.signal } : undefined
        );
        console.error('Syncing invoice payment transactions...');
        const service = new PaymentSyncService(client, activeCacheService);
        const result = await awaitWhileSyncLockHeld(lockLoss, () =>
          service.syncHistoricalPayments({
            onProgress: (current, total, transactionsProcessed) => {
              console.error(
                `Progress: ${current}/${total} invoices, ${transactionsProcessed} transactions`
              );
            },
          })
        );
        const paymentSyncStatus = await awaitWhileSyncLockHeld(lockLoss, () =>
          activeCacheService.getPaymentSyncStatus()
        );
        const paymentTransactionCount = await awaitWhileSyncLockHeld(lockLoss, () =>
          activeCacheService.getPaymentTransactionCount()
        );
        lockLoss?.assertHeld();
        console.log(
          formatJson({
            success: result.success,
            backend: pgService ? 'postgresql' : 'sqlite',
            mode: result.mode,
            resumed: result.resumed,
            invoices_processed: result.documentsProcessed,
            total_invoices: result.totalDocuments,
            payment_transactions_processed: result.transactionsProcessed,
            payment_transaction_count: paymentTransactionCount,
            cursor: result.cursor,
            duration: result.duration,
            payment_sync_status: paymentSyncStatus ?? 'not_initialized',
          })
        );
      } catch (error) {
        console.error(formatError(lockLoss?.safeError(error) ?? (error as Error)));
        process.exitCode = 1;
      } finally {
        try {
          if (lockService && lockKey && lockAcquired) await lockService.releaseSyncLock(lockKey);
        } catch {
          /* Connection close below is the final lock-release fallback. */
        }
        try {
          if (cacheService) await cacheService.close();
        } catch {
          /* Ignore cleanup errors after command result is set. */
        }
      }
    });
}

function supportsSyncLock(cacheService: CacheService): cacheService is LockableCacheService {
  return 'tryAcquireSyncLock' in cacheService && 'releaseSyncLock' in cacheService;
}
