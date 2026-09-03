import { Command } from 'commander';
import { CacheSyncProgressReporter as ActualCacheSyncProgressReporter } from '../../../../sdk/src/cache/cache-sync-progress-reporter.js';
import { buildPaymentSyncStatusFingerprint } from './full-resume-checkpoint.js';

const mockHomeDirectory = `/tmp/salesbinder-cli-cache-command-${process.pid}`;
const mockCheckpointPath = `${mockHomeDirectory}/.salesbinder/cache/full-resume-default.json`;
const actualFileExists = (path: unknown) =>
  jest.requireActual<typeof import('fs')>('fs').existsSync(path as import('fs').PathLike);
let mockCheckpointCleanupFailure = false;
let mockCheckpointWriteFailureAfterPayment = false;
let mockPaymentStatusWritten = false;
const mockRmSync = jest.fn((path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
  if (mockCheckpointCleanupFailure && String(path) === mockCheckpointPath) {
    throw new Error('private cleanup detail');
  }
  return jest
    .requireActual<typeof import('fs')>('fs')
    .rmSync(path as import('fs').PathLike, options);
});
const mockRenameSync = jest.fn((oldPath: unknown, newPath: unknown) => {
  if (
    mockCheckpointWriteFailureAfterPayment &&
    mockPaymentStatusWritten &&
    String(newPath) === mockCheckpointPath
  ) {
    mockCheckpointWriteFailureAfterPayment = false;
    throw new Error('private checkpoint write failure');
  }
  return jest
    .requireActual<typeof import('fs')>('fs')
    .renameSync(oldPath as import('fs').PathLike, newPath as import('fs').PathLike);
});
const mockExistsSync = jest.fn((path: unknown) =>
  String(path).includes('full-resume-') ? actualFileExists(path) : true
);
const mockUnlinkSync = jest.fn((_path: unknown) => undefined);
const mockStatSync = jest.fn((_path: unknown) => ({ size: 1024 * 1024 }));
type MockAccountConfig = { subdomain: string; v3ApiKey?: string };
const mockLoadConfig = jest.fn<MockAccountConfig, [string]>((_accountName: string) => ({
  subdomain: 'example',
  v3ApiKey: 'test-v3-key',
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (path: unknown) => mockExistsSync(path),
  rmSync: (path: unknown, options?: { force?: boolean; recursive?: boolean }) =>
    mockRmSync(path, options),
  renameSync: (oldPath: unknown, newPath: unknown) => mockRenameSync(oldPath, newPath),
  unlinkSync: (path: unknown) => mockUnlinkSync(path),
  statSync: (path: unknown) => mockStatSync(path),
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => mockHomeDirectory,
}));

let outerPgLockHeld = false;
let phaseOrder: string[] = [];
let documentRecordIssues: object[] = [];
let itemRecordIssues: object[] = [];
let deletedLogDocumentTombstones: object[] = [];
let accountSyncFailure: Error | null = null;
let deletedLogFailure: Error | null = null;
let paymentSyncStatus: Record<string, unknown> | null = null;
let mockDeletedLogAdvancesState = false;
let emittedProgress: object[] = [];
let clientRuntimeOptions: object[] = [];
let checkpointPresentDuringTerminal: boolean | undefined;
let checkpointPresentDuringOutput: boolean | undefined;
let innerSqlitePullLockHeld = false;
let terminalWriteProtected: boolean | undefined;
let deletedLogSyncOptions: object[] = [];
let useActualProgressReporter = false;

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
  verifyAccountBinding: jest.fn(async () => undefined),
  ensureSchema: jest.fn(async () => undefined),
  setSyncStatus: jest.fn<Promise<void>, [Record<string, unknown>]>(async () => undefined),
  getSyncStatus: jest.fn(async () => null),
  getPaymentSyncStatus: jest.fn(async () => paymentSyncStatus),
  setPaymentSyncStatus: jest.fn<Promise<void>, [Record<string, unknown>]>(async (status) => {
    mockPaymentStatusWritten = true;
    paymentSyncStatus = status;
  }),
  getCacheState: jest.fn(async () => null),
  setCacheState: jest.fn<Promise<void>, [Record<string, unknown>]>(async () => undefined),
  getAccountCount: jest.fn(async () => 0),
  getDocumentCount: jest.fn(async () => 0),
  getDocumentCountByContext: jest.fn(async () => 0),
  getItemDocumentCount: jest.fn(async () => 0),
  getPaymentTransactionCount: jest.fn(async () => 0),
  getItemCount: jest.fn(async () => 0),
  getCategoryCount: jest.fn(async () => 0),
  getCategoryCacheMeta: jest.fn(async () => null),
  getInventoryCacheMeta: jest.fn(async () => null),
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

type MockPullResult = {
  success: boolean;
  accountsPulled: number;
  categoriesPulled: number;
  documentsPulled: number;
  itemDocumentsPulled: number;
  paymentTransactionsPulled: number;
  itemsPulled: number;
  stockRowsPulled: number;
  duration: string;
};
type MockPullSettlement =
  | { status: 'success'; result: MockPullResult }
  | { status: 'failed'; error: unknown };
type MockPullOptions = {
  pgLockAlreadyHeld?: boolean;
  onSettledWhileLocked?: (settlement: MockPullSettlement) => void | Promise<void>;
};
const pullFromPostgres = jest.fn<
  Promise<MockPullResult>,
  [string, string, string | undefined, object | undefined, MockPullOptions | undefined]
>();
const createPostgresCacheService = jest.fn(async () => outerPgService);
const categoryIndexerConstructor = jest.fn();
const v3InventoryIndexerConstructor = jest.fn();

type MockProgressOptions = {
  onProgressEvent?: (event: Record<string, unknown>) => void;
  includeItemDeletes?: boolean;
  full?: boolean;
};

function emitCompletedPhase(
  options: MockProgressOptions | boolean | undefined,
  phase: string,
  count: number
): void {
  if (!options || typeof options === 'boolean') return;
  options.onProgressEvent?.({
    phase,
    event: 'phase_completed',
    recordsProcessed: count,
    recordsTotal: count,
    indeterminate: false,
  });
}

class MockSalesBinderClient {
  constructor(_accountName?: string, runtimeOptions?: object) {
    if (runtimeOptions) clientRuntimeOptions.push(runtimeOptions);
  }
}
class MockSalesBinderV3Client {
  constructor(_accountName?: string, runtimeOptions?: object) {
    if (runtimeOptions) clientRuntimeOptions.push(runtimeOptions);
  }
}

