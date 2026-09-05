import { createCacheSyncScheduler, statusNeedsFullSync } from './cache-sync-scheduler.js';
import type { CliExecutor, CommandResult } from './cli-process-executor.js';
import type { FullAttemptStore } from './postgres-full-attempt-store.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

function databaseUrl(database: string): string {
  return ['postgres:', '', 'worker:password@database-host', database].join('/');
}

function enabledConfig() {
  const config = validateSchedulerEnvironment({
    HOME: '/configured-home',
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'configured-account',
    SALESBINDER_SUBDOMAIN: 'configured-subdomain',
    SALESBINDER_API_KEY: 'configured-v2-credential',
    SALESBINDER_V3_API_KEY: 'configured-v3-credential',
    SALESBINDER_DB_URL: databaseUrl('cache'),
    SALESBINDER_CHANGE_FEED_DB_URL: databaseUrl('feed'),
    SALESBINDER_READ_BACKEND: 'postgresql',
  });
  if (config.disabled) throw new Error('Expected enabled configuration.');
  return config;
}

function fakeExecutor(results: CommandResult[], calls: string[][]): CliExecutor {
  return {
    async execute(args): Promise<CommandResult> {
      calls.push(args);
      return results.shift() ?? { code: 0, output: '' };
    },
    stop: jest.fn(),
  };
}

function memoryStore(): FullAttemptStore & { timestamp: number } {
  return {
    timestamp: 0,
    async claim(timestamp, retryMilliseconds) {
      if (timestamp - this.timestamp < retryMilliseconds) return false;
      this.timestamp = timestamp;
      return true;
    },
    close: jest.fn(async () => undefined),
  };
}

test('disabled scheduler stays alive without executing commands', async () => {
  const calls: string[][] = [];
  const executor = fakeExecutor([], calls);
  const scheduler = createCacheSyncScheduler(
    { disabled: true },
    {
      executor,
      fullAttemptStore: memoryStore(),
    }
  );
  const running = scheduler.run();
  await Promise.resolve();
  expect(calls).toEqual([]);
  scheduler.stop();
  await running;
  expect(executor.stop).toHaveBeenCalledWith('SIGTERM');
});

test('selects full only for an old valid authoritative timestamp', () => {
  const now = Date.parse('2030-01-08T00:00:00.000Z');
  expect(statusNeedsFullSync('{"last_full_sync":"2030-01-01T00:00:00.000Z"}', now, 604_800)).toBe(
    true
  );
  expect(statusNeedsFullSync('{}', now, 604_800)).toBe(false);
  expect(statusNeedsFullSync('unavailable', now, 604_800)).toBe(false);
});

test('runs status and sync immediately, then waits the default interval', async () => {
  const calls: string[][] = [];
  const executor = fakeExecutor(
    [
      { code: 0, output: '{"last_full_sync":"2030-01-01T00:00:00.000Z"}' },
      { code: 0, output: '' },
    ],
    calls
  );
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(enabledConfig(), {
    executor,
    fullAttemptStore: memoryStore(),
    now: () => Date.parse('2030-01-08T00:00:00.000Z'),
    delay: async (milliseconds) => {
      expect(milliseconds).toBe(900_000);
      scheduler.stop();
    },
  });
  await scheduler.run();
  expect(calls).toEqual([
    ['--account', 'configured-account', 'cache', 'status'],
    ['--account', 'configured-account', 'cache', 'sync', '--full'],
  ]);
});

test.each([
  ['failed', 1],
  ['warning-style', 0],
])('%s full attempt is throttled while incremental sync continues', async (_name, firstCode) => {
  const calls: string[][] = [];
  const oldStatus = '{"last_full_sync":"2030-01-01T00:00:00.000Z"}';
  const executor = fakeExecutor(
    [
      { code: 0, output: oldStatus },
      { code: firstCode, output: '' },
      { code: 0, output: oldStatus },
      { code: 0, output: '' },
    ],
    calls
  );
  let cycles = 0;
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(enabledConfig(), {
    executor,
    fullAttemptStore: memoryStore(),
    now: () => Date.parse('2030-01-08T00:00:00.000Z'),
    warn: () => undefined,
    delay: async () => {
      cycles += 1;
      if (cycles === 2) scheduler.stop();
    },
  });
  await scheduler.run();
  const syncCalls = calls.filter((args) => args.includes('sync'));
  expect(syncCalls[0].at(-1)).toBe('--full');
  expect(syncCalls[1].at(-1)).toBe('sync');
});

test('status failure selects normal sync and nonzero sync logs a constant warning', async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const executor = fakeExecutor(
    [
      { code: 1, output: '' },
      { code: 1, output: '' },
    ],
    calls
  );
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(enabledConfig(), {
    executor,
    fullAttemptStore: memoryStore(),
    warn: (message) => warnings.push(message),
    delay: async () => scheduler.stop(),
  });
  await scheduler.run();
  expect(calls[1]).toEqual(['--account', 'configured-account', 'cache', 'sync']);
  expect(warnings).toEqual(['SalesBinder cache sync failed; retrying next cycle.']);
});

test('durable throttle failure skips full but allows incremental sync with a constant warning', async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const store: FullAttemptStore = {
    claim: jest.fn(async () => {
      throw new Error('private database failure detail');
    }),
    close: jest.fn(async () => undefined),
  };
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(enabledConfig(), {
    executor: fakeExecutor(
      [
        { code: 0, output: '{"last_full_sync":"2030-01-01T00:00:00.000Z"}' },
        { code: 0, output: '' },
      ],
      calls
    ),
    fullAttemptStore: store,
    now: () => Date.parse('2030-01-08T00:00:00.000Z'),
    warn: (message) => warnings.push(message),
    delay: async () => scheduler.stop(),
  });
  await scheduler.run();
  expect(calls[1]).toEqual(['--account', 'configured-account', 'cache', 'sync']);
  expect(warnings).toEqual([
    'SalesBinder full-sync throttle unavailable; running incremental sync only.',
  ]);
});
