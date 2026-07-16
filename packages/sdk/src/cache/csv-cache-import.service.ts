import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import type { CacheService } from './cache.interface.js';
import type { AccountRow, DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId } from './types.js';
import { ContextId } from '../types/common.types.js';
import { parseCsvFile } from './csv-cache-import.parser.js';
import type { CsvImportOptions, CsvImportResult, CsvImportWarnings, CsvRow } from './csv-cache-import.types.js';

const INVOICE_FILES = [
  '2024-ptt-order-confirmation-line_items.csv',
  '2025-ptt-order-confirmation-line_items.csv',
  '2026-ptt-order-confirmation-line_items.csv',
] as const;

const CUSTOMER_FILE = 'customers.csv';
const SUPPLIER_FILE = 'suppliers.csv';
const PO_FILE = '2025-2026-po-line_items.csv';
const INVENTORY_FILE = 'inventory_variations_list.csv';

const ACCOUNT_HEADERS = [
  'Name', 'Account Number', 'Office Email', 'Office Phone', 'Office fax', 'URL',
  'Billing Address 1', 'Billing Address 2', 'Billing City', 'Billing Region',
  'Billing Postal-Zip Code', 'Billing Country', 'Shipping Address 1',
  'Shipping Address 2', 'Shipping City', 'Shipping Region', 'Shipping Postal-Zip Code',
  'Shipping Country', 'VAT Number', 'Account Manager', 'Label Name', 'ID',
  'Created', 'Last Modified', 'Archived',
];

const INVOICE_HEADERS = [
  'PTT Order Confirmation Number', 'Item Name', 'Item #', 'Item SKU', 'Description',
  'Quantity', 'Item Location', 'Unit Cost', 'Unit Price', 'Total Amount',
  'Discounted %', 'Account Name', 'Issue Date', 'Subtotal', 'Grand Total',
  'External PO#',
];

const PO_HEADERS = [
  'PO Number', 'Item Name', 'Item #', 'Item SKU', 'Description', 'Quantity',
  'Item Location', 'Quantity Received', 'Unit Price', 'Total Amount', 'Discounted %',
  'Account Name', 'Issue Date', 'Subtotal', 'Grand Total', 'Shipping Location',
];

const INVENTORY_HEADERS = [
  'Name', 'Item #', 'SKU', 'Quantity On Hand', 'Quantity Reserved',
  'Quantity Available', 'Quantity Incoming', 'In Transit', 'Variation ID',
  'Location', 'Category', 'Price', 'Cost', 'Valuation', 'Item ID', 'Location ID',
  'Barcode',
];

interface PreparedImport {
  accounts: AccountRow[];
  items: ItemRow[];
  stockRows: ItemStockLocationRow[];
  documents: DocumentRow[];
  lineItems: Omit<ItemDocumentRow, 'id'>[];
  counts: Omit<CsvImportResult, 'success' | 'mode' | 'files_checked' | 'warnings' | 'duration'>;
  warnings: CsvImportWarnings;
  maxInvoiceDate: string | null;
  maxPoDate: string | null;
}

export class CsvCacheImportService {
  constructor(private readonly cache: CacheService | null = null) {}

  async importDirectory(directory: string, options: CsvImportOptions): Promise<CsvImportResult> {
    const start = Date.now();
    const files = this.resolveFiles(directory);
    const prepared = await this.prepare(files);

    if (!options.dryRun) {
      await this.write(prepared, options.accountName);
    }

    return {
      success: true,
      mode: options.dryRun ? 'dry_run' : 'import',
      files_checked: files.length,
      ...prepared.counts,
      warnings: prepared.warnings,
      duration: `${((Date.now() - start) / 1000).toFixed(1)}s`,
    };
  }

  private resolveFiles(directory: string): string[] {
    const names = [CUSTOMER_FILE, SUPPLIER_FILE, ...INVOICE_FILES, PO_FILE, INVENTORY_FILE];
    const missing = names.filter((name) => !existsSync(join(directory, name)));
    if (missing.length > 0) {
      throw new Error(`Missing export files: ${missing.join(', ')}`);
    }
    return names.map((name) => join(directory, name));
  }

