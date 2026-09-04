import { PostgresInventoryChangeFeedStore } from '../postgres-inventory-change-feed.store.js';
import {
  CACHE_SCHEMA_VERSION,
  createInventoryBaselineRootFingerprint,
  createInventoryEventReceiptId,
  createInventoryItemBundleFingerprint,
  createInventorySnapshotFingerprint,
  type CacheState,
  type InventoryBaselineRun,
  type InventoryChangeFeedBinding,
  type InventoryEventReceipt,
  type InventoryEventReceiptInput,
  type InventoryItemBundleApplication,
  type InventorySnapshot,
  type InventoryStagingProgress,
  type InventoryTombstoneApplication,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';

type QueryResult = { rows: unknown[] };
type FakeClient = { query: jest.Mock<Promise<QueryResult>, [string, unknown[]?]> };

const binding: InventoryChangeFeedBinding = {
  accountIdentity: 'salesbinder:acme',
  ledgerDatabaseId: '11111111-1111-4111-8111-111111111111',
  consumerName: 'inventory-worker',
};

describe('PostgresInventoryChangeFeedStore', () => {
  it('creates durable v8 feed, receipt, baseline, staging, and immutability tables', async () => {
    const { store, harness } = createHarness();

    await store.ensureSchema(harness.client);

    const sql = harness.sql();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_change_feed_state');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_event_receipts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_baseline_runs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_baseline_root_items');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_staging_items');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_staging_stock_locations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS inventory_staging_progress');
    expect(sql).toContain('CREATE TRIGGER inventory_event_receipts_immutable');
  });

  it('opens feed state by exact account and consumer and rejects ledger mismatches', async () => {
    const { store } = createHarness();
    const state = await store.ensureInventoryChangeFeedState(binding, 100);

    expect(state).toMatchObject({
      ...binding,
      baselineGeneration: null,
      observedThroughEventSeq: null,
      appliedThroughEventSeq: null,
      highestAppliedEventSeq: null,
      blockedByEventSeq: null,
      updatedAt: 100,
    });
    await expect(
      store.ensureInventoryChangeFeedState(
        { ...binding, ledgerDatabaseId: '22222222-2222-4222-8222-222222222222' },
        101
      )
    ).rejects.toThrow(/ledger database UUID conflicts/);
    await expect(
      store.getInventoryChangeFeedStateByConsumer(binding.accountIdentity, binding.consumerName)
    ).resolves.toEqual(state);
  });

  it('applies item bundles atomically, returns deterministic receipts, and replays idempotently', async () => {
    const { store, harness } = createHarness();
    await store.ensureInventoryChangeFeedState(binding, 100);
    await promoteEmptyBaseline(store, '10');
    const application = bundleApplication({ eventSeqs: ['11', '12'], committedAt: 120 });

    const applied = await store.applyInventoryItemBundle(application);
    const mutationCountAfterApply = harness.liveMutationCount();
    const replayed = await store.applyInventoryItemBundle(application);

    expect(applied).toMatchObject({ duplicate: false, materialized: true });
    expect(replayed).toMatchObject({ duplicate: true, materialized: true });
    expect(harness.liveMutationCount()).toBe(mutationCountAfterApply);
    expect(applied.receipts).toEqual([
      receipt(application.events[0], application, 'upsert', 'found_current', 'upserted'),
      receipt(application.events[1], application, 'upsert', 'found_current', 'upserted'),
    ]);
    expect(replayed.receipts).toEqual(applied.receipts);
    await expect(store.getInventoryEventReceipt(binding, '11')).resolves.toEqual(
      applied.receipts[0]
    );
    await expect(store.getInventoryChangeFeedState(binding)).resolves.toMatchObject({
      observedThroughEventSeq: '12',
      highestAppliedEventSeq: '12',
      appliedThroughEventSeq: '10',
    });
  });

  it('fences stale global cursors and object events without mutating live inventory', async () => {
    const { store, harness } = createHarness();
    await store.ensureInventoryChangeFeedState(binding, 100);
    await promoteEmptyBaseline(store, '10');
    await store.updateInventoryChangeFeedState({
      ...binding,
      observedThroughEventSeq: '20',
      highestAppliedEventSeq: '20',
      updatedAt: 101,
    });
    await expect(
      store.applyInventoryItemBundle(
        bundleApplication({ eventSeqs: ['21'], expectedHighestAppliedEventSeq: '19' })
      )
    ).rejects.toThrow(/cursor changed/);

    const newer = bundleApplication({ eventSeqs: ['25'], expectedHighestAppliedEventSeq: '20' });
    await store.applyInventoryItemBundle(newer);
    const mutationCountAfterNewer = harness.liveMutationCount();
    const stale = bundleApplication({ eventSeqs: ['24'], expectedHighestAppliedEventSeq: '25' });
    const result = await store.applyInventoryItemBundle(stale);

    expect(result).toMatchObject({ duplicate: false, materialized: false });
    expect(result.receipts).toEqual([
      receipt(stale.events[0], stale, 'fenced_noop', 'found_current', 'superseded', null),
    ]);
    expect(harness.liveMutationCount()).toBe(mutationCountAfterNewer);
  });

  it('stores tombstones with separate hydration and materialization outcomes plus readback proof', async () => {
    const { store, harness } = createHarness();
    await store.ensureInventoryChangeFeedState(binding, 100);
    await promoteEmptyBaseline(store, '30');
    const application: InventoryTombstoneApplication = {
      ...binding,
      cacheGeneration: 'generation-1',
      objectId: item().item_id,
      events: [event('31', item().item_id, 'inventory.item_deleted')],
      proof: { deleteEventSeq: '31', confirmation: 'v3_exact_404', confirmedMissingAt: 130 },
      expectedHighestAppliedEventSeq: '30',
      committedAt: 131,
    };

    const result = await store.applyInventoryTombstone(application);

    expect(result).toMatchObject({ duplicate: false, materialized: true });
    expect(result.receipts).toEqual([
      {
        ...binding,
        receiptId: createInventoryEventReceiptId(binding, '31'),
        eventSeq: '31',
        eventType: 'inventory.item_deleted',
        objectId: application.objectId,
        appliedAction: 'tombstone',
        hydrationOutcome: 'expected_tombstone',
        materializationOutcome: 'tombstoned',
        cacheGeneration: 'generation-1',
        sourceFingerprint: null,
        committedAt: 131,
      },
    ]);
    expect(harness.sql()).toContain('DELETE FROM item_stock_locations WHERE item_id = $1');
    expect(harness.sql()).toContain('DELETE FROM items WHERE item_id = $1');
  });

  it('keeps ordered root manifests, pending IDs, failures, and idempotent baseline promotion', async () => {
    const { store, harness } = createHarness();
    const rootItemIds = [item(1).item_id, item(2).item_id, item(3).item_id];
    const run: InventoryBaselineRun = {
      ...binding,
      runId: '33333333-3333-4333-8333-333333333333',
      generation: 'baseline-generation',
      startEventSeq: '40',
      rootFingerprint: createInventoryBaselineRootFingerprint(binding.accountIdentity, rootItemIds),
      rootItemIds,
      expectedItemCount: 3,
      status: 'active',
      startedAt: 140,
      updatedAt: 141,
      promotedAt: null,
      failureCode: null,
    };
    await store.beginInventoryBaselineRun(run);

    await store.stageInventoryBaselineItem({
      ...binding,
      runId: run.runId,
      item: item(1),
      stockRows: [stock(1)],
      stagedAt: 150,
    });
    await store.recordInventoryStagingFailure({
      ...binding,
      runId: run.runId,
      itemId: item(2).item_id,
      attemptCount: 2,
      errorCode: 'invalid_record',
      errorMessage: 'Item failed source validation',
      updatedAt: 151,
    });

    await expect(store.getInventoryBaselineRun(binding, run.runId)).resolves.toEqual(run);
    await expect(store.getInventoryStagingProgress(binding, run.runId)).resolves.toEqual({
      ...binding,
      runId: run.runId,
      expectedItemCount: 3,
      stagedItemCount: 1,
      failedItemCount: 1,
      completedItemIds: [item(1).item_id],
      pendingItemIds: [item(2).item_id, item(3).item_id],
      failures: [
        {
          itemId: item(2).item_id,
          attemptCount: 2,
          errorCode: 'invalid_record',
          errorMessage: 'Item failed source validation',
          updatedAt: 151,
        },
      ],
    } satisfies InventoryStagingProgress);
    await expect(
      store.promoteInventoryBaselineRun({ ...binding, runId: run.runId, promotedAt: 160 })
    ).rejects.toThrow(/incomplete or failed/);

    await store.stageInventoryBaselineItem({
      ...binding,
      runId: run.runId,
      item: item(2),
      stockRows: [stock(2)],
      stagedAt: 152,
    });
    await store.stageInventoryBaselineItem({
      ...binding,
      runId: run.runId,
      item: item(3),
      stockRows: [stock(3)],
      stagedAt: 153,
    });
    const promoted = await store.promoteInventoryBaselineRun({
      ...binding,
      runId: run.runId,
      promotedAt: 160,
    });
    const replayed = await store.promoteInventoryBaselineRun({
      ...binding,
      runId: run.runId,
      promotedAt: 161,
    });

    expect(promoted.meta).toEqual({
      version: 2,
      status: 'complete',
      accountIdentity: binding.accountIdentity,
      startedAt: 140,
      completedAt: 160,
      itemCount: 3,
      stockRowCount: 3,
      freshItemCount: 3,
      preservedItemCount: 0,
      omittedItemCount: 0,
      warningCount: 0,
      lastCompleteAt: 160,
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceApiVersion: '3',
      generation: run.generation,
      fingerprint: createInventorySnapshotFingerprint(
        binding.accountIdentity,
        run.generation,
        [item(1), item(2), item(3)],
        [stock(1), stock(2), stock(3)]
      ),
    });
    expect(replayed).toEqual(promoted);
    expect(harness.liveInventoryItems()).toEqual([item(1), item(2), item(3)]);
  });
});

