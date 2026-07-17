import type { SalesBinderClient } from '../resources/index.js';
import { ContextId, DocumentContextId } from '../types/common.types.js';
import type { DeletedLogEntry, DeletedLogListResponse } from '../types/deleted-log.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState } from './types.js';
import {
  assertCacheMutationCompatible,
  CACHE_PENDING_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
} from './types.js';

export interface DeletedLogSyncResult {
  deletedRecordsProcessed: number;
}

const ITEM_CONTEXT_ID = 6;
const DOCUMENT_CONTEXT_COUNT = 3;

export class DeletedLogSyncService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {}

  async sync(full = false): Promise<DeletedLogSyncResult> {
    const syncStartedAt = Math.floor(Date.now() / 1000);
    const state = await this.cache.getCacheState();
    await assertCacheMutationCompatible(this.cache, state, this.accountName);
    const lastDeletedSync = state?.lastDeletedSync;
    const needsFullHistory = full
      || !state
      || state.accountName !== this.accountName
      || state.schemaVersion !== CACHE_SCHEMA_VERSION
      || lastDeletedSync == null;
    const since = needsFullHistory || lastDeletedSync == null
      ? 0
      : Math.max(0, lastDeletedSync - this.syncLookbackSeconds);
    const contexts = [
      ContextId.Customer,
      ContextId.Supplier,
      ITEM_CONTEXT_ID,
      DocumentContextId.Estimate,
      DocumentContextId.Invoice,
      DocumentContextId.PurchaseOrder,
    ];
    let processed = 0;
    const deletedDocumentIds = new Set<string>();
    const retryDocumentIdentities = state?.documentSyncCheckpoint?.accountName === this.accountName
      ? state.documentSyncCheckpoint.retryDocumentIdentities ?? {}
      : {};

    for (const contextId of contexts) {
      processed += await this.syncContext(
        contextId,
        since,
        deletedDocumentIds,
        retryDocumentIdentities
      );
    }

    await this.cache.setCacheState(this.mergeState(state, syncStartedAt, deletedDocumentIds));
    return { deletedRecordsProcessed: processed };
  }

  private async syncContext(
    contextId: number,
    deletedSince: number,
    deletedDocumentIds: Set<string>,
    retryDocumentIdentities: Record<string, { contextId: number; documentNumber: number }>
  ): Promise<number> {
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
        if (await this.deleteCachedRecord(entry, retryDocumentIdentities)) {
          deletedDocumentIds.add(entry.record_id);
        }
        processed++;
      }

      hasMore = page < Number(response.pages ?? page);
      page++;
    }

    return processed;
  }

  private async deleteCachedRecord(
    entry: DeletedLogEntry,
    retryDocumentIdentities: Record<string, { contextId: number; documentNumber: number }>
  ): Promise<boolean> {
    if (entry.context_id === ContextId.Customer || entry.context_id === ContextId.Supplier) {
      await this.cache.deleteAccount(entry.record_id);
      return false;
    }

    if (entry.context_id === ITEM_CONTEXT_ID) {
      await this.cache.deleteItem(entry.record_id);
      return false;
    }

    let document = await this.cache.getDocumentByApiId(entry.record_id);
    const retryIdentity = retryDocumentIdentities[entry.record_id];
    if (!document && retryIdentity?.contextId === entry.context_id) {
      const candidate = await this.cache.getDocumentByNumber(
        retryIdentity.contextId,
        retryIdentity.documentNumber
      );
      if (candidate && (candidate.api_doc_id == null || candidate.api_doc_id === entry.record_id)) {
        document = candidate;
      }
    }
    if (document) {
      await this.cache.deleteDocument(document.doc_id);
      return true;
    }
    if (retryIdentity) return true;

    const directCandidate = await this.cache.getDocument(entry.record_id);
    if (!directCandidate) return true;
    if (
      directCandidate.context_id !== entry.context_id
      || (
        directCandidate.api_doc_id != null
        && directCandidate.api_doc_id !== entry.record_id
      )
    ) {
      return false;
    }
    await this.cache.deleteDocument(directCandidate.doc_id);
    return true;
  }

  private flattenEntries(response: DeletedLogListResponse): DeletedLogEntry[] {
    const entries = response.deletedlog ?? response.deleted_log ?? [];
    return Array.isArray(entries[0]) ? entries.flat() : entries as unknown as DeletedLogEntry[];
  }

  private mergeState(
    state: CacheState | null,
    now: number,
    deletedDocumentIds: Set<string>
  ): CacheState {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName?.trim() ? state.accountName : this.accountName,
      schemaVersion: state?.schemaVersion ?? CACHE_PENDING_SCHEMA_VERSION,
      lastDeletedSync: now,
      documentSyncCheckpoint: reconcileDocumentCheckpoint(
        state?.documentSyncCheckpoint,
        this.accountName,
        deletedDocumentIds
      ),
    };
  }
}

function reconcileDocumentCheckpoint(
  checkpoint: CacheState['documentSyncCheckpoint'],
  accountName: string,
  deletedDocumentIds: Set<string>
): CacheState['documentSyncCheckpoint'] {
  if (
    !checkpoint
    || checkpoint.accountName !== accountName
    || deletedDocumentIds.size === 0
  ) {
    return checkpoint;
  }
  const retryDocumentIds = checkpoint.retryDocumentIds.filter(
    (documentId) => !deletedDocumentIds.has(documentId)
  );
  if (retryDocumentIds.length === checkpoint.retryDocumentIds.length) return checkpoint;
  const retryIds = new Set(retryDocumentIds);
  const retryDocumentIdentities = Object.fromEntries(
    Object.entries(checkpoint.retryDocumentIdentities ?? {})
      .filter(([documentId]) => retryIds.has(documentId))
  );
  const traversalComplete = checkpoint.nextContextIndex >= DOCUMENT_CONTEXT_COUNT;
  const fullCatchUpComplete = checkpoint.syncType !== 'full' || checkpoint.phase === 'catch_up';
  if (retryDocumentIds.length === 0 && traversalComplete && fullCatchUpComplete) {
    return undefined;
  }
  return {
    ...checkpoint,
    retryDocumentIds,
    retryDocumentIdentities,
  };
}
