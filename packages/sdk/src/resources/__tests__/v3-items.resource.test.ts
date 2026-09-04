import type { AxiosInstance } from 'axios';
import { ApiResponseValidationError } from '../api-response-validation.error.js';
import { V3ItemsResource } from '../v3-items.resource.js';

const item = {
  id: 'item-1',
  object: 'item',
  item_number: 1,
  name: 'Widget',
  description: null,
  sku: null,
  barcode: null,
  serial_number: null,
  inventory_type: 'quantity',
  category_id: 'category-1',
  category_name: 'Widgets',
  status_id: 12,
  location_id: null,
  price: '10.00',
  quantity: 7,
  quantity_reserved: 2,
  quantity_incoming: 3,
  threshold: 1,
  variation_count: 1,
  published: true,
  archived: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('V3ItemsResource', () => {
  it('lists active and archived items and preserves v3 inventory fields', async () => {
    const get = jest.fn().mockResolvedValue({ data: listEnvelope([item], '/api/v3/items') });
    const resource = createResource(get);

    const result = await resource.list({ page: 2, limit: 100, archived: 'all' });

    expect(get).toHaveBeenCalledWith('/items', {
      params: { page: 2, limit: 100, archived: 'all' },
    });
    expect(result.data[0]).toMatchObject({
      archived: true,
      category_name: 'Widgets',
      quantity_reserved: 2,
      quantity_incoming: 3,
    });
    expect(result.pagination).toEqual({ page: 1, per_page: 100, total_pages: 1, total_records: 1 });
  });

  it('gets the direct v3 item object without a suffix', async () => {
    const get = jest.fn().mockResolvedValue({ data: item });
    const resource = createResource(get);

    await expect(resource.get(item.id)).resolves.toMatchObject({ id: item.id, archived: true });
    expect(get).toHaveBeenCalledWith('/items/item-1');
  });

  it.each([1, 21, 50])(
    'serializes %i exact item IDs in one explicitly bounded archived v3 request',
    async (count) => {
      const ids = Array.from({ length: count }, (_, index) => canonicalId(index + 1));
      const get = jest.fn().mockResolvedValue({
        data: listEnvelope(
          ids.map((id) => v3Item(id)),
          '/api/v3/items',
          { per_page: count }
        ),
      });
      const resource = createResource(get);

      const result = await resource.getMany(ids);

      expect(result.items.map(({ id }) => id)).toEqual(ids);
      expect(result.omittedIds).toEqual([]);
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('/items', {
        params: { page: 1, limit: count, ids: ids.join(','), archived: 'all' },
      });
    }
  );

  it('preserves caller order when the exact-ID response returns items in a different order', async () => {
    const ids = [canonicalId(1), canonicalId(2), canonicalId(3)];
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([v3Item(ids[2]), v3Item(ids[0]), v3Item(ids[1])], '/api/v3/items', {
        per_page: ids.length,
      }),
    });
    const resource = createResource(get);

    const result = await resource.getMany(ids);

    expect(result.items.map(({ id }) => id)).toEqual(ids);
    expect(result.omittedIds).toEqual([]);
  });

  it('reports omitted exact IDs without issuing a fallback lookup', async () => {
    const ids = [canonicalId(1), canonicalId(2), canonicalId(3)];
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([v3Item(ids[1])], '/api/v3/items', { per_page: ids.length }),
    });
    const resource = createResource(get);

    const result = await resource.getMany(ids);

    expect(result.items.map(({ id }) => id)).toEqual([ids[1]]);
    expect(result.omittedIds).toEqual([ids[0], ids[2]]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/items', {
      params: { page: 1, limit: ids.length, ids: ids.join(','), archived: 'all' },
    });
  });

  it('passes through archived exact-ID results', async () => {
    const id = canonicalId(1);
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([v3Item(id, { archived: true })], '/api/v3/items', { per_page: 1 }),
    });
    const resource = createResource(get);

    await expect(resource.getMany([id])).resolves.toMatchObject({
      items: [{ id, archived: true }],
      omittedIds: [],
    });
  });

  it.each([
    { label: 'empty', ids: [] },
    { label: '51 IDs', ids: Array.from({ length: 51 }, (_, index) => canonicalId(index + 1)) },
  ])('rejects $label exact-ID requests before making an HTTP request', async ({ ids }) => {
    const get = jest.fn();
    const resource = createResource(get);

    await expect(resource.getMany(ids)).rejects.toThrow(RangeError);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'duplicate IDs', ids: [canonicalId(1), canonicalId(1)] },
    { label: 'noncanonical UUIDs', ids: ['00000000-0000-4000-8000-00000000000A'] },
  ])('rejects $label before making an HTTP request', async ({ ids }) => {
    const get = jest.fn();
    const resource = createResource(get);

    await expect(resource.getMany(ids)).rejects.toThrow(TypeError);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects unexpected exact-ID response identities', async () => {
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([v3Item(canonicalId(2))], '/api/v3/items', { per_page: 1 }),
    });
    const resource = createResource(get);

    await expect(resource.getMany([canonicalId(1)])).rejects.toThrow(ApiResponseValidationError);
  });

  it('rejects duplicate exact-ID response identities', async () => {
    const id = canonicalId(1);
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([v3Item(id), v3Item(id)], '/api/v3/items', {
        per_page: 1,
        total_records: 2,
      }),
    });
    const resource = createResource(get);

    await expect(resource.getMany([id])).rejects.toThrow(ApiResponseValidationError);
  });

  it.each([
    {
      label: 'malformed item object',
      data: [{ id: canonicalId(1), object: 'customer' }],
      message: 'expected item objects',
    },
    {
      label: 'malformed item identity',
      data: [v3Item('ITEM-1')],
      message: 'expected canonical item identities',
    },
  ])('rejects $label in exact-ID responses', async ({ data, message }) => {
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope(data, '/api/v3/items', { per_page: 1 }),
    });
    const resource = createResource(get);

    await expect(resource.getMany([canonicalId(1)])).rejects.toThrow(message);
  });

  it.each([
    { label: 'a continuation flag', pagination: {}, hasMore: true },
    { label: 'a later page', pagination: { page: 2 }, hasMore: false },
    { label: 'multiple pages', pagination: { total_pages: 2 }, hasMore: false },
    { label: 'a server page-size override', pagination: { per_page: 20 }, hasMore: false },
    { label: 'an inconsistent total', pagination: { total_records: 2 }, hasMore: false },
  ])('rejects an exact-ID response with $label', async ({ pagination, hasMore }) => {
    const ids = [canonicalId(1), canonicalId(2), canonicalId(3)];
    const response = listEnvelope([v3Item(ids[0])], '/api/v3/items', {
      per_page: ids.length,
      ...pagination,
    });
    const resource = createResource(
      jest.fn().mockResolvedValue({ data: { ...response, has_more: hasMore } })
    );

    await expect(resource.getMany(ids)).rejects.toThrow('expected one complete result page');
  });

  it('lists variations with locations and preserves the location row id', async () => {
    const variation = {
      id: 'variation-1',
      object: 'item_variation',
      item_id: item.id,
      barcode: 'ABC',
      quantity: 5,
      quantity_reserved: 2,
      quantity_incoming: 4,
      in_transit: 3,
      location_count: 1,
      locations: [
        {
          object: 'item_variation_location',
          item_variation_location_id: 42,
          location_id: 'location-1',
          location_name: 'Main',
          quantity: 5,
          quantity_reserved: 2,
          quantity_incoming: 4,
          in_transit: 3,
          threshold: null,
        },
      ],
    };
    const get = jest.fn().mockResolvedValue({
      data: listEnvelope([variation], `/api/v3/items/${item.id}/variations`),
    });
    const resource = createResource(get);

    const result = await resource.listVariations(item.id, {
      page: 1,
      limit: 100,
      include: 'locations',
    });

    expect(get).toHaveBeenCalledWith('/items/item-1/variations', {
      params: { page: 1, limit: 100, include: 'locations' },
    });
    expect(result.data[0].locations?.[0].item_variation_location_id).toBe(42);
    expect(result.data[0]).toMatchObject({
      quantity_reserved: 2,
      quantity_incoming: 4,
      in_transit: 3,
    });
  });

  it('rejects a malformed pagination envelope', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { ...listEnvelope([], '/api/v3/items'), pagination: { page: '1' } },
    });
    const resource = createResource(get);

    await expect(resource.list()).rejects.toThrow('expected numeric pagination');
  });

  it('rejects zero for one-based page and page-size fields', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        ...listEnvelope([], '/api/v3/items'),
        pagination: { page: 0, per_page: 0, total_pages: 0, total_records: 0 },
      },
    });
    const resource = createResource(get);

    await expect(resource.list()).rejects.toThrow('expected numeric pagination');
  });

  it('uses a nominal validation error for malformed item detail responses', async () => {
    const resource = createResource(jest.fn().mockResolvedValue({ data: { object: 'item' } }));

    await expect(resource.get('item-1')).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('encodes item IDs used as URL path segments', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { ...item, id: 'item/with?reserved' } })
      .mockResolvedValueOnce({ data: listEnvelope([], '/api/v3/items/id/variations') });
    const resource = createResource(get);

    await resource.get('item/with?reserved');
    await resource.listVariations('item/with?reserved');

    expect(get).toHaveBeenNthCalledWith(1, '/items/item%2Fwith%3Freserved');
    expect(get).toHaveBeenNthCalledWith(2, '/items/item%2Fwith%3Freserved/variations', {
      params: undefined,
    });
  });
});

function createResource(get: jest.Mock): V3ItemsResource {
  return new V3ItemsResource({ get } as unknown as AxiosInstance);
}

function listEnvelope(
  data: unknown[],
  url: string,
  pagination: Partial<{
    page: number;
    per_page: number;
    total_pages: number;
    total_records: number;
  }> = {}
) {
  return {
    object: 'list',
    url,
    has_more: false,
    data,
    pagination: {
      page: 1,
      per_page: 100,
      total_pages: 1,
      total_records: data.length,
      ...pagination,
    },
  };
}

function canonicalId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function v3Item(id: string, overrides: Partial<typeof item> = {}) {
  return { ...item, id, ...overrides };
}