function createHarness(): {
  store: PostgresInventoryChangeFeedStore;
  harness: {
    client: never;
    sql: () => string;
    liveMutationCount: () => number;
    liveInventoryItems: () => ItemRow[];
  };
} {
  const data: HarnessData = {
    states: [],
    receipts: [],
    runs: [],
    rootItems: [],
    stagingItems: [],
    stagingStock: [],
    progress: [],
    liveItems: [],
    liveStock: [],
    state: null,
  };
  const calls: Array<[string, unknown[]?]> = [];
  const client: FakeClient = {
    query: jest.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      calls.push([sql.trim(), params]);
      return query(data, sql, params);
    }),
  };
  const store: PostgresInventoryChangeFeedStore = new PostgresInventoryChangeFeedStore({
    withVerifiedWrite: async (run) => run(client as never),
    withReadOnlyTransaction: async (run) => run(client as never),
    assertItemBundle: jest.fn(),
    assertInventorySnapshot: jest.fn(),
  });
  return {
    store,
    harness: {
      client: client as never,
      sql: () => calls.map(([sql]) => sql).join('\n'),
      liveMutationCount: () =>
        calls.filter(([sql]) =>
          /^(?:DELETE FROM items|DELETE FROM item_stock_locations|INSERT INTO items|INSERT INTO item_stock_locations)/.test(
            sql
          )
        ).length,
      liveInventoryItems: () => data.liveItems,
    },
  };
}

