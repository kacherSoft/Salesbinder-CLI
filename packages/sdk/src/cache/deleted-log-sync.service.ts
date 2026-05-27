import type { SalesBinderClient } from '../resources/index.js';
import { ContextId, DocumentContextId } from '../types/common.types.js';
import type { DeletedLogEntry, DeletedLogListResponse } from '../types/deleted-log.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState } from './types.js';

export interface DeletedLogSyncResult {
  deletedRecordsProcessed: number;
}

const ITEM_CONTEXT_ID = 6;

export class DeletedLogSyncService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {}

  async sync(): Promise<DeletedLogSyncResult> {
    const state = await this.cache.getCacheState();
    const since = Math.max(0, (state?.lastDeletedSync ?? state?.lastSync ?? 0) - this.syncLookbackSeconds);
    const contexts = [
      ContextId.Customer,
      ContextId.Supplier,
      ITEM_CONTEXT_ID,
      DocumentContextId.Estimate,
      DocumentContextId.Invoice,
      DocumentContextId.PurchaseOrder,
    ];
    let processed = 0;

    for (const contextId of contexts) {
      processed += await this.syncContext(contextId, since);
    }

    await this.cache.setCacheState(this.mergeState(state, Math.floor(Date.now() / 1000)));
    return { deletedRecordsProcessed: processed };
  }

  private async syncContext(contextId: number, deletedSince: number): Promise<number> {
    let page = 1;
    let processed = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.deletedLog.list({
        contextId,
        deletedSince,
        page,
        pageLimit: 200,
      });
      const entries = this.flattenEntries(response);
      if (entries.length === 0) break;

      for (const entry of entries) {
        await this.deleteCachedRecord(entry);
        processed++;
      }

      hasMore = page < Number(response.pages ?? page);
      page++;
    }

    return processed;
  }

  private async deleteCachedRecord(entry: DeletedLogEntry): Promise<void> {
    if (entry.context_id === ContextId.Customer || entry.context_id === ContextId.Supplier) {
      await this.cache.deleteAccount(entry.record_id);
      return;
    }

    if (entry.context_id === ITEM_CONTEXT_ID) {
      await this.cache.deleteItem(entry.record_id);
      return;
    }

    const document = await this.cache.getDocumentByApiId(entry.record_id);
    await this.cache.deleteDocument(document?.doc_id ?? entry.record_id);
  }

  private flattenEntries(response: DeletedLogListResponse): DeletedLogEntry[] {
    const entries = response.deletedlog ?? response.deleted_log ?? [];
    return Array.isArray(entries[0]) ? entries.flat() : entries as unknown as DeletedLogEntry[];
  }

  private mergeState(state: CacheState | null, now: number): CacheState {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: 2,
      lastDeletedSync: now,
    };
  }
}