class MockCacheSyncProgressReporter {
  private terminal = false;
  private readonly actual?: ActualCacheSyncProgressReporter;

  constructor(
    private readonly cache: { setSyncStatus(status: Record<string, unknown>): Promise<void> },
    private readonly context: Record<string, unknown>
  ) {
    if (useActualProgressReporter) {
      this.actual = new ActualCacheSyncProgressReporter(cache as never, context as never);
    }
  }

  async markRunning(summary: Record<string, unknown> = {}) {
    if (this.actual) return this.actual.markRunning(summary);
    await this.cache.setSyncStatus({ ...this.context, ...summary, status: 'running' });
  }

  emit(event: object) {
    if (!this.terminal) emittedProgress.push(event);
    this.actual?.emit(event as never);
  }

  async flush() {
    await this.actual?.flush();
  }

  async markSuccess(summary: Record<string, unknown> = {}) {
    if (this.terminal) return;
    checkpointPresentDuringTerminal = actualFileExists(mockCheckpointPath);
    terminalWriteProtected = outerPgLockHeld && innerSqlitePullLockHeld;
    if (this.actual) {
      await this.actual.markSuccess(summary);
      this.terminal = true;
      return;
    }
    await this.cache.setSyncStatus({ ...this.context, ...summary, status: 'success' });
    this.terminal = true;
  }

  async markSuccessWithWarnings(
    summary: Record<string, unknown> = {},
    recordIssues: object[] = []
  ) {
    if (this.terminal) return;
    checkpointPresentDuringTerminal = actualFileExists(mockCheckpointPath);
    terminalWriteProtected = outerPgLockHeld && innerSqlitePullLockHeld;
    if (this.actual) {
      await this.actual.markSuccessWithWarnings(summary, recordIssues as never);
      this.terminal = true;
      return;
    }
    await this.cache.setSyncStatus({
      ...this.context,
      ...summary,
      status: 'success_with_warnings',
      recordIssues,
    });
    this.terminal = true;
  }

  async markFailure(_error: unknown, summary: Record<string, unknown> = {}) {
    if (this.terminal) return;
    terminalWriteProtected = outerPgLockHeld && innerSqlitePullLockHeld;
    if (this.actual) {
      await this.actual.markFailure(_error, summary);
      this.terminal = true;
      return;
    }
    await this.cache.setSyncStatus({
      ...this.context,
      ...summary,
      status: 'failed',
      error: 'Cache sync failed.',
    });
    this.terminal = true;
  }
}

class SuccessfulAccountIndexer {
  async sync(options?: MockProgressOptions | boolean) {
    phaseOrder.push('accounts');
    if (accountSyncFailure) throw accountSyncFailure;
    emitCompletedPhase(options, 'accounts', 0);
    return { accountsProcessed: 0, customersProcessed: 0, suppliersProcessed: 0 };
  }
}

class SuccessfulDocumentIndexer {
  async sync(options?: MockProgressOptions) {
    phaseOrder.push('documents');
    options?.onProgressEvent?.({
      phase: 'documents',
      event: 'record_processed',
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
      currentRecordId: 'must-not-be-live',
      message: 'must-not-be-live',
    });
    emitCompletedPhase(options, 'documents', 0);
    return {
      success: true,
      type: options?.full ? ('full' as const) : ('delta' as const),
      documentsProcessed: 0,
      documentsDeleted: 0,
      lineItemsProcessed: 0,
      duration: '0s',
      syncLookbackSeconds: 604800,
      recordIssues: documentRecordIssues,
    };
  }

  async isCacheStale() {
    return false;
  }
}

class SuccessfulCategoryIndexer {
  constructor(...args: unknown[]) {
    categoryIndexerConstructor(...args);
  }

  async sync(options?: MockProgressOptions) {
    phaseOrder.push('categories');
    emitCompletedPhase(options, 'categories', 0);
    return { categoriesProcessed: 0, snapshot: null };
  }
}

class SuccessfulItemIndexer {
  constructor(...args: unknown[]) {
    v3InventoryIndexerConstructor(...args);
  }

  async sync(options?: MockProgressOptions) {
    phaseOrder.push('items');
    emitCompletedPhase(options, 'inventory', 0);
    return { itemsProcessed: 0, stockRowsProcessed: 0, recordIssues: itemRecordIssues };
  }
}

class SuccessfulDeletedLogSync {
  private readonly cache?: {
    getCacheState(): Promise<Record<string, unknown> | null>;
    setCacheState(state: Record<string, unknown>): Promise<void>;
  };

  constructor(_client?: unknown, cache?: SuccessfulDeletedLogSync['cache']) {
    this.cache = cache;
  }

  async sync(options?: MockProgressOptions) {
    phaseOrder.push('deleted-log');
    if (options) deletedLogSyncOptions.push(options);
    if (deletedLogFailure) throw deletedLogFailure;
    if (mockDeletedLogAdvancesState && this.cache) {
      const state = await this.cache.getCacheState();
      if (state) await this.cache.setCacheState({ ...state, lastDeletedSync: 222 });
    }
    emitCompletedPhase(options, 'deleted-log', 0);
    return {
      deletedRecordsProcessed: deletedLogDocumentTombstones.length,
      documentTombstones: deletedLogDocumentTombstones,
    };
  }
}

let registerCacheCommands: typeof import('./cache.commands.js').registerCacheCommands;

async function ensureRegisterCacheCommands(): Promise<typeof registerCacheCommands> {
  if (typeof registerCacheCommands === 'function') return registerCacheCommands;
  const module = await import('./cache.commands.js');
  if (typeof module.registerCacheCommands !== 'function') {
    throw new TypeError('registerCacheCommands export is unavailable');
  }
  registerCacheCommands = module.registerCacheCommands;
  return registerCacheCommands;
}

jest.mock(
  '@salesbinder/sdk',
  () => ({
    SalesBinderClient: MockSalesBinderClient,
    SalesBinderV3Client: MockSalesBinderV3Client,
    AccountIndexerService: SuccessfulAccountIndexer,
    CategoryIndexerService: SuccessfulCategoryIndexer,
    DocumentIndexerService: SuccessfulDocumentIndexer,
    V3InventoryIndexerService: SuccessfulItemIndexer,
    DeletedLogSyncService: SuccessfulDeletedLogSync,
    CacheSyncProgressReporter: MockCacheSyncProgressReporter,
    SQLiteCacheService: class {
      constructor() {
        return sqliteCacheService;
      }
    },
    createPostgresCacheService,
    pullFromPostgres,
    loadPreferences: jest.fn(() => ({})),
    loadConfig: (accountName: string) => mockLoadConfig(accountName),
    createSalesBinderAccountBinding: jest.fn(() => ({
      accountIdentity: 'salesbinder:example',
      accountSubdomain: 'example',
    })),
    CACHE_SCHEMA_VERSION: 7,
  }),
  { virtual: true }
);

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

