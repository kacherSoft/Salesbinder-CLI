import type { Command } from 'commander';
import { formatJson } from '../../output/json.formatter.js';
import {
  awaitWhileSyncLockHeld,
  createSyncLockLossGuard,
} from './postgres-sync-lock-loss.guard.js';
import type { OfficialV3SyncResult, OfficialV3SyncStore } from '@salesbinder/sdk';

class OfficialV3SyncCommandError extends Error {}

export function registerCacheV3SyncCommand(cache: Command, program: Command): void {
  cache
    .command('sync-v3')
    .description('Run explicit PostgreSQL partial catch-up using the official V3 change feed')
    .option('--since <since>', 'Initial ISO timestamp or Unix epoch seconds')
    .option('--resume', 'Resume interrupted or warning work; clean completed runs are a no-op')
    .option('--status', 'Read sanitized official V3 sync status without schema/API writes')
    .action(async (options: { since?: string; resume?: boolean; status?: boolean }) => {
      let service: { releaseSyncLock(key: string): Promise<void>; close(): Promise<void> } | null =
        null;
      let lockKey: string | null = null;
      let locked = false;
      const lockLoss = createSyncLockLossGuard();
      try {
        const sdk = await import('@salesbinder/sdk');
        validateOptions(options);
        const dbUrl = process.env.SALESBINDER_DB_URL;
        if (!dbUrl)
          throw new OfficialV3SyncCommandError(
            'SALESBINDER_DB_URL is required; sync-v3 is PostgreSQL-only.'
          );
        const account = sdk.loadV3Config(program.opts().account || 'default');
        const binding = sdk.createSalesBinderAccountBinding(account.subdomain);
        const v3ApiKey = process.env.SALESBINDER_V3_API_KEY ?? account.v3ApiKey;
        if (!options.status && !v3ApiKey?.trim())
          throw new OfficialV3SyncCommandError('A V3 key is required for sync-v3.');
        const pg = new sdk.PostgresCacheService(dbUrl);
        service = pg;
        await pg.verifyAccountBinding(binding);
        const store: OfficialV3SyncStore = pg.getOfficialV3SyncStore();
        if (options.status) {
          const status = await sdk.readOfficialV3SyncStatus(store);
          console.log(formatJson(status));
          return;
        }
        lockKey = `salesbinder-cache-sync:${binding.accountIdentity}`;
        const activeLockKey = lockKey;
        locked = await awaitWhileSyncLockHeld(lockLoss, () =>
          pg.tryAcquireSyncLock(activeLockKey, { onLost: lockLoss.onLost })
        );
        if (!locked)
          throw new OfficialV3SyncCommandError('Another cache writer is running for this account.');
        await awaitWhileSyncLockHeld(lockLoss, () => pg.ensureSchema());
        lockLoss.assertHeld();
        const sync = sdk.createOfficialV3SyncService(
          { ...account, v3ApiKey },
          pg,
          {
            signal: lockLoss.signal,
            rateLimitObserver: (event: { type: string; apiVersion?: string }) => {
              if (event.type === 'wait' || event.type === 'cooldown')
                console.error(`[sync-v3] ${event.apiVersion ?? 'v3'} rate limit wait`);
            },
          },
          lockLoss.assertHeld
        );
        console.error('[sync-v3] official V3 partial catch-up started');
        const result = await awaitWhileSyncLockHeld(lockLoss, () =>
          sync.sync({
            accountIdentity: binding.accountIdentity,
            ...(options.since === undefined ? {} : { since: parseSince(options.since) }),
            ...(options.resume ? { resume: true } : {}),
            onProgress: (progress: {
              phase: string;
              event: string;
              completed: number;
              total: number;
              failed: number;
            }) =>
              console.error(
                `[sync-v3] ${progress.phase}: ${progress.event} ${progress.completed}/${progress.total}; failed=${progress.failed}`
              ),
          })
        );
        lockLoss.assertHeld();
        console.log(formatJson(sanitizeResult(result)));
      } catch (error) {
        const message =
          error instanceof OfficialV3SyncCommandError
            ? error.message
            : safeOfficialError(error, lockLoss.isLost());
        console.error(
          formatJson({ error: true, code: machineOutcomeCode(error, lockLoss.isLost()), message })
        );
        process.exitCode = 1;
      } finally {
        try {
          if (service && lockKey && locked) await service.releaseSyncLock(lockKey);
        } catch {
          /* close releases the session */
        }
        try {
          await service?.close();
        } catch {
          /* avoid a second terminal error */
        }
      }
    });
}

