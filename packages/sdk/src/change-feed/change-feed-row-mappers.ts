import {
  INVENTORY_CHANGE_FEED_API_VERSION,
  INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX,
  INVENTORY_CHANGE_FEED_EVENT_TYPES,
  INVENTORY_CHANGE_FEED_OBJECT_TYPE,
  SALESBINDER_CLI_INVENTORY_CONSUMER,
  type ChangeFeedInventoryEventType,
} from './change-feed.constants.js';
import { invalidResponse } from './change-feed.errors.js';
import type {
  ActiveChangeFeedSyncRun,
  ChangeFeedConsumerStatus,
  ChangeFeedContractPreflight,
  ChangeFeedFailureResult,
  ChangeFeedProgress,
  ChangeFeedTerminalStatus,
  ClaimedChangeFeedEvent,
} from './change-feed.types.js';
import {
  assertRecord,
  assertResponseCount,
  assertResponseDate,
  assertResponseEventSequence,
  assertResponseInteger,
  assertResponseText,
  assertResponseUuid,
  compareEventSequences,
} from './change-feed.validation.js';

type Row = Readonly<Record<string, unknown>>;
const EVENT_TYPES = new Set<string>(INVENTORY_CHANGE_FEED_EVENT_TYPES);
const RUN_KINDS = new Set(['initial_full_sync', 'cutover_replay', 'reconciliation']);
const RUN_STATUSES = new Set(['running', 'baseline_succeeded', 'replaying']);

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : assertResponseText(value, label, 512);
}

function nullableDate(value: unknown, label: string): Date | null {
  return value === null ? null : assertResponseDate(value, label);
}

function exactConsumerAndAccount(row: Row, accountIdentity: string): void {
  if (row.consumer_name !== SALESBINDER_CLI_INVENTORY_CONSUMER) {
    throw invalidResponse('Change-feed response contains an unexpected consumer');
  }
  if (row.account_identity !== accountIdentity) {
    throw invalidResponse('Change-feed response contains an unexpected account binding');
  }
}

export function mapPreflightRow(
  row: Row,
  accountIdentity: string,
  expectedLedgerDatabaseId?: string
): ChangeFeedContractPreflight {
  exactConsumerAndAccount(row, accountIdentity);
  if (row.contract_version !== 2 || row.event_type_prefix !== INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX) {
    throw invalidResponse('Change-feed contract version or prefix mismatch');
  }
  const ledgerDatabaseId = assertResponseUuid(row.ledger_database_id, 'ledger database ID');
  if (expectedLedgerDatabaseId !== undefined && ledgerDatabaseId !== expectedLedgerDatabaseId) {
    throw invalidResponse('Change-feed ledger database ID mismatch');
  }
  if (
    !Array.isArray(row.subscribed_event_types) ||
    row.subscribed_event_types.length !== INVENTORY_CHANGE_FEED_EVENT_TYPES.length ||
    row.subscribed_event_types.some(
      (eventType, index) => eventType !== INVENTORY_CHANGE_FEED_EVENT_TYPES[index]
    )
  ) {
    throw invalidResponse('Change-feed subscription set mismatch');
  }
  return {
    contractVersion: 2,
    ledgerDatabaseId,
    accountIdentity,
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    eventTypePrefix: INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX,
    subscribedEventTypes: INVENTORY_CHANGE_FEED_EVENT_TYPES,
  };
}

export function mapActiveRunRow(row: Row, accountIdentity: string): ActiveChangeFeedSyncRun {
  exactConsumerAndAccount(row, accountIdentity);
  if (!RUN_KINDS.has(String(row.run_kind)) || !RUN_STATUSES.has(String(row.status))) {
    throw invalidResponse('Change-feed response contains an invalid active sync-run state');
  }
  const result: ActiveChangeFeedSyncRun = {
    syncRunId: assertResponseUuid(row.sync_run_id, 'sync-run ID'),
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    runKind: row.run_kind as ActiveChangeFeedSyncRun['runKind'],
    status: row.status as ActiveChangeFeedSyncRun['status'],
    accountIdentity,
    startEventSeq: assertResponseEventSequence(row.start_event_seq, 'start barrier', true),
    cutoverTargetEventSeq: assertResponseEventSequence(
      row.cutover_target_event_seq,
      'cutover target barrier',
      true
    ),
    baselineReceiptId: nullableText(row.baseline_receipt_id, 'baseline receipt ID'),
    baselineCacheGeneration: nullableText(
      row.baseline_cache_generation,
      'baseline cache generation'
    ),
    baselineVerifiedAt: nullableDate(row.baseline_verified_at, 'baseline verification time'),
    startedAt: assertResponseDate(row.started_at, 'sync-run start time'),
    updatedAt: assertResponseDate(row.updated_at, 'sync-run update time'),
  };
  if (result.updatedAt.getTime() < result.startedAt.getTime()) {
    throw invalidResponse('Change-feed active sync-run timestamps are inconsistent');
  }
  if (
    result.startEventSeq !== null &&
    result.cutoverTargetEventSeq !== null &&
    compareEventSequences(result.startEventSeq, result.cutoverTargetEventSeq) > 0
  ) {
    throw invalidResponse('Change-feed active sync-run barriers are inconsistent');
  }
  if (
    result.status !== 'running' &&
    (result.baselineReceiptId === null ||
      result.baselineCacheGeneration === null ||
      result.baselineVerifiedAt === null)
  ) {
    throw invalidResponse('Change-feed active sync-run lacks verified baseline evidence');
  }
  return result;
}

