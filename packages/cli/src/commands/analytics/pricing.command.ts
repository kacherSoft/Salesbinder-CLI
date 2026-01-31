/**
 * Pricing analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface PricingOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

interface PriceDistributionItem {
  price: number;
  quantity: number;
  revenue: number;
  frequency_pct: number;
}

interface PricingOutput {
  item_id: string;
  item_name?: string;
  period: string;
  price_stats: {
    min: number;
    max: number;
    avg: number;
    median: number;
    std_dev: number;
    variance_pct: number;
  };
  price_distribution: PriceDistributionItem[];
  discounts: {
    has_discounts: boolean;
    avg_discount_pct: number | null;
    discount_frequency: number;
  };
}

/**
 * Register pricing analytics command
 */
export function registerPricingCommand(analytics: Command): void {
  analytics
    .command('pricing <item-id>')
    .description(`Analyze price distribution and variance for an item

Examples:
  salesbinder analytics pricing <item-id>
  salesbinder analytics pricing <item-id> --refresh
  salesbinder analytics pricing <item-id> --cached

Output includes:
  - Price statistics (min/max/avg/median/std dev)
  - Price distribution by price point
  - Discount detection and frequency`)
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId: string, options: { refresh?: boolean; cached?: boolean }) => {
      try {
        const {
          SalesBinderClient,
          SQLiteCacheService,
          DocumentIndexerService,
          DocumentContextId,
          CacheAnalyticsService,
          loadPreferences,
        } = await import('@salesbinder/sdk');

        const rootProgram = analytics.parent;
        const accountName = rootProgram?.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const cache = new SQLiteCacheService(accountName);
        const analyticsService = new CacheAnalyticsService();

        const prefs = loadPreferences();
        const indexer = new DocumentIndexerService(
          client,
          cache,
          accountName,
          prefs?.cacheStaleSeconds
        );

        const analyticsOptions: PricingOptions = {
          forceRefresh: options.refresh,
          useCachedOnly: options.cached,
        };

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

        let itemName: string | undefined;
        try {
          const item = await client.items.get(itemId);
          itemName = item.name;
        } catch (error) {
          console.error(`Warning: Could not fetch item details: ${error}`);
        }

        const now = new Date();
        const startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 12);
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = now.toISOString().split('T')[0];

        const priceDistribution = cache.getItemPriceDistribution(
          itemId,
          startDateStr,
          endDateStr,
          DocumentContextId.Invoice
        );

        const totalQuantity = priceDistribution.reduce((sum, d) => sum + d.total_quantity, 0);

        const distribution: PriceDistributionItem[] = priceDistribution.map((d) => ({
          price: Math.round(d.price * 100) / 100,
          quantity: d.total_quantity,
          revenue: Math.round(d.total_revenue * 100) / 100,
          frequency_pct: totalQuantity > 0 ? Math.round((d.total_quantity / totalQuantity) * 1000) / 10 : 0,
        }));

        const analyticsDistribution = priceDistribution.map((d) => ({
          price: d.price,
          totalQuantity: d.total_quantity,
          totalRevenue: d.total_revenue,
        }));

        const priceStats = analyticsService.calculatePriceStats(analyticsDistribution);
        const discounts = analyticsService.detectDiscounts(analyticsDistribution);

        cache.close();

        const result: PricingOutput = {
          item_id: itemId,
          item_name: itemName,
          period: '12 months',
          price_stats: {
            min: Math.round(priceStats.min * 100) / 100,
            max: Math.round(priceStats.max * 100) / 100,
            avg: Math.round(priceStats.avg * 100) / 100,
            median: Math.round(priceStats.median * 100) / 100,
            std_dev: Math.round(priceStats.stdDev * 100) / 100,
            variance_pct: Math.round(priceStats.variancePct * 10) / 10,
          },
          price_distribution: distribution,
          discounts: {
            has_discounts: discounts.hasDiscounts,
            avg_discount_pct: discounts.avgDiscountPct !== null ? Math.round(discounts.avgDiscountPct * 10) / 10 : null,
            discount_frequency: Math.round(discounts.discountFrequency * 1000) / 1000,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
