/**
 * Item sales analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';
import {
  ensureAnalyticsCacheBinding,
  getAnalyticsSyncDecision,
  resolveAnalyticsStaleThreshold,
} from './analytics-cache-binding.js';

interface AnalyticsOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

/**
 * Register item-sales analytics command
 */
export function registerItemSalesCommand(analytics: Command): void {
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
      let cache: import('@salesbinder/sdk').CacheService | null = null;
      try {
        const {
          SalesBinderClient,
          createCacheService,
          createSalesBinderAccountBinding,
          DocumentIndexerService,
          DocumentContextId,
          readPublicCacheSyncAuthority,
          loadConfig,
          loadPreferences,
        } = await import('@salesbinder/sdk');

        const rootProgram = analytics.parent;
        const accountName = rootProgram?.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        cache = await createCacheService(accountName);

        // Load stale threshold from config
        const prefs = loadPreferences();
        const staleThresholdSeconds = resolveAnalyticsStaleThreshold(prefs?.cacheStaleSeconds);
        const indexer = new DocumentIndexerService(
          client,
          cache,
          accountName,
          staleThresholdSeconds
        );

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
          const state = await cache.getCacheState();
          const syncDecision = await getAnalyticsSyncDecision({
            cache,
            forceRefresh: analyticsOptions.forceRefresh === true,
            state,
            readLegacyCacheStale: () => indexer.isCacheStale(),
            staleThresholdSeconds,
          });
          if (syncDecision.error) throw new Error(syncDecision.error);

          if (syncDecision.shouldSync) {
            const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
            await ensureAnalyticsCacheBinding(cache, accountBinding);
            console.error('Syncing cache...');
            await indexer.sync({ full: syncDecision.full });
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
        const latestOcDate = await cache.getLatestItemDocumentDate(itemId, DocumentContextId.Estimate);

        // Query latest PO date (Purchase Order = context 11)
        const latestPoDate = await cache.getLatestItemDocumentDate(itemId, DocumentContextId.PurchaseOrder);

        // Aggregate sales by period
        const salesPeriods: { [key: string]: { sold: number; revenue: number } } = {};
        const now = new Date();

        for (const months of periods) {
          const startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - months);
          const startDateStr = startDate.toISOString().split('T')[0];
          const endDateStr = now.toISOString().split('T')[0];

          // Query invoice line items (Invoice = context 5) for period
          const lineItems = await cache.getItemDocumentsForPeriod(
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
        const state = await cache.getCacheState();
        const cacheAuthority = await readPublicCacheSyncAuthority(cache, {
          staleThresholdSeconds,
        });
        const lastSync =
          cacheAuthority.authority === 'official_v3'
            ? cacheAuthority.lastAppliedAt === null
              ? 'unknown'
              : new Date(cacheAuthority.lastAppliedAt * 1000).toISOString()
            : state
              ? new Date(state.lastSync * 1000).toISOString()
              : 'unknown';
        const stale =
          cacheAuthority.authority === 'official_v3'
            ? cacheAuthority.isStale
            : state
              ? await indexer.isCacheStale()
              : true;

        await cache.close();
        cache = null;

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
            authority: cacheAuthority.authority,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      } finally {
        try {
          if (cache) await cache.close();
        } catch { /* ignore */ }
      }
    });
}