  private async prepare(files: string[]): Promise<PreparedImport> {
    const fileByName = new Map(files.map((path) => [path.split('/').pop(), path]));
    const importedAt = Math.floor(Date.now() / 1000);
    const customers = await this.readAccounts(fileByName.get(CUSTOMER_FILE)!, ContextId.Customer, importedAt);
    const suppliers = await this.readAccounts(fileByName.get(SUPPLIER_FILE)!, ContextId.Supplier, importedAt);
    const inventory = await this.readInventory(fileByName.get(INVENTORY_FILE)!, importedAt);
    const accountIndex = this.buildAccountIndex([...customers, ...suppliers]);
    const itemNumberIndex = this.buildItemNumberIndex(inventory.items);
    const warnings: CsvImportWarnings = {
      unmatched_account_names: 0,
      ambiguous_account_names: 0,
      unmatched_item_numbers: 0,
    };

    const invoice = await this.readDocuments(
      INVOICE_FILES.map((name) => fileByName.get(name)!),
      DocumentContextId.Invoice,
      accountIndex,
      itemNumberIndex,
      warnings,
      importedAt
    );
    const po = await this.readDocuments(
      [fileByName.get(PO_FILE)!],
      DocumentContextId.PurchaseOrder,
      accountIndex,
      itemNumberIndex,
      warnings,
      importedAt
    );

    return {
      accounts: [...customers, ...suppliers],
      items: inventory.items,
      stockRows: inventory.stockRows,
      documents: [...invoice.documents, ...po.documents],
      lineItems: [...invoice.lineItems, ...po.lineItems],
      counts: {
        accounts: {
          customers: customers.length,
          suppliers: suppliers.length,
          total: customers.length + suppliers.length,
        },
        documents: {
          invoices: invoice.documents.length,
          purchase_orders: po.documents.length,
          total: invoice.documents.length + po.documents.length,
        },
        line_items: {
          invoice_lines: invoice.lineItems.length,
          po_lines: po.lineItems.length,
          total: invoice.lineItems.length + po.lineItems.length,
        },
        items: {
          item_rows: inventory.items.length,
          stock_location_rows: inventory.stockRows.length,
          locations: inventory.locationIds.size,
          categories: inventory.categoryNames.size,
        },
      },
      warnings,
      maxInvoiceDate: invoice.maxDate,
      maxPoDate: po.maxDate,
    };
  }

  private async write(prepared: PreparedImport, accountName: string): Promise<void> {
    const cache = this.requireCache();
    const { documents, lineItems } = await this.resolveExistingDocuments(prepared, cache);
    const protectedRows = await this.excludeApiOwnedRows(prepared, cache);

    await cache.batchInsertAccounts(protectedRows.accounts);
    await cache.batchInsertItems(protectedRows.items);
    await cache.batchInsertItemStockLocations(protectedRows.stockRows);
    await cache.batchInsertDocuments(documents);

    for (const doc of documents) {
      await cache.deleteItemDocuments(doc.doc_id);
      await cache.deleteDocumentNonItemLines(doc.doc_id);
    }
    await cache.batchInsertItemDocuments(lineItems);

    const now = Math.floor(Date.now() / 1000);
    const previousState = { ...(await cache.getCacheState()) };
    delete previousState.lastAccountSync;
    delete previousState.lastDocumentSync;
    delete previousState.lastFullDocumentSync;
    delete previousState.lastItemSync;
    delete previousState.lastFullItemSync;
    delete previousState.lastDeletedSync;
    delete previousState.documentSyncCheckpoint;
    await cache.setCacheState({
      ...previousState,
      lastSync: now,
      lastFullSync: now,
      documentCount: await cache.getDocumentCount(),
      itemDocumentCount: await cache.getItemDocumentCount(),
      nonItemDocumentCount: await cache.getDocumentNonItemLineCount(),
      accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      accountCount: await cache.getAccountCount(),
      customerCount: await cache.getAccountCount(ContextId.Customer),
      supplierCount: await cache.getAccountCount(ContextId.Supplier),
      itemCount: await cache.getItemCount(),
      stockLocationCount: await cache.getStockLocationCount(),
    });
  }

  private async excludeApiOwnedRows(prepared: PreparedImport, cache: CacheService): Promise<{
    accounts: AccountRow[];
    items: ItemRow[];
    stockRows: ItemStockLocationRow[];
  }> {
    const apiAccountIds = new Set(
      (await cache.getAllAccounts())
        .filter((account) => account.cache_source === 'api')
        .map((account) => account.account_id)
    );
    const apiItemIds = new Set(
      (await cache.getAllItems())
        .filter((item) => item.cache_source === 'api')
        .map((item) => item.item_id)
    );
    const apiStockRowIds = new Set(
      (await cache.getAllItemStockLocations())
        .filter((row) => row.cache_source === 'api')
        .map((row) => row.stock_row_id)
    );

    return {
      accounts: prepared.accounts.filter((account) => !apiAccountIds.has(account.account_id)),
      items: prepared.items.filter((item) => !apiItemIds.has(item.item_id)),
      stockRows: prepared.stockRows.filter((row) => (
        !apiItemIds.has(row.item_id) && !apiStockRowIds.has(row.stock_row_id)
      )),
    };
  }

