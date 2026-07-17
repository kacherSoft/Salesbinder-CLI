/**
 * Cache types for SQLite document caching
 */

/** Current cache schema and authoritative document snapshot contract. */
export const CACHE_SCHEMA_VERSION = 4;
/** State marker used until every required sync stage publishes the current contract. */
export const CACHE_PENDING_SCHEMA_VERSION = 0;
export const CACHE_WRITER_LOCK_KEY = 'salesbinder-cache-writer-v3';

/** Database schema row for documents table */
export interface DocumentRow {
  doc_id: string;
  context_id: number; // 4=Estimate, 5=Invoice, 11=PO
  doc_number: number;
  issue_date: string; // YYYY-MM-DD
  customer_id: string;
  modified: number; // Unix timestamp
  api_doc_id?: string | null;
  cache_source?: 'api' | 'csv';
  document_name?: string | null;
  custom_doc_number?: string | null;
  account_id?: string | null;
  account_context_id?: number | null;
  account_name?: string | null;
  account_number?: number | null;
  user_id?: string | null;
  salesperson_name?: string | null;
  customer_name?: string | null;
  customer_number?: number | null;
  supplier_name?: string | null;
  supplier_number?: number | null;
  status_id?: number | null;
  status_name?: string | null;
  total_price?: number | null;
  total_cost?: number | null;
  subtotal?: number | null;
  associated_document_id?: string | null;
  external_po_number?: string | null;
  shipping_location?: string | null;
  date_sent?: string | null;
  shipped_percent?: number | null;
  shipment_checked_at?: string | null;
  source_fetched_at?: number | null;
  snapshot_version?: number;
  snapshot_complete?: number;
  is_cancelled?: number;
  imported_at?: number | null;
}

/** Database schema row for item_documents table */
export interface ItemDocumentRow {
  id?: number; // Auto-generated
  item_id: string;
  doc_id: string;
  quantity: number;
  price: number;
  document_item_id?: string | null;
  item_name?: string | null;
  item_number?: number | null;
  item_sku?: string | null;
  item_location?: string | null;
  line_description?: string | null;
  quantity_received?: number | null;
  cost?: number | null;
  total_amount?: number | null;
  discounted_price?: number | null;
  discount_percent?: number | null;
  quantity_shipped?: number | null;
}

/** Source document line without an inventory item relationship. */
export interface DocumentNonItemLineRow {
  id?: number; // Auto-generated
  doc_id: string;
  document_item_id: string;
  line_type: 'non_item';
  name?: string | null;
  line_description?: string | null;
  service_category_id?: string | null;
  unit_id?: string | null;
  quantity: number;
  price: number;
  cost?: number | null;
  total_amount: number;
  discounted_price?: number | null;
  discount_percent?: number | null;
  net_amount: number;
  tax?: number | null;
  tax2?: number | null;
  weight?: number | null;
  source_created?: string | null;
  source_modified?: string | null;
  raw_classification?: string | null;
}

/** Complete authoritative replacement for one source document. */
export interface DocumentSnapshot {
  document: DocumentRow;
  itemLines: Omit<ItemDocumentRow, 'id'>[];
  nonItemLines: Omit<DocumentNonItemLineRow, 'id'>[];
  sourceFetchedAt: number; // Unix timestamp in seconds
}

/** Consistent PostgreSQL source image used to replace a SQLite mirror. */
export interface CacheMirrorSnapshot {
  accounts: AccountRow[];
  documents: DocumentRow[];
  itemDocuments: Omit<ItemDocumentRow, 'id'>[];
  documentNonItemLines: Omit<DocumentNonItemLineRow, 'id'>[];
  items: ItemRow[];
  stockLocations: ItemStockLocationRow[];
  state: CacheState | null;
  syncStatus: CacheSyncStatus | null;
}

