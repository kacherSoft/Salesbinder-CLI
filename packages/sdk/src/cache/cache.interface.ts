/**
 * Cache service interface - abstracts SQLite and PostgreSQL implementations
 */

import type {
  AccountRow,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemStockLocationRow,
  CacheState,
  CacheSyncStatus,
  ItemSalesByPeriodRow,
  PriceDistributionRow,
  CustomerSalesData,
} from './types.js';

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
  getDocumentByApiId(apiDocId: string): Promise<DocumentRow | undefined>;
  getDocumentByNumber(contextId: number, docNumber: number): Promise<DocumentRow | undefined>;
  getDocumentsByContext(contextId: number): Promise<DocumentRow[]>;
  getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]>;
  getDocumentCountByContext(contextId: number): Promise<number>;
  deleteDocument(docId: string): Promise<void>;
  batchInsertDocuments(docs: DocumentRow[]): Promise<void>;
  batchDeleteDocuments(docIds: string[]): Promise<void>;

  // ============ Item Document CRUD Operations ============

  insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void>;
  getItemDocuments(docId: string): Promise<ItemDocumentRow[]>;
  deleteItemDocuments(docId: string): Promise<void>;
  batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void>;

  // ============ Account CRUD Operations ============

  insertAccount(account: AccountRow): Promise<void>;
  getAccount(accountId: string): Promise<AccountRow | undefined>;
  getAccountByNumber(contextId: number, accountNumber: number): Promise<AccountRow | undefined>;
  getAccountsByName(contextId: number, name: string): Promise<AccountRow[]>;
  getAllAccounts(): Promise<AccountRow[]>;
  getAccountsModifiedSince(timestamp: number): Promise<AccountRow[]>;
  batchInsertAccounts(accounts: AccountRow[]): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;

  // ============ Item CRUD Operations ============

  insertItem(item: ItemRow): Promise<void>;
  getItem(itemId: string): Promise<ItemRow | undefined>;
  getAllItems(): Promise<ItemRow[]>;
  getItemsModifiedSince(timestamp: number): Promise<ItemRow[]>;
  batchInsertItems(items: ItemRow[]): Promise<void>;
  deleteItem(itemId: string): Promise<void>;

  // ============ Item Stock/Location Operations ============

  insertItemStockLocation(row: ItemStockLocationRow): Promise<void>;
  getItemStockLocations(itemId: string): Promise<ItemStockLocationRow[]>;
  getAllItemStockLocations(): Promise<ItemStockLocationRow[]>;
  replaceItemStockLocations(itemId: string, rows: ItemStockLocationRow[]): Promise<void>;
  batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void>;
  deleteItemStockLocations(itemId: string): Promise<void>;

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
  getSyncStatus(): Promise<CacheSyncStatus | null>;
  setSyncStatus(status: CacheSyncStatus): Promise<void>;
  getDocumentCount(): Promise<number>;
  getItemDocumentCount(): Promise<number>;
  getAccountCount(contextId?: number): Promise<number>;
  getItemCount(): Promise<number>;
  getStockLocationCount(): Promise<number>;
  clearAll(): Promise<void>;

  // ============ Connection Management ============

  close(): Promise<void>;
  isOpen(): boolean;
}
