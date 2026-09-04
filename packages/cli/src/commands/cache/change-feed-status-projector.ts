import type {
  ActiveChangeFeedSyncRun,
  ChangeFeedConsumerStatus,
  ChangeFeedContractPreflight,
  InventoryChangeFeedState,
} from '@salesbinder/sdk';
import {
  PostgresChangeFeedRepository,
  SALESBINDER_CLI_INVENTORY_CONSUMER,
  type CacheService,
  type InventoryChangeFeedCache,
} from '@salesbinder/sdk';
import { loadChangeFeedConfig } from './change-feed-config.js';

export interface ChangeFeedStatusProjection {
  configured: boolean;
  cache: Record<string, unknown> | 'not_initialized';
  ledger:
    | { configured: false }
    | { configured: true; reachable: false; error: string }
    | Record<string, unknown>;
}

export async function readChangeFeedStatus(input: {
  backend: 'sqlite' | 'postgresql';
  cache: CacheService;
  accountIdentity: string;
}): Promise<ChangeFeedStatusProjection> {
  const config = loadChangeFeedConfig();
  const feedCache = asFeedCache(input.cache);
  const cacheState = feedCache
    ? await feedCache.getInventoryChangeFeedStateByConsumer(
        input.accountIdentity,
        SALESBINDER_CLI_INVENTORY_CONSUMER
      )
    : null;
  if (!config) return projectChangeFeedStatus({ configured: false, cacheState });
  if (input.backend !== 'postgresql') {
    return projectChangeFeedStatus({
      configured: true,
      cacheState,
      ledgerUnavailable: true,
    });
  }

  const ledger = new PostgresChangeFeedRepository({
    databaseUrl: config.databaseUrl,
    accountIdentity: input.accountIdentity,
    ...(cacheState ? { expectedLedgerDatabaseId: cacheState.ledgerDatabaseId } : {}),
  });
  try {
    const preflight = await ledger.preflight();
    const [ledgerStatus, activeRun] = await Promise.all([
      ledger.getStatus(),
      ledger.getActiveSyncRun(),
    ]);
    return projectChangeFeedStatus({
      configured: true,
      cacheState,
      preflight,
      ledgerStatus,
      activeRun,
    });
  } catch {
    return projectChangeFeedStatus({
      configured: true,
      cacheState,
      ledgerUnavailable: true,
    });
  } finally {
    await ledger.close().catch(() => undefined);
  }
}

/** Allowlist cache/ledger state so connection strings and raw database errors cannot escape. */
export function projectChangeFeedStatus(input: {
  configured: boolean;
  cacheState: InventoryChangeFeedState | null;
  preflight?: ChangeFeedContractPreflight | null;
  ledgerStatus?: ChangeFeedConsumerStatus | null;
  activeRun?: ActiveChangeFeedSyncRun | null;
  ledgerUnavailable?: boolean;
}): ChangeFeedStatusProjection {
  return {
    configured: input.configured,
    cache: projectCacheState(input.cacheState),
    ledger: !input.configured
      ? { configured: false }
      : input.ledgerUnavailable || !input.preflight || !input.ledgerStatus
        ? {
            configured: true,
            reachable: false,
            error: 'Change-feed ledger status is unavailable.',
          }
        : projectLedgerState(input.preflight, input.ledgerStatus, input.activeRun ?? null),
  };
}

function projectCacheState(
  state: InventoryChangeFeedState | null
): Record<string, unknown> | 'not_initialized' {
  if (!state) return 'not_initialized';
  return {
    consumer: safeText(state.consumerName),
    ledger_database_id: safeUuid(state.ledgerDatabaseId),
    baseline_generation: safeTextOrNull(state.baselineGeneration),
    observed_through_event_seq: safeSequenceOrNull(state.observedThroughEventSeq),
    applied_through_event_seq: safeSequenceOrNull(state.appliedThroughEventSeq),
    highest_applied_event_seq: safeSequenceOrNull(state.highestAppliedEventSeq),
    blocked_by_event_seq: safeSequenceOrNull(state.blockedByEventSeq),
    updated_at: safeTimestamp(state.updatedAt),
  };
}

function projectLedgerState(
  preflight: ChangeFeedContractPreflight,
  status: ChangeFeedConsumerStatus,
  activeRun: ActiveChangeFeedSyncRun | null
): Record<string, unknown> {
  return {
    configured: true,
    reachable: true,
    contract_version: preflight.contractVersion,
    consumer: safeText(preflight.consumerName),
    ledger_database_id: safeUuid(preflight.ledgerDatabaseId),
    observed_through_event_seq: safeSequenceOrNull(status.observedThroughEventSeq),
    applied_through_event_seq: safeSequenceOrNull(status.appliedThroughEventSeq),
    blocked_by_event_seq: safeSequenceOrNull(status.blockedByEventSeq),
    queued_count: safeCount(status.queuedCount),
    retry_count: safeCount(status.retryCount),
    dead_letter_count: safeCount(status.deadLetterCount),
    last_event_at: status.lastEventReceivedAt?.toISOString() ?? null,
    active_run: activeRun
      ? {
          kind: activeRun.runKind,
          status: activeRun.status,
          start_event_seq: safeSequenceOrNull(activeRun.startEventSeq),
          target_event_seq: safeSequenceOrNull(activeRun.cutoverTargetEventSeq),
          baseline_generation: safeTextOrNull(activeRun.baselineCacheGeneration),
        }
      : null,
  };
}

function safeSequenceOrNull(value: string | null): string | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n ? value : null;
  } catch {
    return null;
  }
}

function safeCount(value: string): string {
  return /^(0|[1-9]\d*)$/.test(value) ? value : '0';
}

function safeTimestamp(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeTextOrNull(value: string | null): string | null {
  return value === null ? null : safeText(value);
}

function safeText(value: string): string {
  return /^[a-zA-Z0-9:._-]{1,200}$/.test(value) ? value : 'invalid';
}

function safeUuid(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : 'invalid';
}

function asFeedCache(cache: CacheService): InventoryChangeFeedCache | null {
  const candidate = cache as Partial<InventoryChangeFeedCache>;
  return typeof candidate.getInventoryChangeFeedStateByConsumer === 'function'
    ? (candidate as InventoryChangeFeedCache)
    : null;
}
