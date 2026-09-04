import type { PoolClient } from 'pg';
import type {
  CacheState,
  InventoryBaselineFailure,
  InventoryBaselinePromotion,
  InventoryBaselinePromotionResult,
  InventoryBaselineRun,
  InventoryChangeFeedBinding,
  InventoryChangeFeedState,
  InventoryChangeFeedStateUpdate,
  InventoryEventReceipt,
  InventoryEventReceiptInput,
  InventoryEventSequence,
  InventoryCacheMeta,
  InventoryItemBundleApplication,
  InventoryReceiptApplicationResult,
  InventoryStagedItemBundle,
  InventoryStagingFailure,
  InventoryStagingProgress,
  InventoryTombstoneApplication,
  InventoryVerifiedBaselineProof,
  InventorySnapshot,
  ItemRow,
  ItemStockLocationRow,
} from './types.js';
import {
  CACHE_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_META_KEY,
  InventoryBaselineProofError,
  createInventoryBaselineRootFingerprint,
  createInventoryEventReceiptId,
  createInventoryItemBundleFingerprint,
  createInventorySnapshotFingerprint,
  isInventoryEventSequence,
  parseInventoryCacheMeta,
} from './types.js';
import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import { assertCanonicalV3SourceId } from './v3-inventory-source-validation.js';

type TransactionRunner = <T>(
  run: (client: PoolClient) => Promise<T>,
  operationSignal?: AbortSignal
) => Promise<T>;

export interface PostgresInventoryChangeFeedStoreOptions {
  withVerifiedWrite: TransactionRunner;
  withReadOnlyTransaction: TransactionRunner;
  assertItemBundle: (item: ItemRow, stockRows: ItemStockLocationRow[]) => void;
  assertInventorySnapshot: (snapshot: InventorySnapshot) => void;
}

const ITEM_COLUMNS = [
  'item_id',
  'item_number',
  'name',
  'description',
  'sku',
  'serial_number',
  'barcode',
  'category_id',
  'category_name',
  'quantity',
  'quantity_reserved',
  'quantity_available',
  'quantity_incoming',
  'in_transit',
  'threshold',
  'cost',
  'price',
  'valuation',
  'published',
  'archived',
  'created',
  'modified',
  'cache_source',
  'imported_at',
  'source_api_version',
] as const;

const STOCK_COLUMNS = [
  'stock_row_id',
  'item_id',
  'item_number',
  'variation_id',
  'variation_location_id',
  'location_id',
  'location_name',
  'category_name',
  'quantity_on_hand',
  'quantity_reserved',
  'quantity_available',
  'quantity_incoming',
  'in_transit',
  'price',
  'cost',
  'valuation',
  'barcode',
  'cache_source',
  'imported_at',
  'source_api_version',
] as const;

const EVENT_TYPES = new Set([
  'inventory.item_created',
  'inventory.item_updated',
  'inventory.low_stock',
  'inventory.item_deleted',
]);

export class PostgresInventoryChangeFeedStore implements InventoryChangeFeedCache {
  constructor(private readonly options: PostgresInventoryChangeFeedStoreOptions) {}

  async ensureSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_change_feed_state (
        account_identity TEXT NOT NULL REFERENCES cache_account_binding(account_identity),
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        baseline_generation TEXT NULL,
        observed_through_event_seq BIGINT NULL,
        applied_through_event_seq BIGINT NULL,
        highest_applied_event_seq BIGINT NULL,
        blocked_by_event_seq BIGINT NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT inventory_change_feed_state_pkey
          PRIMARY KEY (ledger_database_id, consumer_name),
        CONSTRAINT inventory_change_feed_state_identity_unique
          UNIQUE (account_identity, ledger_database_id, consumer_name),
        CONSTRAINT inventory_change_feed_state_account_consumer_unique
          UNIQUE (account_identity, consumer_name),
        CONSTRAINT inventory_change_feed_state_consumer_check
          CHECK (consumer_name <> '' AND length(consumer_name) <= 128),
        CONSTRAINT inventory_change_feed_state_baseline_check
          CHECK (baseline_generation IS NULL OR baseline_generation <> ''),
        CONSTRAINT inventory_change_feed_state_cursors_check CHECK (
          (observed_through_event_seq IS NULL OR observed_through_event_seq >= 0) AND
          (applied_through_event_seq IS NULL OR applied_through_event_seq >= 0) AND
          (highest_applied_event_seq IS NULL OR highest_applied_event_seq >= 0) AND
          (blocked_by_event_seq IS NULL OR blocked_by_event_seq > 0) AND
          (applied_through_event_seq IS NULL OR observed_through_event_seq IS NULL OR
            applied_through_event_seq <= observed_through_event_seq) AND
          (highest_applied_event_seq IS NULL OR observed_through_event_seq IS NULL OR
            highest_applied_event_seq <= observed_through_event_seq) AND
          (applied_through_event_seq IS NULL OR highest_applied_event_seq IS NULL OR
            applied_through_event_seq <= highest_applied_event_seq)
        ),
        CONSTRAINT inventory_change_feed_state_updated_at_check CHECK (updated_at >= 0)
      );

      CREATE TABLE IF NOT EXISTS inventory_event_receipts (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        event_seq BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        applied_action TEXT NOT NULL,
        hydration_outcome TEXT NOT NULL,
        materialization_outcome TEXT NOT NULL,
        cache_generation TEXT NOT NULL,
        source_fingerprint TEXT NULL,
        committed_at BIGINT NOT NULL,
        CONSTRAINT inventory_event_receipts_pkey
          PRIMARY KEY (ledger_database_id, consumer_name, event_seq),
        CONSTRAINT inventory_event_receipts_receipt_id_unique UNIQUE (receipt_id),
        CONSTRAINT inventory_event_receipts_receipt_id_check CHECK (
          receipt_id ~ '^sha256:[0-9a-f]{64}$'
        ),
        CONSTRAINT inventory_event_receipts_feed_fkey
          FOREIGN KEY (account_identity, ledger_database_id, consumer_name)
          REFERENCES inventory_change_feed_state(account_identity, ledger_database_id, consumer_name),
        CONSTRAINT inventory_event_receipts_event_seq_check CHECK (event_seq > 0),
        CONSTRAINT inventory_event_receipts_event_type_check CHECK (event_type IN (
          'inventory.item_created', 'inventory.item_updated',
          'inventory.low_stock', 'inventory.item_deleted'
        )),
        CONSTRAINT inventory_event_receipts_object_check CHECK (
          object_id <> '' AND object_id = btrim(object_id) AND length(object_id) <= 256 AND
          object_id !~ '[[:cntrl:]]'
        ),
        CONSTRAINT inventory_event_receipts_action_check CHECK (
          applied_action IN ('upsert', 'tombstone', 'fenced_noop')
        ),
        CONSTRAINT inventory_event_receipts_hydration_outcome_check CHECK (
          hydration_outcome IN ('found_current', 'found_archived', 'expected_tombstone')
        ),
        CONSTRAINT inventory_event_receipts_materialization_outcome_check CHECK (
          materialization_outcome IN ('upserted', 'tombstoned', 'superseded')
        ),
        CONSTRAINT inventory_event_receipts_result_check CHECK (
          (applied_action = 'upsert' AND hydration_outcome IN ('found_current', 'found_archived')
            AND materialization_outcome = 'upserted'
            AND source_fingerprint IS NOT NULL) OR
          (applied_action = 'tombstone' AND hydration_outcome = 'expected_tombstone'
            AND materialization_outcome = 'tombstoned'
            AND source_fingerprint IS NULL) OR
          (applied_action = 'fenced_noop' AND materialization_outcome = 'superseded'
            AND source_fingerprint IS NULL)
        ),
        CONSTRAINT inventory_event_receipts_generation_check CHECK (cache_generation <> ''),
        CONSTRAINT inventory_event_receipts_committed_at_check CHECK (committed_at >= 0)
      );

