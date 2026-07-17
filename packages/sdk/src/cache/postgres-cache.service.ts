/**
 * PostgreSQL cache service for the shared analytics cache upstream.
 */

import pg, { type PoolClient } from 'pg';
import type { CacheService } from './cache.interface.js';
import {
  assertCacheAccountCompatible,
  CACHE_SCHEMA_VERSION,
  CACHE_WRITER_LOCK_KEY,
  isShipmentIdentityCompatible,
} from './types.js';
import type {
  AccountRow,
  CacheMirrorSnapshot,
  CacheState,
  CacheSyncStatus,
  CustomerSalesData,
  DocumentNonItemLineRow,
  DocumentRow,
  DocumentSnapshot,
  ItemDocumentRow,
  ItemRow,
  ItemSalesByPeriodRow,
  ItemStockLocationRow,
  PriceDistributionRow,
} from './types.js';

const { Pool } = pg;
const CACHE_WRITER_APPLICATION_NAME = `salesbinder-cache-v${CACHE_SCHEMA_VERSION}`;
const TENANT_CACHE_TABLES = [
  'accounts',
  'documents',
  'item_documents',
  'document_non_item_lines',
  'items',
  'item_stock_locations',
] as const;
const ALL_CACHE_TABLES = [...TENANT_CACHE_TABLES, 'cache_meta'] as const;

interface SyncLockLease {
  client: PoolClient;
  invalidate: () => void;
}

const DOCUMENT_COLUMNS = [
  'doc_id', 'context_id', 'doc_number', 'issue_date', 'customer_id', 'modified',
  'api_doc_id', 'cache_source', 'document_name', 'custom_doc_number',
  'account_id', 'account_context_id', 'account_name', 'account_number',
  'user_id', 'salesperson_name', 'customer_name', 'customer_number',
  'supplier_name', 'supplier_number', 'status_id', 'status_name',
  'total_price', 'total_cost', 'subtotal', 'associated_document_id',
  'external_po_number', 'shipping_location', 'date_sent', 'shipped_percent',
  'shipment_checked_at', 'source_fetched_at', 'snapshot_version',
  'snapshot_complete', 'is_cancelled', 'imported_at',
] as const;

const ITEM_DOCUMENT_COLUMNS = [
  'item_id', 'doc_id', 'quantity', 'price', 'document_item_id', 'item_name',
  'item_number', 'item_sku', 'item_location', 'line_description',
  'quantity_received', 'cost', 'total_amount', 'discounted_price', 'discount_percent',
  'quantity_shipped',
] as const;

const DOCUMENT_NON_ITEM_LINE_COLUMNS = [
  'doc_id', 'document_item_id', 'line_type', 'name', 'line_description',
  'service_category_id', 'unit_id', 'quantity', 'price', 'cost', 'total_amount',
  'discounted_price', 'discount_percent', 'net_amount', 'tax', 'tax2', 'weight',
  'source_created', 'source_modified', 'raw_classification',
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
  'published', 'created', 'modified', 'cache_source', 'imported_at',
] as const;

const STOCK_COLUMNS = [
  'stock_row_id', 'item_id', 'item_number', 'variation_id', 'variation_location_id',
  'location_id', 'location_name', 'category_name', 'quantity_on_hand',
  'quantity_reserved', 'quantity_available', 'quantity_incoming', 'in_transit',
  'price', 'cost', 'valuation', 'barcode', 'cache_source', 'imported_at',
] as const;

