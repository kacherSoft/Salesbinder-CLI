import { AxiosError } from 'axios';
import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';
import {
  V3ExactItemHydratorService,
  type V3ExactItemHydrationProgress,
  type V3ExactItemHydratorClient,
} from '../v3-exact-item-hydrator.service.js';

describe('V3ExactItemHydratorService', () => {
  it('hydrates 50+ IDs in batches and preserves caller order across found and missing results', async () => {
    const ids = Array.from({ length: 53 }, (_, index) => canonicalId(index + 1));
    const itemsById = new Map(
      ids
        .filter((id) => id !== ids[2])
        .map((id, index) => [
          id,
          v3Item({
            id,
            item_number: index + 1,
            archived: id === ids[1],
          }),
        ])
    );
    const getMany = jest.fn(async (batch: readonly string[]) => ({
      items: batch
        .flatMap((id) => {
          const item = itemsById.get(id);
          return item ? [item] : [];
        })
        .reverse(),
      omittedIds: batch.filter((id) => !itemsById.has(id)),
    }));
    const listVariations = jest.fn(async (_itemId: string) => page([]));
    const service = createService({ getMany, listVariations });

    const result = await service.hydrate(ids);

    expect(getMany.mock.calls.map(([batch]) => batch)).toEqual([ids.slice(0, 50), ids.slice(50)]);
    expect(result.map(({ id }) => id)).toEqual(ids);
    expect(result[0]).toMatchObject({ id: ids[0], status: 'found_current' });
    expect(result[1]).toMatchObject({ id: ids[1], status: 'found_archived' });
    expect(result[2]).toEqual({ id: ids[2], status: 'missing_unproven' });
    expect(listVariations).toHaveBeenCalledTimes(52);
  });

  it('fetches complete variation pagination with location expansion for every returned item', async () => {
    const first = v3Item({ id: canonicalId(1), item_number: 1, variation_count: 2 });
    const second = v3Item({ id: canonicalId(2), item_number: 2, variation_count: 1 });
    const getMany = jest.fn(async () => ({ items: [second, first], omittedIds: [] }));
    const listVariations = jest.fn(async (itemId: string, params) => {
      if (itemId === first.id && params.page === 1) {
        return page(
          [v3Variation({ id: canonicalId(101), item_id: first.id, locationRowId: 101 })],
          {
            page: 1,
            per_page: 1,
            total_pages: 2,
            total_records: 2,
          }
        );
      }
      if (itemId === first.id && params.page === 2) {
        return page(
          [v3Variation({ id: canonicalId(102), item_id: first.id, locationRowId: 102 })],
          {
            page: 2,
            per_page: 1,
            total_pages: 2,
            total_records: 2,
          }
        );
      }
      return page([v3Variation({ id: canonicalId(201), item_id: second.id })]);
    });
    const service = createService({ getMany, listVariations });

    const result = await service.hydrate([first.id, second.id]);

    expect(result).toEqual([
      expect.objectContaining({ id: first.id, status: 'found_current' }),
      expect.objectContaining({ id: second.id, status: 'found_current' }),
    ]);
    expect(listVariations.mock.calls).toEqual([
      [first.id, { page: 1, limit: 100, include: 'locations' }],
      [first.id, { page: 2, limit: 100, include: 'locations' }],
      [second.id, { page: 1, limit: 100, include: 'locations' }],
    ]);
  });

  it('hydrates variations once for each returned item and skips omitted IDs', async () => {
    const ids = [canonicalId(1), canonicalId(2), canonicalId(3), canonicalId(4)];
    const getMany = jest.fn(async () => ({
      items: [v3Item({ id: ids[2], item_number: 3 }), v3Item({ id: ids[0], item_number: 1 })],
      omittedIds: [ids[1], ids[3]],
    }));
    const listVariations = jest.fn(async (_itemId: string) => page([]));
    const service = createService({ getMany, listVariations });

    await expect(service.hydrate(ids)).resolves.toHaveLength(4);

    expect(listVariations.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[2]]);
  });

  it('isolates local item and variation validation failures from valid peers', async () => {
    const invalidRecord = v3Item({ id: canonicalId(1), item_number: 1, sku: 'BAD\0SKU' });
    const invalidVariations = v3Item({ id: canonicalId(2), item_number: 2, variation_count: 1 });
    const valid = v3Item({ id: canonicalId(3), item_number: 3 });
    const getMany = jest.fn(async () => ({
      items: [invalidRecord, invalidVariations, valid],
      omittedIds: [],
    }));
    const listVariations = jest.fn(async (itemId: string) =>
      itemId === invalidVariations.id
        ? page([
            v3Variation({
              id: canonicalId(202),
              item_id: invalidVariations.id,
              quantity: 10,
            }),
          ])
        : page([])
    );
    const service = createService({ getMany, listVariations });

    const result = await service.hydrate([invalidRecord.id, invalidVariations.id, valid.id]);

    expect(result).toEqual([
      {
        id: invalidRecord.id,
        status: 'local_failure',
        failure: { code: 'invalid_record', message: 'Item failed source validation' },
      },
      {
        id: invalidVariations.id,
        status: 'local_failure',
        failure: {
          code: 'invalid_variations',
          message: 'Item variations failed source validation',
        },
      },
      expect.objectContaining({ id: valid.id, status: 'found_current' }),
    ]);
    expect(listVariations.mock.calls.map(([id]) => id)).toEqual([
      invalidRecord.id,
      invalidVariations.id,
      valid.id,
    ]);
  });

  it('propagates systemic network errors from variation hydration', async () => {
    const item = v3Item({ id: canonicalId(1) });
    const networkError = new Error('socket closed');
    const service = createService({
      getMany: jest.fn(async () => ({ items: [item], omittedIds: [] })),
      listVariations: jest.fn(async () => {
        throw networkError;
      }),
    });

    await expect(service.hydrate([item.id])).rejects.toBe(networkError);
  });

  it('classifies 404 variation hydration errors as local not-found failures', async () => {
    const item = v3Item({ id: canonicalId(1) });
    const notFound = new AxiosError('not found', undefined, undefined, undefined, {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {} as never,
      data: {},
    });
    const service = createService({
      getMany: jest.fn(async () => ({ items: [item], omittedIds: [] })),
      listVariations: jest.fn(async () => {
        throw notFound;
      }),
    });

    await expect(service.hydrate([item.id])).resolves.toEqual([
      {
        id: item.id,
        status: 'local_failure',
        failure: { code: 'not_found', message: 'Item unavailable during refresh' },
      },
    ]);
  });

  it.each([
    {
      label: 'unexpected item identity',
      response: (id: string) => ({ items: [v3Item({ id: canonicalId(2) })], omittedIds: [id] }),
    },
    {
      label: 'duplicate item identity',
      response: (id: string) => ({
        items: [v3Item({ id }), v3Item({ id, item_number: 2 })],
        omittedIds: [],
      }),
    },
    {
      label: 'duplicate omitted identity',
      response: (id: string) => ({ items: [], omittedIds: [id, id] }),
    },
    {
      label: 'incomplete partition',
      response: () => ({ items: [], omittedIds: [] }),
    },
  ])('rejects exact response partition mismatch: $label', async ({ response }) => {
    const id = canonicalId(1);
    const listVariations = jest.fn(async (_itemId: string) => page([]));
    const service = createService({
      getMany: jest.fn(async () => response(id)),
      listVariations,
    });

    await expect(service.hydrate([id])).rejects.toBeInstanceOf(ApiResponseValidationError);
    expect(listVariations).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'duplicate IDs', ids: [canonicalId(1), canonicalId(1)] },
    { label: 'noncanonical IDs', ids: ['00000000-0000-4000-8000-00000000000A'] },
  ])('rejects $label before making an exact lookup request', async ({ ids }) => {
    const getMany = jest.fn();
    const listVariations = jest.fn();
    const service = createService({ getMany, listVariations });

    await expect(service.hydrate(ids)).rejects.toThrow(TypeError);
    expect(getMany).not.toHaveBeenCalled();
    expect(listVariations).not.toHaveBeenCalled();
  });

  it('returns an empty result without calling the API for empty input', async () => {
    const getMany = jest.fn();
    const listVariations = jest.fn();
    const onProgress = jest.fn();
    const service = createService({ getMany, listVariations });

    await expect(service.hydrate([], { onProgress })).resolves.toEqual([]);

    expect(getMany).not.toHaveBeenCalled();
    expect(listVariations).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('emits count-only progress without item identities', async () => {
    const ids = [canonicalId(1), canonicalId(2), canonicalId(3)];
    const progress: V3ExactItemHydrationProgress[] = [];
    const service = createService({
      getMany: jest.fn(async () => ({
        items: [
          v3Item({ id: ids[0], item_number: 1 }),
          v3Item({ id: ids[1], item_number: 2, archived: true }),
        ],
        omittedIds: [ids[2]],
      })),
      listVariations: jest.fn(async () => page([])),
    });

    await service.hydrate(ids, { onProgress: (event) => progress.push(event) });

    expect(progress).toEqual([
      {
        recordsProcessed: 1,
        recordsTotal: 3,
        foundCount: 1,
        missingCount: 0,
        failureCount: 0,
      },
      {
        recordsProcessed: 2,
        recordsTotal: 3,
        foundCount: 2,
        missingCount: 0,
        failureCount: 0,
      },
      {
        recordsProcessed: 3,
        recordsTotal: 3,
        foundCount: 2,
        missingCount: 1,
        failureCount: 0,
      },
    ]);
    expect(progress.flatMap((event) => Object.keys(event))).not.toContain('id');
    expect(JSON.stringify(progress)).not.toContain(ids[0]);
  });
});

