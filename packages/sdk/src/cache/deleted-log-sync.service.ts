import type { SalesBinderClient } from '../resources/index.js';
import { ContextId, DocumentContextId } from '../types/common.types.js';
import type { DeletedLogListResponse } from '../types/deleted-log.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type { CacheState } from './types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

export interface DeletedLogSyncResult {
  deletedRecordsProcessed: number;
  documentTombstones: DeletedDocumentTombstone[];
}

export interface DeletedDocumentTombstone {
  contextId: DocumentContextId;
  apiDocumentId: string;
}

export interface DeletedLogSyncOptions {
  onProgressEvent?: CacheSyncProgressCallback;
  /** Explicit legacy opt-in; validated v3 snapshots own item membership by default. */
  includeItemDeletes?: boolean;
}

interface ContextSyncResult {
  processed: number;
  total: number | null;
  documentTombstones: DeletedDocumentTombstone[];
}

interface ValidatedDeletedLogEntry {
  context_id: number;
  record_id: string;
}

type DeletedLogProgress = Omit<CacheSyncProgress, 'phase' | 'apiVersion'>;

const ITEM_CONTEXT_ID = 6;
const MAX_DELETED_LOG_RECORD_ID_LENGTH = 256;
const MAX_DELETED_LOG_PAGES = 10_000;
const MAX_DELETED_LOG_RECORDS = 1_000_000;

