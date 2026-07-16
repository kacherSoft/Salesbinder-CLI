/**
 * SQLite cache service for local analytics reads.
 */

import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import type { CacheService } from './cache.interface.js';
import { CACHE_SCHEMA_VERSION } from './types.js';
import type {
  AccountRow,
  CacheMirrorSnapshot,
  CacheMetaRow,
  CacheState,
  CacheSyncStatus,
  CustomerSalesData,
  DocumentNonItemLineRow,
  DocumentRow,
  DocumentSnapshot,
  ItemDocumentRow,
  ItemRow,
  ItemSalesByPeriodRow,
  ItemStockLocationRow,
  PriceDistributionRow,
} from './types.js';

const DOCUMENT_COLUMNS = [
  'doc_id', 'context_id', 'doc_number', 'issue_date', 'customer_id', 'modified',
  'api_doc_id', 'cache_source', 'document_name', 'custom_doc_number',
  'account_id', 'account_context_id', 'account_name', 'account_number',
  'user_id', 'salesperson_name', 'customer_name', 'customer_number',
  'supplier_name', 'supplier_number', 'status_id', 'status_name',
  'total_price', 'total_cost', 'subtotal', 'associated_document_id',
  'external_po_number', 'shipping_location', 'date_sent', 'shipped_percent',
  'shipment_checked_at', 'source_fetched_at', 'snapshot_version',
  'snapshot_complete', 'is_cancelled', 'imported_at',
] as const;

const ITEM_DOCUMENT_COLUMNS = [
  'item_id', 'doc_id', 'quantity', 'price', 'document_item_id', 'item_name',
  'item_number', 'item_sku', 'item_location', 'line_description',
  'quantity_received', 'cost', 'total_amount', 'discounted_price', 'discount_percent',
  'quantity_shipped',
] as const;

const DOCUMENT_NON_ITEM_LINE_COLUMNS = [
  'doc_id', 'document_item_id', 'line_type', 'name', 'line_description',
  'service_category_id', 'unit_id', 'quantity', 'price', 'cost', 'total_amount',
  'discounted_price', 'discount_percent', 'net_amount', 'tax', 'tax2', 'weight',
  'source_created', 'source_modified', 'raw_classification',
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

export interface SQLiteCacheMaintenanceLease {
  release(): void;
}

export function tryAcquireSQLiteCacheMaintenanceLock(dbPath: string): SQLiteCacheMaintenanceLease | null {
  const canonicalDbPath = canonicalizeSQLiteCachePath(dbPath);
  const lockPath = `${canonicalDbPath}.maintenance-lock`;
  const lockDb = new Database(lockPath, { timeout: 0 });
  lockDb.pragma('busy_timeout = 0');

  try {
    lockDb.exec('BEGIN EXCLUSIVE');
    lockDb.exec('CREATE TABLE IF NOT EXISTS maintenance_lock (id INTEGER PRIMARY KEY)');
    try { chmodSync(lockPath, 0o600); } catch { /* ignore */ }
  } catch (error) {
    try { lockDb.close(); } catch { /* ignore */ }
    if (isSQLiteLockError(error)) return null;
    throw error;
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        lockDb.exec('COMMIT');
      } catch {
        try { lockDb.exec('ROLLBACK'); } catch { /* ignore */ }
      } finally {
        lockDb.close();
      }
    },
  };
}

export class SQLiteCacheService implements CacheService {
  private db!: Database.Database;
  private readonly accountName: string;
  private readonly dbPath: string;
  private readonly writer: boolean;
  private maintenanceLease: SQLiteCacheMaintenanceLease | null = null;

  constructor(accountName: string, customPath?: string, acquireMaintenanceLock = false) {
    this.accountName = this.sanitizeAccountName(accountName);
    this.dbPath = customPath || this.resolveCachePath(this.accountName);
    this.writer = acquireMaintenanceLock;
    if (acquireMaintenanceLock) {
      this.maintenanceLease = tryAcquireSQLiteCacheMaintenanceLock(this.dbPath);
      if (!this.maintenanceLease) {
        throw new Error('Another SQLite cache writer is already running.');
      }
    }
    try {
      this.db = this.connect();
      if (this.writer) {
        this.initializeSchema();
      } else {
        this.validateReadonlySchema();
      }
    } catch (error) {
      if (this.db?.open) this.db.close();
      this.maintenanceLease?.release();
      this.maintenanceLease = null;
      throw error;
    }
  }

