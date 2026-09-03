/**
 * SQLiteCacheService unit tests
 */

import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { createCategoryFingerprint } from '../category-indexer.service.js';
import {
  CACHE_SCHEMA_VERSION,
  CATEGORY_SNAPSHOT_META_KEY,
  DocumentContextId,
  INVENTORY_ACCOUNT_META_KEY,
  INVENTORY_SNAPSHOT_META_KEY,
  createInventorySnapshotFingerprint,
} from '../types.js';
import type {
  CacheState,
  CacheSyncStatus,
  CategoryCacheMeta,
  CategorySnapshot,
  DocumentRow,
  InventoryCacheMetaV2,
  InventorySnapshot,
  ItemRow,
  ItemStockLocationRow,
} from '../types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from '../payment-sync.types.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SQLiteCacheService', () => {
  let service: SQLiteCacheService;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(
      tmpdir(),
      `test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
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
        const documentColumns = db.pragma('table_info(documents)') as Array<{
          name: string;
          notnull: number;
        }>;
        const itemColumns = db.pragma('table_info(items)') as Array<{
          name: string;
          notnull: number;
        }>;
        const indexes = [
          ...(db.pragma('index_list(documents)') as Array<{ name: string }>),
          ...(db.pragma('index_list(items)') as Array<{ name: string }>),
        ].map(({ name }) => name);

        expect(documentColumns).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'archived', notnull: 0 })])
        );
        expect(itemColumns).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'archived', notnull: 0 })])
        );
        expect(indexes).toEqual(
          expect.arrayContaining(['idx_documents_archived', 'idx_items_archived'])
        );
      } finally {
        db.close();
      }
    });

    it('creates the v7 inventory and category columns with nullable source-correct stock fields', () => {
      const db = new Database(testDbPath, { readonly: true });
      try {
        const stockColumns = db.pragma('table_info(item_stock_locations)') as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        for (const name of [
          'quantity_reserved',
          'quantity_available',
          'quantity_incoming',
          'in_transit',
        ]) {
          expect(stockColumns).toContainEqual(
            expect.objectContaining({ name, notnull: 0, dflt_value: null })
          );
        }
        expect(stockColumns).toContainEqual(
          expect.objectContaining({ name: 'source_api_version', notnull: 0 })
        );
        expect(db.pragma('table_info(items)')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'source_api_version', notnull: 0 }),
          ])
        );
        expect(db.pragma('table_info(categories)')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'inventory_type', notnull: 0 }),
            expect.objectContaining({ name: 'custom_fields_json', notnull: 0 }),
            expect.objectContaining({ name: 'source_api_version', notnull: 0 }),
          ])
        );
      } finally {
        db.close();
      }
    });

    it('migrates a genuine v6 stock table to v7 while nulling only API-fabricated fields', async () => {
      await service.close();
      rmSync(testDbPath, { force: true });
      createLegacyV6InventoryDatabase(testDbPath);

      service = new SQLiteCacheService('test-account', testDbPath);

      const db = new Database(testDbPath, { readonly: true });
      try {
        expect(db.pragma('user_version', { simple: true })).toBe(7);
        const columns = db.pragma('table_info(item_stock_locations)') as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        for (const name of [
          'quantity_reserved',
          'quantity_available',
          'quantity_incoming',
          'in_transit',
        ]) {
          expect(columns).toContainEqual(
            expect.objectContaining({ name, notnull: 0, dflt_value: null })
          );
        }
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(db.pragma('foreign_key_list(item_stock_locations)')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table: 'items',
              from: 'item_id',
              to: 'item_id',
              on_delete: 'CASCADE',
            }),
          ])
        );
        expect(
          (db.pragma('index_list(item_stock_locations)') as Array<{ name: string }>).map(
            ({ name }) => name
          )
        ).toEqual(expect.arrayContaining(['idx_stock_item', 'idx_stock_location']));

        expect(await service.getItem('legacy-api-item')).toEqual(
          expect.objectContaining({
            quantity_reserved: null,
            quantity_available: null,
            quantity_incoming: null,
            in_transit: null,
          })
        );
        expect(await service.getItem('legacy-csv-item')).toEqual(
          expect.objectContaining({
            quantity_reserved: 5,
            quantity_available: 17,
            quantity_incoming: 6,
            in_transit: 7,
          })
        );

        expect(await service.getItemStockLocations('legacy-api-item')).toEqual([
          {
            stock_row_id: 'legacy-api-stock',
            item_id: 'legacy-api-item',
            item_number: 701,
            variation_id: 'variation-api',
            variation_location_id: 'variation-location-api',
            location_id: 'location-api',
            location_name: 'API Warehouse',
            category_name: 'API Category',
            quantity_on_hand: 11,
            quantity_reserved: null,
            quantity_available: null,
            quantity_incoming: null,
            in_transit: null,
            price: 19.5,
            cost: 8.25,
            valuation: 90.75,
            barcode: 'API-BARCODE',
            cache_source: 'api',
            source_api_version: null,
            imported_at: 610,
          },
        ]);
        expect(await service.getItemStockLocations('legacy-csv-item')).toEqual([
          {
            stock_row_id: 'legacy-csv-stock',
            item_id: 'legacy-csv-item',
            item_number: 702,
            variation_id: 'variation-csv',
            variation_location_id: 'variation-location-csv',
            location_id: 'location-csv',
            location_name: 'CSV Warehouse',
            category_name: 'CSV Category',
            quantity_on_hand: 22,
            quantity_reserved: 5,
            quantity_available: 17,
            quantity_incoming: 6,
            in_transit: 7,
            price: 29.5,
            cost: 18.25,
            valuation: 401.5,
            barcode: 'CSV-BARCODE',
            cache_source: 'csv',
            source_api_version: null,
            imported_at: 620,
          },
        ]);
      } finally {
        db.close();
      }
    });

    it('migrates schema v3 lifecycle state as unknown without losing records', async () => {
      await service.insertDocument({
        doc_id: 'legacy-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 7001,
        issue_date: '2026-01-01',
        customer_id: 'customer-1',
        modified: 1,
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
    ] as const)(
      'migrates genuine schema v%s fixtures to the current schema without losing rows',
      async (version, createLegacyDatabase, expectedArchived, expectedPaymentCount) => {
        await service.close();
        rmSync(testDbPath, { force: true });
        createLegacyDatabase(testDbPath);

        service = new SQLiteCacheService('test-account', testDbPath);

        const migratedDb = new Database(testDbPath, { readonly: true });
        try {
          expect(migratedDb.pragma('user_version', { simple: true })).toBe(CACHE_SCHEMA_VERSION);
          expect(
            (migratedDb.pragma('table_info(documents)') as Array<{ name: string }>).map(
              ({ name }) => name
            )
          ).toEqual(expect.arrayContaining(['date_sent', 'shipped_percent']));
          expect(
            (migratedDb.pragma('table_info(item_documents)') as Array<{ name: string }>).map(
              ({ name }) => name
            )
          ).toContain('quantity_shipped');
          expect(migratedDb.pragma('index_list(documents)')).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'idx_documents_api_doc_id', unique: 1 }),
            ])
          );
          expect(
            migratedDb.pragma('table_info(payment_transactions)') as Array<{ name: string }>
          ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'transaction_id' })]));
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
          expect(await service.getAllPaymentTransactions()).toEqual(
            expectedPaymentCount === 0
              ? []
              : [
                  {
                    transaction_id: `payment-v${version}`,
                    doc_id: `legacy-v${version}-doc`,
                    amount: 25,
                    transaction_date: `2026-0${version}-02`,
                    reference: null,
                    imported_at: version * 100,
                  },
                ]
          );
        } finally {
          migratedDb.close();
        }
      }
    );

    it('keeps a v4 migration atomic and reports duplicate legacy API document IDs', async () => {
      await service.close();
      rmSync(testDbPath, { force: true });
      createLegacyV4DatabaseWithDuplicateApiIds(testDbPath);

      expect(() => new SQLiteCacheService('test-account', testDbPath)).toThrow(
        /Cannot migrate cache schema: documents contains 2 rows with api_doc_id "duplicate-api-id"/
      );

      const legacyDb = new Database(testDbPath, { readonly: true });
      try {
        expect(legacyDb.pragma('user_version', { simple: true })).toBe(4);
        expect(
          (legacyDb.pragma('table_info(documents)') as Array<{ name: string }>).map(
            ({ name }) => name
          )
        ).not.toContain('date_sent');
        expect(
          (legacyDb.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number })
            .count
        ).toBe(2);
      } finally {
        legacyDb.close();
      }
    });
  });

  describe('PostgreSQL shipping storage', () => {
    it('adds shipping columns idempotently before creating their index', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn(async (sql: string) => ({
        rows: sql.includes('SELECT account_identity')
          ? [
              {
                account_identity: 'salesbinder:test',
                account_subdomain: 'test',
                created_at: 1,
              },
            ]
          : ([] as unknown[]),
      }));
      const client = { query, release: jest.fn() };
      (pgService as unknown as { expectedBinding: object }).expectedBinding = {
        accountIdentity: 'salesbinder:test',
        accountSubdomain: 'test',
        createdAt: 1,
      };
      (pgService as unknown as { pool: { connect: jest.Mock } }).pool = {
        connect: jest.fn(async () => client),
      };

      await pgService.ensureSchema();

      const statements = query.mock.calls.map(([sql]) => String(sql));
      const migrations = statements.find((sql) => sql.includes('ALTER TABLE documents')) ?? '';
      const indexes =
        statements.find((sql) =>
          sql.includes('CREATE INDEX IF NOT EXISTS idx_documents_shipped_percent')
        ) ?? '';
      expect(migrations).toContain(
        'ALTER TABLE documents ADD COLUMN IF NOT EXISTS date_sent TEXT NULL'
      );
      expect(migrations).toContain(
        'ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipped_percent NUMERIC NULL'
      );
      expect(statements.find((sql) => sql.includes('ALTER TABLE item_documents'))).toContain(
        'ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_shipped NUMERIC NULL'
      );
      expect(statements.indexOf(migrations)).toBeLessThan(statements.indexOf(indexes));
      const schemaSql = statements.join('\n');
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS categories');
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS category_cache_meta');
      expect(schemaSql).not.toContain('shipment_checked_at');
    });

    it('coerces PostgreSQL shipping numerics to numbers', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const document = {
        doc_id: 'pg-doc',
        context_id: DocumentContextId.Invoice,
        doc_number: 1,
        issue_date: '2026-08-01',
        customer_id: 'pg-customer',
        modified: 1,
        date_sent: '2026-08-02',
        shipped_percent: '37.5' as unknown as number,
      };
      const itemDocument = {
        item_id: 'pg-item',
        doc_id: 'pg-doc',
        quantity: '2' as unknown as number,
        price: '10' as unknown as number,
        quantity_shipped: '1.25' as unknown as number,
      };
      const query = jest.fn(async (sql: string) => ({
        rows: sql.includes('item_documents') ? [itemDocument] : [document],
      }));
      (pgService as unknown as { pool: { query: jest.Mock } }).pool = { query };

      expect(await pgService.getDocument('pg-doc')).toMatchObject({
        date_sent: '2026-08-02',
        shipped_percent: 37.5,
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

  describe('Category snapshot authority', () => {
    it('rejects a wrong category fingerprint before replacing categories or reconciling inventory', async () => {
      const priorCategory = categorySnapshotFixture('category-before-invalid-write');
      await service.replaceCategorySnapshot(priorCategory);
      const priorInventory = inventorySnapshot(
        'inventory-before-invalid-category',
        [
          {
            item_id: 'categorized-item',
            name: 'Categorized item',
            category_id: priorCategory.rows[0].category_id,
            category_name: priorCategory.rows[0].name,
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        [
          stockRow('categorized-stock', 'categorized-item', {
            category_name: priorCategory.rows[0].name,
          }),
        ]
      );
      await service.replaceInventorySnapshot(priorInventory);

      const invalid = categorySnapshotFixture('category-invalid-fingerprint');
      invalid.rows[0].name = 'Renamed category';
      invalid.meta.fingerprint = 'sha256:wrong';

      expect(() => service.replaceCategorySnapshot(invalid)).toThrow(/fingerprint/i);
      expect(await service.getCategorySnapshot()).toEqual(priorCategory);
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(priorInventory.items[0])],
        stockRows: [expect.objectContaining(priorInventory.stockRows[0])],
        meta: priorInventory.meta,
      });
    });

    it('rejects correctly fingerprinted noncanonical category IDs and mixed source versions without mutation', async () => {
      const priorCategory = categorySnapshotFixture('category-before-invalid-identities');
      await service.replaceCategorySnapshot(priorCategory);
      const priorInventory = inventorySnapshot('inventory-before-invalid-category-identities');
      await service.replaceInventorySnapshot(priorInventory);
      const invalidCandidates: Array<(snapshot: CategorySnapshot) => void> = [
        (snapshot) => {
          snapshot.rows[0].category_id = ' category-with-leading-space';
        },
        (snapshot) => {
          snapshot.rows[0].parent_id = 'parent\ncontrol';
          snapshot.rows[0].parent_name = null;
        },
        (snapshot) => {
          snapshot.rows[0].source_api_version = '2.0';
        },
        (snapshot) => {
          snapshot.meta.sourceApiVersion = '2.0';
        },
        (snapshot) => {
          snapshot.rows[0].item_count = 2_147_483_648;
        },
        (snapshot) => {
          snapshot.rows[0].name = 'category-\ud800';
        },
        (snapshot) => {
          snapshot.meta.generation = 'generation-\udc00';
        },
      ];

      for (const [index, mutate] of invalidCandidates.entries()) {
        const candidate = categorySnapshotFixture(`invalid-category-identity-${index}`);
        mutate(candidate);
        refreshCategoryFingerprint(candidate);

        expect(() => service.replaceCategorySnapshot(candidate)).toThrow(/invalid/i);
      }

      expect(await service.getCategorySnapshot()).toEqual(priorCategory);
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(priorInventory.items[0])],
        stockRows: [expect.objectContaining(priorInventory.stockRows[0])],
        meta: priorInventory.meta,
      });
    });

    it('accepts well-formed non-BMP category text', async () => {
      const candidate = categorySnapshotFixture('category-🚀');
      candidate.rows[0].name = 'Category 🚀';
      refreshCategoryFingerprint(candidate);

      await service.replaceCategorySnapshot(candidate);

      expect(await service.getCategorySnapshot()).toEqual(candidate);
    });

    it('rejects same-count category tampering consistently across category readers', async () => {
      const snapshot = categorySnapshotFixture('category-generation');
      await service.replaceCategorySnapshot(snapshot);
      expect(await service.getCategoryCacheMeta()).toEqual(snapshot.meta);
      expect(await service.getCategorySnapshot()).toEqual(snapshot);

      const db = new Database(testDbPath);
      try {
        db.prepare('UPDATE categories SET name = ? WHERE category_id = ?').run(
          'Tampered category',
          snapshot.rows[0].category_id
        );
      } finally {
        db.close();
      }

      expect(await service.getCategoryCacheMeta()).toBeNull();
      expect(await service.getCategorySnapshot()).toBeNull();
      expect(await service.getCategory(snapshot.rows[0].category_id)).toBeUndefined();
      expect(await service.getAllCategories()).toEqual([]);
      expect(await service.getCategoryCount()).toBe(0);
    });

    it('fails category readers closed on correctly fingerprinted canonical-ID and source-version violations', async () => {
      for (const mutate of [
        (snapshot: CategorySnapshot) => {
          snapshot.rows[0].category_id = 'category\ncontrol';
        },
        (snapshot: CategorySnapshot) => {
          snapshot.rows[0].source_api_version = '2.0';
        },
        (snapshot: CategorySnapshot) => {
          snapshot.meta.sourceApiVersion = '2.0';
        },
        (snapshot: CategorySnapshot) => {
          snapshot.rows[0].item_count = 2_147_483_648;
        },
      ]) {
        await service.clearAll();
        const invalid = categorySnapshotFixture('raw-invalid-category-authority');
        mutate(invalid);
        refreshCategoryFingerprint(invalid);
        const db = new Database(testDbPath);
        try {
          db.prepare(
            'INSERT INTO categories (' +
              'category_id, name, item_count, parent_id, parent_name, inventory_type, ' +
              'custom_fields_json, created, modified, cache_source, source_api_version, imported_at' +
              ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(
            invalid.rows[0].category_id,
            invalid.rows[0].name,
            invalid.rows[0].item_count,
            invalid.rows[0].parent_id,
            invalid.rows[0].parent_name,
            invalid.rows[0].inventory_type,
            invalid.rows[0].custom_fields_json,
            invalid.rows[0].created,
            invalid.rows[0].modified,
            invalid.rows[0].cache_source,
            invalid.rows[0].source_api_version,
            invalid.rows[0].imported_at
          );
          db.prepare('INSERT INTO category_cache_meta (key, value) VALUES (?, ?)').run(
            CATEGORY_SNAPSHOT_META_KEY,
            JSON.stringify(invalid.meta)
          );
          db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run(
            'category_cache.v7.generation',
            invalid.meta.generation
          );
          db.prepare("INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)").run(
            JSON.stringify({
              lastSync: 0,
              lastFullSync: 0,
              documentCount: 0,
              itemDocumentCount: 0,
              accountName: 'test-account',
              schemaVersion: CACHE_SCHEMA_VERSION,
            })
          );
        } finally {
          db.close();
        }

        await expect(service.getCategoryCacheMeta()).resolves.toBeNull();
        await expect(service.getCategorySnapshot()).resolves.toBeNull();
      }
    });

    it('propagates category storage failures instead of reporting missing authority', async () => {
      const snapshot = categorySnapshotFixture('category-storage-failure');
      await service.replaceCategorySnapshot(snapshot);
      expect(await service.getCategoryCacheMeta()).toEqual(snapshot.meta);
      const db = (service as unknown as { db: Database.Database }).db;
      db.exec('DROP TABLE categories');

      const outcome = await Promise.resolve()
        .then(() => service.getCategoryCacheMeta())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
      expect(outcome).toEqual({
        error: expect.objectContaining({
          message: expect.stringMatching(/no such table: categories/i),
        }),
      });
    });
  });

  describe('Inventory schema v7 snapshots', () => {
    const publishRawInventorySnapshot = async (snapshot: InventorySnapshot): Promise<void> => {
      await service.batchInsertItems(snapshot.items);
      await service.batchInsertItemStockLocations(snapshot.stockRows);
      await service.setCacheState({
        lastSync: 0,
        lastFullSync: 0,
        documentCount: 0,
        itemDocumentCount: 0,
        accountName: 'test-account',
        schemaVersion: 7,
        itemCount: snapshot.items.length,
        stockLocationCount: snapshot.stockRows.length,
        inventorySourceApiVersion: '3',
      });
      const db = new Database(testDbPath);
      try {
        db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run(
          INVENTORY_SNAPSHOT_META_KEY,
          JSON.stringify(snapshot.meta)
        );
        db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run(
          INVENTORY_ACCOUNT_META_KEY,
          snapshot.meta.accountIdentity
        );
      } finally {
        db.close();
      }
    };

    it('round-trips nullable stock values through insert, batch, and replacement writes', async () => {
      await service.insertItem({
        item_id: 'nullable-item',
        name: 'Nullable item',
        source_api_version: null,
      });
      const nullable = stockRow('nullable-stock', 'nullable-item', {
        quantity_reserved: null,
        quantity_available: null,
        quantity_incoming: null,
        in_transit: null,
        source_api_version: null,
      });
      await service.insertItemStockLocation(nullable);
      expect(await service.getItemStockLocations('nullable-item')).toEqual([
        expect.objectContaining(nullable),
      ]);

      await service.batchInsertItemStockLocations([
        stockRow('batch-nullable', 'nullable-item', {
          quantity_reserved: null,
          quantity_available: 0,
          quantity_incoming: null,
          in_transit: 2,
        }),
      ]);
      await service.replaceItemStockLocations('nullable-item', [
        stockRow('replacement-nullable', 'nullable-item', {
          quantity_reserved: null,
          quantity_available: null,
          quantity_incoming: null,
          in_transit: null,
        }),
      ]);
      expect(await service.getItemStockLocations('nullable-item')).toEqual([
        expect.objectContaining({
          stock_row_id: 'replacement-nullable',
          quantity_reserved: null,
          quantity_available: null,
          quantity_incoming: null,
          in_transit: null,
        }),
      ]);
    });

    it('atomically replaces API inventory while preserving CSV-only rows and publishing metadata', async () => {
      const csvItem: ItemRow = { item_id: 'csv-item', name: 'CSV item', cache_source: 'csv' };
      const csvStock = stockRow('csv-stock', 'csv-item', {
        cache_source: 'csv',
        quantity_reserved: 4,
        quantity_available: 6,
        quantity_incoming: 8,
        in_transit: 2,
        source_api_version: null,
      });
      await service.insertItem(csvItem);
      await service.insertItemStockLocation(csvStock);
      await service.insertItem({ item_id: 'old-api-item', name: 'Old API', cache_source: 'api' });
      await service.insertItemStockLocation(stockRow('old-api-stock', 'old-api-item'));

      const snapshot = inventorySnapshot('generation-success');
      await service.replaceInventorySnapshot(snapshot);

      expect(await service.getAllItems()).toEqual(
        expect.arrayContaining([
          expect.objectContaining(csvItem),
          expect.objectContaining(snapshot.items[0]),
        ])
      );
      expect(await service.getItem('old-api-item')).toBeUndefined();
      expect(await service.getAllItemStockLocations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining(csvStock),
          expect.objectContaining(snapshot.stockRows[0]),
        ])
      );
      expect(await service.getInventoryCacheMeta()).toEqual(snapshot.meta);
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(snapshot.items[0])],
        stockRows: [expect.objectContaining(snapshot.stockRows[0])],
        meta: snapshot.meta,
      });
      expect(rawTextMeta(testDbPath, INVENTORY_SNAPSHOT_META_KEY)).toBe(
        JSON.stringify(snapshot.meta)
      );
      expect(rawTextMeta(testDbPath, INVENTORY_ACCOUNT_META_KEY)).toBe(
        snapshot.meta.accountIdentity
      );
      expect(await service.getCacheState()).toMatchObject({
        schemaVersion: 7,
        itemCount: 2,
        stockLocationCount: 2,
        lastItemSync: snapshot.meta.completedAt,
        lastFullItemSync: snapshot.meta.completedAt,
        lastSyncAttempt: snapshot.meta.completedAt,
        inventorySourceApiVersion: '3',
      });
    });

    it('rolls back inventory rows, metadata, and the attempt watermark as one transaction', async () => {
      const prior = inventorySnapshot('inventory-before-transaction-failure');
      await service.replaceInventorySnapshot(prior);
      const candidate = inventorySnapshot('inventory-that-must-roll-back');
      candidate.meta.completedAt = 200;
      candidate.items[0].name = 'Candidate item that must roll back';
      refreshInventoryFingerprint(candidate);
      const db = new Database(testDbPath);
      try {
        db.exec(`
          CREATE TRIGGER fail_inventory_metadata
          BEFORE INSERT ON cache_meta
          WHEN NEW.key = '${INVENTORY_SNAPSHOT_META_KEY}'
          BEGIN
            SELECT RAISE(ABORT, 'injected inventory metadata failure');
          END;
        `);
      } finally {
        db.close();
      }

      expect(() => service.replaceInventorySnapshot(candidate)).toThrow(
        /injected inventory metadata failure/i
      );
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(prior.items[0])],
        stockRows: [expect.objectContaining(prior.stockRows[0])],
        meta: prior.meta,
      });
      expect(await service.getCacheState()).toMatchObject({
        lastSyncAttempt: prior.meta.completedAt,
        lastItemSync: prior.meta.completedAt,
        lastFullItemSync: prior.meta.completedAt,
      });
    });

    it('rejects incomplete item bundles before replacing the prior authoritative snapshot', async () => {
      const prior = inventorySnapshot('inventory-before-incomplete-bundle');
      await service.replaceInventorySnapshot(prior);
      const incomplete = inventorySnapshot(
        'inventory-missing-stock-row',
        [
          {
            item_id: 'uncovered-item',
            name: 'Uncovered item',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        []
      );

      expect(() => service.replaceInventorySnapshot(incomplete)).toThrow(
        /at least one stock row for every item/i
      );
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(prior.items[0])],
        stockRows: [expect.objectContaining(prior.stockRows[0])],
        meta: prior.meta,
      });
      expect(rawTextMeta(testDbPath, INVENTORY_SNAPSHOT_META_KEY)).toBe(JSON.stringify(prior.meta));
    });

    it('rejects invalid inventory numerics and binary flags before mutation', async () => {
      const prior = inventorySnapshot('inventory-before-invalid-numerics');
      await service.replaceInventorySnapshot(prior);
      const invalidValues = [
        ['item', 'quantity', Number.NaN],
        ['item', 'quantity', null],
        ['item', 'quantity', undefined],
        ['item', 'quantity_reserved', Number.POSITIVE_INFINITY],
        ['item', 'cost', Number.NEGATIVE_INFINITY],
        ['item', 'item_number', 1.5],
        ['item', 'published', 7],
        ['item', 'archived', 9],
        ['item', 'modified', -1],
        ['item', 'imported_at', 1.5],
        ['stock', 'quantity_on_hand', Number.NaN],
        ['stock', 'quantity_on_hand', null],
        ['stock', 'quantity_on_hand', undefined],
        ['stock', 'quantity_available', Number.POSITIVE_INFINITY],
        ['stock', 'valuation', Number.NEGATIVE_INFINITY],
        ['stock', 'item_number', 1.5],
        ['stock', 'imported_at', -1],
      ] as const;

      for (const [target, field, value] of invalidValues) {
        const candidate = inventorySnapshot(`invalid-${target}-${field}`);
        const row = target === 'item' ? candidate.items[0] : candidate.stockRows[0];
        (row as unknown as Record<string, unknown>)[field] = value;

        expect(() => service.replaceInventorySnapshot(candidate)).toThrow(/invalid/i);
      }

      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(prior.items[0])],
        stockRows: [expect.objectContaining(prior.stockRows[0])],
        meta: prior.meta,
      });
    });

    it('rejects correctly fingerprinted inventory text containing NUL before mutation', async () => {
      const prior = inventorySnapshot('inventory-before-invalid-text');
      await service.replaceInventorySnapshot(prior);

      for (const [target, field] of [
        ['item', 'description'],
        ['stock', 'location_name'],
      ] as const) {
        const candidate = inventorySnapshot(`invalid-text-${target}-${field}`);
        const row = target === 'item' ? candidate.items[0] : candidate.stockRows[0];
        (row as unknown as Record<string, unknown>)[field] = 'before\0after';
        candidate.meta.fingerprint = createInventorySnapshotFingerprint(
          candidate.meta.accountIdentity,
          candidate.meta.generation,
          candidate.items,
          candidate.stockRows
        );

        expect(() => service.replaceInventorySnapshot(candidate)).toThrow(/invalid/i);
      }

      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(prior.items[0])],
        stockRows: [expect.objectContaining(prior.stockRows[0])],
        meta: prior.meta,
      });
    });

    it('rejects unpaired inventory text before mutation and accepts non-BMP pairs', async () => {
      const prior = inventorySnapshot('inventory-before-invalid-surrogates');
      await service.replaceInventorySnapshot(prior);

      for (const [target, field, value] of [
        ['item', 'name', 'item-\ud800'],
        ['stock', 'location_name', 'location-\udc00'],
        ['meta', 'generation', 'generation-\ud800'],
      ] as const) {
        const candidate = inventorySnapshot(`invalid-surrogate-${target}-${field}`);
        if (target === 'meta') candidate.meta.generation = value;
        else {
          const row = target === 'item' ? candidate.items[0] : candidate.stockRows[0];
          (row as unknown as Record<string, unknown>)[field] = value;
        }
        refreshInventoryFingerprint(candidate);

        expect(() => service.replaceInventorySnapshot(candidate)).toThrow(/invalid|metadata/i);
      }

      const valid = inventorySnapshot('inventory-🚀');
      valid.items[0].name = 'Item 🚀';
      valid.stockRows[0].location_name = 'Warehouse 🚀';
      refreshInventoryFingerprint(valid);
      await service.replaceInventorySnapshot(valid);
      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(valid.items[0])],
        stockRows: [expect.objectContaining(valid.stockRows[0])],
        meta: valid.meta,
      });
    });

    it('rejects correctly fingerprinted noncanonical IDs and incoherent stock rows before mutation', async () => {
      const prior = inventorySnapshot('inventory-before-invalid-identities');
      await service.replaceInventorySnapshot(prior);
      const invalidCandidates: Array<(snapshot: InventorySnapshot) => void> = [
        (snapshot) => {
          snapshot.items[0].item_id = ' item-with-leading-space';
          snapshot.stockRows[0].item_id = snapshot.items[0].item_id;
        },
        (snapshot) => {
          snapshot.items[0].category_id = 'category\ncontrol';
        },
        (snapshot) => {
          snapshot.stockRows[0].stock_row_id = 's'.repeat(257);
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation-with-trailing-space ';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_location_id = 'variation-location';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].variation_location_id = 'variation-location';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].location_id = 'location';
        },
        (snapshot) => {
          snapshot.stockRows[0].stock_row_id = '01';
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].variation_location_id = '01';
          snapshot.stockRows[0].location_id = 'location';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].variation_location_id = '42';
          snapshot.stockRows[0].location_id = 'location';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].variation_location_id = 'variation-location\u007f';
        },
        (snapshot) => {
          snapshot.stockRows[0].location_id = 'location\tcontrol';
        },
        (snapshot) => {
          snapshot.items[0].item_number = 1;
          snapshot.stockRows[0].item_number = 2;
        },
        (snapshot) => {
          snapshot.items[0].item_number = 2_147_483_648;
          snapshot.stockRows[0].item_number = 2_147_483_648;
        },
        (snapshot) => {
          snapshot.items[0].category_name = 'Parent category';
          snapshot.stockRows[0].category_name = 'Different category';
        },
        (snapshot) => {
          snapshot.items[0].price = 10;
          snapshot.stockRows[0].price = 11;
        },
        (snapshot) => {
          snapshot.items[0].cost = 5;
          snapshot.stockRows[0].cost = 6;
        },
        (snapshot) => {
          snapshot.stockRows[0].quantity_on_hand = 9;
        },
        (snapshot) => {
          snapshot.items[0].quantity_reserved = 1;
          snapshot.stockRows[0].quantity_reserved = 2;
        },
        (snapshot) => {
          snapshot.items[0].quantity_available = 8;
          snapshot.stockRows[0].quantity_available = 7;
        },
        (snapshot) => {
          snapshot.items[0].quantity_incoming = 1;
          snapshot.stockRows[0].quantity_incoming = 2;
        },
        (snapshot) => {
          snapshot.items[0].in_transit = 1;
          snapshot.stockRows[0].in_transit = 2;
        },
        (snapshot) => {
          snapshot.items[0].barcode = 'parent-barcode';
          snapshot.stockRows[0].barcode = 'different-barcode';
        },
        (snapshot) => {
          snapshot.stockRows.push(stockRow('second-parent-stock', snapshot.items[0].item_id));
          snapshot.meta.stockRowCount = 2;
        },
        (snapshot) => {
          snapshot.stockRows.push(
            stockRow('variation-stock', snapshot.items[0].item_id, {
              variation_id: 'variation',
            })
          );
          snapshot.meta.stockRowCount = 2;
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows.push({
            ...snapshot.stockRows[0],
            stock_row_id: 'second-aggregate-stock',
          });
          snapshot.meta.stockRowCount = 2;
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows.push({
            ...snapshot.stockRows[0],
            stock_row_id: '42',
            variation_location_id: '42',
            location_id: 'location',
          });
          snapshot.meta.stockRowCount = 2;
        },
      ];

      for (const [index, mutate] of invalidCandidates.entries()) {
        const candidate = inventorySnapshot(`invalid-inventory-relationship-${index}`);
        mutate(candidate);
        refreshInventoryFingerprint(candidate);

        expect(() => service.replaceInventorySnapshot(candidate)).toThrow(/invalid/i);
      }

      expect(await service.getInventorySnapshot()).toEqual({
        items: [expect.objectContaining(prior.items[0])],
        stockRows: [expect.objectContaining(prior.stockRows[0])],
        meta: prior.meta,
      });
    });

    it('fails closed when stored authoritative rows lack stock coverage or contain invalid values', async () => {
      const incomplete = inventorySnapshot(
        'raw-inventory-missing-stock',
        [
          {
            item_id: 'raw-uncovered-item',
            name: 'Raw uncovered item',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        []
      );
      await publishRawInventorySnapshot(incomplete);

      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect(await service.getInventorySnapshot()).toBeNull();

      const valid = inventorySnapshot('raw-inventory-non-finite');
      await service.replaceInventorySnapshot(valid);
      const db = new Database(testDbPath);
      try {
        db.prepare('UPDATE items SET cost = ? WHERE item_id = ?').run(
          Number.POSITIVE_INFINITY,
          valid.items[0].item_id
        );
      } finally {
        db.close();
      }

      await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
      await expect(service.getInventorySnapshot()).resolves.toBeNull();

      const invalidText = inventorySnapshot('raw-inventory-invalid-text');
      invalidText.items[0].description = 'before\0after';
      invalidText.meta.fingerprint = createInventorySnapshotFingerprint(
        invalidText.meta.accountIdentity,
        invalidText.meta.generation,
        invalidText.items,
        invalidText.stockRows
      );
      await publishRawInventorySnapshot(invalidText);

      await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
      await expect(service.getInventorySnapshot()).resolves.toBeNull();

      const invalidSurrogate = inventorySnapshot('raw-inventory-invalid-surrogate');
      invalidSurrogate.meta.generation = 'raw-generation-\ud800';
      refreshInventoryFingerprint(invalidSurrogate);
      await publishRawInventorySnapshot(invalidSurrogate);

      await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
      await expect(service.getInventorySnapshot()).resolves.toBeNull();
    });

    it('fails closed on correctly fingerprinted stored noncanonical IDs and incoherent stock rows', async () => {
      const invalidCandidates: Array<(snapshot: InventorySnapshot) => void> = [
        (snapshot) => {
          snapshot.items[0].item_id = 'item\ncontrol';
          snapshot.stockRows[0].item_id = snapshot.items[0].item_id;
        },
        (snapshot) => {
          snapshot.items[0].price = 10;
          snapshot.stockRows[0].price = 11;
        },
        (snapshot) => {
          snapshot.stockRows[0].quantity_on_hand = 9;
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_location_id = 'variation-location';
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows[0].location_id = 'location';
        },
        (snapshot) => {
          snapshot.items[0].item_number = 2_147_483_648;
          snapshot.stockRows[0].item_number = 2_147_483_648;
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows.push({
            ...snapshot.stockRows[0],
            stock_row_id: 'second-aggregate-stock',
          });
          snapshot.meta.stockRowCount = 2;
        },
        (snapshot) => {
          snapshot.stockRows[0].variation_id = 'variation';
          snapshot.stockRows.push({
            ...snapshot.stockRows[0],
            stock_row_id: '42',
            variation_location_id: '42',
            location_id: 'location',
          });
          snapshot.meta.stockRowCount = 2;
        },
      ];

      for (const [index, mutate] of invalidCandidates.entries()) {
        await service.clearAll();
        const candidate = inventorySnapshot(`raw-invalid-inventory-relationship-${index}`);
        mutate(candidate);
        refreshInventoryFingerprint(candidate);
        await publishRawInventorySnapshot(candidate);

        await expect(service.getInventoryCacheMeta()).resolves.toBeNull();
        await expect(service.getInventorySnapshot()).resolves.toBeNull();
      }
    });

    it('accepts normalized aggregate and explicit variation-only inventory bundles', async () => {
      for (const [generation, mutate] of [
        [
          'aggregate-variation-only',
          (snapshot: InventorySnapshot) => {
            snapshot.stockRows[0].variation_id = 'variation';
          },
        ],
        [
          'explicit-variation-location',
          (snapshot: InventorySnapshot) => {
            snapshot.stockRows[0].stock_row_id = '42';
            snapshot.stockRows[0].variation_id = 'variation';
            snapshot.stockRows[0].variation_location_id = '42';
            snapshot.stockRows[0].location_id = 'location';
          },
        ],
      ] as const) {
        const candidate = inventorySnapshot(generation);
        mutate(candidate);
        refreshInventoryFingerprint(candidate);

        await service.replaceInventorySnapshot(candidate);

        expect(await service.getInventorySnapshot()).toEqual({
          items: [expect.objectContaining(candidate.items[0])],
          stockRows: [expect.objectContaining(candidate.stockRows[0])],
          meta: candidate.meta,
        });
      }
    });

    it('accepts both clean and warning inventory metadata v2 while keeping v1 readable', async () => {
      const v1 = inventorySnapshot('generation-v1');
      await service.replaceInventorySnapshot(v1);
      expect(await service.getInventoryCacheMeta()).toEqual(v1.meta);

      const clean: InventorySnapshot = {
        ...v1,
        meta: {
          ...v1.meta,
          version: 2,
          status: 'complete',
          completedAt: 110,
          freshItemCount: 1,
          preservedItemCount: 0,
          omittedItemCount: 0,
          warningCount: 0,
          lastCompleteAt: 110,
          generation: 'generation-v2-clean',
          fingerprint: createInventorySnapshotFingerprint(
            v1.meta.accountIdentity,
            'generation-v2-clean',
            v1.items,
            v1.stockRows
          ),
        },
      };
      await service.replaceInventorySnapshot(clean);
      expect(await service.getInventoryCacheMeta()).toEqual(clean.meta);

      const warning: InventorySnapshot = {
        ...clean,
        meta: {
          ...(clean.meta as InventoryCacheMetaV2),
          status: 'complete_with_warnings',
          completedAt: 120,
          freshItemCount: 0,
          preservedItemCount: 1,
          omittedItemCount: 1,
          warningCount: 2,
          lastCompleteAt: 110,
          generation: 'generation-v2-warning',
          fingerprint: createInventorySnapshotFingerprint(
            clean.meta.accountIdentity,
            'generation-v2-warning',
            clean.items,
            clean.stockRows
          ),
        },
      };
      await service.replaceInventorySnapshot(warning);

      expect(await service.getInventoryCacheMeta()).toEqual(warning.meta);
      expect(await service.getCacheState()).toMatchObject({
        schemaVersion: CACHE_SCHEMA_VERSION,
        lastItemSync: 120,
        lastFullItemSync: 120,
        lastSyncAttempt: 120,
        inventorySourceApiVersion: '3',
      });
    });

    it('reads genuine historical v1 Unicode fingerprints but rejects uncovered-field tampering', async () => {
      const snapshot = historicalV1InventorySnapshot('salesbinder:test-account');
      await publishRawInventorySnapshot(snapshot);
      const db = new Database(testDbPath);
      try {
        expect((await service.getInventorySnapshot())?.meta).toEqual(snapshot.meta);

        for (const [tamper, restore] of [
          [
            "UPDATE items SET valuation = 99 WHERE item_id = 'z'",
            "UPDATE items SET valuation = NULL WHERE item_id = 'z'",
          ],
          [
            "UPDATE items SET imported_at = 99 WHERE item_id = 'z'",
            "UPDATE items SET imported_at = NULL WHERE item_id = 'z'",
          ],
          [
            "UPDATE item_stock_locations SET valuation = 99 WHERE stock_row_id = 'z'",
            "UPDATE item_stock_locations SET valuation = NULL WHERE stock_row_id = 'z'",
          ],
          [
            "UPDATE item_stock_locations SET imported_at = 99 WHERE stock_row_id = 'z'",
            "UPDATE item_stock_locations SET imported_at = NULL WHERE stock_row_id = 'z'",
          ],
          [
            "UPDATE item_stock_locations SET variation_location_id = 'tampered' WHERE stock_row_id = 'z'",
            "UPDATE item_stock_locations SET variation_location_id = NULL WHERE stock_row_id = 'z'",
          ],
        ] as const) {
          db.exec(tamper);
          expect(await service.getInventorySnapshot()).toBeNull();
          db.exec(restore);
          expect(await service.getInventorySnapshot()).not.toBeNull();
        }
      } finally {
        db.close();
      }
    });

    it('reads historical v1 parent stock rows whose location ID was omitted before persistence', async () => {
      const snapshot = historicalV1InventorySnapshot('salesbinder:test-account', true);
      await publishRawInventorySnapshot(snapshot);

      expect((await service.getInventorySnapshot())?.meta).toEqual(snapshot.meta);
    });

    it('resolves shared item identities to v3 while preserving CSV stock across snapshots', async () => {
      await service.insertItem({ item_id: 'shared-item', name: 'CSV item', cache_source: 'csv' });
      const csvStock = stockRow('csv-shared-stock', 'shared-item', {
        cache_source: 'csv',
        source_api_version: null,
        quantity_reserved: 4,
      });
      await service.insertItemStockLocation(csvStock);
      const first = inventorySnapshot(
        'generation-first',
        [
          {
            item_id: 'shared-item',
            name: 'V3 item',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        [stockRow('api-first-stock', 'shared-item')]
      );

      await service.replaceInventorySnapshot(first);
      expect(await service.getItem('shared-item')).toMatchObject({
        name: 'V3 item',
        cache_source: 'api',
        source_api_version: '3',
      });
      expect(await service.getItemStockLocations('shared-item')).toEqual(
        expect.arrayContaining([
          expect.objectContaining(csvStock),
          expect.objectContaining(first.stockRows[0]),
        ])
      );

      const second = inventorySnapshot(
        'generation-second',
        [
          {
            item_id: 'shared-item',
            name: 'V3 item updated',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        [stockRow('api-second-stock', 'shared-item')]
      );
      await service.replaceInventorySnapshot(second);

      expect(await service.getItemStockLocations('shared-item')).toEqual(
        expect.arrayContaining([
          expect.objectContaining(csvStock),
          expect.objectContaining(second.stockRows[0]),
        ])
      );
      expect(await service.getItemStockLocations('shared-item')).toHaveLength(2);
      expect(await service.getInventoryCacheMeta()).toEqual(second.meta);
    });

    it('fails inventory metadata closed on schema, account, metadata, and row-count mismatches', async () => {
      const snapshot = inventorySnapshot('generation-authority');
      await service.replaceInventorySnapshot(snapshot);
      const db = new Database(testDbPath);
      try {
        const state = await service.getCacheState();
        db.prepare(`UPDATE cache_meta SET value = ? WHERE key = 'state'`).run(
          JSON.stringify({ ...state, schemaVersion: 6 })
        );
        expect(await service.getInventoryCacheMeta()).toBeNull();
        db.prepare(`UPDATE cache_meta SET value = ? WHERE key = 'state'`).run(
          JSON.stringify(state)
        );

        db.prepare('UPDATE cache_meta SET value = ? WHERE key = ?').run(
          'salesbinder:other',
          INVENTORY_ACCOUNT_META_KEY
        );
        expect(await service.getInventoryCacheMeta()).toBeNull();
        db.prepare('UPDATE cache_meta SET value = ? WHERE key = ?').run(
          snapshot.meta.accountIdentity,
          INVENTORY_ACCOUNT_META_KEY
        );

        db.prepare('UPDATE cache_meta SET value = ? WHERE key = ?').run(
          JSON.stringify({ ...snapshot.meta, unexpected: true }),
          INVENTORY_SNAPSHOT_META_KEY
        );
        expect(await service.getInventoryCacheMeta()).toBeNull();
        db.prepare('UPDATE cache_meta SET value = ? WHERE key = ?').run(
          JSON.stringify(snapshot.meta),
          INVENTORY_SNAPSHOT_META_KEY
        );

        db.prepare(`DELETE FROM item_stock_locations WHERE cache_source = 'api'`).run();
        expect(await service.getInventoryCacheMeta()).toBeNull();
      } finally {
        db.close();
      }
    });

    it('rejects same-count row tampering and does not re-authorize it during category replacement', async () => {
      const snapshot = inventorySnapshot('generation-tampered');
      await service.replaceInventorySnapshot(snapshot);
      const db = new Database(testDbPath);
      try {
        db.prepare('UPDATE items SET name = ? WHERE item_id = ?').run(
          'Tampered item',
          snapshot.items[0].item_id
        );
      } finally {
        db.close();
      }

      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect(await service.getInventorySnapshot()).toBeNull();

      await service.replaceCategorySnapshot(categorySnapshotFixture('category-after-tamper', []));

      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect(rawTextMeta(testDbPath, INVENTORY_SNAPSHOT_META_KEY)).toBeUndefined();
      expect((await service.getCacheState())?.inventorySourceApiVersion).toBeUndefined();
    });

    it('propagates inventory storage failures instead of reporting missing authority', async () => {
      const snapshot = inventorySnapshot('inventory-storage-failure');
      await service.replaceInventorySnapshot(snapshot);
      expect(await service.getInventoryCacheMeta()).toEqual(snapshot.meta);
      const db = (service as unknown as { db: Database.Database }).db;
      db.exec('DROP TABLE items');

      await expect(Promise.resolve().then(() => service.getInventoryCacheMeta())).rejects.toThrow(
        /no such table: items/i
      );
    });

    it('preserves CSV inventory values and valid authority while replacing a categorized mirror', async () => {
      const snapshot = inventorySnapshot('generation-mirror');
      const csvItem: ItemRow = {
        item_id: 'mirror-csv-item',
        name: 'Mirror CSV item',
        category_id: 'category-1',
        category_name: 'CSV category label',
        cache_source: 'csv',
      };
      const csvStock = stockRow('mirror-csv-stock', csvItem.item_id, {
        category_name: 'CSV category label',
        cache_source: 'csv',
        source_api_version: null,
      });
      const mirrorCategories = categorySnapshotFixture('mirror-category-generation');
      const mirrorState: CacheState = {
        lastSync: 100,
        lastFullSync: 100,
        documentCount: 0,
        itemDocumentCount: 0,
        accountName: 'source',
        schemaVersion: 7,
        itemCount: 2,
        stockLocationCount: 2,
        inventorySourceApiVersion: '3',
      };
      await service.replaceMirror({
        accounts: [],
        categorySnapshot: mirrorCategories,
        inventoryCacheMeta: snapshot.meta,
        items: [...snapshot.items, csvItem],
        itemStockLocations: [...snapshot.stockRows, csvStock],
        documents: [],
        itemDocuments: [],
        paymentTransactions: [],
        cacheState: mirrorState,
        paymentSyncStatus: null,
        pulledAt: 100,
      });
      expect(await service.getInventoryCacheMeta()).toEqual(snapshot.meta);
      expect(await service.getCategoryCacheMeta()).toEqual(mirrorCategories.meta);
      expect(await service.getAllItems()).toEqual(
        expect.arrayContaining([
          expect.objectContaining(csvItem),
          expect.objectContaining(snapshot.items[0]),
        ])
      );

      expect(() =>
        service.replaceMirror({
          accounts: [],
          categorySnapshot: null,
          inventoryCacheMeta: { ...snapshot.meta, itemCount: 2 },
          items: snapshot.items,
          itemStockLocations: snapshot.stockRows,
          documents: [],
          itemDocuments: [],
          paymentTransactions: [],
          cacheState: mirrorState,
          paymentSyncStatus: null,
          pulledAt: 200,
        })
      ).toThrow(/metadata does not match/);
      expect(await service.getInventoryCacheMeta()).toEqual(snapshot.meta);
      expect(await service.getCategoryCacheMeta()).toEqual(mirrorCategories.meta);

      const incomplete = inventorySnapshot('generation-incomplete-mirror', snapshot.items, []);
      expect(() =>
        service.replaceMirror({
          accounts: [],
          categorySnapshot: null,
          inventoryCacheMeta: incomplete.meta,
          items: incomplete.items,
          itemStockLocations: [],
          documents: [],
          itemDocuments: [],
          paymentTransactions: [],
          cacheState: { ...mirrorState, stockLocationCount: 0 },
          paymentSyncStatus: null,
          pulledAt: 300,
        })
      ).toThrow(/at least one stock row for every item/i);
      expect(await service.getInventoryCacheMeta()).toEqual(snapshot.meta);
      expect(await service.getCategoryCacheMeta()).toEqual(mirrorCategories.meta);
      expect(await service.getItem(csvItem.item_id)).toEqual(expect.objectContaining(csvItem));
      expect(await service.getItemStockLocations(csvItem.item_id)).toEqual([
        expect.objectContaining(csvStock),
      ]);

      await service.clearAll();
      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect(rawTextMeta(testDbPath, INVENTORY_SNAPSHOT_META_KEY)).toBeUndefined();
      expect(rawTextMeta(testDbPath, INVENTORY_ACCOUNT_META_KEY)).toBeUndefined();
    });

    it('invalidates v3 authority after non-snapshot item and stock mutations', async () => {
      const snapshot = inventorySnapshot('generation-mutation');
      await service.replaceInventorySnapshot(snapshot);

      await service.insertItem({
        ...snapshot.items[0],
        name: 'Changed outside snapshot',
        source_api_version: '2.0',
      });
      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect((await service.getCacheState())?.inventorySourceApiVersion).toBeUndefined();
      expect(rawTextMeta(testDbPath, INVENTORY_SNAPSHOT_META_KEY)).toBeUndefined();

      await service.replaceInventorySnapshot(snapshot);
      await service.replaceItemStockLocations(snapshot.items[0].item_id, [
        {
          ...snapshot.stockRows[0],
          quantity_on_hand: 999,
          source_api_version: '2.0',
        },
      ]);
      expect(await service.getInventoryCacheMeta()).toBeNull();
      expect((await service.getCacheState())?.inventorySourceApiVersion).toBeUndefined();
    });

    it('preserves v3 authority with a new generation after category-name reconciliation', async () => {
      const inventory = inventorySnapshot(
        'generation-category',
        [
          {
            item_id: 'snapshot-item',
            name: 'Snapshot item',
            category_id: 'category-1',
            category_name: 'Old category',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        [stockRow('snapshot-stock', 'snapshot-item', { category_name: 'Old category' })]
      );
      await service.replaceInventorySnapshot(inventory);

      await service.replaceCategorySnapshot(
        categorySnapshotFixture('category-generation', [
          {
            category_id: 'category-1',
            name: 'Renamed category',
            item_count: 1,
            parent_id: null,
            parent_name: null,
            inventory_type: 'quantity',
            custom_fields_json: null,
            created: null,
            modified: 101,
            cache_source: 'api',
            source_api_version: '3',
            imported_at: 101,
          },
        ])
      );

      expect((await service.getItem('snapshot-item'))?.category_name).toBe('Renamed category');
      const reconciled = await service.getInventorySnapshot();
      expect(reconciled).not.toBeNull();
      expect(reconciled?.items[0]).toMatchObject({
        item_id: 'snapshot-item',
        category_name: 'Renamed category',
      });
      expect(reconciled?.stockRows[0]).toMatchObject({
        stock_row_id: 'snapshot-stock',
        category_name: 'Renamed category',
      });
      expect(reconciled?.meta).toMatchObject({
        version: inventory.meta.version,
        status: inventory.meta.status,
        startedAt: inventory.meta.startedAt,
        completedAt: inventory.meta.completedAt,
        itemCount: inventory.meta.itemCount,
        stockRowCount: inventory.meta.stockRowCount,
      });
      expect(reconciled?.meta.generation).not.toBe(inventory.meta.generation);
      expect(reconciled?.meta.fingerprint).not.toBe(inventory.meta.fingerprint);
      expect((await service.getCacheState())?.inventorySourceApiVersion).toBe('3');
    });

    it('publishes mirror inventory authority only when category reconciliation preserves final rows', async () => {
      const inventory = inventorySnapshot(
        'generation-category-mirror',
        [
          {
            item_id: 'snapshot-item',
            name: 'Snapshot item',
            category_id: 'category-1',
            category_name: 'Canonical',
            cache_source: 'api',
            source_api_version: '3',
          },
        ],
        [stockRow('snapshot-stock', 'snapshot-item', { category_name: 'Canonical' })]
      );
      const categorySnapshot = categorySnapshotFixture('category-mirror', [
        {
          category_id: 'category-1',
          name: 'Canonical',
          item_count: 1,
          parent_id: null,
          parent_name: null,
          inventory_type: 'quantity' as const,
          custom_fields_json: null,
          created: null,
          modified: 101,
          cache_source: 'api' as const,
          source_api_version: '3' as const,
          imported_at: 101,
        },
      ]);
      const mirrorState: CacheState = {
        lastSync: 101,
        lastFullSync: 101,
        documentCount: 0,
        itemDocumentCount: 0,
        accountName: 'source',
        schemaVersion: 7,
        inventorySourceApiVersion: '3',
      };

      await service.replaceMirror({
        accounts: [],
        categorySnapshot,
        inventoryCacheMeta: inventory.meta,
        items: inventory.items,
        itemStockLocations: inventory.stockRows,
        documents: [],
        itemDocuments: [],
        paymentTransactions: [],
        cacheState: mirrorState,
        paymentSyncStatus: null,
        pulledAt: 101,
      });
      expect(await service.getInventoryCacheMeta()).toEqual(inventory.meta);
      expect((await service.getCacheState())?.inventorySourceApiVersion).toBe('3');

      expect(() =>
        service.replaceMirror({
          accounts: [],
          categorySnapshot: categorySnapshotFixture('category-mirror-mismatch', [
            { ...categorySnapshot.rows[0], name: 'Different canonical name' },
          ]),
          inventoryCacheMeta: inventory.meta,
          items: inventory.items,
          itemStockLocations: inventory.stockRows,
          documents: [],
          itemDocuments: [],
          paymentTransactions: [],
          cacheState: mirrorState,
          paymentSyncStatus: null,
          pulledAt: 102,
        })
      ).toThrow(/category reconciliation.*inventory metadata/i);
      expect(await service.getInventoryCacheMeta()).toEqual(inventory.meta);
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

    it('round-trips warning status progress and the full sanitized issue list', async () => {
      const status: CacheSyncStatus = {
        status: 'success_with_warnings',
        runId: 'warning-run',
        accountName: 'test-account',
        syncTarget: 'sqlite',
        startedAt: 1770000000,
        updatedAt: 1770000010,
        finishedAt: 1770000010,
        phase: 'finalizing',
        progressUpdatedAt: 1770000009,
        progress: {
          phase: 'documents',
          event: 'phase_completed',
          recordsProcessed: 9,
          recordsTotal: null,
          indeterminate: true,
          timestamp: 1770000009,
          rateLimit: { waitMs: 250, remaining: 0, resetSeconds: 1 },
        },
        recordIssues: [
          {
            resource: 'document',
            id: 'doc-warning',
            context_id: 5,
            code: 'invalid_record',
            message: 'Document record could not be normalized.',
            attempts: 2,
            outcome: 'preserved_last_known_good',
          },
        ],
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
      expect(await service.getDocument('test-doc-1')).toMatchObject({
        archived: 1,
        issue_date: '2026-01-29',
      });

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
      await service.insertDocument({
        ...testDoc,
        doc_id: 'doc-2',
        context_id: DocumentContextId.Estimate,
      });

      const invoices = await service.getDocumentsByContext(DocumentContextId.Invoice);
      expect(invoices).toHaveLength(1);
      expect(invoices[0].doc_id).toBe('test-doc-1');
    });
  });

  describe('Payment transactions', () => {
    const payment = (
      transactionId: string,
      docId = 'payment-doc-1',
      overrides: Partial<PaymentTransactionRow> = {}
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
        {
          doc_id: 'payment-doc-1',
          context_id: DocumentContextId.Invoice,
          doc_number: 9001,
          issue_date: '2026-02-01',
          customer_id: 'cust-1',
          modified: 1,
        },
        {
          doc_id: 'payment-doc-2',
          context_id: DocumentContextId.Invoice,
          doc_number: 9002,
          issue_date: '2026-02-02',
          customer_id: 'cust-2',
          modified: 1,
        },
      ]);
    });

    it('creates the payment schema, foreign key, and query indexes', () => {
      const db = new Database(testDbPath, { readonly: true });
      try {
        const columns = (
          db.pragma('table_info(payment_transactions)') as Array<{ name: string }>
        ).map(({ name }) => name);
        const foreignKeys = db.pragma('foreign_key_list(payment_transactions)') as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>;
        const docIndex = (
          db.pragma('index_info(idx_payment_transactions_doc_id)') as Array<{ name: string }>
        ).map(({ name }) => name);
        const dateIndex = (
          db.pragma('index_info(idx_payment_transactions_date_doc)') as Array<{ name: string }>
        ).map(({ name }) => name);

        expect(columns).toEqual([
          'transaction_id',
          'doc_id',
          'amount',
          'transaction_date',
          'reference',
          'imported_at',
        ]);
        expect(foreignKeys).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table: 'documents',
              from: 'doc_id',
              to: 'doc_id',
              on_delete: 'CASCADE',
            }),
          ])
        );
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
        const columns = (
          migratedDb.pragma('table_info(payment_transactions)') as Array<{ name: string }>
        ).map(({ name }) => name);
        const indexes = (
          migratedDb.pragma('index_list(payment_transactions)') as Array<{ name: string }>
        ).map(({ name }) => name);

        expect(version).toBe(CACHE_SCHEMA_VERSION);
        expect(columns).toEqual([
          'transaction_id',
          'doc_id',
          'amount',
          'transaction_date',
          'reference',
          'imported_at',
        ]);
        expect(indexes).toEqual(
          expect.arrayContaining([
            'idx_payment_transactions_doc_id',
            'idx_payment_transactions_date_doc',
          ])
        );
        expect(await service.getDocument('payment-doc-1')).toBeDefined();
      } finally {
        migratedDb.close();
      }
    });

    it('round-trips payment sync status metadata', async () => {
      const status: PaymentSyncStatus = {
        status: 'failed',
        mode: 'full',
        startedAt: 100,
        updatedAt: 120,
        finishedAt: 120,
        lastSuccessfulSync: 90,
        cursor: 'payment-doc-1',
        processedDocuments: 1,
        totalDocuments: 2,
        error: 'upstream unavailable',
      };

      expect(await service.getPaymentSyncStatus()).toBeNull();
      await service.setPaymentSyncStatus(status);
      expect(await service.getPaymentSyncStatus()).toEqual(status);
    });

    it('round-trips and deterministically orders payment rows', async () => {
      const txnA = payment('txn-a', 'payment-doc-1', {
        transaction_date: '2026-02-01',
        amount: 10,
      });
      const txnB = payment('txn-b', 'payment-doc-1', {
        transaction_date: '2026-02-02',
        reference: 'wire',
      });
      const txnC = payment('txn-c', 'payment-doc-2', { transaction_date: '2026-02-01' });
      await service.batchInsertPaymentTransactions([txnB, txnC, txnA]);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([txnA, txnB]);
      expect(await service.getAllPaymentTransactions()).toEqual([txnA, txnC, txnB]);
      expect(await service.getPaymentTransactionCount()).toBe(3);
    });

    it('rolls back deletion and partial inserts when replacement fails', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);
      const invalid = payment('invalid', 'payment-doc-1', { amount: Number.NaN });

      expect(() =>
        service.replacePaymentTransactions('payment-doc-1', [payment('new'), invalid])
      ).toThrow(/payment_transactions\.amount/);
      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('original')]);
    });

    it('rejects cross-document rows without deleting existing payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);

      expect(() =>
        service.replacePaymentTransactions('payment-doc-1', [payment('wrong', 'payment-doc-2')])
      ).toThrow('received rows for a different document');
      expect(
        (await service.getPaymentTransactions('payment-doc-1')).map((row) => row.transaction_id)
      ).toEqual(['original']);
    });

    it('rejects duplicate replacement IDs before deleting existing payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);

      expect(() =>
        service.replacePaymentTransactions('payment-doc-1', [
          payment('duplicate', 'payment-doc-1', { amount: 1 }),
          payment('duplicate', 'payment-doc-1', { amount: 2 }),
        ])
      ).toThrow('Duplicate payment transaction ID duplicate in one write operation.');

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('original')]);
    });

    it('rejects duplicate batch IDs before mutating payment rows', async () => {
      await service.batchInsertPaymentTransactions([payment('original')]);

      expect(() =>
        service.batchInsertPaymentTransactions([
          payment('new', 'payment-doc-1'),
          payment('new', 'payment-doc-2'),
        ])
      ).toThrow('Duplicate payment transaction ID new in one write operation.');

      expect(await service.getAllPaymentTransactions()).toEqual([payment('original')]);
    });

    it('rejects replacement IDs already assigned to another invoice without moving payments', async () => {
      await service.replacePaymentTransactions('payment-doc-1', [payment('doc-1-original')]);
      await service.replacePaymentTransactions('payment-doc-2', [
        payment('shared-existing-id', 'payment-doc-2'),
      ]);

      expect(() =>
        service.replacePaymentTransactions('payment-doc-1', [
          payment('shared-existing-id', 'payment-doc-1'),
        ])
      ).toThrow(/payment_transactions\.transaction_id|UNIQUE constraint failed/);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([
        payment('doc-1-original'),
      ]);
      expect(await service.getPaymentTransactions('payment-doc-2')).toEqual([
        payment('shared-existing-id', 'payment-doc-2'),
      ]);
    });

    it('rolls back batch rows when one payment ID already belongs to another invoice', async () => {
      await service.batchInsertPaymentTransactions([
        payment('shared-existing-id', 'payment-doc-2'),
      ]);

      expect(() =>
        service.batchInsertPaymentTransactions([
          payment('batch-new', 'payment-doc-1'),
          payment('shared-existing-id', 'payment-doc-1'),
        ])
      ).toThrow(/payment_transactions\.transaction_id|UNIQUE constraint failed/);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([]);
      expect(await service.getPaymentTransactions('payment-doc-2')).toEqual([
        payment('shared-existing-id', 'payment-doc-2'),
      ]);
    });

    it('rejects duplicate PostgreSQL batch IDs before opening a transaction', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn();
      const connect = jest.fn();
      (pgService as unknown as { pool: { query: jest.Mock; connect: jest.Mock } }).pool = {
        query,
        connect,
      };

      await expect(
        pgService.batchInsertPaymentTransactions([
          payment('pg-duplicate'),
          payment('pg-duplicate', 'payment-doc-2'),
        ])
      ).rejects.toThrow('Duplicate payment transaction ID pg-duplicate in one write operation.');
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it('uses plain PostgreSQL inserts for payment batches so existing IDs cannot be overwritten', async () => {
      const pgService = Object.create(PostgresCacheService.prototype) as PostgresCacheService;
      const query = jest.fn(async (sql: string, _params?: unknown[]) => ({
        rows: sql.includes('SELECT account_identity')
          ? [
              {
                account_identity: 'salesbinder:test',
                account_subdomain: 'test',
                created_at: 1,
              },
            ]
          : ([] as unknown[]),
      }));
      const client = {
        query,
        release: jest.fn(),
      };
      (pgService as unknown as { expectedBinding: object }).expectedBinding = {
        accountIdentity: 'salesbinder:test',
        accountSubdomain: 'test',
        createdAt: 1,
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
      const query = jest.fn(async (sql: string, _params?: unknown[]) => ({
        rows: sql.includes('SELECT account_identity')
          ? [
              {
                account_identity: 'salesbinder:test',
                account_subdomain: 'test',
                created_at: 1,
              },
            ]
          : ([] as unknown[]),
      }));
      const client = {
        query,
        release: jest.fn(),
      };
      (pgService as unknown as { expectedBinding: object }).expectedBinding = {
        accountIdentity: 'salesbinder:test',
        accountSubdomain: 'test',
        createdAt: 1,
      };
      (pgService as unknown as { pool: { connect: jest.Mock } }).pool = {
        connect: jest.fn(async () => client),
      };

      await pgService.replacePaymentTransactions('payment-doc-1', [payment('pg-replacement')]);

      const statements = client.query.mock.calls.map(([sql]) => String(sql));
      expect(statements).toContain('DELETE FROM payment_transactions WHERE doc_id = $1');
      expect(
        statements.find((sql) => sql.startsWith('INSERT INTO payment_transactions'))
      ).not.toContain('ON CONFLICT');
    });

    it('uses an empty replacement to clear only the requested invoice', async () => {
      await service.batchInsertPaymentTransactions([
        payment('txn-1'),
        payment('txn-2', 'payment-doc-2'),
      ]);

      await service.replacePaymentTransactions('payment-doc-1', []);

      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([]);
      expect((await service.getAllPaymentTransactions()).map((row) => row.transaction_id)).toEqual([
        'txn-2',
      ]);
    });

    it('atomically replaces document lines while preserving or clearing payments as requested', async () => {
      await service.insertItemDocument({
        item_id: 'old-line',
        doc_id: 'payment-doc-1',
        quantity: 1,
        price: 10,
      });
      await service.replacePaymentTransactions('payment-doc-1', [payment('original')]);
      const updatedDocument: DocumentRow = {
        doc_id: 'payment-doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 9001,
        issue_date: '2026-02-10',
        customer_id: 'cust-1',
        modified: 2,
      };

      await service.replaceDocumentBundle(updatedDocument, [
        {
          item_id: 'new-line',
          doc_id: 'payment-doc-1',
          quantity: 2,
          price: 20,
        },
      ]);
      expect(await service.getDocument('payment-doc-1')).toMatchObject({
        issue_date: '2026-02-10',
      });
      expect(await service.getItemDocuments('payment-doc-1')).toEqual([
        expect.objectContaining({ item_id: 'new-line', quantity: 2 }),
      ]);
      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([payment('original')]);

      await service.replaceDocumentBundle(updatedDocument, [], []);
      expect(await service.getItemDocuments('payment-doc-1')).toEqual([]);
      expect(await service.getPaymentTransactions('payment-doc-1')).toEqual([]);
    });

    it('rolls back the complete document, line, and payment bundle when replacement fails', async () => {
      const originalDocument: DocumentRow = {
        doc_id: 'payment-doc-1',
        context_id: DocumentContextId.Invoice,
        doc_number: 9001,
        issue_date: '2026-02-01',
        customer_id: 'cust-1',
        modified: 1,
      };
      await service.insertDocument(originalDocument);
      await service.insertItemDocument({
        item_id: 'old-line',
        doc_id: originalDocument.doc_id,
        quantity: 1,
        price: 10,
      });
      await service.replacePaymentTransactions(originalDocument.doc_id, [payment('original')]);
      await service.replacePaymentTransactions('payment-doc-2', [
        payment('shared-id', 'payment-doc-2'),
      ]);

      expect(() =>
        service.replaceDocumentBundle(
          { ...originalDocument, issue_date: '2026-03-01', modified: 2 },
          [{ item_id: 'new-line', doc_id: originalDocument.doc_id, quantity: 2, price: 20 }],
          [payment('shared-id', originalDocument.doc_id)]
        )
      ).toThrow(/payment_transactions\.transaction_id|UNIQUE constraint failed/);

      expect(await service.getDocument(originalDocument.doc_id)).toMatchObject(originalDocument);
      expect(await service.getItemDocuments(originalDocument.doc_id)).toEqual([
        expect.objectContaining({ item_id: 'old-line', quantity: 1, price: 10 }),
      ]);
      expect(await service.getPaymentTransactions(originalDocument.doc_id)).toEqual([
        payment('original'),
      ]);
      expect(await service.getPaymentTransactions('payment-doc-2')).toEqual([
        payment('shared-id', 'payment-doc-2'),
      ]);
    });

    it('rejects an API identity takeover before mutating a document bundle', async () => {
      const storedDocument: DocumentRow = {
        doc_id: 'stored-identity-doc',
        api_doc_id: 'stored-api-id',
        context_id: DocumentContextId.Invoice,
        doc_number: 9101,
        issue_date: '2026-02-01',
        customer_id: 'cust-1',
        modified: 1,
      };
      await service.batchInsertDocuments([storedDocument]);
      await service.insertItemDocument({
        item_id: 'old-line',
        doc_id: storedDocument.doc_id,
        quantity: 1,
        price: 10,
      });
      await service.replacePaymentTransactions(storedDocument.doc_id, [
        payment('old-payment', storedDocument.doc_id),
      ]);
      const incoming: DocumentRow = {
        ...storedDocument,
        doc_id: 'incoming-doc',
        api_doc_id: 'incoming-api-id',
        issue_date: '2026-03-01',
        modified: 2,
      };

      expect(() =>
        service.replaceDocumentBundle(
          incoming,
          [{ item_id: 'new-line', doc_id: incoming.doc_id, quantity: 2, price: 20 }],
          [payment('new-payment', incoming.doc_id)]
        )
      ).toThrow(/document identity conflict/i);

      expect(await service.getDocument(storedDocument.doc_id)).toMatchObject(storedDocument);
      expect(await service.getDocumentByApiId('incoming-api-id')).toBeUndefined();
      expect(await service.getItemDocuments(storedDocument.doc_id)).toEqual([
        expect.objectContaining({ item_id: 'old-line' }),
      ]);
      expect(await service.getPaymentTransactions(storedDocument.doc_id)).toEqual([
        payment('old-payment', storedDocument.doc_id),
      ]);
    });

    it('adopts a legacy null API identity and remaps document children and payments', async () => {
      const legacyDocument: DocumentRow = {
        doc_id: 'legacy-number-doc',
        api_doc_id: null,
        context_id: DocumentContextId.Invoice,
        doc_number: 9102,
        issue_date: '2026-02-01',
        customer_id: 'cust-1',
        modified: 1,
      };
      await service.batchInsertDocuments([legacyDocument]);
      const incoming: DocumentRow = {
        ...legacyDocument,
        doc_id: 'api-🚀',
        api_doc_id: 'api-🚀',
        issue_date: '2026-03-01',
        modified: 2,
      };

      await service.replaceDocumentBundle(
        incoming,
        [{ item_id: 'new-line', doc_id: incoming.doc_id, quantity: 2, price: 20 }],
        [payment('new-payment', incoming.doc_id)]
      );

      expect(await service.getDocument(legacyDocument.doc_id)).toMatchObject({
        api_doc_id: 'api-🚀',
        issue_date: '2026-03-01',
      });
      expect(await service.getDocument(incoming.doc_id)).toBeUndefined();
      expect(await service.getItemDocuments(legacyDocument.doc_id)).toEqual([
        expect.objectContaining({ item_id: 'new-line' }),
      ]);
      expect(await service.getPaymentTransactions(legacyDocument.doc_id)).toEqual([
        payment('new-payment', legacyDocument.doc_id),
      ]);
    });

    it('rejects distinct API and number owners without mutating either row', async () => {
      await service.batchInsertDocuments([
        {
          doc_id: 'api-owner',
          api_doc_id: 'shared-api-id',
          context_id: DocumentContextId.Invoice,
          doc_number: 9103,
          issue_date: '2026-02-01',
          customer_id: 'cust-1',
          modified: 1,
        },
        {
          doc_id: 'number-owner',
          api_doc_id: null,
          context_id: DocumentContextId.Invoice,
          doc_number: 9104,
          issue_date: '2026-02-02',
          customer_id: 'cust-2',
          modified: 1,
        },
      ]);

      expect(() =>
        service.replaceDocumentBundle(
          {
            doc_id: 'incoming-doc',
            api_doc_id: 'shared-api-id',
            context_id: DocumentContextId.Invoice,
            doc_number: 9104,
            issue_date: '2026-03-01',
            customer_id: 'cust-3',
            modified: 2,
          },
          []
        )
      ).toThrow(/document identity conflict/i);

      expect(await service.getDocument('api-owner')).toMatchObject({ doc_number: 9103 });
      expect(await service.getDocument('number-owner')).toMatchObject({ api_doc_id: null });
    });

    it.each(['\ud800', '\udc00'])(
      'rejects an unpaired API ID before SQLite can encode it %#',
      async (suffix) => {
        const malformed = `api-${suffix}`;
        expect(() =>
          service.replaceDocumentBundle(
            {
              doc_id: 'malformed-api-doc',
              api_doc_id: malformed,
              context_id: DocumentContextId.Invoice,
              doc_number: 9105,
              issue_date: '2026-03-01',
              customer_id: 'cust-1',
              modified: 2,
            },
            []
          )
        ).toThrow(/API identity is invalid/i);
        await expect(service.getDocument('malformed-api-doc')).resolves.toBeUndefined();
      }
    );
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
      const latestDate = await service.getLatestItemDocumentDate(
        'item-1',
        DocumentContextId.Invoice
      );
      expect(latestDate).toBe('2026-01-20');
    });

    it('should return undefined for no matching documents', async () => {
      const latestDate = await service.getLatestItemDocumentDate(
        'nonexistent',
        DocumentContextId.Invoice
      );
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
        {
          doc_id: 'inv-001',
          context_id: DocumentContextId.Invoice,
          doc_number: 1001,
          issue_date: '2025-08-15',
          customer_id: 'cust-a',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-002',
          context_id: DocumentContextId.Invoice,
          doc_number: 1002,
          issue_date: '2025-09-20',
          customer_id: 'cust-b',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-003',
          context_id: DocumentContextId.Invoice,
          doc_number: 1003,
          issue_date: '2025-10-10',
          customer_id: 'cust-a',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-004',
          context_id: DocumentContextId.Invoice,
          doc_number: 1004,
          issue_date: '2025-11-05',
          customer_id: 'cust-c',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-005',
          context_id: DocumentContextId.Invoice,
          doc_number: 1005,
          issue_date: '2025-12-15',
          customer_id: 'cust-b',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-006',
          context_id: DocumentContextId.Invoice,
          doc_number: 1006,
          issue_date: '2026-01-10',
          customer_id: 'cust-a',
          modified: 1706457600,
        },
        {
          doc_id: 'est-001',
          context_id: DocumentContextId.Estimate,
          doc_number: 2001,
          issue_date: '2025-12-01',
          customer_id: 'cust-d',
          modified: 1706457600,
        },
        {
          doc_id: 'est-002',
          context_id: DocumentContextId.Estimate,
          doc_number: 2002,
          issue_date: '2025-12-15',
          customer_id: 'cust-e',
          modified: 1706457600,
        },
        // Matching estimate-invoice pair (same doc_number)
        {
          doc_id: 'est-003',
          context_id: DocumentContextId.Estimate,
          doc_number: 3001,
          issue_date: '2025-11-01',
          customer_id: 'cust-f',
          modified: 1706457600,
        },
        {
          doc_id: 'inv-from-est-003',
          context_id: DocumentContextId.Invoice,
          doc_number: 3001,
          issue_date: '2025-11-20',
          customer_id: 'cust-f',
          modified: 1706457600,
        },
      ];
      await service.batchInsertDocuments(documents);

      // Insert item documents with varying prices and quantities
      const itemDocs = [
        // Item-1: Multiple sales at different prices
        { item_id: 'item-1', doc_id: 'inv-001', quantity: 10, price: 25.0 },
        { item_id: 'item-1', doc_id: 'inv-002', quantity: 5, price: 20.0 },
        { item_id: 'item-1', doc_id: 'inv-003', quantity: 8, price: 25.0 },
        { item_id: 'item-1', doc_id: 'inv-004', quantity: 15, price: 22.5 },
        { item_id: 'item-1', doc_id: 'inv-005', quantity: 12, price: 25.0 },
        { item_id: 'item-1', doc_id: 'inv-006', quantity: 20, price: 25.0 },
        // Item-2: Single price
        { item_id: 'item-2', doc_id: 'inv-001', quantity: 5, price: 100.0 },
        { item_id: 'item-2', doc_id: 'inv-003', quantity: 10, price: 100.0 },
        { item_id: 'item-2', doc_id: 'inv-006', quantity: 8, price: 100.0 },
        // Item-3: No sales (edge case)
      ];
      await service.batchInsertItemDocuments(itemDocs);
    });

    describe('getItemSalesByPeriod', () => {
      it('returns sales grouped by period with dates', async () => {
        const sales = await service.getItemSalesByPeriod(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(sales.length).toBeGreaterThan(0);
        expect(sales[0]).toHaveProperty('issue_date');
        expect(sales[0]).toHaveProperty('quantity');
        expect(sales[0]).toHaveProperty('price');
      });

      it('filters by context_id', async () => {
        const invoices = await service.getItemSalesByPeriod(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const estimates = await service.getItemSalesByPeriod(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Estimate
        );
        expect(invoices.length).toBeGreaterThan(0);
        expect(estimates.length).toBe(0); // item-1 has no estimates
      });

      it('handles date ranges correctly', async () => {
        const q4Sales = await service.getItemSalesByPeriod(
          'item-1',
          '2025-10-01',
          '2025-12-31',
          DocumentContextId.Invoice
        );
        expect(q4Sales.length).toBe(3); // inv-004, inv-005, inv-006 (wait: inv-006 is 2026-01-10, not in range)
        // Actually inv-004 (2025-11-05), inv-005 (2025-12-15) are in Q4; inv-003 (2025-10-10) also qualifies
        // inv-006 is 2026-01-10, out of range
      });

      it('returns empty for non-existent item', async () => {
        const sales = await service.getItemSalesByPeriod(
          'nonexistent',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(sales).toEqual([]);
      });

      it('orders by date ascending', async () => {
        const sales = await service.getItemSalesByPeriod(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const dates = sales.map((s) => s.issue_date);
        const sortedDates = [...dates].sort();
        expect(dates).toEqual(sortedDates);
      });
    });

    describe('getItemPriceDistribution', () => {
      it('groups by price point', async () => {
        const distribution = await service.getItemPriceDistribution(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(distribution.length).toBe(3); // 20.00, 22.50, 25.00
      });

      it('calculates total quantity per price', async () => {
        const distribution = await service.getItemPriceDistribution(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const price25 = distribution.find((d) => d.price === 25);
        expect(price25?.total_quantity).toBe(50); // 10 + 8 + 12 + 20
      });

      it('calculates total revenue per price', async () => {
        const distribution = await service.getItemPriceDistribution(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const price25 = distribution.find((d) => d.price === 25);
        expect(price25?.total_revenue).toBe(1250); // 25 * 50
      });

      it('orders by price ascending', async () => {
        const distribution = await service.getItemPriceDistribution(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const prices = distribution.map((d) => d.price);
        expect(prices).toEqual([20, 22.5, 25]);
      });

      it('returns empty for item with no sales', async () => {
        const distribution = await service.getItemPriceDistribution(
          'item-3',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(distribution).toEqual([]);
      });
    });

    describe('getItemSalesByCustomer', () => {
      it('aggregates sales by customer', async () => {
        const customerSales = await service.getItemSalesByCustomer(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(customerSales.length).toBe(3); // cust-a, cust-b, cust-c
      });

      it('calculates quantity per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const custA = customerSales.find((c) => c.customer_id === 'cust-a');
        expect(custA?.quantity).toBe(38); // 10 + 8 + 20
      });

      it('calculates revenue per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const custA = customerSales.find((c) => c.customer_id === 'cust-a');
        expect(custA?.revenue).toBe(950); // (10+8+20) * 25
      });

      it('counts distinct orders per customer', async () => {
        const customerSales = await service.getItemSalesByCustomer(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const custA = customerSales.find((c) => c.customer_id === 'cust-a');
        expect(custA?.order_count).toBe(3);
      });

      it('orders by revenue descending', async () => {
        const customerSales = await service.getItemSalesByCustomer(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const revenues = customerSales.map((c) => c.revenue);
        expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
      });
    });

    describe('getItemSalesByMonth', () => {
      it('groups sales by month', async () => {
        const monthly = await service.getItemSalesByMonth(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        expect(monthly.length).toBeGreaterThan(0);
        expect(monthly[0]).toHaveProperty('month');
        expect(monthly[0].month).toMatch(/^\d{4}-\d{2}$/);
      });

      it('sums quantity per month', async () => {
        const monthly = await service.getItemSalesByMonth(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const aug = monthly.find((m) => m.month === '2025-08');
        expect(aug?.quantity).toBe(10);
      });

      it('sums revenue per month', async () => {
        const monthly = await service.getItemSalesByMonth(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const aug = monthly.find((m) => m.month === '2025-08');
        expect(aug?.revenue).toBe(250); // 10 * 25
      });

      it('orders by month ascending', async () => {
        const monthly = await service.getItemSalesByMonth(
          'item-1',
          '2025-01-01',
          '2026-12-31',
          DocumentContextId.Invoice
        );
        const months = monthly.map((m) => m.month);
        const sortedMonths = [...months].sort();
        expect(months).toEqual(sortedMonths);
      });
    });

    describe('getItemOrderPatterns', () => {
      it('returns both Estimates and Invoices', async () => {
        const patterns = await service.getItemOrderPatterns('item-2', '2025-01-01', '2026-12-31');
        expect(patterns.length).toBeGreaterThan(0);

        const hasInvoice = patterns.some((p) => p.context_id === DocumentContextId.Invoice);
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
        const dates = patterns.map((p) => p.issue_date);
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
        await service.insertItemDocument({
          item_id: 'item-1',
          doc_id: 'po-001',
          quantity: 100,
          price: 10,
        });

        const patterns = await service.getItemOrderPatterns('item-1', '2025-01-01', '2026-12-31');
        const hasPo = patterns.some((p) => p.context_id === 11);
        expect(hasPo).toBe(false);
      });
    });
  });
});

function createLegacyV6InventoryDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE items (
        item_id TEXT PRIMARY KEY, item_number INTEGER NULL, name TEXT NOT NULL,
        description TEXT NULL, sku TEXT NULL, serial_number TEXT NULL, barcode TEXT NULL,
        category_id TEXT NULL, category_name TEXT NULL, quantity REAL NULL,
        quantity_reserved REAL NULL, quantity_available REAL NULL, quantity_incoming REAL NULL,
        in_transit REAL NULL, threshold REAL NULL, cost REAL NULL, price REAL NULL,
        valuation REAL NULL, published INTEGER NULL, archived INTEGER NULL, created TEXT NULL,
        modified INTEGER NULL, cache_source TEXT NOT NULL DEFAULT 'api', imported_at INTEGER NULL
      );
      CREATE TABLE item_stock_locations (
        stock_row_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, item_number INTEGER NULL,
        variation_id TEXT NULL, variation_location_id TEXT NULL, location_id TEXT NULL,
        location_name TEXT NULL, category_name TEXT NULL,
        quantity_on_hand REAL NOT NULL DEFAULT 0,
        quantity_reserved REAL NOT NULL DEFAULT 0,
        quantity_available REAL NOT NULL DEFAULT 0,
        quantity_incoming REAL NOT NULL DEFAULT 0,
        in_transit REAL NOT NULL DEFAULT 0,
        price REAL NULL, cost REAL NULL, valuation REAL NULL, barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api', imported_at INTEGER NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );
      CREATE TABLE categories (
        category_id TEXT PRIMARY KEY, name TEXT NOT NULL, item_count INTEGER NULL,
        parent_id TEXT NULL, parent_name TEXT NULL, created TEXT NULL, modified INTEGER NULL,
        cache_source TEXT NOT NULL DEFAULT 'api', imported_at INTEGER NOT NULL
      );
      CREATE TABLE category_cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX idx_stock_location ON item_stock_locations(location_id);
      INSERT INTO items (
        item_id, item_number, name, quantity_reserved, quantity_available,
        quantity_incoming, in_transit, cache_source, imported_at
      ) VALUES
        ('legacy-api-item', 701, 'Legacy API item', 2, 9, 3, 4, 'api', 610),
        ('legacy-csv-item', 702, 'Legacy CSV item', 5, 17, 6, 7, 'csv', 620);
      INSERT INTO item_stock_locations (
        stock_row_id, item_id, item_number, variation_id, variation_location_id,
        location_id, location_name, category_name, quantity_on_hand,
        quantity_reserved, quantity_available, quantity_incoming, in_transit,
        price, cost, valuation, barcode, cache_source, imported_at
      ) VALUES
        ('legacy-api-stock', 'legacy-api-item', 701, 'variation-api', 'variation-location-api',
         'location-api', 'API Warehouse', 'API Category', 11, 2, 9, 3, 4,
         19.5, 8.25, 90.75, 'API-BARCODE', 'api', 610),
        ('legacy-csv-stock', 'legacy-csv-item', 702, 'variation-csv', 'variation-location-csv',
         'location-csv', 'CSV Warehouse', 'CSV Category', 22, 5, 17, 6, 7,
         29.5, 18.25, 401.5, 'CSV-BARCODE', 'csv', 620);
      PRAGMA user_version = 6;
    `);
  } finally {
    db.close();
  }
}

