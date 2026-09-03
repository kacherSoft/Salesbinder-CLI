/**
 * PG → SQLite sync service unit tests
 *
 * Tests the explicit pull flow using two SQLite instances to simulate PG
 * since PG may not be available in CI.
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { pullFromPostgres } from '../pg-to-sqlite-sync.service.js';
import { createCategoryFingerprint } from '../category-indexer.service.js';
import type { PgPullLifecycleOptions, PgPullResult, PgPullSettlement } from '../index.js';
import {
  CACHE_SCHEMA_VERSION,
  DocumentContextId,
  createInventorySnapshotFingerprint,
} from '../types.js';
import type {
  AccountRow,
  CacheState,
  CacheSyncStatus,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemStockLocationRow,
} from '../types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from '../payment-sync.types.js';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PgToSqliteSyncService', () => {
  describe('SQLite ↔ SQLite pull simulation', () => {
    // Simulate PG→SQLite by using two SQLite instances
    let sourceDb: SQLiteCacheService;
    let targetDb: SQLiteCacheService;
    let sourcePath: string;
    let targetPath: string;

    const testDocs: DocumentRow[] = [
      {
        doc_id: 'doc-001',
        context_id: DocumentContextId.Invoice,
        doc_number: 1001,
        issue_date: '2026-01-15',
        customer_id: 'cust-a',
        modified: 1705300000,
        date_sent: '2026-01-16',
        shipped_percent: 75,
        archived: 1,
      },
      {
        doc_id: 'doc-002',
        context_id: DocumentContextId.Estimate,
        doc_number: 2001,
        issue_date: '2026-02-10',
        customer_id: 'cust-b',
        modified: 1707500000,
        archived: 0,
      },
      {
        doc_id: 'doc-003',
        context_id: DocumentContextId.PurchaseOrder,
        doc_number: 3001,
        issue_date: '2026-03-05',
        customer_id: 'cust-a',
        modified: 1709600000,
        archived: null,
      },
    ];

    const testItems: Array<Omit<ItemDocumentRow, 'id'>> = [
      { item_id: 'item-x', doc_id: 'doc-001', quantity: 10, quantity_shipped: 7.5, price: 25.5 },
      { item_id: 'item-y', doc_id: 'doc-001', quantity: 5, price: 100 },
      { item_id: 'item-x', doc_id: 'doc-002', quantity: 3, price: 30 },
    ];

    beforeEach(async () => {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2);
      sourcePath = join(tmpdir(), `test-source-${ts}-${rand}.db`);
      targetPath = join(tmpdir(), `test-target-${ts}-${rand}.db`);
      sourceDb = new SQLiteCacheService('source', sourcePath);
      targetDb = new SQLiteCacheService('target', targetPath);

      // Populate source with test data
      await sourceDb.batchInsertDocuments(testDocs);
      await sourceDb.batchInsertItems([
        { item_id: 'master-active', name: 'Active', archived: 0 },
        { item_id: 'master-archived', name: 'Archived', archived: 1 },
        { item_id: 'master-unknown', name: 'Unknown', archived: null },
      ]);
      await sourceDb.batchInsertItemDocuments(testItems);
      await sourceDb.setCacheState({
        lastSync: 1709700000,
        lastFullSync: 1709600000,
        documentCount: 3,
        itemDocumentCount: 3,
        accountName: 'test',
        schemaVersion: 1,
      });
    });

    afterEach(async () => {
      await sourceDb.close();
      await targetDb.close();
      for (const p of [sourcePath, targetPath]) {
        try {
          rmSync(p);
          rmSync(`${p}-wal`, { force: true });
          rmSync(`${p}-shm`, { force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it('should copy all documents from source to target', async () => {
      // Read from source
      const sourceDocs = await sourceDb.getDocumentsModifiedSince(0);
      expect(sourceDocs.length).toBe(3);

      // Target should be empty
      const beforeDocs = await targetDb.getDocumentsModifiedSince(0);
      expect(beforeDocs.length).toBe(0);

      // Simulate pull: batch insert source docs into target
      await targetDb.batchInsertDocuments(sourceDocs);

      const afterDocs = await targetDb.getDocumentsModifiedSince(0);
      expect(afterDocs.length).toBe(3);
      expect(afterDocs.map((d) => d.doc_id).sort()).toEqual(['doc-001', 'doc-002', 'doc-003']);
      expect(afterDocs.map(({ archived }) => archived).sort()).toEqual([null, 0, 1].sort());
      expect(await targetDb.getDocument('doc-001')).toMatchObject({
        date_sent: '2026-01-16',
        shipped_percent: 75,
      });
    });

    it('should copy tri-state lifecycle values for master items', async () => {
      await targetDb.batchInsertItems(await sourceDb.getAllItems());

      expect((await targetDb.getAllItems()).map(({ archived }) => archived).sort()).toEqual(
        [null, 0, 1].sort()
      );
    });

    it('should copy all item documents from source to target', async () => {
      // Get items from source via doc lookup
      const doc1Items = await sourceDb.getItemDocuments('doc-001');
      const doc2Items = await sourceDb.getItemDocuments('doc-002');
      expect(doc1Items.length).toBe(2);
      expect(doc2Items.length).toBe(1);

      // Insert docs first (FK constraint)
      const sourceDocs = await sourceDb.getDocumentsModifiedSince(0);
      await targetDb.batchInsertDocuments(sourceDocs);

      // Copy item documents
      const allItems = [...doc1Items, ...doc2Items].map((i) => ({
        item_id: i.item_id,
        doc_id: i.doc_id,
        quantity: i.quantity,
        price: i.price,
        quantity_shipped: i.quantity_shipped,
      }));
      await targetDb.batchInsertItemDocuments(allItems);

      const targetDoc1Items = await targetDb.getItemDocuments('doc-001');
      const targetDoc2Items = await targetDb.getItemDocuments('doc-002');
      expect(targetDoc1Items.length).toBe(2);
      expect(targetDoc2Items.length).toBe(1);
      expect(targetDoc1Items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item_id: 'item-x', quantity_shipped: 7.5 }),
        ])
      );
    });

    it('should copy cache state from source to target', async () => {
      const sourceState = await sourceDb.getCacheState();
      expect(sourceState).not.toBeNull();

      await targetDb.setCacheState(sourceState!);
      const targetState = await targetDb.getCacheState();

      expect(targetState).toEqual(sourceState);
    });

    it('should clear target before pull (full replace)', async () => {
      // Pre-populate target with different data
      await targetDb.insertDocument({
        doc_id: 'old-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 9999,
        issue_date: '2025-01-01',
        customer_id: 'old-cust',
        modified: 1000000,
      });

      const beforeCount = await targetDb.getDocumentCount();
      expect(beforeCount).toBe(1);

      // Clear target
      const oldDocs = await targetDb.getDocumentsModifiedSince(0);
      await targetDb.batchDeleteDocuments(oldDocs.map((d) => d.doc_id));

      // Insert source data
      const sourceDocs = await sourceDb.getDocumentsModifiedSince(0);
      await targetDb.batchInsertDocuments(sourceDocs);

      const afterCount = await targetDb.getDocumentCount();
      expect(afterCount).toBe(3);

      // Old doc should be gone
      const oldDoc = await targetDb.getDocument('old-doc');
      expect(oldDoc).toBeUndefined();
    });

    it('replaceMirror rolls back rows and metadata when a snapshot insert fails', async () => {
      const oldState: CacheState = {
        lastSync: 100,
        lastFullSync: 90,
        documentCount: 1,
        itemDocumentCount: 0,
        accountName: 'target',
        schemaVersion: CACHE_SCHEMA_VERSION,
      };
      const oldPaymentStatus: PaymentSyncStatus = {
        status: 'complete',
        mode: 'full',
        startedAt: 80,
        updatedAt: 90,
        finishedAt: 90,
        lastSuccessfulSync: 90,
        cursor: 'old-doc',
        processedDocuments: 1,
        totalDocuments: 1,
      };
      await targetDb.insertDocument({
        doc_id: 'old-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 9999,
        issue_date: '2025-01-01',
        customer_id: 'old-cust',
        modified: 100,
      });
      await targetDb.setCacheState(oldState);
      await targetDb.setPaymentSyncStatus(oldPaymentStatus);
      targetDb.setRawMeta('pg_pull_timestamp', '12345');

      expect(() =>
        targetDb.replaceMirror({
          accounts: [],
          categorySnapshot: null,
          items: [],
          itemStockLocations: [],
          documents: [
            {
              doc_id: 'new-doc',
              context_id: DocumentContextId.Invoice,
              doc_number: 1001,
              issue_date: '2026-01-01',
              customer_id: 'new-cust',
              modified: 200,
            },
          ],
          itemDocuments: [],
          paymentTransactions: [payment('orphan-payment', 'missing-doc')],
          cacheState: {
            lastSync: 200,
            lastFullSync: 200,
            documentCount: 1,
            itemDocumentCount: 0,
            accountName: 'source',
            schemaVersion: CACHE_SCHEMA_VERSION,
          },
          paymentSyncStatus: null,
          pulledAt: 99999,
        })
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(await targetDb.getDocument('old-doc')).toBeDefined();
      expect(await targetDb.getDocument('new-doc')).toBeUndefined();
      expect(await targetDb.getCacheState()).toEqual(oldState);
      expect(await targetDb.getPaymentSyncStatus()).toEqual(oldPaymentStatus);
      expect(targetDb.getRawMeta('pg_pull_timestamp')).toBe(12345);
    });

    it('replaceMirror copies a full snapshot and replaces previous mirror contents', async () => {
      const account: AccountRow = {
        account_id: 'cust-new',
        context_id: 2,
        account_number: 7001,
        name: 'New Customer',
        archived: 0,
      };
      const item: ItemRow = {
        item_id: 'master-new',
        item_number: 8001,
        name: 'New Master Item',
        sku: 'NEW',
        archived: 1,
      };
      const stock: ItemStockLocationRow = {
        stock_row_id: 'stock-new',
        item_id: 'master-new',
        location_id: 'loc-1',
        location_name: 'Main',
        quantity_on_hand: 5,
        quantity_reserved: 1,
        quantity_available: 4,
        quantity_incoming: 0,
        in_transit: 0,
      };
      const document: DocumentRow = {
        doc_id: 'doc-new',
        context_id: DocumentContextId.Invoice,
        doc_number: 7001,
        issue_date: '2026-07-01',
        customer_id: 'cust-new',
        modified: 300,
        date_sent: '2026-07-02',
        shipped_percent: 50,
        archived: 0,
      };
      const cacheState: CacheState = {
        lastSync: 300,
        lastFullSync: 300,
        documentCount: 1,
        itemDocumentCount: 1,
        accountName: 'source',
        schemaVersion: CACHE_SCHEMA_VERSION,
        accountCount: 1,
        itemCount: 1,
        stockLocationCount: 1,
      };
      const paymentStatus: PaymentSyncStatus = {
        status: 'complete',
        mode: 'full',
        startedAt: 250,
        updatedAt: 300,
        finishedAt: 300,
        lastSuccessfulSync: 300,
        cursor: 'doc-new',
        processedDocuments: 1,
        totalDocuments: 1,
      };
      await targetDb.insertDocument({
        doc_id: 'old-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 9999,
        issue_date: '2025-01-01',
        customer_id: 'old-cust',
        modified: 100,
      });

      await targetDb.replaceMirror({
        accounts: [account],
        categorySnapshot: null,
        items: [item],
        itemStockLocations: [stock],
        documents: [document],
        itemDocuments: [
          {
            item_id: 'master-new',
            doc_id: 'doc-new',
            quantity: 2,
            quantity_shipped: 1.5,
            price: 50,
            document_item_id: 'line-new',
          },
        ],
        paymentTransactions: [payment('payment-new', 'doc-new')],
        cacheState,
        paymentSyncStatus: paymentStatus,
        pulledAt: 54321,
      });

      expect(await targetDb.getDocument('old-doc')).toBeUndefined();
      expect(await targetDb.getAllAccounts()).toEqual([expect.objectContaining(account)]);
      expect(await targetDb.getAllItems()).toEqual([expect.objectContaining(item)]);
      expect(await targetDb.getAllItemStockLocations()).toEqual([expect.objectContaining(stock)]);
      expect(await targetDb.getDocument('doc-new')).toMatchObject(document);
      expect(await targetDb.getItemDocuments('doc-new')).toEqual([
        expect.objectContaining({ document_item_id: 'line-new', quantity_shipped: 1.5 }),
      ]);
      expect(await targetDb.getAllPaymentTransactions()).toEqual([
        payment('payment-new', 'doc-new'),
      ]);
      expect(await targetDb.getCacheState()).toEqual(cacheState);
      expect(await targetDb.getPaymentSyncStatus()).toEqual(paymentStatus);
      expect(targetDb.getRawMeta('pg_pull_timestamp')).toBe(54321);
    });

    it('replaceMirror preserves warning inventory metadata after final category reconciliation', async () => {
      const accountIdentity = 'salesbinder:mirror';
      const item: ItemRow = {
        item_id: 'mirror-v3-item',
        name: 'Mirror v3 item',
        quantity: 4,
        quantity_reserved: 1,
        quantity_available: 3,
        category_id: 'category-1',
        category_name: 'Canonical category',
        cache_source: 'api',
        source_api_version: '3',
      };
      const stock: ItemStockLocationRow = {
        stock_row_id: 'mirror-v3-stock',
        item_id: item.item_id,
        category_name: 'Canonical category',
        quantity_on_hand: 4,
        quantity_reserved: 1,
        quantity_available: 3,
        quantity_incoming: null,
        in_transit: null,
        cache_source: 'api',
        source_api_version: '3',
      };
      const inventoryCacheMeta = {
        version: 2 as const,
        status: 'complete_with_warnings' as const,
        accountIdentity,
        startedAt: 400,
        completedAt: 401,
        itemCount: 1,
        stockRowCount: 1,
        schemaVersion: 7 as const,
        sourceApiVersion: '3' as const,
        generation: 'mirror-inventory-generation',
        fingerprint: createInventorySnapshotFingerprint(
          accountIdentity,
          'mirror-inventory-generation',
          [item],
          [stock]
        ),
        freshItemCount: 0,
        preservedItemCount: 1,
        omittedItemCount: 1,
        warningCount: 2,
        lastCompleteAt: 390,
      };
      const categoryRows = [
        {
          category_id: 'category-1',
          name: 'Canonical category',
          item_count: 1,
          parent_id: null,
          parent_name: null,
          inventory_type: 'quantity' as const,
          custom_fields_json: null,
          created: null,
          modified: 401,
          cache_source: 'api' as const,
          source_api_version: '3' as const,
          imported_at: 401,
        },
      ];
      const categoryMeta = {
        version: 1 as const,
        status: 'complete' as const,
        accountIdentity,
        startedAt: 400,
        completedAt: 401,
        count: 1,
        page: 1,
        pages: 1,
        sourceRowCount: 1,
        storedRowCount: 1,
        schemaVersion: 7 as const,
        sourceApiVersion: '3' as const,
        generation: 'mirror-category-generation',
      };

      await targetDb.replaceMirror({
        accounts: [],
        categorySnapshot: {
          rows: categoryRows,
          meta: {
            ...categoryMeta,
            fingerprint: createCategoryFingerprint(categoryMeta, categoryRows, 7),
          },
        },
        inventoryCacheMeta,
        items: [item],
        itemStockLocations: [stock],
        documents: [],
        itemDocuments: [],
        paymentTransactions: [],
        cacheState: {
          lastSync: 401,
          lastFullSync: 401,
          documentCount: 0,
          itemDocumentCount: 0,
          accountName: 'mirror',
          schemaVersion: 7,
          inventorySourceApiVersion: '3',
        },
        paymentSyncStatus: null,
        pulledAt: 401,
      });

      expect(await targetDb.getInventoryCacheMeta()).toEqual(inventoryCacheMeta);
      expect((await targetDb.getItem(item.item_id))?.category_name).toBe('Canonical category');
      expect((await targetDb.getItemStockLocations(item.item_id))[0].category_name).toBe(
        'Canonical category'
      );
      expect((await targetDb.getCacheState())?.inventorySourceApiVersion).toBe('3');
    });

    it('getRawMeta / setRawMeta should store and retrieve pull timestamp', () => {
      const now = Date.now();
      targetDb.setRawMeta('pg_pull_timestamp', String(now));
      const retrieved = targetDb.getRawMeta('pg_pull_timestamp');
      expect(retrieved).toBe(now);
    });

    it('getRawMeta should return null for missing key', () => {
      const result = targetDb.getRawMeta('nonexistent_key');
      expect(result).toBeNull();
    });
  });

  describe('protected lifecycle settlement', () => {
    const binding = {
      accountIdentity: 'salesbinder:pull-lifecycle',
      accountSubdomain: 'pull-lifecycle',
    };
    const originalPostgresClose = PostgresCacheService.prototype.close;
    const originalSqliteClose = SQLiteCacheService.prototype.close;
    const originalSqliteReplaceMirror = SQLiteCacheService.prototype.replaceMirror;
    let events: string[];
    let sqlitePath: string;
    let mirrorFailure: Error | null;
    let sqliteStatusFailure: Error | null;
    let sqliteStatusFailuresRemaining: number;
    let pgStatusFailure: Error | null;
    let pgSyncStatus: CacheSyncStatus | null;
    let attemptedSqliteStatuses: CacheSyncStatus[];
    let mirroredSyncStatuses: CacheSyncStatus[];
    let compensatedPgStatuses: CacheSyncStatus[];

    beforeEach(() => {
      events = [];
      mirrorFailure = null;
      sqliteStatusFailure = null;
      sqliteStatusFailuresRemaining = 0;
      pgStatusFailure = null;
      pgSyncStatus = cleanSyncStatus();
      attemptedSqliteStatuses = [];
      mirroredSyncStatuses = [];
      compensatedPgStatuses = [];
      sqlitePath = join(
        tmpdir(),
        `test-pull-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );

      jest.spyOn(PostgresCacheService.prototype, 'ensureSchema').mockResolvedValue(undefined);
      jest
        .spyOn(PostgresCacheService.prototype, 'verifyAccountBinding')
        .mockResolvedValue(undefined);
      jest
        .spyOn(PostgresCacheService.prototype, 'tryAcquireSyncLock')
        .mockImplementation(async () => {
          events.push('postgres-lock-acquired');
          return true;
        });
      jest.spyOn(PostgresCacheService.prototype, 'getDocumentsByContext').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getDocumentsModifiedSince').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getItemDocuments').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getAllPaymentTransactions').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getAllAccounts').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getCategorySnapshot').mockResolvedValue(null);
      jest.spyOn(PostgresCacheService.prototype, 'getInventoryCacheMeta').mockResolvedValue(null);
      jest.spyOn(PostgresCacheService.prototype, 'getAllItems').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getAllItemStockLocations').mockResolvedValue([]);
      jest.spyOn(PostgresCacheService.prototype, 'getCacheState').mockResolvedValue(null);
      jest.spyOn(PostgresCacheService.prototype, 'getPaymentSyncStatus').mockResolvedValue(null);
      jest.spyOn(PostgresCacheService.prototype, 'getSyncStatus').mockImplementation(async () => {
        events.push('postgres-status-read');
        return pgSyncStatus;
      });
      jest
        .spyOn(PostgresCacheService.prototype, 'setSyncStatus')
        .mockImplementation(async (status) => {
          events.push('postgres-status-written');
          if (pgStatusFailure) throw pgStatusFailure;
          compensatedPgStatuses.push(status);
        });
      jest.spyOn(PostgresCacheService.prototype, 'releaseSyncLock').mockImplementation(async () => {
        events.push('postgres-lock-released');
      });
      jest.spyOn(PostgresCacheService.prototype, 'close').mockImplementation(async function (
        this: PostgresCacheService
      ) {
        events.push('postgres-closed');
        await originalPostgresClose.call(this);
      });

      jest.spyOn(SQLiteCacheService.prototype, 'verifyAccountBinding').mockResolvedValue(undefined);
      jest
        .spyOn(SQLiteCacheService.prototype, 'tryAcquireSyncLock')
        .mockImplementation(async () => {
          events.push('sqlite-lock-acquired');
          return true;
        });
      jest.spyOn(SQLiteCacheService.prototype, 'replaceMirror').mockImplementation(async () => {
        events.push('mirror-replaced');
        if (mirrorFailure) throw mirrorFailure;
      });
      jest
        .spyOn(SQLiteCacheService.prototype, 'setSyncStatus')
        .mockImplementation(async (status) => {
          events.push('sqlite-status-written');
          attemptedSqliteStatuses.push(status);
          if (sqliteStatusFailure && sqliteStatusFailuresRemaining > 0) {
            sqliteStatusFailuresRemaining--;
            throw sqliteStatusFailure;
          }
          mirroredSyncStatuses.push(status);
        });
      jest.spyOn(SQLiteCacheService.prototype, 'releaseSyncLock').mockImplementation(async () => {
        events.push('sqlite-lock-released');
      });
      jest.spyOn(SQLiteCacheService.prototype, 'close').mockImplementation(async function (
        this: SQLiteCacheService
      ) {
        events.push('sqlite-closed');
        await originalSqliteClose.call(this);
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      for (const path of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
        rmSync(path, { force: true });
      }
    });

    const pullWithOptions = (options?: PgPullLifecycleOptions): Promise<PgPullResult> =>
      pullFromPostgres('postgres://example/cache', 'pull-lifecycle', sqlitePath, binding, options);

    it('mirrors documents with null or zero modified values and their dependent bundles', async () => {
      const nullModifiedDocument: DocumentRow = {
        doc_id: 'csv-invoice-null-modified',
        context_id: DocumentContextId.Invoice,
        doc_number: 4101,
        issue_date: '2026-08-01',
        customer_id: 'customer-1',
        modified: null as unknown as number,
        cache_source: 'csv',
      };
      const zeroModifiedDocument: DocumentRow = {
        doc_id: 'csv-estimate-zero-modified',
        context_id: DocumentContextId.Estimate,
        doc_number: 4102,
        issue_date: '2026-08-02',
        customer_id: 'customer-2',
        modified: 0,
        cache_source: 'csv',
      };
      const lines: Array<Omit<ItemDocumentRow, 'id'>> = [
        {
          document_item_id: 'line-null-modified',
          item_id: 'item-1',
          doc_id: nullModifiedDocument.doc_id,
          quantity: 1,
          price: 10,
        },
        {
          document_item_id: 'line-zero-modified',
          item_id: 'item-2',
          doc_id: zeroModifiedDocument.doc_id,
          quantity: 2,
          price: 20,
        },
      ];
      const payments = [payment('payment-null-modified', nullModifiedDocument.doc_id)];
      const getDocumentsByContext = jest
        .mocked(PostgresCacheService.prototype.getDocumentsByContext)
        .mockImplementation(async (contextId) => {
          if (contextId === DocumentContextId.Invoice) return [nullModifiedDocument];
          if (contextId === DocumentContextId.Estimate) return [zeroModifiedDocument];
          return [];
        });
      jest
        .mocked(PostgresCacheService.prototype.getItemDocuments)
        .mockImplementation(async (docId) => lines.filter((line) => line.doc_id === docId));
      jest
        .mocked(PostgresCacheService.prototype.getAllPaymentTransactions)
        .mockResolvedValue(payments);
      jest.mocked(SQLiteCacheService.prototype.replaceMirror).mockImplementation(function (
        this: SQLiteCacheService,
        snapshot
      ) {
        events.push('mirror-replaced');
        return originalSqliteReplaceMirror.call(this, snapshot);
      });

      const result = await pullWithOptions();

      expect(result).toEqual(
        expect.objectContaining({
          documentsPulled: 2,
          itemDocumentsPulled: 2,
          paymentTransactionsPulled: 1,
        })
      );
      expect(getDocumentsByContext.mock.calls.map(([contextId]) => contextId)).toEqual([
        DocumentContextId.Estimate,
        DocumentContextId.Invoice,
        DocumentContextId.PurchaseOrder,
      ]);
      expect(PostgresCacheService.prototype.getDocumentsModifiedSince).not.toHaveBeenCalled();
      expect(SQLiteCacheService.prototype.replaceMirror).toHaveBeenCalledWith(
        expect.objectContaining({
          documents: [zeroModifiedDocument, { ...nullModifiedDocument, modified: 0 }],
          itemDocuments: expect.arrayContaining(lines.map((line) => expect.objectContaining(line))),
          paymentTransactions: payments,
        })
      );
      const mirroredDb = new SQLiteCacheService('pull-lifecycle', sqlitePath);
      expect(await mirroredDb.getDocumentsByContext(DocumentContextId.Invoice)).toEqual([
        expect.objectContaining({ doc_id: nullModifiedDocument.doc_id, modified: 0 }),
      ]);
      expect(await mirroredDb.getDocumentsByContext(DocumentContextId.Estimate)).toEqual([
        expect.objectContaining({ doc_id: zeroModifiedDocument.doc_id, modified: 0 }),
      ]);
      expect(await mirroredDb.getItemDocuments(nullModifiedDocument.doc_id)).toEqual([
        expect.objectContaining(lines[0]),
      ]);
      expect(await mirroredDb.getItemDocuments(zeroModifiedDocument.doc_id)).toEqual([
        expect.objectContaining(lines[1]),
      ]);
      expect(await mirroredDb.getAllPaymentTransactions()).toEqual(payments);
      await mirroredDb.close();
    });

    it('mirrors a terminal warning status written by the success hook before releasing locks', async () => {
      const documentId = 'document-warning-with-stable-id';
      const itemId = 'item-warning-with-stable-id';
      const hook = jest.fn(async () => {
        events.push('success-hook');
        pgSyncStatus = {
          ...cleanSyncStatus(),
          status: 'success_with_warnings',
          message: 'untrusted source text',
          recordIssues: [
            {
              resource: 'document',
              id: documentId,
              context_id: 5,
              code: 'not_found',
              message: 'untrusted source text',
              attempts: 2,
              outcome: 'preserved_last_known_good',
            },
            {
              resource: 'item',
              id: itemId,
              code: 'invalid_variations',
              message: 'untrusted source text',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
          unexpected: 'must not be mirrored',
        } as CacheSyncStatus;
      });

      await pullWithOptions({ onSettledWhileLocked: hook });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(mirroredSyncStatuses).toEqual([
        expect.objectContaining({
          status: 'success_with_warnings',
          message: 'Sync completed with warnings',
          recordIssues: [
            expect.objectContaining({
              id: documentId,
              message: 'Document unavailable during refresh',
              attempts: 2,
            }),
            expect.objectContaining({
              id: itemId,
              message: 'Item variations failed source validation',
              attempts: 2,
            }),
          ],
        }),
      ]);
      expect(mirroredSyncStatuses[0]).not.toHaveProperty('unexpected');
      expect(JSON.stringify(mirroredSyncStatuses)).not.toContain('untrusted source text');
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it.each([1, 999])(
      'rejects warning attempts %s without mirroring the untrusted terminal status',
      async (attempts) => {
        const hook = jest.fn(async () => {
          events.push('success-hook');
          pgSyncStatus = {
            ...cleanSyncStatus(),
            status: 'success_with_warnings',
            recordIssues: [
              {
                resource: 'item',
                id: 'invalid-attempt-count-warning',
                code: 'invalid_record',
                message: 'untrusted source text',
                attempts,
                outcome: 'omitted_new',
              },
            ],
          } as unknown as CacheSyncStatus;
        });

        await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toThrow(
          'PostgreSQL sync record issue is invalid.'
        );

        expect(hook).toHaveBeenCalledTimes(1);
        expect(attemptedSqliteStatuses).toEqual([
          expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
        ]);
        expect(mirroredSyncStatuses).toEqual([
          expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
        ]);
        expect(mirroredSyncStatuses).not.toContainEqual(
          expect.objectContaining({ status: 'success_with_warnings' })
        );
        expect(mirroredSyncStatuses[0]).not.toHaveProperty('recordIssues');
        expect(JSON.stringify(mirroredSyncStatuses)).not.toContain('invalid-attempt-count-warning');
        expect(compensatedPgStatuses).toEqual([
          expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
        ]);
        expect(events).toEqual([
          'postgres-lock-acquired',
          'sqlite-lock-acquired',
          'mirror-replaced',
          'postgres-status-read',
          'success-hook',
          'postgres-status-read',
          'sqlite-status-written',
          'postgres-status-written',
          'sqlite-lock-released',
          'postgres-lock-released',
          'postgres-closed',
          'sqlite-closed',
        ]);
      }
    );

    it('sorts mirrored warning identifiers by UTF-16 code units', async () => {
      pgSyncStatus = {
        ...cleanSyncStatus(),
        status: 'success_with_warnings',
        recordIssues: ['😀', 'é', 'ä', 'z'].map((id) => ({
          resource: 'item' as const,
          id,
          code: 'not_found' as const,
          message: 'untrusted source text',
          attempts: 2,
          outcome: 'omitted_new' as const,
        })),
      };

      await pullWithOptions({ onSettledWhileLocked: async () => undefined });

      expect(mirroredSyncStatuses[0].recordIssues?.map(({ id }) => id)).toEqual([
        'z',
        'ä',
        'é',
        '😀',
      ]);
    });

    it.each([
      ['run ID', { runId: 'pull-\ud800' }],
      ['account name', { accountName: 'account-\udc00' }],
    ])('rejects an unpaired surrogate in mirrored sync status %s', async (_label, override) => {
      pgSyncStatus = { ...cleanSyncStatus(), ...override };

      await expect(pullWithOptions()).rejects.toThrow(
        'PostgreSQL sync status identifier is invalid.'
      );

      expect(attemptedSqliteStatuses).toEqual([]);
      expect(mirroredSyncStatuses).toEqual([]);
    });

    it.each(['warning-\ud800', 'warning-\udc00'])(
      'rejects an unpaired surrogate in mirrored warning ID %j',
      async (id) => {
        pgSyncStatus = {
          ...cleanSyncStatus(),
          status: 'success_with_warnings',
          recordIssues: [
            {
              resource: 'item',
              id,
              code: 'invalid_record',
              message: 'untrusted source text',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
        };

        await expect(pullWithOptions()).rejects.toThrow(
          'PostgreSQL sync status identifier is invalid.'
        );

        expect(attemptedSqliteStatuses).toEqual([]);
        expect(mirroredSyncStatuses).toEqual([]);
      }
    );

    it('runs the success hook after result construction and before either lock releases', async () => {
      const result = await pullWithOptions({
        onSettledWhileLocked: ({ status, ...settlement }) => {
          expect(status).toBe('success');
          expect('result' in settlement && settlement.result.success).toBe(true);
          events.push('success-hook');
        },
      });

      expect(result.success).toBe(true);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('awaits the success hook before resolving or releasing locks', async () => {
      let resolveHook!: () => void;
      let signalHookStarted!: () => void;
      const hookStarted = new Promise<void>((resolve) => {
        signalHookStarted = resolve;
      });
      const hookGate = new Promise<void>((resolve) => {
        resolveHook = resolve;
      });
      let pullResolved = false;

      const pull = pullWithOptions({
        onSettledWhileLocked: async () => {
          events.push('hook-started');
          signalHookStarted();
          await hookGate;
          events.push('hook-finished');
        },
      });
      void pull.then(() => {
        pullResolved = true;
      });
      await hookStarted;

      expect(pullResolved).toBe(false);
      expect(events).not.toContain('sqlite-lock-released');
      expect(events).not.toContain('postgres-lock-released');

      resolveHook();
      await pull;
      expect(events.indexOf('hook-finished')).toBeLessThan(events.indexOf('sqlite-lock-released'));
    });

    it('treats a successful-pull hook rejection as fatal and still cleans up both locks', async () => {
      const hookError = new Error('terminal persistence failed');
      const hook = jest.fn(async () => {
        events.push('success-hook');
        throw hookError;
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(hookError);

      expect(hook).toHaveBeenCalledTimes(1);
      expect(events.indexOf('success-hook')).toBeLessThan(events.indexOf('sqlite-lock-released'));
      expect(events.filter((event) => event === 'postgres-status-read')).toHaveLength(1);
      expect(events.indexOf('postgres-status-read')).toBeLessThan(events.indexOf('success-hook'));
      expect(events).not.toContain('sqlite-status-written');
      expect(events).toEqual(
        expect.arrayContaining([
          'sqlite-lock-released',
          'postgres-lock-released',
          'postgres-closed',
          'sqlite-closed',
        ])
      );
    });

    it('keeps a post-hook SQLite status-write failure fatal without invoking the hook twice', async () => {
      const statusWriteFailure = new Error('local terminal status write failed');
      sqliteStatusFailure = statusWriteFailure;
      sqliteStatusFailuresRemaining = 2;
      const hook = jest.fn(async () => {
        events.push('success-hook');
        pgSyncStatus = cleanSyncStatus();
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(
        statusWriteFailure
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(SQLiteCacheService.prototype.setSyncStatus).toHaveBeenCalledTimes(2);
      expect(PostgresCacheService.prototype.setSyncStatus).toHaveBeenCalledTimes(1);
      expect(attemptedSqliteStatuses.map(({ status }) => status)).toEqual(['success', 'failed']);
      expect(mirroredSyncStatuses).toEqual([]);
      expect(compensatedPgStatuses).toEqual([
        expect.objectContaining({
          status: 'failed',
          runId: 'pull-run',
          message: 'Sync failed',
          error: 'Cache sync failed.',
        }),
      ]);
      expect(compensatedPgStatuses[0]).not.toHaveProperty('recordIssues');
      expect(compensatedPgStatuses[0]).toBe(attemptedSqliteStatuses[1]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('persists a local failed status when the terminal-success write failure is transient', async () => {
      const statusWriteFailure = new Error('transient local terminal status write failed');
      sqliteStatusFailure = statusWriteFailure;
      sqliteStatusFailuresRemaining = 1;
      const hook = jest.fn(async () => {
        events.push('success-hook');
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(
        statusWriteFailure
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(SQLiteCacheService.prototype.setSyncStatus).toHaveBeenCalledTimes(2);
      expect(PostgresCacheService.prototype.setSyncStatus).toHaveBeenCalledTimes(1);
      expect(attemptedSqliteStatuses.map(({ status }) => status)).toEqual(['success', 'failed']);
      expect(mirroredSyncStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses[0]).toBe(attemptedSqliteStatuses[1]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('compensates a post-hook PostgreSQL status reread failure without masking it', async () => {
      const statusReadFailure = new Error('terminal status reread failed');
      jest
        .mocked(PostgresCacheService.prototype.getSyncStatus)
        .mockImplementationOnce(async () => {
          events.push('postgres-status-read');
          return cleanSyncStatus();
        })
        .mockImplementationOnce(async () => {
          events.push('postgres-status-read');
          throw statusReadFailure;
        });
      const hook = jest.fn(async () => {
        events.push('success-hook');
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(statusReadFailure);

      expect(hook).toHaveBeenCalledTimes(1);
      expect(attemptedSqliteStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses[0]).toBe(attemptedSqliteStatuses[0]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('preserves the SQLite status-write error when PostgreSQL compensation also fails', async () => {
      const statusWriteFailure = new Error('local terminal status write failed');
      sqliteStatusFailure = statusWriteFailure;
      sqliteStatusFailuresRemaining = 2;
      pgStatusFailure = new Error('postgres compensation failed');
      const hook = jest.fn(async () => {
        events.push('success-hook');
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(
        statusWriteFailure
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(attemptedSqliteStatuses.map(({ status }) => status)).toEqual(['success', 'failed']);
      expect(compensatedPgStatuses).toEqual([]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('fails closed when a success hook does not leave a terminal PostgreSQL status', async () => {
      pgSyncStatus = { ...cleanSyncStatus(), status: 'running', finishedAt: undefined };
      const hook = jest.fn(async () => {
        events.push('success-hook');
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toThrow(
        'PostgreSQL sync status was not terminal after pull settlement.'
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(mirroredSyncStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('rejects duplicate warning identities instead of masking them during projection', async () => {
      const repeatedIssue = {
        resource: 'item' as const,
        id: 'duplicate-item-warning',
        code: 'invalid_record' as const,
        message: 'Item failed source validation',
        attempts: 2 as const,
        outcome: 'omitted_new' as const,
      };
      const hook = jest.fn(async () => {
        events.push('success-hook');
        pgSyncStatus = {
          ...cleanSyncStatus(),
          status: 'success_with_warnings',
          recordIssues: [repeatedIssue, { ...repeatedIssue }],
        };
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toThrow(
        'PostgreSQL sync record issues contain duplicate identities.'
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(mirroredSyncStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(compensatedPgStatuses).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' }),
      ]);
      expect(events).toEqual([
        'postgres-lock-acquired',
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'postgres-status-written',
        'sqlite-lock-released',
        'postgres-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });

    it('reports failure while locked without allowing hook rejection to mask the primary error', async () => {
      const primaryError = new Error('mirror replacement failed');
      mirrorFailure = primaryError;
      const hook = jest.fn(async (settlement: PgPullSettlement) => {
        expect(settlement).toEqual({ status: 'failed', error: primaryError });
        events.push('failure-hook');
        throw new Error('failure terminal persistence also failed');
      });

      await expect(pullWithOptions({ onSettledWhileLocked: hook })).rejects.toBe(primaryError);

      expect(hook).toHaveBeenCalledTimes(1);
      expect(events.indexOf('mirror-replaced')).toBeLessThan(events.indexOf('failure-hook'));
      expect(events.indexOf('failure-hook')).toBeLessThan(events.indexOf('sqlite-lock-released'));
      expect(events).toEqual(
        expect.arrayContaining([
          'sqlite-lock-released',
          'postgres-lock-released',
          'postgres-closed',
          'sqlite-closed',
        ])
      );
    });

    it('keeps the existing four-argument caller behavior', async () => {
      const result = await pullFromPostgres(
        'postgres://example/cache',
        'pull-lifecycle',
        sqlitePath,
        binding
      );

      expect(result).toEqual(expect.objectContaining({ success: true, documentsPulled: 0 }));
      expect(events).not.toContain('success-hook');
      expect(mirroredSyncStatuses).toEqual([
        expect.objectContaining({
          status: 'success',
          runId: 'pull-run',
          message: 'Sync completed',
        }),
      ]);
      expect(events.indexOf('mirror-replaced')).toBeLessThan(
        events.indexOf('postgres-status-read')
      );
      expect(events.indexOf('postgres-status-read')).toBeLessThan(
        events.indexOf('sqlite-status-written')
      );
      expect(events.indexOf('sqlite-status-written')).toBeLessThan(
        events.indexOf('sqlite-lock-released')
      );
      expect(events).toEqual(
        expect.arrayContaining([
          'sqlite-lock-released',
          'postgres-lock-released',
          'postgres-closed',
          'sqlite-closed',
        ])
      );
    });

    it('keeps a caller-held PostgreSQL lock external while protecting the SQLite replacement', async () => {
      const hook = jest.fn(() => {
        events.push('success-hook');
      });

      await pullWithOptions({ pgLockAlreadyHeld: true, onSettledWhileLocked: hook });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(events).not.toContain('postgres-lock-acquired');
      expect(events).not.toContain('postgres-lock-released');
      expect(events).toEqual([
        'sqlite-lock-acquired',
        'mirror-replaced',
        'postgres-status-read',
        'success-hook',
        'postgres-status-read',
        'sqlite-status-written',
        'sqlite-lock-released',
        'postgres-closed',
        'sqlite-closed',
      ]);
    });
  });
});

function payment(transactionId: string, docId: string): PaymentTransactionRow {
  return {
    transaction_id: transactionId,
    doc_id: docId,
    amount: 25.5,
    transaction_date: '2026-02-01',
    reference: null,
    imported_at: 1770000000,
  };
}

function cleanSyncStatus(): CacheSyncStatus {
  return {
    status: 'success',
    runId: 'pull-run',
    accountName: 'pull-lifecycle',
    syncTarget: 'postgresql',
    startedAt: 1770000000,
    updatedAt: 1770000010,
    finishedAt: 1770000010,
    message: 'Sync completed',
    syncType: 'full',
  };
}