export class DeletedLogSyncService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {
    if (hasUnpairedUtf16Surrogate(accountName)) {
      throw new Error('Deleted-log account name is invalid');
    }
  }

  async sync(options: DeletedLogSyncOptions = {}): Promise<DeletedLogSyncResult> {
    const includeItemDeletes = options.includeItemDeletes === true;
    this.emit(options.onProgressEvent, {
      event: 'phase_started',
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    const initialState = await this.cache.getCacheState();
    const since = Math.max(
      0,
      (initialState?.lastDeletedSync ?? initialState?.lastSync ?? 0) - this.syncLookbackSeconds
    );
    const contexts = [
      ContextId.Customer,
      ContextId.Supplier,
      ...(includeItemDeletes ? [ITEM_CONTEXT_ID] : []),
      DocumentContextId.Estimate,
      DocumentContextId.Invoice,
      DocumentContextId.PurchaseOrder,
    ];
    const results: ContextSyncResult[] = [];
    const seenIdentities = new Set<string>();

    for (const [index, contextId] of contexts.entries()) {
      results.push(
        await this.syncContext(contextId, since, index + 1, seenIdentities, options.onProgressEvent)
      );
    }

    const latestState = await this.cache.getCacheState();
    await this.cache.setCacheState(this.mergeState(latestState, Math.floor(Date.now() / 1000)));
    const processed = results.reduce((sum, result) => sum + result.processed, 0);
    const total = sumKnownTotals(results.map(({ total: value }) => value));
    this.emit(options.onProgressEvent, {
      event: 'phase_completed',
      recordsProcessed: processed,
      recordsTotal: total,
      indeterminate: total === null,
    });
    return {
      deletedRecordsProcessed: processed,
      documentTombstones: results
        .flatMap(({ documentTombstones }) => documentTombstones)
        .sort(compareDocumentTombstones),
    };
  }

  private async syncContext(
    contextId: number,
    deletedSince: number,
    pass: number,
    seenIdentities: Set<string>,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<ContextSyncResult> {
    let page = 1;
    let processed = 0;
    let pagesTotal: number | null = null;
    let recordsTotal: number | null = null;
    let hasMore = true;
    const documentTombstones: DeletedDocumentTombstone[] = [];

    this.emit(onProgressEvent, {
      event: 'pass_started',
      pass,
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    while (hasMore) {
      this.emit(onProgressEvent, {
        event: 'page_started',
        pass,
        page,
        pagesTotal,
        recordsProcessed: processed,
        recordsTotal,
        indeterminate: recordsTotal === null,
      });
      const response = await this.client.deletedLog.list({
        contextId,
        deletedSince,
        page,
        pageLimit: 200,
      });
      const entries = this.validatePageEntries(response, contextId, seenIdentities);
      const pagination = validateDeletedLogPagination(
        response,
        page,
        processed,
        entries.length,
        pagesTotal,
        recordsTotal
      );
      if (page === 1) {
        pagesTotal = pagination.pages;
        recordsTotal = pagination.count;
      }
      if (entries.length === 0) {
        this.emit(onProgressEvent, {
          event: 'page_completed',
          pass,
          page,
          pagesTotal,
          recordsProcessed: processed,
          recordsTotal,
          indeterminate: recordsTotal === null,
        });
        hasMore = false;
        continue;
      }

      for (const entry of entries) {
        const tombstone = await this.deleteCachedRecord(entry);
        if (tombstone) documentTombstones.push(tombstone);
        processed++;
        if (recordsTotal !== null && processed > recordsTotal) recordsTotal = null;
        this.emit(onProgressEvent, {
          event: 'record_processed',
          pass,
          page,
          pagesTotal,
          recordsProcessed: processed,
          recordsTotal,
          indeterminate: recordsTotal === null,
        });
      }

      this.emit(onProgressEvent, {
        event: 'page_completed',
        pass,
        page,
        pagesTotal,
        recordsProcessed: processed,
        recordsTotal,
        indeterminate: recordsTotal === null,
      });
      hasMore = pagesTotal !== null && page < pagesTotal;
      if (hasMore) page++;
    }

    this.emit(onProgressEvent, {
      event: 'pass_completed',
      pass,
      recordsProcessed: processed,
      recordsTotal,
      indeterminate: recordsTotal === null,
    });
    return { processed, total: recordsTotal, documentTombstones };
  }

  private emit(
    callback: CacheSyncProgressCallback | undefined,
    progress: DeletedLogProgress
  ): void {
    callback?.({ phase: 'deleted-log', apiVersion: '2.0', ...progress });
  }

  private async deleteCachedRecord(
    entry: ValidatedDeletedLogEntry
  ): Promise<DeletedDocumentTombstone | null> {
    if (entry.context_id === ContextId.Customer || entry.context_id === ContextId.Supplier) {
      await this.cache.deleteAccount(entry.record_id);
      return null;
    }

    if (entry.context_id === ITEM_CONTEXT_ID) {
      await this.cache.deleteItem(entry.record_id);
      return null;
    }

    const document = await this.cache.getDocumentByApiId(entry.record_id);
    if (document) {
      if (document.context_id !== entry.context_id) {
        throw new Error('Deleted-log document resolution context mismatch');
      }
      await this.cache.deleteDocument(document.doc_id);
    } else {
      const directDocument = await this.cache.getDocument(entry.record_id);
      if (
        directDocument?.context_id === entry.context_id &&
        (directDocument.api_doc_id === null ||
          directDocument.api_doc_id === undefined ||
          directDocument.api_doc_id === entry.record_id)
      ) {
        await this.cache.deleteDocument(directDocument.doc_id);
      }
    }
    return {
      contextId: entry.context_id as DocumentContextId,
      apiDocumentId: entry.record_id,
    };
  }

  private validatePageEntries(
    response: DeletedLogListResponse,
    requestedContextId: number,
    seenIdentities: Set<string>
  ): ValidatedDeletedLogEntry[] {
    if (!isRecord(response)) throw new Error('Deleted-log response envelope is invalid');
    const hasDeletedLog = Object.prototype.hasOwnProperty.call(response, 'deletedlog');
    const hasDeletedLogAlias = Object.prototype.hasOwnProperty.call(response, 'deleted_log');
    if (hasDeletedLog === hasDeletedLogAlias) {
      throw new Error('Deleted-log response envelope is ambiguous or missing');
    }
    const envelope = hasDeletedLog ? response.deletedlog : response.deleted_log;
    if (!Array.isArray(envelope)) throw new Error('Deleted-log response envelope is invalid');

    const entries: unknown[] = envelope.every(Array.isArray)
      ? envelope.flat()
      : envelope.some(Array.isArray)
        ? []
        : envelope;
    if (envelope.some(Array.isArray) && !envelope.every(Array.isArray)) {
      throw new Error('Deleted-log response envelope is invalid');
    }

    const validated: ValidatedDeletedLogEntry[] = [];
    const pageIdentities = new Set<string>();
    for (const candidate of entries) {
      if (!isRecord(candidate)) throw new Error('Deleted-log entry identity is invalid');
      if (candidate.context_id !== requestedContextId) {
        throw new Error(`Deleted-log context mismatch for requested context ${requestedContextId}`);
      }
      const recordId = requireCanonicalDeletedLogRecordId(candidate.record_id);
      const identity = JSON.stringify([requestedContextId, recordId]);
      if (seenIdentities.has(identity) || pageIdentities.has(identity)) {
        throw new Error('Deleted-log response contains a duplicate identity');
      }
      pageIdentities.add(identity);
      validated.push({ context_id: requestedContextId, record_id: recordId });
    }
    for (const identity of pageIdentities) seenIdentities.add(identity);
    return validated;
  }

  private mergeState(state: CacheState | null, now: number): CacheState {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastDeletedSync: now,
    };
  }
}

function validateDeletedLogPagination(
  response: DeletedLogListResponse,
  requestedPage: number,
  processed: number,
  pageEntryCount: number,
  expectedPages: number | null,
  expectedCount: number | null
): { count: number; pages: number } {
  const reportedPage = parsePaginationCount(response.page);
  const reportedPages = parsePaginationCount(response.pages);
  const reportedCount = parsePaginationCount(response.count);
  if (
    reportedPage !== requestedPage ||
    reportedPages === null ||
    reportedCount === null ||
    reportedPages > MAX_DELETED_LOG_PAGES ||
    reportedCount > MAX_DELETED_LOG_RECORDS ||
    (expectedPages !== null && reportedPages !== expectedPages) ||
    (expectedCount !== null && reportedCount !== expectedCount)
  ) {
    throw new Error('Deleted-log pagination metadata is invalid or changed');
  }

  if (reportedPages === 0) {
    if (requestedPage !== 1 || reportedCount !== 0 || pageEntryCount !== 0) {
      throw new Error('Deleted-log pagination does not match its entries');
    }
    return { count: reportedCount, pages: reportedPages };
  }
  if (requestedPage > reportedPages || (requestedPage < reportedPages && pageEntryCount === 0)) {
    throw new Error('Deleted-log pagination ended before its declared final page');
  }
  const prospectiveProcessed = processed + pageEntryCount;
  if (
    prospectiveProcessed > reportedCount ||
    (requestedPage === reportedPages && prospectiveProcessed !== reportedCount)
  ) {
    throw new Error('Deleted-log entry count does not match pagination metadata');
  }
  return { count: reportedCount, pages: reportedPages };
}

function parsePaginationCount(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sumKnownTotals(totals: Array<number | null>): number | null {
  return totals.every((total): total is number => total !== null)
    ? totals.reduce<number>((sum, total) => sum + total, 0)
    : null;
}

function compareDocumentTombstones(
  left: DeletedDocumentTombstone,
  right: DeletedDocumentTombstone
): number {
  return (
    left.contextId - right.contextId ||
    compareUtf16CodeUnits(left.apiDocumentId, right.apiDocumentId)
  );
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireCanonicalDeletedLogRecordId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DELETED_LOG_RECORD_ID_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error('Deleted-log entry identity is invalid');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
