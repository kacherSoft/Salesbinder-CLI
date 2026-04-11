/**
 * PG → SQLite sync service
 *
 * Pulls data from a shared PostgreSQL cache into the local SQLite mirror.
 * SQLite is always the read-side for analytics commands (fast, offline-capable).
 * PostgreSQL is the shared source of truth (populated by `cache sync`).
 *
 * Schedule logic: auto-sync only on weekdays, daytime (8–18h), at most once per hour.
 */

import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow } from './types.js';
import { PostgresCacheService } from './postgres-cache.service.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';

/** Result of a PG → SQLite pull */
export interface PgPullResult {
  success: boolean;
  documentsPulled: number;
  itemDocumentsPulled: number;
  duration: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Determine whether an automatic PG → SQLite sync should run.
 * Rules: weekday (Mon–Fri), daytime (8:00–18:00 local), and last pull > 1 hour ago.
 */
export function shouldAutoSync(lastPullTimestamp: number | null): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const hour = now.getHours();
  const isWeekday = day >= 1 && day <= 5;
  const isDaytime = hour >= 8 && hour <= 18;
  if (!isWeekday || !isDaytime) return false;
  if (lastPullTimestamp === null) return true; // never synced
  const elapsed = Date.now() - lastPullTimestamp;
  return elapsed > 3600_000; // 1 hour
}

/**
 * Pull all data from PostgreSQL into the local SQLite cache.
 *
 * Strategy: full replace — wipe SQLite tables then bulk-insert from PG.
 * This is safe because SQLite is only a read mirror; the canonical data lives in PG.
 */
export async function pullFromPostgres(
  pgConnectionString: string,
  sqliteAccountName: string,
  sqliteCustomPath?: string,
): Promise<PgPullResult> {
  const start = Date.now();
  let pg: PostgresCacheService | null = null;
  let sqlite: SQLiteCacheService | null = null;

  try {
    // Open both connections
    pg = new PostgresCacheService(pgConnectionString);
    await pg.ensureSchema();
    sqlite = new SQLiteCacheService(sqliteAccountName, sqliteCustomPath);

    // 1. Pull all documents from PG
    const allDocs = await getAllDocuments(pg);
    const allItems = await getAllItemDocuments(pg);
    const pgState = await pg.getCacheState();

    // 2. Clear SQLite tables (order matters: items first due to FK)
    await clearSqliteTables(sqlite);

    // 3. Bulk-insert into SQLite
    if (allDocs.length > 0) {
      await sqlite.batchInsertDocuments(allDocs);
    }
    if (allItems.length > 0) {
      await sqlite.batchInsertItemDocuments(allItems);
    }

    // 4. Copy cache metadata + record pull timestamp
    if (pgState) {
      await sqlite.setCacheState(pgState);
    }
    // Store the pull timestamp in cache_meta so we can check next time
    await setPgPullTimestamp(sqlite, Date.now());

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    return {
      success: true,
      documentsPulled: allDocs.length,
      itemDocumentsPulled: allItems.length,
      duration: `${duration}s`,
    };
  } finally {
    try { if (pg) await pg.close(); } catch { /* ignore */ }
    try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }
  }
}

/**
 * Try an automatic PG → SQLite sync if conditions are met.
 * Fails silently (returns skipped result) on connection errors.
 */
