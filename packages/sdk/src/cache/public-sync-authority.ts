import type { CacheService } from './cache.interface.js';
import type {
  OfficialV3SyncRun,
  OfficialV3SyncState,
  OfficialV3SyncStatusSummary,
} from './official-v3-sync.types.js';

export type PublicCacheSyncAuthority =
  | { authority: 'legacy' }
  | OfficialV3PublicCacheSyncAuthority;

export interface OfficialV3PublicCacheSyncAuthority {
  authority: 'official_v3';
  status: 'available' | 'unavailable';
  syncHealth: 'healthy' | 'stale' | 'active' | 'incomplete' | 'failed' | 'unavailable';
  freshness: 'FRESH' | 'STALE';
  isStale: boolean;
  lastAppliedAt: number | null;
  lastAttemptAt: number | null;
  coverage: 'partial_catch_up';
  syncStatus: Record<string, unknown>;
}

interface OfficialV3StatusCache {
  getOfficialV3SyncState(): Promise<OfficialV3SyncState | null>;
  getOfficialV3SyncRun(): Promise<OfficialV3SyncRun | null>;
  getOfficialV3SyncStatus(): Promise<OfficialV3SyncStatusSummary | null>;
}

/**
 * Select the durable official V3 state when a PostgreSQL cache exposes it.
 * A present-but-unreadable or inconsistent official state stays authoritative
 * and is reported unavailable, so callers never fall back to stale legacy metadata.
 */
export async function readPublicCacheSyncAuthority(
  cache: CacheService,
  options: { staleThresholdSeconds: number; nowSeconds?: number }
): Promise<PublicCacheSyncAuthority> {
  const official = asOfficialV3StatusCache(cache);
  if (!official) return { authority: 'legacy' };

  try {
    const [state, run] = await Promise.all([
      official.getOfficialV3SyncState(),
      official.getOfficialV3SyncRun(),
    ]);
    if (!state && !run) return { authority: 'legacy' };
    if (!state || !run) return unavailableOfficialAuthority();

    const summary = await official.getOfficialV3SyncStatus();
    if (!summary || !sameRun(summary, run) || !sameState(summary, state))
      return unavailableOfficialAuthority();

    return projectPublicCacheSyncAuthority(summary, options);
  } catch {
    return unavailableOfficialAuthority();
  }
}

function asOfficialV3StatusCache(cache: CacheService): OfficialV3StatusCache | null {
  const candidate = cache as Partial<OfficialV3StatusCache>;
  return typeof candidate.getOfficialV3SyncState === 'function' &&
    typeof candidate.getOfficialV3SyncRun === 'function' &&
    typeof candidate.getOfficialV3SyncStatus === 'function'
    ? (candidate as OfficialV3StatusCache)
    : null;
}

/** Project an already-read official status without performing another store read. */
export function projectPublicCacheSyncAuthority(
  summary: OfficialV3SyncStatusSummary,
  options: { staleThresholdSeconds: number; nowSeconds?: number }
): OfficialV3PublicCacheSyncAuthority {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const lastAppliedAt = successfulApplicationTimestamp(summary);
  const lastAttemptAt = timestampOrNull(summary.run.updatedAt);
  if (lastAttemptAt === null) return unavailableOfficialAuthority();

  const hasFailures = summary.run.status === 'failed' || summary.tasks.failed > 0;
  const incomplete =
    summary.run.status === 'running' ||
    summary.run.status === 'success_with_warnings' ||
    !summary.run.ingestionComplete ||
    summary.tasks.pending > 0 ||
    summary.state.cursorGap;
  const freshByAge =
    lastAppliedAt !== null &&
    nowSeconds >= lastAppliedAt &&
    nowSeconds - lastAppliedAt <= options.staleThresholdSeconds;
  const syncHealth = hasFailures
    ? 'failed'
    : summary.run.status === 'running'
      ? 'active'
      : incomplete
        ? 'incomplete'
        : freshByAge
          ? 'healthy'
          : 'stale';
  const isStale = syncHealth !== 'healthy';

  return {
    authority: 'official_v3',
    status: 'available',
    syncHealth,
    freshness: isStale ? 'STALE' : 'FRESH',
    isStale,
    lastAppliedAt,
    lastAttemptAt,
    coverage: 'partial_catch_up',
    syncStatus: {
      status: summary.run.status,
      run_id: summary.run.runId,
      latest_attempt_at: lastAttemptAt,
      latest_successful_application_at: lastAppliedAt,
      ingestion_complete: summary.run.ingestionComplete,
      page_count: summary.run.pageCount,
      cursor_gap: summary.state.cursorGap,
      tasks: summary.tasks,
      failures: summary.failures,
      coverage: 'partial_catch_up',
    },
  };
}

function unavailableOfficialAuthority(): OfficialV3PublicCacheSyncAuthority {
  return {
    authority: 'official_v3',
    status: 'unavailable',
    syncHealth: 'unavailable',
    freshness: 'STALE',
    isStale: true,
    lastAppliedAt: null,
    lastAttemptAt: null,
    coverage: 'partial_catch_up',
    syncStatus: {
      status: 'unavailable',
      message: 'Official V3 sync state is unavailable. Check cache sync-v3 --status.',
      coverage: 'partial_catch_up',
    },
  };
}

function sameRun(summary: OfficialV3SyncStatusSummary, run: OfficialV3SyncRun): boolean {
  return summary.run.runId === run.runId && summary.run.status === run.status;
}

function sameState(summary: OfficialV3SyncStatusSummary, state: OfficialV3SyncState): boolean {
  return (
    summary.state.updatedAt === state.updatedAt &&
    summary.state.appliedGeneration === state.appliedGeneration &&
    summary.state.nextGeneration === state.nextGeneration
  );
}

function timestampOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** State timestamps also move during ingestion, so only a clean successful run can timestamp application. */
function successfulApplicationTimestamp(summary: OfficialV3SyncStatusSummary): number | null {
  return summary.run.status === 'success' &&
    summary.tasks.failed === 0 &&
    summary.tasks.pending === 0 &&
    !summary.state.cursorGap
    ? timestampOrNull(summary.run.finishedAt)
    : null;
}
