/**
 * Cache factory unit tests
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCacheService, getPostgresReadUrl } from '../cache.factory.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';

describe('Cache factory', () => {
  const dbUrlEnv = ['SALESBINDER', 'DB', 'URL'].join('_');
  const readBackendEnv = ['SALESBINDER', 'READ', 'BACKEND'].join('_');

  const originalDbUrl = process.env[dbUrlEnv];
  const originalReadBackend = process.env[readBackendEnv];

  afterEach(() => {
    if (originalDbUrl === undefined) delete process.env[dbUrlEnv];
    else process.env[dbUrlEnv] = originalDbUrl;

    if (originalReadBackend === undefined) delete process.env[readBackendEnv];
    else process.env[readBackendEnv] = originalReadBackend;
  });

  describe('getPostgresReadUrl', () => {
    it('returns PostgreSQL URL only when read backend is explicitly requested', () => {
      expect(getPostgresReadUrl({ [dbUrlEnv]: 'postgres://example/db', [readBackendEnv]: 'postgresql' })).toBe(
        'postgres://example/db'
      );
    });

    it('does not return PostgreSQL URL when read backend flag is missing', () => {
      expect(getPostgresReadUrl({ [dbUrlEnv]: 'postgres://example/db' })).toBeUndefined();
    });

    it('does not return PostgreSQL URL when connection URL is missing', () => {
      expect(getPostgresReadUrl({ [readBackendEnv]: 'postgresql' })).toBeUndefined();
    });
  });

  it('defaults reads to SQLite even when PostgreSQL URL is configured', async () => {
    process.env[dbUrlEnv] = 'postgres://example/db';
    delete process.env[readBackendEnv];
    const dir = mkdtempSync(join(tmpdir(), 'salesbinder-cache-factory-'));
    const dbPath = join(dir, 'cache.db');
    const writer = new SQLiteCacheService('factory-test', dbPath, true);
    await writer.close();

    const cache = await createCacheService('factory-test', dbPath);

    expect(cache.getDbPath()).not.toContain('postgres://');
    await cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('can explicitly create a lease-bound SQLite writer', async () => {
    delete process.env[readBackendEnv];
    const dir = mkdtempSync(join(tmpdir(), 'salesbinder-cache-writer-factory-'));
    const dbPath = join(dir, 'cache.db');
    const writer = await createCacheService('factory-writer', dbPath, true);
    await writer.setCacheState({
      lastSync: 1,
      lastFullSync: 1,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'factory-writer',
      schemaVersion: 3,
    });
    await writer.close();

    const reader = await createCacheService('factory-writer', dbPath);
    expect((await reader.getCacheState())?.accountName).toBe('factory-writer');
    await reader.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
