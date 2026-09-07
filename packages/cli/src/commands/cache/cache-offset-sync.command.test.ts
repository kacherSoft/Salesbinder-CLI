import { Command } from 'commander';

type OffsetTask = {
  id: string;
  contextId?: 4 | 5 | 11;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  errorCode?: string;
};

type MockAccountConfig = { subdomain: string; apiKey: string; v3ApiKey?: string };

const loadConfig = jest.fn<MockAccountConfig, []>(() => ({
  subdomain: 'example',
  apiKey: 'v2-key',
  v3ApiKey: 'config-v3-key',
}));
const createSalesBinderAccountBinding = jest.fn(() => ({
  accountIdentity: 'salesbinder:example',
  accountSubdomain: 'example',
}));
const createDocumentOffsetSyncService = jest.fn();
const postgresCacheConstructor = jest.fn();
const createPostgresCacheService = jest.fn();
const normalSyncConstructors = {
  SalesBinderClient: jest.fn(),
  SalesBinderV3Client: jest.fn(),
  AccountIndexerService: jest.fn(),
  CategoryIndexerService: jest.fn(),
  DocumentIndexerService: jest.fn(),
  V3InventoryIndexerService: jest.fn(),
  DeletedLogSyncService: jest.fn(),
};

class MockPostgresSyncLockLostError extends Error {
  constructor() {
    super('PostgreSQL sync lock lost.');
    this.name = 'PostgresSyncLockLostError';
  }
}

let lockLostCallback: ((error: Error) => void) | undefined;
let listDocuments: OffsetTask[] = [];
let listItems: OffsetTask[] = [];

const pgService = {
  verifyAccountBinding: jest.fn(async () => undefined),
  tryAcquireSyncLock: jest.fn(async (_key: string, options?: { onLost?: (error: Error) => void }) => {
    lockLostCallback = options?.onLost;
    return true;
  }),
  ensureSchema: jest.fn(async () => undefined),
  releaseSyncLock: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  getOffsetSyncRun: jest.fn(async () => null as object | null),
  listOffsetSyncTasks: jest.fn(async (_runId: string, kind: 'document' | 'item') =>
    kind === 'document' ? listDocuments : listItems
  ),
};

const syncResult = {
  run: {
    version: 1,
    runId: 'run-1',
    accountIdentity: 'salesbinder:example',
    startedAt: 1_800_000_000,
    cutoff: 1_797_408_000,
    days: 30,
    updatedAt: 1_800_000_001,
    discoveryComplete: true,
    status: 'success_with_warnings',
  },
  documents: { discovered: 2, applied: 1, failed: 1, pending: 0 },
  items: { discovered: 1, applied: 0, failed: 0, pending: 1 },
  failures: [
    { kind: 'document', id: 'doc-failed', contextId: 5, code: 'not_found' },
    { kind: 'item', id: 'item-pending', code: 'pending' },
  ],
  coverageLimitations: ['Partial document-driven coverage; does not establish a complete inventory baseline.'],
};

const offsetSync = {
  sync: jest.fn(async (options: { onProgress?: (progress: Record<string, unknown>) => void }) => {
    options.onProgress?.({
      runId: 'run-1',
      phase: 'documents',
      event: 'record_processed',
      completed: 1,
      total: 2,
      failed: 1,
    });
    return syncResult;
  }),
};

jest.mock(
  '@salesbinder/sdk',
  () => ({
    ...normalSyncConstructors,
    PostgresSyncLockLostError: MockPostgresSyncLockLostError,
    PostgresCacheService: class {
      constructor(url: string) {
        postgresCacheConstructor(url);
        return pgService as never;
      }
    },
    createPostgresCacheService,
    loadConfig,
    createSalesBinderAccountBinding,
    createDocumentOffsetSyncService,
  }),
  { virtual: true }
);

let registerCacheOffsetSyncCommand:
  | typeof import('./cache-offset-sync.command.js').registerCacheOffsetSyncCommand
  | undefined;

async function runOffsetSync(...args: string[]): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  const cache = program.command('cache');
  registerCacheOffsetSyncCommand ??= (await import('./cache-offset-sync.command.js'))
    .registerCacheOffsetSyncCommand;
  registerCacheOffsetSyncCommand(cache, program);
  await program.parseAsync(['node', 'test', 'cache', 'sync-offset', ...args]);
}

function loggedJson(): unknown[] {
  return (console.log as jest.Mock).mock.calls.map(([message]) => JSON.parse(String(message)));
}

