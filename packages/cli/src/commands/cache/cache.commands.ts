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
      let cache: import('@salesbinder/sdk').SQLiteCacheService | null = null;

      try {
        const { SalesBinderClient, DocumentIndexerService, SQLiteCacheService } = await import(
          '@salesbinder/sdk'
        );

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        cache = new SQLiteCacheService(accountName);
        const indexer = new DocumentIndexerService(client, cache, accountName);

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

        cache.close();

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
          if (cache && typeof cache.close === 'function') {
            cache.close();
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    });

  // Clear command
  cache
    .command('clear')
    .description(`Delete local cache file

Example:
  salesbinder cache clear

Removes the local SQLite cache file.
Next sync will perform a full resync.`)
    .action(async () => {
      try {
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
  - Cache file location
  - Account name
  - Last sync time
  - Document counts
  - File size
  - Freshness status`)
    .action(async () => {
      let cache: import('@salesbinder/sdk').SQLiteCacheService | null = null;

      try {
        const { SQLiteCacheService, DocumentIndexerService, SalesBinderClient } = await import(
          '@salesbinder/sdk'
        );

        const accountName = program.opts().account || 'default';
        const sanitizedAccount = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const cacheDir = join(homedir(), '.salesbinder', 'cache');
        const cacheFile = join(cacheDir, `salesbinder-${sanitizedAccount}.db`);

        const cacheExists = existsSync(cacheFile);

        if (!cacheExists) {
          console.log(
            formatJson({
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

        cache = new SQLiteCacheService(accountName);
        const client = new SalesBinderClient(accountName);
        const indexer = new DocumentIndexerService(client, cache, accountName);

        const state = cache.getCacheState();
        const stale = indexer.isCacheStale();

        cache.close();

        const output = {
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
                freshness: stale ? 'STALE (>1 hour old)' : 'FRESH',
              }
            : {
                message: 'Cache exists but no metadata found. May need full sync.',
              }),
        };

        console.log(formatJson(output));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      } finally {
        try {
          if (cache && typeof cache.close === 'function') {
            cache.close();
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    });
}
