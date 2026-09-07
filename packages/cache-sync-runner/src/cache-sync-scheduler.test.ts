import { getEventListeners } from 'node:events';
import {
  abortableDelay,
  createCacheSyncScheduler,
  selectSyncAction,
} from './cache-sync-scheduler.js';
import type { CliExecutor, CommandResult } from './cli-process-executor.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

function config(extra: NodeJS.ProcessEnv = {}) {
  const value = validateSchedulerEnvironment({
    HOME: '/home',
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'account',
    SALESBINDER_SUBDOMAIN: 'subdomain',
    SALESBINDER_V3_API_KEY: 'v3',
    SALESBINDER_DB_URL: 'postgres://user:password@host/cache',
    SALESBINDER_READ_BACKEND: 'postgresql',
    SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'disabled',
    ...extra,
  });
  if (value.disabled) throw new Error('Expected enabled configuration.');
  return value;
}

function executor(results: CommandResult[], calls: string[][]): CliExecutor {
  return {
    execute: async (args) => {
      calls.push(args);
      return results.shift() ?? { code: 0, output: '' };
    },
    stop: jest.fn(),
  };
}

const clean = JSON.stringify({
  run: { status: 'success' },
  state: { hasAppliedCursor: true, cursorGap: false },
});
const completed = JSON.stringify({ run: { status: 'success' }, tasks: { failed: 0, pending: 0 } });

test('selects strict official V3 transitions', () => {
  expect(selectSyncAction(null, '1788670542')).toBe('initialize');
  expect(selectSyncAction(null)).toBe('reconcile_required');
  for (const status of ['running', 'failed', 'success_with_warnings']) {
    expect(selectSyncAction({ run: { status } })).toBe('resume');
  }
  expect(selectSyncAction(JSON.parse(clean))).toBe('poll');
  expect(selectSyncAction({ run: { status: 'success' }, state: { hasAppliedCursor: false } })).toBe(
    'reconcile_required'
  );
  expect(selectSyncAction({ run: { status: 'unknown' } })).toBe('reconcile_required');
});

test('disabled scheduler stays alive without executing commands', async () => {
  const calls: string[][] = [];
  const run = createCacheSyncScheduler({ disabled: true }, { executor: executor([], calls) });
  const running = run.run();
  await Promise.resolve();
  expect(calls).toEqual([]);
  run.stop();
  await running;
});

test('cleans completed delay abort listeners before the next cycle', async () => {
  const controller = new AbortController();
  for (let index = 0; index < 20; index += 1) await abortableDelay(0, controller.signal);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('initializes only null state, resumes incomplete work, then polls a clean cursor', async () => {
  const calls: string[][] = [];
  let cycles = 0;
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(
    config({ SALESBINDER_V3_SYNC_INITIAL_SINCE: '1788670542' }),
    {
      executor: executor(
        [
          { code: 0, output: 'null' },
          { code: 0, output: completed },
          { code: 0, output: JSON.stringify({ run: { status: 'success_with_warnings' } }) },
          { code: 0, output: completed },
          { code: 0, output: clean },
          { code: 0, output: completed },
        ],
        calls
      ),
      delay: async (milliseconds) => {
        expect(milliseconds).toBeGreaterThan(299_000);
        expect(milliseconds).toBeLessThanOrEqual(300_000);
        if (++cycles === 3) scheduler.stop();
      },
    }
  );
  await scheduler.run();
  expect(calls).toEqual([
    ['--account', 'account', 'cache', 'sync-v3', '--status'],
    ['--account', 'account', 'cache', 'sync-v3', '--since', '1788670542'],
    ['--account', 'account', 'cache', 'sync-v3', '--status'],
    ['--account', 'account', 'cache', 'sync-v3', '--resume'],
    ['--account', 'account', 'cache', 'sync-v3', '--status'],
    ['--account', 'account', 'cache', 'sync-v3'],
  ]);
  expect(calls.flat()).not.toContain('sync');
  expect(calls.flat()).not.toContain('--full');
});

test('fails closed on malformed state and classifies lock contention as a skip', async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let delays = 0;
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(config(), {
    executor: executor(
      [
        { code: 0, output: 'bad' },
        { code: 0, output: clean },
        {
          code: 1,
          output: '',
          errorOutput: '[sync-v3] progress\n{\n  "error": true,\n  "code": "lock_busy"\n}',
        },
      ],
      calls
    ),
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    delay: async () => {
      if (++delays === 2) scheduler.stop();
    },
  });
  await scheduler.run();
  expect(calls).toEqual([
    ['--account', 'account', 'cache', 'sync-v3', '--status'],
    ['--account', 'account', 'cache', 'sync-v3', '--status'],
    ['--account', 'account', 'cache', 'sync-v3'],
  ]);
  expect(warnings).toEqual([
    'SalesBinder sync-v3 state requires reconciliation; cursor state was not changed.',
  ]);
  expect(infos).toEqual(['SalesBinder sync-v3 skipped: another writer holds the PostgreSQL lock.']);
});

test('coalesces an overrun and delegates durable reference freshness to --if-stale', async () => {
  const calls: string[][] = [];
  const times = [0, 400_000];
  const warnings: string[] = [];
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(
    config({ SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'daily' }),
    {
      executor: executor(
        [
          { code: 0, output: clean },
          { code: 0, output: completed },
          {
            code: 0,
            output: JSON.stringify({
              status: { run: { status: 'success_with_warnings' } },
              resources: [{ resource: 'users', outcome: 'warning', code: 'v2_unavailable' }],
            }),
          },
        ],
        calls
      ),
      now: () => times.shift() ?? 400_000,
      warn: (message) => warnings.push(message),
      delay: async (milliseconds) => {
        expect(milliseconds).toBe(0);
        scheduler.stop();
      },
    }
  );
  await scheduler.run();
  expect(calls.at(-1)).toEqual([
    '--account',
    'account',
    'cache',
    'sync-references',
    '--if-stale',
    '86400',
  ]);
  expect(warnings).toContain(
    'SalesBinder reference refresh completed with warnings: v2_unavailable'
  );
});

test('treats a fresh durable reference result as a healthy skipped cycle', async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  let scheduler: ReturnType<typeof createCacheSyncScheduler>;
  scheduler = createCacheSyncScheduler(
    config({ SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'daily' }),
    {
      executor: executor(
        [
          { code: 0, output: clean },
          { code: 0, output: completed },
          {
            code: 0,
            output: JSON.stringify({
              skipped: true,
              status: { run: { status: 'skipped' } },
              resources: [],
            }),
          },
        ],
        calls
      ),
      warn: (message) => warnings.push(message),
      delay: async () => scheduler.stop(),
    }
  );
  await scheduler.run();
  expect(calls.at(-1)).toEqual([
    '--account',
    'account',
    'cache',
    'sync-references',
    '--if-stale',
    '86400',
  ]);
  expect(warnings).toEqual([]);
});
