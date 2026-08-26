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
    // SalesBinder can occasionally return HTTP 200 with an incomplete body
    // for an item detail request. Treat that as a transient API response and
    // retry here instead of aborting the whole cache sync.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.client.get<{ item?: Item } | Item>(`/items/${id}.json`);
      const data = response?.data as { item?: Item } | Item | undefined;
      const item: Item | undefined = data && typeof data === 'object' && 'item' in data
        ? data.item
        : data as Item | undefined;
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        return item;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new Error(
        `Invalid API response for item ${id}: expected a wrapped or bare item with a string id after ${maxAttempts} attempts`
      );
    }
    throw new Error(`Invalid API response for item ${id}`);
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
