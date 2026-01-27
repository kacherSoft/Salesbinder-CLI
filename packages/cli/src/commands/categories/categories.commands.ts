/**
 * Categories commands for SalesBinder CLI
 */

import type { Command } from 'commander';
import type { CategoryListParams, CreateCategoryDto } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { readJsonInput, validateNumberFlag } from '../../utils/input.util.js';

/**
 * Register all categories commands
 */
export function registerCategoriesCommands(program: Command): void {
  const categories = program.command('categories').description('Manage item categories for organization');

  categories
    .command('list')
    .description(`List all item categories

Examples:
  salesbinder categories list
  salesbinder categories list --limit 50

Returns category details including:
  - Category name
  - Item count
  - Parent category reference
  - Created and modified timestamps

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

        const params: CategoryListParams = {};
        if (options.page) params.page = validateNumberFlag(options.page, 'page', 1);
        if (options.limit) params.pageLimit = validateNumberFlag(options.limit, 'limit', 1, 200);

        const result = await client.categories.list(params);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  categories
    .command('get <id>')
    .description(`Get detailed information for a single category

Example:
  salesbinder categories get <category-id>

Returns complete category details including:
  - Category name and ID
  - Item count
  - Parent category (if nested)
  - Creation and modification timestamps`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.categories.get(id);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  categories
    .command('create [file]')
    .description(`Create a new item category

Examples:
  salesbinder categories create category.json
  echo '{"name":"Tools"}' | salesbinder categories create

Required fields in JSON:
  - name: Category name (string)

Optional fields:
  - parent_id: Parent category UUID for nesting

Input: JSON file or stdin with category data`)
    .action(async (file) => {
      try {
        const data = await readJsonInput(file, 'category');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.categories.create(data as unknown as CreateCategoryDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  categories
    .command('update <id> [file]')
    .description(`Update an existing category

Examples:
  salesbinder categories update <category-id> category.json
  echo '{"name":"Updated Name"}' | salesbinder categories update <category-id>

Provide only the fields you want to update.

Input: JSON file or stdin with partial category data`)
    .action(async (id, file) => {
      try {
        const data = await readJsonInput(file, 'category');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.categories.update(id, data as unknown as CreateCategoryDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  categories
    .command('delete <id>')
    .description(`Delete a category

Example:
  salesbinder categories delete <category-id>

Warning: This action is irreversible.
Items in this category may become uncategorized.`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        await client.categories.delete(id);
        console.log(JSON.stringify({ success: true, deleted: id }, null, 2));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
