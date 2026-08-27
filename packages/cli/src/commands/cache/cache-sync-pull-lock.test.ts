import { Command } from 'commander';

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
  SQLiteCacheService: class {},
  createPostgresCacheService: jest.fn(async () => outerPgService),
  pullFromPostgres,
  loadPreferences: jest.fn(() => ({})),
  loadConfig: jest.fn(() => ({ subdomain: 'example' })),
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
