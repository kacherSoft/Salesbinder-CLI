/**
 * Document indexer service for syncing documents from API to cache
 */

import axios from 'axios';
import type { SalesBinderClient } from '../resources/index.js';
import { validateDocumentListResponse } from '../resources/documents.resource.js';
import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow, SyncOptions, SyncResult, CacheState } from './types.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId } from './types.js';
import type { Document, DocumentListResponse } from '../types/documents.types.js';
import type { CacheSyncProgress, CacheSyncProgressEventType } from './cache-sync-progress.types.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';
import {
  assertDocumentNumberLookupIdentity,
  findExistingDocument,
  sortRecordIssues,
  type DocumentRecoveryEntry,
} from './document-recovery.helpers.js';
import { normalizeDocumentCacheRows } from './document-row-normalizer.js';
import {
  assertDocumentScanBounds,
  flattenDocumentArray,
  validateDocumentPagination,
  type DocumentPaginationState,
} from './document-pagination-validation.js';
import {
  assertDocumentBusinessKey,
  assertDocumentRootIdentity,
  assertFetchedDocumentIdentity,
  classifyDocumentRecordError,
  DocumentRecordError,
  safeDocumentNumber,
} from './document-source-validation.js';
import {
  delay,
  isPaymentSyncInitialized,
  normalizeDocumentPaymentTransactions,
  nowInSeconds,
} from './payment-sync.helpers.js';
import { PAYMENT_DETAIL_DELAY_MS } from './payment-cache.constants.js';
import type { PaymentSyncMode } from './payment-sync.types.js';
import type { PaymentTransactionRow } from './payment-sync.types.js';

interface DocumentWriteResult {
  resolvedDocId: string;
  savedItems: number;
  savedPayments: number | null;
}

const DOCUMENT_BUNDLE_CAPABILITY_ERROR = 'Document sync requires atomic document bundle support.';

export interface DocumentIndexerOptions {
  /** Leave global sync watermarks unchanged for the multi-phase cache pipeline. */
  deferGlobalWatermark?: boolean;
}

/**
 * Document indexer service for syncing API data to cache
 */
export class DocumentIndexerService {
  private readonly staleThreshold: number;
  private readonly syncLookbackSeconds: number;

  constructor(
    private client: SalesBinderClient,
    private cache: CacheService,
    private readonly accountName: string,
    staleThresholdSeconds?: number,
    syncLookbackSeconds?: number,
    private readonly indexerOptions: DocumentIndexerOptions = {}
  ) {
    // Priority: env var > config parameter > default (3600s = 1 hour)
    const envValue = process.env.SALESBINDER_CACHE_STALE_SECONDS;
    this.staleThreshold = envValue ? parseInt(envValue, 10) : (staleThresholdSeconds ?? 3600);
    const lookbackValue = process.env[['SALESBINDER', 'SYNC', 'LOOKBACK', 'SECONDS'].join('_')];
    this.syncLookbackSeconds = lookbackValue
      ? parseInt(lookbackValue, 10)
      : (syncLookbackSeconds ?? 604800);
  }

  /**
   * Perform sync (full or delta based on options and cache state)
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    this.requireDocumentBundleWriter();
    const state = await this.cache.getCacheState();
    const needsInitialSync = !state || state.accountName !== this.accountName;

    if (options.full || needsInitialSync) {
      return this.fullSync(options);
    } else {
      return this.deltaSync(options);
    }
  }

  /**
   * Check if cache is stale (older than configured threshold)
   */
  async isCacheStale(): Promise<boolean> {
    const state = await this.cache.getCacheState();
    if (!state) return true;
    const staleTime = Math.floor(Date.now() / 1000) - this.staleThreshold;
    return state.lastSync < staleTime;
  }

