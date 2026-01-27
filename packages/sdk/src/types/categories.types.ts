/**
 * Categories types for SalesBinder API
 */

import type { ListParams, ListResponse } from './common.types.js';

/** Category object */
export interface Category {
  id: string;
  name: string;
  item_count: number;
  parent_id: string | null;
  created: string;
  modified: string;
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

/** List response for categories */
export interface CategoryListResponse extends ListResponse {
  categories?: Category[][];
}
