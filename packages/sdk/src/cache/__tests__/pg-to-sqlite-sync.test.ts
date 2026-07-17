/**
 * PG → SQLite sync service unit tests
 *
 * Tests the explicit pull flow using two SQLite instances to simulate PG
 * since PG may not be available in CI.
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId } from '../types.js';
import type { CacheMirrorSnapshot, DocumentRow } from '../types.js';
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
      },
      {
        doc_id: 'doc-002',
        context_id: DocumentContextId.Estimate,
        doc_number: 2001,
        issue_date: '2026-02-10',
        customer_id: 'cust-b',
        modified: 1707500000,
      },
      {
        doc_id: 'doc-003',
        context_id: DocumentContextId.PurchaseOrder,
        doc_number: 3001,
        issue_date: '2026-03-05',
        customer_id: 'cust-a',
        modified: 1709600000,
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
      sourceDb = new SQLiteCacheService('source', sourcePath, true);
      targetDb = new SQLiteCacheService('target', targetPath, true);

      // Populate source with test data
      await sourceDb.batchInsertDocuments(testDocs);
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

    it('should atomically mirror non-item lines with the source snapshot', async () => {
      await targetDb.insertDocument({
        doc_id: 'old-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 9999,
        issue_date: '2025-01-01',
        customer_id: 'old-cust',
        modified: 1000000,
      });
      const snapshot: CacheMirrorSnapshot = {
        accounts: [],
        documents: (await sourceDb.getDocumentsModifiedSince(0)).map((document, index) => index === 0
          ? { ...document, snapshot_version: CACHE_SCHEMA_VERSION, snapshot_complete: 1 }
          : document),
        itemDocuments: testItems,
        documentNonItemLines: [{
          doc_id: 'doc-001',
          document_item_id: 'line-adjustment',
          line_type: 'non_item',
          quantity: 1,
          price: -25,
          total_amount: -25,
          net_amount: -25,
        }],
        items: [],
        stockLocations: [],
        state: await sourceDb.getCacheState(),
        syncStatus: null,
      };

      targetDb.replaceMirrorSnapshot(snapshot);

      expect(await targetDb.getDocument('old-doc')).toBeUndefined();
      expect(await targetDb.getDocumentNonItemLines('doc-001')).toEqual([
        expect.objectContaining({ document_item_id: 'line-adjustment', net_amount: -25 }),
      ]);
      expect(await targetDb.getDocument('doc-001')).toMatchObject({
        snapshot_version: CACHE_SCHEMA_VERSION,
        snapshot_complete: 1,
      });
      expect(await targetDb.getCacheState()).toMatchObject({
        schemaVersion: CACHE_SCHEMA_VERSION,
        nonItemDocumentCount: 1,
      });
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