export class PostgresCacheService implements CacheService {
  private pool: InstanceType<typeof Pool>;
  private readonly syncLockClients = new Map<string, SyncLockLease>();
  private writerQueue: Promise<void> = Promise.resolve();
  private opened = true;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString: withCacheWriterApplicationName(connectionString),
      application_name: CACHE_WRITER_APPLICATION_NAME,
    });
  }

  async ensureSchema(requestedAccountName: string): Promise<void> {
    if (!requestedAccountName.trim()) {
      throw new Error('Cache schema initialization requires a non-empty account name.');
    }
    const retainLease = this.syncLockClients.has(CACHE_WRITER_LOCK_KEY);
    if (!await this.tryAcquireSyncLock(CACHE_WRITER_LOCK_KEY)) {
      throw new Error('Another cache writer is already running.');
    }
    try {
      await this.withWriterClient(async (client) => {
        await this.assertOwnershipBeforeSchemaLocked(client, requestedAccountName);
        await this.ensureSchemaLocked(client);
      });
    } finally {
      if (!retainLease) await this.releaseSyncLock(CACHE_WRITER_LOCK_KEY);
    }
  }

  private async assertOwnershipBeforeSchemaLocked(
    client: PoolClient,
    requestedAccountName: string
  ): Promise<void> {
    const relationResult = await client.query<Record<string, boolean>>(
      `SELECT ${ALL_CACHE_TABLES.map((table, index) => (
        `to_regclass($${index + 1}) IS NOT NULL AS "${table}"`
      )).join(', ')}`,
      [...ALL_CACHE_TABLES]
    );
    const relations = relationResult.rows[0] ?? {};
    let state: Pick<CacheState, 'accountName'> | null = null;

    if (relations.cache_meta) {
      const stateResult = await client.query<{ value: string }>(
        `SELECT value FROM cache_meta WHERE key = 'state' LIMIT 1`
      );
      if (stateResult.rows[0]) {
        try {
          const parsed = JSON.parse(stateResult.rows[0].value) as unknown;
          if (
            !parsed
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || (
              'accountName' in parsed
              && typeof (parsed as { accountName?: unknown }).accountName !== 'string'
            )
          ) {
            throw new Error('invalid ownership metadata');
          }
          state = parsed as Pick<CacheState, 'accountName'>;
        } catch {
          throw new Error(
            'Cache account ownership metadata is malformed. '
            + 'Explicitly clear the cache before initializing this schema.'
          );
        }
      }
      const versionResult = await client.query<{ value: string }>(
        `SELECT value FROM cache_meta WHERE key = 'cache_schema_version' LIMIT 1`
      );
      if (versionResult.rows[0]) {
        const rawVersion = versionResult.rows[0].value.trim();
        const cacheSchemaVersion = /^\d+$/.test(rawVersion)
          ? Number(rawVersion)
          : Number.NaN;
        if (!Number.isSafeInteger(cacheSchemaVersion)) {
          throw new Error(
            'Cache schema version metadata is malformed. '
            + 'Explicitly clear the cache before initializing this schema.'
          );
        }
        if (cacheSchemaVersion > CACHE_SCHEMA_VERSION) {
          throw new Error(
            `Cache schema version ${cacheSchemaVersion} is newer than this writer `
            + `version ${CACHE_SCHEMA_VERSION}; upgrade the SalesBinder writer before syncing.`
          );
        }
      }
    }

    assertCacheAccountCompatible(state, requestedAccountName);
    if (state?.accountName?.trim()) return;

    for (const table of TENANT_CACHE_TABLES) {
      if (!relations[table]) continue;
      const populated = await client.query<{ populated: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) AS populated`
      );
      if (populated.rows[0]?.populated) {
        throw new Error(
          'Cache contains data with no account ownership metadata. '
          + `Use a separate database/cache for "${requestedAccountName}" or explicitly clear `
          + 'the existing cache before syncing.'
        );
      }
    }
  }

  private async ensureSchemaLocked(client: PoolClient): Promise<void> {
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

      CREATE TABLE IF NOT EXISTS document_non_item_lines (
        id BIGSERIAL PRIMARY KEY,
        doc_id TEXT NOT NULL,
        document_item_id TEXT NOT NULL,
        line_type TEXT NOT NULL DEFAULT 'non_item',
        name TEXT NULL,
        line_description TEXT NULL,
        service_category_id TEXT NULL,
        unit_id TEXT NULL,
        quantity NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        cost NUMERIC NULL,
        total_amount NUMERIC NOT NULL,
        discounted_price NUMERIC NULL,
        discount_percent NUMERIC NULL,
        net_amount NUMERIC NOT NULL,
        tax NUMERIC NULL,
        tax2 NUMERIC NULL,
        weight NUMERIC NULL,
        source_created TEXT NULL,
        source_modified TEXT NULL,
        raw_classification TEXT NULL,
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

      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await this.createSchemaVersionDowngradeGuard(client);
    await this.migrateDocumentColumns(client);
    await this.migrateItemDocumentColumns(client);
    await this.migrateToV3(client);
    await this.createCompletenessTriggers(client);
    await this.createIndexes(client);
    await this.publishSchemaVersion(client);
  }

  private async createSchemaVersionDowngradeGuard(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE OR REPLACE FUNCTION cache_reject_schema_version_downgrade()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.key = 'cache_schema_version'
          AND NEW.key = 'cache_schema_version'
          AND OLD.value ~ '^[0-9]+$'
          AND NEW.value ~ '^[0-9]+$'
          AND NEW.value::INTEGER < OLD.value::INTEGER
        THEN
          RAISE EXCEPTION 'SalesBinder cache schema downgrade from % to % is not allowed',
            OLD.value, NEW.value;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS cache_schema_version_monotonic_guard ON cache_meta;
      CREATE TRIGGER cache_schema_version_monotonic_guard
      BEFORE UPDATE ON cache_meta
      FOR EACH ROW EXECUTE FUNCTION cache_reject_schema_version_downgrade();
    `);
  }

  private async createCompletenessTriggers(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE OR REPLACE FUNCTION cache_mark_line_snapshot_incomplete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name', true) IS DISTINCT FROM '${CACHE_WRITER_APPLICATION_NAME}' THEN
          RAISE EXCEPTION 'incompatible SalesBinder cache writer';
        END IF;
        IF pg_trigger_depth() > 1 THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          UPDATE documents SET snapshot_complete = 0
           WHERE doc_id = OLD.doc_id AND snapshot_complete <> 0;
          RETURN OLD;
        END IF;
        UPDATE documents SET snapshot_complete = 0
         WHERE doc_id = NEW.doc_id AND snapshot_complete <> 0;
        IF TG_OP = 'UPDATE' AND OLD.doc_id IS DISTINCT FROM NEW.doc_id THEN
          UPDATE documents SET snapshot_complete = 0
           WHERE doc_id = OLD.doc_id AND snapshot_complete <> 0;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION cache_mark_header_snapshot_incomplete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name', true) IS DISTINCT FROM '${CACHE_WRITER_APPLICATION_NAME}' THEN
          RAISE EXCEPTION 'incompatible SalesBinder cache writer';
        END IF;
        IF OLD.context_id IS DISTINCT FROM NEW.context_id
          OR OLD.doc_number IS DISTINCT FROM NEW.doc_number
          OR OLD.total_price IS DISTINCT FROM NEW.total_price
          OR OLD.total_cost IS DISTINCT FROM NEW.total_cost
          OR OLD.subtotal IS DISTINCT FROM NEW.subtotal THEN
          NEW.snapshot_complete := 0;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION cache_require_v3_document_writer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name', true) IS DISTINCT FROM '${CACHE_WRITER_APPLICATION_NAME}' THEN
          RAISE EXCEPTION 'incompatible SalesBinder cache writer';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION cache_guard_shipment_writer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE writer_name TEXT := current_setting('application_name', true);
      BEGIN
        IF writer_name IS DISTINCT FROM '${CACHE_WRITER_APPLICATION_NAME}'
          AND writer_name IS DISTINCT FROM 'super-admin-sale-analyze' THEN
          RAISE EXCEPTION 'incompatible SalesBinder shipment writer';
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_documents_writer_v3_insert_delete ON documents;
      CREATE TRIGGER trg_documents_writer_v3_insert_delete
      BEFORE INSERT OR DELETE ON documents
      FOR EACH ROW EXECUTE FUNCTION cache_require_v3_document_writer();
      DROP TRIGGER IF EXISTS trg_documents_writer_v3_truncate ON documents;
      CREATE TRIGGER trg_documents_writer_v3_truncate
      BEFORE TRUNCATE ON documents
      FOR EACH STATEMENT EXECUTE FUNCTION cache_require_v3_document_writer();

      DROP TRIGGER IF EXISTS trg_item_documents_writer_v3_truncate ON item_documents;
      CREATE TRIGGER trg_item_documents_writer_v3_truncate
      BEFORE TRUNCATE ON item_documents
      FOR EACH STATEMENT EXECUTE FUNCTION cache_require_v3_document_writer();

      DROP TRIGGER IF EXISTS trg_non_item_lines_writer_v3_truncate ON document_non_item_lines;
      CREATE TRIGGER trg_non_item_lines_writer_v3_truncate
      BEFORE TRUNCATE ON document_non_item_lines
      FOR EACH STATEMENT EXECUTE FUNCTION cache_require_v3_document_writer();

      DROP TRIGGER IF EXISTS trg_documents_shipment_writer ON documents;
      CREATE TRIGGER trg_documents_shipment_writer
      BEFORE UPDATE OF date_sent, shipped_percent, shipment_checked_at ON documents
      FOR EACH ROW EXECUTE FUNCTION cache_guard_shipment_writer();

      DROP TRIGGER IF EXISTS trg_item_documents_shipment_writer ON item_documents;
      CREATE TRIGGER trg_item_documents_shipment_writer
      BEFORE UPDATE OF quantity_shipped ON item_documents
      FOR EACH ROW EXECUTE FUNCTION cache_guard_shipment_writer();

      DROP TRIGGER IF EXISTS trg_documents_financial_snapshot_incomplete ON documents;
      CREATE TRIGGER trg_documents_financial_snapshot_incomplete
      BEFORE UPDATE OF context_id, doc_number, total_price, total_cost, subtotal ON documents
      FOR EACH ROW EXECUTE FUNCTION cache_mark_header_snapshot_incomplete();

      DROP TRIGGER IF EXISTS trg_item_documents_insert_snapshot_incomplete ON item_documents;
      CREATE TRIGGER trg_item_documents_insert_snapshot_incomplete
      AFTER INSERT ON item_documents
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();
      DROP TRIGGER IF EXISTS trg_item_documents_delete_snapshot_incomplete ON item_documents;
      CREATE TRIGGER trg_item_documents_delete_snapshot_incomplete
      AFTER DELETE ON item_documents
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();
      DROP TRIGGER IF EXISTS trg_item_documents_financial_update_snapshot_incomplete ON item_documents;
      CREATE TRIGGER trg_item_documents_financial_update_snapshot_incomplete
      AFTER UPDATE OF item_id, doc_id, document_item_id, quantity, price, cost,
        total_amount, discounted_price, discount_percent ON item_documents
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();

      DROP TRIGGER IF EXISTS trg_non_item_lines_insert_snapshot_incomplete ON document_non_item_lines;
      CREATE TRIGGER trg_non_item_lines_insert_snapshot_incomplete
      AFTER INSERT ON document_non_item_lines
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();
      DROP TRIGGER IF EXISTS trg_non_item_lines_delete_snapshot_incomplete ON document_non_item_lines;
      CREATE TRIGGER trg_non_item_lines_delete_snapshot_incomplete
      AFTER DELETE ON document_non_item_lines
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();
      DROP TRIGGER IF EXISTS trg_non_item_lines_update_snapshot_incomplete ON document_non_item_lines;
      CREATE TRIGGER trg_non_item_lines_update_snapshot_incomplete
      AFTER UPDATE ON document_non_item_lines
      FOR EACH ROW EXECUTE FUNCTION cache_mark_line_snapshot_incomplete();
    `);
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
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS imported_at BIGINT NULL;
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
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS cost NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS total_amount NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discounted_price NUMERIC NULL;
      ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NULL;
    `);
  }

  private async migrateToV3(client: PoolClient): Promise<void> {
    try {
      await client.query('BEGIN');
      await client.query(`
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS date_sent TEXT NULL;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipped_percent NUMERIC NULL;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS shipment_checked_at TIMESTAMPTZ NULL;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_fetched_at BIGINT NULL;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS snapshot_complete INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE item_documents ADD COLUMN IF NOT EXISTS quantity_shipped NUMERIC NULL;
      `);
      const invalid = await client.query<{ doc_id: string; document_item_id: string }>(`
        SELECT doc_id, document_item_id
          FROM (
            SELECT doc_id, document_item_id FROM item_documents WHERE document_item_id IS NOT NULL
            UNION ALL
            SELECT doc_id, document_item_id FROM document_non_item_lines
          ) AS source_lines
         WHERE BTRIM(document_item_id) = ''
         LIMIT 1
      `);
      if (invalid.rows[0]) {
        throw new Error(`Cannot migrate cache schema: blank document line source id in ${invalid.rows[0].doc_id}`);
      }
      const duplicate = await client.query<{ doc_id: string; document_item_id: string }>(`
        SELECT doc_id, document_item_id
          FROM (
            SELECT doc_id, document_item_id FROM item_documents WHERE document_item_id IS NOT NULL
            UNION ALL
            SELECT doc_id, document_item_id FROM document_non_item_lines
          ) AS source_lines
         GROUP BY doc_id, document_item_id
        HAVING COUNT(*) > 1
         LIMIT 1
      `);
      if (duplicate.rows[0]) {
        throw new Error(
          `Cannot migrate cache schema: duplicate document line ${duplicate.rows[0].document_item_id} in ${duplicate.rows[0].doc_id}`
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the migration failure */ }
      throw error;
    }
  }

  private async publishSchemaVersion(client: PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO cache_meta (key, value) VALUES ('cache_schema_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(CACHE_SCHEMA_VERSION)]
    );
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_api_doc_id ON documents(api_doc_id) WHERE api_doc_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_item_documents_item ON item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_doc ON item_documents(doc_id);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_name ON item_documents(item_name);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_number ON item_documents(item_number);
      CREATE INDEX IF NOT EXISTS idx_item_documents_item_sku ON item_documents(item_sku);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_item_documents_source_line
        ON item_documents(doc_id, document_item_id) WHERE document_item_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_document_non_item_lines_doc ON document_non_item_lines(doc_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_non_item_lines_source_line
        ON document_non_item_lines(doc_id, document_item_id) WHERE document_item_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_accounts_context_number ON accounts(context_id, account_number);
      CREATE INDEX IF NOT EXISTS idx_accounts_context_name ON accounts(context_id, name);
      CREATE INDEX IF NOT EXISTS idx_accounts_modified ON accounts(modified);
      CREATE INDEX IF NOT EXISTS idx_accounts_archived ON accounts(archived);
      CREATE INDEX IF NOT EXISTS idx_items_modified ON items(modified);
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
      CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
      CREATE INDEX IF NOT EXISTS idx_items_item_number ON items(item_number);
      CREATE INDEX IF NOT EXISTS idx_stock_item ON item_stock_locations(item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON item_stock_locations(location_id);
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

  async readMirrorSnapshot(): Promise<CacheMirrorSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [accounts, documents, itemDocuments, nonItemLines, items, stockLocations, state, syncStatus] = await Promise.all([
        client.query<AccountRow>(`SELECT * FROM accounts`),
        client.query<DocumentRow>(`SELECT * FROM documents`),
        client.query<ItemDocumentRow>(`SELECT * FROM item_documents`),
        client.query<DocumentNonItemLineRow>(`SELECT * FROM document_non_item_lines`),
        client.query<ItemRow>(`SELECT * FROM items`),
        client.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations`),
        client.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'state'`),
        client.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'sync_status'`),
      ]);
      await client.query('COMMIT');
      return {
        accounts: accounts.rows,
        documents: documents.rows.map(this.coerceDocumentForMirror),
        itemDocuments: itemDocuments.rows.map((row) => withoutGeneratedId(this.coerceItemDocument(row))),
        documentNonItemLines: nonItemLines.rows.map((row) => withoutGeneratedId(this.coerceDocumentNonItemLine(row))),
        items: items.rows.map(this.coerceItem),
        stockLocations: stockLocations.rows.map(this.coerceStock),
        state: state.rows[0] ? JSON.parse(state.rows[0].value) as CacheState : null,
        syncStatus: syncStatus.rows[0] ? JSON.parse(syncStatus.rows[0].value) as CacheSyncStatus : null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async insertDocument(doc: DocumentRow): Promise<void> {
    await this.withWriterClient(async (client) => {
      await client.query(
        this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
        this.valuesFor(DOCUMENT_COLUMNS, await this.normalizeDocumentForWrite(client, doc))
      );
    });
  }

  async getDocument(docId: string): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE doc_id = $1`, [docId])).rows[0];
  }

  async getDocumentByApiId(apiDocId: string): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE api_doc_id = $1`, [apiDocId])).rows[0];
  }

  async getDocumentByNumber(contextId: number, docNumber: number): Promise<DocumentRow | undefined> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1 AND doc_number = $2`, [contextId, docNumber])).rows[0];
  }

  async getDocumentsByContext(contextId: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE context_id = $1`, [contextId])).rows;
  }

  async getDocumentsModifiedSince(timestamp: number): Promise<DocumentRow[]> {
    return (await this.pool.query<DocumentRow>(`SELECT * FROM documents WHERE modified > $1 ORDER BY modified ASC`, [timestamp])).rows;
  }

  async getDocumentCountByContext(contextId: number): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents WHERE context_id = $1`, [contextId]);
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(`DELETE FROM documents WHERE doc_id = $1`, [docId]));
  }

  async batchInsertDocuments(docs: DocumentRow[]): Promise<void> {
    await this.withWriterClient((client) => this.batch(client, docs, (doc) => client.query(
      this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
      this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(doc))
    )));
  }

  async batchDeleteDocuments(docIds: string[]): Promise<void> {
    await this.withWriterClient((client) => this.batch(
      client,
      docIds,
      (id) => client.query(`DELETE FROM documents WHERE doc_id = $1`, [id])
    ));
  }

  async replaceDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    await this.withWriterClient(async (client) => {
      this.validateDocumentSnapshot(snapshot);
      try {
        await client.query('BEGIN');
      let existing: DocumentRow | undefined;
      if (snapshot.document.api_doc_id) {
        existing = (await client.query<DocumentRow>(
          `SELECT * FROM documents WHERE api_doc_id = $1 FOR UPDATE`,
          [snapshot.document.api_doc_id]
        )).rows[0];
      }
      if (!existing) {
        existing = (await client.query<DocumentRow>(
          `SELECT * FROM documents WHERE context_id = $1 AND doc_number = $2 FOR UPDATE`,
          [snapshot.document.context_id, snapshot.document.doc_number]
        )).rows[0];
      }
      const docId = existing?.doc_id ?? snapshot.document.doc_id;
      const compatibleShipmentSource = existing
        && isShipmentIdentityCompatible(existing.api_doc_id, snapshot.document.api_doc_id)
        ? existing
        : undefined;
      const existingLines = compatibleShipmentSource
        ? (await client.query<ItemDocumentRow>(
            `SELECT * FROM item_documents WHERE doc_id = $1 ORDER BY id FOR UPDATE`,
            [docId]
          )).rows
        : [];
      await client.query(
        `SELECT id FROM document_non_item_lines WHERE doc_id = $1 ORDER BY id FOR UPDATE`,
        [docId]
      );
      const existingBySourceId = new Map(
        existingLines
          .filter((line) => line.document_item_id)
          .map((line) => [line.document_item_id!, line])
      );
      const preserveReconciledShipment = isShipmentNewer(
        compatibleShipmentSource?.shipment_checked_at,
        snapshot.sourceFetchedAt
      );
      const resolvedDocument: DocumentRow = {
        ...snapshot.document,
        doc_id: docId,
        date_sent: preserveReconciledShipment
          ? compatibleShipmentSource?.date_sent ?? snapshot.document.date_sent ?? null
          : authoritativeShipmentValue(
              snapshot.document.date_sent,
              compatibleShipmentSource?.date_sent
            ),
        shipped_percent: preserveReconciledShipment
          ? compatibleShipmentSource?.shipped_percent
            ?? snapshot.document.shipped_percent
            ?? null
          : authoritativeShipmentValue(
              snapshot.document.shipped_percent,
              compatibleShipmentSource?.shipped_percent
            ),
        shipment_checked_at: compatibleShipmentSource?.shipment_checked_at ?? null,
        source_fetched_at: snapshot.sourceFetchedAt,
        snapshot_version: CACHE_SCHEMA_VERSION,
        snapshot_complete: 0,
      };
      const resolvedItems = snapshot.itemLines.map((line) => {
        const existingLine = line.document_item_id
          ? existingBySourceId.get(line.document_item_id)
          : undefined;
        return {
          ...line,
          doc_id: docId,
          quantity_shipped: preserveReconciledShipment
            ? existingLine?.quantity_shipped ?? line.quantity_shipped ?? null
            : authoritativeShipmentValue(line.quantity_shipped, existingLine?.quantity_shipped),
        };
      });
      const resolvedNonItemLines = snapshot.nonItemLines.map((line) => ({ ...line, doc_id: docId }));

      await client.query(
        this.upsertSql('documents', DOCUMENT_COLUMNS, 'doc_id'),
        this.valuesFor(DOCUMENT_COLUMNS, this.normalizeDocument(resolvedDocument))
      );
      await client.query(`DELETE FROM item_documents WHERE doc_id = $1`, [docId]);
      await client.query(`DELETE FROM document_non_item_lines WHERE doc_id = $1`, [docId]);
      for (const line of resolvedItems) {
        await client.query(
          this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS),
          this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(line))
        );
      }
      for (const line of resolvedNonItemLines) {
        await client.query(
          this.insertSql('document_non_item_lines', DOCUMENT_NON_ITEM_LINE_COLUMNS),
          this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line))
        );
      }
      await client.query(`UPDATE documents SET snapshot_complete = 1 WHERE doc_id = $1`, [docId]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the snapshot failure */ }
        throw error;
      }
    });
  }

  async insertItemDocument(item: Omit<ItemDocumentRow, 'id'>): Promise<void> {
    await this.withWriterClient((client) => client.query(
      this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS),
      this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item))
    ));
  }

  async getItemDocuments(docId: string): Promise<ItemDocumentRow[]> {
    return (await this.pool.query<ItemDocumentRow>(`SELECT * FROM item_documents WHERE doc_id = $1`, [docId])).rows.map(this.coerceItemDocument);
  }

  async deleteItemDocuments(docId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(`DELETE FROM item_documents WHERE doc_id = $1`, [docId]));
  }

  async batchInsertItemDocuments(items: Omit<ItemDocumentRow, 'id'>[]): Promise<void> {
    await this.withWriterClient((client) => this.batch(client, items, (item) => client.query(
      this.insertSql('item_documents', ITEM_DOCUMENT_COLUMNS),
      this.valuesFor(ITEM_DOCUMENT_COLUMNS, this.normalizeItemDocument(item))
    )));
  }

  async insertDocumentNonItemLine(line: Omit<DocumentNonItemLineRow, 'id'>): Promise<void> {
    await this.withWriterClient((client) => client.query(
      this.insertSql('document_non_item_lines', DOCUMENT_NON_ITEM_LINE_COLUMNS),
      this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line))
    ));
  }

  async getDocumentNonItemLines(docId: string): Promise<DocumentNonItemLineRow[]> {
    return (await this.pool.query<DocumentNonItemLineRow>(
      `SELECT * FROM document_non_item_lines WHERE doc_id = $1`,
      [docId]
    )).rows.map(this.coerceDocumentNonItemLine);
  }

  async getAllDocumentNonItemLines(): Promise<DocumentNonItemLineRow[]> {
    return (await this.pool.query<DocumentNonItemLineRow>(
      `SELECT * FROM document_non_item_lines`
    )).rows.map(this.coerceDocumentNonItemLine);
  }

  async deleteDocumentNonItemLines(docId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(
      `DELETE FROM document_non_item_lines WHERE doc_id = $1`,
      [docId]
    ));
  }

  async batchInsertDocumentNonItemLines(lines: Omit<DocumentNonItemLineRow, 'id'>[]): Promise<void> {
    await this.withWriterClient((client) => this.batch(client, lines, (line) => client.query(
      this.insertSql('document_non_item_lines', DOCUMENT_NON_ITEM_LINE_COLUMNS),
      this.valuesFor(DOCUMENT_NON_ITEM_LINE_COLUMNS, this.normalizeDocumentNonItemLine(line))
    )));
  }

  async insertAccount(account: AccountRow): Promise<void> {
    await this.withWriterClient((client) => client.query(
      this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'),
      this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account))
    ));
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
    await this.withWriterClient((client) => this.batch(client, accounts, (account) => client.query(
      this.upsertSql('accounts', ACCOUNT_COLUMNS, 'account_id'),
      this.valuesFor(ACCOUNT_COLUMNS, this.normalizeAccount(account))
    )));
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(`DELETE FROM accounts WHERE account_id = $1`, [accountId]));
  }

  async insertItem(item: ItemRow): Promise<void> {
    await this.withWriterClient((client) => client.query(
      this.upsertSql('items', ITEM_COLUMNS, 'item_id'),
      this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item))
    ));
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
    await this.withWriterClient((client) => this.batch(client, items, (item) => client.query(
      this.upsertSql('items', ITEM_COLUMNS, 'item_id'),
      this.valuesFor(ITEM_COLUMNS, this.normalizeItem(item))
    )));
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(`DELETE FROM items WHERE item_id = $1`, [itemId]));
  }

  async insertItemStockLocation(row: ItemStockLocationRow): Promise<void> {
    await this.withWriterClient((client) => client.query(
      this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
      this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row))
    ));
  }

  async getItemStockLocations(itemId: string): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations WHERE item_id = $1`, [itemId])).rows.map(this.coerceStock);
  }

  async getAllItemStockLocations(): Promise<ItemStockLocationRow[]> {
    return (await this.pool.query<ItemStockLocationRow>(`SELECT * FROM item_stock_locations`)).rows.map(this.coerceStock);
  }

  async replaceItemStockLocations(itemId: string, rows: ItemStockLocationRow[]): Promise<void> {
    await this.withWriterClient(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [itemId]);
        for (const row of rows) {
          await client.query(
            this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
            this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row))
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the stock replacement failure */ }
        throw error;
      }
    });
  }

  async batchInsertItemStockLocations(rows: ItemStockLocationRow[]): Promise<void> {
    await this.withWriterClient((client) => this.batch(client, rows, (row) => client.query(
      this.upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
      this.valuesFor(STOCK_COLUMNS, this.normalizeStock(row))
    )));
  }

  async deleteItemStockLocations(itemId: string): Promise<void> {
    await this.withWriterClient((client) => client.query(
      `DELETE FROM item_stock_locations WHERE item_id = $1`,
      [itemId]
    ));
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
    await this.withWriterClient((client) => client.query(
      `INSERT INTO cache_meta (key, value) VALUES ('state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(state)]
    ));
  }

  async getSyncStatus(): Promise<CacheSyncStatus | null> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM cache_meta WHERE key = 'sync_status'`);
    return result.rows.length ? JSON.parse(result.rows[0].value) as CacheSyncStatus : null;
  }

  async setSyncStatus(status: CacheSyncStatus): Promise<void> {
    await this.withWriterClient((client) => client.query(
      `INSERT INTO cache_meta (key, value) VALUES ('sync_status', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(status)]
    ));
  }

  async tryAcquireSyncLock(_lockKey: string): Promise<boolean> {
    return this.enqueueWriterTask(async () => {
      const lockKey = CACHE_WRITER_LOCK_KEY;
      const existingLease = this.syncLockClients.get(lockKey);
      if (existingLease) {
        try {
          await this.assertWriterLeaseHeld(existingLease);
          return true;
        } catch {
          // A stale local lease was invalidated; try to acquire a new session below.
        }
      }
      const client = await this.pool.connect();
      try {
        const result = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
          [lockKey]
        );
        if (result.rows[0]?.acquired !== true) {
          client.release();
          return false;
        }
        const lease: SyncLockLease = { client, invalidate: () => undefined };
        let invalidated = false;
        lease.invalidate = () => {
          if (invalidated) return;
          invalidated = true;
          if (this.syncLockClients.get(lockKey) === lease) {
            this.syncLockClients.delete(lockKey);
          }
          lease.client.removeListener('error', lease.invalidate);
          lease.client.removeListener('end', lease.invalidate);
          try { lease.client.release(true); } catch { /* already removed by the pool */ }
        };
        client.once('error', lease.invalidate);
        client.once('end', lease.invalidate);
        this.syncLockClients.set(lockKey, lease);
        return true;
      } catch (error) {
        try { client.release(true); } catch { /* already removed by the pool */ }
        throw error;
      }
    });
  }

  async releaseSyncLock(_lockKey: string): Promise<void> {
    await this.enqueueWriterTask(async () => {
      const lockKey = CACHE_WRITER_LOCK_KEY;
      const lease = this.syncLockClients.get(lockKey);
      if (!lease) return;
      this.syncLockClients.delete(lockKey);
      lease.client.removeListener('error', lease.invalidate);
      lease.client.removeListener('end', lease.invalidate);
      try {
        await lease.client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
        lease.client.release();
      } catch (error) {
        try { lease.client.release(true); } catch { /* already removed by the pool */ }
        throw error;
      }
    });
  }

  async getDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM documents`);
  }

  async getItemDocumentCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM item_documents`);
  }

  async getDocumentNonItemLineCount(): Promise<number> {
    return this.count(`SELECT COUNT(*) as count FROM document_non_item_lines`);
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
    await this.writerQueue;
    for (const lockKey of [...this.syncLockClients.keys()]) {
      await this.releaseSyncLock(lockKey);
    }
    await this.pool.end();
  }

  isOpen(): boolean {
    return this.opened;
  }

  async truncateAll(): Promise<void> {
    await this.withWriterClient(async (client) => {
      const relationResult = await client.query<Record<string, boolean>>(
        `SELECT ${ALL_CACHE_TABLES.map((table, index) => (
          `to_regclass($${index + 1}) IS NOT NULL AS "${table}"`
        )).join(', ')}`,
        [...ALL_CACHE_TABLES]
      );
      const relations = relationResult.rows[0] ?? {};
      const existing = ALL_CACHE_TABLES.filter((table) => relations[table]);
      if (existing.length === 0) return;
      await client.query(
        `TRUNCATE TABLE ${existing.join(', ')} RESTART IDENTITY CASCADE`
      );
    });
  }

  private async withWriterClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.enqueueWriterTask(async () => {
      const lease = this.requireWriterLease();
      await this.assertWriterLeaseHeld(lease);
      try {
        return await run(lease.client);
      } catch (error) {
        if (this.syncLockClients.get(CACHE_WRITER_LOCK_KEY) === lease) {
          try { await this.assertWriterLeaseHeld(lease); } catch { /* preserve the mutation failure */ }
        }
        throw error;
      }
    });
  }

  private async enqueueWriterTask<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.writerQueue.then(run, run);
    this.writerQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private requireWriterLease(): SyncLockLease {
    const lease = this.syncLockClients.get(CACHE_WRITER_LOCK_KEY);
    if (!lease) {
      throw new Error('PostgreSQL cache mutation requires the global cache writer lock.');
    }
    return lease;
  }

  private async assertWriterLeaseHeld(lease: SyncLockLease): Promise<void> {
    try {
      const result = await lease.client.query<{ held: boolean }>(`
        SELECT EXISTS (
          SELECT 1
            FROM pg_locks
           WHERE locktype = 'advisory'
             AND pid = pg_backend_pid()
             AND mode = 'ExclusiveLock'
             AND granted
             AND objsubid = 1
             AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295::bigint)
             AND objid::bigint = (hashtext($1)::bigint & 4294967295::bigint)
        ) AS held
      `, [CACHE_WRITER_LOCK_KEY]);
      if (result.rows[0]?.held === true) return;
    } catch {
      // The lease is invalidated below so no later operation can reuse it.
    }
    lease.invalidate();
    throw new Error('PostgreSQL cache writer lease was lost before mutation.');
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
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    return `${this.insertSql(table, columns)} ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`;
  }

  private valuesFor(columns: readonly string[], row: Record<string, unknown>): unknown[] {
    return columns.map((column) => row[column] ?? null);
  }

  private async batch<T>(client: PoolClient, rows: T[], run: (row: T) => Promise<unknown>): Promise<void> {
    if (rows.length === 0) return;
    try {
      await client.query('BEGIN');
      for (const row of rows) await run(row);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the batch failure */ }
      throw error;
    }
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
      snapshot_version: doc.snapshot_version ?? 0,
      snapshot_complete: doc.snapshot_complete ?? 0,
      is_cancelled: doc.is_cancelled ?? 0,
    };
  }

  private async normalizeDocumentForWrite(client: PoolClient, doc: DocumentRow): Promise<Record<string, unknown>> {
    let existing: { doc_id: string } | undefined;
    if (doc.api_doc_id) {
      existing = (await client.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE api_doc_id = $1`,
        [doc.api_doc_id]
      )).rows[0];
    }
    if (!existing) {
      existing = (await client.query<{ doc_id: string }>(
        `SELECT doc_id FROM documents WHERE context_id = $1 AND doc_number = $2`,
        [doc.context_id, doc.doc_number]
      )).rows[0];
    }
    return this.normalizeDocument(existing ? { ...doc, doc_id: existing.doc_id } : doc);
  }

  private normalizeItemDocument(item: Omit<ItemDocumentRow, 'id'>): Record<string, unknown> {
    return { ...item, quantity: item.quantity ?? 0, price: item.price ?? 0 };
  }

  private normalizeDocumentNonItemLine(
    line: Omit<DocumentNonItemLineRow, 'id'>
  ): Record<string, unknown> {
    return {
      ...line,
      line_type: 'non_item',
      quantity: line.quantity ?? 0,
      price: line.price ?? 0,
      total_amount: line.total_amount ?? 0,
      net_amount: line.net_amount ?? 0,
    };
  }

  private validateDocumentSnapshot(snapshot: DocumentSnapshot): void {
    if (!snapshot.document.doc_id || !Number.isFinite(snapshot.sourceFetchedAt)) {
      throw new Error('Invalid document snapshot identity or source timestamp');
    }
    const sourceIds = new Set<string>();
    for (const line of [...snapshot.itemLines, ...snapshot.nonItemLines]) {
      const sourceId = line.document_item_id?.trim();
      if (!sourceId) throw new Error(`Document ${snapshot.document.doc_id} contains a line without source id`);
      if (sourceIds.has(sourceId)) {
        throw new Error(`Document ${snapshot.document.doc_id} contains duplicate source line ${sourceId}`);
      }
      sourceIds.add(sourceId);
    }
  }

  private normalizeAccount(account: AccountRow): Record<string, unknown> {
    return { ...account, archived: account.archived ?? 0, cache_source: account.cache_source ?? 'api' };
  }

  private normalizeItem(item: ItemRow): Record<string, unknown> {
    return { ...item, cache_source: item.cache_source ?? 'api' };
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

  private coerceItemDocument(row: ItemDocumentRow): ItemDocumentRow {
    return {
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      quantity_received: row.quantity_received == null ? null : Number(row.quantity_received),
      cost: row.cost == null ? null : Number(row.cost),
      total_amount: row.total_amount == null ? null : Number(row.total_amount),
      discounted_price: row.discounted_price == null ? null : Number(row.discounted_price),
      discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
      quantity_shipped: row.quantity_shipped == null ? null : Number(row.quantity_shipped),
    };
  }

  private coerceDocumentForMirror(row: DocumentRow): DocumentRow {
    const shipmentCheckedAt = row.shipment_checked_at as unknown;
    return {
      ...row,
      total_price: row.total_price == null ? null : Number(row.total_price),
      total_cost: row.total_cost == null ? null : Number(row.total_cost),
      subtotal: row.subtotal == null ? null : Number(row.subtotal),
      shipped_percent: row.shipped_percent == null ? null : Number(row.shipped_percent),
      source_fetched_at: row.source_fetched_at == null ? null : Number(row.source_fetched_at),
      snapshot_version: row.snapshot_version == null ? 0 : Number(row.snapshot_version),
      snapshot_complete: row.snapshot_complete == null ? 0 : Number(row.snapshot_complete),
      shipment_checked_at: shipmentCheckedAt instanceof Date
        ? shipmentCheckedAt.toISOString()
        : shipmentCheckedAt == null ? null : String(shipmentCheckedAt),
    };
  }

  private coerceDocumentNonItemLine(row: DocumentNonItemLineRow): DocumentNonItemLineRow {
    return {
      ...row,
      quantity: Number(row.quantity),
      price: Number(row.price),
      cost: row.cost == null ? null : Number(row.cost),
      total_amount: Number(row.total_amount),
      discounted_price: row.discounted_price == null ? null : Number(row.discounted_price),
      discount_percent: row.discount_percent == null ? null : Number(row.discount_percent),
      net_amount: Number(row.net_amount),
      tax: row.tax == null ? null : Number(row.tax),
      tax2: row.tax2 == null ? null : Number(row.tax2),
      weight: row.weight == null ? null : Number(row.weight),
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
}

function isShipmentNewer(value: unknown, sourceFetchedAt: number): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(timestamp) && timestamp > sourceFetchedAt * 1000;
}

function authoritativeShipmentValue<T>(incoming: T | null | undefined, existing: T | null | undefined): T | null {
  return incoming === undefined ? existing ?? null : incoming;
}

export function withCacheWriterApplicationName(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('application_name', CACHE_WRITER_APPLICATION_NAME);
  return url.toString();
}

function withoutGeneratedId<T extends { id?: number }>(row: T): Omit<T, 'id'> {
  const { id, ...rest } = row;
  void id;
  return rest;
}
