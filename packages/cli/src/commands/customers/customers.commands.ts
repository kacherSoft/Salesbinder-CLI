/**
 * Customers commands for SalesBinder CLI
 */

import type { Command } from 'commander';
import type { CustomerListParams, CreateCustomerDto } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { readJsonInput, validateNumberFlag, validateContextId } from '../../utils/input.util.js';

/**
 * Register all customers commands
 */
export function registerCustomersCommands(program: Command): void {
  const customers = program.command('customers').description('Manage customers, prospects, and suppliers');

  customers
    .command('list')
    .description(`List and search customer accounts

Examples:
  salesbinder customers list
  salesbinder customers list --context 2
  salesbinder customers list --search "Acme"
  salesbinder customers list --limit 20

Context IDs:
  2 = Customer
  8 = Prospect
  10 = Supplier

Options:
  --page       Page number for pagination (default: 1)
  --limit      Records per page, 1-200 (default: 50)
  --context    Filter by context ID (2, 8, or 10)
  --search     Search term (matches name, company, email)
  --modified   Unix timestamp for delta sync`)
    .option('--page <number>', 'Page number')
    .option('--limit <number>', 'Records per page (1-200)')
    .option('--context <id>', 'Context ID: 2=Customer, 8=Prospect, 10=Supplier')
    .option('--search <term>', 'Search term')
    .option('--modified <timestamp>', 'Modified since Unix timestamp')
    .action(async (options) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const params: CustomerListParams = {};
        if (options.page) params.page = validateNumberFlag(options.page, 'page', 1);
        if (options.limit) params.pageLimit = validateNumberFlag(options.limit, 'limit', 1, 200);
        if (options.context) params.contextId = validateContextId(options.context, 'customer');
        if (options.search) params.s = options.search;
        if (options.modified) params.modifiedSince = validateNumberFlag(options.modified, 'modified', 0);

        const result = await client.customers.list(params);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  customers
    .command('get <id>')
    .description(`Get detailed information for a single customer

Example:
  salesbinder customers get <customer-id>

Returns complete customer details including:
  - Contact information (name, company, email, phone)
  - Billing and shipping addresses
  - Customer type (context)
  - Account status and metadata`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.customers.get(id);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  customers
    .command('create [file]')
    .description(`Create a new customer, prospect, or supplier

Examples:
  salesbinder customers create customer.json
  echo '{"name":"John Doe","company_id":"2"}' | salesbinder customers create

Required fields in JSON:
  - name: Contact name (string)
  - context_id: Type (2=Customer, 8=Prospect, 10=Supplier)

Optional fields:
  - company: Company name
  - email: Email address
  - phone: Phone number
  - address_1, address_2, city, state, country, zip

Input: JSON file or stdin with customer data`)
    .action(async (file) => {
      try {
        const data = await readJsonInput(file, 'customer');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.customers.create(data as unknown as CreateCustomerDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  customers
    .command('update <id> [file]')
    .description(`Update an existing customer

Examples:
  salesbinder customers update <customer-id> customer.json
  echo '{"email":"new@example.com"}' | salesbinder customers update <customer-id>

Provide only the fields you want to update.

Input: JSON file or stdin with partial customer data`)
    .action(async (id, file) => {
      try {
        const data = await readJsonInput(file, 'customer');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.customers.update(id, data as unknown as CreateCustomerDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  customers
    .command('delete <id>')
    .description(`Delete a customer account

Example:
  salesbinder customers delete <customer-id>

Warning: This action is irreversible.
Consider that existing documents may reference this customer.`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        await client.customers.delete(id);
        console.log(JSON.stringify({ success: true, deleted: id }, null, 2));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}