function unresolvedInvoicePaymentStatus(mode: 'full' | 'delta') {
  return {
    status: 'failed',
    mode,
    startedAt: 100,
    updatedAt: 101,
    finishedAt: 101,
    lastSuccessfulSync: 90,
    cursor: 'invoice-race',
    processedDocuments: 1,
    totalDocuments: 1,
    error: 'Invoice document refresh completed with unresolved records.',
  };
}

async function settleSuccessfulPull(options?: MockPullOptions): Promise<MockPullResult> {
  expect(outerPgLockHeld).toBe(true);
  expect(options?.pgLockAlreadyHeld).toBe(true);
  innerSqlitePullLockHeld = true;
  const result = successfulPullResult();
  try {
    await options?.onSettledWhileLocked?.({ status: 'success', result });
    return result;
  } finally {
    innerSqlitePullLockHeld = false;
  }
}

async function settleFailedPull(error: Error, options?: MockPullOptions): Promise<never> {
  expect(outerPgLockHeld).toBe(true);
  expect(options?.pgLockAlreadyHeld).toBe(true);
  innerSqlitePullLockHeld = true;
  try {
    await options?.onSettledWhileLocked?.({ status: 'failed', error });
  } finally {
    innerSqlitePullLockHeld = false;
  }
  throw error;
}

async function runExplicitPull(): Promise<void> {
  await runCacheSync('--pull');
}

async function runCacheSync(...syncOptions: string[]): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  (await ensureRegisterCacheCommands())(program);
  await program.parseAsync(['node', 'test', 'cache', 'sync', ...syncOptions]);
}

async function runFullResume(withPull = false): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  (await ensureRegisterCacheCommands())(program);
  const args = ['node', 'test', 'cache', 'sync', '--full-resume'];
  if (withPull) args.push('--pull');
  await program.parseAsync(args);
}

async function runClear(forceUnbound = false): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  (await ensureRegisterCacheCommands())(program);
  const args = ['node', 'test', 'cache', 'clear'];
  if (forceUnbound) args.push('--force-unbound');
  await program.parseAsync(args);
}

async function runCacheStatus(): Promise<void> {
  const program = new Command();
  program.option('--account <account>');
  (await ensureRegisterCacheCommands())(program);
  await program.parseAsync(['node', 'test', 'cache', 'status']);
}

