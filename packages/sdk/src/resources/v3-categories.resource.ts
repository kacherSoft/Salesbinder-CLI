/** Read-only SalesBinder API v3 item-category resource used by cache snapshots. */

import type { AxiosInstance } from 'axios';
import type { Category, CategoryListResponse, V3Category } from '../types/categories.types.js';
import { validateV3ListResponse } from './v3-items.resource.js';

export interface V3CategoryListParams {
  page?: number;
  pageLimit?: number;
}

export class V3CategoriesResource {
  constructor(private readonly client: AxiosInstance) {}

  async list(params?: V3CategoryListParams): Promise<CategoryListResponse> {
    const query = params && {
      page: params.page,
      limit: params.pageLimit,
    };
    const response = await this.client.get<unknown>('/item-categories', { params: query });
    const list = validateV3ListResponse<V3Category>(response.data, 'item categories');

    return {
      count: list.pagination.total_records,
      page: list.pagination.page,
      pages: list.pagination.total_pages,
      categories: list.data as unknown as Category[],
    };
  }
}
