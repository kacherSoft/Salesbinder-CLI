/** Read-only SalesBinder API v3 inventory resources used by cache snapshots. */

import type { AxiosInstance } from 'axios';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';

export interface V3ItemListParams {
  page?: number;
  limit?: number;
  archived?: boolean | 'all';
}

export interface V3VariationListParams {
  page?: number;
  limit?: number;
  include?: 'locations';
}

export class V3ItemsResource {
  constructor(private readonly client: AxiosInstance) {}

  async list(params?: V3ItemListParams): Promise<V3ListResponse<V3Item>> {
    const response = await this.client.get<unknown>('/items', { params });
    return validateV3ListResponse<V3Item>(response.data, 'items');
  }

  async get(id: string): Promise<V3Item> {
    const response = await this.client.get<unknown>(`/items/${id}`);
    const item = response.data;
    if (!isRecord(item) || item.object !== 'item' || typeof item.id !== 'string') {
      throw new Error(`Invalid API v3 response for item ${id}: expected an item object`);
    }
    return item as unknown as V3Item;
  }

  async listVariations(
    id: string,
    params?: V3VariationListParams
  ): Promise<V3ListResponse<V3ItemVariation>> {
    const response = await this.client.get<unknown>(`/items/${id}/variations`, { params });
    return validateV3ListResponse<V3ItemVariation>(response.data, `variations for item ${id}`);
  }
}

/** Validate the standard v3 list envelope before snapshot code trusts pagination. */
export function validateV3ListResponse<T>(value: unknown, resource: string): V3ListResponse<T> {
  if (
    !isRecord(value) ||
    value.object !== 'list' ||
    typeof value.url !== 'string' ||
    typeof value.has_more !== 'boolean' ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination)
  ) {
    throw new Error(`Invalid API v3 response for ${resource}: expected a list envelope`);
  }

  const { page, per_page, total_pages, total_records } = value.pagination;
  if (
    !isPositiveInteger(page) ||
    !isPositiveInteger(per_page) ||
    !isNonNegativeInteger(total_pages) ||
    !isNonNegativeInteger(total_records)
  ) {
    throw new Error(`Invalid API v3 response for ${resource}: expected numeric pagination`);
  }

  return value as unknown as V3ListResponse<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
