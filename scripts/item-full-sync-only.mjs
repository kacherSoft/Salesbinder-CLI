#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const cliDir = process.cwd();
const envPath = join(cliDir, '.env');
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const {
  SalesBinderClient,
  ItemIndexerService,
  createPostgresCacheService,
  loadPreferences,
} = await import('@salesbinder/sdk');

const accountName = process.env.SALESBINDER_ACCOUNT || 'default';
const checkpointPath = join(homedir(), '.salesbinder', 'cache', `item-full-sync-only-${accountName}.json`);
const log = (...args) => console.error(new Date().toISOString(), ...args);

function ensureDir(file) { mkdirSync(dirname(file), { recursive: true }); }
function loadCheckpoint() {
  if (process.env.RESET_ITEM_FULL_CHECKPOINT === '1' && existsSync(checkpointPath)) rmSync(checkpointPath, { force: true });
  if (!existsSync(checkpointPath)) return { page: 1, itemIndex: 0, startedAt: Math.floor(Date.now() / 1000), itemsProcessed: 0 };
  return JSON.parse(readFileSync(checkpointPath, 'utf8'));
}
function saveCheckpoint(cp) {
  ensureDir(checkpointPath);
  cp.updatedAt = Math.floor(Date.now() / 1000);
  writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
}

const prefs = loadPreferences();
const syncLookbackSeconds = 0;
const client = new SalesBinderClient(accountName);
const cacheService = await createPostgresCacheService();
if (!cacheService) throw new Error('SALESBINDER_DB_URL is required; refusing to write item full sync anywhere except PostgreSQL');

const lockKey = `salesbinder-cache-sync:${accountName}`;
const acquired = await cacheService.tryAcquireSyncLock(lockKey);
if (!acquired) throw new Error('Another SalesBinder cache sync is already running; item-only full sync not started.');

const startedMs = Date.now();
const runId = `${accountName}-item-full-${startedMs}`;
let checkpoint = loadCheckpoint();
let lastStatusAt = 0;
let lastCheckpointLogAt = 0;

try {
  log(`Starting item-only full sync account=${accountName} checkpoint=${checkpointPath}`);
  await cacheService.setSyncStatus({
    status: 'running',
    runId,
    accountName,
    syncTarget: 'postgresql',
    startedAt: Math.floor(startedMs / 1000),
    updatedAt: Math.floor(startedMs / 1000),
    message: 'Item-only full sync running',
    syncType: 'item-full-only',
    documentsProcessed: 0,
    lineItemsProcessed: 0,
    itemsProcessed: checkpoint.itemsProcessed ?? 0,
    stockRowsProcessed: checkpoint.stockRowsProcessed ?? 0,
    deletedRecordsProcessed: 0,
    itemCheckpoint: { page: checkpoint.page, itemIndex: checkpoint.itemIndex },
  });

  const itemIndexer = new ItemIndexerService(client, cacheService, accountName, syncLookbackSeconds);
  const result = await itemIndexer.sync({
    full: true,
    resume: {
      page: checkpoint.page,
      itemIndex: checkpoint.itemIndex,
      onItemCheckpoint: async (position) => {
        checkpoint = {
          ...checkpoint,
          page: position.page,
          itemIndex: position.itemIndex,
        };
        saveCheckpoint(checkpoint);
        const now = Date.now();
        if (now - lastCheckpointLogAt > 60_000) {
          log(`checkpoint page=${position.page} itemIndex=${position.itemIndex}`);
          lastCheckpointLogAt = now;
        }
        if (now - lastStatusAt > 300_000) {
          await cacheService.setSyncStatus({
            status: 'running',
            runId,
            accountName,
            syncTarget: 'postgresql',
            startedAt: Math.floor(startedMs / 1000),
            updatedAt: Math.floor(now / 1000),
            message: `Item-only full sync running at page ${position.page}, item ${position.itemIndex}`,
            syncType: 'item-full-only',
            documentsProcessed: 0,
            lineItemsProcessed: 0,
            itemsProcessed: checkpoint.itemsProcessed ?? 0,
            stockRowsProcessed: checkpoint.stockRowsProcessed ?? 0,
            deletedRecordsProcessed: 0,
            itemCheckpoint: position,
          });
          lastStatusAt = now;
        }
      },
    },
  });

  const finishedAt = Math.floor(Date.now() / 1000);
  const state = await cacheService.getCacheState();
  await cacheService.setCacheState({
    ...(state ?? {}),
    accountName,
    schemaVersion: 2,
    documentCount: state?.documentCount ?? await cacheService.getDocumentCount(),
    itemDocumentCount: state?.itemDocumentCount ?? await cacheService.getItemDocumentCount(),
    itemCount: await cacheService.getItemCount(),
    stockLocationCount: await cacheService.getStockLocationCount(),
    lastItemSync: finishedAt,
    lastSync: state?.lastSync ?? finishedAt,
    lastFullSync: state?.lastFullSync ?? finishedAt,
  });
  await cacheService.setSyncStatus({
    status: 'success',
    runId,
    accountName,
    syncTarget: 'postgresql',
    startedAt: Math.floor(startedMs / 1000),
    updatedAt: finishedAt,
    finishedAt,
    message: 'Item-only full sync completed',
    syncType: 'item-full-only',
    documentsProcessed: 0,
    lineItemsProcessed: 0,
    itemsProcessed: result.itemsProcessed,
    stockRowsProcessed: result.stockRowsProcessed,
    deletedRecordsProcessed: 0,
  });
  if (existsSync(checkpointPath)) rmSync(checkpointPath, { force: true });
  log(`DONE item-only full sync: ${result.itemsProcessed} items, ${result.stockRowsProcessed} stock rows`);
} catch (error) {
  const failedAt = Math.floor(Date.now() / 1000);
  await cacheService.setSyncStatus({
    status: 'failed',
    runId,
    accountName,
    syncTarget: 'postgresql',
    startedAt: Math.floor(startedMs / 1000),
    updatedAt: failedAt,
    finishedAt: failedAt,
    message: `Item-only full sync failed: ${error?.message ?? String(error)}`,
    syncType: 'item-full-only',
    documentsProcessed: 0,
    lineItemsProcessed: 0,
    itemsProcessed: checkpoint.itemsProcessed ?? 0,
    stockRowsProcessed: checkpoint.stockRowsProcessed ?? 0,
    deletedRecordsProcessed: 0,
    itemCheckpoint: { page: checkpoint.page, itemIndex: checkpoint.itemIndex },
  });
  saveCheckpoint({ ...checkpoint, lastError: error?.stack ?? error?.message ?? String(error) });
  log('FAILED', error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  await cacheService.releaseSyncLock(lockKey);
  await cacheService.close?.();
}