/** Database schema row for SalesBinder accounts (customers/suppliers) */
export interface AccountRow {
  account_id: string;
  context_id: number; // 2=Customer, 8=Prospect, 10=Supplier
  account_number?: number | null;
  name: string;
  office_email?: string | null;
  office_phone?: string | null;
  office_fax?: string | null;
  url?: string | null;
  billing_address_1?: string | null;
  billing_address_2?: string | null;
  billing_city?: string | null;
  billing_region?: string | null;
  billing_postal_code?: string | null;
  billing_country?: string | null;
  shipping_address_1?: string | null;
  shipping_address_2?: string | null;
  shipping_city?: string | null;
  shipping_region?: string | null;
  shipping_postal_code?: string | null;
  shipping_country?: string | null;
  vat_number?: string | null;
  account_manager?: string | null;
  label_name?: string | null;
  archived?: number;
  last_invoiced?: string | null;
  created?: string | null;
  modified?: number | null;
  cache_source?: 'api' | 'csv';
  imported_at?: number | null;
}

/** Database schema row for cached item master data */
export interface ItemRow {
  item_id: string;
  item_number?: number | null;
  name: string;
  description?: string | null;
  sku?: string | null;
  serial_number?: string | null;
  barcode?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  quantity?: number | null;
  quantity_reserved?: number | null;
  quantity_available?: number | null;
  quantity_incoming?: number | null;
  in_transit?: number | null;
  threshold?: number | null;
  cost?: number | null;
  price?: number | null;
  valuation?: number | null;
  published?: number | null;
  created?: string | null;
  modified?: number | null;
  cache_source?: 'api' | 'csv';
  imported_at?: number | null;
}

/** Database schema row for item variation/location stock data */
export interface ItemStockLocationRow {
  stock_row_id: string;
  item_id: string;
  item_number?: number | null;
  variation_id?: string | null;
  variation_location_id?: string | null;
  location_id?: string | null;
  location_name?: string | null;
  category_name?: string | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  quantity_incoming: number;
  in_transit: number;
  price?: number | null;
  cost?: number | null;
  valuation?: number | null;
  barcode?: string | null;
  cache_source?: 'api' | 'csv';
  imported_at?: number | null;
}

/** Database schema row for cache_meta table */
export interface CacheMetaRow {
  key: string;
  value: string;
}

/** Persistent cursor for a resumable authoritative document sync. */
export interface DocumentSyncCheckpoint {
  accountName: string;
  syncType: 'full' | 'delta';
  phase: 'primary' | 'catch_up';
  startedAt: number;
  sourceModifiedSince: number;
  endWatermark?: number;
  nextContextIndex: number;
  nextPage: number;
  retryDocumentIds: string[];
  retryDocumentIdentities?: Record<string, { contextId: number; documentNumber: number }>;
}

/** Cache sync state metadata */
export interface CacheState {
  lastSync: number; // Unix timestamp
  lastFullSync: number; // Unix timestamp
  documentCount: number;
  itemDocumentCount: number;
  nonItemDocumentCount?: number;
  accountName: string;
  schemaVersion: number;
  accountCount?: number;
  customerCount?: number;
  supplierCount?: number;
  itemCount?: number;
  stockLocationCount?: number;
  lastDocumentSync?: number;
  lastFullDocumentSync?: number;
  lastAccountSync?: number;
  lastItemSync?: number;
  lastFullItemSync?: number;
  lastDeletedSync?: number;
  /** Document/line snapshot contract published after documents and deletions finish. */
  documentSnapshotVersion?: number;
  /** Durable marker that the whole-cache authoritative refresh has not completed. */
  fullSyncPending?: boolean;
  documentSyncCheckpoint?: DocumentSyncCheckpoint;
}

/** Shipment reconciliation may only carry across the same source document identity. */
export function isShipmentIdentityCompatible(
  existingApiDocumentId: string | null | undefined,
  incomingApiDocumentId: string | null | undefined
): boolean {
  return existingApiDocumentId == null || existingApiDocumentId === incomingApiDocumentId;
}

/**
 * Cache rows are not tenant-namespaced, so silently switching an owned cache
 * would leave rows that exist only in the previous account.
 */
export function assertCacheAccountCompatible(
  state: Pick<CacheState, 'accountName'> | null,
  requestedAccountName: string
): void {
  const cachedAccountName = state?.accountName?.trim();
  if (cachedAccountName && cachedAccountName !== requestedAccountName) {
    throw new Error(
      `Cache belongs to account "${cachedAccountName}". `
      + `Use a separate database/cache for "${requestedAccountName}" or explicitly clear `
      + 'the existing cache before switching accounts.'
    );
  }
}

