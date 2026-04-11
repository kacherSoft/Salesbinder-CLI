/**
 * PostgreSQL cache service for document caching
 * Uses pg (node-postgres) with a connection pool
 */

import pg from 'pg';
import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow, CacheState, ItemSalesByPeriodRow, PriceDistributionRow, CustomerSalesData } from './types.js';

const { Pool } = pg;

/**
 * PostgreSQL cache service — online shared cache implementation.
 * All SQL is standard ANSI with minor PostgreSQL-specific syntax
 * (SERIAL, to_char instead of strftime, ON CONFLICT instead of INSERT OR REPLACE).
 */
export class PostgresCacheService implements CacheService {
  private pool: InstanceType<typeof Pool>;
  private opened: boolean = true;
  private readonly connectionString: string;

  /**
   * @param connectionString  Full PostgreSQL connection URL, e.g.
   *   postgres://user:pass@host:port/dbname
   */
  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString });
  }

  /**
   * Create tables if they don't exist (idempotent).
   * Call once after construction before using the service.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
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
   * Returns the connection string as the "path" identifier.
   */
  getDbPath(): string {
    // Mask password in URL for display
    try {
      const url = new URL(this.connectionString);
      url.password = '***';
      return url.toString();
    } catch {
      return this.connectionString;
    }
  }

  // ============ Document CRUD Operations ============

  async insertDocument(doc: DocumentRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (doc_id, context_id, doc_number, issue_date, customer_id, modified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (doc_id) DO UPDATE SET
         context_id = EXCLUDED.context_id,
         doc_number = EXCLUDED.doc_number,
         issue_date = EXCLUDED.issue_date,
         customer_id = EXCLUDED.customer_id,
         modified = EXCLUDED.modified`,
      [doc.doc_id, doc.context_id, doc.doc_number, doc.issue_date, doc.customer_id, doc.modified]
    );
  }

  async getDocument(docId: string): Promise<DocumentRow | undefined> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE doc_id = $1`,
      [docId]
    );
    return result.rows[0];
  }

  async getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE context_id = $1`,
      [contextId]
    );
    return result.rows;
  }

  async getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE modified > $1 ORDER BY modified ASC`,
      [timestamp]
    );
    return result.rows;
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.pool.query(`DELETE FROM documents WHERE doc_id = $1`, [docId]);
  }

  async batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    if (docs.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of docs) {
        await client.query(
          `INSERT INTO documents (doc_id, context_id, doc_number, issue_date, customer_id, modified)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (doc_id) DO UPDATE SET
             context_id = EXCLUDED.context_id,
             doc_number = EXCLUDED.doc_number,
             issue_date = EXCLUDED.issue_date,
             customer_id = EXCLUDED.customer_id,
             modified = EXCLUDED.modified`,
          [doc.doc_id, doc.context_id, doc.doc_number, doc.issue_date, doc.customer_id, doc.modified]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async batchDeleteDocuments(docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const id of docIds) {
        await client.query(`DELETE FROM documents WHERE doc_id = $1`, [id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ============ Item Document CRUD Operations ============

  async insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO item_documents (item_id, doc_id, quantity, price)
       VALUES ($1, $2, $3, $4)`,
      [item.item_id, item.doc_id, item.quantity, item.price]
    );
  }

  async getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    const result = await this.pool.query<ItemDocumentRow>(
      `SELECT * FROM item_documents WHERE doc_id = $1`,
      [docId]
    );
    return result.rows;
  }

  async deleteItemDocuments(docId: string): Promise<void> {
    await this.pool.query(`DELETE FROM item_documents WHERE doc_id = $1`, [docId]);
  }

  async batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    if (items.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          `INSERT INTO item_documents (item_id, doc_id, quantity, price)
           VALUES ($1, $2, $3, $4)`,
          [item.item_id, item.doc_id, item.quantity, item.price]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ============ Analytics Query Helpers ============

  async getItemDocumentsForPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemDocumentRow[]> {
    const result = await this.pool.query<ItemDocumentRow>(
      `SELECT id.* FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id = $2
         AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows;
  }

  async getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined> {
    const result = await this.pool.query<{ latest_date: string | null }>(
      `SELECT MAX(d.issue_date) as latest_date
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2`,
      [itemId, contextId]
    );
    return result.rows[0]?.latest_date || undefined;
  }

  async getItemSalesByPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemSalesByPeriodRow[]> {
    const result = await this.pool.query<ItemSalesByPeriodRow>(
      `SELECT
         d.issue_date,
         id.quantity,
         id.price
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id = $2
         AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows;
  }

  async getItemPriceDistribution(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<PriceDistributionRow[]> {
    const result = await this.pool.query<PriceDistributionRow>(
      `SELECT
         id.price,
         SUM(ABS(id.quantity)) as total_quantity,
         SUM(id.quantity * id.price) as total_revenue
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id = $2
         AND d.issue_date BETWEEN $3 AND $4
       GROUP BY id.price
       ORDER BY id.price ASC`,
      [itemId, contextId, startDate, endDate]
    );
    // pg returns numeric columns as strings, coerce them
    return result.rows.map(row => ({
      price: Number(row.price),
      total_quantity: Number(row.total_quantity),
      total_revenue: Number(row.total_revenue),
    }));
  }

  async getItemSalesByCustomer(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<CustomerSalesData[]> {
    const result = await this.pool.query<CustomerSalesData>(
      `SELECT
         d.customer_id,
         SUM(ABS(id.quantity)) as quantity,
         SUM(id.quantity * id.price) as revenue,
         COUNT(DISTINCT id.doc_id) as order_count
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id = $2
         AND d.issue_date BETWEEN $3 AND $4
       GROUP BY d.customer_id
       ORDER BY revenue DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map(row => ({
      customer_id: row.customer_id,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
      order_count: Number(row.order_count),
    }));
  }

  async getItemSalesByMonth(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<{ month: string; quantity: number; revenue: number }[]> {
    const result = await this.pool.query<{ month: string; quantity: number; revenue: number }>(
      `SELECT
         to_char(d.issue_date::date, 'YYYY-MM') as month,
         SUM(ABS(id.quantity)) as quantity,
         SUM(id.quantity * id.price) as revenue
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id = $2
         AND d.issue_date BETWEEN $3 AND $4
       GROUP BY month
       ORDER BY month ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map(row => ({
      month: row.month,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
    }));
  }

  async getItemOrderPatterns(
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
    const result = await this.pool.query<{
      doc_id: string;
      quantity: number;
      price: number;
      issue_date: string;
      customer_id: string;
      context_id: number;
      doc_number: number;
    }>(
      `SELECT
         id.doc_id,
         id.quantity,
         id.price,
         d.issue_date,
         d.customer_id,
         d.context_id,
         d.doc_number
       FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1
         AND d.context_id IN (4, 5)
         AND d.issue_date BETWEEN $2 AND $3
       ORDER BY d.issue_date DESC`,
      [itemId, startDate, endDate]
    );
    return result.rows.map(row => ({
      doc_id: row.doc_id,
      quantity: Number(row.quantity),
      price: Number(row.price),
      issue_date: row.issue_date,
      customer_id: row.customer_id,
      context_id: Number(row.context_id),
      doc_number: Number(row.doc_number),
    }));
  }

  // ============ Cache Metadata Operations ============

  async getCacheState(): Promise<CacheState | null> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM cache_meta WHERE key = 'state'`
    );
    if (result.rows.length === 0) return null;
    return JSON.parse(result.rows[0].value) as CacheState;
  }

  async setCacheState(state: CacheState): Promise<void> {
    await this.pool.query(
      `INSERT INTO cache_meta (key, value) VALUES ('state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(state)]
    );
  }

  async getDocumentCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM documents`
    );
    return Number(result.rows[0].count);
  }

  async getItemDocumentCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM item_documents`
    );
    return Number(result.rows[0].count);
  }

  /**
   * End all pool connections
   */
  async close(): Promise<void> {
    this.opened = false;
    await this.pool.end();
  }

  /**
   * Check if pool is open
   */
  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Truncate all cache tables (used by cache clear command for PostgreSQL)
   */
  async truncateAll(): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE item_documents, documents, cache_meta RESTART IDENTITY CASCADE`);
  }
}
