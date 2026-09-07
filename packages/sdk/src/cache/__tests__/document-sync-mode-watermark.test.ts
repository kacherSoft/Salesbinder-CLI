import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { DocumentContextId, type CacheState } from '../types.js';

const EMPTY_DOCUMENT_PAGE = { documents: [] };

type DocumentCacheState = CacheState & { lastDocumentSync?: number };

function state(overrides: Partial<DocumentCacheState> = {}): DocumentCacheState {
  return {
    lastSync: 100,
    lastFullSync: 90,
    lastDocumentSync: 200,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'default',
    schemaVersion: 8,
    ...overrides,
  };
}

function cacheFor(
  cacheState: CacheState | null,
  options: { paymentWriteError?: Error } = {}
): CacheService {
  return {
    getCacheState: jest.fn(async () => cacheState),
    getPaymentSyncStatus: jest.fn(async () => null),
    getDocumentByApiId: jest.fn(async () => undefined),
    getDocumentByNumber: jest.fn(async () => undefined),
    replaceDocumentBundle: jest.fn(async () => undefined),
    getDocumentCount: jest.fn(async () => 0),
    getItemDocumentCount: jest.fn(async () => 0),
    setCacheState: jest.fn(async () => undefined),
    setPaymentSyncStatus: jest.fn(async () => {
      if (options.paymentWriteError) throw options.paymentWriteError;
    }),
  } as unknown as CacheService;
}

function emptyClient(onList?: () => void): SalesBinderClient {
  return {
    documents: {
      list: jest.fn(async () => {
        onList?.();
        return EMPTY_DOCUMENT_PAGE;
      }),
      get: jest.fn(),
    },
  } as unknown as SalesBinderClient;
}

function documentFor(contextId: DocumentContextId, id: string, documentNumber: number): Document {
  return {
    id,
    context_id: contextId,
    document_number: documentNumber,
    customer_id: 'customer-1',
    user_id: 'user-1',
    issue_date: '2026-01-01',
    status_id: 1,
    total_cost: 1,
    total_tax: 0,
    total_tax2: 0,
    total_price: 2,
    total_transactions: 0,
    created: '2026-01-01T00:00:00+00:00',
    modified: '2026-01-02T00:00:00+00:00',
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
        created: '2026-01-01T00:00:00+00:00',
        modified: '2026-01-02T00:00:00+00:00',
      },
    ],
  };
}

