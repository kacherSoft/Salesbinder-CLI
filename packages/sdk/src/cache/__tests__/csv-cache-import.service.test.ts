import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CsvCacheImportService } from '../csv-cache-import.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { DocumentContextId } from '../types.js';

describe('CsvCacheImportService', () => {
  let dir: string;
  let dbPath: string;
  let cache: SQLiteCacheService;
  let importer: CsvCacheImportService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'salesbinder-csv-fixture-'));
    dbPath = join(dir, 'cache.db');
    cache = new SQLiteCacheService('test', dbPath);
    importer = new CsvCacheImportService(cache);
    writeFixtureSet(dir);
  });

  afterEach(async () => {
    await cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dry-runs synthetic exports without writes', async () => {
    const result = await importer.importDirectory(dir, { dryRun: true, accountName: 'test' });

    expect(result.accounts.total).toBe(2);
    expect(result.documents.total).toBe(2);
    expect(result.line_items.total).toBe(2);
    expect(result.items.item_rows).toBe(1);
    expect(result.items.stock_location_rows).toBe(1);
    expect(await cache.getDocumentCount()).toBe(0);
  });

  it('imports and reimports synthetic exports idempotently', async () => {
    await importer.importDirectory(dir, { accountName: 'test' });
    await importer.importDirectory(dir, { accountName: 'test' });

    expect(await cache.getAccountCount()).toBe(2);
    expect(await cache.getDocumentCount()).toBe(2);
    expect(await cache.getItemDocumentCount()).toBe(2);
    expect(await cache.getItemCount()).toBe(1);
    expect(await cache.getStockLocationCount()).toBe(1);

    const invoice = await cache.getDocumentByNumber(DocumentContextId.Invoice, 1001);
    expect(invoice?.customer_name).toBe('Customer A');
    const lines = await cache.getItemDocuments(invoice!.doc_id);
    expect(lines[0].item_name).toBe('SKU-ITEM-A');
  });

  it('rejects missing required headers before writes', async () => {
    writeFileSync(join(dir, 'customers.csv'), 'Name,ID\nCustomer A,cust-a\n');

    await expect(importer.importDirectory(dir, { accountName: 'test' }))
      .rejects.toThrow(/missing Account Number/);
    expect(await cache.getAccountCount()).toBe(0);
  });
});

function writeFixtureSet(dir: string): void {
  writeFileSync(join(dir, 'customers.csv'), [
    'Name,"Account Number","Office Email","Office Phone","Office fax",URL,"Billing Address 1","Billing Address 2","Billing City","Billing Region","Billing Postal-Zip Code","Billing Country","Shipping Address 1","Shipping Address 2","Shipping City","Shipping Region","Shipping Postal-Zip Code","Shipping Country","VAT Number","Account Manager","Label Name",ID,Created,"Last Modified","Last Invoiced",Archived',
    'Customer A,101,,,,,,,,,,,,,,,,,,,,cust-a,2026-01-01,2026-01-02,,No',
  ].join('\n'));
  writeFileSync(join(dir, 'suppliers.csv'), [
    'Name,"Account Number","Office Email","Office Phone","Office fax",URL,"Billing Address 1","Billing Address 2","Billing City","Billing Region","Billing Postal-Zip Code","Billing Country","Shipping Address 1","Shipping Address 2","Shipping City","Shipping Region","Shipping Postal-Zip Code","Shipping Country","VAT Number","Account Manager","Label Name",ID,Created,"Last Modified",Archived',
    'Supplier A,201,,,,,,,,,,,,,,,,,,,,sup-a,2026-01-01,2026-01-02,No',
  ].join('\n'));
  writeFileSync(join(dir, 'inventory_variations_list.csv'), [
    'Name,"Item #",SKU,"Quantity On Hand","Quantity Reserved","Quantity Available","Quantity Incoming","In Transit","Variation ID",Attributes,Location,Category,Price,Cost,Valuation,"Item ID","Location ID",Barcode',
    'SKU-ITEM-A,5001,SKU-ITEM-A,10,1,9,0,0,var-a,,Main,Category A,12,8,80,item-a,loc-a,barcode-a',
  ].join('\n'));
  writeFileSync(join(dir, '2024-ptt-order-confirmation-line_items.csv'), invoiceCsv([
    '1001,SKU-ITEM-A,5001,SKU-ITEM-A,Line A,2,Main,8,12,24,0,Customer A,2026-01-03,0,0,24,24,No,,,PO-1,',
  ]));
  writeFileSync(join(dir, '2025-ptt-order-confirmation-line_items.csv'), invoiceCsv([]));
  writeFileSync(join(dir, '2026-ptt-order-confirmation-line_items.csv'), invoiceCsv([]));
  writeFileSync(join(dir, '2025-2026-po-line_items.csv'), poCsv([
    '2001,SKU-ITEM-A,5001,SKU-ITEM-A,PO Line A,3,Main,1,10,30,0,Supplier A,2026-01-04,0,0,30,30,No,,,Warehouse A',
  ]));
}

function invoiceCsv(rows: string[]): string {
  return [
    '"PTT Order Confirmation Number","Item Name","Item #","Item SKU",Description,Quantity,"Item Location","Unit Cost","Unit Price","Total Amount","Discounted %","Account Name","Issue Date",VAT,"Tax 2",Subtotal,"Grand Total","Drop Shipped",Attention,Summary,"External PO#","Service Type"',
    ...rows,
  ].join('\n');
}

function poCsv(rows: string[]): string {
  return [
    '"PO Number","Item Name","Item #","Item SKU",Description,Quantity,"Item Location","Quantity Received","Unit Price","Total Amount","Discounted %","Account Name","Issue Date",VAT,"Tax 2",Subtotal,"Grand Total","Drop Shipped",Attention,Summary,"Shipping Location"',
    ...rows,
  ].join('\n');
}
