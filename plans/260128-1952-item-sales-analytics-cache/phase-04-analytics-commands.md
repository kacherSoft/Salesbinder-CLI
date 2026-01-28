# Phase 04: Analytics Commands

**Priority:** P2
**Status:** pending
**Effort:** 2.5h
**Dependencies:** Phase 02, Phase 03 complete

## Overview

Implement CLI command for item sales analytics that aggregates data from SQLite cache. Shows current stock, latest OC/PO dates, and sold quantities for 3/6/12 month periods.

## Context Links

- Parent plan: [plan.md](./plan.md)
- Previous phases:
  - [phase-02-sqlite-cache-infrastructure.md](./phase-02-sqlite-cache-infrastructure.md)
  - [phase-03-document-indexer-and-sync.md](./phase-03-document-indexer-and-sync.md)
- Output format: [plan.md#analytics-output](./plan.md#analytics-output)

## Requirements

### Functional
- CLI command: `analytics item-sales <item-id> [--months 3|6|12] [--refresh] [--cached]`
- Fetch current stock from Items API (real-time)
- Calculate latest OC (Order Confirmation) date from cache
- Calculate latest PO (Purchase Order) date from cache
- Aggregate sold quantities for 3, 6, 12 month periods from Invoices (context=5)
- Auto-sync cache if stale (unless --cached flag)
- Force refresh with --refresh flag

### Non-Functional
- <100ms query time from cache
- Graceful handling of missing items
- Clear error messages
- JSON output format

## Architecture

```
CLI Command: analytics item-sales
    ↓
Check cache freshness
    ↓
Auto-sync if needed (unless --cached)
    ↓
Query SQLite cache for:
  - Latest OC date (context=4)
  - Latest PO date (context=11)
  - Invoice line items (context=5)
    ↓
Aggregate sales by period
    ↓
Fetch current stock from API
    ↓
Format and output JSON
```

## Related Code Files

### New Files
- `packages/cli/src/commands/analytics/item-sales.command.ts` - Analytics command
- `packages/cli/src/commands/analytics/index.ts` - Analytics module exports

### Modified Files
- `packages/cli/src/index.ts` - Register analytics commands

### Dependencies
- `packages/sdk/src/cache/sqlite-cache.service.ts` - Cache queries (Phase 02)
- `packages/sdk/src/cache/document-indexer.service.ts` - Sync (Phase 03)
- `packages/sdk/src/resources/items.resource.ts` - Stock fetch

## Implementation Steps

1. **Create analytics command module**
   - Create packages/cli/src/commands/analytics directory
   - Create item-sales.command.ts
   - Create index.ts for exports

2. **Implement command registration**
   - Register analytics command group
   - Add item-sales subcommand
   - Define options: --months, --refresh, --cached

3. **Implement cache freshness check**
   - Check if cache exists
   - Check if cache is stale (>1 hour)
   - Trigger sync if needed (respect --cached flag)

4. **Implement analytics aggregation**
   - Query latest OC date from cache (context=4)
   - Query latest PO date from cache (context=11)
   - Query invoice line items (context=5) for item
   - Aggregate by 3/6/12 month periods
   - Calculate revenue (quantity * price)

5. **Implement stock fetch**
   - Call Items API for real-time stock
   - Extract total quantity from item variations
   - Handle missing items gracefully

6. **Format output**
   - Build ItemSalesAnalytics response
   - Include cache freshness info
   - Format as JSON

## Implementation Details

### Command Registration

```typescript
// packages/cli/src/commands/analytics/item-sales.command.ts

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

export function registerItemSalesCommand(program: Command): void {
  const analytics = program.command('analytics').description('Sales analytics and reporting');

  analytics
    .command('item-sales <item-id>')
    .description(`Generate sales analytics for a single item

Examples:
  salesbinder analytics item-sales <item-id>
  salesbinder analytics item-sales <item-id> --months 12
  salesbinder analytics item-sales <item-id> --refresh
  salesbinder analytics item-sales <item-id> --cached

Output includes:
  - Current stock quantity (real-time from API)
  - Latest Order Confirmation date
  - Latest Purchase Order date
  - Sold quantities for 3/6/12 month periods
  - Revenue by period
  - Cache freshness information

Options:
  --months    Periods to include (default: 3,6,12)
  --refresh   Force cache refresh before query
  --cached    Use cache even if stale (skip sync)`)
    .option('--months <periods>', 'Periods in months (comma-separated)', '3,6,12')
    .option('--refresh', 'Force cache refresh')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId, options) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        // Parse months option
        const periods = options.months.split(',')
          .map((m: string) => parseInt(m, 10))
          .filter((m: number) => [3, 6, 12].includes(m));

        const result = await generateItemSalesAnalytics(
          client,
          accountName,
          itemId,
          periods,
          {
            forceRefresh: options.refresh,
            useCachedOnly: options.cached
          }
        );

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
```

### Analytics Generator

```typescript
import type { SalesBinderClient } from '@salesbinder/sdk';
import { SQLiteCacheService } from '@salesbinder/sdk';
import { DocumentContext } from '@salesbinder/sdk';

interface AnalyticsOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

async function generateItemSalesAnalytics(
  client: SalesBinderClient,
  accountName: string,
  itemId: string,
  periods: number[],
  options: AnalyticsOptions
): Promise<ItemSalesAnalytics> {
  // Initialize cache
  const cache = new SQLiteCacheService(accountName);
  const indexer = new DocumentIndexerService(client, cache, accountName);

  try {
    // Check cache and sync if needed
    if (!options.useCachedOnly) {
      const state = cache.getCacheState();
      const needsSync = options.forceRefresh ||
                        !state ||
                        state.accountName !== accountName ||
                        indexer.isCacheStale();

      if (needsSync) {
        console.error('Syncing cache...');
        await indexer.sync({ full: options.forceRefresh });
        console.error('Sync complete');
      }
    }

    // Fetch item details for name and stock
    let itemName: string | undefined;
    let currentStock = 0;

    try {
      const item = await client.items.get(itemId);
      itemName = item.name;

      // Calculate total stock from variations
      currentStock = (item.item_variations || []).reduce((sum, variation) => {
        return sum + (variation.item_variations_locations || [])
          .reduce((locSum, loc) => locSum + (loc.quantity || 0), 0);
      }, 0);
    } catch (error) {
      // Item might not exist, continue with partial data
      console.error(`Warning: Could not fetch item details: ${error}`);
    }

    // Query latest OC date (context=4)
    const latestOcDate = cache.getLatestItemDocumentDate(itemId, DocumentContext.ESTIMATE);

    // Query latest PO date (context=11)
    const latestPoDate = cache.getLatestItemDocumentDate(itemId, DocumentContext.PURCHASE_ORDER);

    // Aggregate sales by period
    const salesPeriods: { [key: string]: { sold: number; revenue: number } } = {};
    const now = new Date();

    for (const months of periods) {
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - months);
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = now.toISOString().split('T')[0];

      // Query invoice line items (context=5) for period
      const lineItems = cache.getItemDocumentsForPeriod(
        itemId,
        startDateStr,
        endDateStr,
        DocumentContext.INVOICE
      );

      // Aggregate quantity and revenue
      const sold = lineItems.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
      const revenue = lineItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);

      salesPeriods[`${months}_months`] = { sold, revenue };
    }

    // Get cache freshness info
    const state = cache.getCacheState();
    const lastSync = state ? new Date(state.lastSync * 1000).toISOString() : 'unknown';
    const stale = state ? indexer.isCacheStale() : true;

    return {
      item_id: itemId,
      item_name: itemName,
      current_stock: currentStock,
      latest_oc_date: latestOcDate,
      latest_po_date: latestPoDate,
      sales_periods: salesPeriods,
      cache_freshness: {
        last_sync: lastSync,
        stale
      }
    };

  } finally {
    cache.close();
  }
}
```

### Update CLI Entry Point

```typescript
// packages/cli/src/index.ts

import { registerItemSalesCommand } from './commands/analytics/item-sales.command.js';

export function createProgram(): Command {
  const program = new Command();

  // ... existing configuration ...

  // Register analytics commands
  registerItemSalesCommand(program);

  // ... existing command registrations ...

  return program;
}
```

## Todo List

- [ ] Create analytics command directory structure
- [ ] Implement item-sales.command.ts
- [ ] Implement command registration with options
- [ ] Implement cache freshness check
- [ ] Implement auto-sync logic
- [ ] Implement analytics aggregation (OC, PO dates)
- [ ] Implement sales period aggregation
- [ ] Implement stock fetch from API
- [ ] Implement JSON output formatting
- [ ] Add error handling for missing items
- [ ] Test with real data
- [ ] Verify <100ms query time
- [ ] Update CLI description in main index.ts

## Success Criteria

- [ ] Command executes successfully
- [ ] Cache auto-syncs when stale
- [ ] --cached flag skips sync check
- [ ] --refresh flag forces full sync
- [ ] Analytics queries return in <100ms
- [ ] Output matches specified format
- [ ] Missing items handled gracefully
- [ ] Error messages are clear
- [ ] TypeScript compiles without errors
- [ ] Linting passes

## Risk Assessment

**Risk:** Cache missing or incomplete data
**Mitigation:** Check cache state, handle missing data gracefully, show warnings

**Risk:** Item not found in API
**Mitigation:** Catch errors, return analytics with partial data (item_name = undefined)

**Risk:** Slow queries on large dataset
**Mitigation:** Ensure indexes exist, use efficient queries, measure performance

**Risk:** Date calculation errors
**Mitigation:** Use ISO date strings, test timezone handling

## Security Considerations

- No new security concerns
- API calls use existing authenticated client
- Cache access controlled by file permissions (0600)

## Next Steps

After completion, proceed to [Phase 05: Cache Management Commands](./phase-05-cache-management-commands.md)
