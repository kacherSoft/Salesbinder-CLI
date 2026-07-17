/**
 * PG → SQLite sync service
 *
 * Pulls data from a shared PostgreSQL cache into the local SQLite mirror.
 * SQLite is the optional local mirror for offline reads.
 * PostgreSQL is the shared source of truth (populated by `cache sync`).
 */

import { PostgresCacheService } from './postgres-cache.service.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';

/** Result of a PG → SQLite pull */
export interface PgPullResult {
  success: boolean;
  accountsPulled: number;
  documentsPulled: number;
  itemDocumentsPulled: number;
  documentNonItemLinesPulled: number;
  itemsPulled: number;
  stockRowsPulled: number;
  duration: string;
  skipped?: boolean;
  skipReason?: string;
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
    sqlite = new SQLiteCacheService(sqliteAccountName, sqliteCustomPath, true);

    // Read one repeatable-read PostgreSQL image, then atomically replace SQLite.
    const snapshot = await pg.readMirrorSnapshot();
    sqlite.replaceMirrorSnapshot(snapshot);
    // Store the pull timestamp in cache_meta so we can check next time
    sqlite.setRawMeta('pg_pull_timestamp', String(Date.now()));

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    return {
      success: true,
      accountsPulled: snapshot.accounts.length,
      documentsPulled: snapshot.documents.length,
      itemDocumentsPulled: snapshot.itemDocuments.length,
      documentNonItemLinesPulled: snapshot.documentNonItemLines.length,
      itemsPulled: snapshot.items.length,
      stockRowsPulled: snapshot.stockLocations.length,
      duration: `${duration}s`,
    };
  } finally {
    try { if (pg) await pg.close(); } catch { /* ignore */ }
    try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }
  }
}
