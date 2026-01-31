/**
 * Order patterns & cycle time analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface PatternOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

interface OrderPatterns {
  total_orders: number;
  avg_quantity_per_order: number;
  median_quantity_per_order: number;
  min_order_size: number;
  max_order_size: number;
  order_frequency_days: number;
}

interface SizeDistribution {
  small: number;
  medium: number;
  large: number;
}

interface CycleTime {
  avg_estimate_to_invoice_days: number;
  median_days: number;
  conversion_rate: number;
}

interface WinLoss {
  estimates_created: number;
  converted_to_invoice: number;
  still_open_estimate: number;
  lost_estimate: number;
  win_rate: number;
}

interface PatternsOutput {
  item_id: string;
  item_name?: string;
  period: string;
  order_patterns: OrderPatterns;
  size_distribution: SizeDistribution;
  cycle_time: CycleTime | null;
  win_loss: WinLoss | null;
}

/**
 * Register patterns analytics command
 */
export function registerPatternsCommand(analytics: Command): void {
  analytics
    .command('patterns <item-id>')
    .description(`Analyze order patterns, cycle time, and win rate for an item

Examples:
  salesbinder analytics patterns <item-id>
  salesbinder analytics patterns <item-id> --refresh
  salesbinder analytics patterns <item-id> --cached

Output includes:
  - Order size distribution (small/medium/large)
  - Order frequency (days between orders)
  - Cycle time: Estimate to Invoice conversion
  - Win rate: Estimates converted to Invoices`)
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId: string, options: { refresh?: boolean; cached?: boolean }) => {
      try {
        const {
          SalesBinderClient,
          SQLiteCacheService,
          DocumentIndexerService,
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

        const analyticsOptions: PatternOptions = {
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
        const endDate = new Date(now);
        const startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 12);

        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        // Get all order patterns (Estimates and Invoices)
        const patterns = cache.getItemOrderPatterns(itemId, startDateStr, endDateStr);

        // Separate Invoices for order patterns analysis
        const invoices = patterns.filter(p => p.context_id === 5);

        // Calculate order patterns from Invoices
        const quantities = invoices.map(p => p.quantity);
        const totalOrders = invoices.length;
        const avgQty = analyticsService.calculateMean(quantities);
        const medianQty = analyticsService.calculateMedian(quantities);
        const minOrderSize = quantities.length > 0 ? Math.min(...quantities) : 0;
        const maxOrderSize = quantities.length > 0 ? Math.max(...quantities) : 0;

        // Calculate order frequency (average days between orders)
        let orderFrequencyDays = 0;
        if (invoices.length > 1) {
          const sortedDates = invoices
            .map(p => new Date(p.issue_date).getTime())
            .sort((a, b) => a - b);
          const gaps: number[] = [];
          for (let i = 1; i < sortedDates.length; i++) {
            gaps.push((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24));
          }
          orderFrequencyDays = Math.round(analyticsService.calculateMean(gaps));
        }

        const orderPatterns: OrderPatterns = {
          total_orders: totalOrders,
          avg_quantity_per_order: Math.round(avgQty * 100) / 100,
          median_quantity_per_order: Math.round(medianQty * 100) / 100,
          min_order_size: minOrderSize,
          max_order_size: maxOrderSize,
          order_frequency_days: orderFrequencyDays,
        };

        // Calculate size distribution
        const smallThreshold = avgQty / 2;
        const largeThreshold = avgQty * 2;

        const sizeDistribution: SizeDistribution = {
          small: quantities.filter(q => q < smallThreshold).length,
          medium: quantities.filter(q => q >= smallThreshold && q <= largeThreshold).length,
          large: quantities.filter(q => q > largeThreshold).length,
        };

        // Calculate cycle time and win rate (requires Estimates)
        const hasEstimates = patterns.some(p => p.context_id === 4);
        let cycleTime: CycleTime | null = null;
        let winLoss: WinLoss | null = null;

        if (hasEstimates) {
          const cycleTimeResult = analyticsService.calculateCycleTime(patterns);
          const winRateResult = analyticsService.calculateWinRate(patterns);

          cycleTime = {
            avg_estimate_to_invoice_days: cycleTimeResult.avg_estimate_to_invoice_days,
            median_days: cycleTimeResult.median_days,
            conversion_rate: winRateResult.win_rate,
          };

          winLoss = {
            estimates_created: winRateResult.estimates_created,
            converted_to_invoice: winRateResult.converted_to_invoice,
            still_open_estimate: winRateResult.still_open_estimate,
            lost_estimate: winRateResult.lost_estimate,
            win_rate: winRateResult.win_rate,
          };
        }

        cache.close();

        const result: PatternsOutput = {
          item_id: itemId,
          item_name: itemName,
          period: '12 months',
          order_patterns: orderPatterns,
          size_distribution: sizeDistribution,
          cycle_time: cycleTime,
          win_loss: winLoss,
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
