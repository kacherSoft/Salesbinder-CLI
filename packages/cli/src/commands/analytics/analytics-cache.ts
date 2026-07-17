import type {
  CacheState,
  CacheService,
  CacheSyncStatus,
  DocumentIndexerService as DocumentIndexer,
  SalesBinderClient,
} from '@salesbinder/sdk';

function assertAnalyticsCacheReady(
  state: CacheState | null,
  syncStatus: CacheSyncStatus | null,
  accountName: string,
  requireSuccessfulSyncStatus: boolean
): CacheState {
  if (!state) {
    throw Object.assign(
      new Error(
        'Analytics cache is uninitialized; '
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_SCHEMA_UNINITIALIZED' }
    );
  }
  if (state.accountName !== accountName) {
    throw Object.assign(
      new Error(
        `Cache belongs to account "${state.accountName}". `
        + `Use a separate database/cache for "${accountName}" or explicitly clear `
        + 'the existing cache before switching accounts.'
      ),
      { code: 'CACHE_ACCOUNT_MISMATCH' }
    );
  }
  if (state.fullSyncPending) {
    throw Object.assign(
      new Error(
        'Analytics cache has an incomplete full sync; '
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_SCHEMA_OBSOLETE' }
    );
  }
  if (state.documentSyncCheckpoint) {
    throw Object.assign(
      new Error(
        'Analytics cache has an incomplete document sync; '
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_SYNC_INCOMPLETE' }
    );
  }
  if (!syncStatus && requireSuccessfulSyncStatus) {
    throw Object.assign(
      new Error(
        'Shared PostgreSQL analytics cache has no successful sync status; '
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_SYNC_INCOMPLETE' }
    );
  }
  if (syncStatus && syncStatus.accountName !== accountName) {
    throw Object.assign(
      new Error(
        `Analytics cache sync status belongs to account "${syncStatus.accountName}", `
        + `not "${accountName}"; run \`salesbinder cache sync\` before running analytics.`
      ),
      { code: 'CACHE_SYNC_INCOMPLETE' }
    );
  }
  if (syncStatus && syncStatus.status !== 'success') {
    throw Object.assign(
      new Error(
        `Analytics cache sync is ${syncStatus.status}; `
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_SYNC_INCOMPLETE' }
    );
  }
  return state;
}

interface PrepareAnalyticsCacheOptions {
  accountName: string;
  client: SalesBinderClient;
  staleSeconds?: number;
  forceRefresh?: boolean;
  useCachedOnly?: boolean;
}

export async function prepareAnalyticsCache(options: PrepareAnalyticsCacheOptions): Promise<{
  cache: CacheService;
  indexer: DocumentIndexer;
}> {
  const {
    CACHE_SCHEMA_VERSION,
    createCacheService,
    DocumentIndexerService,
    getPostgresReadUrl,
  } = await import('@salesbinder/sdk');
  const makeIndexer = (cache: CacheService) => new DocumentIndexerService(
    options.client,
    cache,
    options.accountName,
    options.staleSeconds,
  );
  const sharedPostgres = Boolean(getPostgresReadUrl());

  if (options.useCachedOnly) {
    const cache = await createCacheService(options.accountName);
    try {
      const state = assertAnalyticsCacheReady(
        await cache.getCacheState(),
        await cache.getSyncStatus(),
        options.accountName,
        sharedPostgres
      );
      if (state.schemaVersion !== CACHE_SCHEMA_VERSION) {
        throw new Error(
          `Analytics cache schema ${state.schemaVersion} is obsolete; `
          + 'run `salesbinder cache sync` to complete the full cache upgrade.'
        );
      }
      return { cache, indexer: makeIndexer(cache) };
    } catch (error) {
      await cache.close();
      throw error;
    }
  }

  let reader: CacheService | null = null;
  let requiresFullSync = true;
  let preserveExistingEnrichment = false;
  try {
    reader = await createCacheService(options.accountName);
    const indexer = makeIndexer(reader);
    const state = assertAnalyticsCacheReady(
      await reader.getCacheState(),
      await reader.getSyncStatus(),
      options.accountName,
      sharedPostgres
    );
    if (state && state.schemaVersion !== CACHE_SCHEMA_VERSION) {
      const error = Object.assign(
        new Error(
          `Analytics cache schema ${state.schemaVersion} is obsolete; `
          + 'run `salesbinder cache sync` to complete the full cache upgrade.'
        ),
        { code: 'CACHE_SCHEMA_OBSOLETE' }
      );
      throw error;
    }
    requiresFullSync = !state || state.schemaVersion !== CACHE_SCHEMA_VERSION;
    preserveExistingEnrichment = Boolean(
      state
      && state.accountName === options.accountName
      && state.schemaVersion === CACHE_SCHEMA_VERSION
    );
    const needsSync = options.forceRefresh
      || !state
      || state.accountName !== options.accountName
      || requiresFullSync
      || await indexer.isCacheStale();
    if (!needsSync) return { cache: reader, indexer };
  } catch (error) {
    if (
      (error as { code?: string })?.code === 'CACHE_SCHEMA_OBSOLETE'
      || (error as { code?: string })?.code === 'CACHE_SCHEMA_UNINITIALIZED'
      || (error as { code?: string })?.code === 'CACHE_ACCOUNT_MISMATCH'
      || (error as { code?: string })?.code === 'CACHE_SYNC_INCOMPLETE'
    ) {
      if (reader) {
        try { await reader.close(); } catch { /* preserve the schema error */ }
        reader = null;
      }
      throw error;
    }
    if (!reader) {
      throw new Error(
        'Analytics cache is uninitialized or unavailable; '
        + 'run `salesbinder cache sync` before running analytics.'
      );
    }
    // Missing or old caches are initialized only after the read-only probe closes.
  }

  if (reader) {
    try { await reader.close(); } catch { /* preserve the writer-open failure */ }
  }
  if (sharedPostgres) {
    throw Object.assign(
      new Error(
        'Shared PostgreSQL analytics refresh requires the authoritative whole-cache pipeline; '
        + 'run `salesbinder cache sync` before running analytics.'
      ),
      { code: 'CACHE_AUTHORITATIVE_SYNC_REQUIRED' }
    );
  }
  const cache = await createCacheService(options.accountName, undefined, true);
  const indexer = makeIndexer(cache);
  try {
    console.error('Syncing cache...');
    const result = await indexer.sync({
      full: Boolean(options.forceRefresh || requiresFullSync),
      preserveExistingEnrichment,
    });
    if (!result.success) {
      throw new Error(
        `Document sync incomplete: ${result.failedDocuments} document(s) require retry.`
      );
    }
    console.error('Sync complete');
    return { cache, indexer };
  } catch (error) {
    await cache.close();
    throw error;
  }
}
