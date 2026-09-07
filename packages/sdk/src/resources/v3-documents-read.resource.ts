import type { AxiosInstance } from 'axios';
import { ApiResponseValidationError } from './api-response-validation.error.js';
import { validateV3ListResponse } from './v3-items.resource.js';

export interface V3DocumentGetManyResult {
  records: Record<string, unknown>[];
  omittedIds: string[];
}

/** Exact-ID reads only; the supplied v3 client owns authentication and pacing. */
export class V3DocumentsReadResource {
  constructor(private readonly client: AxiosInstance) {}

  async get(contextId: 4 | 5 | 11, id: string): Promise<unknown> {
    const route = routeFor(contextId);
    if (!route || !isCanonicalUuid(id)) {
      throw new TypeError('Document lookup requires a supported context and canonical UUID');
    }
    const response = await this.client.get<unknown>(`/${route}/${id}`);
    return response.data;
  }

  async getMany(contextId: 4 | 5 | 11, ids: readonly string[]): Promise<V3DocumentGetManyResult> {
    const route = routeFor(contextId);
    validateExactIds(route, ids);
    const response = await this.client.get<unknown>(`/${route}`, {
      params: { page: 1, limit: ids.length, ids: ids.join(',') },
    });
    const page = validateV3ListResponse<unknown>(response.data, `exact ${route}`);
    if (
      page.has_more ||
      page.pagination.page !== 1 ||
      page.pagination.per_page !== ids.length ||
      page.pagination.total_pages > 1 ||
      page.pagination.total_records !== page.data.length
    ) {
      throw new ApiResponseValidationError(
        'Invalid API v3 response for exact document lookup: expected one complete result page'
      );
    }

    const requestedIds = new Set(ids);
    const records = new Map<string, Record<string, unknown>>();
    for (const value of page.data) {
      if (!isDocumentRecord(value, contextId)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact document lookup: expected the requested document resource',
          'identity'
        );
      }
      if (!requestedIds.has(value.id)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact document lookup: returned an unexpected document identity',
          'identity'
        );
      }
      if (records.has(value.id)) {
        throw new ApiResponseValidationError(
          'Invalid API v3 response for exact document lookup: returned a duplicate document identity',
          'identity'
        );
      }
      records.set(value.id, value);
    }
    return {
      records: ids.flatMap((id) => {
        const record = records.get(id);
        return record == null ? [] : [record];
      }),
      omittedIds: ids.filter((id) => !records.has(id)),
    };
  }
}

function routeFor(contextId: number): string | undefined {
  return { 4: 'estimates', 5: 'invoices', 11: 'purchase-orders' }[contextId];
}

function isDocumentRecord(
  value: unknown,
  contextId: 4 | 5 | 11
): value is Record<string, unknown> & { id: string } {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.id) &&
    value.object === objectFor(contextId) &&
    (value.context_id === undefined || value.context_id === contextId)
  );
}

function objectFor(contextId: 4 | 5 | 11): 'estimate' | 'invoice' | 'purchase_order' {
  return ({ 4: 'estimate', 5: 'invoice', 11: 'purchase_order' } as const)[contextId];
}

function validateExactIds(
  route: string | undefined,
  ids: readonly string[]
): asserts ids is string[] {
  if (!route || ids.length < 1 || ids.length > 50) {
    throw new RangeError(
      'Exact document lookup requires a supported context and between 1 and 50 IDs'
    );
  }
  if (new Set(ids).size !== ids.length || !ids.every(isCanonicalUuid)) {
    throw new TypeError('Exact document lookup requires unique canonical UUIDs');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
