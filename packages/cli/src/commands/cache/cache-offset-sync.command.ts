import type { Command } from 'commander';
import type { DocumentOffsetTask, PostgresCacheService } from '@salesbinder/sdk';
import { formatJson } from '../../output/json.formatter.js';
import { awaitWhileSyncLockHeld, createSyncLockLossGuard } from './postgres-sync-lock-loss.guard.js';

class OffsetCommandError extends Error {}

export function registerCacheOffsetSyncCommand(cache: Command, program: Command): void {
  cache.command('sync-offset')
    .description('Refresh changed documents via V2 modifiedSince and related inventory via V3; PostgreSQL only')
    .option('--days <days>', 'Rolling days from this run start (1-365); not overlap before last sync', '30')
    .option('--resume', 'Resume the stored run with its original cutoff and unfinished tasks')
    .option('--status', 'Read the dedicated offset run status without contacting SalesBinder')
    .action(async (options: { days: string; resume?: boolean; status?: boolean }) => {
      let service: PostgresCacheService | null = null;
      let lockKey: string | null = null;
      let locked = false;
      const lockLoss = createSyncLockLossGuard();
      try {
        const {
          PostgresCacheService: PgCache,
          loadConfig,
          createSalesBinderAccountBinding,
          createDocumentOffsetSyncService,
        } = await import('@salesbinder/sdk');
        const days = parseOffsetDays(options.days);
        const url = process.env.SALESBINDER_DB_URL;
        if (!url) throw new OffsetCommandError('SALESBINDER_DB_URL is required; offset sync is PostgreSQL-only.');
        const config = loadConfig(program.opts().account || 'default');
        const account = {
          ...config,
          v3ApiKey: process.env.SALESBINDER_V3_API_KEY ?? config.v3ApiKey,
        };
        if (!options.status && !account.v3ApiKey?.trim()) {
          throw new OffsetCommandError('A V3 key is required for document and inventory detail reads.');
        }
        const binding = createSalesBinderAccountBinding(account.subdomain);
        service = new PgCache(url);
        // Offset refresh requires an existing correctly bound cache, not an implicit new baseline.
        await service.verifyAccountBinding(binding);
        const activeCache = service;
        if (options.status) {
          const run = await activeCache.getOffsetSyncRun();
          const documents = run ? await activeCache.listOffsetSyncTasks(run.runId, 'document') : [];
          const items = run ? await activeCache.listOffsetSyncTasks(run.runId, 'item') : [];
          console.log(formatJson({ run, documents: summarizeTasks(documents), items: summarizeTasks(items),
            coverage: 'document-driven partial refresh; not a full inventory snapshot' }));
          return;
        }
        lockKey = `salesbinder-cache-sync:${binding.accountIdentity}`;
        const activeLockKey = lockKey;
        locked = await awaitWhileSyncLockHeld(lockLoss, () =>
          activeCache.tryAcquireSyncLock(activeLockKey, { onLost: lockLoss.onLost }));
        if (!locked) throw new OffsetCommandError('Another cache writer is running for this account.');
        // Migrate an existing bound cache only after acquiring its writer lock.
        // The --status branch above remains read-only.
        await awaitWhileSyncLockHeld(lockLoss, () => activeCache.ensureSchema());
        lockLoss.assertHeld();
        const sync = createDocumentOffsetSyncService(account, activeCache, {
          signal: lockLoss.signal,
          rateLimitObserver: (event) => {
            if (event.type === 'wait' || event.type === 'cooldown') {
              console.error(`[offset] ${event.apiVersion}: waiting for API rate limit`);
            }
          },
        }, lockLoss.assertHeld);
        console.error('[offset] V2 document selection → V3 documents and exact related items; no full inventory scan');
        const result = await awaitWhileSyncLockHeld(lockLoss, () => sync.sync({
          accountIdentity: binding.accountIdentity,
          ...(options.resume ? {} : { days }),
          resume: options.resume,
          onProgress: (progress) => console.error(
            `[offset] ${progress.phase}: ${progress.event} ${progress.completed}/${progress.total}; failed=${progress.failed}`
          ),
        }));
        lockLoss.assertHeld();
        console.log(formatJson(result));
      } catch (error) {
        const message = error instanceof OffsetCommandError ? error.message : safeOffsetError(error, lockLoss.isLost());
        console.error(formatJson({ error: true, message }));
        process.exitCode = 1;
      } finally {
        try { if (service && lockKey && locked) await service.releaseSyncLock(lockKey); } catch { /* Close releases the session. */ }
        try { await service?.close(); } catch { /* Do not emit a second terminal error. */ }
      }
    });
}

export function parseOffsetDays(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 365) {
    throw new OffsetCommandError('--days must be an integer from 1 to 365.');
  }
  return Number(value);
}

function summarizeTasks(tasks: DocumentOffsetTask[]) {
  return {
    discovered: tasks.length,
    applied: tasks.filter((task) => task.status === 'done').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    failures: tasks.filter((task) => task.status === 'failed').map((task) => ({ id: task.id, code: task.errorCode })),
  };
}

function safeOffsetError(error: unknown, lostLock: boolean): string {
  if (lostLock) return 'Offset sync stopped: PostgreSQL writer lock lost. Saved work can be resumed.';
  const source = error as { code?: unknown; response?: { status?: unknown }; message?: unknown } | null;
  const code = typeof source?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(source.code) ? source.code : 'failed';
  const status = Number(source?.response?.status);
  if (status === 401 || status === 403) return `Offset sync stopped: API authorization failed (${status}).`;
  return `Offset sync ${code}. Check cache sync-offset --status; use --resume after resolving the failure.`;
}
