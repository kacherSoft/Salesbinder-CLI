import type { Command } from 'commander';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CacheService, CacheSyncStatus, SyncRecordIssue } from '@salesbinder/sdk';
import { formatError, formatJson } from '../../output/json.formatter.js';
import {
  deriveCacheSyncHealth,
  projectCacheSyncProgress,
} from './cache-sync-progress-controller.js';
import { readChangeFeedStatus } from './change-feed-status-projector.js';
import {
  canonicalSyncRecordIssueMessage,
  requireCanonicalSyncRecordIssueId,
} from './full-resume-phase-results.js';

export function registerCacheStatusCommand(cache: Command, program: Command): void {
  cache
    .command('status')
    .description('Show cache backend, sync health, feed progress, authority and record counts')
    .action(async () => {
      let cacheService: CacheService | null = null;
      try {
        const sdk = await import('@salesbinder/sdk');
        const accountName = program.opts().account || 'default';
        const accountBinding = sdk.createSalesBinderAccountBinding(
          sdk.loadConfig(accountName).subdomain
        );
        const dbUrl = process.env.SALESBINDER_DB_URL;
        let backend: 'postgresql' | 'sqlite';
        let location: Record<string, unknown>;
        if (dbUrl) {
          backend = 'postgresql';
          const pgCache = await sdk.createPostgresCacheService();
          if (!pgCache)
            throw new Error('PostgreSQL backend is configured but could not be opened.');
          cacheService = pgCache;
          await pgCache.verifyAccountBinding(accountBinding);
          location = { connection: maskPostgresUrl(dbUrl) };
        } else {
          backend = 'sqlite';
          const cacheFile = sqliteCachePath(accountName);
          if (!existsSync(cacheFile)) {
            console.log(
              formatJson({
                backend,
                exists: false,
                account: accountName,
                cache_file: cacheFile,
                sync_health: 'not_initialized',
                sync_status: 'not_initialized',
                message: 'Cache does not exist. Run "cache sync" to create it.',
              })
            );
            return;
          }
          cacheService = await sdk.createCacheService(accountName);
          await cacheService.verifyAccountBinding(accountBinding);
          location = {
            exists: true,
            cache_file: cacheFile,
            size_mb: Number((statSync(cacheFile).size / (1024 * 1024)).toFixed(2)),
          };
        }

        const activeCache = cacheService;
        const prefs = sdk.loadPreferences();
        const thresholdEnv = process.env.SALESBINDER_CACHE_STALE_SECONDS?.trim();
        const configuredThreshold = thresholdEnv
          ? /^\d+$/.test(thresholdEnv)
            ? Number(thresholdEnv)
            : Number.NaN
          : (prefs?.cacheStaleSeconds ?? 3600);
        const staleThreshold =
          Number.isSafeInteger(configuredThreshold) && configuredThreshold >= 0
            ? configuredThreshold
            : 3600;
        const [state, syncStatus, paymentStatus, counts, categoryMeta, inventoryMeta] =
          await Promise.all([
            activeCache.getCacheState(),
            activeCache.getSyncStatus(),
            activeCache.getPaymentSyncStatus(),
            collectCacheCounts(activeCache),
            activeCache.getCategoryCacheMeta(),
            activeCache.getInventoryCacheMeta(),
          ]);
        const [authority, changeFeed, references, ocShipping] = await Promise.all([
          sdk.readPublicCacheSyncAuthority(activeCache, { staleThresholdSeconds: staleThreshold }),
          readChangeFeedStatus({
            backend,
            cache: activeCache,
            accountIdentity: accountBinding.accountIdentity,
          }),
          readReferenceStatus(activeCache, accountBinding.accountIdentity),
          readOCShippingStatus(activeCache),
        ]);
        const legacy = projectLegacyStatus(state, syncStatus, staleThreshold);
        const selected = authority.authority === 'official_v3' ? authority : legacy;
        const output = {
          backend,
          ...location,
          account: accountName,
          cache_authority: authority.authority,
          sync_health: selected.syncHealth,
          sync_status: selected.syncStatus,
          change_feed: changeFeed,
          ...(authority.authority === 'official_v3'
            ? {
                last_sync: isoTimestamp(authority.lastAppliedAt),
                latest_sync_attempt: isoTimestamp(authority.lastAttemptAt),
                coverage: authority.coverage,
                overall_health: deriveOverallHealth(selected.syncHealth, ocShipping, references),
                ...counts,
                ...(state ? { schema_version: state.schemaVersion } : {}),
                is_stale: authority.isStale,
                freshness: authority.freshness,
                stale_threshold_seconds: staleThreshold,
                payment_sync_status: paymentStatus ?? 'not_initialized',
                categories: categoryMeta ?? 'not_initialized',
                inventory: inventoryMeta ?? 'not_initialized',
                references,
                oc_shipping: ocShipping,
                legacy_status: {
                  sync_health: legacy.syncHealth,
                  sync_status: legacy.syncStatus,
                  ...legacy.output,
                },
              }
            : {
                ...legacy.output,
                ...(state
                  ? {
                      ...counts,
                      payment_sync_status: paymentStatus ?? 'not_initialized',
                      categories: categoryMeta ?? 'not_initialized',
                      inventory: inventoryMeta ?? 'not_initialized',
                    }
                  : {}),
              }),
        };
        console.log(formatJson(output));
      } catch (error) {
        console.error(formatError(error as Error));
        process.exitCode = 1;
      } finally {
        await cacheService?.close().catch(() => undefined);
      }
    });
}

