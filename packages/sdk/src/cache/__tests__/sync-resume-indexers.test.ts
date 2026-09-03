import { AxiosError } from 'axios';
import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { Item } from '../../types/items.types.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
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
  document_items: [
    {
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
    },
  ],
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
  item_variations: [
    {
      id: `variation-${id}`,
      item_id: id,
      item_variations_locations: [{ id: 1, location_id: 'location-1', quantity: 5 }],
    },
  ],
});

describe('full sync resume indexers', () => {
  it('records the failed position and replays an incomplete document phase from the beginning', async () => {
    const failure = new Error('document write failed');
    let failSecond = true;
    const inserted: string[] = [];
    const checkpoints: Array<{ contextId: number; page: number; docIndex: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => {
        if (row.doc_id === 'doc-2' && failSecond) throw failure;
        inserted.push(row.doc_id);
      }),
      getDocumentCount: jest.fn(async () => 30),
      getItemDocumentCount: jest.fn(async () => 40),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const list = jest.fn(async ({ contextId, page }: { contextId: number; page: number }) => ({
      documents:
        contextId === DocumentContextId.Estimate && page === 1
          ? [[document('doc-1'), document('doc-2'), document('doc-3')]]
          : [],
    }));
    const client = { documents: { list, get: jest.fn() } } as unknown as SalesBinderClient;
    const service = new DocumentIndexerService(client, cache, 'test');
    const onDocumentCheckpoint = (position: (typeof checkpoints)[number]) =>
      checkpoints.push(position);

    await expect(service.sync({ full: true, resume: { onDocumentCheckpoint } })).rejects.toBe(
      failure
    );
    expect(inserted).toEqual(['doc-1']);
    expect(client.documents.get).not.toHaveBeenCalled();
    expect(checkpoints.at(-1)).toEqual({
      contextId: DocumentContextId.Estimate,
      page: 1,
      docIndex: 1,
    });
    expect(cache.setCacheState).not.toHaveBeenCalled();

    failSecond = false;
    inserted.length = 0;
    const resumedResult = await service.sync({
      full: true,
      resume: { documents: checkpoints.at(-1), onDocumentCheckpoint },
    });
    expect(inserted).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(resumedResult).toMatchObject({ documentsProcessed: 3, lineItemsProcessed: 3 });
    expect(cache.setCacheState).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentCount: 30, itemDocumentCount: 40 })
    );

    failSecond = true;
    inserted.length = 0;
    await expect(service.sync({ full: true })).rejects.toBe(failure);
    expect(inserted).toEqual(['doc-1']);

    inserted.length = 0;
    (cache.getCacheState as jest.Mock).mockResolvedValue({
      lastSync: 100,
      lastFullSync: 100,
      documentCount: 30,
      itemDocumentCount: 40,
      accountName: 'test',
      schemaVersion: 5,
    });
    await expect(service.sync()).rejects.toBe(failure);
    expect(inserted).toEqual(['doc-1']);
  });

  it('collects document-local failures, retries every unique ID once, and preserves warning watermarks', async () => {
    const invalid = (id: string): Document => ({ ...document(id), modified: 'not-a-date' });
    const listed = [invalid('doc-1'), invalid('doc-2'), invalid('doc-3'), document('doc-4')];
    const written: string[] = [];
    const events: CacheSyncProgress[] = [];
    const priorState = {
      lastSync: 100,
      lastFullSync: 90,
      documentCount: 1,
      itemDocumentCount: 1,
      accountName: 'test',
      schemaVersion: 7,
    };
    const cache = {
      getCacheState: jest.fn(async () => priorState),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async (id: string) =>
        id === 'doc-2'
          ? { doc_id: 'cached-doc-2', api_doc_id: id, context_id: 4, doc_number: 2 }
          : undefined
      ),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => {
        written.push(row.doc_id);
      }),
      getDocumentCount: jest.fn(async () => 3),
      getItemDocumentCount: jest.fn(async () => 3),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const list = jest.fn(async ({ contextId, page }: { contextId: number; page: number }) => ({
      documents: contextId === DocumentContextId.Estimate && page === 1 ? [listed] : [],
    }));
    const get = jest.fn(async (id: string) => {
      if (id === 'doc-1') return document(id);
      if (id === 'doc-2') throw axiosNotFound();
      return invalid(id);
    });
    const service = new DocumentIndexerService(
      { documents: { list, get } } as unknown as SalesBinderClient,
      cache,
      'test'
    );

    const result = await service.sync({ onProgressEvent: (event) => events.push(event) });

    expect(get.mock.calls.map(([id]) => id)).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(written).toEqual(['doc-4', 'doc-1']);
    expect(result).toMatchObject({ documentsProcessed: 2, lineItemsProcessed: 2 });
    expect(result.recordIssues).toEqual([
      {
        resource: 'document',
        id: 'doc-2',
        context_id: 4,
        code: 'not_found',
        message: 'Document unavailable during refresh',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
      {
        resource: 'document',
        id: 'doc-3',
        context_id: 4,
        code: 'invalid_record',
        message: 'Document failed source validation',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ]);
    expect(cache.setCacheState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSync: 100,
        lastFullSync: 90,
        lastSyncAttempt: expect.any(Number),
      })
    );
    expect(events.filter(({ event }) => event === 'record_retry_succeeded')).toHaveLength(1);
    expect(events.filter(({ event }) => event === 'record_retry_failed')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/doc-[1234]/);
  });

  it('keeps the earliest recoverable checkpoint when a later document fails fatally', async () => {
    const fatal = new Error('cache transaction failed');
    const checkpoints: Array<{ contextId: number; page: number; docIndex: number }> = [];
    const malformed = { ...document('doc-1'), modified: 'not-a-date' };
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => {
        throw fatal;
      }),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents:
            contextId === DocumentContextId.Estimate && page === 1
              ? [[malformed, document('doc-2')]]
              : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { onDocumentCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
      })
    ).rejects.toBe(fatal);

    expect(checkpoints.at(-1)).toEqual({
      contextId: DocumentContextId.Estimate,
      page: 1,
      docIndex: 0,
    });
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])('keeps root document HTTP %s failures fatal', async (status) => {
    const failure = axiosFailure(status);
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async () => {
          throw failure;
        }),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toBe(failure);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('keeps a page-one document-list 404 fatal', async () => {
    const failure = axiosNotFound();
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async () => {
          throw failure;
        }),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toBe(failure);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('keeps an early typed document-list 404 fatal when pagination declares another page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, offset) => ({
      ...document(`doc-${offset + 1}`),
      document_number: offset + 1,
    }));
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ page }) => {
          if (page === 2) throw axiosNotFound();
          return { documents: [firstPage], count: 51, page: 1, pages: 2 };
        }),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow('Document pagination ended before page 2');
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it.each([
    [[document('doc-1'), document('doc-1')], /duplicate document ID/i],
    [[document('doc-1'), { ...document('doc-2'), document_number: 1 }], /business key/i],
    [[{ ...document('doc-1'), context_id: DocumentContextId.Invoice }], /context mismatch/i],
  ])('keeps document root identity conflicts fatal', async (listed, expected) => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [listed] : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow(expected);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('retries malformed document text as a record-local failure without reaching the cache', async () => {
    const malformed = {
      ...document('doc-1'),
      customer: { name: { unexpected: true } },
    } as unknown as Document;
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [[malformed]] : [],
        })),
        get: jest.fn(async () => malformed),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: 'doc-1',
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
  });

  it('detects duplicate identities within a resumed document page', async () => {
    const duplicate = document('doc-1');
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async () => ({ documents: [[duplicate, duplicate]] })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { documents: { contextId: DocumentContextId.Estimate, page: 2, docIndex: 0 } },
      })
    ).rejects.toThrow(/duplicate document ID/i);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('rejects a duplicate document ID after replaying a page before the saved position', async () => {
    const skipped = { ...document('doc-1'), document_number: 101 };
    const written: string[] = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row.doc_id)),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents:
            contextId === DocumentContextId.Estimate && (page === 1 || page === 2)
              ? [[skipped]]
              : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { documents: { contextId: DocumentContextId.Estimate, page: 2, docIndex: 0 } },
      })
    ).rejects.toThrow(/duplicate document ID/i);

    expect(written).toEqual(['doc-1']);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('validates pagination integrity on pages before the resume cursor', async () => {
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) =>
          contextId === DocumentContextId.Estimate && page === 1
            ? {
                documents: [[{ ...document('doc-1'), document_number: 101 }]],
                count: 1,
                page: 2,
                pages: 1,
              }
            : { documents: [] }
        ),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { documents: { contextId: DocumentContextId.Estimate, page: 2, docIndex: 0 } },
      })
    ).rejects.toThrow('Invalid document page 1');

    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('rejects a duplicate business key after replaying rows before the saved index', async () => {
    const skipped = { ...document('doc-1'), document_number: 101 };
    const resumed = { ...document('doc-2'), document_number: 102 };
    const duplicate = { ...document('doc-3'), document_number: 101 };
    const written: string[] = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row.doc_id)),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents:
            contextId === DocumentContextId.Estimate && page === 1
              ? [[skipped, resumed, duplicate]]
              : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { documents: { contextId: DocumentContextId.Estimate, page: 1, docIndex: 1 } },
      })
    ).rejects.toThrow(/duplicate document business key/i);

    expect(written).toEqual(['doc-1', 'doc-2']);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('rejects a duplicate document ID from a context before the resume cursor', async () => {
    const estimate = { ...document('doc-1'), document_number: 101 };
    const invoice = {
      ...document('doc-1'),
      context_id: DocumentContextId.Invoice,
      document_number: 201,
    };
    const written: string[] = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row.doc_id)),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents:
            page !== 1
              ? []
              : contextId === DocumentContextId.Estimate
                ? [[estimate]]
                : contextId === DocumentContextId.Invoice
                  ? [[invoice]]
                  : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({
        full: true,
        resume: { documents: { contextId: DocumentContextId.Invoice, page: 1, docIndex: 0 } },
      })
    ).rejects.toThrow(/duplicate document ID/i);

    expect(written).toEqual(['doc-1']);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('replays rows shifted before a persisted page cursor after source insertion', async () => {
    const written: string[] = [];
    const checkpoints: Array<{ contextId: number; page: number; docIndex: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row.doc_id)),
      getDocumentCount: jest.fn(async () => 3),
      getItemDocumentCount: jest.fn(async () => 3),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents:
            contextId !== DocumentContextId.Estimate
              ? []
              : page === 1
                ? [[document('doc-0'), document('doc-1')]]
                : page === 2
                  ? [[document('doc-2')]]
                  : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test').sync({
      full: true,
      resume: {
        documents: { contextId: DocumentContextId.Estimate, page: 2, docIndex: 0 },
        onDocumentCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      },
    });

    expect(written).toEqual(['doc-0', 'doc-1', 'doc-2']);
    expect(result).toMatchObject({ documentsProcessed: 3, lineItemsProcessed: 3 });
    expect(checkpoints[0]).toEqual({
      contextId: DocumentContextId.Estimate,
      page: 1,
      docIndex: 0,
    });
  });

  it('replays the surviving source when pagination shrinks past a persisted cursor', async () => {
    const written: string[] = [];
    const checkpoints: Array<{ contextId: number; page: number; docIndex: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row.doc_id)),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId }) =>
          contextId === DocumentContextId.Estimate
            ? { documents: [[document('doc-1')]], count: 1, page: 1, pages: 1 }
            : { documents: [] }
        ),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test').sync({
      full: true,
      resume: {
        documents: { contextId: DocumentContextId.Estimate, page: 3, docIndex: 0 },
        onDocumentCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      },
    });

    expect(written).toEqual(['doc-1']);
    expect(result).toMatchObject({ documentsProcessed: 1, lineItemsProcessed: 1 });
    expect(checkpoints[0]).toEqual({
      contextId: DocumentContextId.Estimate,
      page: 1,
      docIndex: 0,
    });
  });

  it('rewrites changed source content before a persisted row cursor', async () => {
    const changed = {
      ...document('doc-1'),
      name: 'Changed before resume',
      modified: '2026-02-03',
    };
    const written: Array<{ doc_id: string; document_name: string | null; modified: number }> = [];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (row) => written.push(row)),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [[changed]] : [],
        })),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test').sync({
      full: true,
      resume: {
        documents: { contextId: DocumentContextId.Estimate, page: 1, docIndex: 1 },
      },
    });

    expect(written).toEqual([
      expect.objectContaining({
        doc_id: 'doc-1',
        document_name: 'Changed before resume',
        modified: Math.floor(new Date('2026-02-03').getTime() / 1000),
      }),
    ]);
    expect(result).toMatchObject({ documentsProcessed: 1, lineItemsProcessed: 1 });
  });

  it('keeps exhausted document transport failures fatal', async () => {
    const failure = Object.assign(new Error('socket unavailable'), {
      isAxiosError: true,
      request: {},
    });
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      replaceDocumentBundle: jest.fn(),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const withoutItems = { ...document('doc-1'), document_items: undefined };
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [[withoutItems]] : [],
        })),
        get: jest.fn(async () => {
          throw failure;
        }),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toBe(failure);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
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
      insertItem: jest.fn(async (row) => {
        inserted.push(row.item_id);
      }),
      replaceItemStockLocations: jest.fn(async (id: string) => {
        replaced.push(id);
      }),
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
    const onItemCheckpoint = (position: (typeof checkpoints)[number]) => checkpoints.push(position);

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

function axiosNotFound(): AxiosError {
  return new AxiosError('Not found', undefined, undefined, undefined, { status: 404 } as any);
}

function axiosFailure(status?: number): AxiosError {
  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    status === undefined ? undefined : ({ status } as any)
  );
}
