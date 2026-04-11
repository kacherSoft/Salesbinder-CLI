/**
 * Cache management commands
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Register cache management commands
 */
export function registerCacheCommands(program: Command): void {
  const cache = program.command('cache').description('Local cache management');

  // Sync command
  cache
    .command('sync')
    .description(`Sync local cache with SalesBinder API

Examples:
  salesbinder cache sync
  salesbinder cache sync --full

Performs incremental sync by default.
Use --full to force complete resync.`)
    .option('--full', 'Force full sync (re-download all documents)')
    .action(async (options: { full?: boolean }) => {
      let cacheService: import('@salesbinder/sdk').CacheService | null = null;

      try {
        const { SalesBinderClient, DocumentIndexerService, createCacheService, loadPreferences } = await import(
          '@salesbinder/sdk'
        );

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        cacheService = await createCacheService(accountName);

        // Load stale threshold from config
        const prefs = loadPreferences();
        const indexer = new DocumentIndexerService(
          client,
          cacheService,
          accountName,
          prefs?.cacheStaleSeconds
        );

        console.error('Starting cache sync...');

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

        await cacheService.close();
        cacheService = null;

        const output = {
          success: true,
          sync_type: result.type,
          documents_processed: result.documentsProcessed,
          documents_deleted: result.documentsDeleted || 0,
          line_items_processed: result.lineItemsProcessed,
          duration: result.duration,
          message: `Sync complete: ${result.documentsProcessed} documents in ${result.duration}`,
        };

        console.log(formatJson(output));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      } finally {
        // Ensure database is closed even on error
        try {
          if (cacheService && typeof cacheService.close === 'function') {
            await cacheService.close();
          }
        } catch {
          // Ignore cleanup errors
        }
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
      try {
        const dbUrl = process.env.SALESBINDER_DB_URL;

        if (dbUrl) {
          // PostgreSQL: truncate tables
          const { PostgresCacheService } = await import('@salesbinder/sdk');
          const pgCache = new PostgresCacheService(dbUrl);
          await pgCache.ensureSchema();
          await pgCache.truncateAll();
          await pgCache.close();

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
          const accountName = program.opts().account || 'default';
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
        process.exit(1);
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
        const { createCacheService, DocumentIndexerService, SalesBinderClient, loadPreferences } = await import(
          '@salesbinder/sdk'
        );

        const dbUrl = process.env.SALESBINDER_DB_URL;
        const accountName = program.opts().account || 'default';

        if (dbUrl) {
          // PostgreSQL backend
          cacheService = await createCacheService(accountName);
          const client = new SalesBinderClient(accountName);
          const prefs = loadPreferences();
          const indexer = new DocumentIndexerService(
            client,
            cacheService,
            accountName,
            prefs?.cacheStaleSeconds
          );

          const state = await cacheService.getCacheState();
          const stale = await indexer.isCacheStale();

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
                  document_count: state.documentCount,
                  line_item_count: state.itemDocumentCount,
                  schema_version: state.schemaVersion,
                  is_stale: stale,
                  freshness: stale ? 'STALE' : 'FRESH',
                  stale_threshold_seconds: prefs?.cacheStaleSeconds || 3600,
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
          const stale = await indexer.isCacheStale();

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
                  document_count: state.documentCount,
                  line_item_count: state.itemDocumentCount,
                  schema_version: state.schemaVersion,
                  is_stale: stale,
                  freshness: stale ? 'STALE' : 'FRESH',
                  stale_threshold_seconds: prefs?.cacheStaleSeconds || 3600,
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
}