describe('document sync mode and watermark coordination', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SALESBINDER_SYNC_LOOKBACK_SECONDS;
  });

  it('uses delta mode for an existing cache even when the configured alias changed', async () => {
    const cache = cacheFor(state({ accountName: 'default' }));
    const client = emptyClient();

    const result = await new DocumentIndexerService(
      client,
      cache,
      'phuthaitech',
      undefined,
      10
    ).sync();

    expect(result.type).toBe('delta');
    expect(client.documents.list).toHaveBeenCalledWith(
      expect.objectContaining({ modifiedSince: 190 })
    );
  });

  it('respects explicit delta mode and fails closed when cache state is absent', async () => {
    const cache = cacheFor(null);
    const client = emptyClient();

    await expect(
      new DocumentIndexerService(client, cache, 'phuthaitech').sync({ full: false })
    ).rejects.toThrow('Delta document sync requires existing cache state');
    expect(client.documents.list).not.toHaveBeenCalled();
  });

  it('uses zero lookback and advances clean document and global watermarks to scan start', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = cacheFor(state({ accountName: 'phuthaitech', lastDocumentSync: 500 }));
    const client = emptyClient(() => now.mockReturnValue(9_000_000));

    const result = await new DocumentIndexerService(
      client,
      cache,
      'phuthaitech',
      undefined,
      0
    ).sync({ full: false });

    expect(result.type).toBe('delta');
    expect(client.documents.list).toHaveBeenCalledWith(
      expect.objectContaining({ modifiedSince: 500 })
    );
    expect(cache.setCacheState).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastSync: 1_000, lastDocumentSync: 1_000 })
    );
  });

  it('advances a clean standalone full watermark to scan start', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const cache = cacheFor(state({ accountName: 'phuthaitech' }));
    const client = emptyClient(() => now.mockReturnValue(8_000_000));

    await new DocumentIndexerService(client, cache, 'phuthaitech').sync({ full: true });

    expect(cache.setCacheState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastSync: 2_000,
        lastFullSync: 2_000,
        lastDocumentSync: 2_000,
      })
    );
  });

  it('emits cumulative phase progress with context-local totals', async () => {
    const cache = cacheFor(state({ accountName: 'phuthaitech' }));
    const events: CacheSyncProgress[] = [];
    const documents = new Map<DocumentContextId, Document>([
      [DocumentContextId.Estimate, documentFor(DocumentContextId.Estimate, 'estimate-1', 1)],
      [DocumentContextId.Invoice, documentFor(DocumentContextId.Invoice, 'invoice-1', 2)],
      [
        DocumentContextId.PurchaseOrder,
        documentFor(DocumentContextId.PurchaseOrder, 'purchase-order-1', 3),
      ],
    ]);
    const client = {
      documents: {
        list: jest.fn(async ({ contextId }: { contextId: DocumentContextId }) => ({
          documents: [[documents.get(contextId)]],
          count: '1',
          page: '1',
          pages: '1',
        })),
        get: jest.fn(async (id: string) =>
          [...documents.values()].find((document) => document.id === id)
        ),
      },
    } as unknown as SalesBinderClient;

    await new DocumentIndexerService(client, cache, 'phuthaitech').sync({
      full: false,
      onProgressEvent: (event) => events.push(event),
    });

    expect(events.filter(({ event }) => event === 'record_processed')).toEqual([
      expect.objectContaining({
        phaseMode: 'delta',
        contextId: DocumentContextId.Estimate,
        contextRecordsProcessed: 1,
        contextRecordsTotal: 1,
        page: 1,
        pagesTotal: 1,
        recordsProcessed: 1,
        recordsTotal: null,
      }),
      expect.objectContaining({
        contextId: DocumentContextId.Invoice,
        contextRecordsProcessed: 1,
        recordsProcessed: 2,
      }),
      expect.objectContaining({
        contextId: DocumentContextId.PurchaseOrder,
        contextRecordsProcessed: 1,
        recordsProcessed: 3,
      }),
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        event: 'phase_completed',
        phaseMode: 'delta',
        recordsProcessed: 3,
        recordsTotal: 3,
        indeterminate: false,
      })
    );
  });

  it('keeps aggregate progress unchanged while retrying a logical document', async () => {
    const cache = cacheFor(state({ accountName: 'phuthaitech' }));
    const events: CacheSyncProgress[] = [];
    const valid = documentFor(DocumentContextId.Estimate, 'estimate-1', 1);
    const malformed = { ...valid, modified: 'not-a-date' };
    const client = {
      documents: {
        list: jest.fn(async ({ contextId }: { contextId: DocumentContextId }) =>
          contextId === DocumentContextId.Estimate
            ? { documents: [[malformed]], count: '1', page: '1', pages: '1' }
            : { documents: [], count: '0', page: '1', pages: '0' }
        ),
        get: jest.fn(async () => valid),
      },
    } as unknown as SalesBinderClient;

    await new DocumentIndexerService(client, cache, 'phuthaitech').sync({
      full: false,
      onProgressEvent: (event) => events.push(event),
    });

    const retry = events.find(({ event }) => event === 'record_retry_succeeded');
    expect(retry).toEqual(
      expect.objectContaining({ recordsProcessed: 1, recordsTotal: null, phaseMode: 'delta' })
    );
    expect(retry).not.toHaveProperty('contextRecordsTotal');
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        event: 'phase_completed',
        recordsProcessed: 1,
        recordsTotal: 1,
      })
    );
  });

  it('commits payment completion before advancing the document watermark', async () => {
    const cache = cacheFor(state({ accountName: 'phuthaitech' }));
    (cache.getPaymentSyncStatus as jest.Mock).mockResolvedValue({
      status: 'complete',
      mode: 'delta',
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      lastSuccessfulSync: 1,
      cursor: null,
      processedDocuments: 0,
      totalDocuments: 0,
    });

    await new DocumentIndexerService(emptyClient(), cache, 'phuthaitech').sync({ full: false });

    expect(cache.setPaymentSyncStatus).toHaveBeenCalledTimes(1);
    expect((cache.setPaymentSyncStatus as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (cache.setCacheState as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('does not advance state when payment completion cannot be persisted', async () => {
    const paymentWriteError = new Error('payment status write failed');
    const cache = cacheFor(state({ accountName: 'phuthaitech' }), { paymentWriteError });
    (cache.getPaymentSyncStatus as jest.Mock).mockResolvedValue({
      status: 'complete',
      mode: 'delta',
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      lastSuccessfulSync: 1,
      cursor: null,
      processedDocuments: 0,
      totalDocuments: 0,
    });

    await expect(
      new DocumentIndexerService(emptyClient(), cache, 'phuthaitech').sync({ full: false })
    ).rejects.toBe(paymentWriteError);
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });
});