function createService(overrides: {
  getMany?: jest.Mock;
  listVariations?: jest.Mock;
}): V3ExactItemHydratorService {
  const client: V3ExactItemHydratorClient = {
    items: {
      getMany: overrides.getMany ?? jest.fn(async () => ({ items: [], omittedIds: [] })),
      listVariations: overrides.listVariations ?? jest.fn(async () => page([])),
    },
  };
  return new V3ExactItemHydratorService(client);
}

function canonicalId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function page<T extends { id: string }>(
  data: T[],
  pagination: Partial<V3ListResponse<T>['pagination']> = {}
): V3ListResponse<T> {
  const pageNumber = pagination.page ?? 1;
  const perPage = pagination.per_page ?? 100;
  const totalRecords = pagination.total_records ?? data.length;
  const totalPages =
    pagination.total_pages ?? (totalRecords === 0 ? 1 : Math.ceil(totalRecords / perPage));
  return {
    object: 'list',
    url: '/api/v3/test',
    has_more: pageNumber < totalPages,
    data,
    pagination: {
      page: pageNumber,
      per_page: perPage,
      total_pages: totalPages,
      total_records: totalRecords,
    },
  };
}

function v3Item(overrides: Partial<V3Item> = {}): V3Item {
  return {
    id: canonicalId(1),
    object: 'item',
    item_number: 1,
    name: 'Widget',
    description: null,
    sku: null,
    barcode: null,
    serial_number: null,
    inventory_type: 'quantity',
    category_id: null,
    category_name: null,
    status_id: 12,
    location_id: null,
    price: '3.0000',
    cost: '2.0000',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    threshold: 1,
    variation_count: 0,
    published: true,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function v3Variation(
  overrides: Partial<V3ItemVariation> & { locationRowId?: number } = {}
): V3ItemVariation {
  const itemId = overrides.item_id ?? canonicalId(1);
  const { locationRowId, ...variationOverrides } = overrides;
  return {
    id: canonicalId(101),
    object: 'item_variation',
    item_id: itemId,
    barcode: 'W-1',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    in_transit: 2,
    location_count: 1,
    locations: [
      {
        object: 'item_variation_location',
        item_variation_location_id: locationRowId ?? (Number.parseInt(itemId.slice(-6), 16) || 42),
        location_id: canonicalId(301),
        location_name: 'Main',
        quantity: 12,
        quantity_reserved: 3,
        quantity_incoming: 5,
        in_transit: 2,
        threshold: 1,
      },
    ],
    ...variationOverrides,
  };
}