function categorySnapshotFixture(
  generation: string,
  rows: CategorySnapshot['rows'] = [
    {
      category_id: 'category-1',
      name: 'Category one',
      item_count: 1,
      parent_id: null,
      parent_name: null,
      inventory_type: 'quantity',
      custom_fields_json: null,
      created: null,
      modified: 90,
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 100,
    },
  ]
): CategorySnapshot {
  const meta = {
    version: 1,
    status: 'complete',
    accountIdentity: 'salesbinder:test-account',
    startedAt: 90,
    completedAt: 100,
    count: rows.length,
    page: 1,
    pages: 1,
    sourceRowCount: rows.length,
    storedRowCount: rows.length,
    schemaVersion: 7,
    sourceApiVersion: '3',
    generation,
  } satisfies Omit<CategoryCacheMeta, 'fingerprint'>;
  return {
    rows,
    meta: {
      ...meta,
      fingerprint: createCategoryFingerprint(meta, rows, CACHE_SCHEMA_VERSION),
    },
  };
}

function refreshCategoryFingerprint(snapshot: CategorySnapshot): void {
  snapshot.meta.fingerprint = createCategoryFingerprint(
    snapshot.meta,
    snapshot.rows,
    CACHE_SCHEMA_VERSION
  );
}

function inventorySnapshot(
  generation: string,
  items: ItemRow[] = [
    {
      item_id: 'snapshot-item',
      name: 'Snapshot item',
      cache_source: 'api',
      source_api_version: '3',
    },
  ],
  stockRows: ItemStockLocationRow[] = [stockRow('snapshot-stock', 'snapshot-item')]
): InventorySnapshot {
  const accountIdentity = 'salesbinder:test-account';
  const normalizedItems = items.map((item) => ({ quantity: 10, ...item }));
  return {
    items: normalizedItems,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity,
      startedAt: 90,
      completedAt: 100,
      itemCount: normalizedItems.filter(
        (row) => row.cache_source === 'api' && row.source_api_version === '3'
      ).length,
      stockRowCount: stockRows.filter(
        (row) => row.cache_source === 'api' && row.source_api_version === '3'
      ).length,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: createInventorySnapshotFingerprint(
        accountIdentity,
        generation,
        normalizedItems,
        stockRows
      ),
    },
  };
}

