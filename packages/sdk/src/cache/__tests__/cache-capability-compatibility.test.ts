import type { SalesBinderClient } from '../../resources/index.js';
import type { CacheService } from '../cache.interface.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import {
  V3InventoryIndexerService,
  type V3InventoryClient,
} from '../v3-inventory-indexer.service.js';

describe('cache capability compatibility', () => {
  it('keeps legacy cache contracts structurally assignable', () => {
    const legacyCapabilities: Pick<CacheService, 'replaceDocumentBundle' | 'getInventorySnapshot'> =
      {};

    expect(legacyCapabilities).toEqual({});
  });

  it('fails document sync before upstream calls or cache writes without atomic bundle support', async () => {
    const list = jest.fn();
    const get = jest.fn();
    const getCacheState = jest.fn();
    const setCacheState = jest.fn();
    const cache = { getCacheState, setCacheState } as unknown as CacheService;
    const client = { documents: { list, get } } as unknown as SalesBinderClient;

    await expect(new DocumentIndexerService(client, cache, 'test').sync()).rejects.toThrow(
      'Document sync requires atomic document bundle support.'
    );
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(getCacheState).not.toHaveBeenCalled();
    expect(setCacheState).not.toHaveBeenCalled();
  });

  it('fails inventory sync before upstream calls or cache writes without snapshot reads', async () => {
    const list = jest.fn();
    const get = jest.fn();
    const listVariations = jest.fn();
    const getCacheState = jest.fn();
    const replaceInventorySnapshot = jest.fn();
    const setCacheState = jest.fn();
    const cache = {
      getCacheState,
      replaceInventorySnapshot,
      setCacheState,
    } as unknown as CacheService;
    const client = { items: { list, get, listVariations } } as unknown as V3InventoryClient;

    await expect(
      new V3InventoryIndexerService(client, cache, 'test', 'salesbinder:test').sync()
    ).rejects.toThrow('V3 inventory sync requires inventory snapshot read support.');
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(listVariations).not.toHaveBeenCalled();
    expect(getCacheState).not.toHaveBeenCalled();
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
    expect(setCacheState).not.toHaveBeenCalled();
  });
});
