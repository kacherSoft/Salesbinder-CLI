/**
 * Trends analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';
import {
  ensureAnalyticsCacheBinding,
  getAnalyticsSyncDecision,
} from './analytics-cache-binding.js';

interface TrendsOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

interface TrendsPeriod {
  period: string;
  quantity_sold: number;
  revenue: number;
  avg_monthly: number;
}

interface TrendsOutput {
  item_id: string;
  item_name?: string;
  analysis_period: string;
  periods: TrendsPeriod[];
  trend: {
    direction: 'upward' | 'downward' | 'stable' | 'volatile';
    growth_rate: number;
    momentum: 'accelerating' | 'decelerating' | 'stable';
    volatility_score: number;
  };
}

/**
 * Register trends analytics command
 */
export function registerTrendsCommand(analytics: Command): void {
  analytics
    .command('trends <item-id>')
    .description(`Analyze sales trends for an item over 12 months

Examples:
  salesbinder analytics trends <item-id>
  salesbinder analytics trends <item-id> --refresh
  salesbinder analytics trends <item-id> --cached

Output includes:
  - 3-month rolling period analysis
  - Trend direction (upward/downward/stable/volatile)
  - Growth rate and momentum
  - Volatility score`)
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId: string, options: { refresh?: boolean; cached?: boolean }) => {
      let cache: import('@salesbinder/sdk').CacheService | null = null;
      try {
        const {
          SalesBinderClient,
          createCacheService,
          createSalesBinderAccountBinding,
          DocumentIndexerService,
          DocumentContextId,
          CacheAnalyticsService,
          loadConfig,
          loadPreferences,
        } = await import('@salesbinder/sdk');

        const rootProgram = analytics.parent;
        const accountName = rootProgram?.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        cache = await createCacheService(accountName);
        const analyticsService = new CacheAnalyticsService();

        const prefs = loadPreferences();
        const indexer = new DocumentIndexerService(
          client,
          cache,
          accountName,
          prefs?.cacheStaleSeconds
        );

        const analyticsOptions: TrendsOptions = {
          forceRefresh: options.refresh,
          useCachedOnly: options.cached,
        };

        if (!analyticsOptions.useCachedOnly) {
          const state = await cache.getCacheState();
          const syncDecision = getAnalyticsSyncDecision(
            analyticsOptions.forceRefresh === true,
            state,
            await indexer.isCacheStale()
          );

          if (syncDecision.shouldSync) {
            const accountBinding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
            await ensureAnalyticsCacheBinding(cache, accountBinding);
            console.error('Syncing cache...');
            await indexer.sync({ full: syncDecision.full });
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
        const periods: TrendsPeriod[] = [];
        const periodData: { period: string; quantitySold: number; revenue: number; avgMonthly: number }[] = [];

        for (let i = 0; i < 4; i++) {
          const endDate = new Date(now);
          endDate.setMonth(endDate.getMonth() - i * 3);
          const startDate = new Date(endDate);
          startDate.setMonth(startDate.getMonth() - 3);

          const startDateStr = startDate.toISOString().split('T')[0];
          const endDateStr = endDate.toISOString().split('T')[0];

          const lineItems = await cache.getItemSalesByPeriod(
            itemId,
            startDateStr,
            endDateStr,
            DocumentContextId.Invoice
          );

          const quantitySold = lineItems.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
          const revenue = Math.abs(lineItems.reduce((sum, item) => sum + item.quantity * item.price, 0));
          const avgMonthly = quantitySold / 3;

          const periodLabel = i === 0 ? 'months_10_12' : i === 1 ? 'months_7_9' : i === 2 ? 'months_4_6' : 'months_1_3';
          periods.push({
            period: periodLabel,
            quantity_sold: quantitySold,
            revenue,
            avg_monthly: Math.round(avgMonthly * 100) / 100,
          });

          periodData.push({
            period: periodLabel,
            quantitySold,
            revenue,
            avgMonthly,
          });
        }

        periods.reverse();
        periodData.reverse();

        const trend = analyticsService.detectTrend(periodData);

        await cache.close();
        cache = null;

        const result: TrendsOutput = {
          item_id: itemId,
          item_name: itemName,
          analysis_period: '12 months',
          periods,
          trend: {
            direction: trend.direction,
            growth_rate: Math.round(trend.growthRate * 1000) / 1000,
            momentum: trend.momentum,
            volatility_score: Math.round(trend.volatilityScore * 1000) / 1000,
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
