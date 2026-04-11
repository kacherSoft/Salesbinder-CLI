/**
 * Factory function for creating the appropriate CacheService implementation.
 *
 * Strategy:
 * - Always return SQLite for reads (fast, offline-capable)
 * - If SALESBINDER_DB_URL is set, auto-sync PG → SQLite in background
 *   (weekdays 8–18h, at most once per hour)
 * - Use createPostgresCacheService() when you need direct PG access (e.g. cache sync)
 */

import type { CacheService } from './cache.interface.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';
import { PostgresCacheService } from './postgres-cache.service.js';
import { tryAutoSync } from './pg-to-sqlite-sync.service.js';

/**
 * Create a CacheService for reading cached data.
 * Always returns SQLite (local, fast).
 * If SALESBINDER_DB_URL is set, triggers a background PG → SQLite pull
 * when the local mirror is stale (weekday daytime, once per hour).
 *
 * @param accountName - Account name (used for SQLite file isolation)
 * @param customPath  - Optional custom path (SQLite only, for testing)
 */
export async function createCacheService(accountName: string, customPath?: string): Promise<CacheService> {
  const sqlite = new SQLiteCacheService(accountName, customPath);

  // If PG is configured, try background auto-sync (non-blocking)
  const dbUrl = process.env.SALESBINDER_DB_URL;
  if (dbUrl) {
    // Fire-and-forget: don't block the caller
    tryAutoSync(dbUrl, accountName, customPath)
      .then((result) => {
        if (result.success && !result.skipped) {
          console.error(
            `[pg-sync] Pulled ${result.documentsPulled} docs from PostgreSQL → SQLite (${result.duration})`
          );
        } else if (!result.success) {
          console.error(`[pg-sync] Skipped: ${result.skipReason}`);
        }
      })
      .catch(() => {
        // Silently ignore — SQLite still works offline
      });
  }

  return sqlite;
}

/**
 * Create a direct PostgreSQL CacheService (for cache sync command writing to PG).
 * Only call this when you need to WRITE to PostgreSQL directly.
 * Returns null if SALESBINDER_DB_URL is not set.
 */
export async function createPostgresCacheService(): Promise<PostgresCacheService | null> {
  const dbUrl = process.env.SALESBINDER_DB_URL;
  if (!dbUrl) return null;
  const service = new PostgresCacheService(dbUrl);
  await service.ensureSchema();
  return service;
}