  private async resolveExistingDocuments(prepared: PreparedImport, cache: CacheService): Promise<{
    documents: DocumentRow[];
    lineItems: Omit<ItemDocumentRow, 'id'>[];
  }> {
    const docIdMap = new Map<string, string>();
    const protectedApiDocumentIds = new Set<string>();
    const documents: DocumentRow[] = [];

    for (const doc of prepared.documents) {
      const existing = await cache.getDocumentByNumber(doc.context_id, doc.doc_number);
      if (!existing) {
        documents.push(doc);
        docIdMap.set(doc.doc_id, doc.doc_id);
        continue;
      }

      if (existing.snapshot_complete === 1 && existing.api_doc_id) {
        protectedApiDocumentIds.add(doc.doc_id);
        continue;
      }

      documents.push(mergeDocument(existing, doc));
      docIdMap.set(doc.doc_id, existing.doc_id);
    }

    return {
      documents,
      lineItems: prepared.lineItems
        .filter((line) => !protectedApiDocumentIds.has(line.doc_id))
        .map((line) => ({
          ...line,
          doc_id: docIdMap.get(line.doc_id) ?? line.doc_id,
        })),
    };
  }

  private requireCache(): CacheService {
    if (!this.cache) {
      throw new Error('A writable cache service is required for CSV import.');
    }
    return this.cache;
  }

  private async readAccounts(filePath: string, contextId: ContextId, importedAt: number): Promise<AccountRow[]> {
    const { rows } = await parseCsvFile(filePath, ACCOUNT_HEADERS);
    return rows.map((row) => ({
      account_id: clean(row['ID']) || syntheticId('account', String(contextId), row['Name'], row['Account Number']),
      context_id: contextId,
      account_number: toNumber(row['Account Number']),
      name: clean(row['Name']) || 'Unknown',
      office_email: nullable(row['Office Email']),
      office_phone: nullable(row['Office Phone']),
      office_fax: nullable(row['Office fax']),
      url: nullable(row['URL']),
      billing_address_1: nullable(row['Billing Address 1']),
      billing_address_2: nullable(row['Billing Address 2']),
      billing_city: nullable(row['Billing City']),
      billing_region: nullable(row['Billing Region']),
      billing_postal_code: nullable(row['Billing Postal-Zip Code']),
      billing_country: nullable(row['Billing Country']),
      shipping_address_1: nullable(row['Shipping Address 1']),
      shipping_address_2: nullable(row['Shipping Address 2']),
      shipping_city: nullable(row['Shipping City']),
      shipping_region: nullable(row['Shipping Region']),
      shipping_postal_code: nullable(row['Shipping Postal-Zip Code']),
      shipping_country: nullable(row['Shipping Country']),
      vat_number: nullable(row['VAT Number']),
      account_manager: nullable(row['Account Manager']),
      label_name: nullable(row['Label Name']),
      archived: toBooleanNumber(row['Archived']),
      last_invoiced: normalizeDate(row['Last Invoiced']),
      created: nullable(row['Created']),
      modified: toUnix(row['Last Modified']),
      cache_source: 'csv',
      imported_at: importedAt,
    }));
  }

