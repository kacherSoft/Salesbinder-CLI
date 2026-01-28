/**
 * SQLite cache service for document caching
 */

import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DocumentRow, ItemDocumentRow, CacheState, CacheMetaRow } from './types.js';

/**
 * SQLite cache service for local document caching
 */
export class SQLiteCacheService {
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

  /**
   * Insert or replace a document
   */
  insertDocument(doc: DocumentRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents
      (doc_id, context_id, doc_number, issue_date, customer_id, modified)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(doc.doc_id, doc.context_id, doc.doc_number, doc.issue_date, doc.customer_id, doc.modified);
  }

  /**
   * Get a document by ID
   */
  getDocument(docId: string): DocumentRow | undefined {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE doc_id = ?`);
    return stmt.get(docId) as DocumentRow | undefined;
  }

  /**
   * Get documents by context ID
   */
  getDocumentsByContext(contextId: number): DocumentRow[] {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE context_id = ?`);
    return stmt.all(contextId) as DocumentRow[];
  }

  /**
   * Get documents modified since timestamp
   */
  getDocumentsModifiedSince(timestamp: number): DocumentRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM documents WHERE modified > ?
      ORDER BY modified ASC
    `);
    return stmt.all(timestamp) as DocumentRow[];
  }

  /**
   * Delete a document (cascades to item_documents)
   */
  deleteDocument(docId: string): void {
    const stmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
    stmt.run(docId);
  }

  /**
   * Batch insert documents (transactional)
   */
  batchInsertDocuments(docs: DocumentRow[]): void {
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
  }

  /**
   * Batch delete documents (transactional)
   */
  batchDeleteDocuments(docIds: string[]): void {
    const deleteStmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteStmt.run(id);
      }
    });
    transaction(docIds);
  }

  // ============ Item Document CRUD Operations ============

  /**
   * Insert a single item document
   */
  insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO item_documents (item_id, doc_id, quantity, price)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(item.item_id, item.doc_id, item.quantity, item.price);
  }

  /**
   * Get item documents for a document
   */
  getItemDocuments(docId: string): ItemDocumentRow[] {
    const stmt = this.db.prepare(`SELECT * FROM item_documents WHERE doc_id = ?`);
    return stmt.all(docId) as ItemDocumentRow[];
  }

  /**
   * Delete item documents for a document
   */
  deleteItemDocuments(docId: string): void {
    const stmt = this.db.prepare(`DELETE FROM item_documents WHERE doc_id = ?`);
    stmt.run(docId);
  }

  /**
   * Batch insert item documents (transactional)
   */
  batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): void {
    if (items.length === 0) return;
    
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
  }

  // ============ Analytics Query Helpers ============

  /**
   * Get item documents for a specific period and document context
   */
  getItemDocumentsForPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): ItemDocumentRow[] {
    const stmt = this.db.prepare(`
      SELECT id.* FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ?
        AND d.context_id = ?
        AND d.issue_date BETWEEN ? AND ?
      ORDER BY d.issue_date DESC
    `);
    return stmt.all(itemId, contextId, startDate, endDate) as ItemDocumentRow[];
  }

  /**
   * Get latest document date for an item by context
   */
  getLatestItemDocumentDate(itemId: string, contextId: number): string | undefined {
    const stmt = this.db.prepare(`
      SELECT MAX(d.issue_date) as latest_date
      FROM item_documents id
      JOIN documents d ON d.doc_id = id.doc_id
      WHERE id.item_id = ? AND d.context_id = ?
    `);
    const result = stmt.get(itemId, contextId) as { latest_date: string | null } | undefined;
    return result?.latest_date || undefined;
  }

  // ============ Cache Metadata Operations ============

  /**
   * Get cache state
   */
  getCacheState(): CacheState | null {
    const stmt = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'state'`);
    const row = stmt.get() as CacheMetaRow | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as CacheState;
  }

  /**
   * Set cache state
   */
  setCacheState(state: CacheState): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)
    `);
    stmt.run(JSON.stringify(state));
  }

  /**
   * Get document count
   */
  getDocumentCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM documents`);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Get item document count
   */
  getItemDocumentCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM item_documents`);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Close database connection
   * Should be called when shutting down to release resources
   */
  close(): void {
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