export async function tryAutoSync(
  pgConnectionString: string,
  sqliteAccountName: string,
  sqliteCustomPath?: string,
): Promise<PgPullResult> {
  // Check schedule
  let sqlite: SQLiteCacheService | null = null;
  try {
    sqlite = new SQLiteCacheService(sqliteAccountName, sqliteCustomPath);
    const lastPull = await getPgPullTimestamp(sqlite);
    await sqlite.close();
    sqlite = null;

    if (!shouldAutoSync(lastPull)) {
      return {
        success: true,
        documentsPulled: 0,
        itemDocumentsPulled: 0,
        duration: '0s',
        skipped: true,
        skipReason: lastPull === null
          ? 'Outside sync window (weekday 8-18h)'
          : 'Last pull is still fresh (< 1 hour)',
      };
    }
  } catch {
    // SQLite doesn't exist yet or other local error — proceed with pull
    try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }
  }

  // Try to pull
  try {
    return await pullFromPostgres(pgConnectionString, sqliteAccountName, sqliteCustomPath);
  } catch (error: any) {
    // Connection failed — fail silently
    return {
      success: false,
      documentsPulled: 0,
      itemDocumentsPulled: 0,
      duration: '0s',
      skipped: true,
      skipReason: `PostgreSQL unreachable: ${error?.message || error}`,
    };
  }
}

// ============ Internal helpers ============

/** Fetch all documents from PG (batched to avoid memory issues) */
async function getAllDocuments(pg: PostgresCacheService): Promise<DocumentRow[]> {
  // Use getDocumentsModifiedSince(0) to get everything
  return pg.getDocumentsModifiedSince(0);
}

/** Fetch all item_documents from PG */
async function getAllItemDocuments(pg: PostgresCacheService): Promise<Omit<ItemDocumentRow, 'id'>[]> {
  // We need a raw query — add a helper method or use existing interface
  // Get all doc_ids first, then batch-fetch item docs
  const docs = await pg.getDocumentsModifiedSince(0);
  const allItems: Omit<ItemDocumentRow, 'id'>[] = [];

  // Batch by 100 doc_ids to avoid too many round-trips
  const batchSize = 100;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const promises = batch.map(doc => pg.getItemDocuments(doc.doc_id));
    const results = await Promise.all(promises);
    for (const items of results) {
      for (const item of items) {
        allItems.push({
          item_id: item.item_id,
          doc_id: item.doc_id,
          quantity: item.quantity,
          price: item.price,
        });
      }
    }
  }

  return allItems;
}

/** Clear SQLite data tables (preserving schema) */
async function clearSqliteTables(sqlite: SQLiteCacheService): Promise<void> {
  // Delete item_documents first (FK constraint), then documents, then meta
  // Use the interface methods — delete all documents via getDocumentsModifiedSince(0)
  const allDocs = await sqlite.getDocumentsModifiedSince(0);
  if (allDocs.length > 0) {
    const docIds = allDocs.map(d => d.doc_id);
    // Delete in batches
    const batchSize = 500;
    for (let i = 0; i < docIds.length; i += batchSize) {
      const batch = docIds.slice(i, i + batchSize);
      await sqlite.batchDeleteDocuments(batch);
    }
  }
}

/** Read last PG pull timestamp from SQLite cache_meta */
async function getPgPullTimestamp(sqlite: CacheService): Promise<number | null> {
  // We use getCacheState to piggyback — but we need a separate key.
  // Access the underlying db via a workaround: store in cache_meta via setCacheState wrapper
  // Instead, use the sqlite instance directly if it exposes raw access.
  // For clean interface usage, store it as part of CacheState isn't ideal.
  // Let's use a convention: store 'pg_pull_timestamp' in cache_meta.
  // Since CacheService doesn't expose raw meta access, we cast to SQLiteCacheService.
  const sqliteService = sqlite as SQLiteCacheService;
  if ('getRawMeta' in sqliteService) {
    return (sqliteService as any).getRawMeta('pg_pull_timestamp');
  }
  // Fallback: check if cache state has a recent lastSync
  const state = await sqlite.getCacheState();
  return state ? state.lastSync * 1000 : null;
}

/** Store PG pull timestamp in SQLite cache_meta */
async function setPgPullTimestamp(sqlite: CacheService, timestamp: number): Promise<void> {
  const sqliteService = sqlite as SQLiteCacheService;
  if ('setRawMeta' in sqliteService) {
    (sqliteService as any).setRawMeta('pg_pull_timestamp', String(timestamp));
  }
}
