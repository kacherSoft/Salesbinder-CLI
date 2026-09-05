import type { CliExecutor } from './cli-process-executor.js';
import type { FullAttemptStore } from './postgres-full-attempt-store.js';
import type { SchedulerConfig } from './scheduler-config.js';

export const FULL_SYNC_RETRY_SECONDS = 86_400;

export interface SchedulerDependencies {
  executor: CliExecutor;
  fullAttemptStore: FullAttemptStore;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface CacheSyncScheduler {
  run(): Promise<void>;
  stop(signal?: NodeJS.Signals): void;
}

export function statusNeedsFullSync(
  output: string,
  nowMs: number,
  thresholdSeconds: number
): boolean {
  try {
    const lastFullSync = (JSON.parse(output) as Record<string, unknown>).last_full_sync;
    if (typeof lastFullSync !== 'string') return false;
    const timestamp = Date.parse(lastFullSync);
    return Number.isFinite(timestamp) && nowMs - timestamp >= thresholdSeconds * 1000;
  } catch {
    return false;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function claimFullAttempt(
  store: FullAttemptStore,
  timestampMs: number,
  warn: (message: string) => void
): Promise<boolean> {
  try {
    return await store.claim(timestampMs, FULL_SYNC_RETRY_SECONDS * 1000);
  } catch {
    warn('SalesBinder full-sync throttle unavailable; running incremental sync only.');
    return false;
  }
}

async function keepAlive(
  signal: AbortSignal,
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
): Promise<void> {
  while (!signal.aborted) await delay(86_400_000, signal);
}

export function createCacheSyncScheduler(
  config: SchedulerConfig,
  dependencies: SchedulerDependencies
): CacheSyncScheduler {
  const controller = new AbortController();
  const delay = dependencies.delay ?? abortableDelay;
  const now = dependencies.now ?? Date.now;
  const warn = dependencies.warn ?? console.warn;

  return {
    async run(): Promise<void> {
      if (config.disabled) return keepAlive(controller.signal, delay);
      const accountArgs = ['--account', config.accountName];
      while (!controller.signal.aborted) {
        const status = await dependencies.executor.execute(
          [...accountArgs, 'cache', 'status'],
          true
        );
        if (controller.signal.aborted) break;
        const currentTime = now();
        const fullDue =
          status.code === 0 &&
          statusNeedsFullSync(status.output, currentTime, config.fullSyncIntervalSeconds);
        const full =
          fullDue && (await claimFullAttempt(dependencies.fullAttemptStore, currentTime, warn));
        if (controller.signal.aborted) break;
        const sync = await dependencies.executor.execute(
          [...accountArgs, 'cache', 'sync', ...(full ? ['--full'] : [])],
          false
        );
        if (controller.signal.aborted) break;
        if (sync.code !== 0) warn('SalesBinder cache sync failed; retrying next cycle.');
        await delay(config.syncIntervalSeconds * 1000, controller.signal);
      }
    },
    stop(signal: NodeJS.Signals = 'SIGTERM'): void {
      controller.abort();
      dependencies.executor.stop(signal);
    },
  };
}
