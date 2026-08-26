import type { Command } from 'commander';
import type { CacheService } from '@salesbinder/sdk';
import { formatError, formatJson } from '../../output/json.formatter.js';

type LockableCacheService = CacheService & {
  tryAcquireSyncLock(lockKey: string): Promise<boolean>;
  releaseSyncLock(lockKey: string): Promise<void>;
};

export function registerCachePaymentSyncCommand(cache: Command, program: Command): void {
  cache
    .command('sync-payments')
    .description(`Backfill invoice payment transactions from cached invoices

Examples:
  salesbinder cache sync-payments

Fetches invoice detail records in deterministic order, replaces each invoice's
payment transaction set atomically, and resumes automatically from the last cursor
stored in cache_meta.payment_sync_status.`)
    .action(async () => {
      let cacheService: CacheService | null = null;
      let lockService: LockableCacheService | null = null;
      let lockKey: string | null = null;

      try {
        const {
          createPostgresCacheService,
          PaymentSyncService,
          SalesBinderClient,
          SQLiteCacheService,
        } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const pgService = await createPostgresCacheService();
        cacheService = pgService ?? new SQLiteCacheService(accountName);

        if (supportsSyncLock(cacheService)) {
          lockService = cacheService;
          lockKey = `salesbinder-cache-sync:${accountName}`;
          const acquired = await lockService.tryAcquireSyncLock(lockKey);
          if (!acquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        }

        console.error('Syncing invoice payment transactions...');
        const service = new PaymentSyncService(client, cacheService);
        const result = await service.syncHistoricalPayments({
          onProgress: (current, total, transactionsProcessed) => {
            console.error(`Progress: ${current}/${total} invoices, ${transactionsProcessed} transactions`);
          },
        });
        const paymentSyncStatus = await cacheService.getPaymentSyncStatus();
        const paymentTransactionCount = await cacheService.getPaymentTransactionCount();

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
          }),
        );
      } catch (error) {
        console.error(formatError(error as Error));
        process.exitCode = 1;
      } finally {
        try {
          if (lockService && lockKey) await lockService.releaseSyncLock(lockKey);
        } catch { /* Connection close below is the final lock-release fallback. */ }
        try {
          if (cacheService) await cacheService.close();
        } catch { /* Ignore cleanup errors after command result is set. */ }
      }
    });
}

function supportsSyncLock(cacheService: CacheService): cacheService is LockableCacheService {
  return 'tryAcquireSyncLock' in cacheService && 'releaseSyncLock' in cacheService;
}
