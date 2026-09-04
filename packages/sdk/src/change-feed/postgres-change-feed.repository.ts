import type { Pool, QueryResultRow } from 'pg';
import {
  SALESBINDER_CLI_INVENTORY_CONSUMER,
} from './change-feed.constants.js';
import {
  ChangeFeedRepositoryError,
  invalidInput,
  invalidResponse,
} from './change-feed.errors.js';
import {
  mapActiveRunRow,
  mapClaimRows,
  mapFailureRow,
  mapPreflightRow,
  mapProgressRow,
  mapStatusRow,
  mapTerminalStatus,
} from './change-feed-row-mappers.js';
import type {
  ActiveChangeFeedSyncRun,
  BeginChangeFeedSyncRun,
  ChangeFeedConsumerStatus,
  ChangeFeedContractPreflight,
  ChangeFeedFailureResult,
  ChangeFeedProgress,
  ChangeFeedRepository,
  ChangeFeedSyncBarrier,
  ChangeFeedTerminalStatus,
  ClaimedChangeFeedEvent,
  ClaimChangeFeedOptions,
  CompleteChangeFeedEvent,
  FailChangeFeedEvent,
  FailChangeFeedSyncRun,
  PostgresChangeFeedRepositoryOptions,
  RenewChangeFeedLease,
  VerifiedBaselineReceipt,
} from './change-feed.types.js';
import {
  assertFailureCode,
  assertInputDate,
  assertInputEventSequence,
  assertInputInteger,
  assertInputRecord,
  assertInputText,
  assertInputUuid,
  assertResponseCount,
  assertResponseDate,
  assertResponseEventSequence,
  assertResponseUuid,
  assertSafeErrorMessage,
} from './change-feed.validation.js';
import { PostgresChangeFeedQueryRunner } from './postgres-change-feed-query-runner.js';

type Row = QueryResultRow & Record<string, unknown>;
const RUN_KINDS = new Set(['initial_full_sync', 'cutover_replay', 'reconciliation']);
const HYDRATION_OUTCOMES = new Set([
  'found_current',
  'found_archived',
  'expected_tombstone',
]);

export class PostgresChangeFeedRepository implements ChangeFeedRepository {
  readonly #accountIdentity: string;
  #verifiedLedgerDatabaseId?: string;
  #verifiedPreflight?: ChangeFeedContractPreflight;
  readonly #runner: PostgresChangeFeedQueryRunner;

  constructor(options: PostgresChangeFeedRepositoryOptions) {
    assertInputRecord(options, 'repository options');
    assertTransportOptions(options);
    this.#accountIdentity = assertInputText(options.accountIdentity, 'account identity');
    this.#verifiedLedgerDatabaseId =
      options.expectedLedgerDatabaseId === undefined
        ? undefined
        : assertInputUuid(options.expectedLedgerDatabaseId, 'expected ledger database ID');
    this.#runner = new PostgresChangeFeedQueryRunner(options);
  }

  async preflight(): Promise<ChangeFeedContractPreflight> {
    const row = this.#single(
      await this.#query(
        `SELECT contract_version, ledger_database_id::text, account_identity,
                consumer_name, event_type_prefix, subscribed_event_types
           FROM public.get_change_feed_contract_preflight($1::text, $2::text)`,
        [this.#accountIdentity, SALESBINDER_CLI_INVENTORY_CONSUMER]
      ),
      'preflight'
    );
    const result = mapPreflightRow(row, this.#accountIdentity, this.#verifiedLedgerDatabaseId);
    this.#verifiedLedgerDatabaseId = result.ledgerDatabaseId;
    this.#verifiedPreflight = result;
    return result;
  }

