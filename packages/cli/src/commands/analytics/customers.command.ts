/**
 * Customer breakdown analytics command
 */

import type { Command } from 'commander';
import { formatJson, formatError } from '../../output/json.formatter.js';

interface CustomerOptions {
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
  resolveNames?: boolean;
}

interface TopCustomer {
  customer_id: string;
  customer_name?: string;
  quantity: number;
  revenue: number;
  share_pct: number;
  order_count: number;
  avg_order_size: number;
}

interface Concentration {
  top_3_share_pct: number;
  top_5_share_pct: number;
  herfindahl_index: number;
}

interface CustomerSegments {
  large: number;
  medium: number;
  small: number;
}

interface CustomersOutput {
  item_id: string;
  item_name?: string;
  period: string;
  total_customers: number;
  total_quantity: number;
  total_revenue: number;
  top_customers: TopCustomer[];
  concentration: Concentration;
  customer_segments: CustomerSegments;
}

/**
 * Register customers analytics command
 */
export function registerCustomersCommand(analytics: Command): void {
  analytics
    .command('customers <item-id>')
    .description(`Analyze customer breakdown and concentration for an item

Examples:
  salesbinder analytics customers <item-id>
  salesbinder analytics customers <item-id> --resolve-names
  salesbinder analytics customers <item-id> --refresh
  salesbinder analytics customers <item-id> --cached

Output includes:
  - Top customers by revenue
  - Market concentration metrics
  - Customer segmentation`)
    .option('--refresh', 'Force cache refresh before query')
    .option('--cached', 'Use cache without checking freshness')
    .option('--resolve-names', 'Fetch customer names from API (slower but more readable)')
    .action(async (itemId: string, options: { refresh?: boolean; cached?: boolean; resolveNames?: boolean }) => {
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

        const analyticsOptions: CustomerOptions = {
          forceRefresh: options.refresh,
          useCachedOnly: options.cached,
          resolveNames: options.resolveNames,
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

        const customerSales = cache.getItemSalesByCustomer(
          itemId,
          startDateStr,
          endDateStr,
          DocumentContextId.Invoice
        );

        const totalRevenue = customerSales.reduce((sum, c) => sum + Math.abs(c.revenue), 0);

        // Resolve customer names if requested
        const customerNameMap = new Map<string, string>();
        if (options.resolveNames) {
          console.error('Fetching customer names...');
          for (const sales of customerSales) {
            if (!customerNameMap.has(sales.customer_id)) {
              try {
                const customer = await client.customers.get(sales.customer_id);
                customerNameMap.set(sales.customer_id, customer.name);
              } catch {
                customerNameMap.set(sales.customer_id, sales.customer_id); // Fallback to ID
              }
            }
          }
        }

        const shares = customerSales.map(c => (Math.abs(c.revenue) / totalRevenue) * 100);

        const concentration: Concentration = {
          top_3_share_pct: Math.round(analyticsService.calculateTopShare(shares, 3) * 10) / 10,
          top_5_share_pct: Math.round(analyticsService.calculateTopShare(shares, 5) * 10) / 10,
          herfindahl_index: Math.round(analyticsService.calculateHerfindahlIndex(shares) * 1000) / 1000,
        };

        cache.close();

        const result: CustomersOutput = {
          item_id: itemId,
          item_name: itemName,
          period: '12 months',
          total_customers: customerSales.length,
          total_quantity: customerSales.reduce((sum, c) => sum + c.quantity, 0),
          total_revenue: Math.round(totalRevenue * 100) / 100,
          top_customers: customerSales.slice(0, 10).map(c => {
            const customer: TopCustomer = {
              customer_id: c.customer_id,
              quantity: c.quantity,
              revenue: Math.abs(c.revenue),
              share_pct: Math.round((Math.abs(c.revenue) / totalRevenue) * 1000) / 10,
              order_count: c.order_count,
              avg_order_size: Math.round((c.quantity / c.order_count) * 100) / 100,
            };
            if (options.resolveNames) {
              customer.customer_name = customerNameMap.get(c.customer_id);
            }
            return customer;
          }),
          concentration,
          customer_segments: {
            large: shares.filter(s => s > 10).length,
            medium: shares.filter(s => s >= 3 && s <= 10).length,
            small: shares.filter(s => s < 3).length,
          },
        };

        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
