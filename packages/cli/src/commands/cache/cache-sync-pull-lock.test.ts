import { Command } from 'commander';

const mockExistsSync = jest.fn((_path: unknown) => true);
const mockUnlinkSync = jest.fn((_path: unknown) => undefined);
const mockStatSync = jest.fn((_path: unknown) => ({ size: 1024 * 1024 }));
const mockLoadConfig = jest.fn((_accountName: string) => ({ subdomain: 'example' }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (path: unknown) => mockExistsSync(path),
  unlinkSync: (path: unknown) => mockUnlinkSync(path),
  statSync: (path: unknown) => mockStatSync(path),
}));

let outerPgLockHeld = false;
let phaseOrder: string[] = [];

const outerPgService = {
  tryAcquireSyncLock: jest.fn(async () => {
    outerPgLockHeld = true;
    return true;
  }),
  releaseSyncLock: jest.fn(async () => {
    outerPgLockHeld = false;
  }),
  close: jest.fn(async () => undefined),
  ensureAccountBinding: jest.fn(async () => undefined),
  setSyncStatus: jest.fn(async () => undefined),
  getSyncStatus: jest.fn(async () => null),
  getPaymentSyncStatus: jest.fn(async () => null),
  getCacheState: jest.fn(async () => null),
  setCacheState: jest.fn(async () => undefined),
  getAccountCount: jest.fn(async () => 0),
  getDocumentCount: jest.fn(async () => 0),
  getItemDocumentCount: jest.fn(async () => 0),
  getItemCount: jest.fn(async () => 0),
  getCategoryCount: jest.fn(async () => 0),
  getCategoryCacheMeta: jest.fn(async () => null),
  getStockLocationCount: jest.fn(async () => 0),
};

const sqliteCacheService = {
  verifyAccountBinding: jest.fn(async () => undefined),
  verifyUnboundForDeletion: jest.fn(async () => undefined),
  tryAcquireSyncLock: jest.fn(async () => true),
  closeDatabaseForDeletion: jest.fn(() => undefined),
  releaseSyncLock: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
};

const pullFromPostgres = jest.fn<Promise<{
  success: boolean;
  accountsPulled: number;
  categoriesPulled: number;
  documentsPulled: number;
  itemDocumentsPulled: number;
  paymentTransactionsPulled: number;
  itemsPulled: number;
  stockRowsPulled: number;
  duration: string;
}>, []>();

class SuccessfulAccountIndexer {
  async sync() {
    phaseOrder.push('accounts');
    return { accountsProcessed: 0, customersProcessed: 0, suppliersProcessed: 0 };
  }
}

class SuccessfulDocumentIndexer {
  async sync() {
    phaseOrder.push('documents');
    return {
      success: true,
      type: 'delta' as const,
      documentsProcessed: 0,
      documentsDeleted: 0,
      lineItemsProcessed: 0,
      duration: '0s',
      syncLookbackSeconds: 604800,
    };
  }
}

class SuccessfulCategoryIndexer {
  async sync() {
    phaseOrder.push('categories');
    return { categoriesProcessed: 0, snapshot: null };
  }
}

class SuccessfulItemIndexer {
  async sync() {
    phaseOrder.push('items');
    return { itemsProcessed: 0, stockRowsProcessed: 0 };
  }
}

class SuccessfulDeletedLogSync {
  async sync() {
    phaseOrder.push('deleted-log');
    return { deletedRecordsProcessed: 0 };
  }
}

let registerCacheCommands: typeof import('./cache.commands.js').registerCacheCommands;

jest.mock('@salesbinder/sdk', () => ({
  SalesBinderClient: class {},
  AccountIndexerService: SuccessfulAccountIndexer,
  CategoryIndexerService: SuccessfulCategoryIndexer,
  DocumentIndexerService: SuccessfulDocumentIndexer,
  ItemIndexerService: SuccessfulItemIndexer,
  DeletedLogSyncService: SuccessfulDeletedLogSync,
  SQLiteCacheService: class {
    constructor() {
      return sqliteCacheService;
    }
  },
  createPostgresCacheService: jest.fn(async () => outerPgService),
  pullFromPostgres,
  loadPreferences: jest.fn(() => ({})),
  loadConfig: (accountName: string) => mockLoadConfig(accountName),
  createSalesBinderAccountBinding: jest.fn(() => ({
    accountIdentity: 'salesbinder:example',
    accountSubdomain: 'example',
  })),
  CACHE_SCHEMA_VERSION: 7,
}), { virtual: true });

function successfulPullResult() {
  return {
    success: true,
    accountsPulled: 0,
    categoriesPulled: 0,
    documentsPulled: 0,
    itemDocumentsPulled: 0,
    paymentTransactionsPulled: 0,
    itemsPulled: 0,
    stockRowsPulled: 0,
    duration: '0s',
  };
}

async function runExplicitPull(): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  registerCacheCommands(program);
  await program.parseAsync(['node', 'test', 'cache', 'sync', '--pull']);
}

