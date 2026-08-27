import type { AxiosInstance } from 'axios';
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
});

function createResource(get: jest.Mock): V3ItemsResource {
  return new V3ItemsResource({ get } as unknown as AxiosInstance);
}

function listEnvelope(data: unknown[], url: string) {
  return {
    object: 'list',
    url,
    has_more: false,
    data,
    pagination: { page: 1, per_page: 100, total_pages: 1, total_records: data.length },
  };
}