  /**
   * Perform full sync - fetch all documents
   */
  private async fullSync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const state = await this.cache.getCacheState();
    let totalDocuments = 0;
    let totalLineItems = 0;
    let paymentDocumentsUpdated = 0;
    let lastPaymentCursor: string | null = null;
    const paymentRefreshStartedAt = nowInSeconds();
    const previousPaymentStatus = await this.cache.getPaymentSyncStatus();
    const refreshInvoicePayments = isPaymentSyncInitialized(previousPaymentStatus);
    const recoveryQueue = new Map<string, DocumentRecoveryEntry>();
    const seenIds = new Set<string>();
    const seenBusinessKeys = new Map<string, string>();
    let recordsObserved = 0;
    let frozenCheckpoint: { contextId: number; page: number; docIndex: number } | null = null;

    this.emitProgress(options, 'phase_started', 0);

    try {
      const contexts = [
        { id: DocumentContextId.Estimate, name: 'Estimate' },
        { id: DocumentContextId.Invoice, name: 'Invoice' },
        { id: DocumentContextId.PurchaseOrder, name: 'Purchase Order' },
      ];

      for (const context of contexts) {
        // A page/index checkpoint cannot be a safe write cursor because the v2 list
        // API exposes no stable snapshot generation or ordering. Replay every row
        // whenever the documents phase itself is incomplete.
        console.error(`Syncing ${context.name}s...`);

        let page = 1;
        let hasMore = true;
        let paginationState: DocumentPaginationState | null | undefined;
        let contextRowsFetched = 0;

        while (hasMore) {
          assertDocumentScanBounds(page, contextRowsFetched);
          this.emitProgress(options, 'page_started', recordsObserved, page);
          let response: DocumentListResponse;
          try {
            response = validateDocumentListResponse(
              await this.client.documents.list({
                contextId: context.id,
                page,
                pageLimit: 50,
              })
            );
          } catch (error: unknown) {
            // A typed 404 after at least one page is the legacy end-of-pagination sentinel.
            if (axios.isAxiosError(error) && error.response?.status === 404) {
              if (page === 1) throw error;
              if (paginationState && page <= paginationState.pages) {
                throw new Error(`Document pagination ended before page ${paginationState.pages}`);
              }
              hasMore = false;
              break;
            }
            // Re-throw other errors
            throw error;
          }

          const documents = flattenDocumentArray(response?.documents);
          contextRowsFetched += documents.length;
          assertDocumentScanBounds(page, contextRowsFetched);
          paginationState = validateDocumentPagination(
            response,
            page,
            documents.length,
            paginationState
          );
          if (!documents || documents.length === 0) {
            if (paginationState && paginationState.count !== 0 && page <= paginationState.pages) {
              throw new Error(`Document page ${page} was empty before the declared snapshot ended`);
            }
            hasMore = false;
            break;
          }

          // Process documents from list response (includes line items in most cases)
          for (let docIndex = 0; docIndex < documents.length; docIndex++) {
            const doc = documents[docIndex];
            assertDocumentRootIdentity(doc, context.id, seenIds, seenBusinessKeys);
            const checkpoint = { contextId: context.id, page, docIndex };
            if (!frozenCheckpoint) options.resume?.onDocumentCheckpoint?.(checkpoint);
            recordsObserved++;
            try {
              const { resolvedDocId, savedItems, savedPayments } = await this.writeSourceDocument(
                doc,
                context.id,
                refreshInvoicePayments
              );

              totalDocuments++;
              totalLineItems += savedItems;
              if (savedPayments !== null) {
                paymentDocumentsUpdated++;
                lastPaymentCursor = resolvedDocId;
              }

              if (!frozenCheckpoint) {
                options.resume?.onDocumentCheckpoint?.({
                  contextId: context.id,
                  page,
                  docIndex: docIndex + 1,
                });
              }

              options.onProgress?.(totalDocuments, -1);
              this.emitProgress(options, 'record_processed', recordsObserved, page);
            } catch (error) {
              if (!(error instanceof DocumentRecordError)) throw error;
              recoveryQueue.set(doc.id, {
                id: doc.id,
                contextId: context.id,
                documentNumber: safeDocumentNumber(doc.document_number),
              });
              if (!frozenCheckpoint) {
                frozenCheckpoint = checkpoint;
                options.resume?.onDocumentCheckpoint?.(checkpoint);
              }
              this.emitProgress(options, 'record_failed_collected', recordsObserved, page);
            }
          }

          this.emitProgress(options, 'page_completed', recordsObserved, page);
          hasMore = paginationState ? page < paginationState.pages : true;
          if (!frozenCheckpoint) {
            options.resume?.onDocumentCheckpoint?.({
              contextId: context.id,
              page: page + 1,
              docIndex: 0,
            });
          }
          page += 1;

          // Rate limiting: pause between pages to avoid rate limits
          if (hasMore) await delay(500);
        }
        if (paginationState && contextRowsFetched !== paginationState.count) {
          throw new Error(
            `Incomplete document snapshot: expected ${paginationState.count}, received ${contextRowsFetched}`
          );
        }
      }

      const recovery = await this.recoverDocuments(
        recoveryQueue,
        refreshInvoicePayments,
        options,
        totalDocuments,
        seenBusinessKeys
      );
      totalDocuments += recovery.documents;
      totalLineItems += recovery.lineItems;
      paymentDocumentsUpdated += recovery.paymentDocuments;
      lastPaymentCursor = recovery.lastPaymentCursor ?? lastPaymentCursor;
      const recordIssues = recovery.recordIssues;

      // Update cache state
      const completedAt = nowInSeconds();
      const deferGlobalWatermark = this.indexerOptions.deferGlobalWatermark === true;
      await this.cache.setCacheState({
        ...state,
        lastSync:
          deferGlobalWatermark || recordIssues.length > 0 ? (state?.lastSync ?? 0) : completedAt,
        lastFullSync:
          deferGlobalWatermark || recordIssues.length > 0
            ? (state?.lastFullSync ?? 0)
            : completedAt,
        lastSyncAttempt: completedAt,
        documentCount: await this.cache.getDocumentCount(),
        itemDocumentCount: await this.cache.getItemDocumentCount(),
        accountName: this.accountName,
        schemaVersion: CACHE_SCHEMA_VERSION,
      });
      await this.completePaymentRefresh(
        'full',
        refreshInvoicePayments,
        paymentRefreshStartedAt,
        paymentDocumentsUpdated,
        lastPaymentCursor,
        previousPaymentStatus?.lastSuccessfulSync,
        recordIssues
      );
      this.emitProgress(options, 'phase_completed', recordsObserved);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'full',
        documentsProcessed: totalDocuments,
        lineItemsProcessed: totalLineItems,
        syncLookbackSeconds: this.syncLookbackSeconds,
        duration: `${duration}s`,
        recordIssues,
      };
    } catch (error) {
      try {
        await this.failPaymentRefresh(
          'full',
          refreshInvoicePayments,
          paymentRefreshStartedAt,
          paymentDocumentsUpdated,
          lastPaymentCursor,
          previousPaymentStatus?.lastSuccessfulSync,
          'Document refresh failed'
        );
      } catch {
        /* Preserve the original sync failure. */
      }
      console.error('Full sync failed: Document refresh failed');
      throw error;
    }
  }

  /**
   * Perform delta sync - fetch only modified documents
   */
  private async deltaSync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const state = await this.cache.getCacheState();
    if (!state) throw new Error('Delta document sync requires existing cache state');
    let documentsUpdated = 0;
    const documentsDeleted = 0;
    let lineItemsUpdated = 0;
    let paymentDocumentsUpdated = 0;
    let lastPaymentCursor: string | null = null;
    const paymentRefreshStartedAt = nowInSeconds();
    const previousPaymentStatus = await this.cache.getPaymentSyncStatus();
    const refreshInvoicePayments = isPaymentSyncInitialized(previousPaymentStatus);
    const recoveryQueue = new Map<string, DocumentRecoveryEntry>();
    const seenIds = new Set<string>();
    const seenBusinessKeys = new Map<string, string>();
    let recordsObserved = 0;

    this.emitProgress(options, 'phase_started', 0);

    try {
      const lastSyncTime = Math.max(0, state.lastSync - this.syncLookbackSeconds);
      const contexts = [
        DocumentContextId.Estimate,
        DocumentContextId.Invoice,
        DocumentContextId.PurchaseOrder,
      ];

      for (const contextId of contexts) {
        let page = 1;
        let hasMore = true;
        let paginationState: DocumentPaginationState | null | undefined;
        let contextRowsFetched = 0;

        while (hasMore) {
          assertDocumentScanBounds(page, contextRowsFetched);
          this.emitProgress(options, 'page_started', recordsObserved, page);
          let response: DocumentListResponse;
          try {
            response = validateDocumentListResponse(
              await this.client.documents.list({
                contextId,
                modifiedSince: lastSyncTime,
                page,
                pageLimit: 50,
              })
            );
          } catch (error: unknown) {
            // A typed 404 after at least one page is the legacy end-of-pagination sentinel.
            if (axios.isAxiosError(error) && error.response?.status === 404) {
              if (page === 1) throw error;
              if (paginationState && page <= paginationState.pages) {
                throw new Error(`Document pagination ended before page ${paginationState.pages}`);
              }
              hasMore = false;
              break;
            }
            // Re-throw other errors
            throw error;
          }

          const documents = flattenDocumentArray(response?.documents);
          contextRowsFetched += documents.length;
          assertDocumentScanBounds(page, contextRowsFetched);
          paginationState = validateDocumentPagination(
            response,
            page,
            documents.length,
            paginationState
          );
          if (!documents || documents.length === 0) {
            if (paginationState && paginationState.count !== 0 && page <= paginationState.pages) {
              throw new Error(`Document page ${page} was empty before the declared snapshot ended`);
            }
            hasMore = false;
            break;
          }

          for (const doc of documents) {
            assertDocumentRootIdentity(doc, contextId, seenIds, seenBusinessKeys);
            recordsObserved++;
            try {
              const { resolvedDocId, savedItems, savedPayments } = await this.writeSourceDocument(
                doc,
                contextId,
                refreshInvoicePayments
              );

              documentsUpdated++;
              lineItemsUpdated += savedItems;
              if (savedPayments !== null) {
                paymentDocumentsUpdated++;
                lastPaymentCursor = resolvedDocId;
              }

              options.onProgress?.(documentsUpdated, -1);
              this.emitProgress(options, 'record_processed', recordsObserved, page);
            } catch (error) {
              if (!(error instanceof DocumentRecordError)) throw error;
              recoveryQueue.set(doc.id, {
                id: doc.id,
                contextId,
                documentNumber: safeDocumentNumber(doc.document_number),
              });
              this.emitProgress(options, 'record_failed_collected', recordsObserved, page);
            }
          }

          this.emitProgress(options, 'page_completed', recordsObserved, page);
          hasMore = paginationState ? page < paginationState.pages : true;
          page += 1;
          if (hasMore) await delay(500);
        }
        if (paginationState && contextRowsFetched !== paginationState.count) {
          throw new Error(
            `Incomplete document snapshot: expected ${paginationState.count}, received ${contextRowsFetched}`
          );
        }
      }

      const recovery = await this.recoverDocuments(
        recoveryQueue,
        refreshInvoicePayments,
        options,
        documentsUpdated,
        seenBusinessKeys
      );
      documentsUpdated += recovery.documents;
      lineItemsUpdated += recovery.lineItems;
      paymentDocumentsUpdated += recovery.paymentDocuments;
      lastPaymentCursor = recovery.lastPaymentCursor ?? lastPaymentCursor;
      const recordIssues = recovery.recordIssues;

      // Update cache state
      const updatedState: CacheState = {
        ...state,
        lastSync:
          this.indexerOptions.deferGlobalWatermark === true || recordIssues.length > 0
            ? state.lastSync
            : nowInSeconds(),
        lastSyncAttempt: nowInSeconds(),
        documentCount: await this.cache.getDocumentCount(),
        itemDocumentCount: await this.cache.getItemDocumentCount(),
      };
      await this.cache.setCacheState(updatedState);
      await this.completePaymentRefresh(
        'delta',
        refreshInvoicePayments,
        paymentRefreshStartedAt,
        paymentDocumentsUpdated,
        lastPaymentCursor,
        previousPaymentStatus?.lastSuccessfulSync,
        recordIssues
      );
      this.emitProgress(options, 'phase_completed', recordsObserved);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'delta',
        documentsProcessed: documentsUpdated,
        documentsDeleted,
        lineItemsProcessed: lineItemsUpdated,
        syncLookbackSeconds: this.syncLookbackSeconds,
        duration: `${duration}s`,
        recordIssues,
      };
    } catch (error) {
      try {
        await this.failPaymentRefresh(
          'delta',
          refreshInvoicePayments,
          paymentRefreshStartedAt,
          paymentDocumentsUpdated,
          lastPaymentCursor,
          previousPaymentStatus?.lastSuccessfulSync,
          'Document refresh failed'
        );
      } catch {
        /* Preserve the original sync failure. */
      }
      console.error('Delta sync failed: Document refresh failed');
      throw error;
    }
  }

  private async writeSourceDocument(
    sourceDocument: Document,
    expectedContext: DocumentContextId,
    refreshInvoicePayments: boolean
  ): Promise<DocumentWriteResult> {
    const expectedDocumentNumber = safeDocumentNumber(sourceDocument.document_number);
    if (expectedDocumentNumber === undefined) {
      throw new DocumentRecordError('invalid_record', 'Document failed source validation');
    }
    let fullDocument = sourceDocument;
    if (this.shouldFetchDocumentDetail(sourceDocument, refreshInvoicePayments)) {
      try {
        fullDocument = await this.client.documents.get(sourceDocument.id);
      } catch (error) {
        const recordError = classifyDocumentRecordError(error);
        if (recordError) throw recordError;
        throw error;
      }
      await delay(PAYMENT_DETAIL_DELAY_MS);
    }
    assertFetchedDocumentIdentity(
      fullDocument,
      sourceDocument.id,
      expectedContext,
      expectedDocumentNumber
    );
    return this.writeFetchedDocument(fullDocument, refreshInvoicePayments);
  }

  private async writeFetchedDocument(
    document: Document,
    refreshInvoicePayments: boolean
  ): Promise<DocumentWriteResult> {
    if (!Array.isArray(document.document_items)) {
      throw new DocumentRecordError('invalid_record', 'Document failed source validation');
    }
    const { docRow, itemRows } = normalizeDocumentCacheRows(document);
    return this.writeDocumentBundle(document, docRow, itemRows, refreshInvoicePayments);
  }

  private async writeDocumentBundle(
    sourceDocument: Document,
    docRow: DocumentRow,
    itemRows: Omit<ItemDocumentRow, 'id'>[],
    refreshInvoicePayments: boolean
  ): Promise<DocumentWriteResult> {
    const existingByApiId = docRow.api_doc_id
      ? await this.cache.getDocumentByApiId(docRow.api_doc_id)
      : undefined;
    const existingByNumber = await this.cache.getDocumentByNumber(
      docRow.context_id,
      docRow.doc_number
    );
    if (existingByApiId && existingByNumber && existingByApiId.doc_id !== existingByNumber.doc_id) {
      throw new Error(`Cache document identity conflict for ${docRow.api_doc_id}`);
    }
    assertDocumentNumberLookupIdentity(existingByNumber, docRow.api_doc_id);
    const existing = existingByApiId ?? existingByNumber;
    const resolvedDocId = existing?.doc_id ?? docRow.doc_id;
    const resolvedDoc = { ...docRow, doc_id: resolvedDocId };
    const resolvedItems = itemRows.map((item) => ({ ...item, doc_id: resolvedDocId }));
    let paymentRows: PaymentTransactionRow[] | undefined;
    if (this.shouldFetchInvoicePayments(sourceDocument, refreshInvoicePayments)) {
      try {
        paymentRows = normalizeDocumentPaymentTransactions(
          sourceDocument,
          resolvedDocId,
          nowInSeconds()
        );
      } catch (error) {
        const recordError = classifyDocumentRecordError(error);
        if (recordError) throw recordError;
        throw error;
      }
    }

    await this.requireDocumentBundleWriter()(resolvedDoc, resolvedItems, paymentRows);
    return {
      resolvedDocId,
      savedItems: resolvedItems.length,
      savedPayments: paymentRows?.length ?? null,
    };
  }

  private shouldFetchInvoicePayments(
    doc: Pick<Document, 'context_id'>,
    refreshInvoicePayments: boolean
  ): boolean {
    return refreshInvoicePayments && doc.context_id === DocumentContextId.Invoice;
  }

  private requireDocumentBundleWriter(): NonNullable<CacheService['replaceDocumentBundle']> {
    const writer = this.cache.replaceDocumentBundle;
    if (typeof writer !== 'function') throw new Error(DOCUMENT_BUNDLE_CAPABILITY_ERROR);
    return writer.bind(this.cache);
  }

  private shouldFetchDocumentDetail(
    doc: Pick<Document, 'context_id' | 'document_items'>,
    refreshInvoicePayments: boolean
  ): boolean {
    if (!doc.document_items || doc.document_items.length === 0) {
      return true;
    }

    return refreshInvoicePayments && doc.context_id === DocumentContextId.Invoice;
  }

  private async recoverDocuments(
    queue: Map<string, DocumentRecoveryEntry>,
    refreshInvoicePayments: boolean,
    options: SyncOptions,
    startingDocuments: number,
    seenBusinessKeys: Map<string, string>
  ): Promise<{
    documents: number;
    lineItems: number;
    paymentDocuments: number;
    lastPaymentCursor: string | null;
    recordIssues: SyncRecordIssue[];
  }> {
    const entries = [...queue.values()].sort((left, right) =>
      compareCodeUnitStrings(left.id, right.id)
    );
    const recordIssues: SyncRecordIssue[] = [];
    let documents = 0;
    let lineItems = 0;
    let paymentDocuments = 0;
    let lastPaymentCursor: string | null = null;
    if (entries.length > 0) {
      this.emitProgress(options, 'retry_pass_started', 0, undefined, entries.length);
    }

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      let lookupEntry = entry;
      try {
        let document: Document;
        try {
          document = await this.client.documents.get(entry.id);
        } catch (error) {
          const recordError = classifyDocumentRecordError(error);
          if (recordError) throw recordError;
          throw error;
        }
        await delay(PAYMENT_DETAIL_DELAY_MS);
        assertFetchedDocumentIdentity(document, entry.id, entry.contextId, entry.documentNumber);
        const recoveredDocumentNumber = safeDocumentNumber(document.document_number);
        if (recoveredDocumentNumber === undefined) {
          throw new DocumentRecordError('invalid_record', 'Document failed source validation');
        }
        assertDocumentBusinessKey(
          document.id,
          entry.contextId,
          recoveredDocumentNumber,
          seenBusinessKeys
        );
        lookupEntry = { ...entry, documentNumber: recoveredDocumentNumber };
        const write = await this.writeFetchedDocument(document, refreshInvoicePayments);
        documents++;
        lineItems += write.savedItems;
        if (write.savedPayments !== null) {
          paymentDocuments++;
          lastPaymentCursor = write.resolvedDocId;
        }
        options.onProgress?.(startingDocuments + documents, -1);
        this.emitProgress(options, 'record_retry_succeeded', index + 1, undefined, entries.length);
      } catch (error) {
        if (!(error instanceof DocumentRecordError)) throw error;
        const existing = await findExistingDocument(this.cache, lookupEntry);
        recordIssues.push({
          resource: 'document',
          id: entry.id,
          context_id: entry.contextId,
          code: error.code,
          message: error.safeMessage,
          attempts: 2,
          outcome: existing ? 'preserved_last_known_good' : 'omitted_new',
        });
        this.emitProgress(options, 'record_retry_failed', index + 1, undefined, entries.length);
      }
    }

    return {
      documents,
      lineItems,
      paymentDocuments,
      lastPaymentCursor,
      recordIssues: sortRecordIssues(recordIssues),
    };
  }

  private emitProgress(
    options: SyncOptions,
    event: CacheSyncProgressEventType,
    recordsProcessed: number,
    page?: number,
    recordsTotal: number | null = null
  ): void {
    if (!options.onProgressEvent) return;
    const progress: CacheSyncProgress = {
      phase: 'documents',
      event,
      ...(page === undefined ? {} : { page }),
      recordsProcessed,
      recordsTotal,
      indeterminate: recordsTotal === null,
      apiVersion: '2.0',
      timestamp: nowInSeconds(),
    };
    options.onProgressEvent(progress);
  }

  private async completePaymentRefresh(
    mode: PaymentSyncMode,
    refreshInvoicePayments: boolean,
    startedAt: number,
    processedDocuments: number,
    cursor: string | null,
    lastSuccessfulSync: number | undefined,
    recordIssues: SyncRecordIssue[]
  ): Promise<void> {
    if (recordIssues.some((issue) => issue.context_id === DocumentContextId.Invoice)) {
      await this.failPaymentRefresh(
        mode,
        refreshInvoicePayments,
        startedAt,
        processedDocuments,
        cursor,
        lastSuccessfulSync,
        'Invoice document refresh completed with unresolved records.'
      );
      return;
    }
    await this.finalizePaymentRefresh(
      mode,
      refreshInvoicePayments,
      startedAt,
      processedDocuments,
      cursor
    );
  }

  private async finalizePaymentRefresh(
    mode: PaymentSyncMode,
    refreshInvoicePayments: boolean,
    startedAt: number,
    processedDocuments: number,
    cursor: string | null
  ): Promise<void> {
    if (!refreshInvoicePayments) return;

    const finishedAt = nowInSeconds();
    await this.cache.setPaymentSyncStatus({
      status: 'complete',
      mode,
      startedAt,
      updatedAt: finishedAt,
      finishedAt,
      lastSuccessfulSync: finishedAt,
      cursor,
      processedDocuments,
      totalDocuments: processedDocuments,
    });
  }

  private async failPaymentRefresh(
    mode: PaymentSyncMode,
    refreshInvoicePayments: boolean,
    startedAt: number,
    processedDocuments: number,
    cursor: string | null,
    lastSuccessfulSync: number | undefined,
    safeError:
      | 'Document refresh failed'
      | 'Invoice document refresh completed with unresolved records.'
  ): Promise<void> {
    if (!refreshInvoicePayments) return;
    const failedAt = nowInSeconds();
    await this.cache.setPaymentSyncStatus({
      status: 'failed',
      mode,
      startedAt,
      updatedAt: failedAt,
      finishedAt: failedAt,
      lastSuccessfulSync,
      cursor,
      processedDocuments,
      totalDocuments: processedDocuments,
      error: safeError,
    });
  }
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