function validateOptions(options: { since?: string; resume?: boolean; status?: boolean }): void {
  const selected =
    Number(Boolean(options.since)) +
    Number(Boolean(options.resume)) +
    Number(Boolean(options.status));
  if (selected > 1)
    throw new OfficialV3SyncCommandError('--since, --resume, and --status are mutually exclusive.');
  if (options.since !== undefined) parseSince(options.since);
}

export function parseSince(value: string): string | number {
  if (/^\d{1,10}$/.test(value)) {
    const epoch = Number(value);
    if (Number.isSafeInteger(epoch) && epoch >= 0 && epoch < 100_000_000_000)
      return validateSinceWindow(epoch * 1000, epoch);
  }
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed) && isoMatch && /(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= new Date(Date.UTC(Number(isoMatch[1]), month, 0)).getUTCDate()
    ) {
      validateSinceWindow(parsed, value);
      return value;
    }
  }
  throw new OfficialV3SyncCommandError('--since must be an ISO timestamp or Unix epoch seconds.');
}

function validateSinceWindow(milliseconds: number, result: string | number): string | number {
  const now = Date.now();
  if (milliseconds > now) throw new OfficialV3SyncCommandError('--since cannot be in the future.');
  if (milliseconds < now - 90 * 24 * 60 * 60 * 1000)
    throw new OfficialV3SyncCommandError('--since exceeds the 90-day retention window.');
  return result;
}

function sanitizeResult(result: OfficialV3SyncResult): Record<string, unknown> {
  const run = result.run;
  return {
    run: {
      version: run.version,
      runId: run.runId,
      accountIdentity: run.accountIdentity,
      entry: { kind: run.entry?.kind },
      status: run.status,
      ingestionComplete: run.ingestionComplete,
      pageCount: run.pageCount,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
    },
    state: result.state,
    tasks: result.tasks,
    failures: result.failures,
    coverage: 'partial_catch_up',
  };
}

function safeOfficialError(error: unknown, lostLock: boolean): string {
  if (lostLock) return 'Sync-v3 stopped: PostgreSQL writer lock lost. Saved work can be resumed.';
  const source = error as { code?: unknown; response?: { status?: unknown } } | null;
  const code =
    typeof source?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(source.code)
      ? source.code
      : 'failed';
  const status = Number(source?.response?.status);
  if (status === 401 || status === 403)
    return `Sync-v3 stopped: API authorization failed (${status}).`;
  return `Sync-v3 ${code}. Check cache sync-v3 --status; use --resume after resolving the failure.`;
}

function machineOutcomeCode(error: unknown, lostLock: boolean): string {
  if (lostLock) return 'sync_failed';
  if (error instanceof OfficialV3SyncCommandError) {
    if (error.message.includes('Another cache writer')) return 'lock_busy';
    if (error.message.includes('required') || error.message.includes('configuration'))
      return 'configuration_error';
    return 'configuration_error';
  }
  const source = error as { code?: unknown; response?: { status?: unknown } } | null;
  const wrappedCode = typeof source?.code === 'string' ? source.code : '';
  if (wrappedCode === 'authentication_failed') return 'authorization_failed';
  if (wrappedCode === 'rebuild_required' || wrappedCode === 'account_mismatch')
    return 'reconcile_required';
  if (
    [
      'invalid_account',
      'invalid_options',
      'since_required',
      'since_state_exists',
      'no_run_to_resume',
      'resume_required',
      'resume_cursor_missing',
    ].includes(wrappedCode)
  )
    return 'configuration_error';
  const status = Number(source?.response?.status);
  if (status === 401 || status === 403) return 'authorization_failed';
  if (
    status === 409 ||
    (typeof source?.code === 'string' && /reconcile|cursor_expired|full_refresh/i.test(source.code))
  )
    return 'reconcile_required';
  return 'sync_failed';
}
