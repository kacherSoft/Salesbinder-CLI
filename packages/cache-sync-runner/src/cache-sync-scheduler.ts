import type { CliExecutor, CommandResult } from './cli-process-executor.js';
import type { SchedulerConfig } from './scheduler-config.js';

export type SyncAction = 'initialize' | 'resume' | 'poll' | 'reconcile_required';

export interface SchedulerDependencies {
  executor: CliExecutor;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

export interface CacheSyncScheduler {
  run(): Promise<void>;
  stop(signal?: NodeJS.Signals): void;
}

interface OfficialStatus {
  run?: { status?: unknown };
  state?: { hasAppliedCursor?: unknown; cursorGap?: unknown };
}

function parseTerminalJson(output: string): unknown | undefined {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const starts = [...trimmed.matchAll(/(?:^|\n)\{/g)].map(
      (match) => (match.index ?? 0) + match[0].length - 1
    );
    for (const start of starts.reverse()) {
      try {
        return JSON.parse(trimmed.slice(start)) as unknown;
      } catch {
        // The candidate was a progress line rather than the final JSON record.
      }
    }
    return undefined;
  }
}

export function selectSyncAction(status: unknown, initialSince?: string): SyncAction {
  if (status === null) return initialSince ? 'initialize' : 'reconcile_required';
  if (!status || typeof status !== 'object') return 'reconcile_required';
  const { run, state } = status as OfficialStatus;
  const runStatus = run?.status;
  if (runStatus === 'running' || runStatus === 'failed' || runStatus === 'success_with_warnings') {
    return 'resume';
  }
  if (runStatus === 'success' && state?.hasAppliedCursor === true && state.cursorGap === false) {
    return 'poll';
  }
  return 'reconcile_required';
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function keepAlive(
  signal: AbortSignal,
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
): Promise<void> {
  while (!signal.aborted) await delay(86_400_000, signal);
}

function argumentsFor(
  action: SyncAction,
  config: Extract<SchedulerConfig, { disabled: false }>
): string[] | null {
  if (action === 'initialize')
    return config.initialSince ? ['cache', 'sync-v3', '--since', config.initialSince] : null;
  if (action === 'resume') return ['cache', 'sync-v3', '--resume'];
  if (action === 'poll') return ['cache', 'sync-v3'];
  return null;
}

function errorCode(result: CommandResult): string | null {
  const parsed = parseTerminalJson(result.errorOutput ?? '');
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  return typeof record.code === 'string' ? record.code : null;
}

function isLockBusy(result: CommandResult): boolean {
  return errorCode(result) === 'lock_busy';
}

function hasWarnings(result: CommandResult): boolean {
  const parsed = parseTerminalJson(result.output);
  if (!parsed || typeof parsed !== 'object') return false;
  const record = parsed as Record<string, unknown>;
  const run = record.run as Record<string, unknown> | undefined;
  const tasks = record.tasks as Record<string, unknown> | undefined;
  return (
    run?.status === 'success_with_warnings' ||
    Number(tasks?.failed) > 0 ||
    Number(tasks?.pending) > 0
  );
}

function hasValidResult(result: CommandResult): boolean {
  const parsed = parseTerminalJson(result.output);
  if (!parsed || typeof parsed !== 'object') return false;
  const run = (parsed as Record<string, unknown>).run;
  return (
    !!run &&
    typeof run === 'object' &&
    ['success', 'success_with_warnings'].includes((run as Record<string, unknown>).status as string)
  );
}

function resultSummary(result: CommandResult): string | null {
  const parsed = parseTerminalJson(result.output);
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const run = record.run;
  if (!run || typeof run !== 'object') return null;
  const status = (run as Record<string, unknown>).status;
  if (status !== 'success' && status !== 'success_with_warnings') return null;
  const tasks =
    record.tasks && typeof record.tasks === 'object'
      ? (record.tasks as Record<string, unknown>)
      : {};
  const state =
    record.state && typeof record.state === 'object'
      ? (record.state as Record<string, unknown>)
      : {};
  return `SalesBinder sync-v3 result: status=${status}; applied=${Number(tasks.applied) || 0}; failed=${Number(tasks.failed) || 0}; pending=${Number(tasks.pending) || 0}; cursorGap=${state.cursorGap === true}.`;
}

async function refreshReferences(
  accountArgs: string[],
  intervalSeconds: number,
  executor: CliExecutor,
  warn: (message: string) => void,
  info: (message: string) => void
): Promise<void> {
  const refresh = await executor.execute(
    [...accountArgs, 'cache', 'sync-references', '--if-stale', String(intervalSeconds)],
    true
  );
  if (refresh.code !== 0) {
    warn('SalesBinder reference refresh failed; retrying on the next cycle.');
    return;
  }
  const parsed = parseTerminalJson(refresh.output);
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const statusRecord = record?.status;
  const run =
    statusRecord && typeof statusRecord === 'object'
      ? (statusRecord as Record<string, unknown>).run
      : null;
  const status = run && typeof run === 'object' ? (run as Record<string, unknown>).status : null;
  const resources = Array.isArray(record?.resources) ? record.resources : [];
  const codes = resources
    .map((failure) =>
      failure &&
      typeof failure === 'object' &&
      typeof (failure as Record<string, unknown>).code === 'string'
        ? (failure as Record<string, unknown>).code
        : null
    )
    .filter((code): code is string => code !== null)
    .slice(0, 10);
  if (status === 'success_with_warnings' || codes.length > 0) {
    warn(
      `SalesBinder reference refresh completed with warnings${codes.length ? `: ${codes.join(', ')}` : '.'}`
    );
  } else if (status === 'success' || status === 'skipped') {
    info(`SalesBinder reference refresh result: status=${status}.`);
  } else {
    warn(
      'SalesBinder reference refresh returned no valid result; durable freshness was not assumed.'
    );
  }
}

export function createCacheSyncScheduler(
  config: SchedulerConfig,
  dependencies: SchedulerDependencies
): CacheSyncScheduler {
  const controller = new AbortController();
  const delay = dependencies.delay ?? abortableDelay;
  const now = dependencies.now ?? Date.now;
  const warn = dependencies.warn ?? console.warn;
  const info = dependencies.info ?? console.info;

  return {
    async run(): Promise<void> {
      if (config.disabled) return keepAlive(controller.signal, delay);
      const accountArgs = ['--account', config.accountName];
      while (!controller.signal.aborted) {
        const cycleStartedAt = now();
        const status = await dependencies.executor.execute(
          [...accountArgs, 'cache', 'sync-v3', '--status'],
          true
        );
        if (controller.signal.aborted) break;
        if (status.code !== 0) {
          warn('SalesBinder sync-v3 status failed; reconciliation is required before polling.');
        } else {
          const action = selectSyncAction(parseTerminalJson(status.output), config.initialSince);
          const args = argumentsFor(action, config);
          if (!args) {
            warn(
              'SalesBinder sync-v3 state requires reconciliation; cursor state was not changed.'
            );
          } else {
            const sync = await dependencies.executor.execute([...accountArgs, ...args], true);
            if (sync.code !== 0) {
              if (isLockBusy(sync))
                info('SalesBinder sync-v3 skipped: another writer holds the PostgreSQL lock.');
              else if (errorCode(sync) === 'reconcile_required')
                warn('SalesBinder sync-v3 requires reconciliation; cursor state was not changed.');
              else
                warn('SalesBinder sync-v3 failed; retrying from durable state on the next cycle.');
            } else if (!hasValidResult(sync)) {
              warn(
                'SalesBinder sync-v3 returned no valid result; reconciliation is required before polling.'
              );
            } else if (hasWarnings(sync)) {
              warn(
                'SalesBinder sync-v3 completed with warnings; the next cycle will resume durable work.'
              );
            }
            const summary = resultSummary(sync);
            if (summary) info(summary);
          }
        }
        if (controller.signal.aborted) break;
        if (config.referenceSyncIntervalSeconds !== null) {
          await refreshReferences(
            accountArgs,
            config.referenceSyncIntervalSeconds,
            dependencies.executor,
            warn,
            info
          );
        }
        if (controller.signal.aborted) break;
        const remaining = Math.max(0, cycleStartedAt + config.syncIntervalSeconds * 1000 - now());
        await delay(remaining, controller.signal);
      }
    },
    stop(signal: NodeJS.Signals = 'SIGTERM'): void {
      controller.abort();
      dependencies.executor.stop(signal);
    },
  };
}