  private async readInventory(filePath: string, importedAt: number) {
    const { rows } = await parseCsvFile(filePath, INVENTORY_HEADERS);
    const itemMap = new Map<string, ItemRow>();
    const stockRows: ItemStockLocationRow[] = [];
    const locationIds = new Set<string>();
    const categoryNames = new Set<string>();

    rows.forEach((row, index) => {
      const itemId = clean(row['Item ID']) || syntheticId('item', row['Item #'], row['Name']);
      const itemNumber = toNumber(row['Item #']);
      const current = itemMap.get(itemId);
      const quantity = toNumber(row['Quantity On Hand']) ?? 0;
      const reserved = toNumber(row['Quantity Reserved']) ?? 0;
      const available = toNumber(row['Quantity Available']) ?? 0;
      const incoming = toNumber(row['Quantity Incoming']) ?? 0;
      const inTransit = toNumber(row['In Transit']) ?? 0;
      const valuation = toNumber(row['Valuation']) ?? 0;
      const locationId = clean(row['Location ID']);
      const categoryName = clean(row['Category']);
      if (locationId) locationIds.add(locationId);
      if (categoryName) categoryNames.add(categoryName);

      itemMap.set(itemId, {
        item_id: itemId,
        item_number: itemNumber,
        name: clean(row['Name']) || 'Unknown',
        sku: nullable(row['SKU']),
        barcode: nullable(row['Barcode']),
        category_name: nullable(row['Category']),
        quantity: (current?.quantity ?? 0) + quantity,
        quantity_reserved: (current?.quantity_reserved ?? 0) + reserved,
        quantity_available: (current?.quantity_available ?? 0) + available,
        quantity_incoming: (current?.quantity_incoming ?? 0) + incoming,
        in_transit: (current?.in_transit ?? 0) + inTransit,
        cost: toNumber(row['Cost']) ?? current?.cost ?? null,
        price: toNumber(row['Price']) ?? current?.price ?? null,
        valuation: (current?.valuation ?? 0) + valuation,
        cache_source: 'csv',
        imported_at: importedAt,
      });

      stockRows.push({
        stock_row_id: syntheticId('stock', itemId, row['Variation ID'], locationId, String(index)),
        item_id: itemId,
        item_number: itemNumber,
        variation_id: nullable(row['Variation ID']),
        variation_location_id: nullable(row['Variation ID']),
        location_id: nullable(locationId),
        location_name: nullable(row['Location']),
        category_name: nullable(row['Category']),
        quantity_on_hand: quantity,
        quantity_reserved: reserved,
        quantity_available: available,
        quantity_incoming: incoming,
        in_transit: inTransit,
        price: toNumber(row['Price']),
        cost: toNumber(row['Cost']),
        valuation: toNumber(row['Valuation']),
        barcode: nullable(row['Barcode']),
        cache_source: 'csv',
        imported_at: importedAt,
      });
    });

    return { items: [...itemMap.values()], stockRows, locationIds, categoryNames };
  }

  private async readDocuments(
    filePaths: string[],
    contextId: DocumentContextId,
    accountIndex: Map<string, AccountRow[]>,
    itemNumberIndex: Map<number, string[]>,
    warnings: CsvImportWarnings,
    importedAt: number
  ) {
    const documents = new Map<number, DocumentRow>();
    const lineItems: Omit<ItemDocumentRow, 'id'>[] = [];
    const unresolvedAccounts = new Set<string>();
    const ambiguousAccounts = new Set<string>();
    const unmatchedItems = new Set<string>();
    let maxDate: string | null = null;
    let lineIndex = 0;

    for (const filePath of filePaths) {
      const { rows } = await parseCsvFile(filePath, contextId === DocumentContextId.Invoice ? INVOICE_HEADERS : PO_HEADERS);
      for (const row of rows) {
        const docNumber = toNumber(contextId === DocumentContextId.Invoice ? row['PTT Order Confirmation Number'] : row['PO Number']);
        if (docNumber == null) continue;
        const issueDate = normalizeDate(row['Issue Date']) ?? '1970-01-01';
        if (maxDate === null || issueDate > maxDate) {
          maxDate = issueDate;
        }
        const account = this.resolveAccount(row, contextId, accountIndex, unresolvedAccounts, ambiguousAccounts);
        const docId = syntheticId('doc', String(contextId), String(docNumber));
        const itemNumber = toNumber(row['Item #']);
        const itemIds = itemNumber == null ? [] : itemNumberIndex.get(itemNumber) ?? [];
        const itemId = itemIds.length === 1
          ? itemIds[0]
          : syntheticId('item-line', row['Item #'], row['Item Name']);
        if (itemNumber != null && itemIds.length !== 1) unmatchedItems.add(String(itemNumber));

        documents.set(docNumber, {
          doc_id: docId,
          context_id: contextId,
          doc_number: docNumber,
          issue_date: issueDate,
          customer_id: account.accountId,
          modified: importedAt,
          cache_source: 'csv',
          document_name: nullable(row['Summary']),
          account_id: account.accountId,
          account_context_id: account.contextId,
          account_name: account.name,
          account_number: account.number,
          customer_name: contextId === DocumentContextId.Invoice ? account.name : null,
          customer_number: contextId === DocumentContextId.Invoice ? account.number : null,
          supplier_name: contextId === DocumentContextId.PurchaseOrder ? account.name : null,
          supplier_number: contextId === DocumentContextId.PurchaseOrder ? account.number : null,
          total_price: toNumber(row['Grand Total']),
          subtotal: toNumber(row['Subtotal']),
          external_po_number: nullable(row['External PO#']),
          shipping_location: nullable(row['Shipping Location']),
          snapshot_version: CACHE_SCHEMA_VERSION,
          snapshot_complete: 0,
          imported_at: importedAt,
        });

        lineItems.push({
          document_item_id: syntheticId('line', String(contextId), String(docNumber), String(lineIndex++)),
          item_id: itemId,
          doc_id: docId,
          quantity: toNumber(row['Quantity']) ?? 0,
          price: toNumber(row['Unit Price']) ?? 0,
          item_name: nullable(row['Item Name']),
          item_number: itemNumber,
          item_sku: nullable(row['Item SKU']) ?? nullable(row['Item Name']),
          item_location: nullable(row['Item Location']),
          line_description: nullable(row['Description']),
          quantity_received: contextId === DocumentContextId.PurchaseOrder ? toNumber(row['Quantity Received']) : null,
          cost: contextId === DocumentContextId.Invoice ? toNumber(row['Unit Cost']) : null,
          total_amount: toNumber(row['Total Amount']),
          discount_percent: toNumber(row['Discounted %']),
        });
      }
    }

    warnings.unmatched_account_names += unresolvedAccounts.size;
    warnings.ambiguous_account_names += ambiguousAccounts.size;
    warnings.unmatched_item_numbers += unmatchedItems.size;
    return { documents: [...documents.values()], lineItems, maxDate };
  }

