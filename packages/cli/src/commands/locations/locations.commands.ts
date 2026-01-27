/**
 * Locations commands for SalesBinder CLI
 */

import type { Command } from 'commander';
import type { LocationListParams } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { validateNumberFlag } from '../../utils/input.util.js';

/**
 * Register all locations commands
 */
export function registerLocationsCommands(program: Command): void {
  const locations = program.command('locations').description('Manage inventory locations (warehouses, stores)');

  locations
    .command('list')
    .description(`List all inventory locations

Examples:
  salesbinder locations list
  salesbinder locations list --limit 20

Returns location details including:
  - Location name and short code
  - Address information
  - Item and zone counts
  - Associated zones

Options:
  --page       Page number for pagination (default: 1)
  --limit      Records per page, 1-200 (default: 50)`)
    .option('--page <number>', 'Page number')
    .option('--limit <number>', 'Records per page (1-200)')
    .action(async (options) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const params: LocationListParams = {};
        if (options.page) params.page = validateNumberFlag(options.page, 'page', 1);
        if (options.limit) params.pageLimit = validateNumberFlag(options.limit, 'limit', 1, 200);

        const result = await client.locations.list(params);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  locations
    .command('get <id>')
    .description(`Get detailed information for a single location

Example:
  salesbinder locations get <location-id>

Returns complete location details including:
  - Name and address
  - Item and zone counts
  - Zone definitions
  - Location settings`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.locations.get(id);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
