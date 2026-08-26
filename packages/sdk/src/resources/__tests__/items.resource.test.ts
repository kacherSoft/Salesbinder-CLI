import type { AxiosInstance } from 'axios';
import { ItemsResource } from '../items.resource.js';
import type { Item } from '../../types/items.types.js';

const item: Item = {
  id: 'item-1',
  item_number: 1,
  name: 'Test item',
  quantity: 10,
  threshold: 2,
  cost: 5,
  price: 8,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-02T00:00:00Z',
};

describe('ItemsResource.get', () => {
  let timeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  it('accepts a wrapped item body', async () => {
    const get = jest.fn().mockResolvedValue({ data: { item } });
    const resource = createResource(get);

    await expect(resource.get(item.id)).resolves.toEqual(item);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare item body', async () => {
    const get = jest.fn().mockResolvedValue({ data: item });
    const resource = createResource(get);

    await expect(resource.get(item.id)).resolves.toEqual(item);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('retries a malformed successful body and recovers', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { item: null } })
      .mockResolvedValueOnce({ data: { item } });
    const resource = createResource(get);

    await expect(resource.get(item.id)).resolves.toEqual(item);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error after three malformed successful bodies', async () => {
    const get = jest.fn().mockResolvedValue({ data: {} });
    const resource = createResource(get);

    await expect(resource.get(item.id)).rejects.toThrow(
      'Invalid API response for item item-1: expected a wrapped or bare item with a string id after 3 attempts'
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('does not retry rejected requests', async () => {
    const requestError = new Error('HTTP 404');
    const get = jest.fn().mockRejectedValue(requestError);
    const resource = createResource(get);

    await expect(resource.get(item.id)).rejects.toBe(requestError);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

function createResource(get: jest.Mock): ItemsResource {
  return new ItemsResource({ get } as unknown as AxiosInstance);
}