  private buildAccountIndex(accounts: AccountRow[]): Map<string, AccountRow[]> {
    const index = new Map<string, AccountRow[]>();
    for (const account of accounts) {
      const key = accountKey(account.context_id, account.name);
      index.set(key, [...(index.get(key) ?? []), account]);
    }
    return index;
  }

  private buildItemNumberIndex(items: ItemRow[]): Map<number, string[]> {
    const index = new Map<number, string[]>();
    for (const item of items) {
      if (item.item_number == null) continue;
      index.set(item.item_number, [...(index.get(item.item_number) ?? []), item.item_id]);
    }
    return index;
  }

  private resolveAccount(
    row: CsvRow,
    documentContextId: DocumentContextId,
    accountIndex: Map<string, AccountRow[]>,
    unresolved: Set<string>,
    ambiguous: Set<string>
  ) {
    const accountContextId = documentContextId === DocumentContextId.PurchaseOrder ? ContextId.Supplier : ContextId.Customer;
    const name = clean(row['Account Name']) || 'Unknown';
    const candidates = accountIndex.get(accountKey(accountContextId, name)) ?? [];
    if (candidates.length === 1) {
      const match = candidates[0];
      return { accountId: match.account_id, contextId: accountContextId, name, number: match.account_number ?? null };
    }
    if (candidates.length > 1) ambiguous.add(name);
    if (candidates.length === 0) unresolved.add(name);
    return {
      accountId: syntheticId('unmatched-account', String(accountContextId), name),
      contextId: accountContextId,
      name,
      number: null,
    };
  }
}

function accountKey(contextId: number, name: string): string {
  return `${contextId}:${name.trim().toLocaleLowerCase()}`;
}

function syntheticId(...parts: string[]): string {
  return `csv:${parts[0]}:${createHash('sha1').update(parts.slice(1).join('|')).digest('hex').slice(0, 24)}`;
}

function mergeDocument(existing: DocumentRow, imported: DocumentRow): DocumentRow {
  return {
    ...imported,
    doc_id: existing.doc_id,
    api_doc_id: existing.api_doc_id ?? imported.api_doc_id ?? null,
    user_id: existing.user_id ?? imported.user_id ?? null,
    salesperson_name: existing.salesperson_name ?? imported.salesperson_name ?? null,
    status_id: existing.status_id ?? imported.status_id ?? null,
    status_name: existing.status_name ?? imported.status_name ?? null,
    date_sent: existing.date_sent ?? imported.date_sent ?? null,
    shipped_percent: existing.shipped_percent ?? imported.shipped_percent ?? null,
    shipment_checked_at: existing.shipment_checked_at ?? null,
    source_fetched_at: existing.source_fetched_at ?? null,
    snapshot_version: CACHE_SCHEMA_VERSION,
    snapshot_complete: 0,
    is_cancelled: existing.is_cancelled ?? imported.is_cancelled ?? 0,
    cache_source: existing.api_doc_id ? 'api' : imported.cache_source,
  };
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function nullable(value: string | undefined): string | null {
  const cleaned = clean(value);
  return cleaned === '' ? null : cleaned;
}

function toNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/,/g, '').replace(/%$/, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanNumber(value: string | undefined): number {
  const cleaned = clean(value).toLocaleLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(cleaned) ? 1 : 0;
}

function normalizeDate(value: string | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function toUnix(value: string | undefined): number | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}
