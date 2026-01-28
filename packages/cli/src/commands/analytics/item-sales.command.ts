/**
 * Item sales analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface AnalyticsOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

/**
 * Register item-sales analytics command
 */
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
  - Cache freshness information`)
    .option('--months <periods>', 'Periods in months (comma-separated)', '3,6,12')
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId: string, options: { months: string; refresh?: boolean; cached?: boolean }) => {
      try {
        const {
          SalesBinderClient,
          SQLiteCacheService,
          DocumentIndexerService,
          DocumentContextId,
        } = await import('@salesbinder/sdk');

        const accountName = program.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const cache = new SQLiteCacheService(accountName);
        const indexer = new DocumentIndexerService(client, cache, accountName);

        // Parse months option
        const periods = options.months
          .split(',')
          .map((m: string) => parseInt(m, 10))
          .filter((m: number) => [3, 6, 12].includes(m));

        const analyticsOptions: AnalyticsOptions = {
          forceRefresh: options.refresh,
          useCachedOnly: options.cached,
        };

        // Check cache and sync if needed
        if (!analyticsOptions.useCachedOnly) {
          const state = cache.getCacheState();
          const needsSync =
            analyticsOptions.forceRefresh ||
            !state ||
            state.accountName !== accountName ||
            indexer.isCacheStale();

          if (needsSync) {
            console.error('Syncing cache...');
            await indexer.sync({ full: analyticsOptions.forceRefresh });
            console.error('Sync complete');
          }
        }

        // Fetch item details for name and stock
        let itemName: string | undefined;
        let currentStock = 0;

        try {
          const item = await client.items.get(itemId);
          itemName = item.name;
          currentStock = item.quantity || 0;
        } catch (error) {
          console.error(`Warning: Could not fetch item details: ${error}`);
        }

        // Query latest OC date (Estimate = context 4)
        const latestOcDate = cache.getLatestItemDocumentDate(itemId, DocumentContextId.Estimate);

        // Query latest PO date (Purchase Order = context 11)
        const latestPoDate = cache.getLatestItemDocumentDate(itemId, DocumentContextId.PurchaseOrder);

        // Aggregate sales by period
        const salesPeriods: { [key: string]: { sold: number; revenue: number } } = {};
        const now = new Date();

        for (const months of periods) {
          const startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - months);
          const startDateStr = startDate.toISOString().split('T')[0];
          const endDateStr = now.toISOString().split('T')[0];

          // Query invoice line items (Invoice = context 5) for period
          const lineItems = cache.getItemDocumentsForPeriod(
            itemId,
            startDateStr,
            endDateStr,
            DocumentContextId.Invoice
          );

          // Aggregate quantity and revenue
          const sold = lineItems.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
          const revenue = lineItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

          salesPeriods[`${months}_months`] = { sold, revenue: Math.abs(revenue) };
        }

        // Get cache freshness info
        const state = cache.getCacheState();
        const lastSync = state ? new Date(state.lastSync * 1000).toISOString() : 'unknown';
        const stale = state ? indexer.isCacheStale() : true;

        cache.close();

        const result = {
          item_id: itemId,
          item_name: itemName,
          current_stock: currentStock,
          latest_oc_date: latestOcDate,
          latest_po_date: latestPoDate,
          sales_periods: salesPeriods,
          cache_freshness: {
            last_sync: lastSync,
            stale,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