function cliErrors(): Array<{ error: boolean; message: string }> {
  return (console.error as jest.Mock).mock.calls
    .map(([message]) => {
      try {
        return JSON.parse(String(message)) as unknown;
      } catch {
        return null;
      }
    })
    .filter((message): message is { error: boolean; message: string } =>
      Boolean(message && typeof message === 'object' && (message as { error?: unknown }).error === true)
    );
}

describe('cache sync-offset command', () => {
  const originalDatabaseUrl = process.env.SALESBINDER_DB_URL;
  const originalV3Key = process.env.SALESBINDER_V3_API_KEY;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.env.SALESBINDER_DB_URL = 'postgres://example.test/salesbinder';
    delete process.env.SALESBINDER_V3_API_KEY;
    process.exitCode = undefined;
    lockLostCallback = undefined;
    listDocuments = [];
    listItems = [];
    jest.clearAllMocks();
    loadConfig.mockReturnValue({ subdomain: 'example', apiKey: 'v2-key', v3ApiKey: 'config-v3-key' });
    pgService.getOffsetSyncRun.mockResolvedValue(null);
    pgService.ensureSchema.mockResolvedValue(undefined);
    pgService.tryAcquireSyncLock.mockImplementation(async (_key, options) => {
      lockLostCallback = options?.onLost;
      return true;
    });
    createDocumentOffsetSyncService.mockReturnValue(offsetSync);
    offsetSync.sync.mockImplementation(async (options) => {
      options.onProgress?.({
        runId: 'run-1',
        phase: 'documents',
        event: 'record_processed',
        completed: 1,
        total: 2,
        failed: 1,
      });
      return syncResult;
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.SALESBINDER_DB_URL;
    else process.env.SALESBINDER_DB_URL = originalDatabaseUrl;
    if (originalV3Key === undefined) delete process.env.SALESBINDER_V3_API_KEY;
    else process.env.SALESBINDER_V3_API_KEY = originalV3Key;
    process.exitCode = originalExitCode;
  });

  it('rejects invalid --days before opening the database or API sync service', async () => {
    await runOffsetSync('--days', '0');

    expect(process.exitCode).toBe(1);
    expect(cliErrors()).toEqual([{ error: true, message: '--days must be an integer from 1 to 365.' }]);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(postgresCacheConstructor).not.toHaveBeenCalled();
    expect(pgService.verifyAccountBinding).not.toHaveBeenCalled();
    expect(pgService.ensureSchema).not.toHaveBeenCalled();
    expect(createDocumentOffsetSyncService).not.toHaveBeenCalled();
    expect(offsetSync.sync).not.toHaveBeenCalled();
  });

  it('reads --status without acquiring a writer lock or contacting SalesBinder', async () => {
    loadConfig.mockReturnValue({ subdomain: 'example', apiKey: 'v2-key' });
    pgService.getOffsetSyncRun.mockResolvedValue({ runId: 'run-1', status: 'running' });
    listDocuments = [
      { id: 'doc-ok', contextId: 4, status: 'done', attempts: 1 },
      { id: 'doc-new', contextId: 5, status: 'pending', attempts: 0 },
      { id: 'doc-bad', contextId: 11, status: 'failed', attempts: 2, errorCode: 'not_found' },
    ];
    listItems = [{ id: 'item-ok', status: 'done', attempts: 1 }];

    await runOffsetSync('--status');

    expect(process.exitCode).toBeUndefined();
    expect(pgService.tryAcquireSyncLock).not.toHaveBeenCalled();
    expect(pgService.ensureSchema).not.toHaveBeenCalled();
    expect(createDocumentOffsetSyncService).not.toHaveBeenCalled();
    expect(loggedJson()).toEqual([
      {
        run: { runId: 'run-1', status: 'running' },
        documents: {
          discovered: 3,
          applied: 1,
          pending: 1,
          failed: 1,
          failures: [{ id: 'doc-bad', code: 'not_found' }],
        },
        items: { discovered: 1, applied: 1, pending: 0, failed: 0, failures: [] },
        coverage: 'document-driven partial refresh; not a full inventory snapshot',
      },
    ]);
  });

  it('propagates explicit days, account identity, progress and final partial coverage', async () => {
    await runOffsetSync('--days', '17');

    expect(process.exitCode).toBeUndefined();
    expect(offsetSync.sync).toHaveBeenCalledWith(
      expect.objectContaining({ accountIdentity: 'salesbinder:example', days: 17 })
    );
    expect(console.error).toHaveBeenCalledWith(
      '[offset] V2 document selection → V3 documents and exact related items; no full inventory scan'
    );
    expect(console.error).toHaveBeenCalledWith(
      '[offset] documents: record_processed 1/2; failed=1'
    );
    expect(loggedJson()).toEqual([syncResult]);
  });

  it('propagates --resume without replacing the stored run cutoff', async () => {
    await runOffsetSync('--days', '17', '--resume');

    const options = offsetSync.sync.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toEqual(
      expect.objectContaining({ accountIdentity: 'salesbinder:example', resume: true })
    );
    expect(Object.prototype.hasOwnProperty.call(options, 'days')).toBe(false);
  });

  it('uses the offset service factory and avoids normal full-sync or ledger factories', async () => {
    await runOffsetSync();

    expect(createDocumentOffsetSyncService).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'v2-key', v3ApiKey: 'config-v3-key' }),
      pgService,
      expect.objectContaining({
        signal: expect.objectContaining({ aborted: false }),
        rateLimitObserver: expect.any(Function),
      }),
      expect.any(Function)
    );
    expect(postgresCacheConstructor).toHaveBeenCalledWith('postgres://example.test/salesbinder');
    expect(pgService.ensureSchema).toHaveBeenCalledTimes(1);
    expect(pgService.verifyAccountBinding.mock.invocationCallOrder[0]).toBeLessThan(
      pgService.tryAcquireSyncLock.mock.invocationCallOrder[0]
    );
    expect(pgService.tryAcquireSyncLock.mock.invocationCallOrder[0]).toBeLessThan(
      pgService.ensureSchema.mock.invocationCallOrder[0]
    );
    expect(pgService.ensureSchema.mock.invocationCallOrder[0]).toBeLessThan(
      createDocumentOffsetSyncService.mock.invocationCallOrder[0]
    );
    expect(createDocumentOffsetSyncService.mock.invocationCallOrder[0]).toBeLessThan(
      offsetSync.sync.mock.invocationCallOrder[0]
    );
    expect(createPostgresCacheService).not.toHaveBeenCalled();
    for (const constructor of Object.values(normalSyncConstructors)) {
      expect(constructor).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the writer lock is busy', async () => {
    pgService.tryAcquireSyncLock.mockResolvedValueOnce(false);

    await runOffsetSync();

    expect(process.exitCode).toBe(1);
    expect(pgService.ensureSchema).not.toHaveBeenCalled();
    expect(createDocumentOffsetSyncService).not.toHaveBeenCalled();
    expect(offsetSync.sync).not.toHaveBeenCalled();
    expect(pgService.releaseSyncLock).not.toHaveBeenCalled();
    expect(pgService.close).toHaveBeenCalledTimes(1);
    expect(cliErrors()).toEqual([
      { error: true, message: 'Another cache writer is running for this account.' },
    ]);
  });

  it('does not create the offset sync service when schema migration fails', async () => {
    pgService.ensureSchema.mockRejectedValueOnce(new Error('private migration detail'));

    await runOffsetSync();

    expect(process.exitCode).toBe(1);
    expect(pgService.verifyAccountBinding.mock.invocationCallOrder[0]).toBeLessThan(
      pgService.tryAcquireSyncLock.mock.invocationCallOrder[0]
    );
    expect(pgService.tryAcquireSyncLock.mock.invocationCallOrder[0]).toBeLessThan(
      pgService.ensureSchema.mock.invocationCallOrder[0]
    );
    expect(createDocumentOffsetSyncService).not.toHaveBeenCalled();
    expect(offsetSync.sync).not.toHaveBeenCalled();
    expect(pgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(pgService.close).toHaveBeenCalledTimes(1);
    expect(cliErrors()).toEqual([
      {
        error: true,
        message:
          'Offset sync failed. Check cache sync-offset --status; use --resume after resolving the failure.',
      },
    ]);
  });

  it('cleans up once and emits one sanitized terminal error when the lock is lost', async () => {
    offsetSync.sync.mockImplementationOnce(async () => {
      lockLostCallback?.(new Error('ETIMEDOUT postgres://writer:secret@private.example/db'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return syncResult;
    });

    await runOffsetSync();

    expect(process.exitCode).toBe(1);
    expect(pgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(pgService.close).toHaveBeenCalledTimes(1);
    expect(cliErrors()).toEqual([
      {
        error: true,
        message: 'Offset sync stopped: PostgreSQL writer lock lost. Saved work can be resumed.',
      },
    ]);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
      /writer:secret|private\.example|ETIMEDOUT/
    );
  });
});
