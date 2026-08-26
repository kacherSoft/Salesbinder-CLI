/**
 * PostgreSQL cache service for the shared analytics cache upstream.
 */

import pg from 'pg';
import type { CacheService } from './cache.interface.js';
import type {
  AccountRow,
  CacheState,
  CacheSyncStatus,
  CustomerSalesData,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemSalesByPeriodRow,
  ItemStockLocationRow,
  PriceDistributionRow,
} from './types.js';

const { Pool } = pg;

const DOCUMENT_COLUMNS = [
  'doc_id', 'context_id', 'doc_number', 'issue_date', 'customer_id', 'modified',
  'api_doc_id', 'cache_source', 'document_name', 'custom_doc_number',
  'account_id', 'account_context_id', 'account_name', 'account_number',
  'user_id', 'salesperson_name', 'customer_name', 'customer_number',
  'supplier_name', 'supplier_number', 'status_id', 'status_name',
  'total_price', 'total_cost', 'subtotal', 'associated_document_id',
  'external_po_number', 'shipping_location', 'date_sent', 'shipped_percent', 'is_cancelled', 'imported_at',
] as const;

const ITEM_DOCUMENT_COLUMNS = [
  'item_id', 'doc_id', 'quantity', 'price', 'document_item_id', 'item_name',
  'item_number', 'item_sku', 'item_location', 'line_description',
  'quantity_received', 'quantity_shipped', 'cost', 'total_amount', 'discounted_price', 'discount_percent',
] as const;

const ACCOUNT_COLUMNS = [
  'account_id', 'context_id', 'account_number', 'name', 'office_email', 'office_phone',
  'office_fax', 'url', 'billing_address_1', 'billing_address_2', 'billing_city',
  'billing_region', 'billing_postal_code', 'billing_country', 'shipping_address_1',
  'shipping_address_2', 'shipping_city', 'shipping_region', 'shipping_postal_code',
  'shipping_country', 'vat_number', 'account_manager', 'label_name', 'archived',
  'last_invoiced', 'created', 'modified', 'cache_source', 'imported_at',
] as const;

const ITEM_COLUMNS = [
  'item_id', 'item_number', 'name', 'description', 'sku', 'serial_number', 'barcode',
  'category_id', 'category_name', 'quantity', 'quantity_reserved', 'quantity_available',
  'quantity_incoming', 'in_transit', 'threshold', 'cost', 'price', 'valuation',
  'published', 'created', 'modified', 'cache_source', 'imported_at',
] as const;

const STOCK_COLUMNS = [
  'stock_row_id', 'item_id', 'item_number', 'variation_id', 'variation_location_id',
  'location_id', 'location_name', 'category_name', 'quantity_on_hand',
  'quantity_reserved', 'quantity_available', 'quantity_incoming', 'in_transit',
  'price', 'cost', 'valuation', 'barcode', 'cache_source', 'imported_at',
] as const;

export class PostgresCacheService implements CacheService {
  private pool: InstanceType<typeof Pool>;
  private opened = true;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        account_number INTEGER NULL,
        name TEXT NOT NULL,
        office_email TEXT NULL,
        office_phone TEXT NULL,
        office_fax TEXT NULL,
        url TEXT NULL,
        billing_address_1 TEXT NULL,
        billing_address_2 TEXT NULL,
        billing_city TEXT NULL,
        billing_region TEXT NULL,
        billing_postal_code TEXT NULL,
        billing_country TEXT NULL,
        shipping_address_1 TEXT NULL,
        shipping_address_2 TEXT NULL,
        shipping_city TEXT NULL,
        shipping_region TEXT NULL,
        shipping_postal_code TEXT NULL,
        shipping_country TEXT NULL,
        vat_number TEXT NULL,
        account_manager TEXT NULL,
        label_name TEXT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        last_invoiced TEXT NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        doc_number INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        modified BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_documents (
        id SERIAL PRIMARY KEY,
        item_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        quantity NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY,
        item_number INTEGER NULL,
        name TEXT NOT NULL,
        description TEXT NULL,
        sku TEXT NULL,
        serial_number TEXT NULL,
        barcode TEXT NULL,
        category_id TEXT NULL,
        category_name TEXT NULL,
        quantity NUMERIC NULL,
        quantity_reserved NUMERIC NULL,
        quantity_available NUMERIC NULL,
        quantity_incoming NUMERIC NULL,
        in_transit NUMERIC NULL,
        threshold NUMERIC NULL,
        cost NUMERIC NULL,
        price NUMERIC NULL,
        valuation NUMERIC NULL,
        published INTEGER NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL
      );

