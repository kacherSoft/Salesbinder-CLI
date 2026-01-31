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
}

/** Database schema row for item_documents table */
export interface ItemDocumentRow {
  id?: number; // Auto-generated
  item_id: string;
  doc_id: string;
  quantity: number;
  price: number;
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
}

/** Options for cache sync operations */
export interface SyncOptions {
  full?: boolean; // Force full sync
  onProgress?: (current: number, total: number) => void; // Progress callback
}

/** Sync result interface */
export interface SyncResult {
  success: boolean;
  type: 'full' | 'delta';
  documentsProcessed: number;
  documentsDeleted?: number;
  lineItemsProcessed: number;
  duration: string;
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
