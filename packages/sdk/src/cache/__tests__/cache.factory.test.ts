/**
 * Cache factory unit tests
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import {
  createCacheService,
  createReadCacheService,
  createPostgresCacheReaderService,
  createPostgresCacheService,
  getPostgresReadUrl,
} from '../cache.factory.js';

jest.mock('../../config/config.loader.js', () => ({
  loadConfig: jest.fn(() => ({ subdomain: 'factory-test' })),
}));

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
      expect(
        getPostgresReadUrl({ [dbUrlEnv]: 'postgres://example/db', [readBackendEnv]: 'postgresql' })
      ).toBe('postgres://example/db');
    });

    it('does not return PostgreSQL URL when read backend flag is missing', () => {
      expect(getPostgresReadUrl({ [dbUrlEnv]: 'postgres://example/db' })).toBeUndefined();
    });

    it('does not return PostgreSQL URL when connection URL is missing', () => {
      expect(getPostgresReadUrl({ [readBackendEnv]: 'postgresql' })).toBeUndefined();
    });
  });

  it('opens an existing SQLite cache read-only when PostgreSQL is not selected', async () => {
    process.env[dbUrlEnv] = 'postgres://example/db';
    delete process.env[readBackendEnv];

    const tempDir = mkdtempSync(join(tmpdir(), 'salesbinder-cache-factory-'));
    const dbPath = join(tempDir, 'factory-test.db');
    const writer = new SQLiteCacheService('factory-test', dbPath);
    let cache: Awaited<ReturnType<typeof createCacheService>> | undefined;

    try {
      await writer.ensureAccountBinding({
        accountIdentity: 'salesbinder:factory-test',
        accountSubdomain: 'factory-test',
      });
      await writer.close();
      cache = await createCacheService('factory-test', dbPath);

      expect(cache.getDbPath()).not.toContain('postgres://');
      expect(cache.getDbPath()).toBe(dbPath);
    } finally {
      try {
        await cache?.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('opens PostgreSQL readers through the real factory path without schema initialization', async () => {
    process.env[dbUrlEnv] =
      'postgres://example/cache?options=-c%20search_path%3Dtenant%20-c%20default_transaction_read_only%3Doff';
    process.env[readBackendEnv] = 'postgresql';
    const verify = jest
      .spyOn(PostgresCacheService.prototype, 'verifyAccountBinding')
      .mockResolvedValue(undefined);
    const ensureSchema = jest.spyOn(PostgresCacheService.prototype, 'ensureSchema');
    let cache: Awaited<ReturnType<typeof createCacheService>> | undefined;

    try {
      cache = await createReadCacheService('factory-test');
      expect(cache).toBeInstanceOf(PostgresCacheService);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(ensureSchema).not.toHaveBeenCalled();
      expect(new URL(cache.getDbPath()).searchParams.get('options')).toBe(
        '-c search_path=tenant -c default_transaction_read_only=off -c default_transaction_read_only=on'
      );
    } finally {
      await cache?.close();
      jest.restoreAllMocks();
    }
  });

  it('rejects an explicitly selected PostgreSQL reader without a database URL', async () => {
    delete process.env[dbUrlEnv];
    process.env[readBackendEnv] = 'postgresql';

    await expect(createReadCacheService('factory-test')).rejects.toThrow(
      'PostgreSQL read backend is selected but SALESBINDER_DB_URL is not configured.'
    );
  });

  it('does not create a missing SQLite cache for a reader', async () => {
    delete process.env[dbUrlEnv];
    delete process.env[readBackendEnv];
    const tempDir = mkdtempSync(join(tmpdir(), 'salesbinder-cache-factory-'));
    const dbPath = join(tempDir, 'missing.db');

    try {
      await expect(createReadCacheService('factory-test', dbPath)).rejects.toThrow(
        'SQLite cache does not exist'
      );
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an existing SQLite file without a schema without adding tables', async () => {
    delete process.env[dbUrlEnv];
    delete process.env[readBackendEnv];
    const tempDir = mkdtempSync(join(tmpdir(), 'salesbinder-cache-factory-'));
    const dbPath = join(tempDir, 'empty.db');
    const db = new Database(dbPath);
    db.close();

    try {
      await expect(createReadCacheService('factory-test', dbPath)).rejects.toThrow(
        'SQLite cache schema is not initialized. Run cache sync first.'
      );
      const inspection = new Database(dbPath, { readonly: true });
      try {
        expect(
          inspection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
        ).toEqual([]);
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the explicit PostgreSQL writer factory responsible for schema initialization', async () => {
    process.env[dbUrlEnv] = 'postgres://example/cache';
    const ensureSchema = jest
      .spyOn(PostgresCacheService.prototype, 'ensureSchema')
      .mockResolvedValue(undefined);
    const service = await createPostgresCacheService();
    try {
      expect(service).toBeInstanceOf(PostgresCacheService);
      expect(ensureSchema).toHaveBeenCalledTimes(1);
    } finally {
      await service?.close();
      jest.restoreAllMocks();
    }
  });

  it('closes a failed reader connection without attempting schema initialization', async () => {
    process.env[dbUrlEnv] = 'postgres://example/cache';
    const verify = jest
      .spyOn(PostgresCacheService.prototype, 'verifyAccountBinding')
      .mockRejectedValue(new Error('binding missing'));
    const ensureSchema = jest.spyOn(PostgresCacheService.prototype, 'ensureSchema');
    const close = jest.spyOn(PostgresCacheService.prototype, 'close').mockResolvedValue(undefined);

    await expect(createPostgresCacheReaderService('factory-test')).rejects.toThrow('binding missing');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('closes a reader when PostgreSQL schema is missing', async () => {
    process.env[dbUrlEnv] = 'postgres://example/cache';
    const verify = jest
      .spyOn(PostgresCacheService.prototype, 'verifyAccountBinding')
      .mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const close = jest.spyOn(PostgresCacheService.prototype, 'close').mockResolvedValue(undefined);

    await expect(createPostgresCacheReaderService('factory-test')).rejects.toThrow(
      'PostgreSQL cache schema is not initialized. Run cache sync first.'
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});
