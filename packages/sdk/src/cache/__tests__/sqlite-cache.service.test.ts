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

  afterEach(async () => {
    await service.close();
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

  describe('Cache metadata', () => {
    it('stores and returns sync status', async () => {
      const status = {
        status: 'running' as const,
        runId: 'run-1',
        accountName: 'test-account',
        syncTarget: 'sqlite' as const,
        startedAt: 1770000000,
        updatedAt: 1770000000,
        message: 'Sync running',
      };

      await service.setSyncStatus(status);

      expect(await service.getSyncStatus()).toEqual(status);
    });

    it('returns null when sync status has not been written', async () => {
      expect(await service.getSyncStatus()).toBeNull();
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

    it('should insert and retrieve document', async () => {
      await service.insertDocument(testDoc);
      const retrieved = await service.getDocument('test-doc-1');
      expect(retrieved).toMatchObject(testDoc);
      expect(retrieved?.cache_source).toBe('api');
    });

    it('should update existing document', async () => {
      await service.insertDocument(testDoc);
      const updated = { ...testDoc, issue_date: '2026-01-29' };
      await service.insertDocument(updated);
      const retrieved = await service.getDocument('test-doc-1');
      expect(retrieved?.issue_date).toBe('2026-01-29');
    });

    it('should delete document', async () => {
      await service.insertDocument(testDoc);
      await service.deleteDocument('test-doc-1');
      const retrieved = await service.getDocument('test-doc-1');
      expect(retrieved).toBeUndefined();
    });

    it('should batch insert documents', async () => {
      const docs: DocumentRow[] = [
        { ...testDoc, doc_id: 'doc-1', doc_number: 1 },
        { ...testDoc, doc_id: 'doc-2', doc_number: 2 },
        { ...testDoc, doc_id: 'doc-3', doc_number: 3 },
      ];
      await service.batchInsertDocuments(docs);
      expect(await service.getDocumentCount()).toBe(3);
    });

    it('should get documents by context', async () => {
      await service.insertDocument(testDoc);
      await service.insertDocument({ ...testDoc, doc_id: 'doc-2', context_id: DocumentContextId.Estimate });

      const invoices = await service.getDocumentsByContext(DocumentContextId.Invoice);
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

    beforeEach(async () => {
      await service.insertDocument(testDoc);
    });

    it('should insert and retrieve item documents', async () => {
      await service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'test-doc-1',
        quantity: 10,
        price: 29.99,
      });

      const items = await service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(1);
      expect(items[0].item_id).toBe('item-1');
      expect(items[0].quantity).toBe(10);
    });

    it('should cascade delete item documents when document deleted', async () => {
      await service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'test-doc-1',
        quantity: 5,
        price: 10,
      });

      await service.deleteDocument('test-doc-1');
      const items = await service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(0);
    });

    it('should batch insert item documents', async () => {
      await service.batchInsertItemDocuments([
        { item_id: 'item-1', doc_id: 'test-doc-1', quantity: 5, price: 10 },
        { item_id: 'item-2', doc_id: 'test-doc-1', quantity: 3, price: 20 },
      ]);

      const items = await service.getItemDocuments('test-doc-1');
      expect(items).toHaveLength(2);
    });
  });

  describe('Analytics Queries', () => {
    beforeEach(async () => {
      await service.insertDocument({
        doc_id: 'inv-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-15',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      await service.insertDocument({
        doc_id: 'inv-2',
        context_id: DocumentContextId.Invoice,
        doc_number: 2,
        issue_date: '2026-01-20',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      await service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'inv-1',
        quantity: 5,
        price: 10,
      });

      await service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'inv-2',
        quantity: 3,
        price: 15,
      });
    });

    it('should get latest item document date by context', async () => {
      const latestDate = await service.getLatestItemDocumentDate('item-1', DocumentContextId.Invoice);
      expect(latestDate).toBe('2026-01-20');
    });

    it('should return undefined for no matching documents', async () => {
      const latestDate = await service.getLatestItemDocumentDate('nonexistent', DocumentContextId.Invoice);
      expect(latestDate).toBeUndefined();
    });

    it('should get item documents for period', async () => {
      const items = await service.getItemDocumentsForPeriod(
        'item-1',
        '2026-01-01',
        '2026-01-31',
        DocumentContextId.Invoice
      );

      expect(items).toHaveLength(2);
    });

    it('should filter by date range', async () => {
      const items = await service.getItemDocumentsForPeriod(
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
    it('should return null for missing state', async () => {
      const state = await service.getCacheState();
      expect(state).toBeNull();
    });

    it('should save and retrieve cache state', async () => {
      const state: CacheState = {
        lastSync: 1706457600,
        lastFullSync: 1706457600,
        documentCount: 100,
        itemDocumentCount: 500,
        accountName: 'test-account',
        schemaVersion: 1,
      };

      await service.setCacheState(state);
      const retrieved = await service.getCacheState();

      expect(retrieved).toEqual(state);
    });

    it('should update existing cache state', async () => {
      const state: CacheState = {
        lastSync: 1706457600,
        lastFullSync: 1706457600,
        documentCount: 100,
        itemDocumentCount: 500,
        accountName: 'test-account',
        schemaVersion: 1,
      };

      await service.setCacheState(state);
      await service.setCacheState({ ...state, lastSync: 1706544000 });

      const retrieved = await service.getCacheState();
      expect(retrieved?.lastSync).toBe(1706544000);
    });
  });

  describe('Counts', () => {
    it('should return correct document count', async () => {
      expect(await service.getDocumentCount()).toBe(0);

      await service.insertDocument({
        doc_id: 'doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-28',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      expect(await service.getDocumentCount()).toBe(1);
    });

    it('should return correct item document count', async () => {
      expect(await service.getItemDocumentCount()).toBe(0);

      await service.insertDocument({
        doc_id: 'doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-01-28',
        customer_id: 'cust-1',
        modified: 1706457600,
      });

      await service.insertItemDocument({
        item_id: 'item-1',
        doc_id: 'doc-1',
        quantity: 5,
        price: 10,
      });

      expect(await service.getItemDocumentCount()).toBe(1);
    });
  });

  describe('Analytics Query Methods', () => {
    beforeEach(async () => {
      // Insert test documents spanning 6 months
      const documents = [
        { doc_id: 'inv-001', context_id: DocumentContextId.Invoice, doc_number: 1001, issue_date: '2025-08-15', customer_id: 'cust-a', modified: 1706457600 },
        { doc_id: 'inv-002', context_id: DocumentContextId.Invoice, doc_number: 1002, issue_date: '2025-09-20', customer_id: 'cust-b', modified: 1706457600 },
        { doc_id: 'inv-003', context_id: DocumentContextId.Invoice, doc_number: 1003, issue_date: '2025-10-10', customer_id: 'cust-a', modified: 1706457600 },
        { doc_id: 'inv-004', context_id: DocumentContextId.Invoice, doc_number: 1004, issue_date: '2025-11-05', customer_id: 'cust-c', modified: 1706457600 },
        { doc_id: 'inv-005', context_id: DocumentContextId.Invoice, doc_number: 1005, issue_date: '2025-12-15', customer_id: 'cust-b', modified: 1706457600 },
        { doc_id: 'inv-006', context_id: DocumentContextId.Invoice, doc_number: 1006, issue_date: '2026-01-10', customer_id: 'cust-a', modified: 1706457600 },
        { doc_id: 'est-001', context_id: DocumentContextId.Estimate, doc_number: 2001, issue_date: '2025-12-01', customer_id: 'cust-d', modified: 1706457600 },
        { doc_id: 'est-002', context_id: DocumentContextId.Estimate, doc_number: 2002, issue_date: '2025-12-15', customer_id: 'cust-e', modified: 1706457600 },
        // Matching estimate-invoice pair (same doc_number)
        { doc_id: 'est-003', context_id: DocumentContextId.Estimate, doc_number: 3001, issue_date: '2025-11-01', customer_id: 'cust-f', modified: 1706457600 },
        { doc_id: 'inv-from-est-003', context_id: DocumentContextId.Invoice, doc_number: 3001, issue_date: '2025-11-20', customer_id: 'cust-f', modified: 1706457600 },
      ];
      await service.batchInsertDocuments(documents);

      // Insert item documents with varying prices and quantities
      const itemDocs = [
        // Item-1: Multiple sales at different prices
        { item_id: 'item-1', doc_id: 'inv-001', quantity: 10, price: 25.00 },
        { item_id: 'item-1', doc_id: 'inv-002', quantity: 5, price: 20.00 },
        { item_id: 'item-1', doc_id: 'inv-003', quantity: 8, price: 25.00 },
        { item_id: 'item-1', doc_id: 'inv-004', quantity: 15, price: 22.50 },
        { item_id: 'item-1', doc_id: 'inv-005', quantity: 12, price: 25.00 },
        { item_id: 'item-1', doc_id: 'inv-006', quantity: 20, price: 25.00 },
        // Item-2: Single price
        { item_id: 'item-2', doc_id: 'inv-001', quantity: 5, price: 100.00 },
        { item_id: 'item-2', doc_id: 'inv-003', quantity: 10, price: 100.00 },
        { item_id: 'item-2', doc_id: 'inv-006', quantity: 8, price: 100.00 },
        // Item-3: No sales (edge case)
      ];
      await service.batchInsertItemDocuments(itemDocs);
    });

    describe('getItemSalesByPeriod', () => {
      it('returns sales grouped by period with dates', async () => {
        const sales = await service.getItemSalesByPeriod('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(sales.length).toBeGreaterThan(0);
        expect(sales[0]).toHaveProperty('issue_date');
        expect(sales[0]).toHaveProperty('quantity');
        expect(sales[0]).toHaveProperty('price');
      });

      it('filters by context_id', async () => {
        const invoices = await service.getItemSalesByPeriod('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const estimates = await service.getItemSalesByPeriod('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Estimate);
        expect(invoices.length).toBeGreaterThan(0);
        expect(estimates.length).toBe(0); // item-1 has no estimates
      });

      it('handles date ranges correctly', async () => {
        const q4Sales = await service.getItemSalesByPeriod('item-1', '2025-10-01', '2025-12-31', DocumentContextId.Invoice);
        expect(q4Sales.length).toBe(3); // inv-004, inv-005, inv-006 (wait: inv-006 is 2026-01-10, not in range)
        // Actually inv-004 (2025-11-05), inv-005 (2025-12-15) are in Q4; inv-003 (2025-10-10) also qualifies
        // inv-006 is 2026-01-10, out of range
      });

      it('returns empty for non-existent item', async () => {
        const sales = await service.getItemSalesByPeriod('nonexistent', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(sales).toEqual([]);
      });

      it('orders by date ascending', async () => {
        const sales = await service.getItemSalesByPeriod('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const dates = sales.map(s => s.issue_date);
        const sortedDates = [...dates].sort();
        expect(dates).toEqual(sortedDates);
      });
    });

    describe('getItemPriceDistribution', () => {
      it('groups by price point', async () => {
        const distribution = await service.getItemPriceDistribution('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(distribution.length).toBe(3); // 20.00, 22.50, 25.00
      });

      it('calculates total quantity per price', async () => {
        const distribution = await service.getItemPriceDistribution('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const price25 = distribution.find(d => d.price === 25);
        expect(price25?.total_quantity).toBe(50); // 10 + 8 + 12 + 20
      });

      it('calculates total revenue per price', async () => {
        const distribution = await service.getItemPriceDistribution('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const price25 = distribution.find(d => d.price === 25);
        expect(price25?.total_revenue).toBe(1250); // 25 * 50
      });

      it('orders by price ascending', async () => {
        const distribution = await service.getItemPriceDistribution('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const prices = distribution.map(d => d.price);
        expect(prices).toEqual([20, 22.5, 25]);
      });

      it('returns empty for item with no sales', async () => {
        const distribution = await service.getItemPriceDistribution('item-3', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(distribution).toEqual([]);
      });
    });

    describe('getItemSalesByCustomer', () => {
      it('aggregates sales by customer', async () => {
        const customerSales = await service.getItemSalesByCustomer('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(customerSales.length).toBe(3); // cust-a, cust-b, cust-c
      });

      it('calculates quantity per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const custA = customerSales.find(c => c.customer_id === 'cust-a');
        expect(custA?.quantity).toBe(38); // 10 + 8 + 20
      });

      it('calculates revenue per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const custA = customerSales.find(c => c.customer_id === 'cust-a');
        expect(custA?.revenue).toBe(950); // (10+8+20) * 25
      });

      it('counts distinct orders per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const custA = customerSales.find(c => c.customer_id === 'cust-a');
        expect(custA?.order_count).toBe(3);
      });

      it('orders by revenue descending', async () => {
        const customerSales = await service.getItemSalesByCustomer('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const revenues = customerSales.map(c => c.revenue);
        expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
      });
    });

    describe('getItemSalesByMonth', () => {
      it('groups sales by month', async () => {
        const monthly = await service.getItemSalesByMonth('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        expect(monthly.length).toBeGreaterThan(0);
        expect(monthly[0]).toHaveProperty('month');
        expect(monthly[0].month).toMatch(/^\d{4}-\d{2}$/);
      });

      it('sums quantity per month', async () => {
        const monthly = await service.getItemSalesByMonth('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const aug = monthly.find(m => m.month === '2025-08');
        expect(aug?.quantity).toBe(10);
      });

      it('sums revenue per month', async () => {
        const monthly = await service.getItemSalesByMonth('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const aug = monthly.find(m => m.month === '2025-08');
        expect(aug?.revenue).toBe(250); // 10 * 25
      });

      it('orders by month ascending', async () => {
        const monthly = await service.getItemSalesByMonth('item-1', '2025-01-01', '2026-12-31', DocumentContextId.Invoice);
        const months = monthly.map(m => m.month);
        const sortedMonths = [...months].sort();
        expect(months).toEqual(sortedMonths);
      });
    });

    describe('getItemOrderPatterns', () => {
      it('returns both Estimates and Invoices', async () => {
        const patterns = await service.getItemOrderPatterns('item-2', '2025-01-01', '2026-12-31');
        expect(patterns.length).toBeGreaterThan(0);

        const hasInvoice = patterns.some(p => p.context_id === DocumentContextId.Invoice);
        // Since item-2 only has invoices in our test data
        expect(hasInvoice).toBe(true);
      });

      it('includes all required fields', async () => {
        const patterns = await service.getItemOrderPatterns('item-1', '2025-01-01', '2026-12-31');
        expect(patterns[0]).toHaveProperty('doc_id');
        expect(patterns[0]).toHaveProperty('quantity');
        expect(patterns[0]).toHaveProperty('price');
        expect(patterns[0]).toHaveProperty('issue_date');
        expect(patterns[0]).toHaveProperty('customer_id');
        expect(patterns[0]).toHaveProperty('context_id');
        expect(patterns[0]).toHaveProperty('doc_number');
      });

      it('orders by date descending', async () => {
        const patterns = await service.getItemOrderPatterns('item-1', '2025-01-01', '2026-12-31');
        const dates = patterns.map(p => p.issue_date);
        const sortedDates = [...dates].sort((a, b) => b.localeCompare(a));
        expect(dates).toEqual(sortedDates);
      });

      it('returns empty for item with no documents', async () => {
        const patterns = await service.getItemOrderPatterns('item-3', '2025-01-01', '2026-12-31');
        expect(patterns).toEqual([]);
      });

      it('filters to only Estimates and Invoices (context 4 and 5)', async () => {
        // Insert a Purchase Order (context 11) - should be excluded
        await service.insertDocument({
          doc_id: 'po-001',
          context_id: 11,
          doc_number: 4001,
          issue_date: '2025-12-01',
          customer_id: 'cust-x',
          modified: 1706457600,
        });
        await service.insertItemDocument({ item_id: 'item-1', doc_id: 'po-001', quantity: 100, price: 10 });

        const patterns = await service.getItemOrderPatterns('item-1', '2025-01-01', '2026-12-31');
        const hasPo = patterns.some(p => p.context_id === 11);
        expect(hasPo).toBe(false);
      });
    });
  });
});
