/**
 * Cache module exports
 */

export * from './types.js';
export type { CacheService } from './cache.interface.js';
export { SQLiteCacheService } from './sqlite-cache.service.js';
export { PostgresCacheService } from './postgres-cache.service.js';
export { createCacheService, createPostgresCacheService } from './cache.factory.js';
export { pullFromPostgres, tryAutoSync, shouldAutoSync } from './pg-to-sqlite-sync.service.js';
export type { PgPullResult } from './pg-to-sqlite-sync.service.js';
export { DocumentIndexerService } from './document-indexer.service.js';
export { CacheAnalyticsService } from './cache-analytics.service.js';