      CREATE TABLE IF NOT EXISTS inventory_baseline_runs (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        run_id UUID NOT NULL,
        generation TEXT NOT NULL,
        start_event_seq BIGINT NOT NULL,
        root_fingerprint TEXT NOT NULL,
        expected_item_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        promoted_at BIGINT NULL,
        failure_code TEXT NULL,
        promoted_meta JSONB NULL,
        CONSTRAINT inventory_baseline_runs_pkey
          PRIMARY KEY (account_identity, ledger_database_id, consumer_name, run_id),
        CONSTRAINT inventory_baseline_runs_feed_fkey
          FOREIGN KEY (account_identity, ledger_database_id, consumer_name)
          REFERENCES inventory_change_feed_state(account_identity, ledger_database_id, consumer_name),
        CONSTRAINT inventory_baseline_runs_generation_unique
          UNIQUE (account_identity, ledger_database_id, consumer_name, generation),
        CONSTRAINT inventory_baseline_runs_values_check CHECK (
          generation <> '' AND start_event_seq >= 0 AND root_fingerprint <> '' AND
          expected_item_count >= 0 AND status IN ('active', 'promoted', 'failed') AND
          started_at >= 0 AND updated_at >= started_at AND
          (promoted_at IS NULL OR promoted_at >= started_at) AND
          (failure_code IS NULL OR failure_code <> '') AND
          ((status = 'failed' AND failure_code IS NOT NULL) OR
            (status <> 'failed' AND failure_code IS NULL)) AND
          ((status = 'promoted' AND promoted_at IS NOT NULL AND
              jsonb_typeof(promoted_meta) = 'object') OR
            (status <> 'promoted' AND promoted_at IS NULL AND promoted_meta IS NULL))
        )
      );

      CREATE TABLE IF NOT EXISTS inventory_baseline_root_items (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        run_id UUID NOT NULL,
        root_position INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        CONSTRAINT inventory_baseline_root_items_pkey PRIMARY KEY (
          account_identity, ledger_database_id, consumer_name, run_id, item_id
        ),
        CONSTRAINT inventory_baseline_root_items_position_unique UNIQUE (
          account_identity, ledger_database_id, consumer_name, run_id, root_position
        ),
        CONSTRAINT inventory_baseline_root_items_run_fkey FOREIGN KEY (
          account_identity, ledger_database_id, consumer_name, run_id
        ) REFERENCES inventory_baseline_runs(
          account_identity, ledger_database_id, consumer_name, run_id
        ) ON DELETE CASCADE,
        CONSTRAINT inventory_baseline_root_items_values_check CHECK (
          root_position >= 0 AND item_id <> '' AND item_id = btrim(item_id) AND
          length(item_id) <= 256 AND item_id !~ '[[:cntrl:]]'
        )
      );

      CREATE TABLE IF NOT EXISTS inventory_staging_items (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        run_id UUID NOT NULL,
        item_id TEXT NOT NULL,
        item_payload JSONB NOT NULL,
        staged_at BIGINT NOT NULL,
        CONSTRAINT inventory_staging_items_pkey PRIMARY KEY (
          account_identity, ledger_database_id, consumer_name, run_id, item_id
        ),
        CONSTRAINT inventory_staging_items_run_fkey FOREIGN KEY (
          account_identity, ledger_database_id, consumer_name, run_id
        ) REFERENCES inventory_baseline_runs(
          account_identity, ledger_database_id, consumer_name, run_id
        ) ON DELETE CASCADE,
        CONSTRAINT inventory_staging_items_values_check CHECK (
          item_id <> '' AND item_id = btrim(item_id) AND length(item_id) <= 256 AND
          jsonb_typeof(item_payload) = 'object' AND
          item_payload ?& ARRAY['item_id', 'cache_source', 'source_api_version'] AND
          item_payload->>'item_id' = item_id AND item_payload->>'cache_source' = 'api' AND
          item_payload->>'source_api_version' = '3' AND staged_at >= 0
        )
      );

      CREATE TABLE IF NOT EXISTS inventory_staging_stock_locations (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        run_id UUID NOT NULL,
        stock_row_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        stock_payload JSONB NOT NULL,
        staged_at BIGINT NOT NULL,
        CONSTRAINT inventory_staging_stock_locations_pkey PRIMARY KEY (
          account_identity, ledger_database_id, consumer_name, run_id, stock_row_id
        ),
        CONSTRAINT inventory_staging_stock_locations_item_fkey FOREIGN KEY (
          account_identity, ledger_database_id, consumer_name, run_id, item_id
        ) REFERENCES inventory_staging_items(
          account_identity, ledger_database_id, consumer_name, run_id, item_id
        ) ON DELETE CASCADE,
        CONSTRAINT inventory_staging_stock_locations_values_check CHECK (
          stock_row_id <> '' AND item_id <> '' AND
          jsonb_typeof(stock_payload) = 'object' AND
          stock_payload ?& ARRAY['stock_row_id', 'item_id', 'cache_source', 'source_api_version'] AND
          stock_payload->>'stock_row_id' = stock_row_id AND
          stock_payload->>'item_id' = item_id AND stock_payload->>'cache_source' = 'api' AND
          stock_payload->>'source_api_version' = '3' AND staged_at >= 0
        )
      );

