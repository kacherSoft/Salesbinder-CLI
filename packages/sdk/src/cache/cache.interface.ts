/**
 * Cache service interface - abstracts SQLite and PostgreSQL implementations
 */

import type { DocumentRow, ItemDocumentRow, CacheState, ItemSalesByPeriodRow, PriceDistributionRow, CustomerSalesData } from './types.js';

/**
 * Unified cache service interface.
 * All methods return Promises so both SQLite (wrapped) and PostgreSQL (native async) share the same contract.
 */
export interface CacheService {
  /** Get the underlying database path or connection identifier */
  getDbPath(): string;

  // ============ Document CRUD Operations ============

  insertDocument(doc: DocumentRow): Promise<void>;
  getDocument(docId: string): Promise<DocumentRow | undefined>;
  getDocumentsByContext(contextId: number): Promise<DocumentRow[]>;
  getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]>;
  deleteDocument(docId: string): Promise<void>;
  batchInsertDocuments(docs: DocumentRow[]): Promise<void>;
  batchDeleteDocuments(docIds: string[]): Promise<void>;

  // ============ Item Document CRUD Operations ============

  insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void>;
  getItemDocuments(docId: string): Promise<ItemDocumentRow[]>;
  deleteItemDocuments(docId: string): Promise<void>;
  batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void>;

  // ============ Analytics Query Helpers ============

  getItemDocumentsForPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemDocumentRow[]>;

  getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined>;

  getItemSalesByPeriod(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<ItemSalesByPeriodRow[]>;

  getItemPriceDistribution(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<PriceDistributionRow[]>;

  getItemSalesByCustomer(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<CustomerSalesData[]>;

  getItemSalesByMonth(
    itemId: string,
    startDate: string,
    endDate: string,
    contextId: number
  ): Promise<{ month: string; quantity: number; revenue: number }[]>;

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
  }[]>;

  // ============ Cache Metadata Operations ============

  getCacheState(): Promise<CacheState | null>;
  setCacheState(state: CacheState): Promise<void>;
  getDocumentCount(): Promise<number>;
  getItemDocumentCount(): Promise<number>;

  // ============ Connection Management ============

  close(): Promise<void>;
  isOpen(): boolean;
}
