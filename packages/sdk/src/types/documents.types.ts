/**
 * Documents (Invoices/Estimates/POs) types for SalesBinder API
 */

import type { ListParams, ListResponse, DocumentContextId } from './common.types.js';

/** Document item (line item) */
export interface DocumentItem {
  id: string;
  document_id: string;
  item_id?: string;
  name?: string;
  description?: string;
  quantity: number;
  quantity_partially_received: number;
  tax: number;
  tax2: number;
  discount_percent: number;
  cost: number;
  price: number;
  discounted_price: number;
  weight: number;
  unit_id?: string | null;
  service_category_id?: string | null;
  item_variations_location_id?: number | null;
  item_variation_data?: string;
  created: string;
  modified: string;
}

/** Document status */
export interface DocumentStatus {
  id: number;
  name: string;
}

/** Document context */
export interface DocumentContext {
  id: DocumentContextId;
  name: string;
}

/** Document resource */
export interface Document {
  id: string;
  context_id: DocumentContextId;
  document_number: number;
  customer_id: string;
  user_id: string;
  name?: string;
  issue_date: string;
  expiry_date?: string | null;
  date_sent?: string | null;
  status_id: number;
  total_cost: number;
  total_tax: number;
  total_tax2: number;
  total_price: number;
  total_transactions: number;
  created: string;
  modified: string;
  status?: DocumentStatus;
  context?: DocumentContext;
  document_items?: DocumentItem[];
}

/** Create document item DTO */
export interface CreateDocumentItemDto {
  item_id: string;
  description?: string;
  quantity: number;
  price: number;
  cost?: number;
  tax?: number;
  tax2?: number;
  weight?: number;
}

/** Create document DTO */
export interface CreateDocumentDto {
  context_id: number;
  customer_id: string;
  issue_date: string; // YYYY-MM-DD format
  name?: string;
  shipping_address?: string;
  document_items: CreateDocumentItemDto[];
}

/** Update document DTO */
export interface UpdateDocumentDto extends Partial<Omit<CreateDocumentDto, 'document_items'>> {
  document_items?: CreateDocumentItemDto[];
}

/** List parameters for documents */
export interface DocumentListParams extends ListParams {
  contextId?: DocumentContextId;
  customerId?: string;
  accountNumber?: number;
  documentNumber?: number;
  field?: string;
  exact?: boolean;
}

/** List response for documents */
export interface DocumentListResponse extends ListResponse {
  documents?: Document[][];
}
