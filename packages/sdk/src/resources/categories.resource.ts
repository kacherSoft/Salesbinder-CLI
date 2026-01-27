/**
 * Categories resource for SalesBinder API
 */

import type { AxiosInstance } from 'axios';
import type {
  Category,
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryListParams,
  CategoryListResponse,
} from '../types/categories.types.js';

/**
 * Categories resource class
 */
export class CategoriesResource {
  constructor(private client: AxiosInstance) {}

  /**
   * List categories with optional filtering
   */
  async list(params?: CategoryListParams): Promise<CategoryListResponse> {
    const response = await this.client.get<CategoryListResponse>('/categories.json', { params });
    return response.data;
  }

  /**
   * Get single category by ID
   */
  async get(id: string): Promise<Category> {
    const response = await this.client.get<{ category: Category }>(`/categories/${id}.json`);
    return response.data.category;
  }

  /**
   * Create new category
   */
  async create(data: CreateCategoryDto): Promise<Category> {
    const response = await this.client.post<{ category: Category }>('/categories.json', { category: data });
    return response.data.category;
  }

  /**
   * Update existing category
   */
  async update(id: string, data: UpdateCategoryDto): Promise<Category> {
    const response = await this.client.put<{ category: Category }>(`/categories/${id}.json`, { category: data });
    return response.data.category;
  }

  /**
   * Delete category
   */
  async delete(id: string): Promise<void> {
    await this.client.delete(`/categories/${id}.json`);
  }
}
