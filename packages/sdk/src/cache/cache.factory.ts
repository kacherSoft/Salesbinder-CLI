/**
 * Factory function for creating the appropriate CacheService implementation.
 *
 * Strategy:
 * - Default reads use SQLite (fast, offline-capable)
 * - Shared readers can opt into PostgreSQL with the read-backend env flag
 * - Use createPostgresCacheService() when you need direct PostgreSQL writes
 */

import type { CacheService } from './cache.interface.js';
import { loadConfig } from '../config/config.loader.js';
import { createSalesBinderAccountBinding } from './types.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';
import { PostgresCacheService } from './postgres-cache.service.js';

const DATABASE_URL_ENV = ['SALESBINDER', 'DB', 'URL'].join('_');
const READ_BACKEND_ENV = ['SALESBINDER', 'READ', 'BACKEND'].join('_');

export function getPostgresReadUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const readDbUrl = env[DATABASE_URL_ENV];
  return readDbUrl && env[READ_BACKEND_ENV] === 'postgresql' ? readDbUrl : undefined;
}

export function isPostgresReadBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[READ_BACKEND_ENV] === 'postgresql';
}

/**
 * Create a CacheService for reading cached data.
 * Returns PostgreSQL only when explicitly requested for shared readers.
 * Otherwise returns SQLite without network side effects.
 *
 * @param accountName - Account name (used for SQLite file isolation)
 * @param customPath  - Optional custom path (SQLite only, for testing)
 */
export async function createCacheService(accountName: string, customPath?: string): Promise<CacheService> {
  return createReadCacheService(accountName, customPath);
}

/** Open an existing cache exclusively for reads. Never initializes or migrates a cache. */
export async function createReadCacheService(
  accountName: string,
  customPath?: string
): Promise<CacheService> {
  if (isPostgresReadBackend()) {
    const dbUrl = process.env[DATABASE_URL_ENV];
    if (!dbUrl) {
      throw new Error(
        'PostgreSQL read backend is selected but SALESBINDER_DB_URL is not configured.'
      );
    }
    return openPostgresReader(dbUrl, accountName);
  }
  return openSQLiteReader(accountName, customPath);
}

/** Open an already-initialized PostgreSQL cache for reads without issuing schema DDL. */
export async function createPostgresCacheReaderService(
  accountName: string
): Promise<PostgresCacheService | null> {
  const dbUrl = process.env.SALESBINDER_DB_URL;
  return dbUrl ? openPostgresReader(dbUrl, accountName) : null;
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

async function openPostgresReader(
  databaseUrl: string,
  accountName: string
): Promise<PostgresCacheService> {
  const binding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
  const service = new PostgresCacheService(databaseUrl, { readOnly: true });
  try {
    await service.verifyAccountBinding(binding);
    return service;
  } catch (error) {
    await service.close().catch(() => undefined);
    if (isMissingPostgresSchema(error)) {
      throw new Error('PostgreSQL cache schema is not initialized. Run cache sync first.');
    }
    throw error;
  }
}

function isMissingPostgresSchema(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P01'
  );
}

async function openSQLiteReader(accountName: string, customPath?: string): Promise<SQLiteCacheService> {
  const binding = createSalesBinderAccountBinding(loadConfig(accountName).subdomain);
  const service = new SQLiteCacheService(accountName, customPath, { readOnly: true });
  try {
    await service.verifyAccountBinding(binding);
    return service;
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}