async function runClear(forceUnbound = false): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  registerCacheCommands(program);
  const args = ['node', 'test', 'cache', 'clear'];
  if (forceUnbound) args.push('--force-unbound');
  await program.parseAsync(args);
}

describe('cache sync --pull lock ordering', () => {
  const originalDatabaseUrl = process.env.SALESBINDER_DB_URL;
  const originalExitCode = process.exitCode;

  beforeAll(async () => {
    ({ registerCacheCommands } = await import('./cache.commands.js'));
  });

  beforeEach(() => {
    process.env.SALESBINDER_DB_URL = 'postgres://example.test/salesbinder';
    process.exitCode = undefined;
    outerPgLockHeld = false;
    phaseOrder = [];
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.SALESBINDER_DB_URL;
    else process.env.SALESBINDER_DB_URL = originalDatabaseUrl;
    process.exitCode = originalExitCode;
  });

  it('releases the outer PostgreSQL lock exactly once before starting the protected pull', async () => {
    pullFromPostgres.mockImplementation(async () => {
      expect(outerPgLockHeld).toBe(false);
      return successfulPullResult();
    });

    await runExplicitPull();

    expect(pullFromPostgres).toHaveBeenCalledTimes(1);
    expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps pull failures nonzero without attempting a second outer lock release', async () => {
    pullFromPostgres.mockImplementation(async () => {
      expect(outerPgLockHeld).toBe(false);
      throw new Error('pull failed');
    });

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'pull failed' }),
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });

  it('does not start pull and retains final cleanup when the pre-pull release fails', async () => {
    outerPgService.releaseSyncLock.mockRejectedValueOnce(new Error('release failed'));

    await runExplicitPull();

    expect(pullFromPostgres).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'release failed' }),
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(2);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });
});

describe('cache clear SQLite account preconditions', () => {
  const originalDatabaseUrl = process.env.SALESBINDER_DB_URL;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    delete process.env.SALESBINDER_DB_URL;
    process.exitCode = undefined;
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 1024 * 1024 });
    mockLoadConfig.mockReturnValue({ subdomain: 'example' });
    sqliteCacheService.verifyAccountBinding.mockResolvedValue(undefined);
    sqliteCacheService.verifyUnboundForDeletion.mockResolvedValue(undefined);
    sqliteCacheService.tryAcquireSyncLock.mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.SALESBINDER_DB_URL;
    else process.env.SALESBINDER_DB_URL = originalDatabaseUrl;
    process.exitCode = originalExitCode;
  });

  it('verifies the matching durable binding and closes SQLite before deleting files', async () => {
    await runClear();

    expect(sqliteCacheService.verifyAccountBinding).toHaveBeenCalledWith({
      accountIdentity: 'salesbinder:example', accountSubdomain: 'example',
    });
    expect(sqliteCacheService.verifyUnboundForDeletion).not.toHaveBeenCalled();
    expect(sqliteCacheService.closeDatabaseForDeletion).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    expect(sqliteCacheService.verifyAccountBinding.mock.invocationCallOrder[0])
      .toBeLessThan(mockUnlinkSync.mock.invocationCallOrder[0]);
    expect(sqliteCacheService.closeDatabaseForDeletion.mock.invocationCallOrder[0])
      .toBeLessThan(mockUnlinkSync.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a mismatched binding without deleting any cache file', async () => {
    sqliteCacheService.verifyAccountBinding.mockRejectedValueOnce(new Error('not bound to salesbinder:example'));

    await runClear();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(sqliteCacheService.tryAcquireSyncLock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('allows explicit recovery deletion for a legacy unbound cache', async () => {
    await runClear(true);

    expect(sqliteCacheService.verifyUnboundForDeletion).toHaveBeenCalledTimes(1);
    expect(sqliteCacheService.verifyAccountBinding).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not let force-unbound override an existing mismatched binding', async () => {
    sqliteCacheService.verifyUnboundForDeletion.mockRejectedValueOnce(
      new Error('SQLite cache already has an account binding'),
    );

    await runClear(true);

    expect(sqliteCacheService.verifyAccountBinding).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(sqliteCacheService.tryAcquireSyncLock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('returns success for a missing SQLite file without loading account config', async () => {
    mockExistsSync.mockReturnValue(false);
    mockLoadConfig.mockImplementationOnce(() => {
      throw new Error('config missing');
    });

    await runClear();

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('force-deletes an unbound legacy SQLite file without loading account config', async () => {
    mockLoadConfig.mockImplementationOnce(() => {
      throw new Error('config missing');
    });

    await runClear(true);

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(sqliteCacheService.verifyUnboundForDeletion).toHaveBeenCalledTimes(1);
    expect(sqliteCacheService.tryAcquireSyncLock).toHaveBeenCalledWith(
      expect.stringContaining('salesbinder-cache-file:'),
    );
    expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps config mandatory for normal clear of an existing SQLite file', async () => {
    mockLoadConfig.mockImplementationOnce(() => {
      throw new Error('config missing');
    });

    await runClear();

    expect(mockLoadConfig).toHaveBeenCalledWith('default');
    expect(sqliteCacheService.verifyAccountBinding).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
