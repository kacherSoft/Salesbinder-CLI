import type {
  CacheService,
  DocumentIndexerService as DocumentIndexer,
  SalesBinderClient,
} from '@salesbinder/sdk';

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
  const { createCacheService, DocumentIndexerService } = await import('@salesbinder/sdk');
  const makeIndexer = (cache: CacheService) => new DocumentIndexerService(
    options.client,
    cache,
    options.accountName,
    options.staleSeconds,
  );

  if (options.useCachedOnly) {
    const cache = await createCacheService(options.accountName);
    return { cache, indexer: makeIndexer(cache) };
  }

  let reader: CacheService | null = null;
  try {
    reader = await createCacheService(options.accountName);
    const indexer = makeIndexer(reader);
    const state = await reader.getCacheState();
    const needsSync = options.forceRefresh
      || !state
      || state.accountName !== options.accountName
      || await indexer.isCacheStale();
    if (!needsSync) return { cache: reader, indexer };
  } catch {
    // Missing or old caches are initialized only after the read-only probe closes.
  }

  if (reader) {
    try { await reader.close(); } catch { /* preserve the writer-open failure */ }
  }
  const cache = await createCacheService(options.accountName, undefined, true);
  const indexer = makeIndexer(cache);
  try {
    console.error('Syncing cache...');
    await indexer.sync({ full: options.forceRefresh });
    console.error('Sync complete');
    return { cache, indexer };
  } catch (error) {
    await cache.close();
    throw error;
  }
}
