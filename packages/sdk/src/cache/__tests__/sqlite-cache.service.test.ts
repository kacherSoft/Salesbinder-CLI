/**
 * SQLiteCacheService unit tests
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { DocumentContextId, DocumentRow, CacheState } from '../types.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SQLiteCacheService', () => {
  let service: SQLiteCacheService;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    service = new SQLiteCacheService('test-account', testDbPath);
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(testDbPath);
      rmSync(`${testDbPath}-wal`, { force: true });
      rmSync(`${testDbPath}-shm`, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Connection and Schema', () => {
    it('should create database file', () => {
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('should return correct db path', () => {
      expect(service.getDbPath()).toBe(testDbPath);
    });
  });

  describe('Document CRUD', () => {
    const testDoc: DocumentRow = {
      doc_id: 'test-doc-1',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-01-28',
      customer_id: 'customer-1',
      modified: 1706457600,
    };

    it('should insert and retrieve document', () => {
      service.insertDocument(testDoc);
      const retrieved = service.getDocument('test-doc-1');
      expect(retrieved).toEqual(testDoc);
    });

    it('should update existing document', () => {
      service.insertDocument(testDoc);
      const updated = { ...testDoc, issue_date: '2026-01-29' };
      service.insertDocument(updated);
      const retrieved = service.getDocument('test-doc-1');
      expect(retrieved?.issue_date).toBe('2026-01-29');
    });

    it('should delete document', () => {
      service.insertDocument(testDoc);
      service.deleteDocument('test-doc-1');
      const retrieved = service.getDocument('test-doc-1');
      expect(retrieved).toBeUndefined();
    });

    it('should batch insert documents', () => {
      const docs: DocumentRow[] = [
        { ...testDoc, doc_id: 'doc-1', doc_number: 1 },
        { ...testDoc, doc_id: 'doc-2', doc_number: 2 },
        { ...testDoc, doc_id: 'doc-3', doc_number: 3 },
      ];
      service.batchInsertDocuments(docs);
      expect(service.getDocumentCount()).toBe(3);
    });

    it('should get documents by context', () => {
      service.insertDocument(testDoc);
      service.insertDocument({ ...testDoc, doc_id: 'doc-2', context_id: DocumentContextId.Estimate });

      const invoices = service.getDocumentsByContext(DocumentContextId.Invoice);
      expect(invoices).toHaveLength(1);
      expect(invoices[0].doc_id).toBe('test-doc-1');
    });
  });

  describe('Item Document CRUD', () => {
    const testDoc: DocumentRow = {
      doc_id: 'test-doc-1',
      context_id: DocumentContextId.Invoice,
      doc_number: 1001,
      issue_date: '2026-01-28',
      customer_id: 'customer-1',
      modified: 1706457600,
    };

    beforeEach(() => {
      service.insertDocument(testDoc);
    });

    it('should insert and retrieve item documents', () => {
      service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'test-doc-1',
        quantity: 10,
        price: 29.99,
      });

      const items = service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(1);
      expect(items[0].item_id).toBe('item-1');
      expect(items[0].quantity).toBe(10);
    });

    it('should cascade delete item documents when document deleted', () => {
      service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'test-doc-1',
        quantity: 5,
        price: 10,
      });

      service.deleteDocument('test-doc-1');
      const items = service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(0);
    });

    it('should batch insert item documents', () => {
      service.batchInsertItemDocuments([
        { item_id: 'item-1', doc_id: 'test-doc-1', quantity: 5, price: 10 },
        { item_id: 'item-2', doc_id: 'test-doc-1', quantity: 3, price: 20 },
      ]);

      const items = service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(2);
    });
  });

  describe('Analytics Queries', () => {
    beforeEach(() => {
      service.insertDocument({
        doc_id: 'inv-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-15',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      service.insertDocument({
        doc_id: 'inv-2',
        context_id: DocumentContextId.Invoice,
        doc_number: 2,
        issue_date: '2026-01-20',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'inv-1',
        quantity: 5,
        price: 10,
      });

      service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'inv-2',
        quantity: 3,
        price: 15,
      });
    });

    it('should get latest item document date by context', () => {
      const latestDate = service.getLatestItemDocumentDate('item-1', DocumentContextId.Invoice);
      expect(latestDate).toBe('2026-01-20');
    });

    it('should return undefined for no matching documents', () => {
      const latestDate = service.getLatestItemDocumentDate('nonexistent', DocumentContextId.Invoice);
      expect(latestDate).toBeUndefined();
    });

    it('should get item documents for period', () => {
      const items = service.getItemDocumentsForPeriod(
        'item-1',
        '2026-01-01',
        '2026-01-31',
        DocumentContextId.Invoice
      );

      expect(items).toHaveLength(2);
    });

    it('should filter by date range', () => {
      const items = service.getItemDocumentsForPeriod(
        'item-1',
        '2026-01-16',
        '2026-01-31',
        DocumentContextId.Invoice
      );

      expect(items).toHaveLength(1);
      expect(items[0].quantity).toBe(3);
    });
  });

  describe('Cache Metadata', () => {
    it('should return null for missing state', () => {
      const state = service.getCacheState();
      expect(state).toBeNull();
    });

    it('should save and retrieve cache state', () => {
      const state: CacheState = {
        lastSync: 1706457600,
        lastFullSync: 1706457600,
        documentCount: 100,
        itemDocumentCount: 500,
        accountName: 'test-account',
        schemaVersion: 1,
      };

      service.setCacheState(state);
      const retrieved = service.getCacheState();

      expect(retrieved).toEqual(state);
    });

    it('should update existing cache state', () => {
      const state: CacheState = {
        lastSync: 1706457600,
        lastFullSync: 1706457600,
        documentCount: 100,
        itemDocumentCount: 500,
        accountName: 'test-account',
        schemaVersion: 1,
      };

      service.setCacheState(state);
      service.setCacheState({ ...state, lastSync: 1706544000 });

      const retrieved = service.getCacheState();
      expect(retrieved?.lastSync).toBe(1706544000);
    });
  });

  describe('Counts', () => {
    it('should return correct document count', () => {
      expect(service.getDocumentCount()).toBe(0);

      service.insertDocument({
        doc_id: 'doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-28',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      expect(service.getDocumentCount()).toBe(1);
    });

    it('should return correct item document count', () => {
      expect(service.getItemDocumentCount()).toBe(0);

      service.insertDocument({
        doc_id: 'doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-28',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'doc-1',
        quantity: 5,
        price: 10,
      });

      expect(service.getItemDocumentCount()).toBe(1);
    });
  });
});
