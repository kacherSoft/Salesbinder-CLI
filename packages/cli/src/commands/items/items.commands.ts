/**
 * Items commands for SalesBinder CLI
 */

import type { Command } from 'commander';
import type { ItemListParams, CreateItemDto } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { readJsonInput, validateNumberFlag } from '../../utils/input.util.js';

/**
 * Register all items commands
 */
export function registerItemsCommands(program: Command): void {
  const items = program.command('items').description('Manage inventory items (products, materials, equipment)');

  items
    .command('list')
    .description(`List and search inventory items

Examples:
  salesbinder items list
  salesbinder items list --limit 10
  salesbinder items list --search "cutter"
  salesbinder items list --category <category-id>
  salesbinder items list --modified 1704067200

Options:
  --page       Page number for pagination (default: 1)
  --limit      Records per page, 1-100 (default: 50)
  --category   Filter by category ID
  --search     Search term (matches name, description, SKU)
  --modified   Unix timestamp for delta sync (items modified since)`)
    .option('--page <number>', 'Page number')
    .option('--limit <number>', 'Records per page (1-100)')
    .option('--category <id>', 'Filter by category ID')
    .option('--search <term>', 'Search term')
    .option('--modified <timestamp>', 'Modified since Unix timestamp')
    .action(async (options) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const params: ItemListParams = {};
        if (options.page) params.page = validateNumberFlag(options.page, 'page', 1);
        if (options.limit) params.pageLimit = validateNumberFlag(options.limit, 'limit', 1, 100);
        if (options.category) params.categoryId = options.category;
        if (options.search) params.s = options.search;
        if (options.modified) params.modifiedSince = validateNumberFlag(options.modified, 'modified', 0);

        const result = await client.items.list(params);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  items
    .command('get <id>')
    .description(`Get detailed information for a single item

Example:
  salesbinder items get <item-id>

Returns complete item details including:
  - Basic info (name, description, SKU)
  - Pricing and cost
  - Quantities across locations
  - Variations and stock levels
  - Category assignments`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.items.get(id);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  items
    .command('create [file]')
    .description(`Create a new inventory item

Examples:
  salesbinder items create item.json
  echo '{"name":"New Product","description":"Description"}' | salesbinder items create

Required fields in JSON:
  - name: Item name (string)

Optional fields:
  - description: Item description
  - sku: Stock keeping unit
  - price: Selling price (number)
  - cost: Unit cost (number)
  - quantity: Initial quantity (number)
  - category_id: Category reference (string)

Input: JSON file or stdin with item data`)
    .action(async (file) => {
      try {
        const data = await readJsonInput(file, 'item');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.items.create(data as unknown as CreateItemDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  items
    .command('update <id> [file]')
    .description(`Update an existing inventory item

Examples:
  salesbinder items update <item-id> item.json
  echo '{"price":29.99}' | salesbinder items update <item-id>

Provide only the fields you want to update.
Omit fields to keep existing values.

Input: JSON file or stdin with partial item data`)
    .action(async (id, file) => {
      try {
        const data = await readJsonInput(file, 'item');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.items.update(id, data as unknown as CreateItemDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  items
    .command('delete <id>')
    .description(`Delete an inventory item

Example:
  salesbinder items delete <item-id>

Warning: This action is irreversible.
Consider using update to set item as inactive instead.`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        await client.items.delete(id);
        console.log(JSON.stringify({ success: true, deleted: id }, null, 2));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}

