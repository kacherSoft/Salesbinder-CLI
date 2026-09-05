import { createCacheSyncScheduler } from './cache-sync-scheduler.js';
import type { FullAttemptStore } from './postgres-full-attempt-store.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

function databaseUrl(database: string): string {
  return ['postgres:', '', 'worker:password@database-host', database].join('/');
}

test('does not start sync after shutdown while durable throttle claim is pending', async () => {
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
  const calls: string[][] = [];
  let releaseClaim: (claimed: boolean) => void = () => undefined;
  let claimStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (claimStarted = resolve));
  const store: FullAttemptStore = {
    claim: jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseClaim = resolve;
          claimStarted();
        })
    ),
    close: jest.fn(async () => undefined),
  };
  const executor = {
    execute: jest.fn(async (args: string[]) => {
      calls.push(args);
      return { code: 0, output: '{"last_full_sync":"2000-01-01T00:00:00.000Z"}' };
    }),
    stop: jest.fn(),
  };
  const scheduler = createCacheSyncScheduler(config, { executor, fullAttemptStore: store });
  const running = scheduler.run();
  await started;
  scheduler.stop();
  releaseClaim(true);
  await running;
  expect(calls).toEqual([['--account', 'configured-account', 'cache', 'status']]);
});