  async getActiveSyncRun(): Promise<ActiveChangeFeedSyncRun | null> {
    this.#requirePreflight();
    const rows = await this.#query(
      `SELECT sync_run_id::text, consumer_name, run_kind, status, account_identity,
              start_event_seq::text, cutover_target_event_seq::text,
              baseline_receipt_id, baseline_cache_generation, baseline_verified_at,
              started_at, updated_at
         FROM public.get_active_change_feed_sync_run($1::text, $2::text)`,
      [this.#accountIdentity, SALESBINDER_CLI_INVENTORY_CONSUMER]
    );
    if (rows.length === 0) return null;
    return mapActiveRunRow(this.#single(rows, 'active sync-run inspection'), this.#accountIdentity);
  }

  async captureTarget(lockTimeoutMs: number): Promise<string | null> {
    this.#requirePreflight();
    assertInputInteger(lockTimeoutMs, 'lock timeout', 1, 9_000);
    const row = this.#single(
      await this.#query(
        `SELECT public.capture_change_feed_target($1::text, $2::integer)::text AS event_seq`,
        [SALESBINDER_CLI_INVENTORY_CONSUMER, lockTimeoutMs]
      ),
      'target capture'
    );
    return assertResponseEventSequence(row.event_seq, 'target barrier', true);
  }

  async claim(options: ClaimChangeFeedOptions): Promise<ClaimedChangeFeedEvent[]> {
    this.#requirePreflight();
    const bounds = validateClaim(options);
    const rows = await this.#query(
      `SELECT event_seq::text, provider_event_id, event_type, api_version,
              object_type, object_id, provider_created_at, received_at, raw_body,
              parsed_payload, attempt_count, leased_until, lease_token::text
         FROM public.claim_change_feed_events(
           $1::text, $2::text, $3::integer, $4::integer, $5::bigint, $6::uuid
         )`,
      [
        SALESBINDER_CLI_INVENTORY_CONSUMER,
        bounds.leaseOwner,
        bounds.batchSize,
        bounds.leaseSeconds,
        bounds.throughEventSeq,
        bounds.syncRunId,
      ]
    );
    return mapClaimRows(rows);
  }

  async renewLease(input: RenewChangeFeedLease): Promise<Date> {
    this.#requirePreflight();
    assertInputRecord(input, 'lease renewal input');
    const eventSeq = assertInputEventSequence(input.eventSeq, 'event sequence');
    const leaseOwner = assertInputText(input.leaseOwner, 'lease owner');
    const leaseToken = assertInputUuid(input.leaseToken, 'lease token');
    const leaseSeconds = assertInputInteger(input.leaseSeconds, 'lease seconds', 1, 900);
    const row = this.#single(
      await this.#query(
        `SELECT public.renew_change_feed_event_lease(
           $1::text, $2::bigint, $3::text, $4::uuid, $5::integer
         ) AS leased_until`,
        [SALESBINDER_CLI_INVENTORY_CONSUMER, eventSeq, leaseOwner, leaseToken, leaseSeconds]
      ),
      'lease renewal'
    );
    return assertResponseDate(row.leased_until, 'lease expiry');
  }

  async complete(input: CompleteChangeFeedEvent): Promise<ChangeFeedTerminalStatus> {
    this.#requirePreflight();
    assertInputRecord(input, 'lease completion input');
    const eventSeq = assertInputEventSequence(input.eventSeq, 'event sequence');
    const leaseOwner = assertInputText(input.leaseOwner, 'lease owner');
    const leaseToken = assertInputUuid(input.leaseToken, 'lease token');
    const receipt = validateReceipt(input.receipt);
    const row = this.#single(
      await this.#query(
        `SELECT public.complete_change_feed_event(
           $1::text, $2::bigint, $3::text, $4::uuid, $5::text, $6::text,
           $7::timestamptz, $8::text, $9::boolean
         ) AS status`,
        [
          SALESBINDER_CLI_INVENTORY_CONSUMER,
          eventSeq,
          leaseOwner,
          leaseToken,
          receipt.receiptId,
          receipt.cacheGeneration,
          receipt.committedAt,
          receipt.hydrationOutcome,
          true,
        ],
        input.operationSignal
      ),
      'lease completion'
    );
    return mapTerminalStatus(row.status);
  }

  async fail(input: FailChangeFeedEvent): Promise<ChangeFeedFailureResult> {
    this.#requirePreflight();
    const values = validateFailure(input);
    const row = this.#single(
      await this.#query(
        `SELECT status, next_attempt_at
           FROM public.fail_change_feed_event(
             $1::text, $2::bigint, $3::text, $4::uuid, $5::text, $6::text,
             $7::boolean, $8::integer, $9::integer, $10::integer
           )`,
        [SALESBINDER_CLI_INVENTORY_CONSUMER, ...values],
        input.operationSignal
      ),
      'lease failure transition'
    );
    return mapFailureRow(row);
  }

  async refreshProgress(): Promise<ChangeFeedProgress> {
    this.#requirePreflight();
    const row = this.#single(
      await this.#query(
        `SELECT observed_through_event_seq::text, applied_through_event_seq::text,
                blocked_by_event_seq::text
           FROM public.refresh_change_feed_progress($1::text)`,
        [SALESBINDER_CLI_INVENTORY_CONSUMER]
      ),
      'progress refresh'
    );
    return mapProgressRow(row);
  }

  async getStatus(): Promise<ChangeFeedConsumerStatus> {
    this.#requirePreflight();
    const row = this.#single(
      await this.#query(
        `SELECT observed_through_event_seq::text, applied_through_event_seq::text,
                blocked_by_event_seq::text, queued_count::text, retry_count::text,
                dead_letter_count::text, last_event_received_at
           FROM public.get_change_feed_consumer_status($1::text)`,
        [SALESBINDER_CLI_INVENTORY_CONSUMER]
      ),
      'consumer status inspection'
    );
    return mapStatusRow(row);
  }

  async beginSyncRun(input: BeginChangeFeedSyncRun): Promise<ChangeFeedSyncBarrier> {
    this.#requirePreflight();
    assertInputRecord(input, 'sync-run start input');
    if (!RUN_KINDS.has(input.runKind)) throw invalidInput('sync-run kind is invalid');
    const lockTimeoutMs = assertInputInteger(input.lockTimeoutMs, 'lock timeout', 1, 9_000);
    const row = this.#single(
      await this.#query(
        `SELECT sync_run_id::text, start_event_seq::text
           FROM public.begin_change_feed_sync_run($1::text, $2::text, $3::text, $4::integer)`,
        [this.#accountIdentity, SALESBINDER_CLI_INVENTORY_CONSUMER, input.runKind, lockTimeoutMs]
      ),
      'sync-run start'
    );
    return {
      syncRunId: assertResponseUuid(row.sync_run_id, 'sync-run ID'),
      eventSeq: assertResponseEventSequence(row.start_event_seq, 'start barrier', true),
    };
  }

  async verifyBaseline(syncRunId: string, receipt: VerifiedBaselineReceipt): Promise<void> {
    this.#requirePreflight();
    const runId = assertInputUuid(syncRunId, 'sync-run ID');
    const validated = validateBaselineReceipt(receipt);
    await this.#execute(
      `SELECT public.verify_change_feed_baseline(
         $1::uuid, $2::text, $3::text, $4::boolean, $5::boolean, $6::jsonb
       )`,
      [runId, validated.receiptId, validated.cacheGeneration, true, true, '[]']
    );
  }

  async captureSyncTarget(syncRunId: string, lockTimeoutMs: number): Promise<string | null> {
    this.#requirePreflight();
    const runId = assertInputUuid(syncRunId, 'sync-run ID');
    const timeout = assertInputInteger(lockTimeoutMs, 'lock timeout', 1, 9_000);
    const row = this.#single(
      await this.#query(
        `SELECT public.capture_change_feed_sync_target($1::uuid, $2::integer)::text AS event_seq`,
        [runId, timeout]
      ),
      'sync target capture'
    );
    return assertResponseEventSequence(row.event_seq, 'cutover target barrier', true);
  }

  async coverBaseline(syncRunId: string): Promise<string> {
    this.#requirePreflight();
    const runId = assertInputUuid(syncRunId, 'sync-run ID');
    const row = this.#single(
      await this.#query(
        `SELECT public.cover_change_feed_baseline_events($1::uuid, $2::text)::text AS covered_count`,
        [runId, SALESBINDER_CLI_INVENTORY_CONSUMER]
      ),
      'baseline coverage'
    );
    return assertResponseCount(row.covered_count, 'covered event count');
  }

  async promoteSyncRun(syncRunId: string): Promise<void> {
    this.#requirePreflight();
    await this.#execute(
      `SELECT public.promote_change_feed_sync_run($1::uuid, $2::text)`,
      [assertInputUuid(syncRunId, 'sync-run ID'), SALESBINDER_CLI_INVENTORY_CONSUMER]
    );
  }

  async failSyncRun(input: FailChangeFeedSyncRun): Promise<void> {
    this.#requirePreflight();
    assertInputRecord(input, 'sync-run failure input');
    await this.#execute(
      `SELECT public.fail_change_feed_sync_run($1::uuid, $2::text, $3::text, $4::text)`,
      [
        assertInputUuid(input.syncRunId, 'sync-run ID'),
        SALESBINDER_CLI_INVENTORY_CONSUMER,
        assertFailureCode(input.failureCode, 'failure code'),
        assertSafeErrorMessage(input.sanitizedReason, 'sanitized failure reason'),
      ]
    );
  }

  close(): Promise<void> {
    return this.#runner.close();
  }

  #query(sql: string, values: readonly unknown[], operationSignal?: AbortSignal): Promise<Row[]> {
    return this.#runner.query<Row>(sql, values, operationSignal);
  }

  async #execute(sql: string, values: readonly unknown[]): Promise<void> {
    this.#single(await this.#query(sql, values), 'change-feed transition');
  }

  #single(rows: Row[], operation: string): Row {
    if (rows.length !== 1 || rows[0] === undefined) {
      throw invalidResponse(`Change-feed ${operation} returned an unexpected row count`);
    }
    return rows[0];
  }

  #requirePreflight(): ChangeFeedContractPreflight {
    if (!this.#verifiedPreflight) {
      throw new ChangeFeedRepositoryError(
        'contract_state_conflict',
        'Change-feed contract preflight must succeed before this operation'
      );
    }
    return this.#verifiedPreflight;
  }
}

