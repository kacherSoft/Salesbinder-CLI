import type { SalesBinderClient } from '../../resources/index.js';
import { ContextId, DocumentContextId } from '../../types/common.types.js';
import type { Customer } from '../../types/customers.types.js';
import { AccountIndexerService } from '../account-indexer.service.js';
import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import { DeletedLogSyncService } from '../deleted-log-sync.service.js';
import type { SyncRecordIssue } from '../sync-record-issue.types.js';
import type { CacheState } from '../types.js';

const customer = (id: string, contextId: ContextId): Customer => ({
  id,
  context_id: contextId,
  customer_number: 1,
  name: 'Private name',
  created: '2026-01-01',
  modified: '2026-01-02',
});

describe('cache sync progress contracts', () => {
  it('exposes resource-specific warning types', () => {
    const documentIssue: SyncRecordIssue = {
      resource: 'document',
      id: 'document-id',
      context_id: DocumentContextId.Invoice,
      code: 'invalid_record',
      message: 'Document failed source validation',
      attempts: 2,
      outcome: 'omitted_new',
    };
    const itemIssue: SyncRecordIssue = {
      resource: 'item',
      id: 'item-id',
      code: 'content_changed',
      message: 'Item changed during snapshot verification',
      attempts: 2,
      outcome: 'preserved_last_known_good',
    };
    // @ts-expect-error Document warnings cannot use item-only recovery codes.
    const invalidDocumentIssue: SyncRecordIssue = {
      ...documentIssue,
      code: 'content_changed',
    };
    // @ts-expect-error Item warnings cannot carry document context.
    const invalidItemIssue: SyncRecordIssue = {
      ...itemIssue,
      context_id: DocumentContextId.Invoice,
    };

    expect([documentIssue, itemIssue]).toHaveLength(2);
    void invalidDocumentIssue;
    void invalidItemIssue;
  });

  it('preserves the account boolean overload and emits ID-free pass/page/count progress', async () => {
    const events: CacheSyncProgress[] = [];
    const list = jest.fn(async ({ contextId }: { contextId: ContextId }) =>
      contextId === ContextId.Customer
        ? {
            count: '2',
            page: '1',
            pages: '1',
            customers: [
              customer('customer-secret-1', contextId),
              customer('customer-secret-2', contextId),
            ],
          }
        : { count: '0', page: '1', pages: '0', customers: [] }
    );
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const service = new AccountIndexerService(
      { customers: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await service.sync(true);
    const result = await service.sync({
      full: true,
      onProgressEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      accountsProcessed: 2,
      customersProcessed: 2,
      suppliersProcessed: 0,
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ modifiedSince: 0 }));
    expect(events.map(({ event }) => event)).toEqual([
      'phase_started',
      'pass_started',
      'page_started',
      'record_processed',
      'record_processed',
      'page_completed',
      'pass_completed',
      'pass_started',
      'page_started',
      'page_completed',
      'pass_completed',
      'phase_completed',
    ]);
    expect(events.filter(({ event }) => event === 'pass_started').map(({ pass }) => pass)).toEqual([
      1, 2,
    ]);
    expect(
      events.find(({ event, pass }) => event === 'page_completed' && pass === 1)
    ).toMatchObject({
      page: 1,
      pagesTotal: 1,
      recordsProcessed: 2,
      recordsTotal: 2,
      indeterminate: false,
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'accounts',
      event: 'phase_completed',
      recordsProcessed: 2,
      recordsTotal: 2,
      indeterminate: false,
      apiVersion: '2.0',
    });
    expect(JSON.stringify(events)).not.toMatch(
      /customer-secret|Private name|contextId|context_id|message/
    );
  });

  it.each([
    ['pages', { count: '0' }],
    ['count', { pages: '0' }],
  ])(
    'rejects account pages when %s metadata is missing',
    async (_missing, response) => {
      const events: CacheSyncProgress[] = [];
      const cache = {
        getCacheState: jest.fn(async () => null),
        batchInsertAccounts: jest.fn(async () => undefined),
        setCacheState: jest.fn(async () => undefined),
      } as unknown as CacheService;
      const client = {
        customers: { list: jest.fn(async () => ({ page: '1', customers: [], ...response })) },
      } as unknown as SalesBinderClient;

      await expect(
        new AccountIndexerService(client, cache, 'test').sync({
          onProgressEvent: (event) => events.push(event),
        })
      ).rejects.toThrow(/account pagination/i);

      expect(cache.batchInsertAccounts).not.toHaveBeenCalled();
      expect(cache.setCacheState).not.toHaveBeenCalled();
      expect(events.some(({ event }) => event === 'phase_completed')).toBe(false);
    }
  );

  it.each(['0', '1'])('accepts an empty account result reported with %s total pages', async (pages) => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      customers: {
        list: jest.fn(async () => ({ count: '0', page: '1', pages, customers: [] })),
      },
    } as unknown as SalesBinderClient;

    await expect(new AccountIndexerService(client, cache, 'test').sync()).resolves.toMatchObject({
      accountsProcessed: 0,
    });
    expect(cache.batchInsertAccounts).not.toHaveBeenCalled();
    expect(cache.setCacheState).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty zero-count account result with more than one page', async () => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      customers: {
        list: jest.fn(async () => ({ count: '0', page: '1', pages: '2', customers: [] })),
      },
    } as unknown as SalesBinderClient;

    await expect(new AccountIndexerService(client, cache, 'test').sync()).rejects.toThrow(
      /account pagination/i
    );
    expect(cache.batchInsertAccounts).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong requested page', { count: '1', page: '2', pages: '1' }],
    ['zero pages with a row', { count: '1', page: '1', pages: '0' }],
    ['final count mismatch', { count: '2', page: '1', pages: '1' }],
    ['pages above the safety bound', { count: '1', page: '1', pages: '10001' }],
    ['count above the safety bound', { count: '1000001', page: '1', pages: '1' }],
    ['zero count with a row', { count: '0', page: '1', pages: '1' }],
  ])('rejects %s account pagination before cache mutation', async (_label, pagination) => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      customers: {
        list: jest.fn(async ({ contextId }: { contextId: ContextId }) => ({
          ...pagination,
          customers: [customer('account-1', contextId)],
        })),
      },
    } as unknown as SalesBinderClient;

    await expect(new AccountIndexerService(client, cache, 'test').sync()).rejects.toThrow(
      /account pagination/i
    );

    expect(cache.batchInsertAccounts).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('rejects changed account pagination and duplicate identities without advancing state', async () => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const list = jest.fn(async ({ contextId, page }: { contextId: ContextId; page: number }) =>
      page === 1
        ? {
            count: '2',
            page: '1',
            pages: '2',
            customers: [customer('duplicate-account', contextId)],
          }
        : {
            count: '2',
            page: '2',
            pages: '2',
            customers: [customer('duplicate-account', contextId)],
          }
    );

    await expect(
      new AccountIndexerService(
        { customers: { list } } as unknown as SalesBinderClient,
        cache,
        'test'
      ).sync()
    ).rejects.toThrow(/duplicate/i);

    expect(cache.batchInsertAccounts).toHaveBeenCalledTimes(1);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    ['count', { count: '3', page: '2', pages: '2' }],
    ['pages', { count: '2', page: '2', pages: '3' }],
  ])('rejects a changed account %s after preserving only the valid page', async (_field, page2) => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const list = jest.fn(async ({ contextId, page }: { contextId: ContextId; page: number }) =>
      page === 1
        ? {
            count: '2',
            page: '1',
            pages: '2',
            customers: [customer('account-1', contextId)],
          }
        : { ...page2, customers: [customer('account-2', contextId)] }
    );

    await expect(
      new AccountIndexerService(
        { customers: { list } } as unknown as SalesBinderClient,
        cache,
        'test'
      ).sync()
    ).rejects.toThrow(/account pagination/i);

    expect(cache.batchInsertAccounts).toHaveBeenCalledTimes(1);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('persists the account scan start rather than its finish time', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    let liveState: CacheState = {
      lastSync: 50,
      lastFullSync: 40,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'test',
      schemaVersion: 8,
    };
    const cache = {
      getCacheState: jest.fn(async () => liveState),
      batchInsertAccounts: jest.fn(async () => undefined),
      setCacheState: jest.fn(async (state: CacheState) => {
        liveState = state;
      }),
    } as unknown as CacheService;
    const list = jest.fn(async (_request: { modifiedSince: number }) => {
      now.mockReturnValue(200_000);
      return { count: '0', page: '1', pages: '0', customers: [] };
    });

    try {
      await new AccountIndexerService(
        { customers: { list } } as unknown as SalesBinderClient,
        cache,
        'test',
        0
      ).sync();
      expect(liveState.lastAccountSync).toBe(100);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls.every(([request]) => request.modifiedSince === 50)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('validates account and deleted-log lookbacks at construction', () => {
    const client = {} as SalesBinderClient;
    const cache = {} as CacheService;

    expect(() => new AccountIndexerService(client, cache, 'test', -1)).toThrow(/lookback/i);
    expect(() => new DeletedLogSyncService(client, cache, 'test', 'junk')).toThrow(/lookback/i);
  });

  it('excludes item tombstone requests and item deletes by default', async () => {
    const list = jest.fn(async ({ contextId }: { contextId: number }) =>
      contextId === 6
        ? {
            count: '1',
            page: '1',
            pages: '1',
            deletedlog: [
              [
                {
                  id: 1,
                  context_id: contextId,
                  record_id: 'deleted-secret',
                  created: '2026-01-01',
                },
              ],
            ],
          }
        : { count: '0', page: '1', pages: '0', deletedlog: [] }
    );
    const deleteItem = jest.fn(async () => undefined);
    const cache = deletedCache({ deleteItem });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    const result = await service.sync();

    expect(result).toEqual({ deletedRecordsProcessed: 0, documentTombstones: [] });
    expect(list.mock.calls.map(([{ contextId }]) => contextId)).toEqual([
      ContextId.Customer,
      ContextId.Supplier,
      DocumentContextId.Estimate,
      DocumentContextId.Invoice,
      DocumentContextId.PurchaseOrder,
    ]);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('supports explicit legacy item deletes without resurrecting stale inventory authority', async () => {
    const events: CacheSyncProgress[] = [];
    const order: string[] = [];
    const list = jest.fn(async ({ contextId }: { contextId: number }) =>
      contextId === 6
        ? {
            count: '1',
            page: '1',
            pages: '1',
            deletedlog: [
              [
                {
                  id: 1,
                  context_id: 6,
                  record_id: 'item-owned-by-v3',
                  created: '2026-01-01',
                },
              ],
            ],
          }
        : { count: '0', page: '1', pages: '0', deletedlog: [] }
    );
    let liveState: CacheState = {
      lastSync: 100,
      lastFullSync: 90,
      documentCount: 1,
      itemDocumentCount: 2,
      accountName: 'test',
      schemaVersion: 7,
      inventorySourceApiVersion: '3',
    };
    const getCacheState = jest.fn(async () => liveState);
    const setCacheState = jest.fn(async (state: CacheState) => {
      liveState = state;
    });
    const deleteItem = jest.fn(async () => {
      order.push('delete');
      const stateWithoutInventoryAuthority = { ...liveState };
      delete stateWithoutInventoryAuthority.inventorySourceApiVersion;
      liveState = stateWithoutInventoryAuthority;
    });
    const cache = deletedCache({ getCacheState, setCacheState, deleteItem });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    const result = await service.sync({
      includeItemDeletes: true,
      onProgressEvent: (event) => {
        events.push(event);
        if (event.event === 'record_processed') order.push('progress');
      },
    });

    expect(result).toEqual({ deletedRecordsProcessed: 1, documentTombstones: [] });
    expect(order).toEqual(['delete', 'progress']);
    expect(list.mock.calls.map(([{ contextId }]) => contextId)).toEqual([
      ContextId.Customer,
      ContextId.Supplier,
      6,
      DocumentContextId.Estimate,
      DocumentContextId.Invoice,
      DocumentContextId.PurchaseOrder,
    ]);
    expect(deleteItem).toHaveBeenCalledWith('item-owned-by-v3');
    expect(getCacheState).toHaveBeenCalledTimes(2);
    expect(setCacheState).toHaveBeenCalledTimes(1);
    expect(setCacheState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSync: 100,
        lastFullSync: 90,
        lastDeletedSync: expect.any(Number),
      })
    );
    expect(liveState).not.toHaveProperty('inventorySourceApiVersion');
    expect(events.filter(({ event }) => event === 'pass_started')).toHaveLength(6);
    expect(events.filter(({ event }) => event === 'page_completed')).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({
      phase: 'deleted-log',
      event: 'phase_completed',
      recordsProcessed: 1,
      recordsTotal: 1,
      indeterminate: false,
      apiVersion: '2.0',
    });
    expect(JSON.stringify(events)).not.toContain('item-owned-by-v3');
  });

  it('persists the deleted-log scan start and leaves empty-cache global watermarks unclaimed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    let liveState: CacheState | null = null;
    const cache = deletedCache({
      getCacheState: jest.fn(async () => liveState),
      setCacheState: jest.fn(async (state: CacheState) => {
        liveState = state;
      }),
    });
    const list = jest.fn(async () => {
      now.mockReturnValue(200_000);
      return { count: '0', page: '1', pages: '0', deletedlog: [] };
    });

    try {
      await new DeletedLogSyncService(
        { deletedLog: { list } } as unknown as SalesBinderClient,
        cache,
        'test',
        0
      ).sync();

      expect(liveState).toMatchObject({
        lastSync: 0,
        lastFullSync: 0,
        lastDeletedSync: 100,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('uses the previous deleted-log cutoff while persisting the scan start', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    let liveState: CacheState = {
      lastSync: 40,
      lastFullSync: 30,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'test',
      schemaVersion: 8,
      lastDeletedSync: 50,
    };
    const cache = deletedCache({
      getCacheState: jest.fn(async () => liveState),
      setCacheState: jest.fn(async (state: CacheState) => {
        liveState = state;
      }),
    });
    const list = jest.fn(async (_request: { deletedSince: number }) => {
      now.mockReturnValue(200_000);
      return { count: '0', page: '1', pages: '0', deletedlog: [] };
    });

    try {
      await new DeletedLogSyncService(
        { deletedLog: { list } } as unknown as SalesBinderClient,
        cache,
        'test',
        0
      ).sync();

      expect(liveState.lastDeletedSync).toBe(100);
      expect(list).toHaveBeenCalledTimes(5);
      expect(list.mock.calls.every(([request]) => request.deletedSince === 50)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('rejects a cross-context deleted-log page before deleting any record', async () => {
    const list = jest.fn(async ({ contextId }: { contextId: number }) => ({
      count: '2',
      page: '1',
      pages: '1',
      deletedlog: [
        [
          {
            id: 1,
            context_id: contextId,
            record_id: 'valid-customer',
            created: '2026-01-01',
          },
          {
            id: 2,
            context_id: 6,
            record_id: 'cross-context-item',
            created: '2026-01-01',
          },
        ],
      ],
    }));
    const deleteAccount = jest.fn(async () => undefined);
    const deleteItem = jest.fn(async () => undefined);
    const cache = deletedCache({ deleteAccount, deleteItem });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync()).rejects.toThrow(/deleted-log context mismatch/i);

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('returns deterministic context-plus-API-ID document tombstones after safe deletes', async () => {
    const events: CacheSyncProgress[] = [];
    const list = jest.fn(async ({ contextId }: { contextId: number }) => {
      const recordIds =
        contextId === DocumentContextId.Estimate
          ? ['shared-api-id', 'é-document', 'z-document']
          : contextId === DocumentContextId.Invoice
            ? ['shared-api-id', 'api-resolved', 'legacy-api', 'legacy-undefined', 'old-api']
            : [];
      return {
        count: String(recordIds.length),
        page: '1',
        pages: recordIds.length === 0 ? '0' : '1',
        deleted_log: recordIds.map((recordId, index) =>
          deletedLogEntry(contextId, recordId, index + 1)
        ),
      } as never;
    });
    const getDocumentByApiId = jest.fn(async (apiDocumentId: string) =>
      apiDocumentId === 'api-resolved'
        ? ({ doc_id: 'private-cache-id', context_id: DocumentContextId.Invoice } as never)
        : undefined
    );
    const getDocument = jest.fn(async (documentId: string) => {
      if (documentId === 'legacy-api') {
        return {
          doc_id: documentId,
          context_id: DocumentContextId.Invoice,
          api_doc_id: null,
        } as never;
      }
      if (documentId === 'legacy-undefined') {
        return {
          doc_id: documentId,
          context_id: DocumentContextId.Invoice,
        } as never;
      }
      if (documentId === 'old-api') {
        return {
          doc_id: documentId,
          context_id: DocumentContextId.Invoice,
          api_doc_id: 'replacement-api',
        } as never;
      }
      return undefined;
    });
    const deleteDocument = jest.fn(async () => undefined);
    const cache = deletedCache({ getDocumentByApiId, getDocument, deleteDocument });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    const result = await service.sync({
      includeItemDeletes: false,
      onProgressEvent: (event) => events.push(event),
    });

    expect(result).toEqual({
      deletedRecordsProcessed: 8,
      documentTombstones: [
        { contextId: 4, apiDocumentId: 'shared-api-id' },
        { contextId: 4, apiDocumentId: 'z-document' },
        { contextId: 4, apiDocumentId: 'é-document' },
        { contextId: 5, apiDocumentId: 'api-resolved' },
        { contextId: 5, apiDocumentId: 'legacy-api' },
        { contextId: 5, apiDocumentId: 'legacy-undefined' },
        { contextId: 5, apiDocumentId: 'old-api' },
        { contextId: 5, apiDocumentId: 'shared-api-id' },
      ],
    });
    expect(deleteDocument).toHaveBeenCalledTimes(3);
    expect(deleteDocument).toHaveBeenCalledWith('private-cache-id');
    expect(deleteDocument).toHaveBeenCalledWith('legacy-api');
    expect(deleteDocument).toHaveBeenCalledWith('legacy-undefined');
    expect(deleteDocument).not.toHaveBeenCalledWith('old-api');
    expect(JSON.stringify(events)).not.toMatch(
      /shared-api-id|api-resolved|private-cache-id|legacy-api|legacy-undefined|old-api|z-document|é-document/
    );
  });

  it.each([
    ['missing', { count: '0', page: '1', pages: '0' }],
    ['non-array', { count: '0', page: '1', pages: '0', deletedlog: {} }],
    ['ambiguous aliases', { count: '0', page: '1', pages: '0', deletedlog: [], deleted_log: [] }],
    [
      'mixed flat and wrapped',
      {
        count: '2',
        page: '1',
        pages: '1',
        deletedlog: [
          deletedLogEntry(ContextId.Customer, 'flat'),
          [deletedLogEntry(ContextId.Customer, 'wrapped')],
        ],
      },
    ],
    ['non-record entry', { count: '1', page: '1', pages: '1', deletedlog: [[null]] }],
  ])('rejects a %s deleted-log envelope before any cache mutation', async (_label, response) => {
    const cache = deletedCache();
    const service = new DeletedLogSyncService(
      {
        deletedLog: { list: jest.fn(async () => response as never) },
      } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync()).rejects.toThrow(/deleted-log/i);

    expect(cache.deleteAccount).not.toHaveBeenCalled();
    expect(cache.deleteItem).not.toHaveBeenCalled();
    expect(cache.deleteDocument).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    ['missing page', { count: '0', pages: '0', deletedlog: [] }],
    ['missing count', { page: '1', pages: '0', deletedlog: [] }],
    ['missing pages', { count: '0', page: '1', deletedlog: [] }],
    ['wrong requested page', { count: '0', page: '2', pages: '0', deletedlog: [] }],
    ['empty before final page', { count: '1', page: '1', pages: '2', deletedlog: [] }],
    [
      'final count mismatch',
      {
        count: '2',
        page: '1',
        pages: '1',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'only-entry')]],
      },
    ],
    [
      'zero pages with an entry',
      {
        count: '1',
        page: '1',
        pages: '0',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'impossible-entry')]],
      },
    ],
    [
      'pages above the operational safety bound',
      {
        count: '1',
        page: '1',
        pages: '10001',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'excess-pages')]],
      },
    ],
    [
      'count above the operational safety bound',
      {
        count: '1000001',
        page: '1',
        pages: '2',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'excess-count')]],
      },
    ],
  ])('rejects %s deleted-log pagination before any cache mutation', async (_label, response) => {
    const cache = deletedCache();
    const service = new DeletedLogSyncService(
      {
        deletedLog: { list: jest.fn(async () => response as never) },
      } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync()).rejects.toThrow(/deleted-log (pagination|entry count)/i);

    expect(cache.deleteAccount).not.toHaveBeenCalled();
    expect(cache.deleteItem).not.toHaveBeenCalled();
    expect(cache.deleteDocument).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an empty final page before the declared count',
      { count: '2', page: '2', pages: '2', deletedlog: [] },
    ],
    [
      'a changed count',
      {
        count: '3',
        page: '2',
        pages: '2',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'second-entry', 2)]],
      },
    ],
    [
      'a changed page total',
      {
        count: '2',
        page: '2',
        pages: '3',
        deletedlog: [[deletedLogEntry(ContextId.Customer, 'second-entry', 2)]],
      },
    ],
  ])('rejects %s without advancing deleted state', async (_label, secondPage) => {
    const list = jest.fn(async ({ page }: { page: number }) =>
      page === 1
        ? {
            count: '2',
            page: '1',
            pages: '2',
            deletedlog: [[deletedLogEntry(ContextId.Customer, 'first-entry')]],
          }
        : secondPage
    );
    const deleteAccount = jest.fn(async () => undefined);
    const cache = deletedCache({ deleteAccount });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync()).rejects.toThrow(/deleted-log/i);

    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith('first-entry');
    expect(deleteAccount).not.toHaveBeenCalledWith('second-entry');
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    '',
    ' leading',
    'trailing ',
    'control\u0000character',
    'high-\ud800',
    'low-\udc00',
    'i'.repeat(257),
    42,
  ])(
    'rejects non-canonical deleted-log record ID %j before deleting the valid page prefix',
    async (invalidRecordId) => {
      const deleteAccount = jest.fn(async () => undefined);
      const cache = deletedCache({ deleteAccount });
      const response = {
        count: '2',
        page: '1',
        pages: '1',
        deletedlog: [
          [
            deletedLogEntry(ContextId.Customer, 'valid-prefix'),
            deletedLogEntry(ContextId.Customer, invalidRecordId as string, 2),
          ],
        ],
      };
      const service = new DeletedLogSyncService(
        { deletedLog: { list: jest.fn(async () => response) } } as unknown as SalesBinderClient,
        cache,
        'test'
      );

      await expect(service.sync()).rejects.toThrow(/entry identity is invalid/i);

      expect(deleteAccount).not.toHaveBeenCalled();
      expect(cache.setCacheState).not.toHaveBeenCalled();
    }
  );

  it('accepts a valid non-BMP deleted-log record ID', async () => {
    const recordId = 'deleted-😀';
    const deleteAccount = jest.fn(async () => undefined);
    const cache = deletedCache({ deleteAccount });
    const list = jest.fn(async ({ contextId }: { contextId: number }) => ({
      count: contextId === ContextId.Customer ? '1' : '0',
      page: '1',
      pages: contextId === ContextId.Customer ? '1' : '0',
      deletedlog:
        contextId === ContextId.Customer ? [[deletedLogEntry(ContextId.Customer, recordId)]] : [],
    }));

    const result = await new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test-😀'
    ).sync();

    expect(deleteAccount).toHaveBeenCalledWith(recordId);
    expect(result.deletedRecordsProcessed).toBe(1);
  });

  it.each(['account-\ud800', 'account-\udc00'])(
    'rejects an unpaired surrogate in deleted-log checkpoint account name %j',
    (accountName) => {
      expect(
        () =>
          new DeletedLogSyncService(
            { deletedLog: { list: jest.fn() } } as unknown as SalesBinderClient,
            deletedCache(),
            accountName
          )
      ).toThrow(/account name is invalid/i);
    }
  );

  it('tracks duplicate context-plus-API-ID identities across pages and validates before page deletes', async () => {
    const list = jest.fn(async ({ page }: { page: number }) => ({
      count: '3',
      page: String(page),
      pages: '2',
      deletedlog: [
        page === 1
          ? [deletedLogEntry(ContextId.Customer, 'duplicate')]
          : [
              deletedLogEntry(ContextId.Customer, 'duplicate', 2),
              deletedLogEntry(ContextId.Customer, 'new-on-invalid-page', 3),
            ],
      ],
    }));
    const deleteAccount = jest.fn(async () => undefined);
    const cache = deletedCache({ deleteAccount });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync()).rejects.toThrow(/duplicate identity/i);

    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith('duplicate');
    expect(deleteAccount).not.toHaveBeenCalledWith('new-on-invalid-page');
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('rejects an API-ID lookup that resolves to a document in another context', async () => {
    const cache = deletedCache({
      getDocumentByApiId: jest.fn(async () => ({
        doc_id: 'wrong-context-cache-id',
        context_id: DocumentContextId.Estimate,
      })) as never,
    });
    const list = jest.fn(async ({ contextId }: { contextId: number }) => ({
      count: contextId === DocumentContextId.Invoice ? '1' : '0',
      page: '1',
      pages: contextId === DocumentContextId.Invoice ? '1' : '0',
      deletedlog:
        contextId === DocumentContextId.Invoice
          ? [[deletedLogEntry(contextId, 'invoice-api-id')]]
          : [],
    }));
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync({ includeItemDeletes: false })).rejects.toThrow(
      /document resolution context mismatch/i
    );

    expect(cache.deleteDocument).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('does not emit page or phase completion or advance deleted state after a failed delete', async () => {
    const events: CacheSyncProgress[] = [];
    const failure = new Error('delete failed');
    const list = jest.fn(async () => ({
      count: '2',
      page: '1',
      pages: '1',
      deletedlog: [
        [
          { id: 1, context_id: ContextId.Customer, record_id: 'first', created: '2026-01-01' },
          { id: 2, context_id: ContextId.Customer, record_id: 'second', created: '2026-01-01' },
        ],
      ],
    }));
    const deleteAccount = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const cache = deletedCache({ deleteAccount });
    const service = new DeletedLogSyncService(
      { deletedLog: { list } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    await expect(service.sync({ onProgressEvent: (event) => events.push(event) })).rejects.toBe(
      failure
    );

    expect(deleteAccount).toHaveBeenCalledTimes(2);
    expect(events.filter(({ event }) => event === 'record_processed')).toHaveLength(1);
    expect(events.some(({ event }) => event === 'page_completed')).toBe(false);
    expect(events.some(({ event }) => event === 'phase_completed')).toBe(false);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });
});

function deletedCache(overrides: Partial<CacheService> = {}): CacheService {
  return {
    getCacheState: jest.fn(async () => null),
    setCacheState: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => undefined),
    deleteItem: jest.fn(async () => undefined),
    getDocumentByApiId: jest.fn(async () => undefined),
    getDocument: jest.fn(async () => undefined),
    deleteDocument: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CacheService;
}

function deletedLogEntry(contextId: number, recordId: string, id = 1) {
  return { id, context_id: contextId, record_id: recordId, created: '2026-01-01' };
}
