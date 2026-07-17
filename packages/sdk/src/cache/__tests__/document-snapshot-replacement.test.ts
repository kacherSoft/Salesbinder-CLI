import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { SalesBinderClient } from '../../resources/index.js';
import type { Document, DocumentItem } from '../../types/documents.types.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { withCacheWriterApplicationName } from '../postgres-cache.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import {
  CACHE_SCHEMA_VERSION,
  DocumentContextId,
  type CacheState,
  type DocumentSnapshot,
} from '../types.js';

describe('authoritative document snapshots', () => {
  let cache: SQLiteCacheService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `document-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cache = new SQLiteCacheService('snapshot-test', dbPath, true);
  });

  afterEach(async () => {
    await cache.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.maintenance-lock`, { force: true });
  });

  it('captures non-item lines, remains idempotent, and removes deleted source lines', async () => {
    const value = snapshot(100);

    await cache.replaceDocumentSnapshot(value);
    await cache.replaceDocumentSnapshot(value);

    expect(await cache.getItemDocumentCount()).toBe(1);
    expect(await cache.getDocumentNonItemLineCount()).toBe(1);
    expect(await cache.getDocument('doc-1')).toMatchObject({
      snapshot_version: CACHE_SCHEMA_VERSION,
      snapshot_complete: 1,
    });
    expect(await cache.getDocumentNonItemLines('doc-1')).toEqual([
      expect.objectContaining({
        document_item_id: 'line-adjustment',
        total_amount: -25,
        net_amount: -20,
        line_type: 'non_item',
      }),
    ]);

    const withoutAdjustment = snapshot(200);
    withoutAdjustment.nonItemLines = [];
    await cache.replaceDocumentSnapshot(withoutAdjustment);

    expect(await cache.getItemDocumentCount()).toBe(1);
    expect(await cache.getDocumentNonItemLineCount()).toBe(0);
  });

  it('rolls back header and both line sets when a line insert fails', async () => {
    await cache.replaceDocumentSnapshot(snapshot(100));
    const invalid = snapshot(200);
    invalid.document.subtotal = 999;
    invalid.itemLines[0].price = 999;
    invalid.nonItemLines[0].raw_classification = {} as unknown as string;

    expect(() => cache.replaceDocumentSnapshot(invalid)).toThrow();

    expect((await cache.getDocument('doc-1'))?.subtotal).toBe(75);
    expect((await cache.getItemDocuments('doc-1'))[0].price).toBe(100);
    expect((await cache.getDocumentNonItemLines('doc-1'))[0].net_amount).toBe(-20);
  });

  it('invalidates completeness when financial lines change outside atomic replacement', async () => {
    await cache.replaceDocumentSnapshot(snapshot(100));
    expect((await cache.getDocument('doc-1'))?.snapshot_complete).toBe(1);

    await cache.deleteDocumentNonItemLines('doc-1');
    expect((await cache.getDocument('doc-1'))?.snapshot_complete).toBe(0);

    await cache.replaceDocumentSnapshot(snapshot(200));
    await cache.deleteItemDocuments('doc-1');
    expect((await cache.getDocument('doc-1'))?.snapshot_complete).toBe(0);
  });

  it('rejects document mutations from a legacy SQLite connection', async () => {
    await cache.replaceDocumentSnapshot(snapshot(100));
    const legacy = new Database(dbPath);
    try {
      expect(() => legacy.prepare(`UPDATE documents SET total_price = 999 WHERE doc_id = 'doc-1'`).run())
        .toThrow(/salesbinder_cache_writer_version|incompatible SalesBinder cache writer/);
    } finally {
      legacy.close();
    }
    expect((await cache.getDocument('doc-1'))?.total_price).not.toBe(999);
  });

  it('allows authoritative parent deletion to cascade through both line tables', async () => {
    await cache.replaceDocumentSnapshot(snapshot(100));

    await cache.deleteDocument('doc-1');

    expect(await cache.getDocument('doc-1')).toBeUndefined();
    expect(await cache.getItemDocumentCount()).toBe(0);
    expect(await cache.getDocumentNonItemLineCount()).toBe(0);
  });

  it('preserves newer or omitted shipment values but applies explicit source clears', async () => {
    await cache.replaceDocumentSnapshot(snapshot(1000));
    const current = (await cache.getDocument('doc-1'))!;
    await cache.insertDocument({
      ...current,
      date_sent: '1970-01-01T00:20:00.000Z',
      shipped_percent: 50,
      shipment_checked_at: '1970-01-01T00:20:00.000Z',
    });
    await cache.deleteItemDocuments('doc-1');
    await cache.insertItemDocument({
      ...snapshot(1000).itemLines[0],
      quantity_shipped: 2,
    });

    const staleSource = snapshot(1100);
    staleSource.document.shipped_percent = 0;
    staleSource.itemLines[0].quantity_shipped = 0;
    await cache.replaceDocumentSnapshot(staleSource);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      date_sent: '1970-01-01T00:20:00.000Z',
      shipped_percent: 50,
    });
    expect((await cache.getItemDocuments('doc-1'))[0].quantity_shipped).toBe(2);

    const sourceWithClear = snapshot(2000);
    sourceWithClear.document.date_sent = null;
    sourceWithClear.document.shipped_percent = null;
    sourceWithClear.itemLines[0].quantity_shipped = null;
    await cache.replaceDocumentSnapshot(sourceWithClear);
    expect((await cache.getDocument('doc-1'))?.date_sent).toBeNull();
    expect((await cache.getDocument('doc-1'))?.shipped_percent).toBeNull();
    expect((await cache.getItemDocuments('doc-1'))[0].quantity_shipped).toBeNull();

    const locallyReconciled = (await cache.getDocument('doc-1'))!;
    await cache.insertDocument({
      ...locallyReconciled,
      shipped_percent: 50,
      shipment_checked_at: '1970-01-01T00:20:00.000Z',
    });
    await cache.deleteItemDocuments('doc-1');
    await cache.insertItemDocument({ ...snapshot(2000).itemLines[0], quantity_shipped: 2 });
    const sourceWithOmissions = snapshot(2000);
    sourceWithOmissions.document.shipped_percent = undefined;
    sourceWithOmissions.itemLines[0].quantity_shipped = undefined;
    await cache.replaceDocumentSnapshot(sourceWithOmissions);
    expect((await cache.getDocument('doc-1'))?.shipped_percent).toBe(50);
    expect((await cache.getItemDocuments('doc-1'))[0].quantity_shipped).toBe(2);
  });

  it('preserves reconciliation committed while document detail is in flight', async () => {
    await cache.replaceDocumentSnapshot(snapshot(900));
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({ document_items: [] });
    const detailed = sourceDocument({ date_sent: null, shipped_percent: 0 });
    detailed.document_items![0].quantity_partially_shipped = 0;
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const get = jest.fn(async (_id: string, options?: { beforeRequestStart?: () => Promise<void> }) => {
      await options?.beforeRequestStart?.();
      const current = (await cache.getDocument('doc-1'))!;
      await cache.insertDocument({
        ...current,
        date_sent: '1970-01-01T00:16:41.000Z',
        shipped_percent: 50,
        shipment_checked_at: '1970-01-01T00:16:41.000Z',
      });
      await cache.deleteItemDocuments('doc-1');
      await cache.insertItemDocument({ ...snapshot(900).itemLines[0], quantity_shipped: 2 });
      return detailed;
    });
    const client = fakeClient(listed, detailed);
    client.documents.get = get;
    try {
      const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);
      expect((await indexer.sync()).success).toBe(true);
    } finally {
      now.mockRestore();
    }
    expect(await cache.getDocument('doc-1')).toMatchObject({ shipped_percent: 50 });
    expect((await cache.getItemDocuments('doc-1'))[0].quantity_shipped).toBe(2);
  });

  it('always uses document detail instead of a non-empty list payload', async () => {
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({
      document_items: [sourceItem({ id: 'partial-line', name: 'Partial list line' })],
    });
    const detailed = sourceDocument();
    const client = fakeClient(listed, detailed);
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();

    expect(result.success).toBe(true);
    expect(client.documents.get).toHaveBeenCalledWith('doc-1', expect.objectContaining({
      beforeRequestStart: expect.any(Function),
    }));
    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({ document_item_id: 'line-item', item_name: 'Authoritative item' }),
    ]);
    expect(await cache.getDocumentNonItemLines('doc-1')).toHaveLength(1);
  });

  it('fails closed when authoritative product-line cost is missing', async () => {
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({ document_items: [] });
    const detailed = sourceDocument();
    detailed.document_items![0].cost = null as unknown as number;
    const client = fakeClient(listed, detailed);
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();

    expect(result).toMatchObject({ success: false, failedDocuments: 1, retryDocumentIds: ['doc-1'] });
    expect(await cache.getDocument('doc-1')).toBeUndefined();
  });

  it('keeps the safe watermark and retry checkpoint when any document fails', async () => {
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({ document_items: [] });
    const client = fakeClient(listed, sourceDocument());
    client.documents.get.mockRejectedValue(new Error('detail unavailable'));
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();
    const state = await cache.getCacheState();

    expect(result).toMatchObject({ success: false, failedDocuments: 1, retryDocumentIds: ['doc-1'] });
    expect(state?.lastDocumentSync).toBe(100);
    expect(state?.documentSyncCheckpoint?.retryDocumentIds).toEqual(['doc-1']);
    expect(state?.documentSyncCheckpoint).not.toHaveProperty('completedDocumentIds');
  });

  it('resumes an unfinished full checkpoint from a plain sync invocation', async () => {
    await cache.setCacheState({
      ...cacheState(),
      documentSyncCheckpoint: {
        accountName: 'snapshot-test',
        syncType: 'full',
        phase: 'catch_up',
        startedAt: 90,
        sourceModifiedSince: 89,
        endWatermark: 100,
        nextContextIndex: 3,
        nextPage: 1,
        retryDocumentIds: ['doc-1'],
      },
    });
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();

    expect(result).toMatchObject({ success: true, type: 'full', failedDocuments: 0 });
    expect((await cache.getCacheState())?.documentSyncCheckpoint).toBeUndefined();
  });

  it('replaces a stale delta checkpoint when a schema upgrade requires full history', async () => {
    await cache.setCacheState({
      ...cacheState(),
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      documentSyncCheckpoint: {
        accountName: 'snapshot-test',
        syncType: 'delta',
        phase: 'primary',
        startedAt: 90,
        sourceModifiedSince: 80,
        nextContextIndex: 0,
        nextPage: 1,
        retryDocumentIds: [],
      },
    });
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync({ full: true });

    expect(result.type).toBe('full');
    expect(client.documents.list.mock.calls[0][0]).not.toHaveProperty('modifiedSince');
    expect((await cache.getCacheState())?.documentSyncCheckpoint).toBeUndefined();
  });

  it('treats a confirmed detail 404 as a tombstone instead of a retry', async () => {
    await cache.replaceDocumentSnapshot(snapshot(90));
    await cache.setCacheState(cacheState());
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    client.documents.get.mockRejectedValue({ response: { status: 404 } });
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();

    expect(result).toMatchObject({
      success: true,
      type: 'delta',
      documentsDeleted: 1,
      failedDocuments: 0,
      retryDocumentIds: [],
    });
    expect(await cache.getDocument('doc-1')).toBeUndefined();
  });

  it('removes a CSV-seeded synthetic row when listed API detail returns 404', async () => {
    await cache.insertDocument({
      doc_id: 'csv-invoice-1001',
      api_doc_id: null,
      cache_source: 'csv',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 90,
    });
    await cache.setCacheState(cacheState());
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    client.documents.get.mockRejectedValue({ response: { status: 404 } });
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    expect((await indexer.sync()).success).toBe(true);

    expect(await cache.getDocument('csv-invoice-1001')).toBeUndefined();
    expect(await cache.getDocumentCount()).toBe(0);
  });

  it('retains listed identity so a resumed 404 removes a synthetic CSV row', async () => {
    await cache.insertDocument({
      doc_id: 'csv-invoice-1001',
      api_doc_id: null,
      cache_source: 'csv',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 90,
    });
    await cache.setCacheState(cacheState());
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    client.documents.get.mockRejectedValue(new Error('temporary detail failure'));
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    expect((await indexer.sync()).success).toBe(false);
    expect((await cache.getCacheState())?.documentSyncCheckpoint?.retryDocumentIdentities).toEqual({
      'doc-1': { contextId: DocumentContextId.Invoice, documentNumber: 1001 },
    });

    client.documents.get.mockRejectedValue({ response: { status: 404 } });
    expect((await indexer.sync()).success).toBe(true);
    expect(await cache.getDocument('csv-invoice-1001')).toBeUndefined();
    expect((await cache.getCacheState())?.documentSyncCheckpoint).toBeUndefined();
  });

  it('finishes a full sync only after a delta catch-up reaches an end watermark', async () => {
    const listed = sourceDocument({ document_items: [] });
    const detailed = sourceDocument();
    const list = jest.fn(async (params: { contextId: number; page: number; modifiedSince?: number }) => {
      if (params.modifiedSince !== undefined) return { documents: [] };
      if (params.contextId === DocumentContextId.Invoice && params.page === 1) {
        return { documents: [[listed]] };
      }
      return { documents: [] };
    });
    const client = {
      documents: { list, get: jest.fn().mockResolvedValue(detailed) },
    } as unknown as SalesBinderClient & {
      documents: { list: jest.Mock; get: jest.Mock };
    };
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync({ full: true });
    const state = await cache.getCacheState();

    expect(result.success).toBe(true);
    expect(list.mock.calls.some(([params]) => params.modifiedSince !== undefined)).toBe(true);
    expect(state?.lastDocumentSync).toBeGreaterThan(0);
    expect(state?.documentSyncCheckpoint).toBeUndefined();
  });
});

