/**
 * Items (Inventory) types for SalesBinder API
 */

import type { ListParams, ListResponse } from './common.types.js';

/** Item resource */
export interface Item {
  id: string;
  account_id?: string;
  item_number: number;
  name: string;
  description?: string;
  serial_number?: string;
  sku?: string;
  barcode?: string;
  multiple?: boolean;
  quantity: number;
  threshold: number;
  cost: number;
  price: number;
  published?: boolean;
  archived?: boolean;
  category_id?: string;
  category?: {
    id?: string;
    name?: string;
  };
  created: string;
  modified: string;
  location?: {
    id?: string;
    name?: string;
  } | null;
  item_variations?: ItemVariation[];
}

export interface ItemVariation {
  id: string;
  item_id: string;
  quantity?: number;
  item_variations_locations?: ItemVariationLocation[];
}

export interface ItemVariationLocation {
  id?: number | string;
  item_variation_id?: string;
  location_id?: string;
  quantity?: number;
  threshold?: number;
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
