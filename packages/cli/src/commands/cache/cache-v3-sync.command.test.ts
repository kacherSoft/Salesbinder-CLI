import { Command } from 'commander';

const mockStore = { getState: jest.fn(), getRun: jest.fn(), listTasks: jest.fn() };
const mockPg = {
  verifyAccountBinding: jest.fn(async () => undefined),
  getOfficialV3SyncStore: jest.fn(() => mockStore),
  tryAcquireSyncLock: jest.fn(async () => true),
  ensureSchema: jest.fn(async () => undefined),
  releaseSyncLock: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
};
const mockLoadConfig = jest.fn<{ subdomain: string; apiKey: string; v3ApiKey?: string }, []>(
  () => ({ subdomain: 'example', apiKey: 'v2', v3ApiKey: 'v3' })
);
const mockCreateService = jest.fn();
const mockStatus = jest.fn();
const mockPgConstructor = jest.fn();
jest.mock(
  '@salesbinder/sdk',
  () => ({
    PostgresSyncLockLostError: class extends Error {},
    PostgresCacheService: class {
      constructor() {
        mockPgConstructor();
        return mockPg;
      }
    },
    loadConfig: mockLoadConfig,
    createSalesBinderAccountBinding: jest.fn(() => ({ accountIdentity: 'salesbinder:example' })),
    createOfficialV3SyncService: mockCreateService,
    readOfficialV3SyncStatus: mockStatus,
  }),
  { virtual: true }
);

