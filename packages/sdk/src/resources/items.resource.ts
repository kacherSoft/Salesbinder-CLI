/**
 * Items (Inventory) resource for SalesBinder API
 */

import type { AxiosInstance } from 'axios';
import type {
  Item,
  CreateItemDto,
  UpdateItemDto,
  ItemListParams,
  ItemListResponse,
} from '../types/items.types.js';

/**
 * Items resource class
 * Provides CRUD operations for inventory items
 */
export class ItemsResource {
  constructor(private client: AxiosInstance) {}

  /**
   * List items with optional filtering
   */
  async list(params?: ItemListParams): Promise<ItemListResponse> {
    const response = await this.client.get<ItemListResponse>('/items.json', { params });
    return response.data;
  }

  /**
   * Get single item by ID
   */
  async get(id: string): Promise<Item> {
    const response = await this.client.get<{ item: Item }>(`/items/${id}.json`);
    return response.data.item;
  }

  /**
   * Create new item
   */
  async create(data: CreateItemDto): Promise<Item> {
    const response = await this.client.post<{ item: Item }>('/items.json', { item: data });
    return response.data.item;
  }

  /**
   * Update existing item
   */
  async update(id: string, data: UpdateItemDto): Promise<Item> {
    const response = await this.client.put<{ item: Item }>(`/items/${id}.json`, { item: data });
    return response.data.item;
  }

  /**
   * Delete item
   */
  async delete(id: string): Promise<void> {
    await this.client.delete(`/items/${id}.json`);
  }
}
