/**
 * Factory function for creating the appropriate CacheService implementation.
 *
 * Strategy:
 * - Default reads use SQLite (fast, offline-capable)
 * - Shared readers can opt into PostgreSQL with the read-backend env flag
 * - Use createPostgresCacheService(accountName) for an ownership-checked PG writer
 */

import type { CacheService } from './cache.interface.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';
import { PostgresCacheService } from './postgres-cache.service.js';
import { CACHE_WRITER_LOCK_KEY } from './types.js';

const DATABASE_URL_ENV = ['SALESBINDER', 'DB', 'URL'].join('_');
const READ_BACKEND_ENV = ['SALESBINDER', 'READ', 'BACKEND'].join('_');

export function getPostgresReadUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const readDbUrl = env[DATABASE_URL_ENV];
  return readDbUrl && env[READ_BACKEND_ENV] === 'postgresql' ? readDbUrl : undefined;
}

/**
 * Create a CacheService for reading cached data.
 * Returns PostgreSQL only when explicitly requested for shared readers.
 * Otherwise returns SQLite without network side effects.
 *
 * @param accountName - Account name (used for SQLite file isolation)
 * @param customPath  - Optional custom path (SQLite only, for testing)
 * @param writable    - Hold the backend's global writer lease until close
 */
export async function createCacheService(
  accountName: string,
  customPath?: string,
  writable = false
): Promise<CacheService> {
  const readDbUrl = getPostgresReadUrl();
  if (readDbUrl) {
    const pg = new PostgresCacheService(readDbUrl);
    try {
      if (writable) {
        if (!await pg.tryAcquireSyncLock(CACHE_WRITER_LOCK_KEY)) {
          throw new Error('Another cache writer is already running.');
        }
        await pg.ensureSchema(accountName);
      }
      return pg;
    } catch (error) {
      await pg.close();
      throw error;
    }
  }

  return new SQLiteCacheService(accountName, customPath, writable);
}

/**
 * Create a direct PostgreSQL CacheService (for cache sync command writing to PG).
 * Only call this when you need to WRITE to PostgreSQL directly.
 * Returns null if SALESBINDER_DB_URL is not set.
 */
export async function createPostgresCacheService(
  accountName: string
): Promise<PostgresCacheService | null> {
  const dbUrl = process.env.SALESBINDER_DB_URL;
  if (!dbUrl) return null;
  const service = new PostgresCacheService(dbUrl);
  try {
    if (!await service.tryAcquireSyncLock(CACHE_WRITER_LOCK_KEY)) {
      throw new Error('Another cache writer is already running.');
    }
    await service.ensureSchema(accountName);
    return service;
  } catch (error) {
    await service.close();
    throw error;
  }
}