type CacheOwnershipProbe = {
  getDocumentCount(): Promise<number>;
  getItemDocumentCount(): Promise<number>;
  getDocumentNonItemLineCount(): Promise<number>;
  getAccountCount(contextId?: number): Promise<number>;
  getItemCount(): Promise<number>;
  getStockLocationCount(): Promise<number>;
};

/** Reject unknown ownership when tenant-bearing rows exist without usable cache metadata. */
export async function assertCacheMutationCompatible(
  cache: CacheOwnershipProbe,
  state: Pick<CacheState, 'accountName'> | null,
  requestedAccountName: string
): Promise<void> {
  assertCacheAccountCompatible(state, requestedAccountName);
  if (state?.accountName?.trim()) return;

  const counts = await Promise.all([
    cache.getDocumentCount(),
    cache.getItemDocumentCount(),
    cache.getDocumentNonItemLineCount(),
    cache.getAccountCount(),
    cache.getItemCount(),
    cache.getStockLocationCount(),
  ]);
  if (counts.some((count) => count > 0)) {
    throw new Error(
      'Cache contains data with no account ownership metadata. '
      + `Use a separate database/cache for "${requestedAccountName}" or explicitly clear `
      + 'the existing cache before syncing.'
    );
  }
}

/** Writer sync status stored in cache_meta. */
export interface CacheSyncStatus {
  status: 'running' | 'success' | 'failed';
  runId: string;
  accountName: string;
  syncTarget: 'sqlite' | 'postgresql';
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  message?: string;
  syncType?: 'full' | 'delta';
  documentsProcessed?: number;
  lineItemsProcessed?: number;
  nonItemLinesProcessed?: number;
  failedDocuments?: number;
  retryDocumentIds?: string[];
  itemsProcessed?: number;
  stockRowsProcessed?: number;
  deletedRecordsProcessed?: number;
  error?: string;
}

/** Options for cache sync operations */
export interface SyncOptions {
  full?: boolean; // Force full sync
  onProgress?: (current: number, total: number) => void; // Progress callback
  preserveExistingEnrichment?: boolean; // Disable when pre-run cache identity is incompatible
}

/** Sync result interface */
export interface SyncResult {
  success: boolean;
  type: 'full' | 'delta';
  documentsProcessed: number;
  documentsDeleted?: number;
  lineItemsProcessed: number;
  nonItemLinesProcessed: number;
  failedDocuments: number;
  retryDocumentIds: string[];
  duration: string;
  accountsProcessed?: number;
  customersProcessed?: number;
  suppliersProcessed?: number;
  itemsProcessed?: number;
  stockRowsProcessed?: number;
  deletedRecordsProcessed?: number;
  syncLookbackSeconds?: number;
}

/** Sales analytics result for a single item */
export interface ItemSalesAnalytics {
  item_id: string;
  item_name?: string;
  current_stock: number;
  latest_oc_date?: string; // YYYY-MM-DD
  latest_po_date?: string; // YYYY-MM-DD
  sales_periods: {
    [months: string]: {
      sold: number;
      revenue: number;
    };
  };
  cache_freshness: {
    last_sync: string; // ISO 8601
    stale: boolean;
  };
}

/** Item sales grouped by period for analytics */
export interface ItemSalesByPeriodRow {
  issue_date: string;
  quantity: number;
  price: number;
}

/** Price distribution for analytics */
export interface PriceDistributionRow {
  price: number;
  total_quantity: number;
  total_revenue: number;
}

/** Customer sales data for analytics */
export interface CustomerSalesData {
  customer_id: string;
  customer_name?: string | null;
  quantity: number;
  revenue: number;
  order_count: number;
}

/** Order pattern row for cycle time and win rate analysis */
export interface OrderPatternRow {
  doc_id: string;
  quantity: number;
  price: number;
  issue_date: string;
  customer_id: string;
  context_id: number;
  doc_number: number;
}

// Re-export DocumentContextId from common types for convenience
export { DocumentContextId } from '../types/common.types.js';