function projectLegacyStatus(
  state: Awaited<ReturnType<CacheService['getCacheState']>>,
  syncStatus: CacheSyncStatus | null,
  staleThreshold: number
): {
  syncHealth: string;
  syncStatus: Record<string, unknown> | 'not_initialized';
  output: Record<string, unknown>;
} {
  const stale = !state || state.lastSync < Math.floor(Date.now() / 1000) - staleThreshold;
  return {
    syncHealth: deriveCacheSyncHealth(syncStatus),
    syncStatus: projectStatus(syncStatus),
    output: state
      ? {
          last_sync: new Date(state.lastSync * 1000).toISOString(),
          last_document_sync:
            state.lastDocumentSync === undefined
              ? null
              : new Date(state.lastDocumentSync * 1000).toISOString(),
          last_full_sync: new Date(state.lastFullSync * 1000).toISOString(),
          schema_version: state.schemaVersion,
          is_stale: stale,
          freshness: stale ? 'STALE' : 'FRESH',
          stale_threshold_seconds: staleThreshold,
        }
      : { message: 'Cache exists but no metadata found. May need full sync.' },
  };
}

function isoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString();
}

function deriveOverallHealth(
  syncHealth: string,
  ocShipping: unknown,
  references: unknown
): 'healthy' | 'warning' | 'failed' | 'unavailable' {
  if (syncHealth === 'failed') return 'failed';
  if (syncHealth === 'unavailable') return 'unavailable';
  if (
    syncHealth !== 'healthy' ||
    hasOCShippingWarning(ocShipping) ||
    hasReferenceRefreshWarning(references)
  )
    return 'warning';
  return 'healthy';
}

function hasOCShippingWarning(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as {
    pending_warning_count?: unknown;
    reconciliation?: { status?: unknown; failed?: unknown };
  };
  return (
    result.pending_warning_count !== 0 ||
    result.reconciliation?.status === 'failed' ||
    result.reconciliation?.status === 'success_with_warnings' ||
    (typeof result.reconciliation?.failed === 'number' && result.reconciliation.failed > 0)
  );
}

function hasReferenceRefreshWarning(value: unknown): boolean {
  if (value === 'not_available') return true;
  if (!value || typeof value !== 'object') return false;
  const status = value as {
    run?: { status?: unknown };
    resources?: Record<string, { outcome?: unknown }>;
  };
  if (status.run?.status === 'failed' || status.run?.status === 'success_with_warnings') return true;
  return Object.values(status.resources ?? {}).some((resource) => resource.outcome === 'failed');
}

async function readReferenceStatus(cache: CacheService, accountIdentity: string): Promise<unknown> {
  const candidate = cache as CacheService & {
    getReferenceRefreshStore?: () => { getStatus(identity: string): Promise<unknown> };
  };
  return typeof candidate.getReferenceRefreshStore === 'function'
    ? (await candidate.getReferenceRefreshStore().getStatus(accountIdentity)) ?? 'not_initialized'
    : 'not_available';
}

async function readOCShippingStatus(cache: CacheService): Promise<unknown> {
  const candidate = cache as CacheService & {
    getOCShippingReconciliationStatus?: () => Promise<unknown>;
    getOCShippingPendingWarnings?: () => Promise<readonly unknown[]>;
  };
  if (
    typeof candidate.getOCShippingReconciliationStatus !== 'function' ||
    typeof candidate.getOCShippingPendingWarnings !== 'function'
  )
    return 'not_available';
  const [reconciliation, warnings] = await Promise.all([
    candidate.getOCShippingReconciliationStatus(),
    candidate.getOCShippingPendingWarnings(),
  ]);
  return {
    reconciliation: reconciliation ?? 'not_initialized',
    pending_warning_count: warnings.length,
  };
}