function assertDatabaseUrl(value: unknown): void {
  const databaseUrl = assertInputText(value, 'database URL', 8_192);
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error();
  } catch {
    throw invalidInput('database URL must be a valid PostgreSQL URL');
  }
}

function isPool(value: unknown): value is Pool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<'connect' | 'on' | 'removeListener' | 'end', unknown>>;
  return (
    typeof candidate.connect === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.removeListener === 'function' &&
    typeof candidate.end === 'function'
  );
}

function assertTransportOptions(options: PostgresChangeFeedRepositoryOptions): void {
  const databaseUrl = 'databaseUrl' in options ? options.databaseUrl : undefined;
  const pool = 'pool' in options ? options.pool : undefined;
  const hasDatabaseUrl = databaseUrl !== undefined;
  const hasPool = pool !== undefined;
  if (hasDatabaseUrl === hasPool) {
    throw invalidInput('repository options require exactly one database URL or PostgreSQL pool');
  }
  if (hasDatabaseUrl) {
    assertDatabaseUrl(databaseUrl);
    return;
  }
  if (!isPool(pool)) throw invalidInput('injected PostgreSQL pool is invalid');
}

function validateClaim(options: ClaimChangeFeedOptions): {
  leaseOwner: string;
  batchSize: number;
  leaseSeconds: number;
  throughEventSeq: string | null;
  syncRunId: string | null;
} {
  assertInputRecord(options, 'claim input');
  const leaseOwner = assertInputText(options.leaseOwner, 'lease owner');
  const batchSize = assertInputInteger(options.batchSize, 'batch size', 1, 100);
  const leaseSeconds = assertInputInteger(options.leaseSeconds, 'lease seconds', 1, 900);
  if (options.mode === 'ordinary') {
    if (options.syncRunId !== undefined) throw invalidInput('ordinary claim cannot include sync-run ID');
    return {
      leaseOwner,
      batchSize,
      leaseSeconds,
      throughEventSeq: assertInputEventSequence(options.throughEventSeq, 'target event sequence'),
      syncRunId: null,
    };
  }
  if (options.mode === 'replay') {
    if (options.throughEventSeq !== undefined) {
      throw invalidInput('replay claim cannot include target event sequence');
    }
    return {
      leaseOwner,
      batchSize,
      leaseSeconds,
      throughEventSeq: null,
      syncRunId: assertInputUuid(options.syncRunId, 'sync-run ID'),
    };
  }
  throw invalidInput('claim mode must be ordinary or replay');
}

