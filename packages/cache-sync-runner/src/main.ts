import { fileURLToPath } from 'node:url';
import { createCacheSyncScheduler } from './cache-sync-scheduler.js';
import { createCliExecutor } from './cli-process-executor.js';
import {
  createPostgresFullAttemptStore,
  type FullAttemptStore,
} from './postgres-full-attempt-store.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

async function main(): Promise<void> {
  const config = validateSchedulerEnvironment(process.env);
  const childEnvironment = config.disabled
    ? process.env
    : {
        ...process.env,
        SALESBINDER_DB_URL: config.cacheDatabaseUrl,
        SALESBINDER_CHANGE_FEED_DB_URL: config.changeFeedDatabaseUrl,
        SALESBINDER_READ_BACKEND: 'postgresql',
      };
  const executor = createCliExecutor({
    env: childEnvironment,
    cliPath: fileURLToPath(new URL('../../cli/dist/cli.js', import.meta.url)),
  });
  const fullAttemptStore: FullAttemptStore = config.disabled
    ? { claim: async () => false, close: async () => undefined }
    : createPostgresFullAttemptStore(config.cacheDatabaseUrl);
  const scheduler = createCacheSyncScheduler(config, {
    executor,
    fullAttemptStore,
  });
  const stopInterrupt = (): void => scheduler.stop('SIGINT');
  const stopTerminate = (): void => scheduler.stop('SIGTERM');
  process.once('SIGINT', stopInterrupt);
  process.once('SIGTERM', stopTerminate);
  try {
    await scheduler.run();
  } finally {
    process.removeListener('SIGINT', stopInterrupt);
    process.removeListener('SIGTERM', stopTerminate);
    await fullAttemptStore.close().catch(() => {
      console.warn('SalesBinder full-sync throttle shutdown failed.');
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Scheduler startup failed.');
  process.exitCode = 1;
});