test('PostgreSQL cache writer overrides conflicting application_name parameters', () => {
  const normalized = new URL(withCacheWriterApplicationName(
    'postgresql://cache-user@localhost/cache?application_name=legacy-writer&sslmode=require'
  ));
  expect(normalized.searchParams.get('application_name')).toBe(`salesbinder-cache-v${CACHE_SCHEMA_VERSION}`);
  expect(normalized.searchParams.get('sslmode')).toBe('require');
});

function cacheState(): CacheState {
  return {
    lastSync: 100,
    lastFullSync: 100,
    lastDocumentSync: 100,
    documentCount: 0,
    itemDocumentCount: 0,
    accountName: 'snapshot-test',
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
}

function snapshot(sourceFetchedAt: number): DocumentSnapshot {
  return {
    sourceFetchedAt,
    document: {
      doc_id: 'doc-1',
      api_doc_id: 'doc-1',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-07-16',
      customer_id: 'customer-1',
      modified: 100,
      subtotal: 75,
      snapshot_version: CACHE_SCHEMA_VERSION,
      snapshot_complete: 1,
    },
    itemLines: [{
      item_id: 'item-1',
      doc_id: 'doc-1',
      document_item_id: 'line-item',
      quantity: 1,
      price: 100,
      total_amount: 100,
      quantity_shipped: 0,
    }],
    nonItemLines: [{
      doc_id: 'doc-1',
      document_item_id: 'line-adjustment',
      line_type: 'non_item',
      quantity: 1,
      price: -25,
      total_amount: -25,
      discount_percent: 20,
      net_amount: -20,
      raw_classification: '{"has_item_id":false}',
    }],
  };
}

function fakeClient(listed: Document, detailed: Document) {
  const list = jest.fn(async (params: { contextId: number; page: number }) => {
    if (params.contextId === DocumentContextId.Invoice && params.page === 1) {
      return { documents: [[listed]] };
    }
    return { documents: [] };
  });
  return {
    documents: { list, get: jest.fn().mockResolvedValue(detailed) },
  } as unknown as SalesBinderClient & {
    documents: { list: jest.Mock; get: jest.Mock };
  };
}

function sourceDocument(overrides: Partial<Document> = {}): Document {
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
    document_items: [
      sourceItem(),
      sourceItem({
        id: 'line-adjustment',
        item_id: undefined,
        name: 'Invoice adjustment',
        price: -25,
        discount_percent: 20,
      }),
    ],
    ...overrides,
  };
}

function sourceItem(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'line-item',
    document_id: 'doc-1',
    item_id: 'item-1',
    name: 'Authoritative item',
    description: 'Authoritative detail line',
    quantity: 1,
    quantity_partially_received: 0,
    quantity_partially_shipped: 0,
    tax: 0,
    tax2: 0,
    discount_percent: 0,
    cost: 60,
    price: 100,
    discounted_price: 0,
    weight: 1,
    created: '2026-07-16T00:00:00.000Z',
    modified: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}
