import { Command } from 'commander';

const mockReferenceStore = { getStatus: jest.fn() };
const mockPg = {
  verifyAccountBinding: jest.fn(async () => undefined),
  getReferenceRefreshStore: jest.fn(() => mockReferenceStore),
  tryAcquireSyncLock: jest.fn(async () => true),
  ensureSchema: jest.fn(async () => undefined),
  releaseSyncLock: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
};
const mockPgConstructor = jest.fn();
const mockLoadV3Config = jest.fn<{ subdomain: string; apiVersion: string; v3ApiKey?: string }, []>(() => ({
  subdomain: 'example',
  apiVersion: '2.0',
  v3ApiKey: 'v3-key',
}));
const mockLoadConfig = jest.fn(() => ({
  subdomain: 'example',
  apiVersion: '2.0',
  apiKey: 'v2-key',
  v3ApiKey: 'v3-key',
}));
const mockCreateReferenceRefreshService = jest.fn();

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
    loadV3Config: mockLoadV3Config,
    loadConfig: mockLoadConfig,
    createSalesBinderAccountBinding: jest.fn(() => ({ accountIdentity: 'salesbinder:example' })),
    createReferenceRefreshService: mockCreateReferenceRefreshService,
  }),
  { virtual: true }
);

describe('cache sync-references command', () => {
  let parseIfStale: typeof import('./cache-references-sync.command.js').parseIfStale;
  let registerCacheReferencesSyncCommand: typeof import('./cache-references-sync.command.js').registerCacheReferencesSyncCommand;

  beforeAll(async () => {
    const module = await import('./cache-references-sync.command.js');
    parseIfStale = module.parseIfStale;
    registerCacheReferencesSyncCommand = module.registerCacheReferencesSyncCommand;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.SALESBINDER_DB_URL;
    delete process.env.SALESBINDER_V3_API_KEY;
    delete process.env.SALESBINDER_API_KEY;
  });

  it('registers status and stale options', () => {
    const program = new Command();
    program.option('--account <account>');
    const cache = program.command('cache');
    registerCacheReferencesSyncCommand(cache, program);

    const command = cache.commands.find((entry) => entry.name() === 'sync-references');

    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--status', '--if-stale'])
    );
    expect(parseIfStale('86400')).toBe(86_400);
    expect(() => parseIfStale('1.5')).toThrow('--if-stale');
  });

  it('reads status without schema migration, API keys, or service construction', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    mockLoadV3Config.mockReturnValueOnce({ subdomain: 'example', apiVersion: '2.0' });
    mockReferenceStore.getStatus.mockResolvedValueOnce({
      version: 1,
      accountIdentity: 'salesbinder:example',
      resources: {},
    });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheReferencesSyncCommand(cache, program);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'test', 'cache', 'sync-references', '--status']);

    expect(mockPg.verifyAccountBinding).toHaveBeenCalled();
    expect(mockPg.ensureSchema).not.toHaveBeenCalled();
    expect(mockCreateReferenceRefreshService).not.toHaveBeenCalled();
    expect(mockReferenceStore.getStatus).toHaveBeenCalledWith('salesbinder:example');
    (console.log as jest.Mock).mockRestore();
  });

  it('runs V3-only reference refresh under the shared cache lock', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    mockLoadV3Config.mockReturnValueOnce({
      subdomain: 'example',
      apiVersion: '2.0',
      v3ApiKey: 'v3-key',
    });
    mockLoadConfig.mockImplementationOnce(() => {
      throw new Error('no v2 key');
    });
    const sync = jest.fn(async () => ({
      status: { run: { status: 'success_with_warnings' } },
      resources: [{ resource: 'users', outcome: 'skipped' }],
      skipped: false,
      coverage: 'references_only',
    }));
    mockCreateReferenceRefreshService.mockReturnValueOnce({ sync });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheReferencesSyncCommand(cache, program);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync([
      'node',
      'test',
      'cache',
      'sync-references',
      '--if-stale',
      '86400',
    ]);

    expect(mockPg.tryAcquireSyncLock).toHaveBeenCalledWith(
      'salesbinder-cache-sync:salesbinder:example',
      expect.any(Object)
    );
    expect(mockPg.ensureSchema).toHaveBeenCalled();
    expect(mockCreateReferenceRefreshService).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.any(String) }),
      mockPg,
      expect.any(Object),
      expect.any(Function)
    );
    expect(sync).toHaveBeenCalledWith({
      accountIdentity: 'salesbinder:example',
      ifStaleSeconds: 86_400,
    });
    expect(process.exitCode).toBeUndefined();
    expect(mockPg.releaseSyncLock).toHaveBeenCalled();
    expect(mockPg.close).toHaveBeenCalled();
    (console.log as jest.Mock).mockRestore();
  });

  it('exits nonzero for required reference failures after reporting structured result', async () => {
    process.env.SALESBINDER_DB_URL = 'postgres://example/salesbinder';
    const sync = jest.fn(async () => ({
      status: { run: { status: 'failed' } },
      resources: [{ resource: 'categories', outcome: 'failed' }],
      skipped: false,
      coverage: 'references_only',
    }));
    mockCreateReferenceRefreshService.mockReturnValueOnce({ sync });
    const program = new Command().option('--account <account>');
    const cache = program.command('cache');
    registerCacheReferencesSyncCommand(cache, program);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'test', 'cache', 'sync-references']);

    expect(process.exitCode).toBe(1);
    expect(mockPg.releaseSyncLock).toHaveBeenCalled();
    (console.log as jest.Mock).mockRestore();
  });
});