      CREATE TABLE IF NOT EXISTS item_stock_locations (
        stock_row_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_number INTEGER NULL,
        variation_id TEXT NULL,
        variation_location_id TEXT NULL,
        location_id TEXT NULL,
        location_name TEXT NULL,
        category_name TEXT NULL,
        quantity_on_hand NUMERIC NOT NULL DEFAULT 0,
        quantity_reserved NUMERIC NOT NULL DEFAULT 0,
        quantity_available NUMERIC NOT NULL DEFAULT 0,
        quantity_incoming NUMERIC NOT NULL DEFAULT 0,
        in_transit NUMERIC NOT NULL DEFAULT 0,
        price NUMERIC NULL,
        cost NUMERIC NULL,
        valuation NUMERIC NULL,
        barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );

      -- Category taxonomy is part of the PostgreSQL cache contract. It is
      -- maintained by the category-cache sync, but must survive any normal
      -- schema ensure/restore path instead of being treated as a legacy table.
      CREATE TABLE IF NOT EXISTS categories (
        category_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_count INTEGER NULL,
        parent_id TEXT NULL,
        parent_name TEXT NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS category_cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await this.migrateDocumentColumns();
    await this.migrateItemDocumentColumns();
    await this.createIndexes();
  }

  private async migrateDocumentColumns(): Promise<void> {
    await this.pool.query(`
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS api_doc_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS cache_source TEXT NOT NULL DEFAULT 'api';
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS custom_doc_number TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_context_id INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS salesperson_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS customer_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS customer_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_id INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS total_price NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS total_cost NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS subtotal NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS associated_document_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_po_number TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipping_location TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS date_sent TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipped_percent NUMERIC NULL;
      -- Additive field owned by the live shipment-reconciliation app.
      -- Keep it out of DOCUMENT_COLUMNS so normal SalesBinder syncs never overwrite it.
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipment_checked_at TIMESTAMPTZ NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS imported_at BIGINT NULL;
    `);
  }

  private async migrateItemDocumentColumns(): Promise<void> {
    await this.pool.query(`
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS document_item_id TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_name TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_number INTEGER NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_sku TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_location TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS line_description TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_received NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_shipped NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS cost NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS total_amount NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discounted_price NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NULL;
    `);
  }

