/**
 * SQLite cache service for local analytics reads.
 */

import Database from 'better-sqlite3';
import {
  chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CacheService, SQLiteMirrorSnapshot } from './cache.interface.js';
import type {
  AccountRow,
  CacheAccountBinding,
  CacheMetaRow,
  CacheState,
  CacheSyncStatus,
  CategoryCacheMeta,
  CategoryCacheRow,
  CategorySnapshot,
  CustomerSalesData,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemSalesByPeriodRow,
  ItemStockLocationRow,
  InventoryCacheMeta,
  InventorySnapshot,
  PriceDistributionRow,
} from './types.js';
import {
  CACHE_SCHEMA_VERSION,
  CATEGORY_GENERATION_META_KEY,
  CATEGORY_SNAPSHOT_META_KEY,
  INVENTORY_ACCOUNT_META_KEY,
  INVENTORY_SNAPSHOT_META_KEY,
  createSalesBinderAccountBinding,
} from './types.js';
import { PAYMENT_SYNC_STATUS_KEY, PAYMENT_TRANSACTION_COLUMNS } from './payment-cache.constants.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from './payment-sync.types.js';
import {
  assertPaymentRowsMatchDocument,
  assertUniquePaymentTransactionIds,
} from './payment-sync.helpers.js';

const DOCUMENT_COLUMNS = [
  'doc_id', 'context_id', 'doc_number', 'issue_date', 'customer_id', 'modified',
  'api_doc_id', 'cache_source', 'document_name', 'custom_doc_number',
  'account_id', 'account_context_id', 'account_name', 'account_number',
  'user_id', 'salesperson_name', 'customer_name', 'customer_number',
  'supplier_name', 'supplier_number', 'status_id', 'status_name',
  'total_price', 'total_cost', 'subtotal', 'associated_document_id',
  'external_po_number', 'shipping_location', 'date_sent', 'shipped_percent',
  'is_cancelled', 'archived', 'imported_at',
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

const CATEGORY_COLUMNS = [
  'category_id', 'name', 'item_count', 'parent_id', 'parent_name',
  'inventory_type', 'custom_fields_json', 'created', 'modified', 'cache_source',
  'source_api_version', 'imported_at',
] as const;

const ITEM_COLUMNS = [
  'item_id', 'item_number', 'name', 'description', 'sku', 'serial_number', 'barcode',
  'category_id', 'category_name', 'quantity', 'quantity_reserved', 'quantity_available',
  'quantity_incoming', 'in_transit', 'threshold', 'cost', 'price', 'valuation',
  'published', 'archived', 'created', 'modified', 'cache_source',
  'source_api_version', 'imported_at',
] as const;

const STOCK_COLUMNS = [
  'stock_row_id', 'item_id', 'item_number', 'variation_id', 'variation_location_id',
  'location_id', 'location_name', 'category_name', 'quantity_on_hand',
  'quantity_reserved', 'quantity_available', 'quantity_incoming', 'in_transit',
  'price', 'cost', 'valuation', 'barcode', 'cache_source', 'source_api_version',
  'imported_at',
] as const;

const SQLITE_ACCOUNT_IDENTITY_META_KEY = 'cache_account_binding.v1.account_identity';
const SQLITE_ACCOUNT_SUBDOMAIN_META_KEY = 'cache_account_binding.v1.account_subdomain';

export class SQLiteCacheService implements CacheService {
  private db: Database.Database;
  private readonly accountName: string;
  private readonly dbPath: string;
  private readonly syncLocks = new Map<string, { fd: number; path: string }>();

  constructor(accountName: string, customPath?: string) {
    this.accountName = this.sanitizeAccountName(accountName);
    this.dbPath = customPath || this.resolveCachePath(this.accountName);
    this.db = this.connect();
    this.initializeSchema();
  }

  private sanitizeAccountName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private resolveCachePath(accountName: string): string {
    const cacheDir = join(homedir(), '.salesbinder', 'cache');
    mkdirSync(cacheDir, { mode: 0o700, recursive: true });
    return join(cacheDir, `salesbinder-${accountName}.db`);
  }

  private connect(): Database.Database {
    const debugSql = process.env['DEBUG'] === 'true';
    const db = new Database(this.dbPath, {
      fileMustExist: false,
      verbose: debugSql ? console.log : undefined,
    });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    if (existsSync(this.dbPath)) {
      try { chmodSync(this.dbPath, 0o600); } catch { /* ignore */ }
    }
    return db;
  }

  private initializeSchema(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (currentVersion === 0) {
      this.createSchema();
      this.createIndexes();
      this.db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
      return;
    }
    if (currentVersion < CACHE_SCHEMA_VERSION) {
      const migrate = this.db.transaction(() => {
        this.migrateSchema(currentVersion);
        this.db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
      });
      migrate.immediate();
    }
  }

  private createSchema(): void {
    this.db.exec(`
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
        modified INTEGER NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at INTEGER NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        doc_number INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        modified INTEGER NOT NULL,
        api_doc_id TEXT NULL UNIQUE,
        cache_source TEXT NOT NULL DEFAULT 'api',
        document_name TEXT NULL,
        custom_doc_number TEXT NULL,
        account_id TEXT NULL,
        account_context_id INTEGER NULL,
        account_name TEXT NULL,
        account_number INTEGER NULL,
        user_id TEXT NULL,
        salesperson_name TEXT NULL,
        customer_name TEXT NULL,
        customer_number INTEGER NULL,
        supplier_name TEXT NULL,
        supplier_number INTEGER NULL,
        status_id INTEGER NULL,
        status_name TEXT NULL,
        total_price REAL NULL,
        total_cost REAL NULL,
        subtotal REAL NULL,
        associated_document_id TEXT NULL,
        external_po_number TEXT NULL,
        shipping_location TEXT NULL,
        date_sent TEXT NULL,
        shipped_percent REAL NULL,
        is_cancelled INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NULL,
        imported_at INTEGER NULL,
        UNIQUE(context_id, doc_number)
      );

      CREATE TABLE IF NOT EXISTS item_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        document_item_id TEXT NULL,
        item_name TEXT NULL,
        item_number INTEGER NULL,
        item_sku TEXT NULL,
        item_location TEXT NULL,
        line_description TEXT NULL,
        quantity_received REAL NULL,
        quantity_shipped REAL NULL,
        cost REAL NULL,
        total_amount REAL NULL,
        discounted_price REAL NULL,
        discount_percent REAL NULL,
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
        quantity REAL NULL,
        quantity_reserved REAL NULL,
        quantity_available REAL NULL,
        quantity_incoming REAL NULL,
        in_transit REAL NULL,
        threshold REAL NULL,
        cost REAL NULL,
        price REAL NULL,
        valuation REAL NULL,
        published INTEGER NULL,
        archived INTEGER NULL,
        created TEXT NULL,
        modified INTEGER NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        source_api_version TEXT NULL,
        imported_at INTEGER NULL
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
        quantity_on_hand REAL NOT NULL DEFAULT 0,
        quantity_reserved REAL NULL,
        quantity_available REAL NULL,
        quantity_incoming REAL NULL,
        in_transit REAL NULL,
        price REAL NULL,
        cost REAL NULL,
        valuation REAL NULL,
        barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        source_api_version TEXT NULL,
        imported_at INTEGER NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS payment_transactions (
        transaction_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        amount REAL NOT NULL,
        transaction_date TEXT NOT NULL,
        reference TEXT NULL,
        imported_at INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS categories (
        category_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_count INTEGER NULL,
        parent_id TEXT NULL,
        parent_name TEXT NULL,
        inventory_type TEXT NULL,
        custom_fields_json TEXT NULL,
        created TEXT NULL,
        modified INTEGER NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        source_api_version TEXT NULL,
        imported_at INTEGER NOT NULL
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
  }

  private migrateSchema(fromVersion: number): void {
    // Recreate any missing current tables before applying additive column migrations.
    this.createSchema();
    if (fromVersion < 2) {
      this.addVersion2DocumentColumns();
      this.addVersion2ItemDocumentColumns();
    }
    if (fromVersion < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS payment_transactions (
          transaction_id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          amount REAL NOT NULL,
          transaction_date TEXT NOT NULL,
          reference TEXT NULL,
          imported_at INTEGER NOT NULL,
          FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
        );
      `);
    }
    if (fromVersion < 4) {
      this.addColumnsIfMissing('documents', [['archived', 'INTEGER NULL']]);
      this.addColumnsIfMissing('items', [['archived', 'INTEGER NULL']]);
    }
    if (fromVersion < 5) {
      this.addColumnsIfMissing('documents', [
        ['date_sent', 'TEXT NULL'],
        ['shipped_percent', 'REAL NULL'],
      ]);
      this.addColumnsIfMissing('item_documents', [['quantity_shipped', 'REAL NULL']]);
    }
    if (fromVersion < 7) {
      this.addColumnsIfMissing('items', [['source_api_version', 'TEXT NULL']]);
      this.addColumnsIfMissing('categories', [
        ['inventory_type', 'TEXT NULL'],
        ['custom_fields_json', 'TEXT NULL'],
        ['source_api_version', 'TEXT NULL'],
      ]);
      this.addColumnsIfMissing('item_stock_locations', [['source_api_version', 'TEXT NULL']]);
      this.nullLegacyApiInventoryValues();
      this.rebuildStockLocationsForVersion7();
    }
    // Current indexes may refer to columns introduced by any prior migration.
    this.createIndexes();
  }

  private nullLegacyApiInventoryValues(): void {
    this.db.exec(`
      UPDATE items
      SET quantity_reserved = NULL,
          quantity_available = NULL,
          quantity_incoming = NULL,
          in_transit = NULL
      WHERE cache_source = 'api';
    `);
  }

  private rebuildStockLocationsForVersion7(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS item_stock_locations_v7;
      CREATE TABLE item_stock_locations_v7 (
        stock_row_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_number INTEGER NULL,
        variation_id TEXT NULL,
        variation_location_id TEXT NULL,
        location_id TEXT NULL,
        location_name TEXT NULL,
        category_name TEXT NULL,
        quantity_on_hand REAL NOT NULL DEFAULT 0,
        quantity_reserved REAL NULL,
        quantity_available REAL NULL,
        quantity_incoming REAL NULL,
        in_transit REAL NULL,
        price REAL NULL,
        cost REAL NULL,
        valuation REAL NULL,
        barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        source_api_version TEXT NULL,
        imported_at INTEGER NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );

      INSERT INTO item_stock_locations_v7 (
        stock_row_id, item_id, item_number, variation_id, variation_location_id,
        location_id, location_name, category_name, quantity_on_hand,
        quantity_reserved, quantity_available, quantity_incoming, in_transit,
        price, cost, valuation, barcode, cache_source, source_api_version, imported_at
      )
      SELECT
        stock_row_id, item_id, item_number, variation_id, variation_location_id,
        location_id, location_name, category_name, quantity_on_hand,
        CASE WHEN cache_source = 'api' THEN NULL ELSE quantity_reserved END,
        CASE WHEN cache_source = 'api' THEN NULL ELSE quantity_available END,
        CASE WHEN cache_source = 'api' THEN NULL ELSE quantity_incoming END,
        CASE WHEN cache_source = 'api' THEN NULL ELSE in_transit END,
        price, cost, valuation, barcode, cache_source, source_api_version, imported_at
      FROM item_stock_locations;

      DROP TABLE item_stock_locations;
      ALTER TABLE item_stock_locations_v7 RENAME TO item_stock_locations;
    `);
    const foreignKeyFailures = this.db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyFailures.length > 0) {
      throw new Error('Cannot migrate cache schema v7: item stock foreign-key validation failed.');
    }
  }

  private addVersion2DocumentColumns(): void {
    this.addColumnsIfMissing('documents', [
      ['api_doc_id', 'TEXT NULL'],
      ['cache_source', "TEXT NOT NULL DEFAULT 'api'"],
      ['document_name', 'TEXT NULL'],
      ['custom_doc_number', 'TEXT NULL'],
      ['account_id', 'TEXT NULL'],
      ['account_context_id', 'INTEGER NULL'],
      ['account_name', 'TEXT NULL'],
      ['account_number', 'INTEGER NULL'],
      ['user_id', 'TEXT NULL'],
      ['salesperson_name', 'TEXT NULL'],
      ['customer_name', 'TEXT NULL'],
      ['customer_number', 'INTEGER NULL'],
      ['supplier_name', 'TEXT NULL'],
      ['supplier_number', 'INTEGER NULL'],
      ['status_id', 'INTEGER NULL'],
      ['status_name', 'TEXT NULL'],
      ['total_price', 'REAL NULL'],
      ['total_cost', 'REAL NULL'],
      ['subtotal', 'REAL NULL'],
      ['associated_document_id', 'TEXT NULL'],
      ['external_po_number', 'TEXT NULL'],
      ['shipping_location', 'TEXT NULL'],
      ['is_cancelled', 'INTEGER NOT NULL DEFAULT 0'],
      ['imported_at', 'INTEGER NULL'],
    ]);
  }

  private addVersion2ItemDocumentColumns(): void {
    this.addColumnsIfMissing('item_documents', [
      ['document_item_id', 'TEXT NULL'],
      ['item_name', 'TEXT NULL'],
      ['item_number', 'INTEGER NULL'],
      ['item_sku', 'TEXT NULL'],
      ['item_location', 'TEXT NULL'],
      ['line_description', 'TEXT NULL'],
      ['quantity_received', 'REAL NULL'],
      ['cost', 'REAL NULL'],
      ['total_amount', 'REAL NULL'],
      ['discounted_price', 'REAL NULL'],
      ['discount_percent', 'REAL NULL'],
    ]);
  }

  private addColumnsIfMissing(table: string, specs: Array<[string, string]>): void {
    const existing = new Set(
      (this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((col) => col.name)
    );
    for (const [name, definition] of specs) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private createIndexes(): void {
    this.ensureUniqueDocumentApiIdIndex();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_context_doc_number
        ON documents(context_id, doc_number);
      CREATE INDEX IF NOT EXISTS idx_documents_context ON documents(context_id);
      CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified);
      CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account_name ON documents(account_context_id, account_name);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status_id);
      CREATE INDEX IF NOT EXISTS idx_documents_shipped_percent ON documents(shipped_percent);
      CREATE INDEX IF NOT EXISTS idx_documents_archived ON documents(archived);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc ON item_documents(doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_name ON item_documents(item_name);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_number ON item_documents(item_number);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_sku ON item_documents(item_sku);
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_doc_id ON payment_transactions(doc_id);
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_date_doc ON payment_transactions(transaction_date, doc_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_number ON accounts(context_id, account_number);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_name ON accounts(context_id, name);
      CREATE INDEX IF NOT EXISTS idx_accounts_modified ON accounts(modified);
      CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts(archived);
      CREATE INDEX IF NOT EXISTS idx_items_modified ON items(modified);
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
      CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
      CREATE INDEX IF NOT EXISTS idx_items_item_number ON items(item_number);
      CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived);
      CREATE INDEX IF NOT EXISTS idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON item_stock_locations(location_id);
      CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
    `);
  }

  private ensureUniqueDocumentApiIdIndex(): void {
    const duplicate = this.db.prepare(`
      SELECT api_doc_id, COUNT(*) AS count
      FROM documents
      WHERE api_doc_id IS NOT NULL
      GROUP BY api_doc_id
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get() as { api_doc_id: string; count: number } | undefined;
    if (duplicate) {
      throw new Error(
        `Cannot migrate cache schema: documents contains ${duplicate.count} rows with api_doc_id "${duplicate.api_doc_id}". `
        + 'Resolve duplicate document identities before retrying.'
      );
    }
    const indexes = this.db.pragma('index_list(documents)') as Array<{ name: string; unique: number }>;
    const existing = indexes.find(({ name }) => name === 'idx_documents_api_doc_id');
    if (existing && existing.unique !== 1) {
      this.db.exec('DROP INDEX idx_documents_api_doc_id');
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_api_doc_id
        ON documents(api_doc_id) WHERE api_doc_id IS NOT NULL;
    `);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  insertDocument(doc: DocumentRow): Promise<void> {
    const stmt = this.db.prepare(this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'));
    stmt.run(...this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocumentForWrite(doc)));
    return Promise.resolve();
  }

  getDocument(docId: string): Promise<DocumentRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM documents WHERE doc_id = ?`).get(docId) as DocumentRow | undefined);
  }

  getDocumentByApiId(apiDocId: string): Promise<DocumentRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM documents WHERE api_doc_id = ?`).get(apiDocId) as DocumentRow | undefined);
  }

  getDocumentByNumber(contextId: number, docNumber: number): Promise<DocumentRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM documents WHERE context_id = ? AND doc_number = ?`).get(contextId, docNumber) as DocumentRow | undefined);
  }

  getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM documents WHERE context_id = ?`).all(contextId) as DocumentRow[]);
  }

  getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM documents WHERE modified > ? ORDER BY modified ASC`).all(timestamp) as DocumentRow[]);
  }

  getDocumentCountByContext(contextId: number): Promise<number> {
    return Promise.resolve(this.count('documents', 'context_id = ?', [contextId]));
  }

  deleteDocument(docId: string): Promise<void> {
    this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`).run(docId);
    return Promise.resolve();
  }

  batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    const insert = this.db.prepare(this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'));
    const tx = this.db.transaction((documents: DocumentRow[]) => {
      for (const doc of documents) insert.run(...this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(doc)));
    });
    tx(docs);
    return Promise.resolve();
  }

  batchDeleteDocuments(docIds: string[]): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
    const tx = this.db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(id)));
    tx(docIds);
    return Promise.resolve();
  }

  insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    const stmt = this.db.prepare(`INSERT INTO item_documents (${ITEM_DOCUMENT_COLUMNS.join(', ')}) VALUES (${ITEM_DOCUMENT_COLUMNS.map(() => '?').join(', ')})`);
    stmt.run(...this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item)));
    return Promise.resolve();
  }

  getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM item_documents WHERE doc_id = ?`).all(docId) as ItemDocumentRow[]);
  }

  deleteItemDocuments(docId: string): Promise<void> {
    this.db.prepare(`DELETE FROM item_documents WHERE doc_id = ?`).run(docId);
    return Promise.resolve();
  }

  batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    const insert = this.db.prepare(`INSERT INTO item_documents (${ITEM_DOCUMENT_COLUMNS.join(', ')}) VALUES (${ITEM_DOCUMENT_COLUMNS.map(() => '?').join(', ')})`);
    const tx = this.db.transaction((rows: Omit<ItemDocumentRow, 'id'>[]) => {
      for (const item of rows) insert.run(...this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item)));
    });
    tx(items);
    return Promise.resolve();
  }

  getPaymentTransactions(docId: string): Promise<PaymentTransactionRow[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM payment_transactions WHERE doc_id = ? ORDER BY transaction_date ASC, transaction_id ASC`)
        .all(docId) as PaymentTransactionRow[],
    );
  }

  getAllPaymentTransactions(): Promise<PaymentTransactionRow[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM payment_transactions ORDER BY transaction_date ASC, transaction_id ASC`)
        .all() as PaymentTransactionRow[],
    );
  }

  replacePaymentTransactions(docId: string, transactions: PaymentTransactionRow[]): Promise<void> {
    assertPaymentRowsMatchDocument(docId, transactions);
    assertUniquePaymentTransactionIds(transactions);
    const deleteStmt = this.db.prepare(`DELETE FROM payment_transactions WHERE doc_id = ?`);
    const insert = this.db.prepare(
      `INSERT INTO payment_transactions (${PAYMENT_TRANSACTION_COLUMNS.join(', ')})`
      + ` VALUES (${PAYMENT_TRANSACTION_COLUMNS.map(() => '?').join(', ')})`,
    );
    const tx = this.db.transaction(() => {
      deleteStmt.run(docId);
      for (const transaction of transactions) {
        insert.run(...this.valuesFor(PAYMENT_TRANSACTION_COLUMNS, this.normalizePaymentTransaction(transaction)));
      }
    });
    tx();
    return Promise.resolve();
  }

  batchInsertPaymentTransactions(transactions: PaymentTransactionRow[]): Promise<void> {
    assertUniquePaymentTransactionIds(transactions);
    const insert = this.db.prepare(
      `INSERT INTO payment_transactions (${PAYMENT_TRANSACTION_COLUMNS.join(', ')})`
      + ` VALUES (${PAYMENT_TRANSACTION_COLUMNS.map(() => '?').join(', ')})`,
    );
    const tx = this.db.transaction((rows: PaymentTransactionRow[]) => {
      for (const transaction of rows) {
        insert.run(...this.valuesFor(PAYMENT_TRANSACTION_COLUMNS, this.normalizePaymentTransaction(transaction)));
      }
    });
    tx(transactions);
    return Promise.resolve();
  }

  insertAccount(account: AccountRow): Promise<void> {
    this.db.prepare(this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id')).run(...this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account)));
    return Promise.resolve();
  }

  getAccount(accountId: string): Promise<AccountRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId) as AccountRow | undefined);
  }

  getAccountByNumber(contextId: number, accountNumber: number): Promise<AccountRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM accounts WHERE context_id = ? AND account_number = ?`).get(contextId, accountNumber) as AccountRow | undefined);
  }

  getAccountsByName(contextId: number, name: string): Promise<AccountRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM accounts WHERE context_id = ? AND name = ?`).all(contextId, name) as AccountRow[]);
  }

  getAllAccounts(): Promise<AccountRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM accounts`).all() as AccountRow[]);
  }

  getAccountsModifiedSince(timestamp: number): Promise<AccountRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM accounts WHERE COALESCE(modified, 0) > ? ORDER BY modified ASC`).all(timestamp) as AccountRow[]);
  }

  batchInsertAccounts(accounts: AccountRow[]): Promise<void> {
    const insert = this.db.prepare(this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'));
    const tx = this.db.transaction((rows: AccountRow[]) => {
      for (const row of rows) insert.run(...this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(row)));
    });
    tx(accounts);
    return Promise.resolve();
  }

  deleteAccount(accountId: string): Promise<void> {
    this.db.prepare(`DELETE FROM accounts WHERE account_id = ?`).run(accountId);
    return Promise.resolve();
  }

  replaceCategorySnapshot(snapshot: CategorySnapshot): Promise<void> {
    this.assertCategorySnapshot(snapshot);
    this.assertSnapshotAccountMatchesBinding(snapshot.meta.accountIdentity);
    const tx = this.db.transaction(() => this.replaceCategorySnapshotInTransaction(snapshot));
    tx.immediate();
    return Promise.resolve();
  }

  getCategorySnapshot(): Promise<CategorySnapshot | null> {
    const read = this.db.transaction(() => {
      const meta = this.readAuthoritativeCategoryMeta();
      if (!meta) return null;
      const rows = this.getAllCategoryRows();
      return rows.length === meta.storedRowCount ? { rows, meta } : null;
    });
    return Promise.resolve(read.deferred());
  }

  getCategoryCacheMeta(): Promise<CategoryCacheMeta | null> {
    const read = this.db.transaction(() => this.readAuthoritativeCategoryMeta());
    return Promise.resolve(read.deferred());
  }

  getCategory(categoryId: string): Promise<CategoryCacheRow | undefined> {
    const read = this.db.transaction(() => this.readAuthoritativeCategoryMeta()
      ? this.db.prepare('SELECT * FROM categories WHERE category_id = ?').get(categoryId) as CategoryCacheRow | undefined
      : undefined);
    return Promise.resolve(read.deferred());
  }

  getAllCategories(): Promise<CategoryCacheRow[]> {
    const read = this.db.transaction(() => this.readAuthoritativeCategoryMeta() ? this.getAllCategoryRows() : []);
    return Promise.resolve(read.deferred());
  }

  getCategoryCount(): Promise<number> {
    const read = this.db.transaction(() => this.readAuthoritativeCategoryMeta() ? this.count('categories') : 0);
    return Promise.resolve(read.deferred());
  }

  insertItem(item: ItemRow): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(this.upsertSql('items', ITEM_COLUMNS, 'item_id'))
        .run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)));
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate();
    return Promise.resolve();
  }

  getItem(itemId: string): Promise<ItemRow | undefined> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM items WHERE item_id = ?`).get(itemId) as ItemRow | undefined);
  }

  getAllItems(): Promise<ItemRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM items`).all() as ItemRow[]);
  }

  getItemsModifiedSince(timestamp: number): Promise<ItemRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM items WHERE COALESCE(modified, 0) > ? ORDER BY modified ASC`).all(timestamp) as ItemRow[]);
  }

  batchInsertItems(items: ItemRow[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    const insert = this.db.prepare(this.upsertSql('items', ITEM_COLUMNS, 'item_id'));
    const tx = this.db.transaction((rows: ItemRow[]) => {
      for (const row of rows) insert.run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(row)));
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate(items);
    return Promise.resolve();
  }

  deleteItem(itemId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM items WHERE item_id = ?`).run(itemId);
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate();
    return Promise.resolve();
  }

  insertItemStockLocation(row: ItemStockLocationRow): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'))
        .run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate();
    return Promise.resolve();
  }

  getItemStockLocations(itemId: string): Promise<ItemStockLocationRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM item_stock_locations WHERE item_id = ?`).all(itemId) as ItemStockLocationRow[]);
  }

  getAllItemStockLocations(): Promise<ItemStockLocationRow[]> {
    return Promise.resolve(this.db.prepare(`SELECT * FROM item_stock_locations`).all() as ItemStockLocationRow[]);
  }

  replaceItemStockLocations(itemId: string, rows: ItemStockLocationRow[]): Promise<void> {
    const deleteStmt = this.db.prepare(`DELETE FROM item_stock_locations WHERE item_id = ?`);
    const insert = this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'));
    const tx = this.db.transaction(() => {
      deleteStmt.run(itemId);
      for (const row of rows) insert.run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate();
    return Promise.resolve();
  }

  batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    const insert = this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'));
    const tx = this.db.transaction((stockRows: ItemStockLocationRow[]) => {
      for (const row of stockRows) insert.run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate(rows);
    return Promise.resolve();
  }

  deleteItemStockLocations(itemId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM item_stock_locations WHERE item_id = ?`).run(itemId);
      this.invalidateInventoryAuthorityInTransaction();
    });
    tx.immediate();
    return Promise.resolve();
  }

  replaceInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
    this.assertInventorySnapshot(snapshot);
    this.assertSnapshotAccountMatchesBinding(snapshot.meta.accountIdentity);
    const tx = this.db.transaction(() => {
      const itemInsert = this.db.prepare(
        this.upsertSql('items', ITEM_COLUMNS, 'item_id'),
      );
      const stockInsert = this.db.prepare(
        this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
      );
      this.db.prepare(`DELETE FROM item_stock_locations WHERE cache_source = 'api'`).run();
      this.db.exec(`
        UPDATE items
        SET cache_source = 'csv', source_api_version = NULL
        WHERE cache_source = 'api'
          AND EXISTS (
            SELECT 1 FROM item_stock_locations AS stock
            WHERE stock.item_id = items.item_id AND stock.cache_source = 'csv'
          );
      `);
      this.db.prepare(`DELETE FROM items WHERE cache_source = 'api'`).run();
      for (const item of snapshot.items) {
        itemInsert.run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)));
      }
      for (const row of snapshot.stockRows) {
        stockInsert.run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      }
      this.writeInventoryMetaInTransaction(snapshot.meta);

      const currentState = this.readCacheState();
      this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)`).run(JSON.stringify({
        ...(currentState ?? {
          lastSync: 0,
          lastFullSync: 0,
          documentCount: this.count('documents'),
          itemDocumentCount: this.count('item_documents'),
          accountName: this.accountName,
        }),
        schemaVersion: CACHE_SCHEMA_VERSION,
        itemCount: this.count('items'),
        stockLocationCount: this.count('item_stock_locations'),
        lastItemSync: snapshot.meta.completedAt,
        lastFullItemSync: snapshot.meta.completedAt,
        inventorySourceApiVersion: '3',
      } satisfies CacheState));
    });
    tx.immediate();
    return Promise.resolve();
  }

  getInventoryCacheMeta(): Promise<InventoryCacheMeta | null> {
    const read = this.db.transaction(() => this.readAuthoritativeInventoryMeta());
    return Promise.resolve(read.deferred());
  }

  getItemDocumentsForPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemDocumentRow[]> {
    const stmt = this.db.prepare(`
      SELECT id.* FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ? AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date DESC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as ItemDocumentRow[]);
  }

  getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined> {
    const row = this.db.prepare(`
      SELECT MAX(d.issue_date) as latest_date
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ?
    `).get(itemId, contextId) as { latest_date: string | null } | undefined;
    return Promise.resolve(row?.latest_date || undefined);
  }

  getItemSalesByPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemSalesByPeriodRow[]> {
    return Promise.resolve(this.db.prepare(`
      SELECT d.issue_date, id.quantity, id.price
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ? AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date ASC
    `).all(itemId, contextId, startDate, endDate) as ItemSalesByPeriodRow[]);
  }

  getItemPriceDistribution(itemId: string, startDate: string, endDate: string, contextId: number): Promise<PriceDistributionRow[]> {
    return Promise.resolve(this.db.prepare(`
      SELECT id.price, SUM(ABS(id.quantity)) as total_quantity, SUM(id.quantity * id.price) as total_revenue
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ? AND d.issue_date BETWEEN ? AND ?
      GROUP BY id.price
      ORDER BY id.price ASC
    `).all(itemId, contextId, startDate, endDate) as PriceDistributionRow[]);
  }

  getItemSalesByCustomer(itemId: string, startDate: string, endDate: string, contextId: number): Promise<CustomerSalesData[]> {
    return Promise.resolve(this.db.prepare(`
      SELECT d.customer_id, d.customer_name, SUM(ABS(id.quantity)) as quantity,
             SUM(id.quantity * id.price) as revenue, COUNT(DISTINCT id.doc_id) as order_count
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ? AND d.issue_date BETWEEN ? AND ?
      GROUP BY d.customer_id, d.customer_name
      ORDER BY revenue DESC
    `).all(itemId, contextId, startDate, endDate) as CustomerSalesData[]);
  }

  getItemSalesByMonth(itemId: string, startDate: string, endDate: string, contextId: number): Promise<{ month: string; quantity: number; revenue: number }[]> {
    return Promise.resolve(this.db.prepare(`
      SELECT strftime('%Y-%m', d.issue_date) as month, SUM(ABS(id.quantity)) as quantity,
             SUM(id.quantity * id.price) as revenue
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ? AND d.issue_date BETWEEN ? AND ?
      GROUP BY month
      ORDER BY month ASC
    `).all(itemId, contextId, startDate, endDate) as { month: string; quantity: number; revenue: number }[]);
  }

  getItemOrderPatterns(itemId: string, startDate: string, endDate: string): Promise<{
    doc_id: string;
    quantity: number;
    price: number;
    issue_date: string;
    customer_id: string;
    context_id: number;
    doc_number: number;
  }[]> {
    return Promise.resolve(this.db.prepare(`
      SELECT id.doc_id, id.quantity, id.price, d.issue_date, d.customer_id, d.context_id, d.doc_number
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id IN (4, 5) AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date DESC
    `).all(itemId, startDate, endDate) as any[]);
  }

  getCacheState(): Promise<CacheState | null> {
    return Promise.resolve(this.readCacheState());
  }

  setCacheState(state: CacheState): Promise<void> {
    const tx = this.db.transaction(() => this.setCacheStateInTransaction(state));
    tx.immediate();
    return Promise.resolve();
  }

  getSyncStatus(): Promise<CacheSyncStatus | null> {
    const row = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'sync_status'`).get() as CacheMetaRow | undefined;
    return Promise.resolve(row ? JSON.parse(row.value) as CacheSyncStatus : null);
  }

  setSyncStatus(status: CacheSyncStatus): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('sync_status', ?)`).run(JSON.stringify(status));
    return Promise.resolve();
  }

  getPaymentSyncStatus(): Promise<PaymentSyncStatus | null> {
    const row = this.db.prepare(`SELECT value FROM cache_meta WHERE key = ?`).get(PAYMENT_SYNC_STATUS_KEY) as CacheMetaRow | undefined;
    return Promise.resolve(row ? JSON.parse(row.value) as PaymentSyncStatus : null);
  }

  setPaymentSyncStatus(status: PaymentSyncStatus): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)`)
      .run(PAYMENT_SYNC_STATUS_KEY, JSON.stringify(status));
    return Promise.resolve();
  }

  getDocumentCount(): Promise<number> {
    return Promise.resolve(this.count('documents'));
  }

  getItemDocumentCount(): Promise<number> {
    return Promise.resolve(this.count('item_documents'));
  }

  getPaymentTransactionCount(): Promise<number> {
    return Promise.resolve(this.count('payment_transactions'));
  }

  getAccountCount(contextId?: number): Promise<number> {
    return Promise.resolve(contextId ? this.count('accounts', 'context_id = ?', [contextId]) : this.count('accounts'));
  }

  getItemCount(): Promise<number> {
    return Promise.resolve(this.count('items'));
  }

  getStockLocationCount(): Promise<number> {
    return Promise.resolve(this.count('item_stock_locations'));
  }

  clearAll(): Promise<void> {
    const tx = this.db.transaction(() => this.clearAllInTransaction());
    tx.immediate();
    return Promise.resolve();
  }

  /** Replace the complete local mirror without exposing a partially-written snapshot. */
  replaceMirror(snapshot: SQLiteMirrorSnapshot): Promise<void> {
    assertUniquePaymentTransactionIds(snapshot.paymentTransactions);
    if (snapshot.categorySnapshot) {
      this.assertCategorySnapshot(snapshot.categorySnapshot);
      this.assertSnapshotAccountMatchesBinding(snapshot.categorySnapshot.meta.accountIdentity);
    }
    if (snapshot.inventoryCacheMeta) {
      this.assertSnapshotAccountMatchesBinding(snapshot.inventoryCacheMeta.accountIdentity);
      this.assertInventoryMetaMatchesRows(
        snapshot.inventoryCacheMeta,
        snapshot.items,
        snapshot.itemStockLocations,
      );
      if (snapshot.categorySnapshot) {
        this.assertCategoryReconciliationPreservesInventoryRows(snapshot);
      }
    }
    const tx = this.db.transaction(() => {
      this.clearAllInTransaction();
      void this.batchInsertAccounts(snapshot.accounts);
      void this.batchInsertItems(snapshot.items);
      void this.batchInsertItemStockLocations(snapshot.itemStockLocations);
      void this.batchInsertDocuments(snapshot.documents);
      void this.batchInsertItemDocuments(snapshot.itemDocuments);
      void this.batchInsertPaymentTransactions(snapshot.paymentTransactions);
      if (snapshot.cacheState) this.setCacheStateInTransaction(snapshot.cacheState);
      if (snapshot.categorySnapshot) this.replaceCategorySnapshotInTransaction(snapshot.categorySnapshot);
      if (snapshot.inventoryCacheMeta) {
        this.assertInventoryMetaMatchesRows(
          snapshot.inventoryCacheMeta,
          this.db.prepare('SELECT * FROM items').all() as ItemRow[],
          this.db.prepare('SELECT * FROM item_stock_locations').all() as ItemStockLocationRow[],
        );
        this.writeInventoryMetaInTransaction(snapshot.inventoryCacheMeta);
        const currentState = this.readCacheState() ?? {
          lastSync: 0,
          lastFullSync: 0,
          documentCount: this.count('documents'),
          itemDocumentCount: this.count('item_documents'),
          accountName: this.accountName,
          schemaVersion: CACHE_SCHEMA_VERSION,
        };
        this.setCacheStateInTransaction({
          ...currentState,
          schemaVersion: CACHE_SCHEMA_VERSION,
          inventorySourceApiVersion: '3',
        });
      } else {
        this.invalidateInventoryAuthorityInTransaction();
      }
      if (snapshot.paymentSyncStatus) void this.setPaymentSyncStatus(snapshot.paymentSyncStatus);
      this.setRawMeta('pg_pull_timestamp', String(snapshot.pulledAt));
    });
    tx.immediate();
    return Promise.resolve();
  }

  getRawMeta(key: string): number | null {
    const row = this.db.prepare(`SELECT value FROM cache_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) return null;
    const num = Number(row.value);
    return Number.isNaN(num) ? null : num;
  }

  setRawMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  async tryAcquireSyncLock(lockKey: string): Promise<boolean> {
    if (this.syncLocks.has(lockKey)) return false;
    const path = `${this.dbPath}.sync.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      let fd: number | null = null;
      try {
        fd = openSync(tempPath, 'wx', 0o600);
        const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
        if (writeSync(fd, owner) !== Buffer.byteLength(owner)) {
          throw new Error('Could not persist the cache sync lock owner.');
        }
        linkSync(tempPath, path);
        try { unlinkSync(tempPath); } catch { /* The lock link remains authoritative. */ }
        this.syncLocks.set(lockKey, { fd, path });
        return true;
      } catch (error) {
        if (fd !== null) try { closeSync(fd); } catch { /* Ignore cleanup errors. */ }
        try { unlinkSync(tempPath); } catch { /* Ignore cleanup errors. */ }
        if (!isExistingFileError(error)) throw error;
        if (!this.removeStaleSyncLock(path)) return false;
      }
    }
    return false;
  }

  async releaseSyncLock(lockKey: string): Promise<void> {
    const lock = this.syncLocks.get(lockKey);
    if (!lock) return;
    this.syncLocks.delete(lockKey);
    try { closeSync(lock.fd); } finally {
      try { unlinkSync(lock.path); } catch { /* Lock already removed. */ }
    }
  }

  async ensureAccountBinding(binding: CacheAccountBinding): Promise<void> {
    this.bindOrVerifyAccount(binding);
  }

  async verifyAccountBinding(binding: CacheAccountBinding): Promise<void> {
    // The mirror path historically verifies before its first replacement. An
    // empty file is safe to bind here; populated legacy files fail closed.
    this.bindOrVerifyAccount(binding);
  }

  async verifyUnboundForDeletion(): Promise<void> {
    const identity = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(SQLITE_ACCOUNT_IDENTITY_META_KEY) as CacheMetaRow | undefined;
    const subdomain = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(SQLITE_ACCOUNT_SUBDOMAIN_META_KEY) as CacheMetaRow | undefined;
    if (identity || subdomain) {
      throw new Error(
        'SQLite cache already has an account binding. '
        + 'The unbound recovery option cannot override a bound or partially-bound cache.',
      );
    }
  }

  closeDatabaseForDeletion(): void {
    if (this.db.open) this.db.close();
  }

  private removeStaleSyncLock(path: string): boolean {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
      const pid = Number(data.pid);
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) return false;
      unlinkSync(path);
      return true;
    } catch {
      try { unlinkSync(path); return true; } catch { return false; }
    }
  }

  async close(): Promise<void> {
    for (const lockKey of [...this.syncLocks.keys()]) await this.releaseSyncLock(lockKey);
    if (this.db?.open) this.db.close();
  }

  isOpen(): boolean {
    return this.db && this.db.open;
  }

  private replaceCategorySnapshotInTransaction(snapshot: CategorySnapshot): void {
    const insert = this.db.prepare(
      `INSERT INTO categories (${CATEGORY_COLUMNS.join(', ')}) VALUES (${CATEGORY_COLUMNS.map(() => '?').join(', ')})`,
    );
    this.db.prepare('DELETE FROM categories').run();
    for (const row of snapshot.rows) insert.run(...this.valuesFor(CATEGORY_COLUMNS, row as unknown as Record<string, unknown>));

    this.db.prepare('DELETE FROM category_cache_meta').run();
    this.db.prepare('INSERT INTO category_cache_meta (key, value) VALUES (?, ?)')
      .run(CATEGORY_SNAPSHOT_META_KEY, JSON.stringify(snapshot.meta));

    const currentState = this.readCacheState();
    const state: CacheState = {
      ...(currentState ?? {
        lastSync: 0,
        lastFullSync: 0,
        documentCount: this.count('documents'),
        itemDocumentCount: this.count('item_documents'),
        accountName: this.accountName,
      }),
      schemaVersion: CACHE_SCHEMA_VERSION,
      categoryCount: snapshot.rows.length,
      lastCategorySync: snapshot.meta.completedAt,
    };
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)`).run(JSON.stringify(state));
    this.db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)')
      .run(CATEGORY_GENERATION_META_KEY, snapshot.meta.generation);

    this.db.exec(`
      UPDATE items
      SET category_name = (
        SELECT categories.name FROM categories WHERE categories.category_id = items.category_id
      )
      WHERE category_id IS NOT NULL;

      UPDATE item_stock_locations
      SET category_name = (
        SELECT categories.name
        FROM items
        LEFT JOIN categories ON categories.category_id = items.category_id
        WHERE items.item_id = item_stock_locations.item_id
      )
      WHERE EXISTS (
        SELECT 1 FROM items
        WHERE items.item_id = item_stock_locations.item_id
          AND items.category_id IS NOT NULL
      );
    `);
    this.invalidateInventoryAuthorityInTransaction();
  }

  private readAuthoritativeCategoryMeta(): CategoryCacheMeta | null {
    const state = this.readCacheState();
    if (state?.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    const marker = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(CATEGORY_GENERATION_META_KEY) as CacheMetaRow | undefined;
    const row = this.db.prepare('SELECT value FROM category_cache_meta WHERE key = ?')
      .get(CATEGORY_SNAPSHOT_META_KEY) as CacheMetaRow | undefined;
    if (!marker || !row) return null;
    try {
      const meta = JSON.parse(row.value) as unknown;
      if (!isCategoryCacheMeta(meta) || meta.generation !== marker.value) return null;
      const binding = this.readPersistedAccountIdentity();
      if (binding && meta.accountIdentity !== binding) return null;
      if (meta.storedRowCount !== this.count('categories')) return null;
      return meta;
    } catch {
      return null;
    }
  }

  private readAuthoritativeInventoryMeta(): InventoryCacheMeta | null {
    const state = this.readCacheState();
    if (
      state?.schemaVersion !== CACHE_SCHEMA_VERSION
      || state.inventorySourceApiVersion !== '3'
    ) return null;
    const row = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(INVENTORY_SNAPSHOT_META_KEY) as CacheMetaRow | undefined;
    const account = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(INVENTORY_ACCOUNT_META_KEY) as CacheMetaRow | undefined;
    if (!row || !account) return null;
    try {
      const meta = JSON.parse(row.value) as unknown;
      if (!isInventoryCacheMeta(meta) || meta.accountIdentity !== account.value) return null;
      const binding = this.readPersistedAccountIdentity();
      if (binding && meta.accountIdentity !== binding) return null;
      if (!this.inventoryCountsMatch(meta)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  private writeInventoryMetaInTransaction(meta: InventoryCacheMeta): void {
    this.db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)')
      .run(INVENTORY_SNAPSHOT_META_KEY, JSON.stringify(meta));
    this.db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)')
      .run(INVENTORY_ACCOUNT_META_KEY, meta.accountIdentity);
  }

  private invalidateInventoryAuthorityInTransaction(): void {
    this.db.prepare('DELETE FROM cache_meta WHERE key IN (?, ?)')
      .run(INVENTORY_SNAPSHOT_META_KEY, INVENTORY_ACCOUNT_META_KEY);
    const currentState = this.readCacheState();
    if (!currentState || currentState.inventorySourceApiVersion !== '3') return;
    const stateWithoutInventoryAuthority = { ...currentState };
    delete stateWithoutInventoryAuthority.inventorySourceApiVersion;
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)`)
      .run(JSON.stringify(stateWithoutInventoryAuthority));
  }

  private assertCategoryReconciliationPreservesInventoryRows(snapshot: SQLiteMirrorSnapshot): void {
    if (!snapshot.categorySnapshot) return;
    const categoryNames = new Map(snapshot.categorySnapshot.rows.map((row) => [row.category_id, row.name]));
    const items = new Map(snapshot.items.map((row) => [row.item_id, row]));
    for (const item of snapshot.items.filter(isV3ApiRow)) {
      if (item.category_id === null || item.category_id === undefined) continue;
      if ((categoryNames.get(item.category_id) ?? null) !== (item.category_name ?? null)) {
        throw new Error('Category reconciliation would change rows covered by inventory metadata.');
      }
    }
    for (const stock of snapshot.itemStockLocations.filter(isV3ApiRow)) {
      const item = items.get(stock.item_id);
      if (!item || item.category_id === null || item.category_id === undefined) continue;
      if ((categoryNames.get(item.category_id) ?? null) !== (stock.category_name ?? null)) {
        throw new Error('Category reconciliation would change rows covered by inventory metadata.');
      }
    }
  }

  private bindOrVerifyAccount(binding: CacheAccountBinding): void {
    const canonical = createSalesBinderAccountBinding(binding.accountSubdomain);
    if (canonical.accountIdentity !== binding.accountIdentity) {
      throw new Error('SQLite cache account identity does not match its normalized SalesBinder subdomain.');
    }
    const tx = this.db.transaction(() => {
      const identity = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
        .get(SQLITE_ACCOUNT_IDENTITY_META_KEY) as CacheMetaRow | undefined;
      const subdomain = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
        .get(SQLITE_ACCOUNT_SUBDOMAIN_META_KEY) as CacheMetaRow | undefined;
      if (!identity && !subdomain) {
        if (this.databaseContainsPayloadRows()) {
          throw new Error(
            'SQLite cache database is populated but has no account binding. '
            + 'Use a matching empty cache file or rebuild this cache before binding it.',
          );
        }
        this.db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?)')
          .run(SQLITE_ACCOUNT_IDENTITY_META_KEY, canonical.accountIdentity);
        this.db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?)')
          .run(SQLITE_ACCOUNT_SUBDOMAIN_META_KEY, canonical.accountSubdomain);
        return;
      }
      if (
        !identity || !subdomain
        || identity.value !== canonical.accountIdentity
        || subdomain.value !== canonical.accountSubdomain
      ) {
        throw new Error(
          `SQLite cache database is not bound to ${canonical.accountIdentity}. `
          + 'Use the matching cache file or rebuild a fresh cache for this SalesBinder account.',
        );
      }
    });
    tx.immediate();
  }

  private assertSnapshotAccountMatchesBinding(accountIdentity: string): void {
    const persistedIdentity = this.readPersistedAccountIdentity();
    if (persistedIdentity && persistedIdentity !== accountIdentity) {
      throw new Error(
        `SQLite cache database is not bound to ${accountIdentity}. `
        + 'Use the matching cache file or rebuild a fresh cache for this SalesBinder account.',
      );
    }
  }

  private readPersistedAccountIdentity(): string | null {
    const row = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?')
      .get(SQLITE_ACCOUNT_IDENTITY_META_KEY) as CacheMetaRow | undefined;
    return row?.value ?? null;
  }

  private databaseContainsPayloadRows(): boolean {
    const tables = [
      'accounts', 'documents', 'item_documents', 'items', 'item_stock_locations',
      'payment_transactions', 'categories', 'category_cache_meta',
    ];
    if (tables.some((table) => this.count(table) > 0)) return true;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM cache_meta
      WHERE key NOT IN (?, ?)
    `).get(SQLITE_ACCOUNT_IDENTITY_META_KEY, SQLITE_ACCOUNT_SUBDOMAIN_META_KEY) as { count: number };
    return row.count > 0;
  }

  private inventoryCountsMatch(meta: InventoryCacheMeta): boolean {
    const itemCounts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN source_api_version = '3' THEN 1 ELSE 0 END) AS v3
      FROM items WHERE cache_source = 'api'
    `).get() as { total: number; v3: number | null };
    const stockCounts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN source_api_version = '3' THEN 1 ELSE 0 END) AS v3
      FROM item_stock_locations WHERE cache_source = 'api'
    `).get() as { total: number; v3: number | null };
    return itemCounts.total === meta.itemCount
      && (itemCounts.v3 ?? 0) === meta.itemCount
      && stockCounts.total === meta.stockRowCount
      && (stockCounts.v3 ?? 0) === meta.stockRowCount;
  }

  private assertInventorySnapshot(snapshot: InventorySnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.stockRows)) {
      throw new Error('Inventory snapshot is incomplete or invalid.');
    }
    this.assertInventoryMetaMatchesRows(snapshot.meta, snapshot.items, snapshot.stockRows);
    const itemIds = new Set<string>();
    for (const item of snapshot.items) {
      if (!isInventoryItemRow(item) || itemIds.has(item.item_id)) {
        throw new Error('Inventory snapshot contains an invalid or duplicate item row.');
      }
      itemIds.add(item.item_id);
    }
    const stockIds = new Set<string>();
    for (const row of snapshot.stockRows) {
      if (!isInventoryStockRow(row) || stockIds.has(row.stock_row_id) || !itemIds.has(row.item_id)) {
        throw new Error('Inventory snapshot contains an invalid, duplicate, or orphan stock row.');
      }
      stockIds.add(row.stock_row_id);
    }
  }

  private assertInventoryMetaMatchesRows(
    meta: InventoryCacheMeta,
    items: ItemRow[],
    stockRows: ItemStockLocationRow[],
  ): void {
    if (
      !isInventoryCacheMeta(meta)
      || meta.itemCount !== items.filter(isV3ApiRow).length
      || meta.stockRowCount !== stockRows.filter(isV3ApiRow).length
      || meta.itemCount !== items.filter((row) => row.cache_source === 'api').length
      || meta.stockRowCount !== stockRows.filter((row) => row.cache_source === 'api').length
    ) {
      throw new Error('Inventory snapshot metadata does not match its authoritative API rows.');
    }
  }

  private getAllCategoryRows(): CategoryCacheRow[] {
    return this.db.prepare('SELECT * FROM categories ORDER BY category_id ASC').all() as CategoryCacheRow[];
  }

  private assertCategorySnapshot(snapshot: CategorySnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.rows) || !isCategoryCacheMeta(snapshot.meta)) {
      throw new Error('Category snapshot is incomplete or invalid.');
    }
    if (
      snapshot.meta.count !== snapshot.rows.length
      || snapshot.meta.sourceRowCount !== snapshot.rows.length
      || snapshot.meta.storedRowCount !== snapshot.rows.length
    ) {
      throw new Error('Category snapshot metadata counts do not match its rows.');
    }
    const names = new Map<string, string>();
    for (const row of snapshot.rows) {
      if (!isCategoryCacheRow(row)) throw new Error('Category snapshot contains an invalid row.');
      if (names.has(row.category_id)) throw new Error(`Category snapshot contains duplicate ID ${row.category_id}.`);
      names.set(row.category_id, row.name);
    }
    for (const row of snapshot.rows) {
      const expectedParentName = row.parent_id ? names.get(row.parent_id) ?? null : null;
      if (row.parent_name !== expectedParentName) {
        throw new Error(`Category snapshot has an inconsistent parent name for ${row.category_id}.`);
      }
    }
  }

  private readCacheState(): CacheState | null {
    const row = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'state'`).get() as CacheMetaRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CacheState;
    } catch {
      return null;
    }
  }

  private setCacheStateInTransaction(state: CacheState): void {
    const persistedState = this.readCacheState();
    if (state.schemaVersion === CACHE_SCHEMA_VERSION && persistedState?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      this.db.prepare('DELETE FROM cache_meta WHERE key = ?').run(CATEGORY_GENERATION_META_KEY);
      this.db.prepare('DELETE FROM cache_meta WHERE key IN (?, ?)')
        .run(INVENTORY_SNAPSHOT_META_KEY, INVENTORY_ACCOUNT_META_KEY);
    }
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)`).run(JSON.stringify(state));
  }

  private clearAllInTransaction(): void {
    this.db.exec(`
      DELETE FROM payment_transactions;
      DELETE FROM item_stock_locations;
      DELETE FROM item_documents;
      DELETE FROM items;
      DELETE FROM documents;
      DELETE FROM accounts;
      DELETE FROM categories;
      DELETE FROM category_cache_meta;
    `);
    this.db.prepare('DELETE FROM cache_meta WHERE key NOT IN (?, ?)')
      .run(SQLITE_ACCOUNT_IDENTITY_META_KEY, SQLITE_ACCOUNT_SUBDOMAIN_META_KEY);
  }

  private count(table: string, where?: string, params: unknown[] = []): number {
    const sql = where ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as count FROM ${table}`;
    const result = this.db.prepare(sql).get(...params) as { count: number };
    return result.count;
  }

  private upsertSql(table: string, columns: readonly string[], conflictColumn: string): string {
    const updates = columns
      .filter((column) => column !== conflictColumn)
      .map((column) => column === 'archived' && (table === 'documents' || table === 'items')
        ? `${column} = COALESCE(excluded.${column}, ${table}.${column})`
        : `${column} = excluded.${column}`)
      .join(', ');
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updates}`;
  }

  private valuesFor(columns: readonly string[], row: Record<string, unknown>): unknown[] {
    return columns.map((column) => row[column] ?? null);
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
      archived: doc.archived ?? null,
    };
  }

  private normalizeDocumentForWrite(doc: DocumentRow): Record<string, unknown> {
    const existingByApiId = doc.api_doc_id ? this.db
      .prepare(`SELECT doc_id FROM documents WHERE api_doc_id = ?`)
      .get(doc.api_doc_id) as { doc_id: string } | undefined : undefined;
    const existingByNumber = this.db
      .prepare(`SELECT doc_id FROM documents WHERE context_id = ? AND doc_number = ?`)
      .get(doc.context_id, doc.doc_number) as { doc_id: string } | undefined;
    const existing = existingByApiId ?? existingByNumber;
    return this.normalizeDocument(existing ? { ...doc, doc_id: existing.doc_id } : doc);
  }

  private normalizeItemDocument(item: Omit<ItemDocumentRow, 'id'>): Record<string, unknown> {
    return { ...item, quantity: item.quantity ?? 0, price: item.price ?? 0 };
  }

  private normalizeAccount(account: AccountRow): Record<string, unknown> {
    return { ...account, archived: account.archived ?? 0, cache_source: account.cache_source ?? 'api' };
  }

  private normalizeItem(item: ItemRow): Record<string, unknown> {
    return { ...item, archived: item.archived ?? null, cache_source: item.cache_source ?? 'api' };
  }

  private normalizeStock(row: ItemStockLocationRow): Record<string, unknown> {
    return {
      ...row,
      quantity_on_hand: row.quantity_on_hand ?? 0,
      quantity_reserved: row.quantity_reserved ?? null,
      quantity_available: row.quantity_available ?? null,
      quantity_incoming: row.quantity_incoming ?? null,
      in_transit: row.in_transit ?? null,
      cache_source: row.cache_source ?? 'api',
    };
  }

  private normalizePaymentTransaction(row: PaymentTransactionRow): Record<string, unknown> {
    return {
      ...row,
      reference: row.reference ?? null,
    };
  }
}

const isExistingFileError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'EEXIST';

const isCategoryCacheMeta = (value: unknown): value is CategoryCacheMeta => {
  if (!isRecord(value)) return false;
  const exactKeys = [
    'accountIdentity', 'completedAt', 'count', 'fingerprint', 'generation', 'page',
    'pages', 'schemaVersion', 'sourceApiVersion', 'sourceRowCount', 'startedAt', 'status',
    'storedRowCount', 'version',
  ];
  return hasExactKeys(value, exactKeys)
    && value.version === 1
    && value.status === 'complete'
    && isNonEmptyString(value.accountIdentity)
    && isNonNegativeInteger(value.startedAt)
    && isNonNegativeInteger(value.completedAt)
    && value.completedAt >= value.startedAt
    && isNonNegativeInteger(value.count)
    && isNonNegativeInteger(value.page)
    && isNonNegativeInteger(value.pages)
    && isNonNegativeInteger(value.sourceRowCount)
    && isNonNegativeInteger(value.storedRowCount)
    && value.schemaVersion === CACHE_SCHEMA_VERSION
    && isApiSourceVersion(value.sourceApiVersion)
    && isNonEmptyString(value.generation)
    && isNonEmptyString(value.fingerprint)
    && (value.count === 0
      ? value.page === 1 && (value.pages === 0 || value.pages === 1)
      : value.pages >= 1 && value.page === value.pages);
};

const isCategoryCacheRow = (value: unknown): value is CategoryCacheRow => {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.category_id)
    && isNonEmptyString(value.name)
    && (value.item_count === null || isNonNegativeInteger(value.item_count))
    && (value.parent_id === null || isNonEmptyString(value.parent_id))
    && (value.parent_name === null || isNonEmptyString(value.parent_name))
    && (value.inventory_type === null || value.inventory_type === 'quantity' || value.inventory_type === 'unique')
    && (value.custom_fields_json === null || isTextWithoutNullByte(value.custom_fields_json))
    && (value.created === null || isTextWithoutNullByte(value.created))
    && (value.modified === null || isNonNegativeInteger(value.modified))
    && value.cache_source === 'api'
    && isApiSourceVersion(value.source_api_version)
    && isNonNegativeInteger(value.imported_at);
};

const isInventoryCacheMeta = (value: unknown): value is InventoryCacheMeta => {
  if (!isRecord(value)) return false;
  const exactKeys = [
    'accountIdentity', 'completedAt', 'fingerprint', 'generation', 'itemCount',
    'schemaVersion', 'sourceApiVersion', 'startedAt', 'status', 'stockRowCount', 'version',
  ];
  return hasExactKeys(value, exactKeys)
    && value.version === 1
    && value.status === 'complete'
    && isNonEmptyString(value.accountIdentity)
    && isNonNegativeInteger(value.startedAt)
    && isNonNegativeInteger(value.completedAt)
    && value.completedAt >= value.startedAt
    && isNonNegativeInteger(value.itemCount)
    && isNonNegativeInteger(value.stockRowCount)
    && value.schemaVersion === CACHE_SCHEMA_VERSION
    && value.sourceApiVersion === '3'
    && isNonEmptyString(value.generation)
    && isNonEmptyString(value.fingerprint);
};

const isInventoryItemRow = (value: unknown): value is ItemRow => {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.item_id)
    && isNonEmptyString(value.name)
    && value.cache_source === 'api'
    && value.source_api_version === '3';
};

const isInventoryStockRow = (value: unknown): value is ItemStockLocationRow => {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.stock_row_id)
    && isNonEmptyString(value.item_id)
    && isFiniteNumber(value.quantity_on_hand)
    && isNullableFiniteNumber(value.quantity_reserved)
    && isNullableFiniteNumber(value.quantity_available)
    && isNullableFiniteNumber(value.quantity_incoming)
    && isNullableFiniteNumber(value.in_transit)
    && value.cache_source === 'api'
    && value.source_api_version === '3';
};

const isV3ApiRow = (value: ItemRow | ItemStockLocationRow): boolean =>
  value.cache_source === 'api' && value.source_api_version === '3';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

const isTextWithoutNullByte = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0');

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNullableFiniteNumber = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

const isApiSourceVersion = (value: unknown): value is '2.0' | '3' =>
  value === '2.0' || value === '3';

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ESRCH');
  }
};
