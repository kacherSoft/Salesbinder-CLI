/**
 * SQLiteCacheService unit tests
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId, DocumentRow, CacheState } from '../types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from '../payment-sync.types.js';
import Database from 'better-sqlite3';
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

    it('creates nullable archive columns and lookup indexes', () => {
      const db = new Database(testDbPath, { readonly: true });
      try {
        const documentColumns = db.pragma('table_info(documents)') as Array<{ name: string; notnull: number }>;
        const itemColumns = db.pragma('table_info(items)') as Array<{ name: string; notnull: number }>;
        const indexes = [
          ...(db.pragma('index_list(documents)') as Array<{ name: string }>),
          ...(db.pragma('index_list(items)') as Array<{ name: string }>),
        ].map(({ name }) => name);

        expect(documentColumns).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'archived', notnull: 0 }),
        ]));
        expect(itemColumns).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'archived', notnull: 0 }),
        ]));
        expect(indexes).toEqual(expect.arrayContaining(['idx_documents_archived', 'idx_items_archived']));
      } finally {
        db.close();
      }
    });

    it('migrates schema v3 lifecycle state as unknown without losing records', async () => {
      await service.insertDocument({
        doc_id: 'legacy-doc', context_id: DocumentContextId.Invoice, doc_number: 7001,
        issue_date: '2026-01-01', customer_id: 'customer-1', modified: 1,
      });
      await service.insertItem({ item_id: 'legacy-item', name: 'Legacy item' });
      await service.close();

      const versionThreeDb = new Database(testDbPath);
      versionThreeDb.exec(`
        DROP INDEX idx_documents_archived;
        DROP INDEX idx_items_archived;
        ALTER TABLE documents DROP COLUMN archived;
        ALTER TABLE items DROP COLUMN archived;
        PRAGMA user_version = 3;
      `);
      versionThreeDb.close();

      service = new SQLiteCacheService('test-account', testDbPath);
      const migratedDb = new Database(testDbPath, { readonly: true });
      expect(migratedDb.pragma('user_version', { simple: true })).toBe(CACHE_SCHEMA_VERSION);
      migratedDb.close();
      expect((await service.getDocument('legacy-doc'))?.archived).toBeNull();
      expect((await service.getItem('legacy-item'))?.archived).toBeNull();
    });

    it.each([
      [1, createLegacyV1Database, null, 0],
      [2, createLegacyV2Database, null, 0],
      [3, createLegacyV3Database, null, 1],
      [4, createLegacyV4Database, 1, 1],
    ] as const)('migrates genuine schema v%s fixtures to v5 without losing rows', async (
      version,
      createLegacyDatabase,
      expectedArchived,
      expectedPaymentCount,
    ) => {
      await service.close();
      rmSync(testDbPath, { force: true });
      createLegacyDatabase(testDbPath);

      service = new SQLiteCacheService('test-account', testDbPath);

      const migratedDb = new Database(testDbPath, { readonly: true });
      try {
        expect(migratedDb.pragma('user_version', { simple: true })).toBe(CACHE_SCHEMA_VERSION);
        expect((migratedDb.pragma('table_info(documents)') as Array<{ name: string }>).map(({ name }) => name))
          .toEqual(expect.arrayContaining(['date_sent', 'shipped_percent']));
        expect((migratedDb.pragma('table_info(item_documents)') as Array<{ name: string }>).map(({ name }) => name))
          .toContain('quantity_shipped');
        expect(migratedDb.pragma('index_list(documents)')).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'idx_documents_api_doc_id', unique: 1 }),
        ]));
        expect((migratedDb.pragma('table_info(payment_transactions)') as Array<{ name: string }>))
          .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'transaction_id' })]));
        expect(await service.getDocument(`legacy-v${version}-doc`)).toMatchObject({
          doc_id: `legacy-v${version}-doc`,
          archived: expectedArchived,
        });
        expect(await service.getItem(`legacy-v${version}-item`)).toMatchObject({
          item_id: `legacy-v${version}-item`,
          archived: expectedArchived,
        });
        expect(await service.getItemDocuments(`legacy-v${version}-doc`)).toEqual([
          expect.objectContaining({ quantity_shipped: null }),
        ]);
        expect(await service.getAllPaymentTransactions()).toEqual(expectedPaymentCount === 0 ? [] : [{
          transaction_id: `payment-v${version}`,
          doc_id: `legacy-v${version}-doc`,
          amount: 25,
          transaction_date: `2026-0${version}-02`,
          reference: null,
          imported_at: version * 100,
        }]);
      } finally {
        migratedDb.close();
      }
    });

    it('keeps a v4 migration atomic and reports duplicate legacy API document IDs', async () => {
      await service.close();
      rmSync(testDbPath, { force: true });
      createLegacyV4DatabaseWithDuplicateApiIds(testDbPath);

      expect(() => new SQLiteCacheService('test-account', testDbPath))
        .toThrow(/Cannot migrate cache schema: documents contains 2 rows with api_doc_id "duplicate-api-id"/);

      const legacyDb = new Database(testDbPath, { readonly: true });
      try {
        expect(legacyDb.pragma('user_version', { simple: true })).toBe(4);
        expect((legacyDb.pragma('table_info(documents)') as Array<{ name: string }>).map(({ name }) => name))
          .not.toContain('date_sent');
        expect((legacyDb.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count)
          .toBe(2);
      } finally {
        legacyDb.close();
      }
    });
  });

  describe('PostgreSQL shipping storage', () => {
    it('adds shipping columns idempotently before creating their index', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn(async (_sql: string) => ({ rows: [] as unknown[] }));
      (pgService as unknown as { pool: { query: jest.Mock } }).pool = { query };

      await pgService.ensureSchema();

      const statements = query.mock.calls.map(([sql]) => String(sql));
      const migrations = statements.find((sql) => sql.includes('ALTER TABLE documents')) ?? '';
      const indexes = statements.find((sql) => sql.includes('CREATE INDEX IF NOT EXISTS idx_documents_shipped_percent')) ?? '';
      expect(migrations).toContain('ALTER TABLE documents ADD COLUMN IF NOT EXISTS date_sent TEXT NULL');
      expect(migrations).toContain('ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipped_percent NUMERIC NULL');
      expect(statements.find((sql) => sql.includes('ALTER TABLE item_documents')))
        .toContain('ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_shipped NUMERIC NULL');
      expect(statements.indexOf(migrations)).toBeLessThan(statements.indexOf(indexes));
      expect(statements.join('\n')).not.toMatch(/category_cache_meta|CREATE TABLE IF NOT EXISTS categories|shipment_checked_at/);
    });

    it('coerces PostgreSQL shipping numerics to numbers', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const document = {
        doc_id: 'pg-doc', context_id: DocumentContextId.Invoice, doc_number: 1,
        issue_date: '2026-08-01', customer_id: 'pg-customer', modified: 1,
        date_sent: '2026-08-02', shipped_percent: '37.5' as unknown as number,
      };
      const itemDocument = {
        item_id: 'pg-item', doc_id: 'pg-doc', quantity: '2' as unknown as number,
        price: '10' as unknown as number, quantity_shipped: '1.25' as unknown as number,
      };
      const query = jest.fn(async (sql: string) => ({
        rows: sql.includes('item_documents') ? [itemDocument] : [document],
      }));
      (pgService as unknown as { pool: { query: jest.Mock } }).pool = { query };

      expect(await pgService.getDocument('pg-doc')).toMatchObject({
        date_sent: '2026-08-02', shipped_percent: 37.5,
      });
      expect(await pgService.getItemDocuments('pg-doc')).toEqual([
        expect.objectContaining({ quantity: 2, price: 10, quantity_shipped: 1.25 }),
      ]);
    });
  });

  describe('Item lifecycle state', () => {
    it('preserves known archive state when an item source reports unknown', async () => {
      await service.insertItem({ item_id: 'item-1', name: 'Item', archived: 1 });
      await service.insertItem({ item_id: 'item-1', name: 'Renamed', archived: null });
      expect(await service.getItem('item-1')).toMatchObject({ name: 'Renamed', archived: 1 });

      await service.insertItem({ item_id: 'item-1', name: 'Active item', archived: 0 });
      expect((await service.getItem('item-1'))?.archived).toBe(0);
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

    it('serializes payment syncs across service instances', async () => {
      const competingService = new SQLiteCacheService('test-account', testDbPath);
      try {
        expect(await service.tryAcquireSyncLock('payment-sync')).toBe(true);
        expect(await competingService.tryAcquireSyncLock('payment-sync')).toBe(false);
        await service.releaseSyncLock('payment-sync');
        expect(await competingService.tryAcquireSyncLock('payment-sync')).toBe(true);
      } finally {
        await competingService.close();
      }
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

    it('persists document shipping fields', async () => {
      await service.insertDocument({
        ...testDoc,
        date_sent: '2026-01-30',
        shipped_percent: 62.5,
      });

      expect(await service.getDocument(testDoc.doc_id)).toMatchObject({
        date_sent: '2026-01-30',
        shipped_percent: 62.5,
      });
    });

    it('should update existing document', async () => {
      await service.insertDocument(testDoc);
      const updated = { ...testDoc, issue_date: '2026-01-29' };
      await service.insertDocument(updated);
      const retrieved = await service.getDocument('test-doc-1');
      expect(retrieved?.issue_date).toBe('2026-01-29');
    });

    it('preserves known archive state when a document source reports unknown', async () => {
      await service.insertDocument({ ...testDoc, archived: 1 });
      await service.insertDocument({ ...testDoc, archived: null, issue_date: '2026-01-29' });
      expect(await service.getDocument('test-doc-1')).toMatchObject({ archived: 1, issue_date: '2026-01-29' });

      await service.insertDocument({ ...testDoc, archived: 0 });
      expect((await service.getDocument('test-doc-1'))?.archived).toBe(0);
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

  describe('Payment transactions', () => {
    const payment = (
      transactionId: string,
      docId = 'payment-doc-1',
      overrides: Partial<PaymentTransactionRow> = {},
    ): PaymentTransactionRow => ({
      transaction_id: transactionId,
      doc_id: docId,
      amount: 25.5,
      transaction_date: '2026-02-01',
      reference: null,
      imported_at: 1770000000,
      ...overrides,
    });

    beforeEach(async () => {
      await service.batchInsertDocuments([
        { doc_id: 'payment-doc-1', context_id: DocumentContextId.Invoice, doc_number: 9001, issue_date: '2026-02-01', customer_id: 'cust-1', modified: 1 },
        { doc_id: 'payment-doc-2', context_id: DocumentContextId.Invoice, doc_number: 9002, issue_date: '2026-02-02', customer_id: 'cust-2', modified: 1 },
      ]);
    });

    it('creates the payment schema, foreign key, and query indexes', () => {
      const db = new Database(testDbPath, { readonly: true });
      try {
        const columns = (db.pragma('table_info(payment_transactions)') as Array<{ name: string }>)
          .map(({ name }) => name);
        const foreignKeys = db.pragma('foreign_key_list(payment_transactions)') as Array<{
          table: string; from: string; to: string; on_delete: string;
        }>;
        const docIndex = (db.pragma('index_info(idx_payment_transactions_doc_id)') as Array<{ name: string }>)
          .map(({ name }) => name);
        const dateIndex = (db.pragma('index_info(idx_payment_transactions_date_doc)') as Array<{ name: string }>)
          .map(({ name }) => name);

        expect(columns).toEqual(['transaction_id', 'doc_id', 'amount', 'transaction_date', 'reference', 'imported_at']);
        expect(foreignKeys).toEqual(expect.arrayContaining([
          expect.objectContaining({ table: 'documents', from: 'doc_id', to: 'doc_id', on_delete: 'CASCADE' }),
        ]));
        expect(docIndex).toEqual(['doc_id']);
        expect(dateIndex).toEqual(['transaction_date', 'doc_id']);
      } finally {
        db.close();
      }
    });

    it('migrates an existing version 2 database without losing documents', async () => {
      await service.close();
      const versionTwoDb = new Database(testDbPath);
      versionTwoDb.exec('DROP TABLE payment_transactions; PRAGMA user_version = 2;');
      versionTwoDb.close();

      service = new SQLiteCacheService('test-account', testDbPath);
      const migratedDb = new Database(testDbPath, { readonly: true });
      try {
        const version = migratedDb.pragma('user_version', { simple: true });
        const columns = (migratedDb.pragma('table_info(payment_transactions)') as Array<{ name: string }>)
          .map(({ name }) => name);
        const indexes = (migratedDb.pragma('index_list(payment_transactions)') as Array<{ name: string }>)
          .map(({ name }) => name);

        expect(version).toBe(CACHE_SCHEMA_VERSION);
        expect(columns).toEqual(['transaction_id', 'doc_id', 'amount', 'transaction_date', 'reference', 'imported_at']);
        expect(indexes).toEqual(expect.arrayContaining([
          'idx_payment_transactions_doc_id', 'idx_payment_transactions_date_doc',
        ]));
        expect(await service.getDocument('payment-doc-1')).toBeDefined();
      } finally {
        migratedDb.close();
      }
    });

    it('round-trips payment sync status metadata', async () => {
      const status: PaymentSyncStatus = {
        status: 'failed', mode: 'full', startedAt: 100, updatedAt: 120, finishedAt: 120,
        lastSuccessfulSync: 90, cursor: 'payment-doc-1', processedDocuments: 1,
        totalDocuments: 2, error: 'upstream unavailable',
      };

      expect(await service.getPaymentSyncStatus()).toBeNull();
      await service.setPaymentSyncStatus(status);
      expect(await service.getPaymentSyncStatus()).toEqual(status);
    });

    it('round-trips and deterministically orders payment rows', async () => {
      const txnA = payment('txn-a', 'payment-doc-1', { transaction_date: '2026-02-01', amount: 10 });
      const txnB = payment('txn-b', 'payment-doc-1', { transaction_date: '2026-02-02', reference: 'wire' });
      const txnC = payment('txn-c', 'payment-doc-2', { transaction_date: '2026-02-01' });
      await service.batchInsertPaymentTransactions([txnB, txnC, txnA]);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([txnA, txnB]);
      expect(await service.getAllPaymentTransactions()).toEqual([txnA, txnC, txnB]);
      expect(await service.getPaymentTransactionCount()).toBe(3);
    });

    it('rolls back deletion and partial inserts when replacement fails', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);
      const invalid = payment('invalid', 'payment-doc-1', { amount: Number.NaN });

      expect(() => service.replacePaymentTransactions('payment-doc-1', [payment('new'), invalid]))
        .toThrow(/payment_transactions\.amount/);
      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('original')]);
    });

    it('rejects cross-document rows without deleting existing payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);

      expect(() => service.replacePaymentTransactions('payment-doc-1', [payment('wrong', 'payment-doc-2')]))
        .toThrow('received rows for a different document');
      expect((await service.getPaymentTransactions('payment-doc-1')).map((row) => row.transaction_id))
        .toEqual(['original']);
    });

    it('rejects duplicate replacement IDs before deleting existing payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);

      expect(() => service.replacePaymentTransactions('payment-doc-1', [
        payment('duplicate', 'payment-doc-1', { amount: 1 }),
        payment('duplicate', 'payment-doc-1', { amount: 2 }),
      ])).toThrow('Duplicate payment transaction ID duplicate in one write operation.');

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('original')]);
    });

    it('rejects duplicate batch IDs before mutating payment rows', async () => {
      await service.batchInsertPaymentTransactions([payment('original')]);

      expect(() => service.batchInsertPaymentTransactions([
        payment('new', 'payment-doc-1'),
        payment('new', 'payment-doc-2'),
      ])).toThrow('Duplicate payment transaction ID new in one write operation.');

      expect(await service.getAllPaymentTransactions()).toEqual([payment('original')]);
    });

    it('rejects replacement IDs already assigned to another invoice without moving payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('doc-1-original')]);
      await service.replacePaymentTransactions('payment-doc-2', [payment('shared-existing-id', 'payment-doc-2')]);

      expect(() => service.replacePaymentTransactions('payment-doc-1', [
        payment('shared-existing-id', 'payment-doc-1'),
      ])).toThrow(/payment_transactions\.transaction_id|UNIQUE constraint failed/);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('doc-1-original')]);
      expect(await service.getPaymentTransactions('payment-doc-2')).toEqual([payment('shared-existing-id', 'payment-doc-2')]);
    });

    it('rolls back batch rows when one payment ID already belongs to another invoice', async () => {
      await service.batchInsertPaymentTransactions([payment('shared-existing-id', 'payment-doc-2')]);

      expect(() => service.batchInsertPaymentTransactions([
        payment('batch-new', 'payment-doc-1'),
        payment('shared-existing-id', 'payment-doc-1'),
      ])).toThrow(/payment_transactions\.transaction_id|UNIQUE constraint failed/);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([]);
      expect(await service.getPaymentTransactions('payment-doc-2')).toEqual([payment('shared-existing-id', 'payment-doc-2')]);
    });

    it('rejects duplicate PostgreSQL batch IDs before opening a transaction', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn();
      const connect = jest.fn();
      (pgService as unknown as { pool: { query: jest.Mock; connect: jest.Mock } }).pool = { query, connect };

      await expect(pgService.batchInsertPaymentTransactions([
        payment('pg-duplicate'),
        payment('pg-duplicate', 'payment-doc-2'),
      ])).rejects.toThrow('Duplicate payment transaction ID pg-duplicate in one write operation.');
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it('uses plain PostgreSQL inserts for payment batches so existing IDs cannot be overwritten', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
      const client = {
        query,
        release: jest.fn(),
      };
      (pgService as unknown as { pool: { connect: jest.Mock; query: jest.Mock } }).pool = {
        connect: jest.fn(async () => client),
        query: jest.fn(),
      };

      await pgService.batchInsertPaymentTransactions([payment('pg-new')]);

      const insertSql = client.query.mock.calls
        .map(([sql]) => String(sql))
        .find((sql) => sql.startsWith('INSERT INTO payment_transactions'));
      expect(insertSql).toBeDefined();
      expect(insertSql).not.toContain('ON CONFLICT');
    });

    it('uses plain PostgreSQL inserts for payment replacements after deleting that invoice only', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
      const client = {
        query,
        release: jest.fn(),
      };
      (pgService as unknown as { pool: { connect: jest.Mock } }).pool = {
        connect: jest.fn(async () => client),
      };

      await pgService.replacePaymentTransactions('payment-doc-1', [payment('pg-replacement')]);

      const statements = client.query.mock.calls.map(([sql]) => String(sql));
      expect(statements).toContain('DELETE FROM payment_transactions WHERE doc_id = $1');
      expect(statements.find((sql) => sql.startsWith('INSERT INTO payment_transactions'))).not.toContain('ON CONFLICT');
    });

    it('uses an empty replacement to clear only the requested invoice', async () => {
      await service.batchInsertPaymentTransactions([
        payment('txn-1'), payment('txn-2', 'payment-doc-2'),
      ]);

      await service.replacePaymentTransactions('payment-doc-1', []);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([]);
      expect((await service.getAllPaymentTransactions()).map((row) => row.transaction_id)).toEqual(['txn-2']);
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

    it('persists shipped quantity on document items', async () => {
      await service.insertItemDocument({
        item_id: 'item-shipped',
        doc_id: 'test-doc-1',
        quantity: 10,
        quantity_shipped: 4.25,
        price: 29.99,
      });

      expect(await service.getItemDocuments('test-doc-1')).toEqual([
        expect.objectContaining({ quantity_shipped: 4.25 }),
      ]);
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

function createLegacyV1Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE documents (
        doc_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        doc_number INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        modified INTEGER NOT NULL,
        UNIQUE(context_id, doc_number)
      );
      CREATE TABLE item_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
      ${legacyItemsTableSql()}
      INSERT INTO documents (doc_id, context_id, doc_number, issue_date, customer_id, modified)
        VALUES ('legacy-v1-doc', ${DocumentContextId.Invoice}, 4101, '2026-01-01', 'legacy-customer', 100);
      INSERT INTO items (item_id, item_number, name, sku, modified)
        VALUES ('legacy-v1-item', 501, 'Legacy v1 item', 'LEG-V1', 100);
      INSERT INTO item_documents (item_id, doc_id, quantity, price)
        VALUES ('legacy-v1-item', 'legacy-v1-doc', 2, 12.5);
      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

function createLegacyV2Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      ${legacyV2DocumentsTableSql()}
      ${legacyV2ItemDocumentsTableSql()}
      ${legacyItemsTableSql()}
      INSERT INTO documents (doc_id, context_id, doc_number, issue_date, customer_id, modified, api_doc_id, cache_source, is_cancelled)
        VALUES ('legacy-v2-doc', ${DocumentContextId.Invoice}, 4201, '2026-02-01', 'legacy-customer', 200, 'api-v2-doc', 'api', 0);
      INSERT INTO items (item_id, item_number, name, sku, modified)
        VALUES ('legacy-v2-item', 502, 'Legacy v2 item', 'LEG-V2', 200);
      INSERT INTO item_documents (item_id, doc_id, quantity, price, document_item_id, item_name, item_number, item_sku)
        VALUES ('legacy-v2-item', 'legacy-v2-doc', 3, 15, 'line-v2', 'Legacy v2 item', 502, 'LEG-V2');
      PRAGMA user_version = 2;
    `);
  } finally {
    db.close();
  }
}

function createLegacyV3Database(dbPath: string): void {
  createLegacyDatabaseWithPayments(dbPath, 3, false);
}

function createLegacyV4Database(dbPath: string): void {
  createLegacyDatabaseWithPayments(dbPath, 4, true);
}

function createLegacyV4DatabaseWithDuplicateApiIds(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      ${legacyV2DocumentsTableSql().replace('api_doc_id TEXT NULL UNIQUE', 'api_doc_id TEXT NULL')}
      ${legacyV2ItemDocumentsTableSql()}
      ${legacyItemsTableSql()}
      ALTER TABLE documents ADD COLUMN archived INTEGER NULL;
      ALTER TABLE items ADD COLUMN archived INTEGER NULL;
      CREATE TABLE payment_transactions (
        transaction_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        amount REAL NOT NULL,
        transaction_date TEXT NOT NULL,
        reference TEXT NULL,
        imported_at INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
      INSERT INTO documents (
        doc_id, context_id, doc_number, issue_date, customer_id, modified, api_doc_id, cache_source, is_cancelled
      ) VALUES
        ('duplicate-doc-1', ${DocumentContextId.Invoice}, 4401, '2026-04-01', 'customer-1', 400, 'duplicate-api-id', 'api', 0),
        ('duplicate-doc-2', ${DocumentContextId.Invoice}, 4402, '2026-04-02', 'customer-2', 400, 'duplicate-api-id', 'api', 0);
      PRAGMA user_version = 4;
    `);
  } finally {
    db.close();
  }
}

function createLegacyDatabaseWithPayments(dbPath: string, version: 3 | 4, archived: boolean): void {
  const db = new Database(dbPath);
  const archivedValue = archived ? 1 : 'NULL';
  try {
    db.exec(`
      ${legacyV2DocumentsTableSql()}
      ${legacyV2ItemDocumentsTableSql()}
      ${legacyItemsTableSql()}
      ${archived ? 'ALTER TABLE documents ADD COLUMN archived INTEGER NULL;' : ''}
      ${archived ? 'ALTER TABLE items ADD COLUMN archived INTEGER NULL;' : ''}
      CREATE TABLE payment_transactions (
        transaction_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        amount REAL NOT NULL,
        transaction_date TEXT NOT NULL,
        reference TEXT NULL,
        imported_at INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
      INSERT INTO documents (
        doc_id, context_id, doc_number, issue_date, customer_id, modified,
        api_doc_id, cache_source, is_cancelled${archived ? ', archived' : ''}
      ) VALUES (
        'legacy-v${version}-doc', ${DocumentContextId.Invoice}, ${4000 + version}01,
        '2026-0${version}-01', 'legacy-customer', ${version}00,
        'api-v${version}-doc', 'api', 0${archived ? `, ${archivedValue}` : ''}
      );
      INSERT INTO items (item_id, item_number, name, sku, modified${archived ? ', archived' : ''})
        VALUES ('legacy-v${version}-item', ${500 + version}, 'Legacy v${version} item', 'LEG-V${version}', ${version}00${archived ? `, ${archivedValue}` : ''});
      INSERT INTO item_documents (item_id, doc_id, quantity, price, document_item_id)
        VALUES ('legacy-v${version}-item', 'legacy-v${version}-doc', ${version}, 20, 'line-v${version}');
      INSERT INTO payment_transactions (transaction_id, doc_id, amount, transaction_date, reference, imported_at)
        VALUES ('payment-v${version}', 'legacy-v${version}-doc', 25, '2026-0${version}-02', NULL, ${version}00);
      PRAGMA user_version = ${version};
    `);
  } finally {
    db.close();
  }
}

function legacyV2DocumentsTableSql(): string {
  return `
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      context_id INTEGER NOT NULL,
      doc_number INTEGER NOT NULL,
      issue_date TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      modified INTEGER NOT NULL,
      api_doc_id TEXT NULL UNIQUE,
      cache_source TEXT NOT NULL DEFAULT 'api',
      document_name TEXT NULL,
      custom_doc_number TEXT NULL,
      account_id TEXT NULL,
      account_context_id INTEGER NULL,
      account_name TEXT NULL,
      account_number INTEGER NULL,
      user_id TEXT NULL,
      salesperson_name TEXT NULL,
      customer_name TEXT NULL,
      customer_number INTEGER NULL,
      supplier_name TEXT NULL,
      supplier_number INTEGER NULL,
      status_id INTEGER NULL,
      status_name TEXT NULL,
      total_price REAL NULL,
      total_cost REAL NULL,
      subtotal REAL NULL,
      associated_document_id TEXT NULL,
      external_po_number TEXT NULL,
      shipping_location TEXT NULL,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      imported_at INTEGER NULL,
      UNIQUE(context_id, doc_number)
    );
  `;
}

function legacyV2ItemDocumentsTableSql(): string {
  return `
    CREATE TABLE item_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      document_item_id TEXT NULL,
      item_name TEXT NULL,
      item_number INTEGER NULL,
      item_sku TEXT NULL,
      item_location TEXT NULL,
      line_description TEXT NULL,
      quantity_received REAL NULL,
      cost REAL NULL,
      total_amount REAL NULL,
      discounted_price REAL NULL,
      discount_percent REAL NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );
  `;
}

function legacyItemsTableSql(): string {
  return `
    CREATE TABLE items (
      item_id TEXT PRIMARY KEY,
      item_number INTEGER NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      sku TEXT NULL,
      serial_number TEXT NULL,
      barcode TEXT NULL,
      category_id TEXT NULL,
      category_name TEXT NULL,
      quantity REAL NULL,
      quantity_reserved REAL NULL,
      quantity_available REAL NULL,
      quantity_incoming REAL NULL,
      in_transit REAL NULL,
      threshold REAL NULL,
      cost REAL NULL,
      price REAL NULL,
      valuation REAL NULL,
      published INTEGER NULL,
      created TEXT NULL,
      modified INTEGER NULL,
      cache_source TEXT NOT NULL DEFAULT 'api',
      imported_at INTEGER NULL
    );
  `;
}