function validateReceipt(receipt: CompleteChangeFeedEvent['receipt']) {
  assertInputRecord(receipt, 'cache receipt');
  if (receipt.receiptVerified !== true) throw invalidInput('cache receipt must be verified');
  if (!HYDRATION_OUTCOMES.has(receipt.hydrationOutcome)) {
    throw invalidInput('cache receipt hydration outcome is invalid');
  }
  return {
    receiptId: assertInputText(receipt.receiptId, 'cache receipt ID', 512),
    cacheGeneration: assertInputText(receipt.cacheGeneration, 'cache generation', 512),
    committedAt: assertInputDate(receipt.committedAt, 'cache commit time'),
    hydrationOutcome: receipt.hydrationOutcome,
  };
}

function validateFailure(input: FailChangeFeedEvent): readonly unknown[] {
  assertInputRecord(input, 'lease failure input');
  const maxAttempts = assertInputInteger(input.maxAttempts, 'maximum attempts', 1, 100);
  const baseDelay = assertInputInteger(input.baseDelaySeconds, 'base delay seconds', 1, 86_400);
  const maxDelay = assertInputInteger(input.maxDelaySeconds, 'maximum delay seconds', 1, 604_800);
  if (maxDelay < baseDelay) throw invalidInput('maximum delay must not be shorter than base delay');
  if (typeof input.retryable !== 'boolean') throw invalidInput('retryable must be boolean');
  return [
    assertInputEventSequence(input.eventSeq, 'event sequence'),
    assertInputText(input.leaseOwner, 'lease owner'),
    assertInputUuid(input.leaseToken, 'lease token'),
    assertFailureCode(input.errorCode, 'error code'),
    assertSafeErrorMessage(input.sanitizedErrorMessage, 'sanitized error message'),
    input.retryable,
    maxAttempts,
    baseDelay,
    maxDelay,
  ];
}

function validateBaselineReceipt(receipt: VerifiedBaselineReceipt) {
  assertInputRecord(receipt, 'baseline receipt');
  if (
    receipt.receiptVerified !== true ||
    receipt.coverageComplete !== true ||
    !Array.isArray(receipt.unresolvedExclusions) ||
    receipt.unresolvedExclusions.length !== 0
  ) {
    throw invalidInput('baseline receipt must prove complete verified coverage without exclusions');
  }
  return {
    receiptId: assertInputText(receipt.receiptId, 'baseline receipt ID', 512),
    cacheGeneration: assertInputText(receipt.cacheGeneration, 'baseline cache generation', 512),
  };
}
