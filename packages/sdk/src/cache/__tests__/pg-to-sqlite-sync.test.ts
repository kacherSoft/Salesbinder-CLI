/**
 * PG → SQLite sync service unit tests
 *
 * Tests the explicit pull flow using two SQLite instances to simulate PG
 * since PG may not be available in CI.
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { DocumentContextId } from '../types.js';
import type { AccountRow, CacheState, DocumentRow, ItemRow, ItemStockLocationRow } from '../types.js';
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

    const testItems = [
      { item_id: 'item-x', doc_id: 'doc-001', quantity: 10, price: 25.50 },
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
        } catch { /* ignore */ }
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
      expect(afterDocs.map(d => d.doc_id).sort()).toEqual(['doc-001', 'doc-002', 'doc-003']);
      expect(afterDocs.map(({ archived }) => archived).sort()).toEqual([null, 0, 1].sort());
    });

    it('should copy tri-state lifecycle values for master items', async () => {
      await targetDb.batchInsertItems(await sourceDb.getAllItems());

      expect((await targetDb.getAllItems()).map(({ archived }) => archived).sort())
        .toEqual([null, 0, 1].sort());
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
      const allItems = [...doc1Items, ...doc2Items].map(i => ({
        item_id: i.item_id,
        doc_id: i.doc_id,
        quantity: i.quantity,
        price: i.price,
      }));
      await targetDb.batchInsertItemDocuments(allItems);

      const targetDoc1Items = await targetDb.getItemDocuments('doc-001');
      const targetDoc2Items = await targetDb.getItemDocuments('doc-002');
      expect(targetDoc1Items.length).toBe(2);
      expect(targetDoc2Items.length).toBe(1);
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
      await targetDb.batchDeleteDocuments(oldDocs.map(d => d.doc_id));

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
        schemaVersion: 4,
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

      expect(() => targetDb.replaceMirror({
        accounts: [],
        items: [],
        itemStockLocations: [],
        documents: [{
          doc_id: 'new-doc',
          context_id: DocumentContextId.Invoice,
          doc_number: 1001,
          issue_date: '2026-01-01',
          customer_id: 'new-cust',
          modified: 200,
        }],
        itemDocuments: [],
        paymentTransactions: [payment('orphan-payment', 'missing-doc')],
        cacheState: {
          lastSync: 200,
          lastFullSync: 200,
          documentCount: 1,
          itemDocumentCount: 0,
          accountName: 'source',
          schemaVersion: 4,
        },
        paymentSyncStatus: null,
        pulledAt: 99999,
      })).toThrow(/FOREIGN KEY constraint failed/);

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
        archived: 0,
      };
      const cacheState: CacheState = {
        lastSync: 300,
        lastFullSync: 300,
        documentCount: 1,
        itemDocumentCount: 1,
        accountName: 'source',
        schemaVersion: 4,
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
        items: [item],
        itemStockLocations: [stock],
        documents: [document],
        itemDocuments: [{
          item_id: 'master-new',
          doc_id: 'doc-new',
          quantity: 2,
          price: 50,
          document_item_id: 'line-new',
        }],
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
      expect(await targetDb.getItemDocuments('doc-new')).toEqual([expect.objectContaining({ document_item_id: 'line-new' })]);
      expect(await targetDb.getAllPaymentTransactions()).toEqual([payment('payment-new', 'doc-new')]);
      expect(await targetDb.getCacheState()).toEqual(cacheState);
      expect(await targetDb.getPaymentSyncStatus()).toEqual(paymentStatus);
      expect(targetDb.getRawMeta('pg_pull_timestamp')).toBe(54321);
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