function query(data: HarnessData, sql: string, params: unknown[] = []): QueryResult {
  if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rows: [] };
  if (
    sql.includes('FROM inventory_change_feed_state') &&
    sql.includes('account_identity=$1 AND consumer_name=$2')
  ) {
    return {
      rows: data.states.filter(
        (row: FeedStateRow) => row.account_identity === params[0] && row.consumer_name === params[1]
      ),
    };
  }
  if (sql.startsWith('INSERT INTO inventory_change_feed_state')) {
    if (
      !data.states.some(
        (row: FeedStateRow) =>
          row.ledger_database_id === params[1] && row.consumer_name === params[2]
      )
    ) {
      data.states.push(feedRow(params));
    }
    return { rows: [] };
  }
  if (sql.includes('FROM inventory_change_feed_state') && sql.includes('ledger_database_id=$2')) {
    return { rows: data.states.filter((row: FeedStateRow) => matchesBinding(row, params)) };
  }
  if (sql.startsWith('UPDATE inventory_change_feed_state') && sql.includes('GREATEST')) {
    Object.assign(requireFeed(data, params), {
      baseline_generation: params[3],
      observed_through_event_seq: params[4],
      applied_through_event_seq: params[4],
      highest_applied_event_seq: params[4],
      updated_at: params[5],
    });
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE inventory_change_feed_state') && sql.includes('baseline_generation')) {
    Object.assign(requireFeed(data, params), {
      baseline_generation: params[3],
      observed_through_event_seq: params[4],
      applied_through_event_seq: params[5],
      highest_applied_event_seq: params[6],
      blocked_by_event_seq: params[7],
      updated_at: params[8],
    });
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE inventory_change_feed_state')) {
    Object.assign(requireFeed(data, params), {
      observed_through_event_seq: params[3],
      applied_through_event_seq: params[4],
      highest_applied_event_seq: params[5],
      blocked_by_event_seq: params[6],
      updated_at: params[7],
    });
    return { rows: [] };
  }
  if (sql.includes('SELECT MAX(event_seq)::TEXT AS event_seq')) {
    const objectId = params[3];
    const sequences = data.receipts
      .filter((row: ReceiptRow) => matchesBinding(row, params) && row.object_id === objectId)
      .map((row: ReceiptRow) => BigInt(row.event_seq));
    const max = sequences.length
      ? sequences.reduce((left, right) => (left > right ? left : right))
      : null;
    return { rows: [{ event_seq: max?.toString() ?? null }] };
  }
  if (sql.includes('FROM inventory_event_receipts')) {
    const sequences = params[3] as string[];
    return {
      rows: data.receipts
        .filter(
          (row: ReceiptRow) => matchesBinding(row, params) && sequences.includes(row.event_seq)
        )
        .sort((left: ReceiptRow, right: ReceiptRow) =>
          Number(BigInt(left.event_seq) - BigInt(right.event_seq))
        ),
    };
  }
  if (sql.startsWith('INSERT INTO inventory_event_receipts')) {
    data.receipts.push(receiptRow(params));
    return { rows: [] };
  }
  if (sql === 'DELETE FROM item_stock_locations WHERE item_id = $1') {
    data.liveStock = data.liveStock.filter(
      (row: ItemStockLocationRow) => row.item_id !== params[0]
    );
    return { rows: [] };
  }
  if (sql === 'DELETE FROM items WHERE item_id = $1') {
    data.liveItems = data.liveItems.filter((row: ItemRow) => row.item_id !== params[0]);
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO items')) {
    data.liveItems = upsertBy(data.liveItems, paramsToItem(params), (row) => row.item_id);
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO item_stock_locations')) {
    data.liveStock = upsertBy(data.liveStock, paramsToStock(params), (row) => row.stock_row_id);
    return { rows: [] };
  }
  return queryBaseline(data, sql, params);
}

