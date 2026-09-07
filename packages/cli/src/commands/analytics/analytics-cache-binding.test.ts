import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CacheService } from '@salesbinder/sdk';
import { SQLiteCacheService } from '../../../../sdk/src/cache/sqlite-cache.service.js';
import { createSalesBinderAccountBinding } from '../../../../sdk/src/cache/types.js';
import {
  ensureAnalyticsCacheBinding,
  getAnalyticsSyncDecision,
} from './analytics-cache-binding.js';

const binding = { accountIdentity: 'salesbinder:acme', accountSubdomain: 'acme' };

function cache(overrides: Partial<CacheService> = {}): CacheService {
  return {
    ensureAccountBinding: jest.fn(async () => undefined),
    verifyAccountBinding: jest.fn(async () => undefined),
    ...overrides,
  } as CacheService;
}

describe('ensureAnalyticsCacheBinding', () => {
  it('ensures the canonical binding before a refresh path', async () => {
    const service = cache();

    await ensureAnalyticsCacheBinding(service, binding);

    expect(service.ensureAccountBinding).toHaveBeenCalledWith(binding);
    expect(service.verifyAccountBinding).not.toHaveBeenCalled();
  });

  it('rejects a mismatched bound cache before refresh writes', async () => {
    const service = cache({
      ensureAccountBinding: jest.fn(async () => {
        throw new Error('SQLite cache database is not bound to salesbinder:acme.');
      }),
    });

    await expect(ensureAnalyticsCacheBinding(service, binding)).rejects.toThrow(
      /not bound to salesbinder:acme/
    );
  });

  it('rejects a mismatched real SQLite binding without changing its payload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'salesbinder-analytics-binding-'));
    const path = join(directory, 'cache.db');
    const owner = new SQLiteCacheService('owner', path);
    await owner.ensureAccountBinding(createSalesBinderAccountBinding('owner'));
    await owner.insertItem({ item_id: 'bound-item', name: 'Bound item' });
    await owner.close();

    const mismatched = new SQLiteCacheService('renamed-alias', path);
    try {
      await expect(
        ensureAnalyticsCacheBinding(
          mismatched,
          createSalesBinderAccountBinding('different-account')
        )
      ).rejects.toThrow(/not bound to salesbinder:different-account/);
      expect(await mismatched.getItem('bound-item')).toBeDefined();
    } finally {
      await mismatched.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('analytics command sync decision', () => {
  it('selects a full sync for an initial uncached refresh', () => {
    expect(getAnalyticsSyncDecision(false, null, true)).toEqual({
      shouldSync: true,
      full: true,
    });
  });

  it('does not sync only because a local alias differs from cache state', () => {
    const state = {
      lastSync: 100,
      lastFullSync: 100,
      documentCount: 1,
      itemDocumentCount: 1,
      accountName: 'old-alias',
      schemaVersion: 8,
    };

    expect(getAnalyticsSyncDecision(false, state, false)).toEqual({
      shouldSync: false,
      full: false,
    });
  });
});
