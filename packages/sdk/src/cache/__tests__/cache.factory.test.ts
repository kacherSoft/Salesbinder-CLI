/**
 * Cache factory unit tests
 */

import { createCacheService, getPostgresReadUrl } from '../cache.factory.js';

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

    const cache = await createCacheService('factory-test');

    expect(cache.getDbPath()).not.toContain('postgres://');
    await cache.close();
  });
});
