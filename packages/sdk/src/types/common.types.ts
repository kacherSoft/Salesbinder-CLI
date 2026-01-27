/**
 * Common types shared across all resources
 */

/** Account context IDs */
export enum ContextId {
  Customer = 2,
  Prospect = 8,
  Supplier = 10,
}

/** Document context IDs */
export enum DocumentContextId {
  Estimate = 4,
  Invoice = 5,
  PurchaseOrder = 11,
}

/** List response wrapper */
export interface ListResponse {
  count?: string;
  page?: string;
  pages?: string;
}

/** Pagination params */
export interface ListParams {
  page?: number;
  pageLimit?: number;
  modifiedSince?: number;
  s?: string;
  compact?: boolean;
}

/** API error response */
export interface ApiErrorResponse {
  message?: {
    errors?: Record<string, Record<string, string>>;
  };
}
