/**
 * PostgreSQL cache service for the shared analytics cache upstream.
 */

import pg, { type PoolClient } from 'pg';
import type { CacheService } from './cache.interface.js';
import type {
  AccountRow,
  CacheAccountBinding,
  CacheState,
  CacheSyncStatus,
  CategoryCacheMeta,
  CategoryCacheRow,
  CategorySnapshot,
  CustomerSalesData,
  DocumentRow,
  ItemDocumentRow,
  ItemRow,
  ItemSalesByPeriodRow,
  ItemStockLocationRow,
  PriceDistributionRow,
} from './types.js';
import {
  CACHE_SCHEMA_VERSION,
  CATEGORY_GENERATION_META_KEY,
  CATEGORY_SNAPSHOT_META_KEY,
  createSalesBinderAccountBinding,
} from './types.js';
import { PAYMENT_SYNC_STATUS_KEY, PAYMENT_TRANSACTION_COLUMNS } from './payment-cache.constants.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from './payment-sync.types.js';
import {
  assertPaymentRowsMatchDocument,
  assertUniquePaymentTransactionIds,
} from './payment-sync.helpers.js';

const { Pool } = pg;

const DB_WRITE_LOCK_KEY = 'salesbinder.cache.database-write.v6';

const CATEGORY_COLUMNS = [
  'category_id', 'name', 'item_count', 'parent_id', 'parent_name',
  'created', 'modified', 'cache_source', 'imported_at',
] as const;

const DOCUMENT_COLUMNS = [
  'doc_id', 'context_id', 'doc_number', 'issue_date', 'customer_id', 'modified',
  'api_doc_id', 'cache_source', 'document_name', 'custom_doc_number',
  'account_id', 'account_context_id', 'account_name', 'account_number',
  'user_id', 'salesperson_name', 'customer_name', 'customer_number',
  'supplier_name', 'supplier_number', 'status_id', 'status_name',
  'total_price', 'total_cost', 'subtotal', 'associated_document_id',
  'external_po_number', 'shipping_location', 'date_sent', 'shipped_percent',
  'is_cancelled', 'archived', 'imported_at',
] as const;

const ITEM_DOCUMENT_COLUMNS = [
  'item_id', 'doc_id', 'quantity', 'price', 'document_item_id', 'item_name',
  'item_number', 'item_sku', 'item_location', 'line_description',
  'quantity_received', 'quantity_shipped', 'cost', 'total_amount', 'discounted_price', 'discount_percent',
] as const;

const ACCOUNT_COLUMNS = [
  'account_id', 'context_id', 'account_number', 'name', 'office_email', 'office_phone',
  'office_fax', 'url', 'billing_address_1', 'billing_address_2', 'billing_city',
  'billing_region', 'billing_postal_code', 'billing_country', 'shipping_address_1',
  'shipping_address_2', 'shipping_city', 'shipping_region', 'shipping_postal_code',
  'shipping_country', 'vat_number', 'account_manager', 'label_name', 'archived',
  'last_invoiced', 'created', 'modified', 'cache_source', 'imported_at',
] as const;

const ITEM_COLUMNS = [
  'item_id', 'item_number', 'name', 'description', 'sku', 'serial_number', 'barcode',
  'category_id', 'category_name', 'quantity', 'quantity_reserved', 'quantity_available',
  'quantity_incoming', 'in_transit', 'threshold', 'cost', 'price', 'valuation',
  'published', 'archived', 'created', 'modified', 'cache_source', 'imported_at',
] as const;

const STOCK_COLUMNS = [
  'stock_row_id', 'item_id', 'item_number', 'variation_id', 'variation_location_id',
  'location_id', 'location_name', 'category_name', 'quantity_on_hand',
  'quantity_reserved', 'quantity_available', 'quantity_incoming', 'in_transit',
  'price', 'cost', 'valuation', 'barcode', 'cache_source', 'imported_at',
] as const;

type QueryExecutor = Pick<PoolClient, 'query'>;

export class PostgresCacheService implements CacheService {
  private pool: InstanceType<typeof Pool>;
  private opened = true;
  private readonly syncLockClients = new Map<string, PoolClient>();
  private readonly connectionString: string;
  private expectedBinding: CacheAccountBinding | null = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    await this.ensureBindingSchema();
    const binding = this.expectedBinding;
    if (!binding) return;

