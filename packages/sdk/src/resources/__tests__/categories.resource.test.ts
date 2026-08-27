import type { AxiosInstance } from 'axios';
import { CategoriesResource } from '../categories.resource.js';

describe('CategoriesResource.list', () => {
  it('flattens the SalesBinder nested category wrapper and preserves pagination metadata', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        count: '2', page: '1', pages: '1',
        categories: [[
          { id: 'a', name: 'A', item_count: 1, parent_id: null, created: '', modified: '' },
          { id: 'b', name: 'B', item_count: 1, parent_id: 'a', created: '', modified: '' },
        ]],
      },
    });
    const resource = new CategoriesResource({ get } as unknown as AxiosInstance);

    const result = await resource.list({ page: 1, pageLimit: 200 });

    expect(result).toMatchObject({ count: '2', page: '1', pages: '1' });
    expect(result.categories?.map((category) => category.id)).toEqual(['a', 'b']);
    expect(get).toHaveBeenCalledWith('/categories.json', { params: { page: 1, pageLimit: 200 } });
  });

  it('rejects a mixed nested category wrapper', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { count: '1', page: '1', pages: '1', categories: [[{ id: 'a' }], { id: 'b' }] },
    });
    const resource = new CategoriesResource({ get } as unknown as AxiosInstance);

    await expect(resource.list()).rejects.toThrow('mixed nested array shape');
  });
});