describe('cache sync-v3 option handling', () => {
  let parseSince: typeof import('./cache-v3-sync.command.js').parseSince;
  let registerCacheV3SyncCommand: typeof import('./cache-v3-sync.command.js').registerCacheV3SyncCommand;
  beforeAll(
    async () =>
      ({ parseSince, registerCacheV3SyncCommand } = await import('./cache-v3-sync.command.js'))
  );
  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.SALESBINDER_V3_API_KEY;
  });
  it('parses epoch seconds and ISO timestamps', () => {
    expect(parseSince('1788670542')).toBe(1788670542);
    expect(parseSince('2026-09-05T17:00:00.000Z')).toBe('2026-09-05T17:00:00.000Z');
  });

  it('rejects malformed since values', () => {
    expect(() => parseSince('1788670542000')).toThrow(
      '--since must be an ISO timestamp or Unix epoch seconds.'
    );
    expect(() => parseSince('2026-09-05T17:00:00')).toThrow(
      '--since must be an ISO timestamp or Unix epoch seconds.'
    );
    expect(() => parseSince('tomorrow')).toThrow(
      '--since must be an ISO timestamp or Unix epoch seconds.'
    );
  });

  it('registers the explicit command and mutually exclusive options', () => {
    const program = new Command();
    program.option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    const command = cache.commands.find((entry) => entry.name() === 'sync-v3');
    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--since', '--resume', '--status'])
    );
  });

  it('reads status without requiring V3 key, schema migration, or API service', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    delete process.env.SALESBINDER_V3_API_KEY;
    delete process.env.SALESBINDER_V3_API_KEY;
    mockLoadConfig.mockReturnValueOnce({ subdomain: 'example', apiKey: 'v2' });
    mockStatus.mockResolvedValueOnce({
      run: { entry: { kind: 'cursor' } },
      coverage: 'partial_catch_up',
    });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'test', 'cache', 'sync-v3', '--status']);
    expect(mockPg.ensureSchema).not.toHaveBeenCalled();
    expect(mockPgConstructor).toHaveBeenCalledTimes(1);
    expect(mockCreateService).not.toHaveBeenCalled();
    expect(mockStatus).toHaveBeenCalledWith(mockStore);
    (console.log as jest.Mock).mockRestore();
  });

  it('forwards since/account and sanitizes opaque cursor from result', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    process.env.SALESBINDER_V3_API_KEY = 'env-v3';
    const opaque = 'OPAQUE_CURSOR_SENTINEL';
    mockCreateService.mockReturnValueOnce({
      sync: jest.fn(async () => ({
        run: {
          version: 1,
          runId: 'run',
          accountIdentity: 'salesbinder:example',
          entry: { kind: 'cursor', value: opaque },
          status: 'success',
          ingestionComplete: true,
          pageCount: 1,
          startedAt: 1,
          updatedAt: 2,
        },
        state: { hasIngestionCursor: true, hasAppliedCursor: true, cursorGap: false },
        tasks: { discovered: 0 },
        failures: [],
        coverage: 'partial_catch_up',
      })),
    });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((v) => logs.push(String(v)));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'test', 'cache', 'sync-v3', '--since', '1788670542']);
    expect(mockPg.tryAcquireSyncLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockPg.ensureSchema.mock.invocationCallOrder.at(-1)!
    );
    expect(mockCreateService).toHaveBeenCalledWith(
      expect.objectContaining({ v3ApiKey: 'env-v3' }),
      mockPg,
      expect.any(Object),
      expect.any(Function)
    );
    expect(logs.join('\n')).not.toContain(opaque);
    (console.log as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
  });

  it('passes the selected mode to the SDK and rejects missing keys before opening PostgreSQL', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    delete process.env.SALESBINDER_V3_API_KEY;
    mockPgConstructor.mockClear();
    mockLoadConfig.mockReturnValueOnce({ subdomain: 'example', apiKey: 'v2' });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'test', 'cache', 'sync-v3', '--resume']);
    expect(mockPgConstructor).not.toHaveBeenCalled();
    (console.error as jest.Mock).mockRestore();
  });

  it('rejects conflicting and invalid dates before opening PostgreSQL', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    for (const args of [
      ['--since', '2026-02-30T00:00:00Z'],
      ['--since', '1788670542', '--resume'],
    ]) {
      mockPgConstructor.mockClear();
      process.exitCode = undefined;
      const program = new Command().option('--account <account>');
      const cache = program.command('cache');
      registerCacheV3SyncCommand(cache, program);
      await program.parseAsync(['node', 'test', 'cache', 'sync-v3', ...args]);
      expect(mockPgConstructor).not.toHaveBeenCalled();
    }
  });

  it('forwards resume and no-option poll modes to the SDK', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    process.env.SALESBINDER_V3_API_KEY = 'env-v3';
    const sync = jest.fn(async (_options?: Record<string, unknown>) => ({
      run: { entry: { kind: 'cursor', value: 'secret' }, status: 'success' },
      state: {},
      tasks: {},
      failures: [],
      coverage: 'partial_catch_up',
    }));
    mockCreateService.mockReturnValue({ sync });
    for (const args of [['--resume'], []] as string[][]) {
      const program = new Command().option('--account <account>');
      const cache = program.command('cache');
      registerCacheV3SyncCommand(cache, program);
      await program.parseAsync(['node', 'test', 'cache', 'sync-v3', ...args]);
    }
    expect(sync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountIdentity: 'salesbinder:example', resume: true })
    );
    expect(sync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountIdentity: 'salesbinder:example' })
    );
    expect(sync.mock.calls[1][0]?.resume).toBeUndefined();
  });

  it('releases the lock and closes after a sync failure', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    process.env.SALESBINDER_V3_API_KEY = 'env-v3';
    mockCreateService.mockReturnValueOnce({
      sync: jest.fn(async () => {
        throw Object.assign(new Error('private'), { code: 'source_failed' });
      }),
    });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    await program.parseAsync(['node', 'test', 'cache', 'sync-v3', '--since', '1788670542']);
    expect(mockPg.releaseSyncLock).toHaveBeenCalled();
    expect(mockPg.close).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('preserves warning status and stops safely on lock loss', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    process.env.SALESBINDER_V3_API_KEY = 'env-v3';
    mockCreateService.mockReturnValueOnce({
      sync: jest.fn(async () => ({
        run: { entry: { kind: 'since', value: '1788670542' }, status: 'success_with_warnings' },
        state: {},
        tasks: {},
        failures: [{ code: 'pending' }],
        coverage: 'partial_catch_up',
      })),
    });
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((v) => logs.push(String(v)));
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheV3SyncCommand(cache, program);
    await program.parseAsync(['node', 'test', 'cache', 'sync-v3', '--since', '1788670542']);
    expect(logs.join('\n')).toContain('success_with_warnings');
    (console.log as jest.Mock).mockRestore();
    (mockPg.tryAcquireSyncLock as jest.Mock).mockImplementationOnce(
      async (_key: string, options?: { onLost?: () => void }) => {
        options?.onLost?.();
        return true;
      }
    );
    const lockProgram = new Command().option('--account <account>');
    const lockCache = lockProgram.command('cache');
    registerCacheV3SyncCommand(lockCache, lockProgram);
    await lockProgram.parseAsync(['node', 'test', 'cache', 'sync-v3', '--resume']);
    expect(mockPg.close).toHaveBeenCalled();
  });
});