function projectStatus(
  status: CacheSyncStatus | null
): Record<string, unknown> | 'not_initialized' {
  if (!status || !['running', 'success', 'success_with_warnings', 'failed'].includes(status.status))
    return 'not_initialized';
  const projected: Record<string, unknown> = {
    status: status.status,
    message:
      status.status === 'running'
        ? 'Sync running'
        : status.status === 'failed'
          ? 'Sync failed'
          : status.status === 'success_with_warnings'
            ? 'Sync completed with warnings'
            : 'Sync completed',
  };
  if (typeof status.runId === 'string') projected.runId = status.runId;
  if (typeof status.accountName === 'string') projected.accountName = status.accountName;
  if (status.syncTarget === 'sqlite' || status.syncTarget === 'postgresql')
    projected.syncTarget = status.syncTarget;
  for (const key of ['startedAt', 'updatedAt', 'finishedAt', 'progressUpdatedAt'] as const) {
    if (isCount(status[key])) projected[key] = status[key];
  }
  if (status.syncType === 'full' || status.syncType === 'delta')
    projected.syncType = status.syncType;
  for (const key of [
    'documentsProcessed',
    'lineItemsProcessed',
    'itemsProcessed',
    'categoriesProcessed',
    'stockRowsProcessed',
    'deletedRecordsProcessed',
  ] as const) {
    if (isCount(status[key])) projected[key] = status[key];
  }
  const progress = projectCacheSyncProgress(status.progress);
  if (progress) {
    projected.phase = progress.phase;
    projected.progress = progress;
  }
  const recordIssues = projectRecordIssues(status.recordIssues);
  if (recordIssues.length > 0) projected.recordIssues = recordIssues;
  if (status.status === 'failed') projected.error = 'Cache sync failed.';
  return projected;
}

function projectRecordIssues(value: unknown): SyncRecordIssue[] {
  if (!Array.isArray(value)) return [];
  const projected: SyncRecordIssue[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const issue = candidate as Record<string, unknown>;
    if (
      (issue.resource !== 'item' && issue.resource !== 'document') ||
      issue.attempts !== 2 ||
      (issue.outcome !== 'preserved_last_known_good' && issue.outcome !== 'omitted_new')
    )
      continue;
    let id: string;
    try {
      id = requireCanonicalSyncRecordIssueId(issue.id);
    } catch {
      continue;
    }
    const code = issue.code;
    if (
      code !== 'not_found' &&
      code !== 'invalid_record' &&
      code !== 'invalid_variations' &&
      code !== 'content_changed'
    )
      continue;
    if (issue.resource === 'document') {
      if (code === 'invalid_variations' || code === 'content_changed') continue;
      const context = issue.context_id;
      if (context !== undefined && (typeof context !== 'number' || ![4, 5, 11].includes(context)))
        continue;
      projected.push({
        resource: 'document',
        id,
        code,
        message: canonicalSyncRecordIssueMessage('document', code),
        attempts: 2,
        outcome: issue.outcome,
        ...(context === undefined ? {} : { context_id: context }),
      });
    } else {
      projected.push({
        resource: 'item',
        id,
        code,
        message: canonicalSyncRecordIssueMessage('item', code),
        attempts: 2,
        outcome: issue.outcome,
      });
    }
  }
  return projected.sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      (left.context_id ?? -1) - (right.context_id ?? -1) ||
      left.id.localeCompare(right.id)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function collectCacheCounts(cache: CacheService) {
  const values = await Promise.all([
    cache.getDocumentCount(),
    cache.getDocumentCountByContext(5),
    cache.getDocumentCountByContext(11),
    cache.getDocumentCountByContext(4),
    cache.getItemDocumentCount(),
    cache.getPaymentTransactionCount(),
    cache.getAccountCount(),
    cache.getAccountCount(2),
    cache.getAccountCount(10),
    cache.getItemCount(),
    cache.getCategoryCount(),
    cache.getStockLocationCount(),
  ]);
  const keys = [
    'document_count',
    'invoice_document_count',
    'purchase_order_document_count',
    'estimate_document_count',
    'line_item_count',
    'payment_transaction_count',
    'account_count',
    'customer_count',
    'supplier_count',
    'item_count',
    'category_count',
    'stock_location_count',
  ];
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}

function sqliteCachePath(accountName: string): string {
  return join(
    homedir(),
    '.salesbinder',
    'cache',
    `salesbinder-${accountName.replace(/[^a-zA-Z0-9_-]/g, '_')}.db`
  );
}

function maskPostgresUrl(value: string): string {
  try {
    const url = new URL(value);
    url.password = '***';
    return url.toString();
  } catch {
    return 'configured';
  }
}