describe('cache sync --pull lock ordering', () => {
  const originalDatabaseUrl = process.env.SALESBINDER_DB_URL;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    jest
      .requireActual<typeof import('fs')>('fs')
      .rmSync(mockHomeDirectory, { recursive: true, force: true });
    process.env.SALESBINDER_DB_URL = 'postgres://example.test/salesbinder';
    process.exitCode = undefined;
    outerPgLockHeld = false;
    phaseOrder = [];
    documentRecordIssues = [];
    itemRecordIssues = [];
    deletedLogDocumentTombstones = [];
    accountSyncFailure = null;
    deletedLogFailure = null;
    paymentSyncStatus = null;
    mockDeletedLogAdvancesState = false;
    emittedProgress = [];
    clientRuntimeOptions = [];
    checkpointPresentDuringTerminal = undefined;
    checkpointPresentDuringOutput = undefined;
    mockCheckpointCleanupFailure = false;
    mockCheckpointWriteFailureAfterPayment = false;
    mockPaymentStatusWritten = false;
    innerSqlitePullLockHeld = false;
    terminalWriteProtected = undefined;
    deletedLogSyncOptions = [];
    useActualProgressReporter = false;
    jest.clearAllMocks();
    mockLoadConfig.mockReturnValue({ subdomain: 'example', v3ApiKey: 'test-v3-key' });
    outerPgService.getCacheState.mockResolvedValue(null);
    outerPgService.setCacheState.mockImplementation(async () => undefined);
    outerPgService.getSyncStatus.mockResolvedValue(null);
    outerPgService.getPaymentSyncStatus.mockImplementation(async () => paymentSyncStatus as never);
    outerPgService.setPaymentSyncStatus.mockImplementation(async (status) => {
      mockPaymentStatusWritten = true;
      paymentSyncStatus = status;
    });
    outerPgService.getCategoryCacheMeta.mockResolvedValue(null);
    outerPgService.getInventoryCacheMeta.mockResolvedValue(null);
    outerPgService.releaseSyncLock.mockImplementation(async () => {
      outerPgLockHeld = false;
    });
    pullFromPostgres.mockImplementation(async (_url, _account, _path, _binding, options) =>
      settleSuccessfulPull(options)
    );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {
      checkpointPresentDuringOutput = actualFileExists(mockCheckpointPath);
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.SALESBINDER_DB_URL;
    else process.env.SALESBINDER_DB_URL = originalDatabaseUrl;
    process.exitCode = originalExitCode;
    jest
      .requireActual<typeof import('fs')>('fs')
      .rmSync(mockHomeDirectory, { recursive: true, force: true });
  });

  it('holds one continuous PostgreSQL writer lock through pull terminal persistence', async () => {
    await runExplicitPull();

    expect(pullFromPostgres).toHaveBeenCalledTimes(1);
    expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
    expect(categoryIndexerConstructor).toHaveBeenCalledWith(
      expect.any(MockSalesBinderV3Client),
      outerPgService,
      'salesbinder:example',
      '3'
    );
    expect(v3InventoryIndexerConstructor).toHaveBeenCalledWith(
      expect.any(MockSalesBinderV3Client),
      outerPgService,
      'default',
      'salesbinder:example'
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
    expect(clientRuntimeOptions).toHaveLength(2);
    expect(clientRuntimeOptions).toEqual([
      { rateLimitObserver: expect.any(Function) },
      { rateLimitObserver: expect.any(Function) },
    ]);
    expect(emittedProgress.map((event) => (event as { phase: string }).phase)).toEqual(
      expect.arrayContaining([
        'accounts',
        'categories',
        'documents',
        'inventory',
        'deleted-log',
        'pg-to-sqlite-pull',
        'finalizing',
      ])
    );
    expect(deletedLogSyncOptions).toEqual([
      { onProgressEvent: expect.any(Function), includeItemDeletes: false },
    ]);
    expect(emittedProgress.some((event) => 'currentRecordId' in event || 'message' in event)).toBe(
      false
    );
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'success' })
    );
    expect(terminalWriteProtected).toBe(true);
    const terminalWrites = outerPgService.setSyncStatus.mock.calls.filter(
      ([status]) =>
        typeof status.status === 'string' &&
        ['success', 'success_with_warnings', 'failed'].includes(status.status)
    );
    expect(terminalWrites).toHaveLength(1);
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      (console.log as jest.Mock).mock.invocationCallOrder[0]
    );
    expect((console.log as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
    expect(pullFromPostgres).toHaveBeenCalledWith(
      'postgres://example.test/salesbinder',
      'default',
      undefined,
      expect.objectContaining({ accountIdentity: 'salesbinder:example' }),
      expect.objectContaining({
        pgLockAlreadyHeld: true,
        onSettledWhileLocked: expect.any(Function),
      })
    );
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('finishes with deterministic warning lists, exit zero, and unchanged clean watermarks', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'doc-z',
        context_id: 11,
        code: 'invalid_record',
        message: 'Authorization: Bearer warning-secret https://private.example/document',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
      {
        resource: 'document',
        id: 'doc-a',
        context_id: 5,
        code: 'not_found',
        message: 'Document unavailable during refresh',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];
    itemRecordIssues = [
      {
        resource: 'item',
        id: 'item-a',
        code: 'invalid_variations',
        message: 'Item variations failed source validation',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    outerPgService.getCacheState.mockResolvedValue({
      accountName: 'default',
      schemaVersion: 7,
      documentCount: 2,
      itemDocumentCount: 3,
      lastSync: 111,
      lastFullSync: 99,
    } as never);
    await runExplicitPull();

    const expectedIssues = [
      documentRecordIssues[1],
      {
        ...documentRecordIssues[0],
        message: 'Document failed source validation',
      },
      itemRecordIssues[0],
    ];

    expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
    expect(pullFromPostgres).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(output).toEqual(
      expect.objectContaining({
        success: true,
        status: 'success_with_warnings',
        failed_documents: expectedIssues.slice(0, 2),
        failed_items: itemRecordIssues,
      })
    );
    expect(JSON.stringify(output)).not.toMatch(/warning-secret|private\.example|Authorization/);
    expect(outerPgService.setCacheState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastSync: 111,
        lastFullSync: 99,
        lastSyncAttempt: expect.any(Number),
      })
    );
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'success_with_warnings',
        recordIssues: expectedIssues,
      })
    );
    expect(terminalWriteProtected).toBe(true);
  });

  it.each([
    ['normal', [] as string[], 'delta' as const],
    ['full', ['--full'], 'full' as const],
  ])(
    'lets an authoritative invoice tombstone resolve a %s-sync warning and payment failure',
    async (_label, syncOptions, syncType) => {
      documentRecordIssues = [
        {
          resource: 'document',
          id: 'invoice-race',
          context_id: 5,
          code: 'invalid_record',
          message: 'Bearer warning-secret',
          attempts: 2,
          outcome: 'preserved_last_known_good',
        },
      ];
      deletedLogDocumentTombstones = [
        { contextId: 5, apiDocumentId: 'invoice-race', raw: 'must not escape' },
      ];
      paymentSyncStatus = unresolvedInvoicePaymentStatus(syncType);

      await runCacheSync(...syncOptions);

      expect(process.exitCode).toBeUndefined();
      expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
      const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
        string,
        unknown
      >;
      expect(output).toEqual(
        expect.objectContaining({
          status: 'success',
          sync_type: syncType,
          failed_documents: [],
          failed_items: [],
        })
      );
      expect(paymentSyncStatus).toEqual(
        expect.objectContaining({
          status: 'complete',
          mode: syncType,
          processedDocuments: 1,
          totalDocuments: 1,
        })
      );
      expect(paymentSyncStatus).not.toHaveProperty('error');
      expect(outerPgService.setPaymentSyncStatus).toHaveBeenCalledTimes(1);
      expect(outerPgService.setPaymentSyncStatus.mock.invocationCallOrder[0]).toBeLessThan(
        outerPgService.setCacheState.mock.invocationCallOrder.at(-1) as number
      );
      expect(JSON.stringify(emittedProgress)).not.toContain('invoice-race');
      expect(JSON.stringify(output)).not.toMatch(/invoice-race|warning-secret|must not escape/);
    }
  );

  it('removes only exact context-plus-API-ID warnings and keeps the invoice payment failure', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'matched-invoice',
        context_id: 5,
        code: 'not_found',
        message: 'Missing',
        attempts: 2,
        outcome: 'omitted_new',
      },
      {
        resource: 'document',
        id: 'same-id-other-context',
        context_id: 5,
        code: 'invalid_record',
        message: 'Invalid',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    deletedLogDocumentTombstones = [
      { contextId: 4, apiDocumentId: 'same-id-other-context' },
      { contextId: 5, apiDocumentId: 'matched-invoice' },
    ];
    paymentSyncStatus = unresolvedInvoicePaymentStatus('delta');

    await runCacheSync();

    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      status: string;
      failed_documents: Array<{ id: string; context_id: number }>;
    };
    expect(output.status).toBe('success_with_warnings');
    expect(output.failed_documents).toEqual([
      expect.objectContaining({ id: 'same-id-other-context', context_id: 5 }),
    ]);
    expect(paymentSyncStatus).toEqual(unresolvedInvoicePaymentStatus('delta'));
    expect(outerPgService.setPaymentSyncStatus).not.toHaveBeenCalled();
  });

  it('never overwrites an unrelated payment-sync failure after resolving invoice warnings', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'invoice-race',
        context_id: 5,
        code: 'not_found',
        message: 'Missing',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];
    deletedLogDocumentTombstones = [{ contextId: 5, apiDocumentId: 'invoice-race' }];
    paymentSyncStatus = {
      ...unresolvedInvoicePaymentStatus('delta'),
      error: 'Payment sync failed',
    };

    await runCacheSync();

    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      status: string;
      failed_documents: unknown[];
    };
    expect(output).toEqual(expect.objectContaining({ status: 'success', failed_documents: [] }));
    expect(paymentSyncStatus).toEqual(
      expect.objectContaining({ status: 'failed', error: 'Payment sync failed' })
    );
    expect(outerPgService.setPaymentSyncStatus).not.toHaveBeenCalled();
  });

  it('rejects exact duplicate warnings instead of hiding them during final aggregation', async () => {
    const duplicate = {
      resource: 'item',
      id: 'item-duplicate',
      code: 'not_found',
      message: 'Authorization: Bearer duplicate-secret https://private.example/item',
      attempts: 2,
      outcome: 'omitted_new',
    };
    itemRecordIssues = [duplicate, { ...duplicate }];

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(pullFromPostgres).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).toContain('Cache sync failed.');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
      /duplicate-secret|private\.example|Authorization/
    );
    expect(JSON.stringify(outerPgService.setSyncStatus.mock.calls)).not.toMatch(
      /duplicate-secret|private\.example|Authorization/
    );
  });

  it('rejects duplicate document warnings with inconsistent contexts', async () => {
    const duplicate = {
      resource: 'document',
      id: 'document-duplicate',
      context_id: 4,
      code: 'not_found',
      message: 'Missing',
      attempts: 2,
      outcome: 'omitted_new',
    };
    documentRecordIssues = [duplicate, { ...duplicate, context_id: 5 }];

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(pullFromPostgres).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
  });

  it('orders Unicode warning IDs by UTF-16 code units in output and durable status', async () => {
    itemRecordIssues = ['é', '😀', 'ä', 'z'].map((id) => ({
      resource: 'item',
      id,
      code: 'not_found',
      message: 'Authorization: Bearer ordering-secret',
      attempts: 2,
      outcome: 'omitted_new',
    }));

    await runExplicitPull();

    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      failed_items: Array<{ id: string; message: string }>;
    };
    expect(output.failed_items.map(({ id }) => id)).toEqual(['z', 'ä', 'é', '😀']);
    expect(
      output.failed_items.every(({ message }) => message === 'Item unavailable during refresh')
    ).toBe(true);
    const durableWarnings = outerPgService.setSyncStatus.mock.calls.at(-1)?.[0].recordIssues as
      | Array<{ id: string; message: string }>
      | undefined;
    expect(durableWarnings?.map(({ id }) => id)).toEqual(['z', 'ä', 'é', '😀']);
    expect(JSON.stringify(output)).not.toMatch(/ordering-secret|Authorization|Bearer/);
    expect(JSON.stringify(durableWarnings)).not.toMatch(/ordering-secret|Authorization|Bearer/);
  });

  it('persists one failed terminal after a transient successful-terminal write failure', async () => {
    outerPgService.setSyncStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('private successful-terminal write detail'))
      .mockResolvedValueOnce(undefined);

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    const terminalWrites = outerPgService.setSyncStatus.mock.calls.filter(
      ([status]) =>
        typeof status.status === 'string' &&
        ['success', 'success_with_warnings', 'failed'].includes(status.status)
    );
    expect(terminalWrites.map(([status]) => status.status)).toEqual(['success', 'failed']);
    expect(terminalWrites.at(-1)?.[0]).toEqual(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      'private successful-terminal write detail'
    );
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });

  it('fails and compensates when queued routine status persistence rejects', async () => {
    const routineFailure = new Error('private routine status write detail');
    let failedPhaseStart = false;
    useActualProgressReporter = true;
    outerPgService.setSyncStatus.mockImplementation(async (status) => {
      const persistedProgress = status.progress as { phase?: unknown; event?: unknown } | undefined;
      if (
        !failedPhaseStart &&
        status.status === 'running' &&
        persistedProgress?.phase === 'finalizing' &&
        persistedProgress.event === 'phase_started'
      ) {
        failedPhaseStart = true;
        throw routineFailure;
      }
    });

    await runCacheSync();

    expect(failedPhaseStart).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    const finalizingRoutineWrites = outerPgService.setSyncStatus.mock.calls
      .map(([status]) => status)
      .filter(
        (status) =>
          status.status === 'running' &&
          (status.progress as { phase?: unknown } | undefined)?.phase === 'finalizing'
      );
    expect(
      finalizingRoutineWrites.map(
        (status) => (status.progress as { event?: unknown } | undefined)?.event
      )
    ).toEqual(['phase_started', 'phase_completed']);
    const terminalWrites = outerPgService.setSyncStatus.mock.calls.filter(
      ([status]) =>
        typeof status.status === 'string' &&
        ['success', 'success_with_warnings', 'failed'].includes(status.status)
    );
    expect(terminalWrites.map(([status]) => status.status)).toEqual(['failed']);
    expect(terminalWrites[0][0]).toEqual(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).toContain('Cache sync failed.');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      routineFailure.message
    );
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
  });

  it('preserves a 256-character warning identifier in terminal JSON', async () => {
    const id = 'i'.repeat(256);
    itemRecordIssues = [
      {
        resource: 'item',
        id,
        code: 'not_found',
        message: 'untrusted',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];

    await runExplicitPull();

    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      failed_items: Array<{ id: string }>;
    };
    expect(output.failed_items[0].id).toBe(id);
  });

  it('rejects a warning identifier longer than 256 characters', async () => {
    itemRecordIssues = [
      {
        resource: 'item',
        id: 'i'.repeat(257),
        code: 'not_found',
        message: 'untrusted',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Cache sync failed.',
      })
    );
  });

  it.each([
    ['unpaired high surrogate', 'item-\ud800'],
    ['unpaired low surrogate', 'item-\udc00'],
  ])('rejects a runtime warning identifier containing an %s', async (_label, id) => {
    itemRecordIssues = [
      {
        resource: 'item',
        id,
        code: 'not_found',
        message: 'untrusted',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];

    await runCacheSync();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
  });

  it.each([1, 999])(
    'rejects runtime warning attempts=%i instead of reporting it',
    async (attempts) => {
      itemRecordIssues = [
        {
          resource: 'item',
          id: 'attempt-contract-id',
          code: 'not_found',
          message: 'Bearer attempts-secret',
          attempts,
          outcome: 'omitted_new',
        },
      ];

      await runCacheSync();

      expect(process.exitCode).toBe(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items']);
      expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
      );
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
        /attempt-contract-id|attempts-secret|Bearer/
      );
    }
  );

  it.each(['invalid_variations', 'content_changed'])(
    'rejects item-only runtime warning code %s for a document',
    async (code) => {
      documentRecordIssues = [
        {
          resource: 'document',
          id: 'invalid-document-code',
          context_id: 5,
          code,
          message: 'Bearer warning-code-secret',
          attempts: 2,
          outcome: 'omitted_new',
        },
      ];

      await runCacheSync();

      expect(process.exitCode).toBe(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items']);
      expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
      );
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
        /invalid-document-code|warning-code-secret|Bearer/
      );
    }
  );

  it('keeps fatal-error stdout empty and persists failure before closing the cache', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'doc-a',
        context_id: 5,
        code: 'invalid_record',
        message: 'Document invalid',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ];
    deletedLogFailure = new Error('Bearer top-secret from https://private.example/documents');

    await runExplicitPull();

    expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
    expect(pullFromPostgres).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Cache sync failed.',
      })
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).toContain('Cache sync failed.');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
      /top-secret|private\.example/
    );
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      outerPgService.close.mock.invocationCallOrder[0]
    );
  });

  it('reconciles a restored full-resume warning before completing the deleted-log phase', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'invoice-race',
        context_id: 5,
        code: 'invalid_record',
        message: 'Document invalid',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    paymentSyncStatus = unresolvedInvoicePaymentStatus('full');
    deletedLogFailure = new Error('later phase failed');

    await runFullResume();

    expect(process.exitCode).toBe(1);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    expect(console.log).not.toHaveBeenCalled();

    process.exitCode = undefined;
    phaseOrder = [];
    documentRecordIssues = [];
    deletedLogFailure = null;
    deletedLogDocumentTombstones = [{ contextId: 5, apiDocumentId: 'invoice-race' }];
    (console.log as jest.Mock).mockClear();
    (console.error as jest.Mock).mockClear();
    outerPgService.setSyncStatus.mockClear();
    outerPgService.setCacheState.mockClear();

    await runFullResume();

    expect(process.exitCode).toBeUndefined();
    expect(phaseOrder).toEqual(['deleted-log']);
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(output).toEqual(
      expect.objectContaining({
        status: 'success',
        failed_documents: [],
        failed_items: [],
        full_resume: expect.objectContaining({
          granularity: 'phase+document-replay+atomic-v3-inventory-snapshot',
        }),
      })
    );
    expect(paymentSyncStatus).toEqual(
      expect.objectContaining({ status: 'complete', mode: 'full' })
    );
    expect(paymentSyncStatus).not.toHaveProperty('error');
    expect(checkpointPresentDuringTerminal).toBe(true);
    expect(checkpointPresentDuringOutput).toBe(true);
    expect(actualFileExists(mockCheckpointPath)).toBe(false);
  });

  it('restores completed deleted-log tombstones and refreshes changed payment evidence', async () => {
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'invoice-race',
        context_id: 5,
        code: 'invalid_record',
        message: 'Bearer checkpoint-secret',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    deletedLogDocumentTombstones = [{ contextId: 5, apiDocumentId: 'invoice-race' }];
    paymentSyncStatus = unresolvedInvoicePaymentStatus('full');
    outerPgService.setSyncStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('private terminal failure'))
      .mockResolvedValueOnce(undefined);

    await runFullResume();

    expect(process.exitCode).toBe(1);
    expect(phaseOrder).toEqual(['accounts', 'categories', 'documents', 'items', 'deleted-log']);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    const storedCheckpoint = JSON.parse(
      jest.requireActual<typeof import('fs')>('fs').readFileSync(mockCheckpointPath, 'utf8')
    ) as {
      phaseResults: {
        'deleted-log': { documentTombstones: object[] };
      };
      phaseEvidence: {
        'deleted-log': { paymentSyncStatusFingerprint: string | null };
      };
    };
    expect(storedCheckpoint.phaseResults['deleted-log'].documentTombstones).toEqual([
      { contextId: 5, apiDocumentId: 'invoice-race' },
    ]);
    expect(paymentSyncStatus).toEqual(
      expect.objectContaining({ status: 'complete', mode: 'full' })
    );

    const restoredPaymentFailure = unresolvedInvoicePaymentStatus('full');
    paymentSyncStatus = restoredPaymentFailure;
    storedCheckpoint.phaseEvidence['deleted-log'].paymentSyncStatusFingerprint =
      buildPaymentSyncStatusFingerprint(restoredPaymentFailure);
    jest
      .requireActual<typeof import('fs')>('fs')
      .writeFileSync(mockCheckpointPath, JSON.stringify(storedCheckpoint), { mode: 0o600 });
    process.exitCode = undefined;
    phaseOrder = [];
    documentRecordIssues = [];
    deletedLogDocumentTombstones = [];
    (console.log as jest.Mock).mockClear();
    (console.error as jest.Mock).mockClear();
    outerPgService.setSyncStatus.mockReset().mockResolvedValue(undefined);
    outerPgService.setPaymentSyncStatus.mockClear();

    await runFullResume();

    expect(process.exitCode).toBeUndefined();
    expect(phaseOrder).toEqual([]);
    expect(outerPgService.setPaymentSyncStatus).toHaveBeenCalledTimes(1);
    expect(paymentSyncStatus).toEqual(
      expect.objectContaining({ status: 'complete', mode: 'full' })
    );
    expect(paymentSyncStatus).not.toHaveProperty('error');
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(output).toEqual(
      expect.objectContaining({ status: 'success', failed_documents: [], failed_items: [] })
    );
    expect(JSON.stringify(output)).not.toMatch(/invoice-race|checkpoint-secret|documentTombstones/);
    expect(actualFileExists(mockCheckpointPath)).toBe(false);
  });

  it('does not persist stale deleted-log completion when its checkpoint write fails', async () => {
    let liveCacheState = {
      accountName: 'default',
      schemaVersion: 7,
      documentCount: 1,
      itemDocumentCount: 0,
      lastSync: 100,
      lastFullSync: 100,
      lastDeletedSync: 111,
    };
    outerPgService.getCacheState.mockImplementation(async () => liveCacheState as never);
    outerPgService.setCacheState.mockImplementation(async (state) => {
      liveCacheState = state as typeof liveCacheState;
    });
    mockDeletedLogAdvancesState = true;
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'invoice-race',
        context_id: 5,
        code: 'invalid_record',
        message: 'Bearer checkpoint-write-secret',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    deletedLogDocumentTombstones = [{ contextId: 5, apiDocumentId: 'invoice-race' }];
    paymentSyncStatus = unresolvedInvoicePaymentStatus('full');
    mockCheckpointWriteFailureAfterPayment = true;

    await runFullResume();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(paymentSyncStatus).toEqual(unresolvedInvoicePaymentStatus('full'));
    expect(liveCacheState.lastDeletedSync).toBe(111);
    expect(outerPgService.setPaymentSyncStatus).toHaveBeenCalledTimes(2);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    const storedCheckpoint = JSON.parse(
      jest.requireActual<typeof import('fs')>('fs').readFileSync(mockCheckpointPath, 'utf8')
    ) as {
      phase: string;
      completedPhases: string[];
      phaseResults: Record<string, unknown>;
    };
    expect(storedCheckpoint.phase).toBe('deleted-log');
    expect(storedCheckpoint.completedPhases).not.toContain('deleted-log');
    expect(storedCheckpoint.phaseResults).not.toHaveProperty('deleted-log');
    expect(outerPgService.setPaymentSyncStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockRenameSync.mock.invocationCallOrder.at(-1) as number
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
      /checkpoint-write-secret|private checkpoint write failure|invoice-race/
    );

    process.exitCode = undefined;
    phaseOrder = [];
    documentRecordIssues = [];
    (console.log as jest.Mock).mockClear();
    (console.error as jest.Mock).mockClear();
    outerPgService.setSyncStatus.mockClear();
    outerPgService.setPaymentSyncStatus.mockClear();

    await runFullResume();

    expect(process.exitCode).toBeUndefined();
    expect(phaseOrder).toEqual(['deleted-log']);
    expect(outerPgService.setPaymentSyncStatus).toHaveBeenCalledTimes(1);
    expect(paymentSyncStatus).toEqual(
      expect.objectContaining({ status: 'complete', mode: 'full' })
    );
    expect(liveCacheState.lastDeletedSync).toBe(222);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(output).toEqual(
      expect.objectContaining({ status: 'success', failed_documents: [], failed_items: [] })
    );
    expect(actualFileExists(mockCheckpointPath)).toBe(false);
  });

  it('restores deleted-log and payment state when payment finalization mutates then rejects', async () => {
    let liveCacheState = {
      accountName: 'default',
      schemaVersion: 7,
      documentCount: 1,
      itemDocumentCount: 0,
      lastSync: 100,
      lastFullSync: 100,
      lastDeletedSync: 111,
    };
    outerPgService.getCacheState.mockImplementation(async () => liveCacheState as never);
    outerPgService.setCacheState.mockImplementation(async (state) => {
      liveCacheState = state as typeof liveCacheState;
    });
    mockDeletedLogAdvancesState = true;
    documentRecordIssues = [
      {
        resource: 'document',
        id: 'invoice-payment-finalization-race',
        context_id: 5,
        code: 'invalid_record',
        message: 'Document failed source validation',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ];
    deletedLogDocumentTombstones = [
      { contextId: 5, apiDocumentId: 'invoice-payment-finalization-race' },
    ];
    const previousPaymentStatus = unresolvedInvoicePaymentStatus('full');
    paymentSyncStatus = previousPaymentStatus;
    const finalizationFailure = new Error('private payment status write failure');
    let paymentWrites = 0;
    outerPgService.setPaymentSyncStatus.mockImplementation(async (status) => {
      mockPaymentStatusWritten = true;
      paymentSyncStatus = status;
      paymentWrites++;
      if (paymentWrites === 1) throw finalizationFailure;
    });

    await runFullResume();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(liveCacheState.lastDeletedSync).toBe(111);
    expect(paymentSyncStatus).toEqual(previousPaymentStatus);
    expect(outerPgService.setPaymentSyncStatus).toHaveBeenCalledTimes(2);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    const storedCheckpoint = JSON.parse(
      jest.requireActual<typeof import('fs')>('fs').readFileSync(mockCheckpointPath, 'utf8')
    ) as { phase: string; completedPhases: string[]; phaseResults: Record<string, unknown> };
    expect(storedCheckpoint.phase).toBe('deleted-log');
    expect(storedCheckpoint.completedPhases).not.toContain('deleted-log');
    expect(storedCheckpoint.phaseResults).not.toHaveProperty('deleted-log');
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(
      /private payment status write failure|invoice-payment-finalization-race/
    );
  });

  it('restores the deleted-log watermark when tombstone validation fails after mutation', async () => {
    let liveCacheState = {
      accountName: 'default',
      schemaVersion: 7,
      documentCount: 0,
      itemDocumentCount: 0,
      lastSync: 100,
      lastFullSync: 100,
      lastDeletedSync: 111,
    };
    outerPgService.getCacheState.mockImplementation(async () => liveCacheState as never);
    outerPgService.setCacheState.mockImplementation(async (state) => {
      liveCacheState = state as typeof liveCacheState;
    });
    mockDeletedLogAdvancesState = true;
    deletedLogDocumentTombstones = [{ contextId: 5, apiDocumentId: 'invoice-\ud800' }];

    await runFullResume();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(liveCacheState.lastDeletedSync).toBe(111);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    const storedCheckpoint = JSON.parse(
      jest.requireActual<typeof import('fs')>('fs').readFileSync(mockCheckpointPath, 'utf8')
    ) as { phase: string; completedPhases: string[]; phaseResults: Record<string, unknown> };
    expect(storedCheckpoint.phase).toBe('deleted-log');
    expect(storedCheckpoint.completedPhases).not.toContain('deleted-log');
    expect(storedCheckpoint.phaseResults).not.toHaveProperty('deleted-log');
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
  });

  it('retains a checkpoint nonfatally when cleanup fails after terminal output', async () => {
    mockCheckpointCleanupFailure = true;

    await runFullResume(true);

    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(output).toEqual(expect.objectContaining({ success: true, status: 'success' }));
    expect(checkpointPresentDuringTerminal).toBe(true);
    expect(checkpointPresentDuringOutput).toBe(true);
    expect(actualFileExists(mockCheckpointPath)).toBe(true);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'success' })
    );
    expect(terminalWriteProtected).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint could not be removed')
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      'private cleanup detail'
    );
    expect((console.log as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockRmSync.mock.invocationCallOrder[0]
    );
    expect(mockRmSync.mock.invocationCallOrder[0]).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });

  it('fails before opening a cache backend when the v3 key is missing', async () => {
    mockLoadConfig.mockReturnValueOnce({ subdomain: 'example' });

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('API v3 key is required'));
    expect(createPostgresCacheService).not.toHaveBeenCalled();
    expect(outerPgService.ensureAccountBinding).not.toHaveBeenCalled();
    expect(outerPgService.tryAcquireSyncLock).not.toHaveBeenCalled();
    expect(outerPgService.setSyncStatus).not.toHaveBeenCalled();
    expect(pullFromPostgres).not.toHaveBeenCalled();
    expect(phaseOrder).toEqual([]);
  });

  it('reports an over-ceiling rate-limit wait clearly without exposing raw error details', async () => {
    accountSyncFailure = Object.assign(
      new Error('SalesBinder v3 private directive requested 999999 seconds'),
      { name: 'RateLimitWaitExceededError' }
    );

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).toContain(
      'SalesBinder rate-limit wait exceeded the 15-minute safety ceiling.'
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      'private directive'
    );
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
  });

  it('persists pull failure once while the continuous writer lock is held', async () => {
    pullFromPostgres.mockImplementation(async (_url, _account, _path, _binding, options) =>
      settleFailedPull(new Error('pull failed'), options)
    );

    await runExplicitPull();

    expect(process.exitCode).toBe(1);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Cache sync failed.' })
    );
    expect(terminalWriteProtected).toBe(true);
    const terminalWrites = outerPgService.setSyncStatus.mock.calls.filter(
      ([status]) =>
        typeof status.status === 'string' &&
        ['success', 'success_with_warnings', 'failed'].includes(status.status)
    );
    expect(terminalWrites).toHaveLength(1);
    expect(outerPgService.setSyncStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      outerPgService.releaseSyncLock.mock.invocationCallOrder[0]
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful result when final lock release falls back to connection close', async () => {
    outerPgService.releaseSyncLock.mockRejectedValueOnce(new Error('release failed'));

    await runExplicitPull();

    expect(pullFromPostgres).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(outerPgService.setSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'success' })
    );
    expect(outerPgService.releaseSyncLock).toHaveBeenCalledTimes(1);
    expect(outerPgService.close).toHaveBeenCalledTimes(1);
  });

  it('projects first-sync status progress and derives stale-running health without mutation', async () => {
    outerPgService.getCacheState.mockResolvedValue(null);
    const persistedStatus = {
      status: 'running',
      runId: 'run-stale',
      accountName: 'default',
      syncTarget: 'postgresql',
      startedAt: 100,
      updatedAt: 100,
      progressUpdatedAt: 100,
      message: 'Bearer persisted-secret',
      error: 'https://private.example/error',
      headers: { authorization: 'persisted-secret' },
      recordIssues: [
        {
          resource: 'document',
          id: 'doc-warning',
          context_id: 4,
          code: 'not_found',
          message: 'Bearer warning-status-secret from https://warning.example/body',
          attempts: 2,
          outcome: 'omitted_new',
        },
      ],
      progress: {
        phase: 'documents',
        event: 'record_processed',
        recordsProcessed: 2,
        recordsTotal: null,
        indeterminate: true,
        currentRecordId: 'must-not-leak',
      },
    };
    outerPgService.getSyncStatus.mockResolvedValue(persistedStatus as never);

    await runCacheStatus();

    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      sync_health: string;
      sync_status: { status: string; progress: Record<string, unknown> };
    };
    expect(output.sync_health).toBe('stale_running');
    expect(output.sync_status.status).toBe('running');
    expect(output.sync_status.progress).not.toHaveProperty('currentRecordId');
    expect(output.sync_status).toEqual(
      expect.objectContaining({
        recordIssues: [
          expect.objectContaining({
            id: 'doc-warning',
            message: 'Document unavailable during refresh',
          }),
        ],
      })
    );
    expect(JSON.stringify(output)).not.toMatch(
      /persisted-secret|private\.example|authorization|warning-status-secret|warning\.example/
    );
    expect(persistedStatus.progress).toHaveProperty('currentRecordId', 'must-not-leak');
    expect(outerPgService.setSyncStatus).not.toHaveBeenCalled();
    expect(outerPgService.releaseSyncLock).not.toHaveBeenCalled();
  });

  it.each([1, 999])('drops persisted cache-status warnings with attempts=%i', async (attempts) => {
    outerPgService.getSyncStatus.mockResolvedValue({
      status: 'success_with_warnings',
      recordIssues: [
        {
          resource: 'item',
          id: 'persisted-attempt-contract-id',
          code: 'not_found',
          message: 'Bearer persisted-attempt-secret',
          attempts,
          outcome: 'omitted_new',
        },
      ],
    } as never);

    await runCacheStatus();

    const output = JSON.parse((console.log as jest.Mock).mock.calls[0][0]) as {
      sync_status: Record<string, unknown>;
    };
    expect(output.sync_status).not.toHaveProperty('recordIssues');
    expect(JSON.stringify(output)).not.toMatch(
      /persisted-attempt-contract-id|persisted-attempt-secret|Bearer/
    );
  });

  it('reports an uninitialized sync contract when the SQLite cache does not exist', async () => {
    delete process.env.SALESBINDER_DB_URL;
    mockExistsSync.mockReturnValue(false);

    await runCacheStatus();

    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse((console.log as jest.Mock).mock.calls[0][0])).toEqual({
      backend: 'sqlite',
      exists: false,
      account: 'default',
      cache_file: `${mockHomeDirectory}/.salesbinder/cache/salesbinder-default.db`,
      sync_health: 'not_initialized',
      sync_status: 'not_initialized',
      message: 'Cache does not exist. Run "cache sync" to create it.',
    });
    expect(createPostgresCacheService).not.toHaveBeenCalled();
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
      accountIdentity: 'salesbinder:example',
      accountSubdomain: 'example',
    });
    expect(sqliteCacheService.verifyUnboundForDeletion).not.toHaveBeenCalled();
    expect(sqliteCacheService.closeDatabaseForDeletion).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    expect(sqliteCacheService.verifyAccountBinding.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnlinkSync.mock.invocationCallOrder[0]
    );
    expect(sqliteCacheService.closeDatabaseForDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnlinkSync.mock.invocationCallOrder[0]
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a mismatched binding without deleting any cache file', async () => {
    sqliteCacheService.verifyAccountBinding.mockRejectedValueOnce(
      new Error('not bound to salesbinder:example')
    );

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
      new Error('SQLite cache already has an account binding')
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
      expect.stringContaining('salesbinder-cache-file:')
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
