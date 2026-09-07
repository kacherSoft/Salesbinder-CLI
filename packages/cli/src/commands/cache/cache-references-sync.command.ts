import type { Command } from 'commander';
import { formatJson } from '../../output/json.formatter.js';
import {
  awaitWhileSyncLockHeld,
  createSyncLockLossGuard,
} from './postgres-sync-lock-loss.guard.js';

class ReferenceSyncCommandError extends Error {}

export function registerCacheReferencesSyncCommand(cache: Command, program: Command): void {
  cache
    .command('sync-references')
    .description('Refresh explicit PostgreSQL reference data for the bound SalesBinder account')
    .option('--status', 'Read reference refresh status without schema/API writes')
    .option('--if-stale <seconds>', 'Skip when every managed reference was attempted recently')
    .action(async (options: { status?: boolean; ifStale?: string }) => {
      let service: { releaseSyncLock(key: string): Promise<void>; close(): Promise<void> } | null =
        null;
      let lockKey: string | null = null;
      let locked = false;
      const lockLoss = createSyncLockLossGuard();
      try {
        const sdk = await import('@salesbinder/sdk');
        const ifStaleSeconds = parseIfStale(options.ifStale);
        const dbUrl = process.env.SALESBINDER_DB_URL;
        if (!dbUrl) {
          throw new ReferenceSyncCommandError(
            'SALESBINDER_DB_URL is required; sync-references is PostgreSQL-only.'
          );
        }
        const accountName = program.opts().account || 'default';
        const account = sdk.loadV3Config(accountName);
        const binding = sdk.createSalesBinderAccountBinding(account.subdomain);
        const v3ApiKey = process.env.SALESBINDER_V3_API_KEY ?? account.v3ApiKey;
        const pg = new sdk.PostgresCacheService(dbUrl);
        service = pg;
        await pg.verifyAccountBinding(binding);
        if (options.status) {
          console.log(formatJson(await pg.getReferenceRefreshStore().getStatus(binding.accountIdentity)));
          return;
        }
        if (!v3ApiKey?.trim()) {
          throw new ReferenceSyncCommandError('A V3 key is required for reference refresh.');
        }
        const v2ApiKey = readOptionalV2ApiKey(sdk, accountName);
        const sync = sdk.createReferenceRefreshService(
          { ...account, v3ApiKey, ...(v2ApiKey ? { apiKey: v2ApiKey } : {}) },
          pg,
          {
            signal: lockLoss.signal,
            rateLimitObserver: (event: { type: string; apiVersion?: string }) => {
              if (event.type === 'wait' || event.type === 'cooldown') {
                console.error(`[sync-references] ${event.apiVersion ?? 'api'} rate limit wait`);
              }
            },
          },
          lockLoss.assertHeld
        );
        lockKey = `salesbinder-cache-sync:${binding.accountIdentity}`;
        const activeLockKey = lockKey;
        locked = await awaitWhileSyncLockHeld(lockLoss, () =>
          pg.tryAcquireSyncLock(activeLockKey, { onLost: lockLoss.onLost })
        );
        if (!locked) {
          throw new ReferenceSyncCommandError('Another cache writer is running for this account.');
        }
        await awaitWhileSyncLockHeld(lockLoss, () => pg.ensureSchema());
        const result = await awaitWhileSyncLockHeld(lockLoss, () =>
          sync.sync({ accountIdentity: binding.accountIdentity, ifStaleSeconds })
        );
        console.log(formatJson(result));
        if (result.status.run?.status === 'failed') process.exitCode = 1;
      } catch (error) {
        const message =
          error instanceof ReferenceSyncCommandError
            ? error.message
            : safeReferenceError(error, lockLoss.isLost());
        console.error(formatJson({ error: true, message }));
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

export function parseIfStale(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ReferenceSyncCommandError('--if-stale must be a non-negative integer.');
  }
  return Number(value);
}

function readOptionalV2ApiKey(
  sdk: { loadConfig(accountName?: string): { apiKey?: string } },
  accountName: string
): string | undefined {
  const envKey = process.env.SALESBINDER_API_KEY;
  if (envKey?.trim()) return envKey;
  try {
    const key = sdk.loadConfig(accountName).apiKey;
    return key?.trim() ? key : undefined;
  } catch {
    return undefined;
  }
}

function safeReferenceError(error: unknown, lostLock: boolean): string {
  if (lostLock) {
    return 'Reference refresh stopped: PostgreSQL writer lock lost. Retry later.';
  }
  const source = error as { code?: unknown; response?: { status?: unknown } } | null;
  const code =
    typeof source?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(source.code)
      ? source.code
      : 'failed';
  const status = Number(source?.response?.status);
  if (status === 401 || status === 403) {
    return `Reference refresh authorization failed (${status}).`;
  }
  return `Reference refresh ${code}. Check cache sync-references --status.`;
}
