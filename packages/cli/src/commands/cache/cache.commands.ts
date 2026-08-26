/**
 * Cache management commands
 */

import type { Command } from 'commander';
import type { CacheService } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { registerCachePaymentSyncCommand } from './cache-payment-sync.command.js';

/**
 * Register cache management commands
 */
export function registerCacheCommands(program: Command): void {
  const cache = program.command('cache').description('Local cache management');
  registerCachePaymentSyncCommand(cache, program);

  // Sync command
  cache
    .command('sync')
    .description(`Sync cache with SalesBinder API

Examples:
  salesbinder cache sync
  salesbinder cache sync --full
  salesbinder cache sync --pull

When a PostgreSQL backend is configured: syncs API → PostgreSQL.
Use --pull to also refresh the local SQLite mirror after PostgreSQL sync.
Otherwise: syncs API → SQLite directly.
Use --full to force complete resync.`)
    .option('--full', 'Force full sync (re-download all documents)')
    .option('--pull', 'After PostgreSQL sync, pull PostgreSQL into local SQLite')
    .action(async (options: { full?: boolean; pull?: boolean }) => {
      let cacheService: import('@salesbinder/sdk').CacheService | null = null;
      let syncRunId: string | null = null;
      let syncLockKey: string | null = null;
      let syncStartedAt: number | null = null;
      let syncTarget: 'postgresql' | 'sqlite' | null = null;
      let lockAcquired = false;

      try {
        const {
          SalesBinderClient,
          AccountIndexerService,
          DocumentIndexerService,
          ItemIndexerService,
          DeletedLogSyncService,
          createPostgresCacheService,
          SQLiteCacheService,
          pullFromPostgres,
          loadPreferences,
        } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const dbUrl = process.env.SALESBINDER_DB_URL;

        // Determine sync target: PG if available, else SQLite
        const pgService = await createPostgresCacheService();
        if (pgService) {
          syncTarget = 'postgresql';
          cacheService = pgService;
          console.error('Syncing API → PostgreSQL...');
          syncLockKey = `salesbinder-cache-sync:${accountName}`;
          lockAcquired = await pgService.tryAcquireSyncLock(syncLockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        } else {
          syncTarget = 'sqlite';
          const sqliteService = new SQLiteCacheService(accountName);
          cacheService = sqliteService;
          console.error('Syncing API → SQLite...');
          syncLockKey = `salesbinder-cache-sync:${accountName}`;
          lockAcquired = await sqliteService.tryAcquireSyncLock(syncLockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        }

        syncStartedAt = Date.now();
        syncRunId = `${accountName}-${syncStartedAt}`;
        await cacheService.setSyncStatus({
          status: 'running',
          runId: syncRunId!,
          accountName,
          syncTarget,
          startedAt: Math.floor(syncStartedAt! / 1000),
          updatedAt: Math.floor(syncStartedAt! / 1000),
          message: 'Sync running',
        });

        // Load stale threshold from config
        const prefs = loadPreferences();
        const lookbackEnv = process.env[['SALESBINDER', 'SYNC', 'LOOKBACK', 'SECONDS'].join('_')];
        const syncLookbackSeconds = lookbackEnv ? parseInt(lookbackEnv, 10) : (prefs?.syncLookbackSeconds ?? 604800);
        const accountIndexer = new AccountIndexerService(client, cacheService, accountName, syncLookbackSeconds);
        const indexer = new DocumentIndexerService(
          client,
          cacheService,
          accountName,
          prefs?.cacheStaleSeconds,
          syncLookbackSeconds
        );
        const itemIndexer = new ItemIndexerService(client, cacheService, accountName, syncLookbackSeconds);
        const deletedLogSync = new DeletedLogSyncService(client, cacheService, accountName, syncLookbackSeconds);

        const accountResult = await accountIndexer.sync(options.full);
        const result = await indexer.sync({
          full: options.full,
          onProgress: (current, total) => {
            if (total > 0) {
              const percent = Math.round((current / total) * 100);
              console.error(`Progress: ${current}/${total} (${percent}%)`);
            } else {
              console.error(`Processed: ${current} documents`);
            }
          },
        });
        const itemResult = await itemIndexer.sync(options.full);
        const deletedResult = await deletedLogSync.sync();
        const cloudSyncFinishedAt = Math.floor(Date.now() / 1000);
        await cacheService.setSyncStatus({
          status: 'success',
          runId: syncRunId!,
          accountName,
          syncTarget,
          startedAt: Math.floor(syncStartedAt! / 1000),
          updatedAt: cloudSyncFinishedAt,
          finishedAt: cloudSyncFinishedAt,
          message: 'Sync completed',
          syncType: result.type,
          documentsProcessed: result.documentsProcessed,
          lineItemsProcessed: result.lineItemsProcessed,
          itemsProcessed: itemResult.itemsProcessed,
          stockRowsProcessed: itemResult.stockRowsProcessed,
          deletedRecordsProcessed: deletedResult.deletedRecordsProcessed,
        });

        await cacheService.close();
        cacheService = null;

        // If we synced to PG, also pull PG → SQLite
        let pullInfo: {
          pulled: boolean;
          accounts?: number;
          documents?: number;
          itemDocuments?: number;
          paymentTransactions?: number;
          items?: number;
          stockRows?: number;
          duration?: string;
        } = { pulled: false };
        if (pgService && dbUrl && options.pull) {
          console.error('Pulling PostgreSQL → SQLite...');
          try {
            const pullResult = await pullFromPostgres(dbUrl, accountName);
            pullInfo = {
              pulled: true,
              accounts: pullResult.accountsPulled,
              documents: pullResult.documentsPulled,
              itemDocuments: pullResult.itemDocumentsPulled,
              paymentTransactions: pullResult.paymentTransactionsPulled,
              items: pullResult.itemsPulled,
              stockRows: pullResult.stockRowsPulled,
              duration: pullResult.duration,
            };
            console.error(`Pull complete: ${pullResult.documentsPulled} docs in ${pullResult.duration}`);
          } catch (pullError: any) {
            console.error(`Warning: PG → SQLite pull failed: ${pullError?.message}`);
          }
        }

        const duration = `${((Date.now() - syncStartedAt!) / 1000).toFixed(1)}s`;

        const output = {
          success: true,
          sync_target: syncTarget,
          sync_type: result.type,
          sync_lookback_seconds: result.syncLookbackSeconds,
          accounts_processed: accountResult.accountsProcessed,
          customers_processed: accountResult.customersProcessed,
          suppliers_processed: accountResult.suppliersProcessed,
          documents_processed: result.documentsProcessed,
          documents_deleted: result.documentsDeleted || 0,
          line_items_processed: result.lineItemsProcessed,
          items_processed: itemResult.itemsProcessed,
          stock_rows_processed: itemResult.stockRowsProcessed,
          deleted_records_processed: deletedResult.deletedRecordsProcessed,
          duration,
          document_sync_duration: result.duration,
          ...(pgService && !options.pull && {
            pg_to_sqlite_pull: {
              skipped: true,
              reason: 'Use --pull to refresh the local SQLite mirror after PostgreSQL sync.',
            },
          }),
          ...(pullInfo.pulled && {
            pg_to_sqlite_pull: {
              accounts: pullInfo.accounts,
              documents: pullInfo.documents,
              item_documents: pullInfo.itemDocuments,
              payment_transactions: pullInfo.paymentTransactions,
              items: pullInfo.items,
              stock_rows: pullInfo.stockRows,
              duration: pullInfo.duration,
            },
          }),
          message: `Sync complete: ${result.documentsProcessed} documents, ${itemResult.itemsProcessed} items in ${duration}`,
        };

        console.log(formatJson(output));
      } catch (error) {
        try {
          if (cacheService && syncRunId && syncTarget) {
            const now = Math.floor(Date.now() / 1000);
            await cacheService.setSyncStatus({
              status: 'failed',
              runId: syncRunId,
              accountName: program.opts().account || 'default',
              syncTarget,
              startedAt: syncStartedAt ? Math.floor(syncStartedAt / 1000) : now,
              updatedAt: now,
              finishedAt: now,
              message: 'Sync failed',
              error: (error as Error).message,
            });
          }
        } catch {
          // Preserve original sync error.
        }
        console.error(formatError(error as Error));
        process.exitCode = 1;
      } finally {
        await releaseCacheWriterLockAndClose(cacheService, syncLockKey, lockAcquired);
      }
    });

  // Clear command
  cache
    .command('clear')
    .description(`Delete or truncate local cache

Example:
  salesbinder cache clear

For SQLite: removes the local cache file.
For PostgreSQL: truncates all cache tables.
Next sync will perform a full resync.`)
    .action(async () => {
      let cacheService: CacheService | null = null;
      let lockKey: string | null = null;
      let lockAcquired = false;

      try {
        const dbUrl = process.env.SALESBINDER_DB_URL;
        const accountName = program.opts().account || 'default';

        if (dbUrl) {
          // PostgreSQL: truncate tables
          const { PostgresCacheService } = await import('@salesbinder/sdk');
          const pgCache = new PostgresCacheService(dbUrl);
          cacheService = pgCache;
          lockKey = `salesbinder-cache-sync:${accountName}`;
          lockAcquired = await pgCache.tryAcquireSyncLock(lockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
          await pgCache.ensureSchema();
          await pgCache.truncateAll();

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
          lockKey = `salesbinder-cache-sync:${accountName}`;
          lockAcquired = await sqliteCache.tryAcquireSyncLock(lockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }

          // Get file size before deletion
          const stats = statSync(cacheFile);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

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
        console.error(formatError(error as Error));
        process.exitCode = 1;
      } finally {
        await releaseCacheWriterLockAndClose(cacheService, lockKey, lockAcquired);
      }
    });

  // CSV export import command
  cache
    .command('import-export <directory>')
    .description(`Seed cache from local SalesBinder CSV exports

Examples:
  salesbinder cache import-export data/ --dry-run
  salesbinder cache import-export data/
  salesbinder cache import-export data/ --target postgresql

Validates and imports local customer, supplier, invoice, PO, and inventory exports.
No historical SalesBinder API requests are made.`)
    .option('--dry-run', 'Validate files and report counts without writing')
    .option('--target <backend>', 'Cache backend: sqlite or postgresql')
    .action(async (directory: string, options: { dryRun?: boolean; target?: string }) => {
      let cacheService: CacheService | null = null;
      let ensurePostgresSchema: (() => Promise<void>) | null = null;
      let lockKey: string | null = null;
      let lockAcquired = false;

      try {
        const { CsvCacheImportService, SQLiteCacheService, PostgresCacheService } = await import('@salesbinder/sdk');
        const accountName = program.opts().account || 'default';
        const databaseUrlEnv = ['SALESBINDER', 'DB', 'URL'].join('_');
        const dbUrl = process.env[databaseUrlEnv];
        const target = (options.target || (dbUrl ? 'postgresql' : 'sqlite')).toLowerCase();

        if (!['sqlite', 'postgresql'].includes(target)) {
          throw new Error('Invalid --target. Use sqlite or postgresql.');
        }

        if (target === 'postgresql') {
          if (!dbUrl) throw new Error('Database URL environment variable is required for --target postgresql.');
          const pgCache = new PostgresCacheService(dbUrl);
          cacheService = pgCache;
          ensurePostgresSchema = () => pgCache.ensureSchema();
        } else {
          cacheService = new SQLiteCacheService(accountName);
        }

        if (!options.dryRun) {
          lockKey = `salesbinder-cache-sync:${accountName}`;
          lockAcquired = await cacheService.tryAcquireSyncLock(lockKey);
          if (!lockAcquired) {
            throw new Error('Another cache sync is already running for this account.');
          }
        }
        if (ensurePostgresSchema) await ensurePostgresSchema();

        console.error(`${options.dryRun ? 'Validating' : 'Importing'} CSV exports -> ${target}...`);
        const importer = new CsvCacheImportService(cacheService);
        const result = await importer.importDirectory(directory, {
          dryRun: options.dryRun,
          accountName,
        });

        console.log(formatJson({ ...result, backend: target }));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exitCode = 1;
      } finally {
        await releaseCacheWriterLockAndClose(cacheService, lockKey, lockAcquired);
      }
    });

  // Status command
  cache
    .command('status')
    .description(`Show cache status and statistics

Example:
  salesbinder cache status

Displays:
  - Cache backend (SQLite or PostgreSQL)
  - Cache file location or connection info
  - Account name
  - Last sync time
  - Document counts
  - Freshness status`)
    .action(async () => {
      let cacheService: import('@salesbinder/sdk').CacheService | null = null;

      try {
        const { createCacheService, createPostgresCacheService, DocumentIndexerService, SalesBinderClient, loadPreferences } = await import(
          '@salesbinder/sdk'
        );

        const dbUrl = process.env.SALESBINDER_DB_URL;
        const accountName = program.opts().account || 'default';

        if (dbUrl) {
          // PostgreSQL backend
          const pgCache = await createPostgresCacheService();
          if (!pgCache) {
            throw new Error('PostgreSQL backend is configured but could not be opened.');
          }
          cacheService = pgCache;
          const client = new SalesBinderClient(accountName);
          const prefs = loadPreferences();
          const indexer = new DocumentIndexerService(
            client,
            cacheService,
            accountName,
            prefs?.cacheStaleSeconds
          );

          const state = await cacheService.getCacheState();
          const syncStatus = await cacheService.getSyncStatus();
          const paymentSyncStatus = await cacheService.getPaymentSyncStatus();
          const stale = await indexer.isCacheStale();
          const counts = await collectCacheCounts(cacheService);

          await cacheService.close();
          cacheService = null;

          const maskedUrl = (() => {
            try {
              const u = new URL(dbUrl);
              u.password = '***';
              return u.toString();
            } catch {
              return dbUrl;
            }
          })();

          const output = {
            backend: 'postgresql',
            connection: maskedUrl,
            account: accountName,
            ...(state
              ? {
                  last_sync: new Date(state.lastSync * 1000).toISOString(),
                  last_full_sync: new Date(state.lastFullSync * 1000).toISOString(),
                  ...counts,
                  schema_version: state.schemaVersion,
                  is_stale: stale,
                  freshness: stale ? 'STALE' : 'FRESH',
                  stale_threshold_seconds: prefs?.cacheStaleSeconds || 3600,
                  sync_status: syncStatus,
                  payment_sync_status: paymentSyncStatus ?? 'not_initialized',
                }
              : {
                  message: 'Cache exists but no metadata found. May need full sync.',
                }),
          };

          console.log(formatJson(output));
        } else {
          // SQLite backend
          const sanitizedAccount = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const cacheDir = join(homedir(), '.salesbinder', 'cache');
          const cacheFile = join(cacheDir, `salesbinder-${sanitizedAccount}.db`);

          const cacheExists = existsSync(cacheFile);

          if (!cacheExists) {
            console.log(
              formatJson({
                backend: 'sqlite',
                exists: false,
                account: accountName,
                cache_file: cacheFile,
                message: 'Cache does not exist. Run "cache sync" to create it.',
              })
            );
            return;
          }

          const stats = statSync(cacheFile);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

          cacheService = await createCacheService(accountName);
          const client = new SalesBinderClient(accountName);

          // Load stale threshold from config
          const prefs = loadPreferences();
          const indexer = new DocumentIndexerService(
            client,
            cacheService,
            accountName,
            prefs?.cacheStaleSeconds
          );

          const state = await cacheService.getCacheState();
          const syncStatus = await cacheService.getSyncStatus();
          const paymentSyncStatus = await cacheService.getPaymentSyncStatus();
          const stale = await indexer.isCacheStale();
          const counts = await collectCacheCounts(cacheService);

          await cacheService.close();
          cacheService = null;

          const output = {
            backend: 'sqlite',
            exists: true,
            account: accountName,
            cache_file: cacheFile,
            size_mb: parseFloat(sizeMB),
            ...(state
              ? {
                  last_sync: new Date(state.lastSync * 1000).toISOString(),
                  last_full_sync: new Date(state.lastFullSync * 1000).toISOString(),
                  ...counts,
                  schema_version: state.schemaVersion,
                  is_stale: stale,
                  freshness: stale ? 'STALE' : 'FRESH',
                  stale_threshold_seconds: prefs?.cacheStaleSeconds || 3600,
                  sync_status: syncStatus,
                  payment_sync_status: paymentSyncStatus ?? 'not_initialized',
                }
              : {
                  message: 'Cache exists but no metadata found. May need full sync.',
                }),
          };

          console.log(formatJson(output));
        }
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      } finally {
        try {
          if (cacheService && typeof cacheService.close === 'function') {
            await cacheService.close();
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    });

  // Pull command (PG → SQLite)
  cache
    .command('pull')
    .description(`Pull data from PostgreSQL into local SQLite cache

Examples:
  salesbinder cache pull

Requires SALESBINDER_DB_URL environment variable.
Downloads all cached data from shared PostgreSQL into local SQLite for fast offline reads.
This pull is explicit; normal cache reads and normal cache sync do not refresh SQLite.`)
    .action(async () => {
      try {
        const dbUrl = process.env.SALESBINDER_DB_URL;
        if (!dbUrl) {
          console.error(formatError(new Error('SALESBINDER_DB_URL is not set. Pull requires a PostgreSQL backend.')));
          process.exit(1);
        }

        const { pullFromPostgres } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        console.error('Pulling PostgreSQL → SQLite...');

        const result = await pullFromPostgres(dbUrl, accountName);

        console.log(
          formatJson({
            success: true,
            accounts_pulled: result.accountsPulled,
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
        process.exit(1);
      }
    });
}

async function releaseCacheWriterLockAndClose(
  cacheService: CacheService | null,
  lockKey: string | null,
  lockAcquired: boolean,
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

async function collectCacheCounts(cacheService: CacheService) {
  const [
    documentCount,
    invoiceCount,
    poCount,
    estimateCount,
    lineItemCount,
    paymentTransactionCount,
    accountCount,
    customerCount,
    supplierCount,
    itemCount,
    stockLocationCount,
  ] = await Promise.all([
    cacheService.getDocumentCount(),
    cacheService.getDocumentCountByContext(5),
    cacheService.getDocumentCountByContext(11),
    cacheService.getDocumentCountByContext(4),
    cacheService.getItemDocumentCount(),
    cacheService.getPaymentTransactionCount(),
    cacheService.getAccountCount(),
    cacheService.getAccountCount(2),
    cacheService.getAccountCount(10),
    cacheService.getItemCount(),
    cacheService.getStockLocationCount(),
  ]);

  return {
    document_count: documentCount,
    invoice_document_count: invoiceCount,
    purchase_order_document_count: poCount,
    estimate_document_count: estimateCount,
    line_item_count: lineItemCount,
    payment_transaction_count: paymentTransactionCount,
    account_count: accountCount,
    customer_count: customerCount,
    supplier_count: supplierCount,
    item_count: itemCount,
    stock_location_count: stockLocationCount,
  };
}
