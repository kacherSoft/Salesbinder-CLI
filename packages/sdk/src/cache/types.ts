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

// Re-export DocumentContextId from common types for convenience
export { DocumentContextId } from '../types/common.types.js';