  private async createIndexes(): Promise<void> {
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_context_doc_number ON documents(context_id, doc_number);
      CREATE INDEX IF NOT EXISTS idx_documents_context ON documents(context_id);
      CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified);
      CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account_name ON documents(account_context_id, account_name);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status_id);
      CREATE INDEX IF NOT EXISTS idx_documents_shipped_percent ON documents(shipped_percent);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_api_doc_id ON documents(api_doc_id) WHERE api_doc_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_item_documents_item ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc ON item_documents(doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_name ON item_documents(item_name);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_number ON item_documents(item_number);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_sku ON item_documents(item_sku);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_number ON accounts(context_id, account_number);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_name ON accounts(context_id, name);
      CREATE INDEX IF NOT EXISTS idx_accounts_modified ON accounts(modified);
      CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts(archived);
      CREATE INDEX IF NOT EXISTS idx_items_modified ON items(modified);
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
      CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
      CREATE INDEX IF NOT EXISTS idx_items_item_number ON items(item_number);
      CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
      CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
      CREATE INDEX IF NOT EXISTS idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON item_stock_locations(location_id);
    `);
  }

  getDbPath(): string {
    try {
      const url = new URL(this.connectionString);
      url.password = '***';
      return url.toString();
    } catch {
      return this.connectionString;
    }
  }

  async insertDocument(doc: DocumentRow): Promise<void> {
    await this.pool.query(
      this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
      this.valuesFor(DOCUMENT_COLUMNS, await this.normalizeDocumentForWrite(doc))
    );
  }

  async getDocument(docId: string): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE doc_id = $1`, [docId])).rows[0];
  }

  async getDocumentByApiId(apiDocId: string): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE api_doc_id = $1`, [apiDocId])).rows[0];
  }

  async getDocumentByNumber(contextId: number, docNumber: number): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1 AND doc_number = $2`, [contextId, docNumber])).rows[0];
  }

  async getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1`, [contextId])).rows;
  }

  async getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE modified > $1 ORDER BY modified ASC`, [timestamp])).rows;
  }

  async getDocumentCountByContext(contextId: number): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents WHERE context_id = $1`, [contextId]);
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.pool.query(`DELETE FROM documents WHERE doc_id = $1`, [docId]);
  }

  async batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    await this.batch(docs, (doc) => this.pool.query(this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'), this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(doc))));
  }

  async batchDeleteDocuments(docIds: string[]): Promise<void> {
    await this.batch(docIds, (id) => this.pool.query(`DELETE FROM documents WHERE doc_id = $1`, [id]));
  }

  async insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    await this.pool.query(this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS), this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item)));
  }

  async getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    return (await this.pool.query<ItemDocumentRow>(`SELECT * FROM item_documents WHERE doc_id = $1`, [docId])).rows.map(this.coerceItemDocument);
  }

  async deleteItemDocuments(docId: string): Promise<void> {
    await this.pool.query(`DELETE FROM item_documents WHERE doc_id = $1`, [docId]);
  }

  async batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    await this.batch(items, (item) => this.pool.query(this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS), this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item))));
  }

  async insertAccount(account: AccountRow): Promise<void> {
    await this.pool.query(this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'), this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account)));
  }

  async getAccount(accountId: string): Promise<AccountRow | undefined> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE account_id = $1`, [accountId])).rows[0];
  }

  async getAccountByNumber(contextId: number, accountNumber: number): Promise<AccountRow | undefined> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE context_id = $1 AND account_number = $2`, [contextId, accountNumber])).rows[0];
  }

  async getAccountsByName(contextId: number, name: string): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE context_id = $1 AND name = $2`, [contextId, name])).rows;
  }

  async getAllAccounts(): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts`)).rows;
  }

  async getAccountsModifiedSince(timestamp: number): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE COALESCE(modified, 0) > $1 ORDER BY modified ASC`, [timestamp])).rows;
  }

  async batchInsertAccounts(accounts: AccountRow[]): Promise<void> {
    await this.batch(accounts, (account) => this.pool.query(this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'), this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account))));
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM accounts WHERE account_id = $1`, [accountId]);
  }

  async insertItem(item: ItemRow): Promise<void> {
    await this.pool.query(this.upsertSql('items', ITEM_COLUMNS, 'item_id'), this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)));
  }

  async getItem(itemId: string): Promise<ItemRow | undefined> {
    const row = (await this.pool.query<ItemRow>(`SELECT * FROM items WHERE item_id = $1`, [itemId])).rows[0];
    return row ? this.coerceItem(row) : undefined;
  }

  async getAllItems(): Promise<ItemRow[]> {
    return (await this.pool.query<ItemRow>(`SELECT * FROM items`)).rows.map(this.coerceItem);
  }

  async getItemsModifiedSince(timestamp: number): Promise<ItemRow[]> {
    return (await this.pool.query<ItemRow>(`SELECT * FROM items WHERE COALESCE(modified, 0) > $1 ORDER BY modified ASC`, [timestamp])).rows.map(this.coerceItem);
  }

  async batchInsertItems(items: ItemRow[]): Promise<void> {
    await this.batch(items, (item) => this.pool.query(this.upsertSql('items', ITEM_COLUMNS, 'item_id'), this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item))));
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.pool.query(`DELETE FROM items WHERE item_id = $1`, [itemId]);
  }

  async insertItemStockLocation(row: ItemStockLocationRow): Promise<void> {
    await this.pool.query(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'), this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
  }

  async getItemStockLocations(itemId: string): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations WHERE item_id = $1`, [itemId])).rows.map(this.coerceStock);
  }

  async getAllItemStockLocations(): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations`)).rows.map(this.coerceStock);
  }

  async replaceItemStockLocations(itemId: string, rows: ItemStockLocationRow[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [itemId]);
      for (const row of rows) {
        await client.query(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'), this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void> {
    await this.batch(rows, (row) => this.pool.query(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'), this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row))));
  }

  async deleteItemStockLocations(itemId: string): Promise<void> {
    await this.pool.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [itemId]);
  }

  async getItemDocumentsForPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemDocumentRow[]> {
    const result = await this.pool.query<ItemDocumentRow>(
      `SELECT id.* FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map(this.coerceItemDocument);
  }

  async getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined> {
    const result = await this.pool.query<{ latest_date: string | null }>(
      `SELECT MAX(d.issue_date) as latest_date FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id WHERE id.item_id = $1 AND d.context_id = $2`,
      [itemId, contextId]
    );
    return result.rows[0]?.latest_date || undefined;
  }

  async getItemSalesByPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemSalesByPeriodRow[]> {
    const result = await this.pool.query<ItemSalesByPeriodRow>(
      `SELECT d.issue_date, id.quantity, id.price FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({ ...row, quantity: Number(row.quantity), price: Number(row.price) }));
  }

  async getItemPriceDistribution(itemId: string, startDate: string, endDate: string, contextId: number): Promise<PriceDistributionRow[]> {
    const result = await this.pool.query<PriceDistributionRow>(
      `SELECT id.price, SUM(ABS(id.quantity)) as total_quantity, SUM(id.quantity * id.price) as total_revenue
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY id.price ORDER BY id.price ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      price: Number(row.price),
      total_quantity: Number(row.total_quantity),
      total_revenue: Number(row.total_revenue),
    }));
  }

  async getItemSalesByCustomer(itemId: string, startDate: string, endDate: string, contextId: number): Promise<CustomerSalesData[]> {
    const result = await this.pool.query<CustomerSalesData>(
      `SELECT d.customer_id, d.customer_name, SUM(ABS(id.quantity)) as quantity,
              SUM(id.quantity * id.price) as revenue, COUNT(DISTINCT id.doc_id) as order_count
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY d.customer_id, d.customer_name ORDER BY revenue DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
      order_count: Number(row.order_count),
    }));
  }

  async getItemSalesByMonth(itemId: string, startDate: string, endDate: string, contextId: number): Promise<{ month: string; quantity: number; revenue: number }[]> {
    const result = await this.pool.query<{ month: string; quantity: number; revenue: number }>(
      `SELECT to_char(d.issue_date::date, 'YYYY-MM') as month, SUM(ABS(id.quantity)) as quantity,
              SUM(id.quantity * id.price) as revenue
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY month ORDER BY month ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({ month: row.month, quantity: Number(row.quantity), revenue: Number(row.revenue) }));
  }

  async getItemOrderPatterns(itemId: string, startDate: string, endDate: string): Promise<{
    doc_id: string; quantity: number; price: number; issue_date: string; customer_id: string; context_id: number; doc_number: number;
  }[]> {
    const result = await this.pool.query<any>(
      `SELECT id.doc_id, id.quantity, id.price, d.issue_date, d.customer_id, d.context_id, d.doc_number
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id IN (4, 5) AND d.issue_date BETWEEN $2 AND $3
       ORDER BY d.issue_date DESC`,
      [itemId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      context_id: Number(row.context_id),
      doc_number: Number(row.doc_number),
    }));
  }

  async getCacheState(): Promise<CacheState | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'state'`);
    return result.rows.length ? JSON.parse(result.rows[0].value) as CacheState : null;
  }

  async setCacheState(state: CacheState): Promise<void> {
    await this.pool.query(
      `INSERT INTO cache_meta (key, value) VALUES ('state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(state)]
    );
  }

  async getSyncStatus(): Promise<CacheSyncStatus | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'sync_status'`);
    return result.rows.length ? JSON.parse(result.rows[0].value) as CacheSyncStatus : null;
  }

  async setSyncStatus(status: CacheSyncStatus): Promise<void> {
    await this.pool.query(
      `INSERT INTO cache_meta (key, value) VALUES ('sync_status', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(status)]
    );
  }

  async tryAcquireSyncLock(lockKey: string): Promise<boolean> {
    const result = await this.pool.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [lockKey]
    );
    return result.rows[0]?.acquired === true;
  }

  async releaseSyncLock(lockKey: string): Promise<void> {
    await this.pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
  }

  async getDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents`);
  }

  async getItemDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM item_documents`);
  }

  async getAccountCount(contextId?: number): Promise<number> {
    return contextId ? this.count(`SELECT COUNT(*) as count FROM accounts WHERE context_id = $1`, [contextId]) : this.count(`SELECT COUNT(*) as count FROM accounts`);
  }

  async getItemCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM items`);
  }

  async getStockLocationCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM item_stock_locations`);
  }

  async clearAll(): Promise<void> {
    await this.truncateAll();
  }

  async close(): Promise<void> {
    this.opened = false;
    await this.pool.end();
  }

  isOpen(): boolean {
    return this.opened;
  }

  async truncateAll(): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE item_stock_locations, item_documents, items, documents, accounts, cache_meta RESTART IDENTITY CASCADE`);
  }

  private async count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query<{ count: string }>(sql, params);
    return Number(result.rows[0].count);
  }

  private insertSql(table: string, columns: readonly string[]): string {
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
  }

  private upsertSql(table: string, columns: readonly string[], conflictColumn: string): string {
    const updates = columns
      .filter((column) => column !== conflictColumn)
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    return `${this.insertSql(table, columns)} ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`;
  }

  private valuesFor(columns: readonly string[], row: Record<string, unknown>): unknown[] {
    return columns.map((column) => this.sanitizeDbValue(row[column] ?? null));
  }

  /**
   * PostgreSQL rejects literal NUL bytes in text values. SalesBinder free-text
   * fields can contain them, so sanitize every outgoing string centrally instead
   * of relying on each indexer to remember every text field.
   */
  private sanitizeDbValue(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    return value.replace(/\u0000/g, '');
  }

  private async batch<T>(rows: T[], run: (row: T) => Promise<unknown>): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    const oldPool = this.pool;
    try {
      await client.query('BEGIN');
      this.pool = client as any;
      for (const row of rows) await run(row);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      this.pool = oldPool;
      client.release();
    }
  }

  private normalizeDocument(doc: DocumentRow): Record<string, unknown> {
    const accountId = doc.account_id ?? doc.customer_id;
    return {
      ...doc,
      customer_id: doc.customer_id || accountId || 'unknown',
      cache_source: doc.cache_source ?? 'api',
      account_id: doc.account_id ?? null,
      account_context_id: doc.account_context_id ?? null,
      account_name: doc.account_name ?? doc.customer_name ?? doc.supplier_name ?? null,
      is_cancelled: doc.is_cancelled ?? 0,
    };
  }

  private async normalizeDocumentForWrite(doc: DocumentRow): Promise<Record<string, unknown>> {
    let existing: { doc_id: string } | undefined;
    if (doc.api_doc_id) {
      existing = (await this.pool.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE api_doc_id = $1`,
        [doc.api_doc_id]
      )).rows[0];
    }
    if (!existing) {
      existing = (await this.pool.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE context_id = $1 AND doc_number = $2`,
        [doc.context_id, doc.doc_number]
      )).rows[0];
    }
    return this.normalizeDocument(existing ? { ...doc, doc_id: existing.doc_id } : doc);
  }

  private normalizeItemDocument(item: Omit<ItemDocumentRow, 'id'>): Record<string, unknown> {
    return { ...item, quantity: item.quantity ?? 0, price: item.price ?? 0 };
  }

  private normalizeAccount(account: AccountRow): Record<string, unknown> {
    return { ...account, archived: account.archived ?? 0, cache_source: account.cache_source ?? 'api' };
  }

  private normalizeItem(item: ItemRow): Record<string, unknown> {
    return { ...item, cache_source: item.cache_source ?? 'api' };
  }

  private normalizeStock(row: ItemStockLocationRow): Record<string, unknown> {
    return {
      ...row,
      quantity_on_hand: row.quantity_on_hand ?? 0,
      quantity_reserved: row.quantity_reserved ?? 0,
      quantity_available: row.quantity_available ?? 0,
      quantity_incoming: row.quantity_incoming ?? 0,
      in_transit: row.in_transit ?? 0,
      cache_source: row.cache_source ?? 'api',
    };
  }

  private coerceItemDocument(row: ItemDocumentRow): ItemDocumentRow {
    return {
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      quantity_received: row.quantity_received == null ? null : Number(row.quantity_received),
      quantity_shipped: row.quantity_shipped == null ? null : Number(row.quantity_shipped),
      cost: row.cost == null ? null : Number(row.cost),
      total_amount: row.total_amount == null ? null : Number(row.total_amount),
      discounted_price: row.discounted_price == null ? null : Number(row.discounted_price),
      discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
    };
  }

  private coerceItem(row: ItemRow): ItemRow {
    return {
      ...row,
      quantity: row.quantity == null ? null : Number(row.quantity),
      quantity_reserved: row.quantity_reserved == null ? null : Number(row.quantity_reserved),
      quantity_available: row.quantity_available == null ? null : Number(row.quantity_available),
      quantity_incoming: row.quantity_incoming == null ? null : Number(row.quantity_incoming),
      in_transit: row.in_transit == null ? null : Number(row.in_transit),
      threshold: row.threshold == null ? null : Number(row.threshold),
      cost: row.cost == null ? null : Number(row.cost),
      price: row.price == null ? null : Number(row.price),
      valuation: row.valuation == null ? null : Number(row.valuation),
    };
  }

  private coerceStock(row: ItemStockLocationRow): ItemStockLocationRow {
    return {
      ...row,
      quantity_on_hand: Number(row.quantity_on_hand),
      quantity_reserved: Number(row.quantity_reserved),
      quantity_available: Number(row.quantity_available),
      quantity_incoming: Number(row.quantity_incoming),
      in_transit: Number(row.in_transit),
      price: row.price == null ? null : Number(row.price),
      cost: row.cost == null ? null : Number(row.cost),
      valuation: row.valuation == null ? null : Number(row.valuation),
    };
  }
}