      CREATE TABLE IF NOT EXISTS inventory_staging_progress (
        account_identity TEXT NOT NULL,
        ledger_database_id UUID NOT NULL,
        consumer_name TEXT NOT NULL,
        run_id UUID NOT NULL,
        item_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT inventory_staging_progress_pkey PRIMARY KEY (
          account_identity, ledger_database_id, consumer_name, run_id, item_id
        ),
        CONSTRAINT inventory_staging_progress_run_fkey FOREIGN KEY (
          account_identity, ledger_database_id, consumer_name, run_id
        ) REFERENCES inventory_baseline_runs(
          account_identity, ledger_database_id, consumer_name, run_id
        ) ON DELETE CASCADE,
        CONSTRAINT inventory_staging_progress_values_check CHECK (
          item_id <> '' AND status IN ('staged', 'failed') AND attempt_count > 0 AND
          updated_at >= 0 AND
          ((status = 'staged' AND error_code IS NULL AND error_message IS NULL) OR
           (status = 'failed' AND error_code IS NOT NULL AND error_code <> ''
             AND length(error_code) <= 128 AND error_message IS NOT NULL
             AND error_message <> '' AND length(error_message) <= 512))
        )
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_event_receipts_object_seq
        ON inventory_event_receipts(account_identity, consumer_name, object_id, event_seq DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_change_feed_state_account_consumer
        ON inventory_change_feed_state(account_identity, consumer_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_baseline_runs_active
        ON inventory_baseline_runs(ledger_database_id, consumer_name)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_inventory_baseline_root_items_run_position
        ON inventory_baseline_root_items(
          account_identity, ledger_database_id, consumer_name, run_id, root_position
        );
      CREATE INDEX IF NOT EXISTS idx_inventory_staging_items_run
        ON inventory_staging_items(account_identity, ledger_database_id, consumer_name, run_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_staging_progress_run_status
        ON inventory_staging_progress(
          account_identity, ledger_database_id, consumer_name, run_id, status
        );

      CREATE OR REPLACE FUNCTION reject_inventory_event_receipt_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $receipt_immutable$
      BEGIN
        RAISE EXCEPTION 'inventory event receipts are immutable';
      END
      $receipt_immutable$;
      DROP TRIGGER IF EXISTS inventory_event_receipts_immutable
        ON inventory_event_receipts;
      CREATE TRIGGER inventory_event_receipts_immutable
        BEFORE UPDATE OR DELETE ON inventory_event_receipts
        FOR EACH ROW EXECUTE FUNCTION reject_inventory_event_receipt_mutation();
    `);
  }

  async ensureInventoryChangeFeedState(
    binding: InventoryChangeFeedBinding,
    updatedAt = nowSeconds()
  ): Promise<InventoryChangeFeedState> {
    assertBinding(binding);
    assertTimestamp(updatedAt, 'updatedAt');
    await this.options.withVerifiedWrite(async (client) => {
      await this.insertFeedState(client, binding, updatedAt);
    });
    return this.requireState(binding);
  }

  async getInventoryChangeFeedState(
    binding: InventoryChangeFeedBinding
  ): Promise<InventoryChangeFeedState | null> {
    assertBinding(binding);
    return this.options.withReadOnlyTransaction(async (client) => {
      const result = await client.query<FeedStateRow>(
        feedStateSelect(false),
        bindingValues(binding)
      );
      return result.rows[0] ? mapFeedState(result.rows[0]) : null;
    });
  }

  async getInventoryChangeFeedStateByConsumer(
    accountIdentity: string,
    consumerName: string
  ): Promise<InventoryChangeFeedState | null> {
    assertNonEmptyText(accountIdentity, 'accountIdentity');
    assertConsumerName(consumerName);
    return this.options.withReadOnlyTransaction(async (client) => {
      const result = await client.query<FeedStateRow>(
        `SELECT account_identity, ledger_database_id::TEXT, consumer_name,
                baseline_generation, observed_through_event_seq::TEXT,
                applied_through_event_seq::TEXT, highest_applied_event_seq::TEXT,
                blocked_by_event_seq::TEXT, updated_at
         FROM inventory_change_feed_state
         WHERE account_identity=$1 AND consumer_name=$2`,
        [accountIdentity, consumerName]
      );
      if (result.rows.length > 1) {
        throw new Error('Inventory change-feed consumer binding is ambiguous.');
      }
      return result.rows[0] ? mapFeedState(result.rows[0]) : null;
    });
  }

  async getVerifiedInventoryBaselineProofByConsumer(
    accountIdentity: string,
    consumerName: string
  ): Promise<InventoryVerifiedBaselineProof | null> {
    assertNonEmptyText(accountIdentity, 'accountIdentity');
    assertConsumerName(consumerName);
    return this.options.withReadOnlyTransaction(async (client) => {
      const result = await client.query<VerifiedBaselineProofRow>(
        `SELECT feed.account_identity, feed.ledger_database_id::TEXT, feed.consumer_name,
                feed.baseline_generation, baseline.status AS baseline_status,
                baseline.promoted_meta
         FROM inventory_change_feed_state AS feed
         LEFT JOIN inventory_baseline_runs AS baseline
           ON baseline.account_identity=feed.account_identity
          AND baseline.ledger_database_id=feed.ledger_database_id
          AND baseline.consumer_name=feed.consumer_name
          AND baseline.generation=feed.baseline_generation
          AND baseline.status='promoted'
         WHERE feed.account_identity=$1 AND feed.consumer_name=$2`,
        [accountIdentity, consumerName]
      );
      if (result.rows.length > 1) {
        throw new Error('Verified inventory baseline proof is ambiguous.');
      }
      const row = result.rows[0];
      if (!row?.baseline_generation) return null;
      if (row.baseline_status !== 'promoted') {
        throw new InventoryBaselineProofError('missing_promoted_run');
      }
      let meta: InventoryCacheMeta | null = null;
      try {
        const value = row.promoted_meta;
        meta = parseInventoryCacheMeta(typeof value === 'string' ? JSON.parse(value) : value);
      } catch {
        meta = null;
      }
      if (
        !meta ||
        meta.version !== 2 ||
        meta.status !== 'complete' ||
        meta.warningCount !== 0 ||
        meta.omittedItemCount !== 0 ||
        meta.preservedItemCount !== 0 ||
        meta.lastCompleteAt !== meta.completedAt ||
        meta.accountIdentity !== row.account_identity ||
        meta.generation !== row.baseline_generation ||
        meta.schemaVersion !== CACHE_SCHEMA_VERSION
      ) {
        throw new InventoryBaselineProofError('invalid_promoted_meta');
      }
      return {
        accountIdentity: row.account_identity,
        ledgerDatabaseId: row.ledger_database_id,
        consumerName: row.consumer_name,
        baselineGeneration: row.baseline_generation,
        meta,
      };
    });
  }

  async updateInventoryChangeFeedState(
    update: InventoryChangeFeedStateUpdate
  ): Promise<InventoryChangeFeedState> {
    assertBinding(update);
    assertTimestamp(update.updatedAt, 'updatedAt');
    assertOptionalSequence(update.observedThroughEventSeq, 'observedThroughEventSeq');
    assertOptionalSequence(update.appliedThroughEventSeq, 'appliedThroughEventSeq');
    assertOptionalSequence(update.highestAppliedEventSeq, 'highestAppliedEventSeq');
    assertOptionalSequence(update.blockedByEventSeq, 'blockedByEventSeq');
    if (update.baselineGeneration !== undefined && update.baselineGeneration !== null) {
      assertNonEmptyText(update.baselineGeneration, 'baselineGeneration');
    }

    await this.options.withVerifiedWrite(async (client) => {
      await this.insertFeedState(client, update, update.updatedAt);
      const currentResult = await client.query<FeedStateRow>(
        feedStateSelect(true),
        bindingValues(update)
      );
      const current = mapFeedState(currentResult.rows[0]);
      const next: InventoryChangeFeedState = {
        ...current,
        baselineGeneration: unchangedBaselineGeneration(
          current.baselineGeneration,
          update.baselineGeneration
        ),
        observedThroughEventSeq: monotonicCursor(
          current.observedThroughEventSeq,
          update.observedThroughEventSeq,
          'observedThroughEventSeq'
        ),
        appliedThroughEventSeq: monotonicCursor(
          current.appliedThroughEventSeq,
          update.appliedThroughEventSeq,
          'appliedThroughEventSeq'
        ),
        highestAppliedEventSeq: monotonicCursor(
          current.highestAppliedEventSeq,
          update.highestAppliedEventSeq,
          'highestAppliedEventSeq'
        ),
        blockedByEventSeq: pick(update.blockedByEventSeq, current.blockedByEventSeq),
        updatedAt: Math.max(current.updatedAt, update.updatedAt),
      };
      assertCursorRelations(next);
      await client.query(
        `UPDATE inventory_change_feed_state
         SET baseline_generation = $4, observed_through_event_seq = $5,
             applied_through_event_seq = $6, highest_applied_event_seq = $7,
             blocked_by_event_seq = $8, updated_at = $9
         WHERE account_identity = $1 AND ledger_database_id = $2 AND consumer_name = $3`,
        [
          ...bindingValues(update),
          next.baselineGeneration,
          next.observedThroughEventSeq,
          next.appliedThroughEventSeq,
          next.highestAppliedEventSeq,
          next.blockedByEventSeq,
          next.updatedAt,
        ]
      );
    }, update.operationSignal);
    return this.requireState(update);
  }

  async getInventoryEventReceipt(
    binding: InventoryChangeFeedBinding,
    eventSeq: InventoryEventSequence
  ): Promise<InventoryEventReceipt | null> {
    const receipts = await this.getInventoryEventReceipts(binding, [eventSeq]);
    return receipts[0] ?? null;
  }

  async getInventoryEventReceipts(
    binding: InventoryChangeFeedBinding,
    eventSeqs: InventoryEventSequence[]
  ): Promise<InventoryEventReceipt[]> {
    assertBinding(binding);
    const sequences = normalizeSequences(eventSeqs, true);
    if (sequences.length === 0) return [];
    return this.options.withReadOnlyTransaction((client) =>
      this.readReceipts(client, binding, sequences, false)
    );
  }

  async applyInventoryItemBundle(
    application: InventoryItemBundleApplication
  ): Promise<InventoryReceiptApplicationResult> {
    this.assertBundleApplication(application);
    return this.applyEvents(application, 'upsert', application.hydrationOutcome, async (client) => {
      await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [
        application.item.item_id,
      ]);
      await client.query(
        upsertSql('items', ITEM_COLUMNS, 'item_id'),
        valuesFor(ITEM_COLUMNS, application.item)
      );
      for (const row of application.stockRows) {
        await client.query(
          upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
          valuesFor(STOCK_COLUMNS, row)
        );
      }
    });
  }

  async applyInventoryTombstone(
    application: InventoryTombstoneApplication
  ): Promise<InventoryReceiptApplicationResult> {
    this.assertTombstoneApplication(application);
    return this.applyEvents(application, 'tombstone', 'expected_tombstone', async (client) => {
      await client.query(`DELETE FROM item_stock_locations WHERE item_id = $1`, [
        application.objectId,
      ]);
      await client.query(`DELETE FROM items WHERE item_id = $1`, [application.objectId]);
    });
  }

  async beginInventoryBaselineRun(run: InventoryBaselineRun): Promise<InventoryBaselineRun> {
    assertBaselineRun(run);
    await this.options.withVerifiedWrite(async (client) => {
      await this.insertFeedState(client, run, run.updatedAt);
      const inserted = await client.query<{ run_id: string }>(
        `INSERT INTO inventory_baseline_runs (
           account_identity, ledger_database_id, consumer_name, run_id, generation,
           start_event_seq, root_fingerprint, expected_item_count, status,
           started_at, updated_at, promoted_at, failure_code, promoted_meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::JSONB)
         ON CONFLICT (account_identity, ledger_database_id, consumer_name, run_id) DO NOTHING
         RETURNING run_id::TEXT`,
        [
          ...bindingValues(run),
          run.runId,
          run.generation,
          run.startEventSeq,
          run.rootFingerprint,
          run.expectedItemCount,
          run.status,
          run.startedAt,
          run.updatedAt,
          run.promotedAt,
          run.failureCode,
          null,
        ]
      );
      if (inserted.rows.length === 1) {
        for (const [position, itemId] of run.rootItemIds.entries()) {
          await client.query(
            `INSERT INTO inventory_baseline_root_items (
               account_identity, ledger_database_id, consumer_name, run_id, root_position, item_id
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [...bindingValues(run), run.runId, position, itemId]
          );
        }
      }
      const persisted = await this.readBaselineRun(client, run, run.runId, true);
      if (!persisted || !sameBaselineIdentity(persisted, run)) {
        throw new Error('Inventory baseline run conflicts with persisted recovery state.');
      }
    });
    const persisted = await this.getInventoryBaselineRun(run, run.runId);
    if (!persisted) throw new Error('Inventory baseline run was not durably stored.');
    return persisted;
  }

  async getInventoryBaselineRun(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryBaselineRun | null> {
    assertBinding(binding);
    assertUuid(runId, 'runId');
    return this.options.withReadOnlyTransaction((client) =>
      this.readBaselineRun(client, binding, runId, false)
    );
  }

  async stageInventoryBaselineItem(bundle: InventoryStagedItemBundle): Promise<void> {
    assertBinding(bundle);
    assertUuid(bundle.runId, 'runId');
    assertTimestamp(bundle.stagedAt, 'stagedAt');
    this.options.assertItemBundle(bundle.item, bundle.stockRows);
    await this.options.withVerifiedWrite(async (client) => {
      const run = await this.requireActiveRun(client, bundle, bundle.runId);
      if (!run.rootItemIds.includes(bundle.item.item_id)) {
        throw new Error('Inventory staged item is not present in the accepted root manifest.');
      }
      const progress = await client.query<{ status: string }>(
        `SELECT status FROM inventory_staging_progress
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
           AND run_id=$4 AND item_id=$5 FOR UPDATE`,
        [...bindingValues(bundle), bundle.runId, bundle.item.item_id]
      );
      if (progress.rows[0]?.status === 'staged') return;
      await client.query(
        `DELETE FROM inventory_staging_items
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
           AND run_id=$4 AND item_id=$5`,
        [...bindingValues(bundle), bundle.runId, bundle.item.item_id]
      );
      await client.query(
        `INSERT INTO inventory_staging_items
           (account_identity, ledger_database_id, consumer_name, run_id, item_id, item_payload, staged_at)
         VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7)`,
        [
          ...bindingValues(bundle),
          bundle.runId,
          bundle.item.item_id,
          JSON.stringify(bundle.item),
          bundle.stagedAt,
        ]
      );
      for (const row of bundle.stockRows) {
        await client.query(
          `INSERT INTO inventory_staging_stock_locations
             (account_identity, ledger_database_id, consumer_name, run_id,
              stock_row_id, item_id, stock_payload, staged_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8)`,
          [
            ...bindingValues(bundle),
            bundle.runId,
            row.stock_row_id,
            row.item_id,
            JSON.stringify(row),
            bundle.stagedAt,
          ]
        );
      }
      await client.query(
        `INSERT INTO inventory_staging_progress
           (account_identity, ledger_database_id, consumer_name, run_id, item_id,
            status, attempt_count, error_code, error_message, updated_at)
         VALUES ($1,$2,$3,$4,$5,'staged',1,NULL,NULL,$6)
         ON CONFLICT (account_identity, ledger_database_id, consumer_name, run_id, item_id)
         DO UPDATE SET status='staged', attempt_count=inventory_staging_progress.attempt_count + 1,
           error_code=NULL, error_message=NULL, updated_at=EXCLUDED.updated_at`,
        [...bindingValues(bundle), bundle.runId, bundle.item.item_id, bundle.stagedAt]
      );
    });
  }

  async recordInventoryStagingFailure(failure: InventoryStagingFailure): Promise<void> {
    assertBinding(failure);
    assertUuid(failure.runId, 'runId');
    assertNonEmptyText(failure.itemId, 'itemId');
    assertPositiveInteger(failure.attemptCount, 'attemptCount');
    assertSafeMessage(failure.errorCode, 'errorCode', 128);
    assertSafeMessage(failure.errorMessage, 'errorMessage', 512);
    assertTimestamp(failure.updatedAt, 'updatedAt');
    await this.options.withVerifiedWrite(async (client) => {
      const run = await this.requireActiveRun(client, failure, failure.runId);
      if (!run.rootItemIds.includes(failure.itemId)) {
        throw new Error('Inventory failed item is not present in the accepted root manifest.');
      }
      await client.query(
        `INSERT INTO inventory_staging_progress
           (account_identity, ledger_database_id, consumer_name, run_id, item_id,
            status, attempt_count, error_code, error_message, updated_at)
         VALUES ($1,$2,$3,$4,$5,'failed',$6,$7,$8,$9)
         ON CONFLICT (account_identity, ledger_database_id, consumer_name, run_id, item_id)
         DO UPDATE SET status='failed',
           attempt_count=GREATEST(inventory_staging_progress.attempt_count, EXCLUDED.attempt_count),
           error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message,
           updated_at=GREATEST(inventory_staging_progress.updated_at, EXCLUDED.updated_at)
         WHERE inventory_staging_progress.status <> 'staged'`,
        [
          ...bindingValues(failure),
          failure.runId,
          failure.itemId,
          failure.attemptCount,
          failure.errorCode,
          failure.errorMessage,
          failure.updatedAt,
        ]
      );
    });
  }

  async getInventoryStagingProgress(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryStagingProgress | null> {
    assertBinding(binding);
    assertUuid(runId, 'runId');
    return this.options.withReadOnlyTransaction(async (client) => {
      const run = await this.readBaselineRun(client, binding, runId, false);
      if (!run) return null;
      const result = await client.query<StagingProgressRow>(
        `SELECT item_id, status, attempt_count, error_code, error_message, updated_at
         FROM inventory_staging_progress
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4
         ORDER BY item_id`,
        [...bindingValues(binding), runId]
      );
      const staged = result.rows.filter((row) => row.status === 'staged');
      const failed = result.rows.filter((row) => row.status === 'failed');
      const completedItemIds = staged.map((row) => row.item_id);
      const completed = new Set(completedItemIds);
      return {
        ...binding,
        runId,
        expectedItemCount: run.expectedItemCount,
        stagedItemCount: staged.length,
        failedItemCount: failed.length,
        completedItemIds,
        pendingItemIds: run.rootItemIds.filter((itemId) => !completed.has(itemId)),
        failures: failed.map((row) => ({
          itemId: row.item_id,
          attemptCount: Number(row.attempt_count),
          errorCode: row.error_code as string,
          errorMessage: row.error_message as string,
          updatedAt: Number(row.updated_at),
        })),
      };
    });
  }

  async promoteInventoryBaselineRun(
    promotion: InventoryBaselinePromotion
  ): Promise<InventoryBaselinePromotionResult> {
    assertBinding(promotion);
    assertUuid(promotion.runId, 'runId');
    assertTimestamp(promotion.promotedAt, 'promotedAt');
    return this.options.withVerifiedWrite(async (client) => {
      const run = await this.readBaselineRun(client, promotion, promotion.runId, true);
      if (!run) throw new Error('Inventory baseline run does not exist.');
      if (run.status === 'promoted') {
        return {
          run,
          meta: await this.readPromotedInventoryMeta(client, promotion, run.generation),
        };
      }
      if (run.status !== 'active') {
        throw new Error('Inventory baseline run is not active.');
      }
      if (promotion.promotedAt < run.startedAt) {
        throw new Error('Inventory baseline promotion cannot predate the accepted root manifest.');
      }
      const stateResult = await client.query<FeedStateRow>(
        feedStateSelect(true),
        bindingValues(promotion)
      );
      if (!stateResult.rows[0]) throw new Error('Inventory change-feed state does not exist.');
      const state = mapFeedState(stateResult.rows[0]);
      if (compareSequences(run.startEventSeq, state.highestAppliedEventSeq) < 0) {
        throw new Error('Inventory baseline start cursor is behind applied cache evidence.');
      }
      const progress = await client.query<{ staged_count: string; failed_count: string }>(
        `SELECT COUNT(*) FILTER (WHERE status='staged') AS staged_count,
                COUNT(*) FILTER (WHERE status='failed') AS failed_count
         FROM inventory_staging_progress
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4`,
        [...bindingValues(promotion), promotion.runId]
      );
      if (
        Number(progress.rows[0]?.staged_count) !== run.expectedItemCount ||
        Number(progress.rows[0]?.failed_count) !== 0
      ) {
        throw new Error('Inventory baseline cannot promote incomplete or failed staging.');
      }
      const itemsResult = await client.query<{ item_payload: ItemRow | string }>(
        `SELECT staged.item_payload
         FROM inventory_baseline_root_items AS root
         JOIN inventory_staging_items AS staged
           USING (account_identity, ledger_database_id, consumer_name, run_id, item_id)
         WHERE root.account_identity=$1 AND root.ledger_database_id=$2
           AND root.consumer_name=$3 AND root.run_id=$4
         ORDER BY root.root_position`,
        [...bindingValues(promotion), promotion.runId]
      );
      const stockResult = await client.query<{ stock_payload: ItemStockLocationRow | string }>(
        `SELECT stock_payload FROM inventory_staging_stock_locations
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4
         ORDER BY stock_row_id`,
        [...bindingValues(promotion), promotion.runId]
      );
      const items = itemsResult.rows.map((row) => parseJsonRow<ItemRow>(row.item_payload));
      const stockRows = stockResult.rows.map((row) =>
        parseJsonRow<ItemStockLocationRow>(row.stock_payload)
      );
      if (
        items.length !== run.expectedItemCount ||
        items.some((item, index) => item.item_id !== run.rootItemIds[index])
      ) {
        throw new Error('Inventory staged rows do not match the accepted root manifest.');
      }
      const snapshot: InventorySnapshot = {
        items,
        stockRows,
        meta: createPromotedInventoryMeta(run, promotion.promotedAt, items, stockRows),
      };
      this.options.assertInventorySnapshot(snapshot);
      await this.replaceLiveInventory(client, snapshot, promotion, run);
      const persisted = await this.readBaselineRun(client, promotion, promotion.runId, true);
      if (!persisted || persisted.status !== 'promoted') {
        throw new Error('Inventory baseline promotion receipt was not durably stored.');
      }
      return {
        run: persisted,
        meta: await this.readPromotedInventoryMeta(client, promotion, persisted.generation),
      };
    });
  }

  async failInventoryBaselineRun(failure: InventoryBaselineFailure): Promise<InventoryBaselineRun> {
    assertBinding(failure);
    assertUuid(failure.runId, 'runId');
    assertSafeMessage(failure.failureCode, 'failureCode', 128);
    assertTimestamp(failure.failedAt, 'failedAt');
    await this.options.withVerifiedWrite(async (client) => {
      const run = await this.readBaselineRun(client, failure, failure.runId, true);
      if (!run) throw new Error('Inventory baseline run does not exist.');
      if (run.status === 'promoted') {
        throw new Error('A promoted inventory baseline cannot be failed.');
      }
      if (run.status === 'failed') {
        if (run.failureCode !== failure.failureCode) {
          throw new Error('Inventory baseline failure conflicts with persisted recovery state.');
        }
        return;
      }
      await client.query(
        `UPDATE inventory_baseline_runs
         SET status='failed', failure_code=$5, updated_at=GREATEST(updated_at,$6)
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4`,
        [...bindingValues(failure), failure.runId, failure.failureCode, failure.failedAt]
      );
    });
    const persisted = await this.getInventoryBaselineRun(failure, failure.runId);
    if (!persisted || persisted.status !== 'failed') {
      throw new Error('Inventory baseline failure was not durably stored.');
    }
    return persisted;
  }

  async deleteInventoryBaselineRun(
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<void> {
    assertBinding(binding);
    assertUuid(runId, 'runId');
    await this.options.withVerifiedWrite(async (client) => {
      await client.query(
        `DELETE FROM inventory_baseline_runs
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
           AND run_id=$4 AND status <> 'promoted'`,
        [...bindingValues(binding), runId]
      );
    });
  }

  private async applyEvents(
    application: InventoryItemBundleApplication | InventoryTombstoneApplication,
    action: 'upsert' | 'tombstone',
    hydrationOutcome: 'found_current' | 'found_archived' | 'expected_tombstone',
    mutate: (client: PoolClient) => Promise<void>
  ): Promise<InventoryReceiptApplicationResult> {
    const sequences = normalizeSequences(
      application.events.map((event) => event.eventSeq),
      true
    );
    const objectId = 'item' in application ? application.item.item_id : application.objectId;
    const sourceFingerprint =
      'item' in application
        ? createInventoryItemBundleFingerprint(
            application.accountIdentity,
            application.item,
            application.stockRows
          )
        : null;
    const transactionResult = await this.options.withVerifiedWrite(async (client) => {
      const existing = await this.readReceipts(client, application, sequences, true);
      if (existing.length > 0 && existing.length !== sequences.length) {
        throw new Error('Inventory event receipt set is partial; refusing an ambiguous rewrite.');
      }
      if (existing.length === sequences.length) {
        assertReceiptsMatch(
          existing,
          application.events,
          objectId,
          action,
          hydrationOutcome,
          application.cacheGeneration,
          sourceFingerprint
        );
        return {
          duplicate: true,
          materialized: existing.every((receipt) => receipt.appliedAction !== 'fenced_noop'),
        };
      }

      const stateResult = await client.query<FeedStateRow>(
        feedStateSelect(true),
        bindingValues(application)
      );
      if (!stateResult.rows[0]) {
        throw new Error(
          'Inventory change-feed state must be initialized before event application.'
        );
      }
      const state = mapFeedState(stateResult.rows[0]);
      if (state.baselineGeneration !== application.cacheGeneration) {
        throw new Error('Inventory cache generation changed before event application.');
      }
      if (state.highestAppliedEventSeq !== application.expectedHighestAppliedEventSeq) {
        throw new Error('Inventory event cursor changed before event application.');
      }
      const highestInput = sequences[sequences.length - 1];
      const objectFence = await client.query<{ event_seq: string | null }>(
        `SELECT MAX(event_seq)::TEXT AS event_seq FROM inventory_event_receipts
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND object_id=$4`,
        [...bindingValues(application), objectId]
      );
      const stale = compareSequences(objectFence.rows[0]?.event_seq ?? null, highestInput) >= 0;
      if (!stale) await mutate(client);

      const receiptAction = stale ? 'fenced_noop' : action;
      const materializationOutcome = stale
        ? 'superseded'
        : action === 'upsert'
          ? 'upserted'
          : 'tombstoned';
      for (const event of application.events) {
        await client.query(
          `INSERT INTO inventory_event_receipts (
             account_identity, ledger_database_id, consumer_name, receipt_id, event_seq, event_type,
             object_id, applied_action, hydration_outcome, materialization_outcome,
             cache_generation, source_fingerprint, committed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            ...bindingValues(application),
            createInventoryEventReceiptId(application, event.eventSeq),
            event.eventSeq,
            event.eventType,
            objectId,
            receiptAction,
            hydrationOutcome,
            materializationOutcome,
            application.cacheGeneration,
            stale ? null : sourceFingerprint,
            application.committedAt,
          ]
        );
      }
      const observedThrough = monotonicCursor(
        state.observedThroughEventSeq,
        application.observedThroughEventSeq ??
          maxSequence(state.observedThroughEventSeq, highestInput),
        'observedThroughEventSeq'
      );
      const appliedThrough = monotonicCursor(
        state.appliedThroughEventSeq,
        application.appliedThroughEventSeq,
        'appliedThroughEventSeq'
      );
      const highestApplied = monotonicCursor(
        state.highestAppliedEventSeq,
        maxSequence(state.highestAppliedEventSeq, highestInput),
        'highestAppliedEventSeq'
      );
      const nextState: InventoryChangeFeedState = {
        ...state,
        baselineGeneration: state.baselineGeneration,
        observedThroughEventSeq: observedThrough,
        appliedThroughEventSeq: appliedThrough,
        highestAppliedEventSeq: highestApplied,
        blockedByEventSeq: pick(application.blockedByEventSeq, state.blockedByEventSeq),
        updatedAt: Math.max(state.updatedAt, application.committedAt),
      };
      assertCursorRelations(nextState);
      await client.query(
        `UPDATE inventory_change_feed_state
         SET observed_through_event_seq=$4, applied_through_event_seq=$5,
             highest_applied_event_seq=$6, blocked_by_event_seq=$7, updated_at=$8
         WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3`,
        [
          ...bindingValues(application),
          nextState.observedThroughEventSeq,
          nextState.appliedThroughEventSeq,
          nextState.highestAppliedEventSeq,
          nextState.blockedByEventSeq,
          nextState.updatedAt,
        ]
      );
      return { duplicate: false, materialized: !stale };
    }, application.operationSignal);

    const receipts = await this.options.withVerifiedWrite(
      (client) => this.readReceipts(client, application, sequences, false),
      application.operationSignal
    );
    if (receipts.length !== sequences.length) {
      throw new Error('Inventory event receipt readback did not prove the committed event set.');
    }
    return { ...transactionResult, receipts };
  }

  private async replaceLiveInventory(
    client: PoolClient,
    snapshot: InventorySnapshot,
    promotion: InventoryBaselinePromotion,
    run: InventoryBaselineRun
  ): Promise<void> {
    await client.query(`DELETE FROM item_stock_locations WHERE cache_source='api'`);
    await client.query(`
      UPDATE items AS item SET cache_source='csv', source_api_version=NULL
      WHERE item.cache_source='api' AND EXISTS (
        SELECT 1 FROM item_stock_locations AS stock
        WHERE stock.item_id=item.item_id AND stock.cache_source='csv'
      )
    `);
    await client.query(`DELETE FROM items WHERE cache_source='api'`);
    for (const item of snapshot.items) {
      await client.query(
        upsertSql('items', ITEM_COLUMNS, 'item_id'),
        valuesFor(ITEM_COLUMNS, item)
      );
    }
    for (const stock of snapshot.stockRows) {
      await client.query(
        upsertSql('item_stock_locations', STOCK_COLUMNS, 'stock_row_id'),
        valuesFor(STOCK_COLUMNS, stock)
      );
    }
    await client.query(
      `INSERT INTO cache_meta(key,value) VALUES($1,$2)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [INVENTORY_SNAPSHOT_META_KEY, JSON.stringify(snapshot.meta)]
    );
    const stateResult = await client.query<{ value: string }>(
      `SELECT value FROM cache_meta WHERE key='state' FOR UPDATE`
    );
    const current = parseCacheState(stateResult.rows[0]?.value);
    const state: CacheState = {
      lastSync: current?.lastSync ?? 0,
      lastFullSync: current?.lastFullSync ?? 0,
      documentCount: current?.documentCount ?? 0,
      itemDocumentCount: current?.itemDocumentCount ?? 0,
      accountName: current?.accountName ?? promotion.accountIdentity,
      ...current,
      schemaVersion: CACHE_SCHEMA_VERSION,
      itemCount: snapshot.items.length,
      stockLocationCount: snapshot.stockRows.length,
      lastItemSync: promotion.promotedAt,
      lastFullItemSync: promotion.promotedAt,
      lastSyncAttempt: promotion.promotedAt,
      inventorySourceApiVersion: '3',
    };
    await client.query(
      `INSERT INTO cache_meta(key,value) VALUES('state',$1)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify(state)]
    );
    await client.query(
      `UPDATE inventory_change_feed_state
       SET baseline_generation=$4, observed_through_event_seq=GREATEST(
         COALESCE(observed_through_event_seq,0),$5
       ), applied_through_event_seq=GREATEST(COALESCE(applied_through_event_seq,0),$5),
          highest_applied_event_seq=GREATEST(COALESCE(highest_applied_event_seq,0),$5),
          updated_at=GREATEST(updated_at,$6)
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3`,
      [...bindingValues(promotion), run.generation, run.startEventSeq, promotion.promotedAt]
    );
    await client.query(
      `UPDATE inventory_baseline_runs
       SET status='promoted', updated_at=$5, promoted_at=$5, promoted_meta=$6::JSONB
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4`,
      [
        ...bindingValues(promotion),
        promotion.runId,
        promotion.promotedAt,
        JSON.stringify(snapshot.meta),
      ]
    );
  }

  private assertBundleApplication(application: InventoryItemBundleApplication): void {
    this.assertApplication(application, application.item.item_id);
    this.options.assertItemBundle(application.item, application.stockRows);
    const fingerprint = createInventoryItemBundleFingerprint(
      application.accountIdentity,
      application.item,
      application.stockRows
    );
    if (
      application.sourceFingerprint !== undefined &&
      application.sourceFingerprint !== fingerprint
    ) {
      throw new Error('Inventory item bundle fingerprint does not match its rows.');
    }
    if (application.hydrationOutcome === 'found_current' && application.item.archived === 1) {
      throw new Error('Current inventory receipt cannot store an archived item.');
    }
    if (application.hydrationOutcome === 'found_archived' && application.item.archived !== 1) {
      throw new Error('Archived inventory receipt requires an archived item.');
    }
  }

  private assertTombstoneApplication(application: InventoryTombstoneApplication): void {
    this.assertApplication(application, application.objectId);
    assertSequence(application.proof.deleteEventSeq, true, 'deleteEventSeq');
    assertTimestamp(application.proof.confirmedMissingAt, 'confirmedMissingAt');
    if (application.proof.confirmedMissingAt > application.committedAt) {
      throw new Error('Inventory tombstone confirmation cannot postdate its cache commit.');
    }
    const newest = [...application.events].sort(compareEvents).at(-1);
    if (
      application.proof.confirmation !== 'v3_exact_404' ||
      newest?.eventSeq !== application.proof.deleteEventSeq ||
      newest.eventType !== 'inventory.item_deleted'
    ) {
      throw new Error(
        'Inventory tombstone requires newest signed delete evidence and confirmed V3 404.'
      );
    }
  }

  private assertApplication(
    application: InventoryItemBundleApplication | InventoryTombstoneApplication,
    objectId: string
  ): void {
    assertBinding(application);
    assertNonEmptyText(application.cacheGeneration, 'cacheGeneration');
    assertCanonicalV3SourceId(objectId, 'inventory receipt');
    assertTimestamp(application.committedAt, 'committedAt');
    assertOptionalSequence(
      application.expectedHighestAppliedEventSeq,
      'expectedHighestAppliedEventSeq'
    );
    assertOptionalSequence(application.observedThroughEventSeq, 'observedThroughEventSeq');
    assertOptionalSequence(application.appliedThroughEventSeq, 'appliedThroughEventSeq');
    assertOptionalSequence(application.blockedByEventSeq, 'blockedByEventSeq');
    if (application.events.length === 0) throw new Error('Inventory event set cannot be empty.');
    normalizeSequences(
      application.events.map((event) => event.eventSeq),
      true
    );
    for (const event of application.events) {
      if (!EVENT_TYPES.has(event.eventType) || event.objectId !== objectId) {
        throw new Error('Inventory receipt event identity is invalid.');
      }
    }
  }

  private async insertFeedState(
    client: PoolClient,
    binding: InventoryChangeFeedBinding,
    updatedAt: number
  ): Promise<void> {
    const consumerBinding = await client.query<FeedStateRow>(
      `SELECT account_identity, ledger_database_id::TEXT, consumer_name,
              baseline_generation, observed_through_event_seq::TEXT,
              applied_through_event_seq::TEXT, highest_applied_event_seq::TEXT,
              blocked_by_event_seq::TEXT, updated_at
       FROM inventory_change_feed_state
       WHERE account_identity=$1 AND consumer_name=$2
       FOR UPDATE`,
      [binding.accountIdentity, binding.consumerName]
    );
    if (
      consumerBinding.rows[0] &&
      consumerBinding.rows[0].ledger_database_id.toLowerCase() !==
        binding.ledgerDatabaseId.toLowerCase()
    ) {
      throw new Error(
        'Inventory change-feed ledger database UUID conflicts with its consumer binding.'
      );
    }
    await client.query(
      `INSERT INTO inventory_change_feed_state (
         account_identity, ledger_database_id, consumer_name, baseline_generation,
         observed_through_event_seq, applied_through_event_seq,
         highest_applied_event_seq, blocked_by_event_seq, updated_at
       ) VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,NULL,$4)
       ON CONFLICT (ledger_database_id, consumer_name) DO NOTHING`,
      [...bindingValues(binding), updatedAt]
    );
    const persisted = await client.query<FeedStateRow>(
      feedStateSelect(true),
      bindingValues(binding)
    );
    if (!persisted.rows[0]) {
      throw new Error('Inventory change-feed identity conflicts with another cache account.');
    }
  }

  private async requireState(
    binding: InventoryChangeFeedBinding
  ): Promise<InventoryChangeFeedState> {
    const state = await this.getInventoryChangeFeedState(binding);
    if (!state) throw new Error('Inventory change-feed state was not durably stored.');
    return state;
  }

  private async readReceipts(
    client: PoolClient,
    binding: InventoryChangeFeedBinding,
    eventSeqs: InventoryEventSequence[],
    forUpdate: boolean
  ): Promise<InventoryEventReceipt[]> {
    const result = await client.query<ReceiptRow>(
      `SELECT account_identity, ledger_database_id::TEXT, consumer_name, receipt_id,
              event_seq::TEXT, event_type, object_id, applied_action, hydration_outcome,
              materialization_outcome, cache_generation, source_fingerprint, committed_at
       FROM inventory_event_receipts
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
         AND event_seq=ANY($4::BIGINT[])
       ORDER BY event_seq${forUpdate ? ' FOR UPDATE' : ''}`,
      [...bindingValues(binding), eventSeqs]
    );
    return result.rows.map(mapReceipt);
  }

  private async readPromotedInventoryMeta(
    client: PoolClient,
    binding: InventoryChangeFeedBinding,
    generation: string
  ): Promise<InventoryCacheMeta> {
    const result = await client.query<{ promoted_meta: InventoryCacheMeta | string | null }>(
      `SELECT promoted_meta FROM inventory_baseline_runs
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
         AND generation=$4 AND status='promoted'`,
      [...bindingValues(binding), generation]
    );
    let meta: InventoryCacheMeta | null = null;
    try {
      const value = result.rows[0]?.promoted_meta;
      meta = parseInventoryCacheMeta(typeof value === 'string' ? JSON.parse(value) : value);
    } catch {
      meta = null;
    }
    if (
      !meta ||
      meta.schemaVersion !== CACHE_SCHEMA_VERSION ||
      meta.accountIdentity !== binding.accountIdentity ||
      meta.generation !== generation
    ) {
      throw new Error('Inventory baseline metadata readback did not prove the promoted snapshot.');
    }
    return meta;
  }

  private async readBaselineRun(
    client: PoolClient,
    binding: InventoryChangeFeedBinding,
    runId: string,
    forUpdate: boolean
  ): Promise<InventoryBaselineRun | null> {
    const result = await client.query<BaselineRunRow>(
      `SELECT account_identity, ledger_database_id::TEXT, consumer_name, run_id::TEXT,
              generation, start_event_seq::TEXT, root_fingerprint, expected_item_count,
              status, started_at, updated_at, promoted_at, failure_code
       FROM inventory_baseline_runs
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [...bindingValues(binding), runId]
    );
    if (!result.rows[0]) return null;
    const rootItems = await client.query<{ item_id: string }>(
      `SELECT item_id FROM inventory_baseline_root_items
       WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3 AND run_id=$4
       ORDER BY root_position`,
      [...bindingValues(binding), runId]
    );
    const run = mapBaselineRun(
      result.rows[0],
      rootItems.rows.map((row) => row.item_id)
    );
    assertStoredBaselineManifest(run);
    return run;
  }

  private async requireActiveRun(
    client: PoolClient,
    binding: InventoryChangeFeedBinding,
    runId: string
  ): Promise<InventoryBaselineRun> {
    const run = await this.readBaselineRun(client, binding, runId, true);
    if (!run || run.status !== 'active') {
      throw new Error('Inventory baseline run is not active.');
    }
    return run;
  }
}

interface FeedStateRow {
  account_identity: string;
  ledger_database_id: string;
  consumer_name: string;
  baseline_generation: string | null;
  observed_through_event_seq: string | null;
  applied_through_event_seq: string | null;
  highest_applied_event_seq: string | null;
  blocked_by_event_seq: string | null;
  updated_at: string | number;
}

interface VerifiedBaselineProofRow {
  account_identity: string;
  ledger_database_id: string;
  consumer_name: string;
  baseline_generation: string | null;
  baseline_status: string | null;
  promoted_meta: InventoryCacheMeta | string | null;
}

interface ReceiptRow {
  account_identity: string;
  ledger_database_id: string;
  consumer_name: string;
  receipt_id: string;
  event_seq: string;
  event_type: InventoryEventReceipt['eventType'];
  object_id: string;
  applied_action: InventoryEventReceipt['appliedAction'];
  hydration_outcome: InventoryEventReceipt['hydrationOutcome'];
  materialization_outcome: InventoryEventReceipt['materializationOutcome'];
  cache_generation: string;
  source_fingerprint: string | null;
  committed_at: string | number;
}

interface BaselineRunRow {
  account_identity: string;
  ledger_database_id: string;
  consumer_name: string;
  run_id: string;
  generation: string;
  start_event_seq: string;
  root_fingerprint: string;
  expected_item_count: string | number;
  status: InventoryBaselineRun['status'];
  started_at: string | number;
  updated_at: string | number;
  promoted_at: string | number | null;
  failure_code: string | null;
}

interface StagingProgressRow {
  item_id: string;
  status: string;
  attempt_count: string | number;
  error_code: string | null;
  error_message: string | null;
  updated_at: string | number;
}

function feedStateSelect(forUpdate: boolean): string {
  return `SELECT account_identity, ledger_database_id::TEXT, consumer_name,
                 baseline_generation, observed_through_event_seq::TEXT,
                 applied_through_event_seq::TEXT, highest_applied_event_seq::TEXT,
                 blocked_by_event_seq::TEXT, updated_at
          FROM inventory_change_feed_state
          WHERE account_identity=$1 AND ledger_database_id=$2 AND consumer_name=$3
          ${forUpdate ? 'FOR UPDATE' : ''}`;
}

function bindingValues(binding: InventoryChangeFeedBinding): [string, string, string] {
  return [binding.accountIdentity, binding.ledgerDatabaseId, binding.consumerName];
}

function mapFeedState(row: FeedStateRow): InventoryChangeFeedState {
  return {
    accountIdentity: row.account_identity,
    ledgerDatabaseId: row.ledger_database_id,
    consumerName: row.consumer_name,
    baselineGeneration: row.baseline_generation,
    observedThroughEventSeq: row.observed_through_event_seq,
    appliedThroughEventSeq: row.applied_through_event_seq,
    highestAppliedEventSeq: row.highest_applied_event_seq,
    blockedByEventSeq: row.blocked_by_event_seq,
    updatedAt: Number(row.updated_at),
  };
}

function mapReceipt(row: ReceiptRow): InventoryEventReceipt {
  return {
    accountIdentity: row.account_identity,
    ledgerDatabaseId: row.ledger_database_id,
    consumerName: row.consumer_name,
    receiptId: row.receipt_id,
    eventSeq: row.event_seq,
    eventType: row.event_type,
    objectId: row.object_id,
    appliedAction: row.applied_action,
    hydrationOutcome: row.hydration_outcome,
    materializationOutcome: row.materialization_outcome,
    cacheGeneration: row.cache_generation,
    sourceFingerprint: row.source_fingerprint,
    committedAt: Number(row.committed_at),
  };
}

function mapBaselineRun(row: BaselineRunRow, rootItemIds: string[]): InventoryBaselineRun {
  return {
    accountIdentity: row.account_identity,
    ledgerDatabaseId: row.ledger_database_id,
    consumerName: row.consumer_name,
    runId: row.run_id,
    generation: row.generation,
    startEventSeq: row.start_event_seq,
    rootFingerprint: row.root_fingerprint,
    rootItemIds,
    expectedItemCount: Number(row.expected_item_count),
    status: row.status,
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    promotedAt: row.promoted_at === null ? null : Number(row.promoted_at),
    failureCode: row.failure_code,
  };
}

function assertReceiptsMatch(
  receipts: InventoryEventReceipt[],
  events: InventoryEventReceiptInput[],
  objectId: string,
  action: 'upsert' | 'tombstone',
  hydrationOutcome: 'found_current' | 'found_archived' | 'expected_tombstone',
  cacheGeneration: string,
  sourceFingerprint: string | null
): void {
  const bySeq = new Map(events.map((event) => [event.eventSeq, event]));
  const matches = receipts.every((receipt) => {
    const event = bySeq.get(receipt.eventSeq);
    const expectedResult =
      receipt.appliedAction === action &&
      receipt.materializationOutcome === (action === 'upsert' ? 'upserted' : 'tombstoned') &&
      receipt.sourceFingerprint === sourceFingerprint;
    const fencedResult =
      receipt.appliedAction === 'fenced_noop' &&
      receipt.materializationOutcome === 'superseded' &&
      receipt.sourceFingerprint === null;
    return (
      event?.eventType === receipt.eventType &&
      receipt.objectId === objectId &&
      receipt.receiptId === createInventoryEventReceiptId(receipt, receipt.eventSeq) &&
      receipt.hydrationOutcome === hydrationOutcome &&
      receipt.cacheGeneration === cacheGeneration &&
      (expectedResult || fencedResult)
    );
  });
  if (!matches)
    throw new Error('Inventory event receipt conflicts with the requested application.');
}

function assertBinding(binding: InventoryChangeFeedBinding): void {
  assertNonEmptyText(binding.accountIdentity, 'accountIdentity');
  assertUuid(binding.ledgerDatabaseId, 'ledgerDatabaseId');
  assertConsumerName(binding.consumerName);
}

function assertBaselineRun(run: InventoryBaselineRun): void {
  assertBinding(run);
  assertUuid(run.runId, 'runId');
  assertNonEmptyText(run.generation, 'generation');
  assertSequence(run.startEventSeq, false, 'startEventSeq');
  assertNonEmptyText(run.rootFingerprint, 'rootFingerprint');
  const sortedRootIds = [...run.rootItemIds].sort(compareText);
  const uniqueRootIds = new Set(sortedRootIds);
  for (const itemId of run.rootItemIds) assertCanonicalV3SourceId(itemId, 'baseline root item');
  if (
    !Number.isSafeInteger(run.expectedItemCount) ||
    run.expectedItemCount < 0 ||
    run.expectedItemCount !== run.rootItemIds.length ||
    uniqueRootIds.size !== run.rootItemIds.length ||
    !run.rootItemIds.every((itemId, index) => itemId === sortedRootIds[index])
  ) {
    throw new Error('expectedItemCount is invalid.');
  }
  if (
    run.rootFingerprint !==
    createInventoryBaselineRootFingerprint(run.accountIdentity, run.rootItemIds)
  ) {
    throw new Error('Inventory baseline root fingerprint does not match its canonical manifest.');
  }
  if (run.status !== 'active' || run.promotedAt !== null || run.failureCode !== null) {
    throw new Error('A new inventory baseline run must be active and unpromoted.');
  }
  assertTimestamp(run.startedAt, 'startedAt');
  assertTimestamp(run.updatedAt, 'updatedAt');
  if (run.updatedAt < run.startedAt) throw new Error('updatedAt precedes startedAt.');
}

function assertStoredBaselineManifest(run: InventoryBaselineRun): void {
  const sortedRootIds = [...run.rootItemIds].sort(compareText);
  const uniqueRootIds = new Set(sortedRootIds);
  if (
    run.expectedItemCount !== run.rootItemIds.length ||
    uniqueRootIds.size !== run.rootItemIds.length ||
    !run.rootItemIds.every((itemId, index) => itemId === sortedRootIds[index]) ||
    run.rootFingerprint !==
      createInventoryBaselineRootFingerprint(run.accountIdentity, run.rootItemIds)
  ) {
    throw new Error('Persisted inventory baseline root manifest failed integrity validation.');
  }
  for (const itemId of run.rootItemIds) assertCanonicalV3SourceId(itemId, 'baseline root item');
}

function sameBaselineIdentity(left: InventoryBaselineRun, right: InventoryBaselineRun): boolean {
  return (
    left.accountIdentity === right.accountIdentity &&
    left.ledgerDatabaseId === right.ledgerDatabaseId &&
    left.consumerName === right.consumerName &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.startEventSeq === right.startEventSeq &&
    left.rootFingerprint === right.rootFingerprint &&
    left.expectedItemCount === right.expectedItemCount &&
    left.rootItemIds.length === right.rootItemIds.length &&
    left.rootItemIds.every((itemId, index) => itemId === right.rootItemIds[index])
  );
}

function assertCursorRelations(state: InventoryChangeFeedState): void {
  if (
    compareSequences(state.appliedThroughEventSeq, state.observedThroughEventSeq) > 0 ||
    compareSequences(state.highestAppliedEventSeq, state.observedThroughEventSeq) > 0 ||
    compareSequences(state.appliedThroughEventSeq, state.highestAppliedEventSeq) > 0
  ) {
    throw new Error('Inventory change-feed applied cursor exceeds the observed cursor.');
  }
}

function monotonicCursor(
  current: InventoryEventSequence | null,
  proposed: InventoryEventSequence | null | undefined,
  field: string
): InventoryEventSequence | null {
  if (proposed === undefined) return current;
  if (proposed === null) {
    if (current !== null) throw new Error(`${field} cannot move backwards.`);
    return null;
  }
  if (current !== null && compareSequences(proposed, current) < 0) {
    throw new Error(`${field} cannot move backwards.`);
  }
  return proposed;
}

function pick<T>(proposed: T | undefined, current: T): T {
  return proposed === undefined ? current : proposed;
}

function unchangedBaselineGeneration(
  current: string | null,
  proposed: string | null | undefined
): string | null {
  if (proposed === undefined || proposed === current) return current;
  throw new Error('Inventory baseline generation changes require atomic baseline promotion.');
}

function normalizeSequences(
  values: InventoryEventSequence[],
  positive: boolean
): InventoryEventSequence[] {
  const unique = new Set<string>();
  for (const value of values) {
    assertSequence(value, positive, 'eventSeq');
    if (unique.has(value)) throw new Error('Inventory event sequence is duplicated.');
    unique.add(value);
  }
  return [...unique].sort((left, right) => compareSequences(left, right));
}

function assertOptionalSequence(value: unknown, field: string): void {
  if (value !== undefined && value !== null) assertSequence(value, false, field);
}

function assertSequence(value: unknown, positive: boolean, field: string): asserts value is string {
  if (!isInventoryEventSequence(value) || (positive && value === '0')) {
    throw new Error(`${field} must be a canonical PostgreSQL BIGINT decimal string.`);
  }
}

function compareSequences(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function maxSequence(
  left: InventoryEventSequence | null,
  right: InventoryEventSequence
): InventoryEventSequence {
  return compareSequences(left, right) >= 0 ? (left as InventoryEventSequence) : right;
}

function compareEvents(
  left: InventoryEventReceiptInput,
  right: InventoryEventReceiptInput
): number {
  return compareSequences(left.eventSeq, right.eventSeq);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID.`);
  }
}

function assertNonEmptyText(value: string, field: string): void {
  if (!value || value.trim() !== value || value.includes('\0'))
    throw new Error(`${field} is invalid.`);
}

function assertConsumerName(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/.test(value)) {
    throw new Error('consumerName is invalid.');
  }
}

function assertSafeMessage(value: string, field: string, max: number): void {
  assertNonEmptyText(value, field);
  if (value.length > max || /(?:postgres(?:ql)?:\/\/|password\s*=)/i.test(value)) {
    throw new Error(`${field} is not safe to persist.`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid.`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid.`);
}

function upsertSql(table: string, columns: readonly string[], conflictColumn: string): string {
  const values = columns.map((_, index) => `$${index + 1}`).join(', ');
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) =>
      table === 'items' && column === 'archived'
        ? `${column}=COALESCE(EXCLUDED.${column},items.${column})`
        : `${column}=EXCLUDED.${column}`
    )
    .join(', ');
  return (
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values}) ` +
    `ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`
  );
}

function valuesFor(columns: readonly string[], row: ItemRow | ItemStockLocationRow): unknown[] {
  const record = row as unknown as Record<string, unknown>;
  return columns.map((column) => {
    const value = record[column] ?? null;
    return typeof value === 'string' ? value.replaceAll('\0', '') : value;
  });
}

function parseJsonRow<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function createPromotedInventoryMeta(
  run: InventoryBaselineRun,
  promotedAt: number,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[]
): InventoryCacheMeta {
  return {
    version: 2,
    status: 'complete',
    accountIdentity: run.accountIdentity,
    startedAt: run.startedAt,
    completedAt: promotedAt,
    itemCount: items.length,
    stockRowCount: stockRows.length,
    freshItemCount: items.length,
    preservedItemCount: 0,
    omittedItemCount: 0,
    warningCount: 0,
    lastCompleteAt: promotedAt,
    schemaVersion: CACHE_SCHEMA_VERSION,
    sourceApiVersion: '3',
    generation: run.generation,
    fingerprint: createInventorySnapshotFingerprint(
      run.accountIdentity,
      run.generation,
      items,
      stockRows
    ),
  };
}

function parseCacheState(value: string | undefined): CacheState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CacheState;
    return Number.isSafeInteger(parsed.schemaVersion) ? parsed : null;
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
