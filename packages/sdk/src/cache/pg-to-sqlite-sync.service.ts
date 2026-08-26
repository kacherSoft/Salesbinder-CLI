/**
 * PG → SQLite sync service
 *
 * Pulls data from a shared PostgreSQL cache into the local SQLite mirror.
 * SQLite is the optional local mirror for offline reads.
 * PostgreSQL is the shared source of truth (populated by `cache sync`).
 */

import type { AccountRow, DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';
import type { PaymentTransactionRow } from './payment-sync.types.js';
import { PostgresCacheService } from './postgres-cache.service.js';
import { SQLiteCacheService } from './sqlite-cache.service.js';

/** Result of a PG → SQLite pull */
export interface PgPullResult {
  success: boolean;
  accountsPulled: number;
  documentsPulled: number;
  itemDocumentsPulled: number;
  paymentTransactionsPulled: number;
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
  let pgLockAcquired = false;
  let sqliteLockAcquired = false;
  const lockKey = `salesbinder-cache-sync:${sqliteAccountName}`;

  try {
    // Open both connections
    pg = new PostgresCacheService(pgConnectionString);
    await pg.ensureSchema();
    pgLockAcquired = await pg.tryAcquireSyncLock(lockKey);
    if (!pgLockAcquired) throw new Error('Another cache sync is already running for this account.');
    sqlite = new SQLiteCacheService(sqliteAccountName, sqliteCustomPath);
    sqliteLockAcquired = await sqlite.tryAcquireSyncLock(lockKey);
    if (!sqliteLockAcquired) throw new Error('Another local cache writer is already running for this account.');

    // 1. Pull all documents from PG
    const allDocs = await getAllDocuments(pg);
    const allItems = await getAllItemDocuments(pg, allDocs);
    const allPayments = await getAllPaymentTransactions(pg);
    const allAccounts = await getAllAccounts(pg);
    const allMasterItems = await getAllItems(pg);
    const allStockRows = await getAllStockRows(pg);
    const pgState = await pg.getCacheState();
    const pgPaymentSyncStatus = await pg.getPaymentSyncStatus();

    // Replace data and metadata together so readers see either the old or new mirror.
    await sqlite.replaceMirror({
      accounts: allAccounts,
      items: allMasterItems,
      itemStockLocations: allStockRows,
      documents: allDocs,
      itemDocuments: allItems,
      paymentTransactions: allPayments,
      cacheState: pgState,
      paymentSyncStatus: pgPaymentSyncStatus,
      pulledAt: Date.now(),
    });

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    return {
      success: true,
      accountsPulled: allAccounts.length,
      documentsPulled: allDocs.length,
      itemDocumentsPulled: allItems.length,
      paymentTransactionsPulled: allPayments.length,
      itemsPulled: allMasterItems.length,
      stockRowsPulled: allStockRows.length,
      duration: `${duration}s`,
    };
  } finally {
    try { if (sqlite && sqliteLockAcquired) await sqlite.releaseSyncLock(lockKey); } catch { /* ignore */ }
    try { if (pg && pgLockAcquired) await pg.releaseSyncLock(lockKey); } catch { /* ignore */ }
    try { if (pg) await pg.close(); } catch { /* ignore */ }
    try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }
  }
}

// ============ Internal helpers ============

/** Fetch all documents from PG (batched to avoid memory issues) */
async function getAllDocuments(pg: PostgresCacheService): Promise<DocumentRow[]> {
  // Use getDocumentsModifiedSince(0) to get everything
  return pg.getDocumentsModifiedSince(0);
}

async function getAllAccounts(pg: PostgresCacheService): Promise<AccountRow[]> {
  return pg.getAllAccounts();
}

async function getAllItems(pg: PostgresCacheService): Promise<ItemRow[]> {
  return pg.getAllItems();
}

async function getAllStockRows(pg: PostgresCacheService): Promise<ItemStockLocationRow[]> {
  return pg.getAllItemStockLocations();
}

async function getAllPaymentTransactions(pg: PostgresCacheService): Promise<PaymentTransactionRow[]> {
  return pg.getAllPaymentTransactions();
}

/** Fetch all item_documents from PG */
async function getAllItemDocuments(
  pg: PostgresCacheService,
  docs: DocumentRow[],
): Promise<Omit<ItemDocumentRow, 'id'>[]> {
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
          document_item_id: item.document_item_id,
          item_id: item.item_id,
          doc_id: item.doc_id,
          quantity: item.quantity,
          price: item.price,
          item_name: item.item_name,
          item_number: item.item_number,
          item_sku: item.item_sku,
          item_location: item.item_location,
          line_description: item.line_description,
          quantity_received: item.quantity_received,
          cost: item.cost,
          total_amount: item.total_amount,
          discounted_price: item.discounted_price,
          discount_percent: item.discount_percent,
        });
      }
    }
  }

  return allItems;
}
