/**
 * SQLite cache service for document caching
 */

import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow, CacheState, CacheMetaRow, ItemSalesByPeriodRow, PriceDistributionRow, CustomerSalesData } from './types.js';

/**
 * SQLite cache service for local document caching.
 * Implements CacheService with Promise-wrapped synchronous sqlite calls.
 */
export class SQLiteCacheService implements CacheService {
  private db: Database.Database;
  private readonly accountName: string;
  private readonly dbPath: string;

  /**
   * Create a new SQLite cache service
   * @param accountName - Account name for cache isolation
   * @param customPath - Optional custom path for testing
   */
  constructor(accountName: string, customPath?: string) {
    this.accountName = this.sanitizeAccountName(accountName);
    this.dbPath = customPath || this.resolveCachePath(this.accountName);
    this.db = this.connect();
    this.initializeSchema();
  }

  /**
   * Sanitize account name for use in file paths
   */
  private sanitizeAccountName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Resolve cache file path
   */
  private resolveCachePath(accountName: string): string {
    const cacheDir = join(homedir(), '.salesbinder', 'cache');
    mkdirSync(cacheDir, { mode: 0o700, recursive: true });
    return join(cacheDir, `salesbinder-${accountName}.db`);
  }

  /**
   * Connect to SQLite database
   */
  private connect(): Database.Database {
    const db = new Database(this.dbPath, {
      fileMustExist: false,
      verbose: process.env.DEBUG === 'true' ? console.log : undefined,
    });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    // Set secure file permissions
    if (existsSync(this.dbPath)) {
      try {
        chmodSync(this.dbPath, 0o600);
      } catch {
        // Ignore permission errors on some systems
      }
    }
    
    return db;
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;

    if (currentVersion === 0) {
      this.createSchema();
      this.db.pragma('user_version = 1');
    }
  }

  /**
   * Create database schema
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        doc_number INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        modified INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_item_documents_item
        ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_documents_context
        ON documents(context_id);
      CREATE INDEX IF NOT EXISTS idx_documents_modified
        ON documents(modified);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc
        ON item_documents(doc_id);
    `);
  }

  /**
   * Get database path
   */
  getDbPath(): string {
    return this.dbPath;
  }

  // ============ Document CRUD Operations ============