  private sanitizeAccountName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private resolveCachePath(accountName: string): string {
    const cacheDir = join(homedir(), '.salesbinder', 'cache');
    return join(cacheDir, `salesbinder-${accountName}.db`);
  }

  private connect(): Database.Database {
    const debugSql = process.env['DEBUG'] === 'true';
    const db = new Database(this.dbPath, {
      readonly: !this.writer,
      fileMustExist: !this.writer,
      verbose: debugSql ? console.log : undefined,
    });
    try {
      db.function(
        'salesbinder_cache_writer_version',
        { deterministic: true },
        () => this.maintenanceLease ? CACHE_SCHEMA_VERSION : 0
      );
      if (this.writer) {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        if (existsSync(this.dbPath)) {
          try { chmodSync(this.dbPath, 0o600); } catch { /* ignore */ }
        }
      } else {
        db.pragma('query_only = ON');
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private validateReadonlySchema(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (currentVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite cache schema version ${currentVersion} is not readable; expected ${CACHE_SCHEMA_VERSION}. `
        + 'Run a cache writer to initialize or migrate it.'
      );
    }
  }

  private initializeSchema(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (currentVersion > CACHE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite cache schema version ${currentVersion} is newer than supported version ${CACHE_SCHEMA_VERSION}.`
      );
    }
    const shouldPublishVersion = currentVersion < CACHE_SCHEMA_VERSION;
    if (currentVersion === 0) {
      this.createSchema();
      // Some legacy cache files predate PRAGMA user_version. Make their
      // existing tables additive-compatible before creating v3 indexes.
      this.addDocumentColumns();
      this.addItemDocumentColumns();
      this.addDocumentSnapshotColumns();
      this.addItemShipmentColumns();
      this.assertUniqueSourceLines();
      this.createIndexes();
    } else if (currentVersion < CACHE_SCHEMA_VERSION) {
      this.migrateSchema(currentVersion);
    }
    this.createCompletenessTriggers();
    if (shouldPublishVersion) {
      this.db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
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
        shipment_checked_at TEXT NULL,
        source_fetched_at INTEGER NULL,
        snapshot_version INTEGER NOT NULL DEFAULT 0,
        snapshot_complete INTEGER NOT NULL DEFAULT 0,
        is_cancelled INTEGER NOT NULL DEFAULT 0,
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
        cost REAL NULL,
        total_amount REAL NULL,
        discounted_price REAL NULL,
        discount_percent REAL NULL,
        quantity_shipped REAL NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS document_non_item_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        document_item_id TEXT NOT NULL,
        line_type TEXT NOT NULL DEFAULT 'non_item',
        name TEXT NULL,
        line_description TEXT NULL,
        service_category_id TEXT NULL,
        unit_id TEXT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        cost REAL NULL,
        total_amount REAL NOT NULL,
        discounted_price REAL NULL,
        discount_percent REAL NULL,
        net_amount REAL NOT NULL,
        tax REAL NULL,
        tax2 REAL NULL,
        weight REAL NULL,
        source_created TEXT NULL,
        source_modified TEXT NULL,
        raw_classification TEXT NULL,
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
        created TEXT NULL,
        modified INTEGER NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
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
        quantity_reserved REAL NOT NULL DEFAULT 0,
        quantity_available REAL NOT NULL DEFAULT 0,
        quantity_incoming REAL NOT NULL DEFAULT 0,
        in_transit REAL NOT NULL DEFAULT 0,
        price REAL NULL,
        cost REAL NULL,
        valuation REAL NULL,
        barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at INTEGER NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private migrateSchema(fromVersion: number): void {
    if (fromVersion < 2) {
      this.createSchema();
      this.addDocumentColumns();
      this.addItemDocumentColumns();
    }
    if (fromVersion < 3) {
      this.createSchema();
      this.addDocumentSnapshotColumns();
      this.addItemShipmentColumns();
      this.assertUniqueSourceLines();
      this.createIndexes();
    }
  }

  private addDocumentColumns(): void {
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

  private addItemDocumentColumns(): void {
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

  private addDocumentSnapshotColumns(): void {
    this.addColumnsIfMissing('documents', [
      ['date_sent', 'TEXT NULL'],
      ['shipped_percent', 'REAL NULL'],
      ['shipment_checked_at', 'TEXT NULL'],
      ['source_fetched_at', 'INTEGER NULL'],
      ['snapshot_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['snapshot_complete', 'INTEGER NOT NULL DEFAULT 0'],
    ]);
  }

  private addItemShipmentColumns(): void {
    this.addColumnsIfMissing('item_documents', [
      ['quantity_shipped', 'REAL NULL'],
    ]);
  }

  private assertUniqueSourceLines(): void {
    const invalid = this.db.prepare(`
      SELECT doc_id, document_item_id
        FROM (
          SELECT doc_id, document_item_id FROM item_documents WHERE document_item_id IS NOT NULL
          UNION ALL
          SELECT doc_id, document_item_id FROM document_non_item_lines
        )
       WHERE TRIM(document_item_id) = ''
       LIMIT 1
    `).get() as { doc_id: string; document_item_id: string } | undefined;
    if (invalid) {
      throw new Error(`Cannot migrate cache schema: blank document line source id in ${invalid.doc_id}`);
    }
    const duplicate = this.db.prepare(`
      SELECT doc_id, document_item_id
        FROM (
          SELECT doc_id, document_item_id FROM item_documents WHERE document_item_id IS NOT NULL
          UNION ALL
          SELECT doc_id, document_item_id FROM document_non_item_lines
        )
       GROUP BY doc_id, document_item_id
      HAVING COUNT(*) > 1
       LIMIT 1
    `).get() as { doc_id: string; document_item_id: string } | undefined;
    if (duplicate) {
      throw new Error(
        `Cannot migrate cache schema: duplicate document line ${duplicate.document_item_id} in ${duplicate.doc_id}`
      );
    }
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
      CREATE INDEX IF NOT EXISTS idx_documents_api_doc_id ON documents(api_doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc ON item_documents(doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_name ON item_documents(item_name);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_number ON item_documents(item_number);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_sku ON item_documents(item_sku);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_item_documents_source_line
        ON item_documents(doc_id, document_item_id) WHERE document_item_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_document_non_item_lines_doc ON document_non_item_lines(doc_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_non_item_lines_source_line
        ON document_non_item_lines(doc_id, document_item_id) WHERE document_item_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_accounts_context_number ON accounts(context_id, account_number);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_name ON accounts(context_id, name);
      CREATE INDEX IF NOT EXISTS idx_accounts_modified ON accounts(modified);
      CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts(archived);
      CREATE INDEX IF NOT EXISTS idx_items_modified ON items(modified);
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
      CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
      CREATE INDEX IF NOT EXISTS idx_items_item_number ON items(item_number);
      CREATE INDEX IF NOT EXISTS idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON item_stock_locations(location_id);
    `);
  }

  private createCompletenessTriggers(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_documents_writer_v3_insert
      BEFORE INSERT ON documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_documents_writer_v3_update
      BEFORE UPDATE ON documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_documents_writer_v3_delete
      BEFORE DELETE ON documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;

      CREATE TRIGGER IF NOT EXISTS trg_item_documents_writer_v3_insert
      BEFORE INSERT ON item_documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_item_documents_writer_v3_update
      BEFORE UPDATE ON item_documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_item_documents_writer_v3_delete
      BEFORE DELETE ON item_documents
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;

      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_writer_v3_insert
      BEFORE INSERT ON document_non_item_lines
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_writer_v3_update
      BEFORE UPDATE ON document_non_item_lines
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_writer_v3_delete
      BEFORE DELETE ON document_non_item_lines
      WHEN salesbinder_cache_writer_version() <> ${CACHE_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;

      CREATE TRIGGER IF NOT EXISTS trg_documents_financial_snapshot_incomplete
      AFTER UPDATE OF context_id, doc_number, total_price, total_cost, subtotal ON documents
      WHEN OLD.context_id IS NOT NEW.context_id
        OR OLD.doc_number IS NOT NEW.doc_number
        OR OLD.total_price IS NOT NEW.total_price
        OR OLD.total_cost IS NOT NEW.total_cost
        OR OLD.subtotal IS NOT NEW.subtotal
      BEGIN
        UPDATE documents SET snapshot_complete = 0 WHERE doc_id = NEW.doc_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_item_documents_insert_snapshot_incomplete
      AFTER INSERT ON item_documents
      BEGIN
        UPDATE documents SET snapshot_complete = 0 WHERE doc_id = NEW.doc_id AND snapshot_complete <> 0;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_item_documents_delete_snapshot_incomplete
      AFTER DELETE ON item_documents
      BEGIN
        UPDATE documents SET snapshot_complete = 0 WHERE doc_id = OLD.doc_id AND snapshot_complete <> 0;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_item_documents_financial_update_snapshot_incomplete
      AFTER UPDATE OF item_id, doc_id, document_item_id, quantity, price, cost,
        total_amount, discounted_price, discount_percent ON item_documents
      BEGIN
        UPDATE documents SET snapshot_complete = 0
         WHERE doc_id IN (OLD.doc_id, NEW.doc_id) AND snapshot_complete <> 0;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_insert_snapshot_incomplete
      AFTER INSERT ON document_non_item_lines
      BEGIN
        UPDATE documents SET snapshot_complete = 0 WHERE doc_id = NEW.doc_id AND snapshot_complete <> 0;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_delete_snapshot_incomplete
      AFTER DELETE ON document_non_item_lines
      BEGIN
        UPDATE documents SET snapshot_complete = 0 WHERE doc_id = OLD.doc_id AND snapshot_complete <> 0;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_non_item_lines_update_snapshot_incomplete
      AFTER UPDATE ON document_non_item_lines
      BEGIN
        UPDATE documents SET snapshot_complete = 0
         WHERE doc_id IN (OLD.doc_id, NEW.doc_id) AND snapshot_complete <> 0;
      END;
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

  replaceDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.validateDocumentSnapshot(snapshot);
    const replace = this.db.transaction((incoming: DocumentSnapshot) => {
      const sourceDoc = incoming.document;
      const existingByApiId = sourceDoc.api_doc_id ? this.db
        .prepare(`SELECT * FROM documents WHERE api_doc_id = ?`)
        .get(sourceDoc.api_doc_id) as DocumentRow | undefined : undefined;
      const existingByNumber = this.db
        .prepare(`SELECT * FROM documents WHERE context_id = ? AND doc_number = ?`)
        .get(sourceDoc.context_id, sourceDoc.doc_number) as DocumentRow | undefined;
      const existing = existingByApiId ?? existingByNumber;
      const docId = existing?.doc_id ?? sourceDoc.doc_id;
      const existingLines = this.db
        .prepare(`SELECT * FROM item_documents WHERE doc_id = ?`)
        .all(docId) as ItemDocumentRow[];
      const existingBySourceId = new Map(
        existingLines
          .filter((line) => line.document_item_id)
          .map((line) => [line.document_item_id!, line])
      );
      const preserveReconciledShipment = isShipmentNewer(existing?.shipment_checked_at, incoming.sourceFetchedAt);
      const resolvedDocument: DocumentRow = {
        ...sourceDoc,
        doc_id: docId,
        date_sent: preserveReconciledShipment
          ? existing?.date_sent ?? sourceDoc.date_sent ?? null
          : authoritativeShipmentValue(sourceDoc.date_sent, existing?.date_sent),
        shipped_percent: preserveReconciledShipment
          ? existing?.shipped_percent ?? sourceDoc.shipped_percent ?? null
          : authoritativeShipmentValue(sourceDoc.shipped_percent, existing?.shipped_percent),
        shipment_checked_at: existing?.shipment_checked_at ?? null,
        source_fetched_at: incoming.sourceFetchedAt,
        snapshot_version: CACHE_SCHEMA_VERSION,
        snapshot_complete: 0,
      };
      const resolvedItems = incoming.itemLines.map((line) => {
        const existingLine = line.document_item_id
          ? existingBySourceId.get(line.document_item_id)
          : undefined;
        return {
          ...line,
          doc_id: docId,
          quantity_shipped: preserveReconciledShipment
            ? existingLine?.quantity_shipped ?? line.quantity_shipped ?? null
            : authoritativeShipmentValue(line.quantity_shipped, existingLine?.quantity_shipped),
        };
      });
      const resolvedNonItemLines = incoming.nonItemLines.map((line) => ({ ...line, doc_id: docId }));

      this.db.prepare(this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'))
        .run(...this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(resolvedDocument)));
      this.db.prepare(`DELETE FROM item_documents WHERE doc_id = ?`).run(docId);
      this.db.prepare(`DELETE FROM document_non_item_lines WHERE doc_id = ?`).run(docId);

      const insertItem = this.db.prepare(
        `INSERT INTO item_documents (${ITEM_DOCUMENT_COLUMNS.join(', ')}) VALUES (${ITEM_DOCUMENT_COLUMNS.map(() => '?').join(', ')})`
      );
      for (const line of resolvedItems) {
        insertItem.run(...this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(line)));
      }
      const insertNonItem = this.db.prepare(
        `INSERT INTO document_non_item_lines (${DOCUMENT_NON_ITEM_LINE_COLUMNS.join(', ')}) VALUES (${DOCUMENT_NON_ITEM_LINE_COLUMNS.map(() => '?').join(', ')})`
      );
      for (const line of resolvedNonItemLines) {
        insertNonItem.run(...this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line)));
      }
      this.db.prepare(`UPDATE documents SET snapshot_complete = 1 WHERE doc_id = ?`).run(docId);
    });
    replace.immediate(snapshot);
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

  insertDocumentNonItemLine(line: Omit<DocumentNonItemLineRow, 'id'>): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO document_non_item_lines (${DOCUMENT_NON_ITEM_LINE_COLUMNS.join(', ')}) VALUES (${DOCUMENT_NON_ITEM_LINE_COLUMNS.map(() => '?').join(', ')})`
    );
    stmt.run(...this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line)));
    return Promise.resolve();
  }

  getDocumentNonItemLines(docId: string): Promise<DocumentNonItemLineRow[]> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM document_non_item_lines WHERE doc_id = ?`).all(docId) as DocumentNonItemLineRow[]
    );
  }

  getAllDocumentNonItemLines(): Promise<DocumentNonItemLineRow[]> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM document_non_item_lines`).all() as DocumentNonItemLineRow[]
    );
  }

  deleteDocumentNonItemLines(docId: string): Promise<void> {
    this.db.prepare(`DELETE FROM document_non_item_lines WHERE doc_id = ?`).run(docId);
    return Promise.resolve();
  }

  batchInsertDocumentNonItemLines(lines: Omit<DocumentNonItemLineRow, 'id'>[]): Promise<void> {
    if (lines.length === 0) return Promise.resolve();
    const insert = this.db.prepare(
      `INSERT INTO document_non_item_lines (${DOCUMENT_NON_ITEM_LINE_COLUMNS.join(', ')}) VALUES (${DOCUMENT_NON_ITEM_LINE_COLUMNS.map(() => '?').join(', ')})`
    );
    const tx = this.db.transaction((rows: Omit<DocumentNonItemLineRow, 'id'>[]) => {
      for (const line of rows) {
        insert.run(...this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line)));
      }
    });
    tx(lines);
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

  insertItem(item: ItemRow): Promise<void> {
    this.db.prepare(this.upsertSql('items', ITEM_COLUMNS, 'item_id')).run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)));
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
    const insert = this.db.prepare(this.upsertSql('items', ITEM_COLUMNS, 'item_id'));
    const tx = this.db.transaction((rows: ItemRow[]) => {
      for (const row of rows) insert.run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(row)));
    });
    tx(items);
    return Promise.resolve();
  }

  deleteItem(itemId: string): Promise<void> {
    this.db.prepare(`DELETE FROM items WHERE item_id = ?`).run(itemId);
    return Promise.resolve();
  }

  insertItemStockLocation(row: ItemStockLocationRow): Promise<void> {
    this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id')).run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
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
    });
    tx();
    return Promise.resolve();
  }

  batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void> {
    const insert = this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'));
    const tx = this.db.transaction((stockRows: ItemStockLocationRow[]) => {
      for (const row of stockRows) insert.run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
    });
    tx(rows);
    return Promise.resolve();
  }

  deleteItemStockLocations(itemId: string): Promise<void> {
    this.db.prepare(`DELETE FROM item_stock_locations WHERE item_id = ?`).run(itemId);
    return Promise.resolve();
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
    const row = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'state'`).get() as CacheMetaRow | undefined;
    return Promise.resolve(row ? JSON.parse(row.value) as CacheState : null);
  }

  setCacheState(state: CacheState): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)`).run(JSON.stringify(state));
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

  getDocumentCount(): Promise<number> {
    return Promise.resolve(this.count('documents'));
  }

  getItemDocumentCount(): Promise<number> {
    return Promise.resolve(this.count('item_documents'));
  }

  getDocumentNonItemLineCount(): Promise<number> {
    return Promise.resolve(this.count('document_non_item_lines'));
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
    this.db.exec(`
      DELETE FROM item_stock_locations;
      DELETE FROM document_non_item_lines;
      DELETE FROM item_documents;
      DELETE FROM items;
      DELETE FROM documents;
      DELETE FROM accounts;
      DELETE FROM cache_meta;
    `);
    return Promise.resolve();
  }

  replaceMirrorSnapshot(snapshot: CacheMirrorSnapshot): void {
    const replace = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM item_stock_locations;
        DELETE FROM document_non_item_lines;
        DELETE FROM item_documents;
        DELETE FROM items;
        DELETE FROM documents;
        DELETE FROM accounts;
        DELETE FROM cache_meta;
      `);
      const insertAccount = this.db.prepare(this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'));
      for (const row of snapshot.accounts) {
        insertAccount.run(...this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(row)));
      }
      const insertItem = this.db.prepare(this.upsertSql('items', ITEM_COLUMNS, 'item_id'));
      for (const row of snapshot.items) {
        insertItem.run(...this.valuesFor(ITEM_COLUMNS, this.normalizeItem(row)));
      }
      const insertStock = this.db.prepare(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'));
      for (const row of snapshot.stockLocations) {
        insertStock.run(...this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      }
      const insertDocument = this.db.prepare(this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'));
      for (const row of snapshot.documents) {
        insertDocument.run(...this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(row)));
      }
      const insertItemDocument = this.db.prepare(
        `INSERT INTO item_documents (${ITEM_DOCUMENT_COLUMNS.join(', ')}) VALUES (${ITEM_DOCUMENT_COLUMNS.map(() => '?').join(', ')})`
      );
      for (const row of snapshot.itemDocuments) {
        insertItemDocument.run(...this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(row)));
      }
      const insertNonItemLine = this.db.prepare(
        `INSERT INTO document_non_item_lines (${DOCUMENT_NON_ITEM_LINE_COLUMNS.join(', ')}) VALUES (${DOCUMENT_NON_ITEM_LINE_COLUMNS.map(() => '?').join(', ')})`
      );
      for (const row of snapshot.documentNonItemLines) {
        insertNonItemLine.run(...this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(row)));
      }
      const restoreCompleteness = this.db.prepare(
        `UPDATE documents SET snapshot_complete = ?, snapshot_version = ? WHERE doc_id = ?`
      );
      for (const row of snapshot.documents) {
        restoreCompleteness.run(row.snapshot_complete ?? 0, row.snapshot_version ?? 0, row.doc_id);
      }
      if (snapshot.state) {
        const state: CacheState = {
          ...snapshot.state,
          schemaVersion: CACHE_SCHEMA_VERSION,
          documentCount: snapshot.documents.length,
          itemDocumentCount: snapshot.itemDocuments.length,
          nonItemDocumentCount: snapshot.documentNonItemLines.length,
        };
        this.db.prepare(`INSERT INTO cache_meta (key, value) VALUES ('state', ?)`)
          .run(JSON.stringify(state));
      }
      if (snapshot.syncStatus) {
        this.db.prepare(`INSERT INTO cache_meta (key, value) VALUES ('sync_status', ?)`)
          .run(JSON.stringify(snapshot.syncStatus));
      }
    });
    replace.immediate();
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

  async tryAcquireSyncLock(_lockKey: string): Promise<boolean> {
    return this.writer && this.maintenanceLease !== null;
  }

  async releaseSyncLock(_lockKey: string): Promise<void> {
    // A writable handle and its maintenance lease have the same lifetime.
    // Releasing only the sidecar would leave an unfenced writable connection.
  }

  async close(): Promise<void> {
    try {
      if (this.db?.open) this.db.close();
    } finally {
      this.maintenanceLease?.release();
      this.maintenanceLease = null;
    }
  }

  isOpen(): boolean {
    return this.db && this.db.open;
  }

  private count(table: string, where?: string, params: unknown[] = []): number {
    const sql = where ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as count FROM ${table}`;
    const result = this.db.prepare(sql).get(...params) as { count: number };
    return result.count;
  }

  private upsertSql(table: string, columns: readonly string[], conflictColumn: string): string {
    const updates = columns
      .filter((column) => column !== conflictColumn)
      .map((column) => `${column} = excluded.${column}`)
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
      snapshot_version: doc.snapshot_version ?? 0,
      snapshot_complete: doc.snapshot_complete ?? 0,
      is_cancelled: doc.is_cancelled ?? 0,
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

  private normalizeDocumentNonItemLine(
    line: Omit<DocumentNonItemLineRow, 'id'>
  ): Record<string, unknown> {
    return {
      ...line,
      line_type: 'non_item',
      quantity: line.quantity ?? 0,
      price: line.price ?? 0,
      total_amount: line.total_amount ?? 0,
      net_amount: line.net_amount ?? 0,
    };
  }

  private validateDocumentSnapshot(snapshot: DocumentSnapshot): void {
    if (!snapshot.document.doc_id || !Number.isFinite(snapshot.sourceFetchedAt)) {
      throw new Error('Invalid document snapshot identity or source timestamp');
    }
    const sourceIds = new Set<string>();
    for (const line of [...snapshot.itemLines, ...snapshot.nonItemLines]) {
      const sourceId = line.document_item_id?.trim();
      if (!sourceId) throw new Error(`Document ${snapshot.document.doc_id} contains a line without source id`);
      if (sourceIds.has(sourceId)) {
        throw new Error(`Document ${snapshot.document.doc_id} contains duplicate source line ${sourceId}`);
      }
      sourceIds.add(sourceId);
    }
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
}

function isShipmentNewer(value: string | null | undefined, sourceFetchedAt: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > sourceFetchedAt * 1000;
}

function authoritativeShipmentValue<T>(incoming: T | null | undefined, existing: T | null | undefined): T | null {
  return incoming === undefined ? existing ?? null : incoming;
}

function canonicalizeSQLiteCachePath(dbPath: string): string {
  const absolutePath = resolve(dbPath);
  mkdirSync(dirname(absolutePath), { mode: 0o700, recursive: true });
  try {
    return realpathSync.native(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return join(realpathSync.native(dirname(absolutePath)), basename(absolutePath));
}

function isSQLiteLockError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}
