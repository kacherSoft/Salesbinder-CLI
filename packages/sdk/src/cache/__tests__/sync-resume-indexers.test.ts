import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { Item } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { ItemIndexerService } from '../item-indexer.service.js';
import { DocumentContextId } from '../types.js';

const document = (id: string): Document => ({
  id,
  context_id: DocumentContextId.Estimate,
  document_number: Number(id.slice(-1)),
  customer_id: 'customer-1',
  user_id: 'user-1',
  issue_date: '2026-01-01',
  status_id: 1,
  total_cost: 1,
  total_tax: 0,
  total_tax2: 0,
  total_price: 2,
  total_transactions: 0,
  created: '2026-01-01',
  modified: '2026-01-02',
  document_items: [{
    id: `line-${id}`,
    document_id: id,
    item_id: 'item-1',
    quantity: 1,
    quantity_partially_received: 0,
    tax: 0,
    tax2: 0,
    discount_percent: 0,
    cost: 1,
    price: 2,
    discounted_price: 2,
    weight: 0,
    created: '2026-01-01',
    modified: '2026-01-02',
  }],
});

const item = (id: string): Item => ({
  id,
  item_number: Number(id.slice(-1)),
  name: id,
  quantity: 5,
  threshold: 0,
  cost: 1,
  price: 2,
  created: '2026-01-01',
  modified: '2026-01-02',
  item_variations: [{
    id: `variation-${id}`,
    item_id: id,
    item_variations_locations: [{ id: 1, location_id: 'location-1', quantity: 5 }],
  }],
});

describe('full sync resume indexers', () => {
  it('stops on a failed document and resumes at that exact context/page/index', async () => {
    const failure = new Error('document write failed');
    let failSecond = true;
    const inserted: string[] = [];
    const checkpoints: Array<{ contextId: number; page: number; docIndex: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async (id: string) => {
        if (id === 'doc-2' && failSecond) throw failure;
        return undefined;
      }),
      getDocumentByNumber: jest.fn(async () => undefined),
      deleteItemDocuments: jest.fn(async () => undefined),
      insertDocument: jest.fn(async (row) => { inserted.push(row.doc_id); }),
      batchInsertItemDocuments: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 30),
      getItemDocumentCount: jest.fn(async () => 40),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const list = jest.fn(async ({ contextId, page }: { contextId: number; page: number }) => ({
      documents: contextId === DocumentContextId.Estimate && page === 1
        ? [[document('doc-1'), document('doc-2'), document('doc-3')]]
        : [],
    }));
    const client = { documents: { list, get: jest.fn() } } as unknown as SalesBinderClient;
    const service = new DocumentIndexerService(client, cache, 'test');
    const onDocumentCheckpoint = (position: typeof checkpoints[number]) => checkpoints.push(position);

    await expect(service.sync({ full: true, resume: { onDocumentCheckpoint } })).rejects.toBe(failure);
    expect(inserted).toEqual(['doc-1']);
    expect(checkpoints.at(-1)).toEqual({ contextId: DocumentContextId.Estimate, page: 1, docIndex: 1 });
    expect(cache.setCacheState).not.toHaveBeenCalled();

    failSecond = false;
    inserted.length = 0;
    await service.sync({
      full: true,
      resume: { documents: checkpoints.at(-1), onDocumentCheckpoint },
    });
    expect(inserted).toEqual(['doc-2', 'doc-3']);
    expect(cache.setCacheState).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentCount: 30, itemDocumentCount: 40 }),
    );

    failSecond = true;
    inserted.length = 0;
    await expect(service.sync({ full: true })).rejects.toBe(failure);
    expect(inserted).toEqual(['doc-1']);

    inserted.length = 0;
    (cache.getCacheState as jest.Mock).mockResolvedValue({
      lastSync: 100, lastFullSync: 100, documentCount: 30, itemDocumentCount: 40,
      accountName: 'test', schemaVersion: 5,
    });
    await expect(service.sync()).rejects.toBe(failure);
    expect(inserted).toEqual(['doc-1']);
  });

  it('does not write list fallback data when item detail retries are exhausted', async () => {
    const failure = new Error('item detail retries exhausted');
    let failSecond = true;
    const inserted: string[] = [];
    const replaced: string[] = [];
    const checkpoints: Array<{ page: number; itemIndex: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getCategorySnapshot: jest.fn(async () => null),
      insertItem: jest.fn(async (row) => { inserted.push(row.item_id); }),
      replaceItemStockLocations: jest.fn(async (id: string) => { replaced.push(id); }),
      getItemCount: jest.fn(async () => 3),
      getStockLocationCount: jest.fn(async () => 3),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const items = [item('item-1'), item('item-2'), item('item-3')];
    const get = jest.fn(async (id: string) => {
      if (id === 'item-2' && failSecond) throw failure;
      return items.find((candidate) => candidate.id === id)!;
    });
    const client = {
      items: { list: jest.fn(async () => ({ items, pages: 1 })), get },
    } as unknown as SalesBinderClient;
    const service = new ItemIndexerService(client, cache, 'test');
    const onItemCheckpoint = (position: typeof checkpoints[number]) => checkpoints.push(position);

    await expect(service.sync({ full: true, resume: { onItemCheckpoint } })).rejects.toBe(failure);
    expect(inserted).toEqual(['item-1']);
    expect(replaced).toEqual(['item-1']);
    expect(checkpoints.at(-1)).toEqual({ page: 1, itemIndex: 1 });
    expect(cache.setCacheState).not.toHaveBeenCalled();

    failSecond = false;
    inserted.length = 0;
    replaced.length = 0;
    await service.sync({
      full: true,
      resume: { ...checkpoints.at(-1), onItemCheckpoint },
    });
    expect(inserted).toEqual(['item-2', 'item-3']);
    expect(replaced).toEqual(['item-2', 'item-3']);
  });
});