function queryBaseline(data: HarnessData, sql: string, params: unknown[]): QueryResult {
  if (sql.startsWith('INSERT INTO inventory_baseline_runs')) {
    if (
      !data.runs.some(
        (row: BaselineRunRow) => matchesBinding(row, params) && row.run_id === params[3]
      )
    ) {
      data.runs.push(baselineRow(params));
      return { rows: [{ run_id: params[3] }] };
    }
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO inventory_baseline_root_items')) {
    data.rootItems.push({
      run_id: params[3] as string,
      root_position: params[4] as number,
      item_id: params[5] as string,
    });
    return { rows: [] };
  }
  if (sql.includes('FROM inventory_baseline_runs') && sql.includes('run_id=$4')) {
    return {
      rows: data.runs.filter(
        (row: BaselineRunRow) => matchesBinding(row, params) && row.run_id === params[3]
      ),
    };
  }
  if (sql.includes('SELECT staged.item_payload')) {
    return {
      rows: data.rootItems
        .filter((root: { run_id: string }) => root.run_id === params[3])
        .sort(
          (left: { root_position: number }, right: { root_position: number }) =>
            left.root_position - right.root_position
        )
        .map((root: { item_id: string }) => ({
          item_payload: data.stagingItems.find(
            (row: { item_id: string }) => row.item_id === root.item_id
          )?.item_payload,
        })),
    };
  }
  if (sql.includes('FROM inventory_baseline_root_items')) {
    return {
      rows: data.rootItems
        .filter((row: { run_id: string }) => row.run_id === params[3])
        .sort(
          (left: { root_position: number }, right: { root_position: number }) =>
            left.root_position - right.root_position
        ),
    };
  }
  if (sql.includes('SELECT status FROM inventory_staging_progress')) {
    return {
      rows: data.progress.filter(
        (row: StagingProgressRow) => matchesRun(row, params) && row.item_id === params[4]
      ),
    };
  }
  if (sql.startsWith('DELETE FROM inventory_staging_items')) {
    data.stagingItems = data.stagingItems.filter(
      (row: { run_id: string; item_id: string }) =>
        row.run_id !== params[3] || row.item_id !== params[4]
    );
    data.stagingStock = data.stagingStock.filter(
      (row: { run_id: string; stock_payload: ItemStockLocationRow }) =>
        row.run_id !== params[3] || row.stock_payload.item_id !== params[4]
    );
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO inventory_staging_items')) {
    data.stagingItems.push({
      run_id: params[3] as string,
      item_id: params[4] as string,
      item_payload: JSON.parse(String(params[5])) as ItemRow,
    });
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO inventory_staging_stock_locations')) {
    data.stagingStock.push({
      run_id: params[3] as string,
      stock_row_id: params[4] as string,
      stock_payload: JSON.parse(String(params[6])) as ItemStockLocationRow,
    });
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO inventory_staging_progress') && sql.includes("'failed'")) {
    upsertProgress(data, {
      run_id: params[3] as string,
      item_id: params[4] as string,
      status: 'failed',
      attempt_count: params[5] as number,
      error_code: params[6] as string,
      error_message: params[7] as string,
      updated_at: params[8] as number,
    });
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO inventory_staging_progress') && sql.includes("'staged'")) {
    upsertProgress(data, {
      run_id: params[3] as string,
      item_id: params[4] as string,
      status: 'staged',
      attempt_count: 1,
      error_code: null,
      error_message: null,
      updated_at: params[5] as number,
    });
    return { rows: [] };
  }
  if (sql.includes('SELECT item_id, status, attempt_count')) {
    return {
      rows: data.progress
        .filter((row: StagingProgressRow) => matchesRun(row, params))
        .sort((left: StagingProgressRow, right: StagingProgressRow) =>
          left.item_id.localeCompare(right.item_id)
        ),
    };
  }
  if (sql.includes('COUNT(*) FILTER')) {
    const rows = data.progress.filter((row: StagingProgressRow) => matchesRun(row, params));
    return {
      rows: [
        {
          staged_count: String(
            rows.filter((row: StagingProgressRow) => row.status === 'staged').length
          ),
          failed_count: String(
            rows.filter((row: StagingProgressRow) => row.status === 'failed').length
          ),
        },
      ],
    };
  }
  if (sql.includes('SELECT stock_payload FROM inventory_staging_stock_locations')) {
    return {
      rows: data.stagingStock
        .filter((row: { run_id: string }) => row.run_id === params[3])
        .sort((left: { stock_row_id: string }, right: { stock_row_id: string }) =>
          left.stock_row_id.localeCompare(right.stock_row_id)
        ),
    };
  }
  if (sql === "DELETE FROM item_stock_locations WHERE cache_source='api'") {
    data.liveStock = data.liveStock.filter(
      (row: ItemStockLocationRow) => row.cache_source !== 'api'
    );
    return { rows: [] };
  }
  if (sql === "DELETE FROM items WHERE cache_source='api'") {
    data.liveItems = data.liveItems.filter((row: ItemRow) => row.cache_source !== 'api');
    return { rows: [] };
  }
  if (sql.includes("SELECT value FROM cache_meta WHERE key='state' FOR UPDATE")) {
    return { rows: data.state ? [{ value: JSON.stringify(data.state) }] : [] };
  }
  if (sql.startsWith("INSERT INTO cache_meta(key,value) VALUES('state'")) {
    data.state = JSON.parse(String(params[0]));
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO cache_meta(key,value) VALUES($1,$2)')) return { rows: [] };
  if (sql.startsWith('UPDATE inventory_baseline_runs')) {
    const run = data.runs.find(
      (row: BaselineRunRow) => matchesBinding(row, params) && row.run_id === params[3]
    );
    if (!run) throw new Error('Missing fake baseline run.');
    Object.assign(run, {
      status: 'promoted',
      updated_at: params[4],
      promoted_at: params[4],
      promoted_meta: JSON.parse(String(params[5])),
    });
    return { rows: [] };
  }
  if (sql.includes('SELECT promoted_meta FROM inventory_baseline_runs')) {
    return {
      rows: data.runs.filter(
        (row: BaselineRunRow) =>
          matchesBinding(row, params) && row.generation === params[3] && row.status === 'promoted'
      ),
    };
  }
  return { rows: [] };
}

function feedRow(params: unknown[]): FeedStateRow {
  return {
    account_identity: params[0] as string,
    ledger_database_id: params[1] as string,
    consumer_name: params[2] as string,
    baseline_generation: null,
    observed_through_event_seq: null,
    applied_through_event_seq: null,
    highest_applied_event_seq: null,
    blocked_by_event_seq: null,
    updated_at: params[3] as number,
  };
}

function baselineRow(params: unknown[]): BaselineRunRow {
  return {
    account_identity: params[0] as string,
    ledger_database_id: params[1] as string,
    consumer_name: params[2] as string,
    run_id: params[3] as string,
    generation: params[4] as string,
    start_event_seq: params[5] as string,
    root_fingerprint: params[6] as string,
    expected_item_count: params[7] as number,
    status: params[8] as 'active',
    started_at: params[9] as number,
    updated_at: params[10] as number,
    promoted_at: null,
    failure_code: null,
  };
}

function receiptRow(params: unknown[]): ReceiptRow {
  return {
    account_identity: params[0] as string,
    ledger_database_id: params[1] as string,
    consumer_name: params[2] as string,
    receipt_id: params[3] as string,
    event_seq: params[4] as string,
    event_type: params[5] as InventoryEventReceipt['eventType'],
    object_id: params[6] as string,
    applied_action: params[7] as InventoryEventReceipt['appliedAction'],
    hydration_outcome: params[8] as InventoryEventReceipt['hydrationOutcome'],
    materialization_outcome: params[9] as InventoryEventReceipt['materializationOutcome'],
    cache_generation: params[10] as string,
    source_fingerprint: params[11] as string | null,
    committed_at: params[12] as number,
  };
}

function requireFeed(data: HarnessData, params: unknown[]): FeedStateRow {
  const state = data.states.find((row: FeedStateRow) => matchesBinding(row, params));
  if (!state) throw new Error('Missing fake feed state.');
  return state;
}

function matchesBinding(
  row: { account_identity: string; ledger_database_id: string; consumer_name: string },
  params: unknown[]
): boolean {
  return (
    row.account_identity === params[0] &&
    row.ledger_database_id === params[1] &&
    row.consumer_name === params[2]
  );
}

function matchesRun(row: { run_id: string }, params: unknown[]): boolean {
  return row.run_id === params[3];
}

function upsertProgress(data: HarnessData, next: StagingProgressRow): void {
  const existing = data.progress.find(
    (row: StagingProgressRow) => row.run_id === next.run_id && row.item_id === next.item_id
  );
  if (!existing) data.progress.push(next);
  else Object.assign(existing, next, { attempt_count: Number(existing.attempt_count) + 1 });
}

function upsertBy<T>(rows: T[], row: T, key: (value: T) => string): T[] {
  return [...rows.filter((candidate) => key(candidate) !== key(row)), row];
}

async function promoteEmptyBaseline(
  store: PostgresInventoryChangeFeedStore,
  startEventSeq: string
): Promise<void> {
  const runId = `33333333-3333-4333-8333-${startEventSeq.padStart(12, '0')}`;
  await store.beginInventoryBaselineRun({
    ...binding,
    runId,
    generation: 'generation-1',
    startEventSeq,
    rootFingerprint: createInventoryBaselineRootFingerprint(binding.accountIdentity, []),
    rootItemIds: [],
    expectedItemCount: 0,
    status: 'active',
    startedAt: 100,
    updatedAt: 101,
    promotedAt: null,
    failureCode: null,
  });
  await store.promoteInventoryBaselineRun({ ...binding, runId, promotedAt: 110 });
}

function bundleApplication(
  overrides: Partial<InventoryItemBundleApplication> & { eventSeqs: string[] }
): InventoryItemBundleApplication {
  const rows = [stock()];
  return {
    ...binding,
    cacheGeneration: 'generation-1',
    item: item(),
    stockRows: rows,
    events: overrides.eventSeqs.map((seq) => event(seq, item().item_id)),
    hydrationOutcome: 'found_current',
    sourceFingerprint: createInventoryItemBundleFingerprint(binding.accountIdentity, item(), rows),
    expectedHighestAppliedEventSeq: overrides.expectedHighestAppliedEventSeq ?? '10',
    committedAt: overrides.committedAt ?? 125,
    ...overrides,
  };
}

function event(
  seq: string,
  objectId: string,
  eventType: InventoryEventReceiptInput['eventType'] = 'inventory.item_updated'
): InventoryEventReceiptInput {
  return { eventSeq: seq, eventType, objectId };
}

function receipt(
  eventInput: InventoryEventReceiptInput,
  application: InventoryItemBundleApplication,
  appliedAction: InventoryEventReceipt['appliedAction'],
  hydrationOutcome: InventoryEventReceipt['hydrationOutcome'],
  materializationOutcome: InventoryEventReceipt['materializationOutcome'],
  sourceFingerprint = application.sourceFingerprint ?? null
): InventoryEventReceipt {
  return {
    ...binding,
    receiptId: createInventoryEventReceiptId(binding, eventInput.eventSeq),
    eventSeq: eventInput.eventSeq,
    eventType: eventInput.eventType,
    objectId: application.item.item_id,
    appliedAction,
    hydrationOutcome,
    materializationOutcome,
    cacheGeneration: application.cacheGeneration,
    sourceFingerprint,
    committedAt: application.committedAt,
  };
}

function item(index = 1): ItemRow {
  return {
    item_id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    name: `Item ${index}`,
    quantity: index,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function stock(index = 1): ItemStockLocationRow {
  return {
    stock_row_id: `stock-${index}`,
    item_id: item(index).item_id,
    quantity_on_hand: index,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function paramsToItem(params: unknown[]): ItemRow {
  return {
    item_id: params[0] as string,
    name: params[2] as string,
    quantity: params[9] as number,
    cache_source: params[22] as 'api',
    source_api_version: params[24] as '3',
  };
}

function paramsToStock(params: unknown[]): ItemStockLocationRow {
  return {
    stock_row_id: params[0] as string,
    item_id: params[1] as string,
    quantity_on_hand: params[8] as number,
    quantity_reserved: params[9] as number | null,
    quantity_available: params[10] as number | null,
    quantity_incoming: params[11] as number | null,
    in_transit: params[12] as number | null,
    cache_source: params[17] as 'api',
    source_api_version: params[19] as '3',
  };
}

interface HarnessData {
  states: FeedStateRow[];
  receipts: ReceiptRow[];
  runs: BaselineRunRow[];
  rootItems: Array<{ run_id: string; root_position: number; item_id: string }>;
  stagingItems: Array<{ run_id: string; item_id: string; item_payload: ItemRow }>;
  stagingStock: Array<{
    run_id: string;
    stock_row_id: string;
    stock_payload: ItemStockLocationRow;
  }>;
  progress: StagingProgressRow[];
  liveItems: ItemRow[];
  liveStock: ItemStockLocationRow[];
  state: CacheState | null;
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
  updated_at: number;
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
  committed_at: number;
}

interface BaselineRunRow {
  account_identity: string;
  ledger_database_id: string;
  consumer_name: string;
  run_id: string;
  generation: string;
  start_event_seq: string;
  root_fingerprint: string;
  expected_item_count: number;
  status: InventoryBaselineRun['status'];
  started_at: number;
  updated_at: number;
  promoted_at: number | null;
  failure_code: string | null;
  promoted_meta?: InventorySnapshot['meta'];
}

type StagingProgressRow = {
  run_id: string;
  item_id: string;
  status: 'staged' | 'failed';
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  updated_at: number;
};
