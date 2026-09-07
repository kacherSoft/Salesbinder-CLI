import { createCacheSyncScheduler } from './cache-sync-scheduler.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

test('does not start sync after shutdown while status is pending', async () => {
  const config = validateSchedulerEnvironment({
    HOME: '/home',
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'account',
    SALESBINDER_SUBDOMAIN: 'subdomain',
    SALESBINDER_V3_API_KEY: 'v3',
    SALESBINDER_DB_URL: 'postgres://user:password@host/cache',
    SALESBINDER_READ_BACKEND: 'postgresql',
    SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'disabled',
  });
  if (config.disabled) throw new Error('Expected enabled configuration.');
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const execute = jest.fn(async () => {
    await pending;
    return { code: 0, output: 'null' };
  });
  const scheduler = createCacheSyncScheduler(config, { executor: { execute, stop: jest.fn() } });
  const running = scheduler.run();
  await Promise.resolve();
  scheduler.stop();
  release();
  await running;
  expect(execute).toHaveBeenCalledTimes(1);
});
