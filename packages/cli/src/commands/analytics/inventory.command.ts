/**
 * Inventory analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface InventoryOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

interface InventoryOutput {
  item_id: string;
  item_name?: string;
  current_stock: number;
  stock_health: {
    status: 'critical' | 'low' | 'adequate' | 'overstocked';
    days_of_stock: number | null;
    stock_to_sales_ratio: number | null;
    risk_level: 'high' | 'medium' | 'low';
  };
  consumption: {
    avg_daily_sales: number;
    max_daily_sales: number;
    recent_trend: 'increasing' | 'decreasing' | 'stable';
  };
  reorder_recommendation: {
    should_reorder: boolean;
    suggested_qty: number | null;
    urgency: 'immediate' | 'soon' | 'monitor' | null;
    rationale: string;
  };
  overstock_assessment: {
    is_overstocked: boolean;
    excess_units: number;
    excess_value: number;
    carrying_cost_estimate: number | null;
  };
}

/**
 * Register inventory analytics command
 */
export function registerInventoryCommand(analytics: Command): void {
  analytics
    .command('inventory <item-id>')
    .description(`Analyze inventory health for an item

Examples:
  salesbinder analytics inventory <item-id>
  salesbinder analytics inventory <item-id> --refresh
  salesbinder analytics inventory <item-id> --cached

Output includes:
  - Stock health status and days of stock
  - Consumption metrics (avg/max daily sales)
  - Reorder recommendations
  - Overstock assessment`)
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .action(async (itemId: string, options: { refresh?: boolean; cached?: boolean }) => {
      try {
        const {
          SalesBinderClient,
          SQLiteCacheService,
          DocumentIndexerService,
          DocumentContextId,
          loadPreferences,
        } = await import('@salesbinder/sdk');

        const rootProgram = analytics.parent;
        const accountName = rootProgram?.opts().account || 'default';
        const client = new SalesBinderClient(accountName);
        const cache = new SQLiteCacheService(accountName);

        const prefs = loadPreferences();
        const indexer = new DocumentIndexerService(
          client,
          cache,
          accountName,
          prefs?.cacheStaleSeconds
        );

        const analyticsOptions: InventoryOptions = {
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
        let currentStock = 0;
        let unitCost: number | null = null;

        try {
          const item = await client.items.get(itemId);
          itemName = item.name;
          currentStock = item.quantity || 0;
          unitCost = item.cost || null;
        } catch (error) {
          console.error(`Warning: Could not fetch item details: ${error}`);
        }

        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 90);
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = now.toISOString().split('T')[0];

        const lineItems = cache.getItemSalesByPeriod(
          itemId,
          startDateStr,
          endDateStr,
          DocumentContextId.Invoice
        );

        const totalSold = lineItems.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
        const avgDailySales = totalSold / 90;

        const dailySalesMap = new Map<string, number>();
        for (const item of lineItems) {
          const date = item.issue_date;
          dailySalesMap.set(date, (dailySalesMap.get(date) || 0) + Math.abs(item.quantity));
        }

        const dailySales = Array.from(dailySalesMap.values());
        const maxDailySales = dailySales.length > 0 ? Math.max(...dailySales) : 0;

        let recentTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
        if (dailySales.length >= 2) {
          const firstHalf = dailySales.slice(0, Math.floor(dailySales.length / 2));
          const secondHalf = dailySales.slice(Math.floor(dailySales.length / 2));
          const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
          const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
          if (secondAvg > firstAvg * 1.2) recentTrend = 'increasing';
          else if (secondAvg < firstAvg * 0.8) recentTrend = 'decreasing';
        }

        const daysOfStock = avgDailySales > 0 ? Math.floor(currentStock / avgDailySales) : null;
        const stockToSalesRatio = avgDailySales > 0 ? currentStock / (avgDailySales * 30) : null;

        let status: 'critical' | 'low' | 'adequate' | 'overstocked';
        let riskLevel: 'high' | 'medium' | 'low';

        if (daysOfStock === null) {
          status = currentStock > 0 ? 'adequate' : 'critical';
          riskLevel = currentStock > 0 ? 'low' : 'high';
        } else if (daysOfStock < 14) {
          status = 'critical';
          riskLevel = 'high';
        } else if (daysOfStock < 30) {
          status = 'low';
          riskLevel = 'medium';
        } else if (daysOfStock > 90 && recentTrend === 'decreasing') {
          status = 'overstocked';
          riskLevel = 'medium';
        } else {
          status = 'adequate';
          riskLevel = 'low';
        }

        let shouldReorder = false;
        let suggestedQty: number | null = null;
        let urgency: 'immediate' | 'soon' | 'monitor' | null = null;
        let rationale = 'No reorder needed at this time';

        if (daysOfStock !== null) {
          if (daysOfStock < 14) {
            shouldReorder = true;
            urgency = 'immediate';
            suggestedQty = Math.ceil((30 - daysOfStock) * avgDailySales);
            rationale = `Current stock covers ${daysOfStock} days. Critical level - immediate reorder recommended.`;
          } else if (daysOfStock < 30) {
            shouldReorder = true;
            urgency = 'soon';
            suggestedQty = Math.ceil((45 - daysOfStock) * avgDailySales);
            rationale = `Current stock covers ${daysOfStock} days. Low level - reorder within 2 weeks.`;
          } else if (daysOfStock < 45) {
            urgency = 'monitor';
            rationale = `Current stock covers ${daysOfStock} days. Monitor stock levels.`;
          }
        }

        let isOverstocked = false;
        let excessUnits = 0;
        let excessValue = 0;

        if (daysOfStock !== null && daysOfStock > 90 && recentTrend === 'decreasing') {
          isOverstocked = true;
          excessUnits = Math.max(0, currentStock - 90 * avgDailySales);
          if (unitCost !== null) {
            excessValue = excessUnits * unitCost;
          }
        }

        const carryingCostEstimate = unitCost !== null ? excessValue * 0.25 : null;

        cache.close();

        const result: InventoryOutput = {
          item_id: itemId,
          item_name: itemName,
          current_stock: currentStock,
          stock_health: {
            status,
            days_of_stock: daysOfStock,
            stock_to_sales_ratio: stockToSalesRatio !== null ? Math.round(stockToSalesRatio * 100) / 100 : null,
            risk_level: riskLevel,
          },
          consumption: {
            avg_daily_sales: Math.round(avgDailySales * 100) / 100,
            max_daily_sales: Math.round(maxDailySales * 100) / 100,
            recent_trend: recentTrend,
          },
          reorder_recommendation: {
            should_reorder: shouldReorder,
            suggested_qty: suggestedQty !== null ? Math.round(suggestedQty) : null,
            urgency,
            rationale,
          },
          overstock_assessment: {
            is_overstocked: isOverstocked,
            excess_units: Math.round(excessUnits),
            excess_value: Math.round(excessValue * 100) / 100,
            carrying_cost_estimate: carryingCostEstimate !== null ? Math.round(carryingCostEstimate * 100) / 100 : null,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
