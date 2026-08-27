/**
 * Categories types for SalesBinder API
 */

import type { ListParams } from './common.types.js';

/** Category object */
export interface Category {
  id: string;
  name: string;
  item_count?: number;
  parent_id: string | null;
  inventory_type?: 'quantity' | 'unique';
  custom_fields?: CategoryCustomField[];
  created?: string;
  modified?: string;
}

export interface CategoryCustomField {
  id: string;
  name: string;
  display_order: number;
  display_on_inventory_list: boolean;
  publish_on_documents: boolean;
}

export interface V3Category extends Omit<Category, 'item_count' | 'created' | 'modified'> {
  object: 'item_category';
  inventory_type: 'quantity' | 'unique';
  custom_fields: CategoryCustomField[];
}

/** Create category DTO */
export interface CreateCategoryDto {
  name: string;
  parent_id?: string;
}

/** Update category DTO */
export interface UpdateCategoryDto extends Partial<Omit<CreateCategoryDto, 'parent_id'>> {
  parent_id?: string;
}

/** List parameters for categories */
export interface CategoryListParams extends ListParams {}

/** SalesBinder returns pagination metadata as integer strings or numbers. */
export type CategoryPaginationValue = string | number;

/** Raw list response before the resource normalizes nested category arrays. */
export interface CategoryListApiResponse {
  count?: CategoryPaginationValue;
  page?: CategoryPaginationValue;
  pages?: CategoryPaginationValue;
  categories?: Category[] | Category[][];
}

/** List response with one flat category array for the requested API page. */
export interface CategoryListResponse {
  count?: CategoryPaginationValue;
  page?: CategoryPaginationValue;
  pages?: CategoryPaginationValue;
  categories?: Category[];
}
