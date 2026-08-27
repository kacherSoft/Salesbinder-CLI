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
  category_name?: string | null;
  quantity_reserved?: number | null;
  quantity_available?: number | null;
  quantity_incoming?: number | null;
  in_transit?: number | null;
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
  quantity_reserved?: number | null;
  quantity_incoming?: number | null;
  in_transit?: number | null;
  item_variations_locations?: ItemVariationLocation[];
}

export interface ItemVariationLocation {
  id?: number | string;
  item_variation_id?: string;
  location_id?: string;
  quantity?: number;
  quantity_reserved?: number | null;
  quantity_available?: number | null;
  quantity_incoming?: number | null;
  in_transit?: number | null;
  location_name?: string | null;
  threshold?: number;
}

/** Native API v3 inventory item wire contract used by the v3 cache adapter. */
export interface V3Item {
  id: string;
  object: 'item';
  item_number: number;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  serial_number: string | null;
  inventory_type: 'quantity' | 'unique';
  category_id: string | null;
  category_name: string | null;
  status_id: number;
  location_id: string | null;
  price: string | null;
  cost?: string | null;
  quantity: number;
  quantity_reserved: number;
  quantity_incoming: number;
  threshold: number;
  variation_count: number;
  published: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  location_inventory?: {
    location_id: string;
    quantity: number;
    quantity_reserved: number;
    quantity_available: number;
    quantity_incoming: number;
    threshold: number;
  };
}

export interface V3ItemVariationLocation {
  object: 'item_variation_location';
  item_variation_location_id: number;
  location_id: string;
  location_name: string | null;
  quantity: number;
  quantity_reserved: number;
  quantity_incoming: number;
  in_transit: number;
  threshold: number | null;
}

export interface V3ItemVariation {
  id: string;
  object: 'item_variation';
  item_id: string;
  barcode: string;
  quantity: number;
  quantity_reserved: number;
  quantity_incoming: number;
  in_transit: number;
  location_count: number;
  locations?: V3ItemVariationLocation[];
}

export interface V3ListResponse<T> {
  object: 'list';
  url: string;
  has_more: boolean;
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total_pages: number;
    total_records: number;
  };
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