  insertDocument(doc: DocumentRow): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents
      (doc_id, context_id, doc_number, issue_date, customer_id, modified)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(doc.doc_id, doc.context_id, doc.doc_number, doc.issue_date, doc.customer_id, doc.modified);
    return Promise.resolve();
  }

  getDocument(docId: string): Promise<DocumentRow | undefined> {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE doc_id = ?`);
    return Promise.resolve(stmt.get(docId) as DocumentRow | undefined);
  }

  getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE context_id = ?`);
    return Promise.resolve(stmt.all(contextId) as DocumentRow[]);
  }

  getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM documents WHERE modified > ?
      ORDER BY modified ASC
    `);
    return Promise.resolve(stmt.all(timestamp) as DocumentRow[]);
  }

  deleteDocument(docId: string): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
    stmt.run(docId);
    return Promise.resolve();
  }

  batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO documents
      (doc_id, context_id, doc_number, issue_date, customer_id, modified)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((documents: DocumentRow[]) => {
      for (const doc of documents) {
        insert.run(doc.doc_id, doc.context_id, doc.doc_number, doc.issue_date, doc.customer_id, doc.modified);
      }
    });
    transaction(docs);
    return Promise.resolve();
  }

  batchDeleteDocuments(docIds: string[]): Promise<void> {
    const deleteStmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteStmt.run(id);
      }
    });
    transaction(docIds);
    return Promise.resolve();
  }

  // ============ Item Document CRUD Operations ============

  insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO item_documents (item_id, doc_id, quantity, price)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(item.item_id, item.doc_id, item.quantity, item.price);
    return Promise.resolve();
  }

  getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    const stmt = this.db.prepare(`SELECT * FROM item_documents WHERE doc_id = ?`);
    return Promise.resolve(stmt.all(docId) as ItemDocumentRow[]);
  }

  deleteItemDocuments(docId: string): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM item_documents WHERE doc_id = ?`);
    stmt.run(docId);
    return Promise.resolve();
  }

  batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    
    const insert = this.db.prepare(`
      INSERT INTO item_documents (item_id, doc_id, quantity, price)
      VALUES (?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((itemDocs: Omit<ItemDocumentRow, 'id'>[]) => {
      for (const item of itemDocs) {
        insert.run(item.item_id, item.doc_id, item.quantity, item.price);
      }
    });
    transaction(items);
    return Promise.resolve();
  }

  // ============ Analytics Query Helpers ============

  getItemDocumentsForPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemDocumentRow[]> {
    const stmt = this.db.prepare(`
      SELECT id.* FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date DESC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as ItemDocumentRow[]);
  }

  getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined> {
    const stmt = this.db.prepare(`
      SELECT MAX(d.issue_date) as latest_date
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ?
    `);
    const result = stmt.get(itemId, contextId) as { latest_date: string | null } | undefined;
    return Promise.resolve(result?.latest_date || undefined);
  }

  getItemSalesByPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemSalesByPeriodRow[]> {
    const stmt = this.db.prepare(`
      SELECT
        d.issue_date,
        id.quantity,
        id.price
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date ASC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as ItemSalesByPeriodRow[]);
  }

  getItemPriceDistribution(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<PriceDistributionRow[]> {
    const stmt = this.db.prepare(`
      SELECT
        id.price,
        SUM(ABS(id.quantity)) as total_quantity,
        SUM(id.quantity * id.price) as total_revenue
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      GROUP BY id.price
      ORDER BY id.price ASC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as PriceDistributionRow[]);
  }

  getItemSalesByCustomer(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<CustomerSalesData[]> {
    const stmt = this.db.prepare(`
      SELECT
        d.customer_id,
        SUM(ABS(id.quantity)) as quantity,
        SUM(id.quantity * id.price) as revenue,
        COUNT(DISTINCT id.doc_id) as order_count
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      GROUP BY d.customer_id
      ORDER BY revenue DESC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as CustomerSalesData[]);
  }

  getItemSalesByMonth(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<{ month: string; quantity: number; revenue: number }[]> {
    const stmt = this.db.prepare(`
      SELECT
        strftime('%Y-%m', d.issue_date) as month,
        SUM(ABS(id.quantity)) as quantity,
        SUM(id.quantity * id.price) as revenue
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      GROUP BY month
      ORDER BY month ASC
    `);
    return Promise.resolve(stmt.all(itemId, contextId, startDate, endDate) as { month: string; quantity: number; revenue: number }[]);
  }

  getItemOrderPatterns(
    itemId: string,
    startDate: string,
    endDate: string
  ): Promise<{
    doc_id: string;
    quantity: number;
    price: number;
    issue_date: string;
    customer_id: string;
    context_id: number;
    doc_number: number;
  }[]> {
    const stmt = this.db.prepare(`
      SELECT
        id.doc_id,
        id.quantity,
        id.price,
        d.issue_date,
        d.customer_id,
        d.context_id,
        d.doc_number
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id IN (4, 5)
        AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date DESC
    `);
    return Promise.resolve(stmt.all(itemId, startDate, endDate) as any[]);
  }

  // ============ Cache Metadata Operations ============

  getCacheState(): Promise<CacheState | null> {
    const stmt = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'state'`);
    const row = stmt.get() as CacheMetaRow | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(row.value) as CacheState);
  }

  setCacheState(state: CacheState): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)
    `);
    stmt.run(JSON.stringify(state));
    return Promise.resolve();
  }

  getDocumentCount(): Promise<number> {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM documents`);
    const result = stmt.get() as { count: number };
    return Promise.resolve(result.count);
  }

  getItemDocumentCount(): Promise<number> {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM item_documents`);
    const result = stmt.get() as { count: number };
    return Promise.resolve(result.count);
  }

  // ============ Raw Meta Access (used by PG→SQLite sync) ============

  /**
   * Read an arbitrary key from cache_meta
   */
  getRawMeta(key: string): number | null {
    const stmt = this.db.prepare(`SELECT value FROM cache_meta WHERE key = ?`);
    const row = stmt.get(key) as { value: string } | undefined;
    if (!row) return null;
    const num = Number(row.value);
    return isNaN(num) ? null : num;
  }

  /**
   * Write an arbitrary key to cache_meta
   */
  setRawMeta(key: string, value: string): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)`);
    stmt.run(key, value);
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
    }
  }

  /**
   * Check if database connection is open
   */
  isOpen(): boolean {
    return this.db && this.db.open;
  }
}
