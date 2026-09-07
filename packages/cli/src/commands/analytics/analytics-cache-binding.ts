import type { CacheAccountBinding, CacheService } from '@salesbinder/sdk';
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
}

/** Decide refresh mode from cache freshness, never from the local CLI alias. */
export function getAnalyticsSyncDecision(
  forceRefresh: boolean,
  state: CacheState | null,
  cacheStale: boolean
): AnalyticsSyncDecision {
  return {
    shouldSync: forceRefresh || !state || cacheStale,
    full: forceRefresh || !state,
  };
}