function refreshInventoryFingerprint(snapshot: InventorySnapshot): void {
  snapshot.meta.fingerprint = createInventorySnapshotFingerprint(
    snapshot.meta.accountIdentity,
    snapshot.meta.generation,
    snapshot.items,
    snapshot.stockRows
  );
}

function historicalV1InventorySnapshot(
  accountIdentity: string,
  omitParentLocationId = false
): InventorySnapshot {
  const ids = ['z', 'Å', 'ä'];
  const items: ItemRow[] = ids.map((id) => ({
    item_id: id,
    item_number: null,
    name: `Item ${id}`,
    description: null,
    sku: null,
    serial_number: null,
    barcode: null,
    category_id: null,
    category_name: null,
    quantity: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    quantity_incoming: 0,
    in_transit: null,
    threshold: 0,
    cost: null,
    price: null,
    published: 1,
    archived: 0,
    created: '2026-01-01',
    modified: 1,
    cache_source: 'api' as const,
    source_api_version: '3' as const,
  }));
  const stockRows: ItemStockLocationRow[] = ids.map((id) => ({
    stock_row_id: id,
    item_id: id,
    item_number: null,
    ...(omitParentLocationId ? {} : { location_id: null }),
    location_name: null,
    category_name: null,
    quantity_on_hand: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    quantity_incoming: 0,
    in_transit: null,
    price: null,
    cost: null,
    barcode: null,
    cache_source: 'api' as const,
    source_api_version: '3' as const,
  }));
  const generation = 'historical-v1-unicode';
  const canonical = {
    accountIdentity,
    generation,
    items: [...items].sort((left, right) => left.item_id.localeCompare(right.item_id)),
    stockRows: [...stockRows].sort((left, right) =>
      left.stock_row_id.localeCompare(right.stock_row_id)
    ),
  };
  return {
    items,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity,
      startedAt: 1,
      completedAt: 2,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
    },
  };
}

function stockRow(
  stock_row_id: string,
  item_id: string,
  overrides: Partial<ItemStockLocationRow> = {}
): ItemStockLocationRow {
  return {
    stock_row_id,
    item_id,
    quantity_on_hand: 10,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
    ...overrides,
  };
}

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

function rawTextMeta(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare('SELECT value FROM cache_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
}
