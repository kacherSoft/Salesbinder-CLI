import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SQLiteCacheService } from '../../../../sdk/src/cache/sqlite-cache.service.js';
import { createSalesBinderAccountBinding } from '../../../../sdk/src/cache/types.js';

const Database = createRequire(join(__dirname, '../../../../sdk/package.json'))('better-sqlite3');
let mockCachePath: string;
const mockReadFactory = jest.fn(async (account: string) =>
  jest.requireActual('../../../../sdk/src/cache/cache.factory.js')
    .createReadCacheService(account, mockCachePath)
);
const mockWriterFactory = jest.fn(() => { throw new Error('Writer factory invoked by analytics'); });
const mockIndexer = jest.fn(() => { throw new Error('Indexer invoked by analytics'); });
const mockItemGet = jest.fn(async () => ({ name: 'Example item', quantity: 5, price: 10, cost: 6 }));

jest.mock('../../../../sdk/src/config/config.loader.js', () => ({
  loadConfig: () => ({ subdomain: 'acme', apiKey: 'test-only' }),
}));
jest.mock('@salesbinder/sdk', () => ({
  createReadCacheService: (account: string) => mockReadFactory(account),
  createCacheService: () => mockWriterFactory(),
  DocumentIndexerService: mockIndexer,
  SalesBinderClient: class { items = { get: mockItemGet }; },
  CacheAnalyticsService: jest.requireActual('../../../../sdk/src/cache/cache-analytics.service.js').CacheAnalyticsService,
  DocumentContextId: jest.requireActual('../../../../sdk/src/types/common.types.js').DocumentContextId,
  loadPreferences: () => ({ cacheStaleSeconds: 3600 }),
  readPublicCacheSyncAuthority: (...args: unknown[]) =>
    jest.requireActual('../../../../sdk/src/cache/public-sync-authority.js').readPublicCacheSyncAuthority(...args),
}), { virtual: true });

import * as commands from './index.js';
const registrations = [
  ['item-sales', commands.registerItemSalesCommand],
  ['customers', commands.registerCustomersCommand],
  ['forecast', commands.registerForecastCommand],
  ['inventory', commands.registerInventoryCommand],
  ['patterns', commands.registerPatternsCommand],
  ['pricing', commands.registerPricingCommand],
  ['trends', commands.registerTrendsCommand],
] as const;

let directory: string;
let output: jest.SpyInstance;
let errors: jest.SpyInstance;
const previousReadBackend = process.env.SALESBINDER_READ_BACKEND;
const previousStaleThreshold = process.env.SALESBINDER_CACHE_STALE_SECONDS;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'analytics-read-only-'));
  mockCachePath = join(directory, 'cache.db');
  process.env.SALESBINDER_READ_BACKEND = 'sqlite';
  delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
  jest.clearAllMocks();
  output = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
});
afterEach(() => {
  expect(mockWriterFactory).not.toHaveBeenCalled();
  expect(mockIndexer).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
  if (previousReadBackend === undefined) delete process.env.SALESBINDER_READ_BACKEND;
  else process.env.SALESBINDER_READ_BACKEND = previousReadBackend;
  if (previousStaleThreshold === undefined) delete process.env.SALESBINDER_CACHE_STALE_SECONDS;
  else process.env.SALESBINDER_CACHE_STALE_SECONDS = previousStaleThreshold;
});

async function seed(lastSync = Math.floor(Date.now() / 1000), owner = 'acme'): Promise<void> {
  const cache = new SQLiteCacheService('default', mockCachePath);
  await cache.ensureAccountBinding(createSalesBinderAccountBinding(owner));
  await cache.insertItem({ item_id: 'item-1', name: 'Example item' });
  await cache.insertDocument({
    doc_id: 'invoice-1', context_id: 5, doc_number: 1,
    issue_date: new Date().toISOString().slice(0, 10), customer_id: 'customer-1', modified: 1,
  });
  await cache.insertItemDocument({ item_id: 'item-1', doc_id: 'invoice-1', quantity: 2, price: 10 });
  await cache.setCacheState({
    lastSync, lastFullSync: lastSync, documentCount: 1, itemDocumentCount: 1,
    accountName: 'old-alias', schemaVersion: 8,
  });
  await cache.close();
}

async function run(name: string, register: (program: Command) => void, flags: string[] = []) {
  const root = new Command().option('--account <account>', 'Account', 'default');
  const analytics = root.command('analytics');
  register(analytics);
  await root.parseAsync(['node', 'salesbinder', 'analytics', name, 'item-1', ...flags]);
}

describe.each(registrations)('%s analytics reads only', (name, register) => {
  it('queries a fresh cache without changing database bytes', async () => {
    await seed();
    const before = readFileSync(mockCachePath);
    await run(name, register);
    expect(mockReadFactory).toHaveBeenCalledWith('default');
    const result = JSON.parse(output.mock.calls[0][0]);
    expect(result.item_id).toBe('item-1');
    if (name === 'item-sales') {
      expect(result.sales_periods['3_months']).toEqual({ sold: 2, revenue: 20 });
      expect(result.cache_freshness).toEqual(expect.objectContaining({ stale: false, authority: 'legacy' }));
    }
    expect(readFileSync(mockCachePath)).toEqual(before);
  });

  it('rejects stale cache by default without source reads or cache writes', async () => {
    await seed(1);
    const before = readFileSync(mockCachePath);
    await expect(run(name, register)).rejects.toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/stale.*read-only.*cache sync/);
    expect(mockItemGet).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(readFileSync(mockCachePath)).toEqual(before);
  });

  it('uses --cached against stale state without changing the snapshot', async () => {
    await seed(1);
    const before = readFileSync(mockCachePath);
    await run(name, register, ['--cached']);
    expect(JSON.parse(output.mock.calls[0][0]).item_id).toBe('item-1');
    expect(readFileSync(mockCachePath)).toEqual(before);
  });

  it.each([['--refresh'], ['--cached', '--refresh']])('rejects flags %j before opening a cache', async (...flags) => {
    await expect(run(name, register, flags)).rejects.toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/read-only.*--refresh/);
    expect(mockReadFactory).not.toHaveBeenCalled();
    expect(existsSync(mockCachePath)).toBe(false);
  });

  it('fails on a missing database without creating it', async () => {
    await expect(run(name, register, ['--cached'])).rejects.toThrow('exit');
    expect(mockReadFactory).toHaveBeenCalledWith('default');
    expect(output).not.toHaveBeenCalled();
    expect(existsSync(mockCachePath)).toBe(false);
  });

  it('fails on a missing table without repairing the schema', async () => {
    await seed();
    const db = new Database(mockCachePath);
    db.exec('DROP TABLE item_documents');
    db.close();
    const before = readFileSync(mockCachePath);
    await expect(run(name, register, ['--cached'])).rejects.toThrow('exit');
    expect(output).not.toHaveBeenCalled();
    expect(readFileSync(mockCachePath)).toEqual(before);
    const inspected = new Database(mockCachePath, { readonly: true });
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'item_documents'").get()).toBeUndefined();
    inspected.close();
  });

  it('rejects an account mismatch without changing the bound cache', async () => {
    await seed(undefined, 'other-account');
    const before = readFileSync(mockCachePath);
    await expect(run(name, register, ['--cached'])).rejects.toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/not bound to salesbinder:acme/);
    expect(mockItemGet).not.toHaveBeenCalled();
    expect(readFileSync(mockCachePath)).toEqual(before);
  });
});
