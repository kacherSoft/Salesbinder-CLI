import type { AxiosInstance } from 'axios';
import { V3CategoriesResource } from '../v3-categories.resource.js';

describe('V3CategoriesResource.list', () => {
  it('normalizes the v3 envelope and preserves category metadata', async () => {
    const categories = [
      {
        id: 'category-1',
        object: 'item_category',
        name: 'Widgets',
        parent_id: null,
        inventory_type: 'quantity',
        custom_fields: [
          {
            id: 'field-1',
            name: 'Colour',
            display_order: 1,
            display_on_inventory_list: true,
            publish_on_documents: false,
          },
        ],
      },
    ];
    const get = jest.fn().mockResolvedValue({
      data: {
        object: 'list',
        url: '/api/v3/item-categories',
        has_more: false,
        data: categories,
        pagination: { page: 2, per_page: 100, total_pages: 3, total_records: 201 },
      },
    });
    const resource = new V3CategoriesResource({ get } as unknown as AxiosInstance);

    const result = await resource.list({ page: 2, pageLimit: 100 });

    expect(get).toHaveBeenCalledWith('/item-categories', { params: { page: 2, limit: 100 } });
    expect(result).toMatchObject({ count: 201, page: 2, pages: 3 });
    expect(result.categories?.[0]).toMatchObject({
      inventory_type: 'quantity',
      custom_fields: [{ id: 'field-1', name: 'Colour' }],
    });
  });

  it('rejects a response without the exact v3 list envelope', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [], pagination: {} } });
    const resource = new V3CategoriesResource({ get } as unknown as AxiosInstance);

    await expect(resource.list()).rejects.toThrow('expected a list envelope');
  });
});
