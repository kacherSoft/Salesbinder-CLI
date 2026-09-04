/** Read-only SalesBinder API v3 inventory resources used by cache snapshots. */

import type { AxiosInstance } from 'axios';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
import { ApiResponseValidationError } from './api-response-validation.error.js';

export interface V3ItemListParams {
  page?: number;
  limit?: number;
  archived?: boolean | 'all';
  ids?: readonly string[];
}

export interface V3ItemGetManyResult {
  items: V3Item[];
  omittedIds: string[];
}

export interface V3VariationListParams {
  page?: number;
  limit?: number;
  include?: 'locations';
}

export class V3ItemsResource {
  constructor(private readonly client: AxiosInstance) {}

  async list(params?: V3ItemListParams): Promise<V3ListResponse<V3Item>> {
    const response = await this.client.get<unknown>('/items', {
      params: params?.ids == null ? params : { ...params, ids: params.ids.join(',') },
    });
    return validateV3ListResponse<V3Item>(response.data, 'items');
  }

  async getMany(ids: readonly string[]): Promise<V3ItemGetManyResult> {
    validateExactItemIds(ids);

    const response = await this.list({ page: 1, limit: ids.length, ids, archived: 'all' });
    if (
      response.has_more ||
      response.pagination.page !== 1 ||
      response.pagination.per_page !== ids.length ||
      response.pagination.total_pages > 1 ||
      response.pagination.total_records !== response.data.length
    ) {
      throw new ApiResponseValidationError(
        'Invalid API v3 response for exact item lookup: expected one complete result page'
      );
    }
    const requestedIds = new Set(ids);
    const returnedItems = new Map<string, V3Item>();

    for (const value of response.data as unknown[]) {
      if (!isRecord(value) || value.object !== 'item') {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact item lookup: expected item objects'
        );
      }
      if (!isCanonicalUuid(value.id)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact item lookup: expected canonical item identities',
          'identity'
        );
      }
      if (!requestedIds.has(value.id)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact item lookup: returned an unexpected item identity',
          'identity'
        );
      }
      if (returnedItems.has(value.id)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact item lookup: returned a duplicate item identity',
          'identity'
        );
      }
      returnedItems.set(value.id, value as unknown as V3Item);
    }

    return {
      items: ids.flatMap((id) => {
        const item = returnedItems.get(id);
        return item == null ? [] : [item];
      }),
      omittedIds: ids.filter((id) => !returnedItems.has(id)),
    };
  }

  async get(id: string): Promise<V3Item> {
    const response = await this.client.get<unknown>(`/items/${encodeURIComponent(id)}`);
    const item = response.data;
    if (!isRecord(item) || item.object !== 'item') {
      throw new ApiResponseValidationError(
        `Invalid API v3 response for item ${id}: expected an item object`
      );
    }
    if (typeof item.id !== 'string') {
      throw new ApiResponseValidationError(
        `Invalid API v3 response for item ${id}: expected an item identity`,
        'identity'
      );
    }
    return item as unknown as V3Item;
  }

  async listVariations(
    id: string,
    params?: V3VariationListParams
  ): Promise<V3ListResponse<V3ItemVariation>> {
    const response = await this.client.get<unknown>(`/items/${encodeURIComponent(id)}/variations`, {
      params,
    });
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
    throw new ApiResponseValidationError(
      `Invalid API v3 response for ${resource}: expected a list envelope`
    );
  }

  const { page, per_page, total_pages, total_records } = value.pagination;
  if (
    !isPositiveInteger(page) ||
    !isPositiveInteger(per_page) ||
    !isNonNegativeInteger(total_pages) ||
    !isNonNegativeInteger(total_records)
  ) {
    throw new ApiResponseValidationError(
      `Invalid API v3 response for ${resource}: expected numeric pagination`
    );
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

function validateExactItemIds(ids: readonly string[]): void {
  if (ids.length < 1 || ids.length > 50) {
    throw new RangeError('Exact item lookup requires between 1 and 50 IDs');
  }

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new TypeError('Exact item lookup requires unique IDs');
  }
  if (!ids.every(isCanonicalUuid)) {
    throw new TypeError('Exact item lookup requires canonical UUIDs');
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
