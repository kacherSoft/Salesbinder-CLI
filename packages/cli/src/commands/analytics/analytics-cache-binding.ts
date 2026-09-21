import { readPublicCacheSyncAuthority, type CacheAccountBinding, type CacheService } from '@salesbinder/sdk';
import type { CacheState } from '@salesbinder/sdk';

/**
 * Ensure the canonical cache owner immediately before analytics refreshes
 * documents. Cached-only queries deliberately do not call this helper, so
 * offline reads retain their existing behavior.
 */
export async function ensureAnalyticsCacheBinding(
  cache: CacheService,
  accountBinding: CacheAccountBinding
): Promise<void> {
  await cache.ensureAccountBinding(accountBinding);
}

export interface AnalyticsSyncDecision {
  shouldSync: boolean;
  full: boolean;
  error?: string;
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

/**
 * Official V3 cache state owns managed PostgreSQL freshness. It never triggers
 * the legacy document indexer, which would publish a second authority.
 */
export async function getAnalyticsSyncDecision(input: {
  cache: CacheService;
  forceRefresh: boolean;
  state: CacheState | null;
  readLegacyCacheStale: () => Promise<boolean>;
  staleThresholdSeconds: number;
}): Promise<AnalyticsSyncDecision> {
  const authority = await readPublicCacheSyncAuthority(input.cache, {
    staleThresholdSeconds: input.staleThresholdSeconds,
  });
  if (authority.authority === 'official_v3') {
    if (input.forceRefresh) {
      return {
        shouldSync: false,
        full: false,
        error:
          'Official V3 cache refresh is managed by cache sync-v3. Run cache sync-v3 --resume, then retry analytics.',
      };
    }
    if (authority.syncHealth !== 'healthy') {
      return {
        shouldSync: false,
        full: false,
        error: `Official V3 cache is ${authority.syncHealth}. Run cache sync-v3 --resume, or use --cached to query the current snapshot explicitly.`,
      };
    }
    return { shouldSync: false, full: false };
  }

  const cacheStale = await input.readLegacyCacheStale();
  return {
    shouldSync: input.forceRefresh || !input.state || cacheStale,
    full: input.forceRefresh || !input.state,
  };
}
