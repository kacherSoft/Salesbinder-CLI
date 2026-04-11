/**
 * Factory function for creating the appropriate CacheService implementation.
 *
 * - If SALESBINDER_DB_URL env var is set → PostgreSQL
 * - Otherwise → SQLite (local file)
 */

import type { CacheService } from './cache.interface.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';
import { PostgresCacheService } from './postgres-cache.service.js';

/**
 * Create and return a CacheService instance.
 *
 * @param accountName - Account name (used for SQLite file isolation)
 * @param customPath  - Optional custom path (SQLite only, for testing)
 */
export async function createCacheService(accountName: string, customPath?: string): Promise<CacheService> {
  const dbUrl = process.env.SALESBINDER_DB_URL;
  if (dbUrl) {
    const service = new PostgresCacheService(dbUrl);
    await service.ensureSchema();
    return service;
  }
  return new SQLiteCacheService(accountName, customPath);
}
