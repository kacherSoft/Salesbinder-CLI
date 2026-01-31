/**
 * Sales forecasting analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface ForecastOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

interface ForecastMonth {
  month: string;
  predicted_quantity: number;
  predicted_revenue: number;
  confidence: 'high' | 'medium' | 'low';
}

interface ForecastSummary {
  avg_monthly_sales: number;
  trend_adjustment: number;
  volatility: number;
}

interface ForecastOutput {
  item_id: string;
  item_name?: string;
  method: string;
  historical_period: string;
  forecast: ForecastMonth[];
  summary: ForecastSummary;
}

/**
 * Register forecast analytics command
 */
export function registerForecastCommand(analytics: Command): void {
  analytics
    .command('forecast <item-id>')
    .description(`Forecast sales for an item using moving average with trend adjustment

Examples:
  salesbinder analytics forecast <item-id>
  salesbinder analytics forecast <item-id> --refresh
  salesbinder analytics forecast <item-id> --cached

Output includes:
  - 3-month sales prediction
  - Confidence levels (high/medium/low)
  - Trend adjustment factor
  - Volatility score`)
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

        const analyticsOptions: ForecastOptions = {
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
        let itemPrice = 0;
        try {
          const item = await client.items.get(itemId);
          itemName = item.name;
          itemPrice = item.price > 0 ? item.price : 0;
        } catch (error) {
          console.error(`Warning: Could not fetch item details: ${error}`);
        }

        const now = new Date();
        const endDate = new Date(now);
        const startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 6);

        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        const monthlySales = cache.getItemSalesByMonth(
          itemId,
          startDateStr,
          endDateStr,
          DocumentContextId.Invoice
        );

        const quantities = monthlySales.map(m => m.quantity);
        const avgMonthlySales = analyticsService.calculateMean(quantities);
        const volatility = analyticsService.calculateVolatility(quantities);

        const growthRate = quantities.length >= 2
          ? analyticsService.calculateGrowthRate(quantities[0], quantities[quantities.length - 1])
          : 0;

        const baseForecast = analyticsService.forecastMovingAverage(quantities, 3);
        const adjustedForecast = analyticsService.applyTrendAdjustment(baseForecast, growthRate / 6);
        const confidence = analyticsService.determineConfidence(volatility, quantities.length);

        const forecast: ForecastMonth[] = [];
        const baseDate = new Date(now);
        baseDate.setDate(1);
        baseDate.setMonth(baseDate.getMonth() + 1);

        for (let i = 0; i < 3; i++) {
          const forecastDate = new Date(baseDate);
          forecastDate.setMonth(forecastDate.getMonth() + i);
          const monthStr = forecastDate.toISOString().slice(0, 7);

          const predictedQty = Math.max(0, Math.round(adjustedForecast[i]));
          const avgRevenuePerQty = monthlySales.length > 0 && avgMonthlySales > 0
            ? monthlySales.reduce((sum, m) => sum + m.revenue, 0) / quantities.reduce((sum, q) => sum + q, 0)
            : itemPrice;
          const revenue = Math.round(predictedQty * avgRevenuePerQty * 100) / 100;

          forecast.push({
            month: monthStr,
            predicted_quantity: predictedQty,
            predicted_revenue: revenue,
            confidence,
          });
        }

        cache.close();

        const result: ForecastOutput = {
          item_id: itemId,
          item_name: itemName,
          method: 'moving_average',
          historical_period: '6 months',
          forecast,
          summary: {
            avg_monthly_sales: Math.round(avgMonthlySales * 100) / 100,
            trend_adjustment: Math.round(growthRate * 1000) / 1000,
            volatility: Math.round(volatility * 1000) / 1000,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
