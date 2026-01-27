/**
 * Items (Inventory) types for SalesBinder API
 */

import type { ListParams, ListResponse } from './common.types.js';

/** Item resource */
export interface Item {
  id: string;
  account_id: string;
  item_number: number;
  name: string;
  description?: string;
  serial_number?: string;
  sku?: string;
  multiple: boolean;
  quantity: number;
  threshold: number;
  cost: number;
  price: number;
  category_id?: string;
  created: string;
  modified: string;
}

/** Create item DTO */
export interface CreateItemDto {
  name: string;
  description?: string;
  serial_number?: string;
  sku?: string;
  multiple?: boolean;
  quantity?: number;
  threshold?: number;
  cost?: number;
  price?: number;
  category_id?: string;
}

/** Update item DTO (all fields optional) */
export interface UpdateItemDto extends Partial<CreateItemDto> {}

/** List parameters for items */
export interface ItemListParams extends ListParams {
  categoryId?: string;
}

/** List response for items */
export interface ItemListResponse extends ListResponse {
  items?: Item[];
}
