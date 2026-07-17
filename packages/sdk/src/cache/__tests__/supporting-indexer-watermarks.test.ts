import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SalesBinderClient } from '../../resources/index.js';
import { AccountIndexerService } from '../account-indexer.service.js';
import { DeletedLogSyncService } from '../deleted-log-sync.service.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { ItemIndexerService } from '../item-indexer.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import {
  CACHE_SCHEMA_VERSION,
  DocumentContextId,
  type CacheState,
} from '../types.js';

describe('supporting indexer watermarks', () => {
  let cache: SQLiteCacheService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `supporting-indexers-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cache = new SQLiteCacheService('test', dbPath, true);
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cache.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.maintenance-lock`, { force: true });
  });

  it('does not let a generic watermark hide a required account backfill', async () => {
    await cache.setCacheState(state({
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      lastSync: 9_000,
      lastAccountSync: 8_000,
    }));
    const list = jest.fn().mockResolvedValue({ customers: [], pages: 1 });
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await new AccountIndexerService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledTimes(2);
    for (const [params] of list.mock.calls) expect(params.modifiedSince).toBe(0);
    expect(await cache.getCacheState()).toMatchObject({
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      lastAccountSync: 2_000,
    });
  });

  it('loads deletion history when no API deletion watermark exists', async () => {
    await cache.setCacheState(state({ lastSync: 9_000, lastDeletedSync: undefined }));
    const list = jest.fn().mockResolvedValue({ deletedlog: [], pages: 1 });
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await new DeletedLogSyncService(client, cache, 'test', 100).sync();

    expect(list).toHaveBeenCalledTimes(6);
    for (const [params] of list.mock.calls) expect(params.deletedSince).toBe(0);
    expect(await cache.getCacheState()).toMatchObject({ lastDeletedSync: 2_000 });
  });

  it('replays all deletion history when the enclosing sync is full', async () => {
    await cache.insertDocument({
      doc_id: 'doc-old',
      api_doc_id: 'doc-old',
      context_id: DocumentContextId.Invoice,
      doc_number: 900,
      issue_date: '2026-07-01',
      customer_id: 'customer-1',
      modified: 100,
    });
    await cache.setCacheState(state({ lastDeletedSync: 1_000 }));
    const list = jest.fn(async (
      { contextId, deletedSince }: { contextId: number; deletedSince: number }
    ) => (
      contextId === DocumentContextId.Invoice && deletedSince === 0
        ? {
            deletedlog: [[{
              id: 1,
              context_id: DocumentContextId.Invoice,
              record_id: 'doc-old',
              created: '2026-07-01T00:00:00.000Z',
            }]],
            pages: 1,
          }
        : { deletedlog: [], pages: 1 }
    ));
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await new DeletedLogSyncService(client, cache, 'test', 100).sync(true);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      contextId: DocumentContextId.Invoice,
      deletedSince: 0,
    }));
    expect(await cache.getDocument('doc-old')).toBeUndefined();
  });

  it('does not delete a replacement document when an old API id is deleted', async () => {
    await cache.insertDocument({
      doc_id: 'old-api-id',
      api_doc_id: 'old-api-id',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-01',
      customer_id: 'customer-1',
      modified: 100,
    });
    await cache.replaceDocumentSnapshot({
      document: {
        doc_id: 'new-api-id',
        api_doc_id: 'new-api-id',
        context_id: DocumentContextId.Invoice,
        doc_number: 1001,
        issue_date: '2026-07-16',
        customer_id: 'customer-1',
        modified: 200,
      },
      itemLines: [{
        document_item_id: 'new-line-1',
        item_id: 'item-new',
        doc_id: 'new-api-id',
        quantity: 2,
        price: 50,
      }],
      nonItemLines: [],
      sourceFetchedAt: 200,
    });
    await cache.setCacheState(state({ lastDeletedSync: 100 }));
    const list = jest.fn(async ({ contextId }: { contextId: number }) => (
      contextId === DocumentContextId.Invoice
        ? {
            deletedlog: [[{
              id: 1,
              context_id: DocumentContextId.Invoice,
              record_id: 'old-api-id',
              created: '2026-07-17T00:00:00.000Z',
            }]],
            pages: 1,
          }
        : { deletedlog: [], pages: 1 }
    ));

    await new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test',
      100
    ).sync(true);

    expect(await cache.getDocument('old-api-id')).toMatchObject({
      api_doc_id: 'new-api-id',
      doc_number: 1001,
    });
    expect(await cache.getDocumentByApiId('new-api-id')).toBeDefined();
    expect(await cache.getItemDocuments('old-api-id')).toEqual([
      expect.objectContaining({ item_id: 'item-new', quantity: 2, price: 50 }),
    ]);
  });

  it('still deletes a legacy document whose internal id has no API identity', async () => {
    await cache.insertDocument({
      doc_id: 'legacy-id',
      api_doc_id: null,
      context_id: DocumentContextId.Invoice,
      doc_number: 1002,
      issue_date: '2026-07-01',
      customer_id: 'customer-1',
      modified: 100,
    });
    await cache.setCacheState(state({ lastDeletedSync: 100 }));
    const list = jest.fn(async ({ contextId }: { contextId: number }) => (
      contextId === DocumentContextId.Invoice
        ? {
            deletedlog: [[{
              id: 1,
              context_id: DocumentContextId.Invoice,
              record_id: 'legacy-id',
              created: '2026-07-17T00:00:00.000Z',
            }]],
            pages: 1,
          }
        : { deletedlog: [], pages: 1 }
    ));

    await new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test',
      100
    ).sync(true);

    expect(await cache.getDocument('legacy-id')).toBeUndefined();
  });

  it('removes confirmed document deletions from retry checkpoint identity maps', async () => {
    await cache.setCacheState(state({
      lastDocumentSync: 100,
      documentSyncCheckpoint: {
        accountName: 'test',
        syncType: 'delta',
        phase: 'primary',
        startedAt: 90,
        sourceModifiedSince: 80,
        nextContextIndex: 3,
        nextPage: 1,
        retryDocumentIds: ['doc-deleted', 'doc-retry'],
        retryDocumentIdentities: {
          'doc-deleted': { contextId: DocumentContextId.Invoice, documentNumber: 1001 },
          'doc-retry': { contextId: DocumentContextId.Invoice, documentNumber: 1002 },
        },
      },
    }));
    const list = jest.fn(async ({ contextId }: { contextId: number }) => (
      contextId === DocumentContextId.Invoice
        ? {
            deletedlog: [[{
              id: 1,
              context_id: DocumentContextId.Invoice,
              record_id: 'doc-deleted',
              created: '2026-07-16T00:00:00.000Z',
            }]],
            pages: 1,
          }
        : { deletedlog: [], pages: 1 }
    ));
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await new DeletedLogSyncService(client, cache, 'test', 100).sync();

    expect((await cache.getCacheState())?.documentSyncCheckpoint).toMatchObject({
      retryDocumentIds: ['doc-retry'],
      retryDocumentIdentities: {
        'doc-retry': { contextId: DocumentContextId.Invoice, documentNumber: 1002 },
      },
    });
  });

  it('removes a synthetic CSV row after its detail 404 is confirmed by the deleted log', async () => {
    await cache.insertDocument({
      doc_id: 'csv-invoice-1001',
      api_doc_id: null,
      cache_source: 'csv',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 100,
    });
    await cache.setCacheState(state({ lastDocumentSync: 100 }));
    const listed = deletionSourceDocument();
    const firstList = jest.fn(async ({ contextId, page }: { contextId: number; page: number }) => (
      contextId === DocumentContextId.Invoice && page === 1
        ? { documents: [[listed]] }
        : { documents: [] }
    ));
    const firstClient = {
      documents: {
        list: firstList,
        get: jest.fn().mockRejectedValue({ response: { status: 404 } }),
      },
    } as unknown as SalesBinderClient;
    const failed = await new DocumentIndexerService(
      firstClient,
      cache,
      'test',
      3600,
      604800,
      100_000
    ).sync();
    expect(failed).toMatchObject({
      success: false,
      retryDocumentIds: ['doc-1'],
    });

    const deletedList = jest.fn(async ({ contextId }: { contextId: number }) => (
      contextId === DocumentContextId.Invoice
        ? {
            deletedlog: [[{
              id: 1,
              context_id: DocumentContextId.Invoice,
              record_id: 'doc-1',
              created: '2026-07-16T00:00:00.000Z',
            }]],
            pages: 1,
          }
        : { deletedlog: [], pages: 1 }
    ));
    await new DeletedLogSyncService(
      { deletedLog: { list: deletedList } } as unknown as SalesBinderClient,
      cache,
      'test',
      100
    ).sync();

    expect(await cache.getDocument('csv-invoice-1001')).toBeUndefined();
    expect((await cache.getCacheState())?.documentSyncCheckpoint).toBeUndefined();

    const get = jest.fn();
    const recovered = await new DocumentIndexerService(
      {
        documents: {
          list: jest.fn().mockResolvedValue({ documents: [] }),
          get,
        },
      } as unknown as SalesBinderClient,
      cache,
      'test',
      3600,
      604800,
      100_000
    ).sync();

    expect(recovered).toMatchObject({ success: true, failedDocuments: 0 });
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves omitted account enrichment while applying explicit source clears', async () => {
    await cache.setCacheState(state({ lastAccountSync: 100 }));
    await cache.insertAccount({
      account_id: 'customer-1',
      context_id: 2,
      account_number: 1001,
      name: 'Cached Customer',
      office_email: 'old@example.com',
      office_phone: '123',
      billing_city: 'Ho Chi Minh City',
      archived: 1,
      imported_at: 77,
      cache_source: 'csv',
    });
    const list = jest.fn(async ({ contextId }: { contextId: number }) => contextId === 2
      ? {
          customers: [{
            id: 'customer-1',
            context_id: 2,
            customer_number: 1001,
            name: 'Updated Customer',
            office_email: null,
            created: '2026-07-16T00:00:00.000Z',
            modified: '2026-07-16T00:00:00.000Z',
          }],
          pages: 1,
        }
      : { customers: [], pages: 1 });
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await new AccountIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getAccount('customer-1')).toMatchObject({
      name: 'Updated Customer',
      office_email: null,
      office_phone: '123',
      billing_city: 'Ho Chi Minh City',
      archived: 1,
      imported_at: 77,
      cache_source: 'api',
    });
  });

  it('does not copy account enrichment across customer and supplier contexts', async () => {
    await cache.setCacheState(state({ lastAccountSync: 100 }));
    await cache.insertAccount({
      account_id: 'shared-id',
      context_id: 10,
      account_number: 9001,
      name: 'Old Supplier',
      office_phone: 'supplier-phone',
      imported_at: 77,
      cache_source: 'csv',
    });
    const list = jest.fn(async ({ contextId }: { contextId: number }) => contextId === 2
      ? {
          customers: [{
            id: 'shared-id',
            context_id: 2,
            customer_number: 1001,
            name: 'New Customer',
            created: '2026-07-16T00:00:00.000Z',
            modified: '2026-07-16T00:00:00.000Z',
          }],
          pages: 1,
        }
      : { customers: [], pages: 1 });
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await new AccountIndexerService(client, cache, 'test', 100).sync();

    expect(await cache.getAccount('shared-id')).toMatchObject({
      context_id: 2,
      name: 'New Customer',
      office_phone: null,
      imported_at: null,
    });
  });

  it('rejects a mismatched account before account cache or source mutation', async () => {
    const initialState = state({
      accountName: 'other-account',
      lastAccountSync: 100,
    });
    await cache.setCacheState(initialState);
    await cache.insertAccount({
      account_id: 'customer-1',
      context_id: 2,
      account_number: 1001,
      name: 'Other Account Customer',
      office_phone: 'other-phone',
      billing_city: 'Other City',
      imported_at: 77,
      cache_source: 'csv',
    });
    const list = jest.fn();
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await expect(new AccountIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/separate database\/cache.*explicitly clear/i);

    expect(await cache.getAccount('customer-1')).toMatchObject({
      name: 'Other Account Customer',
      office_phone: 'other-phone',
      billing_city: 'Other City',
      imported_at: 77,
    });
    expect(await cache.getCacheState()).toEqual(initialState);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects account mutation when populated rows have no ownership state', async () => {
    await cache.insertAccount({
      account_id: 'orphan-customer',
      context_id: 2,
      name: 'Unknown owner',
    });
    const list = jest.fn();
    const client = { customers: { list } } as unknown as SalesBinderClient;

    await expect(new AccountIndexerService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/no account ownership metadata.*explicitly clear/i);

    expect(await cache.getAccount('orphan-customer')).toBeDefined();
    expect(await cache.getCacheState()).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a mismatched account before deleted-log mutation', async () => {
    const initialState = state({ accountName: 'other-account', lastDeletedSync: 100 });
    await cache.setCacheState(initialState);
    await cache.insertDocument({
      doc_id: 'other-doc',
      api_doc_id: 'other-doc',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 100,
    });
    const list = jest.fn();
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await expect(new DeletedLogSyncService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/separate database\/cache.*explicitly clear/i);

    expect(await cache.getDocument('other-doc')).toBeDefined();
    expect(await cache.getCacheState()).toEqual(initialState);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects deleted-log mutation when populated rows have no ownership state', async () => {
    await cache.insertDocument({
      doc_id: 'orphan-doc',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 100,
    });
    const list = jest.fn();
    const client = { deletedLog: { list } } as unknown as SalesBinderClient;

    await expect(new DeletedLogSyncService(client, cache, 'test', 100).sync())
      .rejects.toThrow(/no account ownership metadata.*explicitly clear/i);

    expect(await cache.getDocument('orphan-doc')).toBeDefined();
    expect(await cache.getCacheState()).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps schema publication pending until the item stage succeeds', async () => {
    const previousSchema = CACHE_SCHEMA_VERSION - 1;
    await cache.setCacheState(state({
      schemaVersion: previousSchema,
      lastAccountSync: 100,
      lastDocumentSync: 100,
      lastItemSync: 100,
      lastDeletedSync: 100,
    }));
    const documentList = jest.fn().mockResolvedValue({ documents: [], pages: 1 });
    const documentClient = {
      documents: { list: documentList, get: jest.fn() },
    } as unknown as SalesBinderClient;

    const documentResult = await new DocumentIndexerService(
      documentClient,
      cache,
      'test',
      3600,
      604800,
      100_000
    ).sync({ full: true, preserveExistingEnrichment: false });

    expect(documentResult).toMatchObject({ success: true, type: 'full' });
    expect((await cache.getCacheState())?.schemaVersion).toBe(previousSchema);

    const deletedList = jest.fn().mockResolvedValue({ deletedlog: [], pages: 1 });
    await new DeletedLogSyncService(
      { deletedLog: { list: deletedList } } as unknown as SalesBinderClient,
      cache,
      'test',
      100
    ).sync(true);
    expect((await cache.getCacheState())?.schemaVersion).toBe(previousSchema);

    const itemList = jest.fn().mockRejectedValue(new Error('item source unavailable'));
    await expect(new ItemIndexerService(
      {
        items: { list: itemList, get: jest.fn() },
        categories: { list: jest.fn().mockResolvedValue({ categories: [], pages: 1 }) },
      } as unknown as SalesBinderClient,
      cache,
      'test',
      100
    ).sync(true, false)).rejects.toThrow('item source unavailable');

    expect((await cache.getCacheState())?.schemaVersion).toBe(previousSchema);

    const nextDocumentList = jest.fn().mockResolvedValue({ documents: [], pages: 1 });
    const nextResult = await new DocumentIndexerService(
      {
        documents: { list: nextDocumentList, get: jest.fn() },
      } as unknown as SalesBinderClient,
      cache,
      'test',
      3600,
      604800,
      100_000
    ).sync({ preserveExistingEnrichment: true });

    expect(nextResult.type).toBe('full');
    expect(nextDocumentList.mock.calls[0][0]).not.toHaveProperty('modifiedSince');
  });
});

function state(overrides: Partial<CacheState> = {}): CacheState {
  return {
    lastSync: 100,
    lastFullSync: 100,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'test',
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...overrides,
  };
}

function deletionSourceDocument() {
  return {
    id: 'doc-1',
    context_id: DocumentContextId.Invoice,
    document_number: 1001,
    customer_id: 'customer-1',
    user_id: 'user-1',
    issue_date: '2026-07-16T00:00:00.000Z',
    status_id: 9,
    total_cost: 60,
    total_tax: 0,
    total_tax2: 0,
    total_price: 75,
    total_transactions: 0,
    created: '2026-07-16T00:00:00.000Z',
    modified: '2026-07-16T00:00:00.000Z',
    document_items: [],
  };
}
