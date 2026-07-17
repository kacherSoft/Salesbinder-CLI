import { readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
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

  it('replaces stale v3 writer triggers before mutating a migrated v4 snapshot', async () => {
    await cache.close();
    const legacy = new Database(dbPath);
    for (const table of ['documents', 'item_documents', 'document_non_item_lines']) {
      const triggerPrefix = table === 'document_non_item_lines' ? 'non_item_lines' : table;
      for (const operation of ['insert', 'update', 'delete']) {
        legacy.exec(`
          DROP TRIGGER IF EXISTS trg_${triggerPrefix}_writer_v4_${operation};
          CREATE TRIGGER trg_${triggerPrefix}_writer_v3_${operation}
          BEFORE ${operation.toUpperCase()} ON ${table}
          WHEN salesbinder_cache_writer_version() <> 3
          BEGIN SELECT RAISE(ABORT, 'incompatible SalesBinder cache writer'); END;
        `);
      }
    }
    legacy.pragma('user_version = 3');
    legacy.close();

    cache = new SQLiteCacheService('snapshot-test', dbPath, true);
    await cache.replaceDocumentSnapshot(snapshot(100));

    expect(await cache.getDocument('doc-1')).toMatchObject({
      snapshot_version: CACHE_SCHEMA_VERSION,
      snapshot_complete: 1,
    });
    expect(await cache.getItemDocumentCount()).toBe(1);
    expect(await cache.getDocumentNonItemLineCount()).toBe(1);
    const inspector = new Database(dbPath, { readonly: true });
    try {
      const versionedTriggers = inspector.prepare(`
        SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'trg_%_writer_v%'
      `).all() as Array<{ name: string; sql: string }>;
      expect(versionedTriggers).toHaveLength(9);
      expect(versionedTriggers.every(({ name, sql }) => (
        name.includes(`_v${CACHE_SCHEMA_VERSION}_`)
        && sql.includes(`<> ${CACHE_SCHEMA_VERSION}`)
      ))).toBe(true);
    } finally {
      inspector.close();
    }
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

  it('does not carry shipment reconciliation across a reused document number', async () => {
    const previous = snapshot(1_000);
    previous.document.api_doc_id = 'old-api-document';
    previous.document.shipped_percent = 80;
    previous.document.date_sent = '1970-01-01T00:20:00.000Z';
    previous.document.shipment_checked_at = '1970-01-01T00:30:00.000Z';
    previous.itemLines[0].quantity_shipped = 8;
    await cache.replaceDocumentSnapshot(previous);

    const replacement = snapshot(1_100);
    replacement.document.doc_id = 'new-doc-id';
    replacement.document.api_doc_id = 'new-api-document';
    replacement.document.shipped_percent = 10;
    replacement.document.date_sent = null;
    replacement.document.shipment_checked_at = null;
    replacement.itemLines[0].doc_id = 'new-doc-id';
    replacement.itemLines[0].quantity_shipped = 1;
    replacement.nonItemLines[0].doc_id = 'new-doc-id';
    await cache.replaceDocumentSnapshot(replacement);

    expect(await cache.getDocumentByApiId('new-api-document')).toMatchObject({
      date_sent: null,
      shipped_percent: 10,
      shipment_checked_at: null,
    });
    expect((await cache.getItemDocuments('doc-1'))[0].quantity_shipped).toBe(1);
  });

  it('uses the same shipment identity guard in PostgreSQL snapshot replacement', () => {
    const source = readFileSync(resolve(__dirname, '..', 'postgres-cache.service.ts'), 'utf8');
    const replacementStart = source.indexOf('async replaceDocumentSnapshot(');
    const replacementEnd = source.indexOf('async insertItemDocument(', replacementStart);

    expect(replacementStart).toBeGreaterThan(-1);
    expect(replacementEnd).toBeGreaterThan(replacementStart);
    expect(source.slice(replacementStart, replacementEnd))
      .toContain('isShipmentIdentityCompatible');
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

  it('merges listed and compatible cached metadata without weakening detail authority', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-1',
      account_name: 'Cached Customer',
      account_number: 10,
      user_id: 'user-1',
      salesperson_name: 'Cached Rep',
      status_id: 9,
      status_name: 'Cached Status',
      custom_doc_number: 'CACHED-CUSTOM',
      associated_document_id: 'associated-1',
      external_po_number: 'PO-CACHED',
      shipping_location: 'Cached Warehouse',
      imported_at: 77,
    });
    Object.assign(seeded.itemLines[0], {
      item_number: 5001,
      item_sku: 'SKU-5001',
      item_location: 'A-01',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());

    const listed = sourceDocument({
      document_items: [],
      name: 'Listed document name',
      customer: { id: 'customer-1', name: 'Listed Customer', customer_number: 20 },
      user: { id: 'user-1', name: 'Listed Rep' },
      status: { id: 9, name: 'Listed Status' },
    });
    Object.assign(listed, { custom_doc_number: 'LIST-CUSTOM' });
    const detailed = sourceDocument();
    const client = fakeClient(listed, detailed);
    const indexer = new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    );

    expect((await indexer.sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      total_price: 75,
      total_cost: 60,
      document_name: 'Listed document name',
      account_name: 'Listed Customer',
      account_number: 20,
      salesperson_name: 'Listed Rep',
      status_name: 'Listed Status',
      custom_doc_number: 'LIST-CUSTOM',
      associated_document_id: 'associated-1',
      external_po_number: 'PO-CACHED',
      shipping_location: 'Cached Warehouse',
      imported_at: 77,
    });
    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        document_item_id: 'line-item',
        item_number: 5001,
        item_sku: 'SKU-5001',
        item_location: 'A-01',
      }),
    ]);
    expect(await cache.getDocumentNonItemLines('doc-1')).toHaveLength(1);
  });

  it('treats null relationship objects as unhydrated when their IDs remain assigned', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-1',
      account_name: 'Cached Customer',
      account_number: 10,
      user_id: 'user-1',
      salesperson_name: 'Cached Rep',
      status_id: 9,
      status_name: 'Cancelled',
      is_cancelled: 1,
    });
    Object.assign(seeded.itemLines[0], {
      item_number: 5001,
      item_sku: 'CACHED-SKU',
      item_location: 'Cached location',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState({
      ...cacheState(),
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
    });
    const detailed = sourceDocument();
    Object.assign(detailed, { customer: null, user: null, status: null });
    const detailedLine = detailed.document_items![0] as unknown as Record<string, unknown>;
    delete detailedLine.item_number;
    delete detailedLine.item_sku;
    delete detailedLine.item_location;
    const client = fakeClient(sourceDocument({ document_items: [] }), detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync({ full: true })).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      account_name: 'Cached Customer',
      account_number: 10,
      salesperson_name: 'Cached Rep',
      status_name: 'Cancelled',
      is_cancelled: 1,
    });
    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        item_number: 5001,
        item_sku: 'CACHED-SKU',
        item_location: 'Cached location',
      }),
    ]);
    expect((await cache.getCacheState())?.schemaVersion).toBe(CACHE_SCHEMA_VERSION - 1);
  });

  it('rejects nested null relationship identities for assigned top-level IDs', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-1',
      account_name: 'Cached Customer',
      user_id: 'user-1',
      salesperson_name: 'Cached Rep',
      status_id: 9,
      status_name: 'Cached Status',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const detailed = sourceDocument();
    Object.assign(detailed, {
      customer: { id: null, name: 'Wrong Customer', customer_number: 99 },
      user: { id: null, name: 'Wrong Rep' },
      status: { id: null, name: 'Wrong Status' },
    });
    const client = fakeClient(sourceDocument({ document_items: [] }), detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      account_name: 'Cached Customer',
      salesperson_name: 'Cached Rep',
      status_name: 'Cached Status',
    });
  });

  it('clears relationship names when their top-level identities are explicitly null', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      user_id: 'user-1',
      salesperson_name: 'Cached Rep',
      status_id: 9,
      status_name: 'Cancelled',
      is_cancelled: 1,
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const detailed = sourceDocument();
    Object.assign(detailed, {
      user_id: null,
      status_id: null,
      user: null,
      status: null,
    });
    const client = fakeClient(sourceDocument({ document_items: [] }), detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      user_id: null,
      salesperson_name: null,
      status_id: null,
      status_name: null,
      is_cancelled: 0,
    });
  });

  it('preserves legacy relationship names when null IDs and source relationships are omitted', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      user_id: null,
      salesperson_name: 'Legacy Rep',
      status_id: null,
      status_name: 'Legacy Status',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());

    const listed = sourceDocument({ document_items: [] }) as unknown as Record<string, unknown>;
    const detailed = sourceDocument() as unknown as Record<string, unknown>;
    for (const source of [listed, detailed]) {
      delete source.user_id;
      delete source.user;
      delete source.status_id;
      delete source.status;
    }

    expect((await new DocumentIndexerService(
      fakeClient(listed as unknown as Document, detailed as unknown as Document),
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      user_id: null,
      salesperson_name: 'Legacy Rep',
      status_id: null,
      status_name: 'Legacy Status',
    });
  });

  it('rejects a mismatched account before document cache or source mutation', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-1',
      account_name: 'Other Customer',
      user_id: 'user-1',
      salesperson_name: 'Other Rep',
      status_id: 9,
      status_name: 'Other Status',
      imported_at: 77,
    });
    Object.assign(seeded.itemLines[0], {
      item_number: 5001,
      item_sku: 'OTHER-SKU',
      item_location: 'OTHER-LOCATION',
    });
    await cache.replaceDocumentSnapshot(seeded);
    const initialState = { ...cacheState(), accountName: 'other-account' };
    await cache.setCacheState(initialState);
    const client = fakeClient(
      sourceDocument({ document_items: [] }),
      sourceDocument()
    );

    await expect(new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).rejects.toThrow(/separate database\/cache.*explicitly clear/i);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      account_name: 'Other Customer',
      salesperson_name: 'Other Rep',
      status_name: 'Other Status',
      imported_at: 77,
    });
    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        item_number: 5001,
        item_sku: 'OTHER-SKU',
        item_location: 'OTHER-LOCATION',
      }),
    ]);
    expect(await cache.getCacheState()).toEqual(initialState);
    expect(client.documents.list).not.toHaveBeenCalled();
    expect(client.documents.get).not.toHaveBeenCalled();
  });

  it('rejects document mutation when populated rows have no ownership state', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-1',
      account_name: 'Unowned Customer',
      user_id: 'user-1',
      salesperson_name: 'Unowned Rep',
      status_id: 9,
      status_name: 'Unowned Status',
      imported_at: 77,
    });
    Object.assign(seeded.itemLines[0], {
      item_number: 5001,
      item_sku: 'UNOWNED-SKU',
      item_location: 'UNOWNED-LOCATION',
    });
    await cache.replaceDocumentSnapshot(seeded);
    const client = fakeClient(
      sourceDocument({ document_items: [] }),
      sourceDocument()
    );

    await expect(new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync({ preserveExistingEnrichment: false }))
      .rejects.toThrow(/no account ownership metadata.*explicitly clear/i);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      account_name: 'Unowned Customer',
      salesperson_name: 'Unowned Rep',
      status_name: 'Unowned Status',
      imported_at: 77,
    });
    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        item_number: 5001,
        item_sku: 'UNOWNED-SKU',
        item_location: 'UNOWNED-LOCATION',
      }),
    ]);
    expect(await cache.getCacheState()).toBeNull();
    expect(client.documents.list).not.toHaveBeenCalled();
    expect(client.documents.get).not.toHaveBeenCalled();
  });

  it('keeps an empty document bootstrap schema unpublished', async () => {
    const list = jest.fn().mockResolvedValue({ documents: [], pages: 1 });
    const client = {
      documents: { list, get: jest.fn() },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync({ full: true, preserveExistingEnrichment: false });

    expect(result).toMatchObject({ success: true, type: 'full' });
    expect(await cache.getCacheState()).toMatchObject({
      accountName: 'snapshot-test',
      schemaVersion: 0,
    });
  });

  it('preserves omitted item-line descriptive and receipt fields by compatible identity', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.itemLines[0], {
      item_name: 'Cached line name',
      line_description: 'Cached line description',
      quantity_received: 4,
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const detailed = sourceDocument();
    const detailedLine = detailed.document_items![0] as unknown as Record<string, unknown>;
    delete detailedLine.name;
    delete detailedLine.description;
    delete detailedLine.quantity_partially_received;
    const client = fakeClient(sourceDocument({ document_items: [] }), detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        item_name: 'Cached line name',
        line_description: 'Cached line description',
        quantity_received: 4,
      }),
    ]);
  });

  it('preserves compatible non-item metadata on omission and honors explicit null clears', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.nonItemLines[0], {
      name: 'Cached service',
      line_description: 'Cached service description',
      service_category_id: 'service-category-1',
      unit_id: 'hours',
      tax: 5,
      tax2: 2,
      weight: 3,
      source_created: '2026-07-01T00:00:00.000Z',
      source_modified: '2026-07-02T00:00:00.000Z',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());

    const listedLine = sourceItem({
      id: 'line-adjustment',
      item_id: undefined,
      name: 'Listed service',
    });
    const listedRecord = listedLine as unknown as Record<string, unknown>;
    for (const field of [
      'description',
      'service_category_id',
      'unit_id',
      'tax',
      'tax2',
      'weight',
      'created',
      'modified',
    ]) {
      delete listedRecord[field];
    }
    const listed = sourceDocument({ document_items: [listedLine] });

    const detailed = sourceDocument();
    const detailedLine = detailed.document_items![1] as unknown as Record<string, unknown>;
    Object.assign(detailedLine, {
      quantity: 2,
      price: -30,
      discount_percent: 10,
      unit_id: null,
    });
    for (const field of [
      'name',
      'description',
      'service_category_id',
      'tax',
      'tax2',
      'weight',
      'created',
      'modified',
    ]) {
      delete detailedLine[field];
    }

    expect((await new DocumentIndexerService(
      fakeClient(listed, detailed),
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    const [line] = await cache.getDocumentNonItemLines('doc-1');
    expect(line).toMatchObject({
      name: 'Listed service',
      line_description: 'Cached service description',
      service_category_id: 'service-category-1',
      unit_id: null,
      quantity: 2,
      price: -30,
      discount_percent: 10,
      total_amount: -60,
      net_amount: -54,
      tax: 5,
      tax2: 2,
      weight: 3,
      source_created: '2026-07-01T00:00:00.000Z',
      source_modified: '2026-07-02T00:00:00.000Z',
    });
    expect(JSON.parse(line.raw_classification ?? '{}')).toMatchObject({
      source_name: 'Listed service',
      service_category_id: 'service-category-1',
      unit_id: null,
    });
  });

  it('does not reuse identity-dependent metadata after the related identity changes', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      account_id: 'customer-old',
      account_name: 'Old Customer',
      user_id: 'user-old',
      salesperson_name: 'Old Rep',
      status_id: 8,
      status_name: 'Old Status',
      is_cancelled: 1,
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({
      document_items: [],
      customer_id: 'customer-1',
      user_id: 'user-1',
      status_id: 9,
    });
    const client = fakeClient(listed, sourceDocument());

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      account_name: null,
      salesperson_name: null,
      status_name: null,
      is_cancelled: 0,
    });
  });

  it('resolves nested-only changed salesperson and status identities before names', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.document, {
      user_id: 'user-old',
      salesperson_name: 'Old Rep',
      status_id: 8,
      status_name: 'Old Status',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({ document_items: [] });
    const detail = sourceDocument();
    delete (listed as unknown as Record<string, unknown>).user_id;
    delete (listed as unknown as Record<string, unknown>).status_id;
    delete (detail as unknown as Record<string, unknown>).user_id;
    delete (detail as unknown as Record<string, unknown>).status_id;
    Object.assign(detail, {
      user: { id: 'user-new', name: 'New Rep' },
      status: { id: 9, name: 'New Status' },
    });

    expect((await new DocumentIndexerService(
      fakeClient(listed, detail),
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getDocument('doc-1')).toMatchObject({
      user_id: 'user-new',
      salesperson_name: 'New Rep',
      status_id: 9,
      status_name: 'New Status',
    });
  });

  it('does not copy cached line enrichment across a changed item identity', async () => {
    const seeded = snapshot(90);
    Object.assign(seeded.itemLines[0], {
      item_id: 'old-item',
      item_number: 100,
      item_sku: 'OLD-SKU',
      item_location: 'OLD-LOCATION',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({ document_items: [] });
    const detailed = sourceDocument();
    detailed.document_items![0].item_id = 'new-item';
    const client = fakeClient(listed, detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        document_item_id: 'line-item',
        item_id: 'new-item',
        item_number: null,
        item_sku: null,
        item_location: null,
      }),
    ]);
  });

  it('does not use listed line enrichment from another nested document identity', async () => {
    await cache.setCacheState(cacheState());
    const listedLine = sourceItem({ document_id: 'other-doc' });
    Object.assign(listedLine, {
      item_number: 5001,
      item_sku: 'OTHER-DOC-SKU',
      item_location: 'OTHER-DOC-LOCATION',
    });
    const listed = sourceDocument({ document_items: [listedLine] });
    const detailed = sourceDocument();
    const detailLine = detailed.document_items![0] as unknown as Record<string, unknown>;
    delete detailLine.item_number;
    delete detailLine.item_sku;
    delete detailLine.item_location;
    const client = fakeClient(listed, detailed);

    expect((await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    expect(await cache.getItemDocuments('doc-1')).toEqual([
      expect.objectContaining({
        document_item_id: 'line-item',
        item_number: null,
        item_sku: null,
        item_location: null,
      }),
    ]);
  });

  it('preserves compatible CSV line metadata when API id replaces a synthetic document id', async () => {
    const seeded = snapshot(90);
    seeded.document.doc_id = 'csv-invoice-1001';
    seeded.document.api_doc_id = null;
    seeded.document.cache_source = 'csv';
    seeded.itemLines[0].doc_id = 'csv-invoice-1001';
    Object.assign(seeded.itemLines[0], {
      item_number: 5001,
      item_sku: 'CSV-SKU',
      item_location: 'CSV warehouse',
    });
    seeded.nonItemLines[0].doc_id = 'csv-invoice-1001';
    Object.assign(seeded.nonItemLines[0], {
      name: 'CSV adjustment',
      service_category_id: 'csv-service',
      unit_id: 'hours',
    });
    await cache.replaceDocumentSnapshot(seeded);
    await cache.setCacheState(cacheState());
    const detail = sourceDocument();
    const itemLine = detail.document_items![0] as unknown as Record<string, unknown>;
    delete itemLine.item_number;
    delete itemLine.item_sku;
    delete itemLine.item_location;
    const nonItemLine = detail.document_items![1] as unknown as Record<string, unknown>;
    delete nonItemLine.name;
    delete nonItemLine.service_category_id;
    delete nonItemLine.unit_id;

    expect((await new DocumentIndexerService(
      fakeClient(sourceDocument({ document_items: [] }), detail),
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync()).success).toBe(true);

    const storedDocument = await cache.getDocumentByApiId('doc-1');
    expect(storedDocument).toBeDefined();
    expect(await cache.getItemDocuments(storedDocument!.doc_id)).toEqual([
      expect.objectContaining({
        item_number: 5001,
        item_sku: 'CSV-SKU',
        item_location: 'CSV warehouse',
      }),
    ]);
    expect(await cache.getDocumentNonItemLines(storedDocument!.doc_id)).toEqual([
      expect.objectContaining({
        name: 'CSV adjustment',
        service_category_id: 'csv-service',
        unit_id: 'hours',
      }),
    ]);
    expect(storedDocument).toMatchObject({
      doc_id: 'csv-invoice-1001',
      api_doc_id: 'doc-1',
    });
  });

  it('keeps listed metadata when detail succeeds on retry', async () => {
    await cache.setCacheState(cacheState());
    const listed = sourceDocument({
      document_items: [],
      user: { id: 'user-1', name: 'Listed Retry Rep' },
    });
    const client = fakeClient(listed, sourceDocument());
    client.documents.get
      .mockRejectedValueOnce(new Error('temporary detail failure'))
      .mockResolvedValue(sourceDocument());

    const result = await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync();

    expect(result.success).toBe(true);
    expect(await cache.getDocument('doc-1')).toMatchObject({
      user_id: 'user-1',
      salesperson_name: 'Listed Retry Rep',
    });
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

  it('keeps a resumed retry when its list metadata cannot be refreshed', async () => {
    await cache.replaceDocumentSnapshot(snapshot(90));
    await cache.setCacheState({
      ...cacheState(),
      documentSyncCheckpoint: {
        accountName: 'snapshot-test',
        syncType: 'delta',
        phase: 'primary',
        startedAt: 90,
        sourceModifiedSince: 80,
        nextContextIndex: 3,
        nextPage: 1,
        retryDocumentIds: ['doc-1'],
        retryDocumentIdentities: {
          'doc-1': { contextId: DocumentContextId.Invoice, documentNumber: 1001 },
        },
      },
    });
    const list = jest.fn().mockRejectedValue(new Error('list unavailable'));
    const get = jest.fn().mockResolvedValue(sourceDocument());
    const client = {
      documents: { list, get },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync();

    expect(result).toMatchObject({
      success: false,
      failedDocuments: 1,
      retryDocumentIds: ['doc-1'],
    });
    expect(get).not.toHaveBeenCalled();
    expect((await cache.getCacheState())?.documentSyncCheckpoint).toMatchObject({
      retryDocumentIds: ['doc-1'],
      retryDocumentIdentities: {
        'doc-1': { contextId: DocumentContextId.Invoice, documentNumber: 1001 },
      },
    });
  });

  it('keeps a legacy resumed retry that has no recoverable list identity', async () => {
    await cache.setCacheState({
      ...cacheState(),
      documentSyncCheckpoint: {
        accountName: 'snapshot-test',
        syncType: 'delta',
        phase: 'primary',
        startedAt: 90,
        sourceModifiedSince: 80,
        nextContextIndex: 3,
        nextPage: 1,
        retryDocumentIds: ['doc-new'],
      },
    });
    const get = jest.fn().mockResolvedValue(sourceDocument({ id: 'doc-new' }));
    const client = {
      documents: { list: jest.fn(), get },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(
      client,
      cache,
      'snapshot-test',
      3600,
      604800,
      100_000
    ).sync();

    expect(result).toMatchObject({
      success: false,
      failedDocuments: 1,
      retryDocumentIds: ['doc-new'],
    });
    expect(get).not.toHaveBeenCalled();
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
        retryDocumentIdentities: {
          'doc-1': { contextId: DocumentContextId.Invoice, documentNumber: 1001 },
        },
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
    expect((await cache.getCacheState())?.schemaVersion).toBe(CACHE_SCHEMA_VERSION - 1);
  });

  it('retains and checkpoints a listed document when detail returns 404', async () => {
    await cache.replaceDocumentSnapshot(snapshot(90));
    await cache.setCacheState(cacheState());
    const client = fakeClient(sourceDocument({ document_items: [] }), sourceDocument());
    client.documents.get.mockRejectedValue({ response: { status: 404 } });
    const indexer = new DocumentIndexerService(client, cache, 'snapshot-test', 3600, 604800, 100_000);

    const result = await indexer.sync();

    expect(result).toMatchObject({
      success: false,
      type: 'delta',
      documentsDeleted: 0,
      failedDocuments: 1,
      retryDocumentIds: ['doc-1'],
    });
    expect(await cache.getDocument('doc-1')).toBeDefined();
  });

  it('retains a CSV-seeded synthetic row when listed API detail returns 404', async () => {
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

    expect((await indexer.sync()).success).toBe(false);

    expect(await cache.getDocument('csv-invoice-1001')).toBeDefined();
    expect(await cache.getDocumentCount()).toBe(1);
  });

  it('keeps a resumed detail 404 checkpoint without deleting a synthetic CSV row', async () => {
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
    expect((await indexer.sync()).success).toBe(false);
    expect(await cache.getDocument('csv-invoice-1001')).toBeDefined();
    expect((await cache.getCacheState())?.documentSyncCheckpoint?.retryDocumentIds)
      .toEqual(['doc-1']);
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
