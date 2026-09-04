import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresChangeFeedRepository } from '../../change-feed/postgres-change-feed.repository.js';
import { SALESBINDER_CLI_INVENTORY_CONSUMER } from '../../change-feed/change-feed.constants.js';
import { InventoryChangeFeedSyncService } from '../inventory-change-feed-sync.service.js';
import { PostgresCacheService } from '../postgres-cache.service.js';
import {
  createInventoryBaselineRootFingerprint,
  createInventoryItemBundleFingerprint,
  createSalesBinderAccountBinding,
  type InventoryChangeFeedBinding,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_TWO_DB_CHANGE_FEED_TEST_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const databaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  url.searchParams.set('application_name', `sb-two-db-${databaseName.slice(-16)}`);
  return url.toString();
};

describeIfPostgres('two-database inventory change-feed integration', () => {
  jest.setTimeout(45_000);

  const suffix = randomUUID().replaceAll('-', '_');
  const ledgerDatabase = `sb_ledger_${suffix}`;
  const cacheDatabase = `sb_cache_${suffix}`;
  const bindingAccount = createSalesBinderAccountBinding('two-db-integration');
  const ledgerDatabaseId = randomUUID();
  const itemId = randomUUID();
  const baselineGeneration = `integration-generation-${randomUUID()}`;

  let adminPool: InstanceType<typeof Pool> | undefined;
  let ledgerPool: InstanceType<typeof Pool> | undefined;
  let cachePool: InstanceType<typeof Pool> | undefined;
  let cache: PostgresCacheService | undefined;
  let ledger: PostgresChangeFeedRepository | undefined;

  beforeAll(async () => {
    if (!testUrl) throw new Error('Integration test URL is not configured.');
    adminPool = new Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(ledgerDatabase)}`);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(cacheDatabase)}`);
    ledgerPool = new Pool({ connectionString: databaseUrl(testUrl, ledgerDatabase) });
    cachePool = new Pool({ connectionString: databaseUrl(testUrl, cacheDatabase) });
    await installLedgerContract(ledgerPool, ledgerDatabaseId, bindingAccount.accountIdentity);
  });

  afterAll(async () => {
    await ledger?.close().catch(() => undefined);
    await cache?.close().catch(() => undefined);
    await ledgerPool?.end().catch(() => undefined);
    await cachePool?.end().catch(() => undefined);
    if (adminPool) {
      for (const dbName of [ledgerDatabase, cacheDatabase]) {
        await adminPool
          .query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [dbName]
          )
          .catch(() => undefined);
        await adminPool
          .query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`)
          .catch(() => undefined);
      }
      await adminPool.end().catch(() => undefined);
    }
  });

  it('hydrates one ledger event into a separate cache DB and rejects post-cache pre-ledger callback failure', async () => {
    if (!testUrl || !ledgerPool || !cachePool) {
      throw new Error('Integration PostgreSQL pools were not initialized.');
    }
    const ledgerUrl = databaseUrl(testUrl, ledgerDatabase);
    const cacheUrl = databaseUrl(testUrl, cacheDatabase);
    expect(new URL(ledgerUrl).pathname).not.toBe(new URL(cacheUrl).pathname);

    ledger = new PostgresChangeFeedRepository({
      databaseUrl: ledgerUrl,
      accountIdentity: bindingAccount.accountIdentity,
      expectedLedgerDatabaseId: ledgerDatabaseId,
    });
    const preflight = await ledger.preflight();
    const binding: InventoryChangeFeedBinding = {
      accountIdentity: bindingAccount.accountIdentity,
      ledgerDatabaseId: preflight.ledgerDatabaseId,
      consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    };

    cache = new PostgresCacheService(cacheUrl);
    await cache.ensureAccountBinding(bindingAccount);
    await cache.ensureInventoryChangeFeedState(binding, 100);
    await promoteEmptyBaseline(cache, binding, baselineGeneration);

    await expect(cache.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    try {
      const ignoredEventSeq = await insertLedgerEvent(
        ledgerPool,
        randomUUID(),
        'inventory.item_updated',
        'unsubscribed-integration-consumer'
      );
      await expect(ledger.captureTarget(5_000)).resolves.toBeNull();

      const eventSeq = await insertLedgerEvent(ledgerPool, itemId, 'inventory.item_updated');
      expect(BigInt(eventSeq)).toBeGreaterThan(BigInt(ignoredEventSeq));
      const service = new InventoryChangeFeedSyncService({
        binding,
        ledger,
        cache,
        hydrator: {
          hydrate: async (ids) => ids.map((id) => foundHydration(binding.accountIdentity, id)),
        },
        directItemReader: { items: { get: jest.fn(), listVariations: jest.fn() } },
        signal: new AbortController().signal,
        assertWriterLockHeld: async () => undefined,
        leaseOwner: `two-db-${randomUUID()}`,
        leaseSeconds: 30,
        claimBatchSize: 5,
        now: () => 200,
      });

      await expect(readDatabaseName(ledgerPool)).resolves.toBe(ledgerDatabase);
      await expect(readDatabaseName(cachePool)).resolves.toBe(cacheDatabase);
      const result = await service.sync();

      expect(result).toMatchObject({
        status: 'success',
        clean: true,
        targetEventSeq: eventSeq,
        eventsClaimed: 1,
        eventsCompleted: 1,
        eventsFailed: 0,
        itemsProcessed: 1,
        stockRowsProcessed: 1,
        observedThroughEventSeq: eventSeq,
        appliedThroughEventSeq: eventSeq,
        blockedByEventSeq: null,
      });
      await expect(cache.getInventoryEventReceipt(binding, eventSeq)).resolves.toMatchObject({
        eventSeq,
        objectId: itemId,
        cacheGeneration: baselineGeneration,
        appliedAction: 'upsert',
        hydrationOutcome: 'found_current',
        materializationOutcome: 'upserted',
      });
      await expect(readLedgerStatus(ledgerPool, eventSeq)).resolves.toBe('succeeded');
      await expect(cache.getAllItems()).resolves.toEqual([
        expect.objectContaining({
          item_id: itemId,
          name: 'Hydrated integration item',
          quantity: 7,
        }),
      ]);

      const failedEventSeq = await insertLedgerEvent(
        ledgerPool,
        randomUUID(),
        'inventory.item_updated'
      );
      const boundaryFailure = new Error('post-cache pre-ledger boundary callback failed');
      let cacheApplied = false;
      const failingService = new InventoryChangeFeedSyncService({
        binding,
        ledger,
        cache,
        hydrator: {
          hydrate: async (ids) => ids.map((id) => foundHydration(binding.accountIdentity, id)),
        },
        directItemReader: { items: { get: jest.fn(), listVariations: jest.fn() } },
        signal: new AbortController().signal,
        assertWriterLockHeld: async () => {
          if (cacheApplied) throw boundaryFailure;
        },
        leaseOwner: `two-db-${randomUUID()}`,
        leaseSeconds: 30,
        claimBatchSize: 5,
        now: () => 201,
      });
      const originalApply = cache.applyInventoryItemBundle.bind(cache);
      jest.spyOn(cache, 'applyInventoryItemBundle').mockImplementationOnce(async (application) => {
        const applied = await originalApply(application);
        cacheApplied = true;
        return applied;
      });

      await expect(failingService.sync()).rejects.toBe(boundaryFailure);
      await expect(readLedgerStatus(ledgerPool, failedEventSeq)).resolves.toBe('processing');
      await expect(readLedgerReceiptId(ledgerPool, failedEventSeq)).resolves.toBeNull();
      await expect(cache.getInventoryEventReceipt(binding, failedEventSeq)).resolves.toMatchObject({
        eventSeq: failedEventSeq,
        cacheGeneration: baselineGeneration,
      });
    } finally {
      await cache.releaseSyncLock('cache-sync');
    }
  });
});

async function readDatabaseName(pool: InstanceType<typeof Pool>): Promise<string> {
  const result = await pool.query<{ current_database: string }>('SELECT current_database()');
  return result.rows[0]?.current_database ?? '';
}

async function readLedgerStatus(
  pool: InstanceType<typeof Pool>,
  eventSeq: string
): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM consumer_event_state WHERE event_seq = $1',
    [eventSeq]
  );
  return result.rows[0]?.status ?? null;
}

async function readLedgerReceiptId(
  pool: InstanceType<typeof Pool>,
  eventSeq: string
): Promise<string | null> {
  const result = await pool.query<{ receipt_id: string | null }>(
    'SELECT receipt_id FROM consumer_event_state WHERE event_seq = $1',
    [eventSeq]
  );
  return result.rows[0]?.receipt_id ?? null;
}

async function insertLedgerEvent(
  pool: InstanceType<typeof Pool>,
  objectId: string,
  eventType: 'inventory.item_created' | 'inventory.item_updated',
  consumerName: string = SALESBINDER_CLI_INVENTORY_CONSUMER
): Promise<string> {
  const payload = {
    id: `evt-${randomUUID()}`,
    type: eventType,
    api_version: 'v3',
    account_id: 'two-db-integration-account',
    created_at: '2026-01-01T00:00:00.000Z',
    data: { object: { id: objectId } },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const inserted = await pool.query<{ event_seq: string }>(
    `WITH event AS (
       INSERT INTO webhook_events (
         provider_event_id, event_type, api_version, object_type, object_id,
         provider_created_at, received_at, raw_body, parsed_payload
       ) VALUES ($1,$2,'v3','inventory',$3,$4,$5,$6,$7::jsonb)
       RETURNING event_seq
     )
     INSERT INTO consumer_event_state (consumer_name, event_seq, status, attempt_count)
     SELECT $8, event_seq, 'queued', 0 FROM event
     RETURNING event_seq::TEXT`,
    [
      payload.id,
      payload.type,
      objectId,
      new Date(payload.created_at),
      new Date('2026-01-01T00:00:01.000Z'),
      rawBody,
      JSON.stringify(payload),
      consumerName,
    ]
  );
  const eventSeq = inserted.rows[0]?.event_seq;
  if (!eventSeq) throw new Error('Ledger event was not inserted.');
  return eventSeq;
}

function foundHydration(accountIdentity: string, id: string): V3ExactItemHydrationResult {
  const item: ItemRow = {
    item_id: id,
    name: 'Hydrated integration item',
    quantity: 7,
    quantity_reserved: 0,
    quantity_available: 7,
    quantity_incoming: 0,
    in_transit: 0,
    archived: 0,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 200,
  };
  const stockRows: ItemStockLocationRow[] = [
    {
      stock_row_id: `${id}:stock`,
      item_id: id,
      quantity_on_hand: 7,
      quantity_reserved: 0,
      quantity_available: 7,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
      source_api_version: '3',
      imported_at: 200,
    },
  ];
  return {
    id,
    status: 'found_current',
    bundle: { item, stockRows },
    fingerprint: createInventoryItemBundleFingerprint(accountIdentity, item, stockRows),
  };
}

async function promoteEmptyBaseline(
  cache: PostgresCacheService,
  binding: InventoryChangeFeedBinding,
  generation: string
): Promise<void> {
  const runId = randomUUID();
  await cache.beginInventoryBaselineRun({
    ...binding,
    runId,
    generation,
    startEventSeq: '0',
    rootFingerprint: createInventoryBaselineRootFingerprint(binding.accountIdentity, []),
    rootItemIds: [],
    expectedItemCount: 0,
    status: 'active',
    startedAt: 100,
    updatedAt: 101,
    promotedAt: null,
    failureCode: null,
  });
  await cache.promoteInventoryBaselineRun({ ...binding, runId, promotedAt: 102 });
}

async function installLedgerContract(
  pool: InstanceType<typeof Pool>,
  ledgerDatabaseId: string,
  accountIdentity: string
): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(
    `
    CREATE TABLE change_feed_contract (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      ledger_database_id UUID NOT NULL,
      account_identity TEXT NOT NULL
    );

    CREATE TABLE webhook_events (
      event_seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      provider_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (
        event_type IN (
          'inventory.item_created',
          'inventory.item_deleted',
          'inventory.item_updated',
          'inventory.low_stock'
        )
      ),
      api_version TEXT NOT NULL CHECK (api_version = 'v3'),
      object_type TEXT NOT NULL CHECK (object_type = 'inventory'),
      object_id TEXT NOT NULL,
      provider_created_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      raw_body BYTEA NOT NULL,
      parsed_payload JSONB NOT NULL
    );

    CREATE TABLE consumer_event_state (
      consumer_name TEXT NOT NULL,
      event_seq BIGINT NOT NULL REFERENCES webhook_events(event_seq),
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'processing', 'retry', 'succeeded', 'dead_letter', 'covered_by_baseline')
      ),
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT NULL,
      lease_token UUID NULL,
      leased_until TIMESTAMPTZ NULL,
      receipt_id TEXT NULL,
      cache_generation TEXT NULL,
      committed_at TIMESTAMPTZ NULL,
      hydration_outcome TEXT NULL,
      next_attempt_at TIMESTAMPTZ NULL,
      PRIMARY KEY (consumer_name, event_seq)
    );

    CREATE FUNCTION get_change_feed_contract_preflight(account_identity_input TEXT, consumer_name_input TEXT)
    RETURNS TABLE (
      contract_version INTEGER,
      ledger_database_id UUID,
      account_identity TEXT,
      consumer_name TEXT,
      event_type_prefix TEXT,
      subscribed_event_types TEXT[]
    )
    LANGUAGE SQL
    AS $$
      SELECT 2, c.ledger_database_id, c.account_identity, consumer_name_input, 'inventory.',
             ARRAY['inventory.item_created','inventory.item_deleted','inventory.item_updated','inventory.low_stock']::TEXT[]
      FROM change_feed_contract AS c
      WHERE c.account_identity = account_identity_input
    $$;

    CREATE FUNCTION capture_change_feed_target(consumer_name_input TEXT, lock_timeout_ms INTEGER)
    RETURNS BIGINT
    LANGUAGE SQL
    AS $$
      SELECT NULLIF(COALESCE(MAX(event_seq), 0), 0)
      FROM consumer_event_state AS state
      WHERE state.consumer_name = consumer_name_input AND lock_timeout_ms > 0
    $$;

    CREATE FUNCTION claim_change_feed_events(
      consumer_name_input TEXT,
      lease_owner_input TEXT,
      batch_size_input INTEGER,
      lease_seconds_input INTEGER,
      through_event_seq_input BIGINT,
      sync_run_id_input UUID
    )
    RETURNS TABLE (
      event_seq BIGINT,
      provider_event_id TEXT,
      event_type TEXT,
      api_version TEXT,
      object_type TEXT,
      object_id TEXT,
      provider_created_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ,
      raw_body BYTEA,
      parsed_payload JSONB,
      attempt_count INTEGER,
      leased_until TIMESTAMPTZ,
      lease_token UUID
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN QUERY
      WITH next_events AS (
        SELECT state.event_seq
        FROM consumer_event_state AS state
        WHERE state.consumer_name = consumer_name_input
          AND sync_run_id_input IS NULL
          AND state.event_seq <= through_event_seq_input
          AND (state.status = 'queued' OR (state.status = 'retry' AND state.next_attempt_at <= now()))
        ORDER BY state.event_seq
        FOR UPDATE SKIP LOCKED
        LIMIT batch_size_input
      ),
      leased AS (
        UPDATE consumer_event_state AS state
        SET status = 'processing',
            attempt_count = state.attempt_count + 1,
            lease_owner = lease_owner_input,
            lease_token = gen_random_uuid(),
            leased_until = now() + make_interval(secs => lease_seconds_input),
            next_attempt_at = NULL
        FROM next_events
        WHERE state.consumer_name = consumer_name_input
          AND state.event_seq = next_events.event_seq
        RETURNING state.event_seq, state.attempt_count, state.leased_until, state.lease_token
      )
      SELECT event.event_seq, event.provider_event_id, event.event_type, event.api_version,
             event.object_type, event.object_id, event.provider_created_at, event.received_at,
             event.raw_body, event.parsed_payload, leased.attempt_count,
             leased.leased_until, leased.lease_token
      FROM leased
      JOIN webhook_events AS event ON event.event_seq = leased.event_seq
      ORDER BY event.event_seq;
    END
    $$;

    CREATE FUNCTION renew_change_feed_event_lease(
      consumer_name_input TEXT,
      event_seq_input BIGINT,
      lease_owner_input TEXT,
      lease_token_input UUID,
      lease_seconds_input INTEGER
    )
    RETURNS TIMESTAMPTZ
    LANGUAGE plpgsql
    AS $$
    DECLARE renewed_until TIMESTAMPTZ;
    BEGIN
      UPDATE consumer_event_state
      SET leased_until = now() + make_interval(secs => lease_seconds_input)
      WHERE consumer_name = consumer_name_input
        AND event_seq = event_seq_input
        AND status = 'processing'
        AND lease_owner = lease_owner_input
        AND lease_token = lease_token_input
      RETURNING leased_until INTO renewed_until;
      IF renewed_until IS NULL THEN
        RAISE EXCEPTION 'lease is not active';
      END IF;
      RETURN renewed_until;
    END
    $$;

    CREATE FUNCTION complete_change_feed_event(
      consumer_name_input TEXT,
      event_seq_input BIGINT,
      lease_owner_input TEXT,
      lease_token_input UUID,
      receipt_id_input TEXT,
      cache_generation_input TEXT,
      committed_at_input TIMESTAMPTZ,
      hydration_outcome_input TEXT,
      receipt_verified_input BOOLEAN
    )
    RETURNS TEXT
    LANGUAGE plpgsql
    AS $$
    DECLARE current_status TEXT;
    BEGIN
      SELECT status INTO current_status
      FROM consumer_event_state
      WHERE consumer_name = consumer_name_input AND event_seq = event_seq_input
      FOR UPDATE;
      IF current_status = 'succeeded' THEN
        RETURN 'superseded_by_succeeded';
      END IF;
      IF receipt_verified_input IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'cache receipt was not verified';
      END IF;
      UPDATE consumer_event_state
      SET status = 'succeeded',
          receipt_id = receipt_id_input,
          cache_generation = cache_generation_input,
          committed_at = committed_at_input,
          hydration_outcome = hydration_outcome_input
      WHERE consumer_name = consumer_name_input
        AND event_seq = event_seq_input
        AND status = 'processing'
        AND lease_owner = lease_owner_input
        AND lease_token = lease_token_input;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'lease is not active';
      END IF;
      RETURN 'succeeded';
    END
    $$;

    CREATE FUNCTION fail_change_feed_event(
      consumer_name_input TEXT,
      event_seq_input BIGINT,
      lease_owner_input TEXT,
      lease_token_input UUID,
      error_code_input TEXT,
      sanitized_error_message_input TEXT,
      retryable_input BOOLEAN,
      max_attempts_input INTEGER,
      base_delay_seconds_input INTEGER,
      max_delay_seconds_input INTEGER
    )
    RETURNS TABLE(status TEXT, next_attempt_at TIMESTAMPTZ)
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN QUERY
      UPDATE consumer_event_state AS state
      SET status = CASE
            WHEN retryable_input AND state.attempt_count < max_attempts_input THEN 'retry'
            ELSE 'dead_letter'
          END,
          next_attempt_at = now() + make_interval(
            secs => LEAST(base_delay_seconds_input, max_delay_seconds_input)
          )
      WHERE state.consumer_name = consumer_name_input
        AND state.event_seq = event_seq_input
        AND state.status = 'processing'
        AND state.lease_owner = lease_owner_input
        AND state.lease_token = lease_token_input
        AND error_code_input <> ''
        AND sanitized_error_message_input <> ''
      RETURNING state.status, state.next_attempt_at;
    END
    $$;

    CREATE FUNCTION refresh_change_feed_progress(consumer_name_input TEXT)
    RETURNS TABLE (
      observed_through_event_seq BIGINT,
      applied_through_event_seq BIGINT,
      blocked_by_event_seq BIGINT
    )
    LANGUAGE SQL
    AS $$
      WITH bounds AS (
        SELECT MAX(event_seq) AS observed FROM consumer_event_state WHERE consumer_name = consumer_name_input
      ),
      blocked AS (
        SELECT MIN(event_seq) AS event_seq
        FROM consumer_event_state
        WHERE consumer_name = consumer_name_input
          AND status NOT IN ('succeeded', 'covered_by_baseline')
      )
      SELECT bounds.observed,
             CASE
               WHEN bounds.observed IS NULL THEN NULL
               WHEN blocked.event_seq IS NULL THEN bounds.observed
               WHEN blocked.event_seq <= 1 THEN NULL
               ELSE blocked.event_seq - 1
             END,
             blocked.event_seq
      FROM bounds CROSS JOIN blocked
    $$;

    CREATE FUNCTION get_change_feed_consumer_status(consumer_name_input TEXT)
    RETURNS TABLE (
      observed_through_event_seq BIGINT,
      applied_through_event_seq BIGINT,
      blocked_by_event_seq BIGINT,
      queued_count BIGINT,
      retry_count BIGINT,
      dead_letter_count BIGINT,
      last_event_received_at TIMESTAMPTZ
    )
    LANGUAGE SQL
    AS $$
      WITH progress AS (
        SELECT * FROM refresh_change_feed_progress(consumer_name_input)
      )
      SELECT progress.observed_through_event_seq, progress.applied_through_event_seq,
             progress.blocked_by_event_seq,
             COUNT(*) FILTER (WHERE state.status = 'queued'),
             COUNT(*) FILTER (WHERE state.status = 'retry'),
             COUNT(*) FILTER (WHERE state.status = 'dead_letter'),
             MAX(event.received_at)
      FROM progress
      LEFT JOIN consumer_event_state AS state ON state.consumer_name = consumer_name_input
      LEFT JOIN webhook_events AS event ON event.event_seq = state.event_seq
      GROUP BY progress.observed_through_event_seq, progress.applied_through_event_seq,
               progress.blocked_by_event_seq
    $$;
    `
  );
  await pool.query(
    `INSERT INTO change_feed_contract (id, ledger_database_id, account_identity)
     VALUES (TRUE, $1, $2)`,
    [ledgerDatabaseId, accountIdentity]
  );
}
