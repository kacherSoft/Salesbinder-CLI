import { readPublicCacheSyncAuthority, type CacheService, type CacheState } from '@salesbinder/sdk';

interface AnalyticsReadOptions {
  refresh?: boolean;
  cached?: boolean;
}

/** Reject the former implicit writer option, including when combined with --cached. */
export function assertAnalyticsReadOptions(options: AnalyticsReadOptions): void {
  if (options.refresh) {
    throw new Error(
      'Analytics is read-only; --refresh is unsupported. Run cache sync-v3 for official V3 caches or cache sync for legacy caches, then retry analytics.'
    );
  }
}

/** Match cache-status threshold precedence for every analytics freshness gate. */
export function resolveAnalyticsStaleThreshold(preference: unknown): number {
  const configured = process.env.SALESBINDER_CACHE_STALE_SECONDS?.trim();
  const value: number = configured
    ? /^\d+$/.test(configured)
      ? Number(configured)
      : Number.NaN
    : typeof preference === 'number'
      ? preference
      : 3600;
  return Number.isSafeInteger(value) && value >= 0 ? value : 3600;
}

export function isLegacyAnalyticsCacheStale(
  state: CacheState | null,
  staleThresholdSeconds: number
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return !state ||
    !Number.isSafeInteger(state.lastSync) ||
    state.lastSync <= 0 ||
    state.lastSync > now ||
    now - state.lastSync > staleThresholdSeconds;
}

/** Check readiness without initializing a cache, updating ownership, or starting a writer. */
export async function assertAnalyticsCacheReadable(
  cache: CacheService,
  options: AnalyticsReadOptions,
  staleThresholdSeconds: number
): Promise<void> {
  assertAnalyticsReadOptions(options);
  if (options.cached) return;

  const authority = await readPublicCacheSyncAuthority(cache, { staleThresholdSeconds });
  if (authority.authority === 'official_v3') {
    if (authority.syncHealth !== 'healthy') {
      const nextCommand = authority.syncHealth === 'stale'
        ? 'cache sync-v3'
        : authority.syncHealth === 'active' || authority.syncHealth === 'unavailable'
          ? 'cache sync-v3 --status'
          : 'cache sync-v3 --resume';
      throw new Error(
        `Official V3 cache is ${authority.syncHealth}. Analytics is read-only. Run ${nextCommand}, then retry, or use --cached to query the current snapshot explicitly.`
      );
    }
    return;
  }

  const state = await cache.getCacheState();
  const syncStatus = await cache.getSyncStatus();
  const problem = !state || state.lastSync <= 0
    ? 'uninitialized'
    : syncStatus && syncStatus.status !== 'success'
      ? syncStatus.status
      : isLegacyAnalyticsCacheStale(state, staleThresholdSeconds)
        ? 'stale'
        : null;
  if (problem) {
    throw new Error(
      `Legacy cache is ${problem}. Analytics is read-only. Run cache sync explicitly, then retry, or use --cached to query the current snapshot explicitly.`
    );
  }
}
