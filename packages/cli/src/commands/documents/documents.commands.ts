/**
 * Documents commands for SalesBinder CLI
 */

import type { Command } from 'commander';
import type { DocumentListParams, CreateDocumentDto } from '@salesbinder/sdk';
import { formatJson, formatError } from '../../output/json.formatter.js';
import { readJsonInput, validateNumberFlag, validateContextId } from '../../utils/input.util.js';

/**
 * Register all documents commands
 */
export function registerDocumentsCommands(program: Command): void {
  const documents = program.command('documents').description('Manage documents (estimates, invoices, purchase orders)');

  documents
    .command('list')
    .description(`List and search documents

Examples:
  salesbinder documents list
  salesbinder documents list --context 5
  salesbinder documents list --customer <customer-id>
  salesbinder documents list --search "INV-"

Context IDs:
  4  = Estimate
  5  = Invoice
  11 = Purchase Order

Options:
  --page       Page number for pagination (default: 1)
  --limit      Records per page, 1-200 (default: 50)
  --context    Filter by context ID (4, 5, or 11)
  --customer   Filter by customer ID
  --search     Search term (matches number, notes)
  --modified   Unix timestamp for delta sync`)
    .option('--page <number>', 'Page number')
    .option('--limit <number>', 'Records per page (1-200)')
    .option('--context <id>', 'Context ID: 4=Estimate, 5=Invoice, 11=PO')
    .option('--customer <id>', 'Filter by customer ID')
    .option('--search <term>', 'Search term')
    .option('--modified <timestamp>', 'Modified since Unix timestamp')
    .action(async (options) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const params: DocumentListParams = {};
        if (options.page) params.page = validateNumberFlag(options.page, 'page', 1);
        if (options.limit) params.pageLimit = validateNumberFlag(options.limit, 'limit', 1, 200);
        if (options.context) params.contextId = validateContextId(options.context, 'document');
        if (options.customer) params.customerId = options.customer;
        if (options.search) params.s = options.search;
        if (options.modified) params.modifiedSince = validateNumberFlag(options.modified, 'modified', 0);

        const result = await client.documents.list(params);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  documents
    .command('get <id>')
    .description(`Get detailed information for a single document

Example:
  salesbinder documents get <document-id>

Returns complete document details including:
  - Document type and number
  - Customer information
  - Line items (document_items array)
  - Totals, taxes, payments
  - Issue and due dates
  - Status and history`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.documents.get(id);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  documents
    .command('create [file]')
    .description(`Create a new document (estimate, invoice, or PO)

Examples:
  salesbinder documents create invoice.json
  echo '{"context_id":5,"customer_id":"<id>","issue_date":"2026-01-27","document_items":[]}' | salesbinder documents create

Required fields in JSON:
  - context_id: Type (4=Estimate, 5=Invoice, 11=PO)
  - customer_id: Customer UUID
  - issue_date: ISO date string (YYYY-MM-DD)
  - document_items: Array of line items

Optional fields:
  - due_date: Due date
  - notes: Document notes
  - discount, discount_type: Discount settings

Input: JSON file or stdin with document data`)
    .action(async (file) => {
      try {
        const data = await readJsonInput(file, 'document');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.documents.create(data as unknown as CreateDocumentDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  documents
    .command('update <id> [file]')
    .description(`Update an existing document

Examples:
  salesbinder documents update <document-id> document.json
  echo '{"notes":"Updated notes"}' | salesbinder documents update <document-id>

Provide only the fields you want to update.

Input: JSON file or stdin with partial document data`)
    .action(async (id, file) => {
      try {
        const data = await readJsonInput(file, 'document');
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        const result = await client.documents.update(id, data as unknown as CreateDocumentDto);
        console.log(formatJson(result));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });

  documents
    .command('delete <id>')
    .description(`Delete a document

Example:
  salesbinder documents delete <document-id>

Warning: This action is irreversible.
Consider that deleting invoices affects financial records.`)
    .action(async (id) => {
      try {
        const { SalesBinderClient } = await import('@salesbinder/sdk');
        const accountName = program.opts().account;
        const client = new SalesBinderClient(accountName);

        await client.documents.delete(id);
        console.log(JSON.stringify({ success: true, deleted: id }, null, 2));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exit(1);
      }
    });
}
