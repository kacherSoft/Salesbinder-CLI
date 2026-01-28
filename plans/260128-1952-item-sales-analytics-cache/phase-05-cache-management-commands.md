# Phase 05: Cache Management Commands

**Priority:** P2
**Status:** pending
**Effort:** 1h
**Dependencies:** Phase 02, Phase 03 complete

## Overview

Implement CLI commands for cache management: sync, clear, and status. Provide users with control over cache lifecycle and visibility into cache state.

## Context Links

- Parent plan: [plan.md](./plan.md)
- Previous phases:
  - [phase-02-sqlite-cache-infrastructure.md](./phase-02-sqlite-cache-infrastructure.md)
  - [phase-03-document-indexer-and-sync.md](./phase-03-document-indexer-and-sync.md)

## Requirements

### Functional
- `cache sync [--full]` - Trigger cache sync (delta or full)
- `cache clear` - Delete local cache file
- `cache status` - Show cache statistics and freshness

### Non-Functional
- Clear feedback on operations
- Progress indicators for sync
- Safe deletion (confirmation for clear)
- Multi-account aware

## Architecture

```
cache sync
    ↓
Initialize indexer service
    ↓
Call sync() with options
    ↓
Display results

cache clear
    ↓
Check cache file exists
    ↓
Delete file
    ↓
Confirm deletion

cache status
    ↓
Read cache metadata
    ↓
Calculate statistics
    ↓
Display formatted output
```

## Related Code Files

### New Files
- `packages/cli/src/commands/cache/cache.commands.ts` - Cache management commands
- `packages/cli/src/commands/cache/index.ts` - Cache module exports

### Modified Files
- `packages/cli/src/index.ts` - Register cache commands

### Dependencies
- `packages/sdk/src/cache/sqlite-cache.service.ts` - Cache operations (Phase 02)
- `packages/sdk/src/cache/document-indexer.service.ts` - Sync (Phase 03)

## Implementation Steps

1. **Create cache commands module**
   - Create packages/cli/src/commands/cache directory
   - Create cache.commands.ts
   - Create index.ts for exports

2. **Implement cache sync command**
   - Accept --full flag
   - Initialize indexer service
   - Call sync with progress reporting
   - Display results summary

3. **Implement cache clear command**
   - Check cache file exists
   - Delete cache file
   - Confirm deletion
   - Handle missing cache gracefully

4. **Implement cache status command**
   - Read cache state from metadata
   - Calculate freshness
   - Display statistics (doc count, size, last sync)
   - Show account name

## Implementation Details

### Cache Commands

```typescript
// packages/cli/src/commands/cache/cache.commands.ts

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
    .action(async (options) => {
      try {
        const { SalesBinderClient, DocumentIndexerService, SQLiteCacheService } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const dbCache = new SQLiteCacheService(accountName);
        const indexer = new DocumentIndexerService(client, dbCache, accountName);

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
          }
        });

        dbCache.close();

        const output = {
          success: true,
          sync_type: result.type,
          documents_processed: result.documentsProcessed,
          documents_deleted: result.documentsDeleted || 0,
          line_items_processed: result.lineItemsProcessed,
          duration: result.duration,
          message: `Sync complete: ${result.documentsProcessed} documents in ${result.duration}`
        };

        console.log(formatJson(output));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
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
        const cacheDir = join(homedir(), '.salesbinder', 'cache');
        const cacheFile = join(cacheDir, `salesbinder-${accountName}.db`);

        if (!existsSync(cacheFile)) {
          console.log(JSON.stringify({
            success: true,
            message: 'Cache file does not exist',
            cache_file: cacheFile
          }, null, 2));
          return;
        }

        // Get file size before deletion
        const stats = statSync(cacheFile);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        // Delete cache file
        unlinkSync(cacheFile);

        console.log(JSON.stringify({
          success: true,
          message: `Cache deleted (${sizeMB} MB)`,
          cache_file: cacheFile,
          next_sync: 'full'
        }, null, 2));
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
      try {
        const { SQLiteCacheService, DocumentIndexerService } = await import('@salesbinder/sdk');
        const { SalesBinderClient } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const cacheDir = join(homedir(), '.salesbinder', 'cache');
        const cacheFile = join(cacheDir, `salesbinder-${accountName}.db`);

        const cacheExists = existsSync(cacheFile);

        if (!cacheExists) {
          console.log(JSON.stringify({
            exists: false,
            account: accountName,
            cache_file: cacheFile,
            message: 'Cache does not exist. Run "cache sync" to create it.'
          }, null, 2));
          return;
        }

        const stats = statSync(cacheFile);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        const dbCache = new SQLiteCacheService(accountName);
        const client = new SalesBinderClient(accountName);
        const indexer = new DocumentIndexerService(client, dbCache, accountName);

        const state = dbCache.getCacheState();
        const stale = indexer.isCacheStale();

        dbCache.close();

        const output = {
          exists: true,
          account: accountName,
          cache_file: cacheFile,
          size_mb: parseFloat(sizeMB),
          ...(state ? {
            last_sync: new Date(state.lastSync * 1000).toISOString(),
            last_full_sync: new Date(state.lastFullSync * 1000).toISOString(),
            document_count: state.documentCount,
            line_item_count: state.itemDocumentCount,
            schema_version: state.schemaVersion,
            is_stale: stale,
            freshness: stale ? 'STALE (>1 hour old)' : 'FRESH'
          } : {
            message: 'Cache exists but no metadata found. May need full sync.'
          })
        };

        console.log(JSON.stringify(output, null, 2));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
```

### Update CLI Entry Point

```typescript
// packages/cli/src/index.ts

import { registerCacheCommands } from './commands/cache/cache.commands.js';

export function createProgram(): Command {
  const program = new Command();

  // ... existing configuration ...

  // Register cache commands
  registerCacheCommands(program);

  // ... existing command registrations ...

  return program;
}
```

## Todo List

- [ ] Create cache commands directory structure
- [ ] Implement cache sync command with --full option
- [ ] Implement cache clear command
- [ ] Implement cache status command
- [ ] Add progress reporting to sync
- [ ] Add file size calculation
- [ ] Add stale/fresh status indicator
- [ ] Handle missing cache gracefully
- [ ] Test with real cache file
- [ ] Update CLI description in main index.ts

## Success Criteria

- [ ] All three commands work correctly
- [ ] Sync shows progress
- [ ] Clear deletes cache file
- [ ] Status shows accurate information
- [ ] Multi-account isolation works
- [ ] Missing cache handled gracefully
- [ ] Error messages are clear
- [ ] TypeScript compiles without errors
- [ ] Linting passes

## Risk Assessment

**Risk:** Clearing cache while in use
**Mitigation:** SQLite handles concurrent access, file deletion may fail on Windows (handle gracefully)

**Risk:** Status command fails on corrupted cache
**Mitigation:** Wrap in try-catch, report corruption, suggest cache clear

**Risk:** Large sync without progress feedback
**Mitigation:** Progress callback shows documents processed

## Security Considerations

- No new security concerns
- Cache operations respect file permissions
- Cache file paths validated

## Next Steps

After completion, proceed to [Phase 06: Testing and Integration](./phase-06-testing-and-integration.md)
