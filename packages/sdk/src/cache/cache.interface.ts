/**
 * Cache service interface - abstracts SQLite and PostgreSQL implementations
 */

import type {
  AccountRow,
  CacheAccountBinding,
  CategoryCacheMeta,
  CategoryCacheRow,
  CategorySnapshot,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemStockLocationRow,
  InventoryCacheMeta,
  InventorySnapshot,
  CacheState,
  CacheSyncStatus,
  ItemSalesByPeriodRow,
  PriceDistributionRow,
  CustomerSalesData,
} from './types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from './payment-sync.types.js';

/** Complete PostgreSQL snapshot used to replace the local SQLite read mirror. */
export interface SQLiteMirrorSnapshot {
  accounts: AccountRow[];
  /** Null means the source category cache is not authoritative. */
  categorySnapshot: CategorySnapshot | null;
  /** Null means the source inventory snapshot is not authoritative. */
  inventoryCacheMeta?: InventoryCacheMeta | null;
  items: ItemRow[];
  itemStockLocations: ItemStockLocationRow[];
  documents: DocumentRow[];
  itemDocuments: Omit<ItemDocumentRow, 'id'>[];
  paymentTransactions: PaymentTransactionRow[];
  cacheState: CacheState | null;
  paymentSyncStatus: PaymentSyncStatus | null;
  pulledAt: number;
}

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

  // ============ Payment Transaction Operations ============

  getPaymentTransactions(docId: string): Promise<PaymentTransactionRow[]>;
  getAllPaymentTransactions(): Promise<PaymentTransactionRow[]>;
  replacePaymentTransactions(docId: string, transactions: PaymentTransactionRow[]): Promise<void>;
  batchInsertPaymentTransactions(transactions: PaymentTransactionRow[]): Promise<void>;

  // ============ Account CRUD Operations ============

  insertAccount(account: AccountRow): Promise<void>;
  getAccount(accountId: string): Promise<AccountRow | undefined>;
  getAccountByNumber(contextId: number, accountNumber: number): Promise<AccountRow | undefined>;
  getAccountsByName(contextId: number, name: string): Promise<AccountRow[]>;
  getAllAccounts(): Promise<AccountRow[]>;
  getAccountsModifiedSince(timestamp: number): Promise<AccountRow[]>;
  batchInsertAccounts(accounts: AccountRow[]): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;

  // ============ Category Snapshot Operations ============

  /** Atomically replace categories, complete metadata, marker, and derived names. */
  replaceCategorySnapshot(snapshot: CategorySnapshot): Promise<void>;
  /** Return only an authoritative snapshot; fail closed with null on any authority mismatch. */
  getCategorySnapshot(): Promise<CategorySnapshot | null>;
  /** Return only authoritative typed metadata. */
  getCategoryCacheMeta(): Promise<CategoryCacheMeta | null>;
  getCategory(categoryId: string): Promise<CategoryCacheRow | undefined>;
  getAllCategories(): Promise<CategoryCacheRow[]>;
  getCategoryCount(): Promise<number>;

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
  /** Atomically publish a complete validated v3 item and stock snapshot. */
  replaceInventorySnapshot(snapshot: InventorySnapshot): Promise<void>;
  /** Return authoritative v3 inventory metadata, or null when unavailable. */
  getInventoryCacheMeta(): Promise<InventoryCacheMeta | null>;

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
  getPaymentSyncStatus(): Promise<PaymentSyncStatus | null>;
  setPaymentSyncStatus(status: PaymentSyncStatus): Promise<void>;
  getDocumentCount(): Promise<number>;
  getItemDocumentCount(): Promise<number>;
  getPaymentTransactionCount(): Promise<number>;
  getAccountCount(contextId?: number): Promise<number>;
  getItemCount(): Promise<number>;
  getStockLocationCount(): Promise<number>;
  clearAll(): Promise<void>;

  // ============ Writer Coordination ============

  tryAcquireSyncLock(lockKey: string): Promise<boolean>;
  releaseSyncLock(lockKey: string): Promise<void>;
  /** Bind or verify a cache database against one stable SalesBinder account identity. */
  ensureAccountBinding(binding: CacheAccountBinding): Promise<void>;
  /** Verify an existing binding without claiming an unbound database. */
  verifyAccountBinding(binding: CacheAccountBinding): Promise<void>;

  // ============ Connection Management ============

  close(): Promise<void>;
  isOpen(): boolean;
}