    await this.withDatabaseTransaction(async (client) => {
      this.assertMatchingBinding(await this.readBinding(client, true), binding);
      await this.ensurePayloadSchema(client);
    });
  }

  private async ensureBindingSchema(): Promise<void> {
    await this.withDatabaseTransaction(async (client) => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS cache_account_binding (
        id SMALLINT PRIMARY KEY,
        account_identity TEXT NOT NULL UNIQUE,
        account_subdomain TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        CONSTRAINT cache_account_binding_singleton_check CHECK (id = 1)
      );
      `);
      await this.repairBindingSchema(client);
    });
  }

  private async ensurePayloadSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        account_number INTEGER NULL,
        name TEXT NOT NULL,
        office_email TEXT NULL,
        office_phone TEXT NULL,
        office_fax TEXT NULL,
        url TEXT NULL,
        billing_address_1 TEXT NULL,
        billing_address_2 TEXT NULL,
        billing_city TEXT NULL,
        billing_region TEXT NULL,
        billing_postal_code TEXT NULL,
        billing_country TEXT NULL,
        shipping_address_1 TEXT NULL,
        shipping_address_2 TEXT NULL,
        shipping_city TEXT NULL,
        shipping_region TEXT NULL,
        shipping_postal_code TEXT NULL,
        shipping_country TEXT NULL,
        vat_number TEXT NULL,
        account_manager TEXT NULL,
        label_name TEXT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        last_invoiced TEXT NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        context_id INTEGER NOT NULL,
        doc_number INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        modified BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_documents (
        id SERIAL PRIMARY KEY,
        item_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        quantity NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY,
        item_number INTEGER NULL,
        name TEXT NOT NULL,
        description TEXT NULL,
        sku TEXT NULL,
        serial_number TEXT NULL,
        barcode TEXT NULL,
        category_id TEXT NULL,
        category_name TEXT NULL,
        quantity NUMERIC NULL,
        quantity_reserved NUMERIC NULL,
        quantity_available NUMERIC NULL,
        quantity_incoming NUMERIC NULL,
        in_transit NUMERIC NULL,
        threshold NUMERIC NULL,
        cost NUMERIC NULL,
        price NUMERIC NULL,
        valuation NUMERIC NULL,
        published INTEGER NULL,
        archived INTEGER NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL
      );

      CREATE TABLE IF NOT EXISTS item_stock_locations (
        stock_row_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_number INTEGER NULL,
        variation_id TEXT NULL,
        variation_location_id TEXT NULL,
        location_id TEXT NULL,
        location_name TEXT NULL,
        category_name TEXT NULL,
        quantity_on_hand NUMERIC NOT NULL DEFAULT 0,
        quantity_reserved NUMERIC NOT NULL DEFAULT 0,
        quantity_available NUMERIC NOT NULL DEFAULT 0,
        quantity_incoming NUMERIC NOT NULL DEFAULT 0,
        in_transit NUMERIC NOT NULL DEFAULT 0,
        price NUMERIC NULL,
        cost NUMERIC NULL,
        valuation NUMERIC NULL,
        barcode TEXT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NULL,
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS payment_transactions (
        transaction_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        transaction_date TEXT NOT NULL,
        reference TEXT NULL,
        imported_at BIGINT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        category_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_count INTEGER NULL,
        parent_id TEXT NULL,
        parent_name TEXT NULL,
        created TEXT NULL,
        modified BIGINT NULL,
        cache_source TEXT NOT NULL DEFAULT 'api',
        imported_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS category_cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await this.migrateDocumentColumns(client);
    await this.migrateItemColumns(client);
    await this.migrateItemDocumentColumns(client);
    await this.repairCategorySchema(client);
    await this.createIndexes(client);
  }

  private async migrateDocumentColumns(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS api_doc_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS cache_source TEXT NOT NULL DEFAULT 'api';
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS custom_doc_number TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_context_id INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS account_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS salesperson_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS customer_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS customer_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_number INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_id INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_name TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS total_price NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS total_cost NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS subtotal NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS associated_document_id TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_po_number TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipping_location TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS date_sent TEXT NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipped_percent NUMERIC NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived INTEGER NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS imported_at BIGINT NULL;
    `);
  }

  private async migrateItemColumns(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE items ADD COLUMN IF NOT EXISTS archived INTEGER NULL;
    `);
  }

  private async migrateItemDocumentColumns(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS document_item_id TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_name TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_number INTEGER NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_sku TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS item_location TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS line_description TEXT NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_received NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_shipped NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS cost NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS total_amount NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discounted_price NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NULL;
    `);
  }

  private async repairBindingSchema(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE cache_account_binding ADD COLUMN IF NOT EXISTS id SMALLINT;
      ALTER TABLE cache_account_binding ADD COLUMN IF NOT EXISTS account_identity TEXT;
      ALTER TABLE cache_account_binding ADD COLUMN IF NOT EXISTS account_subdomain TEXT;
      ALTER TABLE cache_account_binding ADD COLUMN IF NOT EXISTS created_at BIGINT;
      DO $migration$
      DECLARE primary_key_name TEXT;
      DECLARE primary_key_columns TEXT[];
      BEGIN
        SELECT constraint_row.conname,
               array_agg(attribute_row.attname ORDER BY key_column.ordinality)
          INTO primary_key_name, primary_key_columns
        FROM pg_constraint AS constraint_row
        CROSS JOIN LATERAL unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
        WHERE constraint_row.conrelid = 'cache_account_binding'::regclass
          AND constraint_row.contype = 'p'
        GROUP BY constraint_row.conname;
        IF primary_key_name IS NOT NULL
          AND primary_key_columns IS DISTINCT FROM ARRAY['id']::TEXT[] THEN
          EXECUTE format(
            'ALTER TABLE cache_account_binding DROP CONSTRAINT %I',
            primary_key_name
          );
        END IF;
      END
      $migration$;
      DO $migration$
      DECLARE extra_column TEXT;
      BEGIN
        FOR extra_column IN
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'cache_account_binding'
            AND column_name NOT IN ('id', 'account_identity', 'account_subdomain', 'created_at')
        LOOP
          EXECUTE format('ALTER TABLE cache_account_binding DROP COLUMN %I', extra_column);
        END LOOP;
      END
      $migration$;
      ALTER TABLE cache_account_binding ALTER COLUMN id TYPE SMALLINT USING id::SMALLINT;
      ALTER TABLE cache_account_binding ALTER COLUMN account_identity TYPE TEXT USING account_identity::TEXT;
      ALTER TABLE cache_account_binding ALTER COLUMN account_subdomain TYPE TEXT USING account_subdomain::TEXT;
      ALTER TABLE cache_account_binding ALTER COLUMN created_at TYPE BIGINT USING created_at::BIGINT;
      ALTER TABLE cache_account_binding ALTER COLUMN id SET NOT NULL;
      ALTER TABLE cache_account_binding ALTER COLUMN account_identity SET NOT NULL;
      ALTER TABLE cache_account_binding ALTER COLUMN account_subdomain SET NOT NULL;
      ALTER TABLE cache_account_binding ALTER COLUMN created_at SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_account_binding_identity
        ON cache_account_binding(account_identity);
      DO $migration$
      DECLARE check_constraint RECORD;
      BEGIN
        FOR check_constraint IN
          SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = 'cache_account_binding'::regclass AND contype = 'c'
        LOOP
          IF check_constraint.conname <> 'cache_account_binding_singleton_check'
            OR check_constraint.definition <> 'CHECK ((id = 1))' THEN
            EXECUTE format(
              'ALTER TABLE cache_account_binding DROP CONSTRAINT %I',
              check_constraint.conname
            );
          END IF;
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'cache_account_binding'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE cache_account_binding
            ADD CONSTRAINT cache_account_binding_pkey PRIMARY KEY (id);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'cache_account_binding'::regclass
            AND contype = 'c'
            AND conname = 'cache_account_binding_singleton_check'
            AND pg_get_constraintdef(oid) = 'CHECK ((id = 1))'
        ) THEN
          ALTER TABLE cache_account_binding
            ADD CONSTRAINT cache_account_binding_singleton_check CHECK (id = 1);
        END IF;
      END
      $migration$;
    `);
  }

  private async repairCategorySchema(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS category_id TEXT;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS item_count INTEGER NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id TEXT NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_name TEXT NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created TEXT NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS modified BIGINT NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS cache_source TEXT DEFAULT 'api';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS imported_at BIGINT;
      DO $migration$
      DECLARE primary_key_name TEXT;
      DECLARE primary_key_columns TEXT[];
      BEGIN
        SELECT constraint_row.conname,
               array_agg(attribute_row.attname ORDER BY key_column.ordinality)
          INTO primary_key_name, primary_key_columns
        FROM pg_constraint AS constraint_row
        CROSS JOIN LATERAL unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
        WHERE constraint_row.conrelid = 'categories'::regclass
          AND constraint_row.contype = 'p'
        GROUP BY constraint_row.conname;
        IF primary_key_name IS NOT NULL
          AND primary_key_columns IS DISTINCT FROM ARRAY['category_id']::TEXT[] THEN
          EXECUTE format('ALTER TABLE categories DROP CONSTRAINT %I', primary_key_name);
        END IF;
      END
      $migration$;
      DO $migration$
      DECLARE extra_column TEXT;
      BEGIN
        FOR extra_column IN
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'categories'
            AND column_name NOT IN (
              'category_id', 'name', 'item_count', 'parent_id', 'parent_name',
              'created', 'modified', 'cache_source', 'imported_at'
            )
        LOOP
          EXECUTE format('ALTER TABLE categories DROP COLUMN %I', extra_column);
        END LOOP;
      END
      $migration$;
      ALTER TABLE categories ALTER COLUMN category_id TYPE TEXT USING category_id::TEXT;
      ALTER TABLE categories ALTER COLUMN name TYPE TEXT USING name::TEXT;
      ALTER TABLE categories ALTER COLUMN item_count TYPE INTEGER USING item_count::INTEGER;
      ALTER TABLE categories ALTER COLUMN parent_id TYPE TEXT USING parent_id::TEXT;
      ALTER TABLE categories ALTER COLUMN parent_name TYPE TEXT USING parent_name::TEXT;
      ALTER TABLE categories ALTER COLUMN created TYPE TEXT USING created::TEXT;
      ALTER TABLE categories ALTER COLUMN modified TYPE BIGINT USING modified::BIGINT;
      ALTER TABLE categories ALTER COLUMN cache_source TYPE TEXT USING cache_source::TEXT;
      ALTER TABLE categories ALTER COLUMN imported_at TYPE BIGINT USING imported_at::BIGINT;
      DELETE FROM categories
        WHERE category_id IS NULL OR name IS NULL OR cache_source IS NULL OR imported_at IS NULL;
      DELETE FROM categories a USING categories b
        WHERE a.ctid > b.ctid AND a.category_id = b.category_id;
      ALTER TABLE categories ALTER COLUMN category_id SET NOT NULL;
      ALTER TABLE categories ALTER COLUMN name SET NOT NULL;
      ALTER TABLE categories ALTER COLUMN cache_source SET DEFAULT 'api';
      ALTER TABLE categories ALTER COLUMN cache_source SET NOT NULL;
      ALTER TABLE categories ALTER COLUMN imported_at SET NOT NULL;

      ALTER TABLE category_cache_meta ADD COLUMN IF NOT EXISTS key TEXT;
      ALTER TABLE category_cache_meta ADD COLUMN IF NOT EXISTS value TEXT;
      DO $migration$
      DECLARE primary_key_name TEXT;
      DECLARE primary_key_columns TEXT[];
      BEGIN
        SELECT constraint_row.conname,
               array_agg(attribute_row.attname ORDER BY key_column.ordinality)
          INTO primary_key_name, primary_key_columns
        FROM pg_constraint AS constraint_row
        CROSS JOIN LATERAL unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
        WHERE constraint_row.conrelid = 'category_cache_meta'::regclass
          AND constraint_row.contype = 'p'
        GROUP BY constraint_row.conname;
        IF primary_key_name IS NOT NULL
          AND primary_key_columns IS DISTINCT FROM ARRAY['key']::TEXT[] THEN
          EXECUTE format('ALTER TABLE category_cache_meta DROP CONSTRAINT %I', primary_key_name);
        END IF;
      END
      $migration$;
      DO $migration$
      DECLARE extra_column TEXT;
      BEGIN
        FOR extra_column IN
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'category_cache_meta'
            AND column_name NOT IN ('key', 'value')
        LOOP
          EXECUTE format('ALTER TABLE category_cache_meta DROP COLUMN %I', extra_column);
        END LOOP;
      END
      $migration$;
      ALTER TABLE category_cache_meta ALTER COLUMN key TYPE TEXT USING key::TEXT;
      ALTER TABLE category_cache_meta ALTER COLUMN value TYPE TEXT USING value::TEXT;
      DELETE FROM category_cache_meta WHERE key IS NULL OR value IS NULL;
      DELETE FROM category_cache_meta a USING category_cache_meta b
        WHERE a.ctid > b.ctid AND a.key = b.key;
      ALTER TABLE category_cache_meta ALTER COLUMN key SET NOT NULL;
      ALTER TABLE category_cache_meta ALTER COLUMN value SET NOT NULL;
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'categories'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE categories
            ADD CONSTRAINT categories_pkey PRIMARY KEY (category_id);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'category_cache_meta'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE category_cache_meta
            ADD CONSTRAINT category_cache_meta_pkey PRIMARY KEY (key);
        END IF;
      END
      $migration$;
    `);
  }

  private async createIndexes(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_context_doc_number ON documents(context_id, doc_number);
      CREATE INDEX IF NOT EXISTS idx_documents_context ON documents(context_id);
      CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified);
      CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);
      CREATE INDEX IF NOT EXISTS idx_documents_account_name ON documents(account_context_id, account_name);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status_id);
      CREATE INDEX IF NOT EXISTS idx_documents_shipped_percent ON documents(shipped_percent);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_api_doc_id ON documents(api_doc_id) WHERE api_doc_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_archived ON documents(archived);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc ON item_documents(doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_name ON item_documents(item_name);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_number ON item_documents(item_number);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_sku ON item_documents(item_sku);
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_doc_id ON payment_transactions(doc_id);
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_date_doc ON payment_transactions(transaction_date, doc_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_number ON accounts(context_id, account_number);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_name ON accounts(context_id, name);
      CREATE INDEX IF NOT EXISTS idx_accounts_modified ON accounts(modified);
      CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts(archived);
      CREATE INDEX IF NOT EXISTS idx_items_modified ON items(modified);
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
      CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
      CREATE INDEX IF NOT EXISTS idx_items_item_number ON items(item_number);
      CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived);
      CREATE INDEX IF NOT EXISTS idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON item_stock_locations(location_id);
      CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
    `);
  }

  getDbPath(): string {
    try {
      const url = new URL(this.connectionString);
      url.password = '***';
      return url.toString();
    } catch {
      return this.connectionString;
    }
  }

  async ensureAccountBinding(binding: CacheAccountBinding): Promise<void> {
    const canonical = createSalesBinderAccountBinding(binding.accountSubdomain);
    if (canonical.accountIdentity !== binding.accountIdentity) {
      throw new Error('PostgreSQL cache account identity does not match its normalized SalesBinder subdomain.');
    }

    const createdAt = binding.createdAt ?? Math.floor(Date.now() / 1000);
    await this.ensureBindingSchema();
    let verifiedBinding: CacheAccountBinding | null = null;
    await this.withDatabaseTransaction(async (client) => {
      const existing = await this.readBinding(client, true);
      if (!existing) {
        if (await this.databaseContainsPayloadRows(client)) {
          throw new Error(
            'PostgreSQL cache database is populated but has no account binding. '
            + 'Use a matching empty database or rebuild this database before binding it.'
          );
        }
        await client.query(
          `INSERT INTO cache_account_binding
             (id, account_identity, account_subdomain, created_at)
           VALUES (1, $1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [canonical.accountIdentity, canonical.accountSubdomain, createdAt],
        );
      }

      const persisted = await this.readBinding(client, true);
      this.assertMatchingBinding(persisted, canonical);
      verifiedBinding = persisted;
    });
    this.expectedBinding = verifiedBinding;
    await this.ensureSchema();
  }

  async verifyAccountBinding(binding: CacheAccountBinding): Promise<void> {
    const canonical = createSalesBinderAccountBinding(binding.accountSubdomain);
    if (canonical.accountIdentity !== binding.accountIdentity) {
      throw new Error('PostgreSQL cache account identity does not match its normalized SalesBinder subdomain.');
    }
    const persisted = await this.readBinding(this.pool, false);
    if (!persisted) {
      throw new Error(
        `PostgreSQL cache database has no account binding for ${canonical.accountIdentity}. `
        + 'Run cache sync for this SalesBinder account first, or use the correctly bound database.'
      );
    }
    this.assertMatchingBinding(persisted, canonical);
    this.expectedBinding = persisted;
  }

  async replaceCategorySnapshot(snapshot: CategorySnapshot): Promise<void> {
    const binding = this.requireExpectedBinding();
    this.assertValidCategorySnapshot(snapshot, binding.accountIdentity);

    await this.withVerifiedWrite(async (client) => {
      const stateResult = await client.query<{ value: string }>(
        `SELECT value FROM cache_meta WHERE key = 'state' FOR UPDATE`,
      );
      const currentState = this.parseCacheState(stateResult.rows[0]?.value);

      await client.query(`DELETE FROM categories`);
      for (const row of snapshot.rows) {
        await client.query(
          this.insertSql('categories', CATEGORY_COLUMNS),
          this.valuesFor(CATEGORY_COLUMNS, row as unknown as Record<string, unknown>),
        );
      }

      await client.query(`DELETE FROM category_cache_meta`);
      await client.query(
        `INSERT INTO category_cache_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [CATEGORY_SNAPSHOT_META_KEY, JSON.stringify(snapshot.meta)],
      );

      await client.query(`
        UPDATE items AS item
        SET category_name = category.name
        FROM categories AS category
        WHERE item.category_id = category.category_id;
        UPDATE items AS item
        SET category_name = NULL
        WHERE item.category_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM categories AS category
            WHERE category.category_id = item.category_id
          );
        UPDATE item_stock_locations AS stock
        SET category_name = category.name
        FROM items AS item
        JOIN categories AS category ON category.category_id = item.category_id
        WHERE stock.item_id = item.item_id;
        UPDATE item_stock_locations AS stock
        SET category_name = NULL
        WHERE EXISTS (
          SELECT 1 FROM items AS item
          WHERE item.item_id = stock.item_id AND item.category_id IS NOT NULL
        )
          AND NOT EXISTS (
            SELECT 1 FROM items AS item
            JOIN categories AS category ON category.category_id = item.category_id
            WHERE item.item_id = stock.item_id
          );
      `);

      const nextState: CacheState = {
        lastSync: currentState?.lastSync ?? 0,
        lastFullSync: currentState?.lastFullSync ?? 0,
        documentCount: currentState?.documentCount ?? 0,
        itemDocumentCount: currentState?.itemDocumentCount ?? 0,
        accountName: currentState?.accountName ?? binding.accountSubdomain,
        ...currentState,
        schemaVersion: CACHE_SCHEMA_VERSION,
        categoryCount: snapshot.meta.storedRowCount,
        lastCategorySync: snapshot.meta.completedAt,
      };
      await client.query(
        `INSERT INTO cache_meta (key, value) VALUES ('state', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(nextState)],
      );
      await client.query(
        `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [CATEGORY_GENERATION_META_KEY, snapshot.meta.generation],
      );
    });
  }

  async getCategorySnapshot(): Promise<CategorySnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const meta = await this.readAuthoritativeCategoryMeta(client);
      if (!meta) {
        await client.query('COMMIT');
        return null;
      }
      const rows = (await client.query<CategoryCacheRow>(
        `SELECT ${CATEGORY_COLUMNS.join(', ')} FROM categories ORDER BY category_id`,
      )).rows.map((row) => this.coerceCategory(row));
      if (rows.length !== meta.storedRowCount) {
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return { rows, meta };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCategoryCacheMeta(): Promise<CategoryCacheMeta | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const meta = await this.readAuthoritativeCategoryMeta(client);
      if (!meta) {
        await client.query('COMMIT');
        return null;
      }
      const countResult = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM categories`);
      await client.query('COMMIT');
      return Number(countResult.rows[0]?.count) === meta.storedRowCount ? meta : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCategory(categoryId: string): Promise<CategoryCacheRow | undefined> {
    return (await this.getCategorySnapshot())?.rows.find((row) => row.category_id === categoryId);
  }

  async getAllCategories(): Promise<CategoryCacheRow[]> {
    return (await this.getCategorySnapshot())?.rows ?? [];
  }

  async getCategoryCount(): Promise<number> {
    return (await this.getCategoryCacheMeta())?.storedRowCount ?? 0;
  }

  async insertDocument(doc: DocumentRow): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
        this.valuesFor(DOCUMENT_COLUMNS, await this.normalizeDocumentForWrite(doc, client)),
      );
    });
  }

  async getDocument(docId: string): Promise<DocumentRow | undefined> {
    const row = (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE doc_id = $1`, [docId])).rows[0];
    return row ? this.coerceDocument(row) : undefined;
  }

  async getDocumentByApiId(apiDocId: string): Promise<DocumentRow | undefined> {
    const row = (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE api_doc_id = $1`, [apiDocId])).rows[0];
    return row ? this.coerceDocument(row) : undefined;
  }

  async getDocumentByNumber(contextId: number, docNumber: number): Promise<DocumentRow | undefined> {
    const row = (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1 AND doc_number = $2`, [contextId, docNumber])).rows[0];
    return row ? this.coerceDocument(row) : undefined;
  }

  async getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1`, [contextId])).rows.map(this.coerceDocument);
  }

  async getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE modified > $1 ORDER BY modified ASC`, [timestamp])).rows.map(this.coerceDocument);
  }

  async getDocumentCountByContext(contextId: number): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents WHERE context_id = $1`, [contextId]);
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM documents WHERE doc_id = $1`, [docId]);
    });
  }

  async batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    await this.batch(docs, (client, doc) => client.query(
      this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
      this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(doc)),
    ));
  }

  async batchDeleteDocuments(docIds: string[]): Promise<void> {
    await this.batch(docIds, (client, id) => client.query(`DELETE FROM documents WHERE doc_id = $1`, [id]));
  }

  async insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS),
        this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item)),
      );
    });
  }

  async getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    return (await this.pool.query<ItemDocumentRow>(`SELECT * FROM item_documents WHERE doc_id = $1`, [docId])).rows.map(this.coerceItemDocument);
  }

  async deleteItemDocuments(docId: string): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM item_documents WHERE doc_id = $1`, [docId]);
    });
  }

  async batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    await this.batch(items, (client, item) => client.query(
      this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS),
      this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item)),
    ));
  }

  async getPaymentTransactions(docId: string): Promise<PaymentTransactionRow[]> {
    return (await this.pool.query<PaymentTransactionRow>(
      `SELECT * FROM payment_transactions WHERE doc_id = $1 ORDER BY transaction_date ASC, transaction_id ASC`,
      [docId],
    )).rows.map((row) => this.coercePaymentTransaction(row));
  }

  async getAllPaymentTransactions(): Promise<PaymentTransactionRow[]> {
    return (await this.pool.query<PaymentTransactionRow>(
      `SELECT * FROM payment_transactions ORDER BY transaction_date ASC, transaction_id ASC`,
    )).rows.map((row) => this.coercePaymentTransaction(row));
  }

  async replacePaymentTransactions(docId: string, transactions: PaymentTransactionRow[]): Promise<void> {
    assertPaymentRowsMatchDocument(docId, transactions);
    assertUniquePaymentTransactionIds(transactions);
    await this.withVerifiedWrite(async (client) => {
      await client.query(`SELECT doc_id FROM documents WHERE doc_id = $1 FOR UPDATE`, [docId]);
      await client.query(`DELETE FROM payment_transactions WHERE doc_id = $1`, [docId]);
      for (const transaction of transactions) {
        await client.query(
          this.insertSql('payment_transactions', PAYMENT_TRANSACTION_COLUMNS),
          this.valuesFor(PAYMENT_TRANSACTION_COLUMNS, this.normalizePaymentTransaction(transaction)),
        );
      }
    });
  }

  async batchInsertPaymentTransactions(transactions: PaymentTransactionRow[]): Promise<void> {
    assertUniquePaymentTransactionIds(transactions);
    await this.batch(transactions, (client, transaction) =>
      client.query(
        this.insertSql('payment_transactions', PAYMENT_TRANSACTION_COLUMNS),
        this.valuesFor(PAYMENT_TRANSACTION_COLUMNS, this.normalizePaymentTransaction(transaction)),
      ),
    );
  }

  async insertAccount(account: AccountRow): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'),
        this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account)),
      );
    });
  }

  async getAccount(accountId: string): Promise<AccountRow | undefined> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE account_id = $1`, [accountId])).rows[0];
  }

  async getAccountByNumber(contextId: number, accountNumber: number): Promise<AccountRow | undefined> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE context_id = $1 AND account_number = $2`, [contextId, accountNumber])).rows[0];
  }

  async getAccountsByName(contextId: number, name: string): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE context_id = $1 AND name = $2`, [contextId, name])).rows;
  }

  async getAllAccounts(): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts`)).rows;
  }

  async getAccountsModifiedSince(timestamp: number): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>(`SELECT * FROM accounts WHERE COALESCE(modified, 0) > $1 ORDER BY modified ASC`, [timestamp])).rows;
  }

  async batchInsertAccounts(accounts: AccountRow[]): Promise<void> {
    await this.batch(accounts, (client, account) => client.query(
      this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'),
      this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account)),
    ));
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM accounts WHERE account_id = $1`, [accountId]);
    });
  }

  async insertItem(item: ItemRow): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        this.upsertSql('items', ITEM_COLUMNS, 'item_id'),
        this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)),
      );
    });
  }

  async getItem(itemId: string): Promise<ItemRow | undefined> {
    const row = (await this.pool.query<ItemRow>(`SELECT * FROM items WHERE item_id = $1`, [itemId])).rows[0];
    return row ? this.coerceItem(row) : undefined;
  }

  async getAllItems(): Promise<ItemRow[]> {
    return (await this.pool.query<ItemRow>(`SELECT * FROM items`)).rows.map(this.coerceItem);
  }

  async getItemsModifiedSince(timestamp: number): Promise<ItemRow[]> {
    return (await this.pool.query<ItemRow>(`SELECT * FROM items WHERE COALESCE(modified, 0) > $1 ORDER BY modified ASC`, [timestamp])).rows.map(this.coerceItem);
  }

  async batchInsertItems(items: ItemRow[]): Promise<void> {
    await this.batch(items, (client, item) => client.query(
      this.upsertSql('items', ITEM_COLUMNS, 'item_id'),
      this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item)),
    ));
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM items WHERE item_id = $1`, [itemId]);
    });
  }

  async insertItemStockLocation(row: ItemStockLocationRow): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
        this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)),
      );
    });
  }

  async getItemStockLocations(itemId: string): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations WHERE item_id = $1`, [itemId])).rows.map(this.coerceStock);
  }

  async getAllItemStockLocations(): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations`)).rows.map(this.coerceStock);
  }

  async replaceItemStockLocations(itemId: string, rows: ItemStockLocationRow[]): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [itemId]);
      for (const row of rows) {
        await client.query(this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'), this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)));
      }
    });
  }

  async batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void> {
    await this.batch(rows, (client, row) => client.query(
      this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
      this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row)),
    ));
  }

  async deleteItemStockLocations(itemId: string): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [itemId]);
    });
  }

  async getItemDocumentsForPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemDocumentRow[]> {
    const result = await this.pool.query<ItemDocumentRow>(
      `SELECT id.* FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map(this.coerceItemDocument);
  }

  async getLatestItemDocumentDate(itemId: string, contextId: number): Promise<string | undefined> {
    const result = await this.pool.query<{ latest_date: string | null }>(
      `SELECT MAX(d.issue_date) as latest_date FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id WHERE id.item_id = $1 AND d.context_id = $2`,
      [itemId, contextId]
    );
    return result.rows[0]?.latest_date || undefined;
  }

  async getItemSalesByPeriod(itemId: string, startDate: string, endDate: string, contextId: number): Promise<ItemSalesByPeriodRow[]> {
    const result = await this.pool.query<ItemSalesByPeriodRow>(
      `SELECT d.issue_date, id.quantity, id.price FROM item_documents id
       JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       ORDER BY d.issue_date ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({ ...row, quantity: Number(row.quantity), price: Number(row.price) }));
  }

  async getItemPriceDistribution(itemId: string, startDate: string, endDate: string, contextId: number): Promise<PriceDistributionRow[]> {
    const result = await this.pool.query<PriceDistributionRow>(
      `SELECT id.price, SUM(ABS(id.quantity)) as total_quantity, SUM(id.quantity * id.price) as total_revenue
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY id.price ORDER BY id.price ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      price: Number(row.price),
      total_quantity: Number(row.total_quantity),
      total_revenue: Number(row.total_revenue),
    }));
  }

  async getItemSalesByCustomer(itemId: string, startDate: string, endDate: string, contextId: number): Promise<CustomerSalesData[]> {
    const result = await this.pool.query<CustomerSalesData>(
      `SELECT d.customer_id, d.customer_name, SUM(ABS(id.quantity)) as quantity,
              SUM(id.quantity * id.price) as revenue, COUNT(DISTINCT id.doc_id) as order_count
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY d.customer_id, d.customer_name ORDER BY revenue DESC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
      order_count: Number(row.order_count),
    }));
  }

  async getItemSalesByMonth(itemId: string, startDate: string, endDate: string, contextId: number): Promise<{ month: string; quantity: number; revenue: number }[]> {
    const result = await this.pool.query<{ month: string; quantity: number; revenue: number }>(
      `SELECT to_char(d.issue_date::date, 'YYYY-MM') as month, SUM(ABS(id.quantity)) as quantity,
              SUM(id.quantity * id.price) as revenue
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id = $2 AND d.issue_date BETWEEN $3 AND $4
       GROUP BY month ORDER BY month ASC`,
      [itemId, contextId, startDate, endDate]
    );
    return result.rows.map((row) => ({ month: row.month, quantity: Number(row.quantity), revenue: Number(row.revenue) }));
  }

  async getItemOrderPatterns(itemId: string, startDate: string, endDate: string): Promise<{
    doc_id: string; quantity: number; price: number; issue_date: string; customer_id: string; context_id: number; doc_number: number;
  }[]> {
    const result = await this.pool.query<any>(
      `SELECT id.doc_id, id.quantity, id.price, d.issue_date, d.customer_id, d.context_id, d.doc_number
       FROM item_documents id JOIN documents d ON d.doc_id = id.doc_id
       WHERE id.item_id = $1 AND d.context_id IN (4, 5) AND d.issue_date BETWEEN $2 AND $3
       ORDER BY d.issue_date DESC`,
      [itemId, startDate, endDate]
    );
    return result.rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      context_id: Number(row.context_id),
      doc_number: Number(row.doc_number),
    }));
  }

  async getCacheState(): Promise<CacheState | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'state'`);
    return result.rows.length ? JSON.parse(result.rows[0].value) as CacheState : null;
  }

  async setCacheState(state: CacheState): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      const persistedResult = await client.query<{ value: string }>(
        `SELECT value FROM cache_meta WHERE key = 'state' FOR UPDATE`,
      );
      const persisted = this.parseCacheState(persistedResult.rows[0]?.value);
      if (state.schemaVersion === CACHE_SCHEMA_VERSION && persisted?.schemaVersion !== CACHE_SCHEMA_VERSION) {
        await client.query(`DELETE FROM cache_meta WHERE key = $1`, [CATEGORY_GENERATION_META_KEY]);
      }
      await client.query(
        `INSERT INTO cache_meta (key, value) VALUES ('state', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(state)],
      );
    });
  }

  async getSyncStatus(): Promise<CacheSyncStatus | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'sync_status'`);
    return result.rows.length ? JSON.parse(result.rows[0].value) as CacheSyncStatus : null;
  }

  async setSyncStatus(status: CacheSyncStatus): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        `INSERT INTO cache_meta (key, value) VALUES ('sync_status', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(status)],
      );
    });
  }

  async getPaymentSyncStatus(): Promise<PaymentSyncStatus | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = $1`, [PAYMENT_SYNC_STATUS_KEY]);
    return result.rows.length ? JSON.parse(result.rows[0].value) as PaymentSyncStatus : null;
  }

  async setPaymentSyncStatus(status: PaymentSyncStatus): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(
        `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [PAYMENT_SYNC_STATUS_KEY, JSON.stringify(status)],
      );
    });
  }

  async tryAcquireSyncLock(_lockKey: string): Promise<boolean> {
    const binding = this.requireExpectedBinding();
    const lockKey = this.syncLockKey(binding);
    if (this.syncLockClients.has(lockKey)) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
        [lockKey],
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        return false;
      }
      this.assertMatchingBinding(await this.readBinding(client, false), binding);
      this.syncLockClients.set(lockKey, client);
      return true;
    } catch (error) {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async releaseSyncLock(_lockKey: string): Promise<void> {
    const binding = this.requireExpectedBinding();
    const lockKey = this.syncLockKey(binding);
    const client = this.syncLockClients.get(lockKey);
    if (!client) return;
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    } finally {
      this.syncLockClients.delete(lockKey);
      client.release();
    }
  }

  async getDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents`);
  }

  async getItemDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM item_documents`);
  }

  async getPaymentTransactionCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM payment_transactions`);
  }

  async getAccountCount(contextId?: number): Promise<number> {
    return contextId ? this.count(`SELECT COUNT(*) as count FROM accounts WHERE context_id = $1`, [contextId]) : this.count(`SELECT COUNT(*) as count FROM accounts`);
  }

  async getItemCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM items`);
  }

  async getStockLocationCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM item_stock_locations`);
  }

  async clearAll(): Promise<void> {
    await this.truncateAll();
  }

  async close(): Promise<void> {
    this.opened = false;
    for (const lockKey of [...this.syncLockClients.keys()]) {
      await this.releaseSyncLock(lockKey);
    }
    await this.pool.end();
  }

  isOpen(): boolean {
    return this.opened;
  }

  async truncateAll(): Promise<void> {
    await this.withVerifiedWrite(async (client) => {
      await client.query(`
        TRUNCATE TABLE payment_transactions, item_stock_locations, item_documents,
          items, documents, accounts, categories, category_cache_meta, cache_meta
          RESTART IDENTITY CASCADE
      `);
    });
  }

  private async withDatabaseTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.acquireDatabaseWriteLock(client);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async withVerifiedWrite<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const binding = this.requireExpectedBinding();
    return this.withDatabaseTransaction(async (client) => {
      this.assertMatchingBinding(await this.readBinding(client, true), binding);
      return run(client);
    });
  }

  private async acquireDatabaseWriteLock(client: PoolClient): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [DB_WRITE_LOCK_KEY]);
  }

  private requireExpectedBinding(): CacheAccountBinding {
    if (!this.expectedBinding) {
      throw new Error(
        'PostgreSQL cache writes require an explicit SalesBinder account binding. '
        + 'Call ensureAccountBinding with the configured subdomain before writing.'
      );
    }
    return this.expectedBinding;
  }

  private syncLockKey(binding: CacheAccountBinding): string {
    return `salesbinder-cache-sync:${binding.accountIdentity}`;
  }

  private async readBinding(
    executor: QueryExecutor,
    forUpdate: boolean,
  ): Promise<CacheAccountBinding | null> {
    const result = await executor.query<{
      account_identity: string;
      account_subdomain: string;
      created_at: string | number;
    }>(`
      SELECT account_identity, account_subdomain, created_at
      FROM cache_account_binding
      WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}
    `);
    const row = result.rows[0];
    return row ? {
      accountIdentity: row.account_identity,
      accountSubdomain: row.account_subdomain,
      createdAt: Number(row.created_at),
    } : null;
  }

  private async databaseContainsPayloadRows(executor: QueryExecutor): Promise<boolean> {
    const payloadTables = [
      'accounts', 'documents', 'item_documents', 'items', 'item_stock_locations',
      'payment_transactions', 'categories', 'category_cache_meta', 'cache_meta',
    ] as const;
    for (const table of payloadTables) {
      const relation = await executor.query<{ relation: string | null }>(
        `SELECT to_regclass($1)::TEXT AS relation`,
        [table],
      );
      if (!relation.rows[0]?.relation) continue;
      const populated = await executor.query<{ populated: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) AS populated`,
      );
      if (populated.rows[0]?.populated === true) return true;
    }
    return false;
  }

  private assertMatchingBinding(
    persisted: CacheAccountBinding | null,
    expected: CacheAccountBinding,
  ): void {
    if (
      !persisted
      || persisted.accountIdentity !== expected.accountIdentity
      || persisted.accountSubdomain !== expected.accountSubdomain
    ) {
      throw new Error(
        `PostgreSQL cache database is not bound to ${expected.accountIdentity}. `
        + 'Use the matching database or rebuild a fresh database for this SalesBinder account.'
      );
    }
  }

  private async readAuthoritativeCategoryMeta(
    executor: QueryExecutor,
  ): Promise<CategoryCacheMeta | null> {
    const result = await executor.query<{
      snapshot_value: string;
      marker_value: string | null;
      state_value: string | null;
      account_identity: string;
      account_subdomain: string;
    }>(`
      SELECT snapshot.value AS snapshot_value,
             marker.value AS marker_value,
             state.value AS state_value,
             binding.account_identity,
             binding.account_subdomain
      FROM category_cache_meta AS snapshot
      JOIN cache_account_binding AS binding ON binding.id = 1
      LEFT JOIN cache_meta AS marker ON marker.key = $2
      LEFT JOIN cache_meta AS state ON state.key = 'state'
      WHERE snapshot.key = $1
    `, [CATEGORY_SNAPSHOT_META_KEY, CATEGORY_GENERATION_META_KEY]);
    const row = result.rows[0];
    if (!row) return null;

    const meta = this.parseCategoryMeta(row.snapshot_value);
    const state = this.parseCacheState(row.state_value);
    if (
      !meta
      || state?.schemaVersion !== CACHE_SCHEMA_VERSION
      || row.marker_value !== meta.generation
      || row.account_identity !== meta.accountIdentity
      || (this.expectedBinding && row.account_identity !== this.expectedBinding.accountIdentity)
    ) {
      return null;
    }
    return meta;
  }

  private parseCacheState(value: string | null | undefined): CacheState | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const state = parsed as Partial<CacheState>;
      return Number.isSafeInteger(state.schemaVersion) ? state as CacheState : null;
    } catch {
      return null;
    }
  }

  private parseCategoryMeta(value: string): CategoryCacheMeta | null {
    try {
      const parsed = JSON.parse(value) as Partial<CategoryCacheMeta>;
      const exactKeys = [
        'accountIdentity', 'completedAt', 'count', 'fingerprint', 'generation', 'page',
        'pages', 'schemaVersion', 'sourceRowCount', 'startedAt', 'status',
        'storedRowCount', 'version',
      ];
      const integerFields = [
        parsed.startedAt, parsed.completedAt, parsed.count, parsed.page, parsed.pages,
        parsed.sourceRowCount, parsed.storedRowCount,
      ];
      if (
        !parsed || typeof parsed !== 'object'
        || !this.hasExactKeys(parsed, exactKeys)
        || parsed.version !== 1
        || parsed.status !== 'complete'
        || parsed.schemaVersion !== CACHE_SCHEMA_VERSION
        || typeof parsed.accountIdentity !== 'string'
        || typeof parsed.generation !== 'string' || parsed.generation.length === 0
        || typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0
        || integerFields.some((number) => !Number.isSafeInteger(number) || (number as number) < 0)
        || (parsed.completedAt as number) < (parsed.startedAt as number)
      ) {
        return null;
      }
      return parsed as CategoryCacheMeta;
    } catch {
      return null;
    }
  }

  private assertValidCategorySnapshot(snapshot: CategorySnapshot, accountIdentity: string): void {
    const meta = this.parseCategoryMeta(JSON.stringify(snapshot.meta));
    if (
      !meta
      || meta.accountIdentity !== accountIdentity
      || meta.sourceRowCount !== snapshot.rows.length
      || meta.storedRowCount !== snapshot.rows.length
      || meta.count !== snapshot.rows.length
    ) {
      throw new Error('Category snapshot metadata does not match the bound account or validated rows.');
    }
    const expectedRowKeys = [
      'cache_source', 'category_id', 'created', 'imported_at', 'item_count',
      'modified', 'name', 'parent_id', 'parent_name',
    ];
    const ids = new Set<string>();
    const names = new Map<string, string>();
    for (const row of snapshot.rows) {
      if (
        !row || typeof row !== 'object'
        || !this.hasExactKeys(row, expectedRowKeys)
        || typeof row.category_id !== 'string'
        || typeof row.name !== 'string'
        || !row.category_id.trim()
        || !row.name.trim()
        || row.category_id.includes('\0')
        || row.name.includes('\0')
        || ids.has(row.category_id)
        || row.cache_source !== 'api'
        || !Number.isSafeInteger(row.imported_at) || row.imported_at < 0
        || (row.item_count !== null
          && (!Number.isSafeInteger(row.item_count) || row.item_count < 0))
        || (row.parent_id !== null
          && (typeof row.parent_id !== 'string' || row.parent_id.trim().length === 0
            || row.parent_id.includes('\0')))
        || (row.parent_name !== null
          && (typeof row.parent_name !== 'string' || row.parent_name.trim().length === 0
            || row.parent_name.includes('\0')))
        || (row.created !== null
          && (typeof row.created !== 'string' || row.created.includes('\0')))
        || (row.modified !== null
          && (!Number.isSafeInteger(row.modified) || row.modified < 0))
      ) {
        throw new Error('Category snapshot contains an invalid or duplicate category row.');
      }
      ids.add(row.category_id);
      names.set(row.category_id, row.name);
    }
    for (const row of snapshot.rows) {
      const expectedParentName = row.parent_id ? names.get(row.parent_id) ?? null : null;
      if (row.parent_name !== expectedParentName) {
        throw new Error('Category snapshot parent names must be derived from the same validated snapshot.');
      }
    }
  }

  private hasExactKeys(value: object, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
  }

  private async count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query<{ count: string }>(sql, params);
    return Number(result.rows[0].count);
  }

  private insertSql(table: string, columns: readonly string[]): string {
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
  }

  private upsertSql(table: string, columns: readonly string[], conflictColumn: string): string {
    const updates = columns
      .filter((column) => column !== conflictColumn)
      .map((column) => column === 'archived' && (table === 'documents' || table === 'items')
        ? `${column} = COALESCE(EXCLUDED.${column}, ${table}.${column})`
        : `${column} = EXCLUDED.${column}`)
      .join(', ');
    return `${this.insertSql(table, columns)} ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`;
  }

  private valuesFor(columns: readonly string[], row: Record<string, unknown>): unknown[] {
    return columns.map((column) => this.sanitizeDbValue(row[column] ?? null));
  }

  /**
   * PostgreSQL rejects literal NUL bytes in text values. SalesBinder free-text
   * fields can contain them, so sanitize every outgoing string centrally instead
   * of relying on each indexer to remember every text field.
   */
  private sanitizeDbValue(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    return value.replaceAll('\u0000', '');
  }

  private async batch<T>(
    rows: T[],
    run: (client: PoolClient, row: T) => Promise<unknown>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.withVerifiedWrite(async (client) => {
      for (const row of rows) await run(client, row);
    });
  }

  private normalizeDocument(doc: DocumentRow): Record<string, unknown> {
    const accountId = doc.account_id ?? doc.customer_id;
    return {
      ...doc,
      customer_id: doc.customer_id || accountId || 'unknown',
      cache_source: doc.cache_source ?? 'api',
      account_id: doc.account_id ?? null,
      account_context_id: doc.account_context_id ?? null,
      account_name: doc.account_name ?? doc.customer_name ?? doc.supplier_name ?? null,
      is_cancelled: doc.is_cancelled ?? 0,
      archived: doc.archived ?? null,
    };
  }

  private async normalizeDocumentForWrite(
    doc: DocumentRow,
    executor: QueryExecutor,
  ): Promise<Record<string, unknown>> {
    let existing: { doc_id: string } | undefined;
    if (doc.api_doc_id) {
      existing = (await executor.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE api_doc_id = $1`,
        [doc.api_doc_id]
      )).rows[0];
    }
    if (!existing) {
      existing = (await executor.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE context_id = $1 AND doc_number = $2`,
        [doc.context_id, doc.doc_number]
      )).rows[0];
    }
    return this.normalizeDocument(existing ? { ...doc, doc_id: existing.doc_id } : doc);
  }

  private normalizeItemDocument(item: Omit<ItemDocumentRow, 'id'>): Record<string, unknown> {
    return { ...item, quantity: item.quantity ?? 0, price: item.price ?? 0 };
  }

  private normalizeAccount(account: AccountRow): Record<string, unknown> {
    return { ...account, archived: account.archived ?? 0, cache_source: account.cache_source ?? 'api' };
  }

  private normalizeItem(item: ItemRow): Record<string, unknown> {
    return { ...item, archived: item.archived ?? null, cache_source: item.cache_source ?? 'api' };
  }

  private normalizeStock(row: ItemStockLocationRow): Record<string, unknown> {
    return {
      ...row,
      quantity_on_hand: row.quantity_on_hand ?? 0,
      quantity_reserved: row.quantity_reserved ?? 0,
      quantity_available: row.quantity_available ?? 0,
      quantity_incoming: row.quantity_incoming ?? 0,
      in_transit: row.in_transit ?? 0,
      cache_source: row.cache_source ?? 'api',
    };
  }

  private normalizePaymentTransaction(row: PaymentTransactionRow): Record<string, unknown> {
    return {
      ...row,
      reference: row.reference ?? null,
    };
  }

  private coerceDocument(row: DocumentRow): DocumentRow {
    return {
      ...row,
      shipped_percent: row.shipped_percent == null ? null : Number(row.shipped_percent),
    };
  }

  private coerceItemDocument(row: ItemDocumentRow): ItemDocumentRow {
    return {
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      quantity_received: row.quantity_received == null ? null : Number(row.quantity_received),
      quantity_shipped: row.quantity_shipped == null ? null : Number(row.quantity_shipped),
      cost: row.cost == null ? null : Number(row.cost),
      total_amount: row.total_amount == null ? null : Number(row.total_amount),
      discounted_price: row.discounted_price == null ? null : Number(row.discounted_price),
      discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
    };
  }

  private coerceItem(row: ItemRow): ItemRow {
    return {
      ...row,
      quantity: row.quantity == null ? null : Number(row.quantity),
      quantity_reserved: row.quantity_reserved == null ? null : Number(row.quantity_reserved),
      quantity_available: row.quantity_available == null ? null : Number(row.quantity_available),
      quantity_incoming: row.quantity_incoming == null ? null : Number(row.quantity_incoming),
      in_transit: row.in_transit == null ? null : Number(row.in_transit),
      threshold: row.threshold == null ? null : Number(row.threshold),
      cost: row.cost == null ? null : Number(row.cost),
      price: row.price == null ? null : Number(row.price),
      valuation: row.valuation == null ? null : Number(row.valuation),
    };
  }

  private coerceStock(row: ItemStockLocationRow): ItemStockLocationRow {
    return {
      ...row,
      quantity_on_hand: Number(row.quantity_on_hand),
      quantity_reserved: Number(row.quantity_reserved),
      quantity_available: Number(row.quantity_available),
      quantity_incoming: Number(row.quantity_incoming),
      in_transit: Number(row.in_transit),
      price: row.price == null ? null : Number(row.price),
      cost: row.cost == null ? null : Number(row.cost),
      valuation: row.valuation == null ? null : Number(row.valuation),
    };
  }

  private coerceCategory(row: CategoryCacheRow): CategoryCacheRow {
    return {
      ...row,
      item_count: row.item_count == null ? null : Number(row.item_count),
      modified: row.modified == null ? null : Number(row.modified),
      imported_at: Number(row.imported_at),
    };
  }

  private coercePaymentTransaction(row: PaymentTransactionRow): PaymentTransactionRow {
    return {
      ...row,
      amount: Number(row.amount),
      reference: row.reference ?? null,
      imported_at: Number(row.imported_at),
    };
  }
}
