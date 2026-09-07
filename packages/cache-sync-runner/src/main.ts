import { fileURLToPath } from 'node:url';
import { createCacheSyncScheduler } from './cache-sync-scheduler.js';
import { createCliExecutor } from './cli-process-executor.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

async function main(): Promise<void> {
  const config = validateSchedulerEnvironment(process.env);
  const childEnvironment = { ...process.env };
  if (!config.disabled) {
    childEnvironment.SALESBINDER_DB_URL = config.cacheDatabaseUrl;
    childEnvironment.SALESBINDER_READ_BACKEND = 'postgresql';
    delete childEnvironment.SALESBINDER_CHANGE_FEED_DB_URL;
  }
  const executor = createCliExecutor({
    env: childEnvironment,
    cliPath: fileURLToPath(new URL('../../cli/dist/cli.js', import.meta.url)),
  });
  const scheduler = createCacheSyncScheduler(config, { executor });
  const stopInterrupt = (): void => scheduler.stop('SIGINT');
  const stopTerminate = (): void => scheduler.stop('SIGTERM');
  process.once('SIGINT', stopInterrupt);
  process.once('SIGTERM', stopTerminate);
  try {
    await scheduler.run();
  } finally {
    process.removeListener('SIGINT', stopInterrupt);
    process.removeListener('SIGTERM', stopTerminate);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Scheduler startup failed.');
  process.exitCode = 1;
});