function assertCanonicalPayload(
  payload: Readonly<Record<string, unknown>>,
  row: Row
): void {
  const data = assertRecord(payload.data, 'event payload data');
  const object = assertRecord(data.object, 'event payload object');
  assertResponseText(payload.account_id, 'payload account ID');
  const payloadCreatedAt = new Date(assertResponseText(payload.created_at, 'payload creation time'));
  const providerCreatedAt = assertResponseDate(row.provider_created_at, 'provider creation time');
  if (
    Number.isNaN(payloadCreatedAt.getTime()) ||
    payloadCreatedAt.getTime() !== providerCreatedAt.getTime() ||
    payload.id !== row.provider_event_id ||
    payload.type !== row.event_type ||
    payload.api_version !== row.api_version ||
    object.id !== row.object_id
  ) {
    throw invalidResponse('Change-feed canonical event does not match its stored payload');
  }
}

export function mapClaimRows(rows: Row[]): ClaimedChangeFeedEvent[] {
  let previousSequence: string | undefined;
  return rows.map((row) => {
    const eventSeq = assertResponseEventSequence(row.event_seq, 'event sequence', false);
    if (previousSequence !== undefined && compareEventSequences(previousSequence, eventSeq) >= 0) {
      throw invalidResponse('Change-feed claims are not in strict receive order');
    }
    previousSequence = eventSeq;
    if (!EVENT_TYPES.has(String(row.event_type))) {
      throw invalidResponse('Change-feed response contains an unsupported event type');
    }
    if (
      row.api_version !== INVENTORY_CHANGE_FEED_API_VERSION ||
      row.object_type !== INVENTORY_CHANGE_FEED_OBJECT_TYPE
    ) {
      throw invalidResponse('Change-feed response contains an unsupported event contract');
    }
    const parsedPayload = assertRecord(row.parsed_payload, 'parsed event payload');
    assertCanonicalPayload(parsedPayload, row);
    if (!Buffer.isBuffer(row.raw_body)) {
      throw invalidResponse('Change-feed response contains invalid raw event bytes');
    }
    return {
      eventSeq,
      providerEventId: assertResponseText(row.provider_event_id, 'provider event ID'),
      eventType: row.event_type as ChangeFeedInventoryEventType,
      apiVersion: INVENTORY_CHANGE_FEED_API_VERSION,
      objectType: INVENTORY_CHANGE_FEED_OBJECT_TYPE,
      objectId: assertResponseUuid(row.object_id, 'object ID'),
      providerCreatedAt: assertResponseDate(row.provider_created_at, 'provider creation time'),
      receivedAt: assertResponseDate(row.received_at, 'receive time'),
      rawBody: row.raw_body,
      parsedPayload,
      attemptCount: assertResponseInteger(row.attempt_count, 'attempt count', 1),
      leasedUntil: assertResponseDate(row.leased_until, 'lease expiry'),
      leaseToken: assertResponseUuid(row.lease_token, 'lease token'),
    };
  });
}

export function mapProgressRow(row: Row): ChangeFeedProgress {
  const result: ChangeFeedProgress = {
    observedThroughEventSeq: assertResponseEventSequence(
      row.observed_through_event_seq,
      'observed cursor',
      true
    ),
    appliedThroughEventSeq: assertResponseEventSequence(
      row.applied_through_event_seq,
      'applied cursor',
      true
    ),
    blockedByEventSeq: assertResponseEventSequence(row.blocked_by_event_seq, 'blocker', true),
  };
  if (
    result.appliedThroughEventSeq !== null &&
    (result.observedThroughEventSeq === null ||
      compareEventSequences(result.appliedThroughEventSeq, result.observedThroughEventSeq) > 0)
  ) {
    throw invalidResponse('Change-feed response contains inconsistent progress cursors');
  }
  if (
    result.blockedByEventSeq !== null &&
    (result.observedThroughEventSeq === null ||
      compareEventSequences(result.blockedByEventSeq, result.observedThroughEventSeq) > 0 ||
      (result.appliedThroughEventSeq !== null &&
        compareEventSequences(result.appliedThroughEventSeq, result.blockedByEventSeq) >= 0))
  ) {
    throw invalidResponse('Change-feed response contains inconsistent blocker progress');
  }
  return result;
}

export function mapStatusRow(row: Row): ChangeFeedConsumerStatus {
  return {
    ...mapProgressRow(row),
    queuedCount: assertResponseCount(row.queued_count, 'queued count'),
    retryCount: assertResponseCount(row.retry_count, 'retry count'),
    deadLetterCount: assertResponseCount(row.dead_letter_count, 'dead-letter count'),
    lastEventReceivedAt: nullableDate(row.last_event_received_at, 'last event receive time'),
  };
}

export function mapTerminalStatus(value: unknown): ChangeFeedTerminalStatus {
  if (value !== 'succeeded' && value !== 'superseded_by_succeeded') {
    throw invalidResponse('Change-feed completion returned an invalid terminal status');
  }
  return value;
}

export function mapFailureRow(row: Row): ChangeFeedFailureResult {
  if (row.status !== 'retry' && row.status !== 'dead_letter') {
    throw invalidResponse('Change-feed failure transition returned an invalid status');
  }
  return {
    status: row.status,
    nextAttemptAt: assertResponseDate(row.next_attempt_at, 'next attempt time'),
  };
}
