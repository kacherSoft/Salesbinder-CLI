/**
 * Cache types for SQLite document caching
 */

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
  quantity_shipped?: number | null;
  cost?: number | null;
  total_amount?: number | null;
  discounted_price?: number | null;
  discount_percent?: number | null;
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

/** Cache sync state metadata */
export interface CacheState {
  lastSync: number; // Unix timestamp
  lastFullSync: number; // Unix timestamp
  documentCount: number;
  itemDocumentCount: number;
  accountName: string;
  schemaVersion: number;
  accountCount?: number;
  customerCount?: number;
  supplierCount?: number;
  itemCount?: number;
  stockLocationCount?: number;
  lastAccountSync?: number;
  lastItemSync?: number;
  lastFullItemSync?: number;
  lastDeletedSync?: number;
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
  itemsProcessed?: number;
  stockRowsProcessed?: number;
  deletedRecordsProcessed?: number;
  error?: string;
}

/** Options for cache sync operations */
export interface SyncOptions {
  full?: boolean; // Force full sync
  onProgress?: (current: number, total: number) => void; // Progress callback
  resume?: {
    documents?: { contextId?: number; page?: number; docIndex?: number };
    onDocumentCheckpoint?: (checkpoint: { contextId: number; page: number; docIndex: number }) => void;
  };
}

/** Sync result interface */
export interface SyncResult {
  success: boolean;
  type: 'full' | 'delta';
  documentsProcessed: number;
  documentsDeleted?: number;
  lineItemsProcessed: number;
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
