/**
 * Document indexer service for syncing documents from API to cache
 */

import type { SalesBinderClient } from '../resources/index.js';
import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow, SyncOptions, SyncResult, CacheState } from './types.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId } from './types.js';
import type { Document, DocumentListResponse } from '../types/documents.types.js';
import {
  delay,
  isPaymentSyncInitialized,
  normalizeDocumentPaymentTransactions,
  nowInSeconds,
  sanitizePaymentSyncError,
} from './payment-sync.helpers.js';
import { PAYMENT_DETAIL_DELAY_MS } from './payment-cache.constants.js';
import type { PaymentSyncMode } from './payment-sync.types.js';

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
    private readonly indexerOptions: DocumentIndexerOptions = {},
  ) {
    // Priority: env var > config parameter > default (3600s = 1 hour)
    const envValue = process.env.SALESBINDER_CACHE_STALE_SECONDS;
    this.staleThreshold = envValue
      ? parseInt(envValue, 10)
      : (staleThresholdSeconds ?? 3600);
    const lookbackValue = process.env[['SALESBINDER', 'SYNC', 'LOOKBACK', 'SECONDS'].join('_')];
    this.syncLookbackSeconds = lookbackValue
      ? parseInt(lookbackValue, 10)
      : (syncLookbackSeconds ?? 604800);
  }

  /**
   * Perform sync (full or delta based on options and cache state)
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
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

    try {
      const contexts = [
        { id: DocumentContextId.Estimate, name: 'Estimate' },
        { id: DocumentContextId.Invoice, name: 'Invoice' },
        { id: DocumentContextId.PurchaseOrder, name: 'Purchase Order' },
      ];

      for (const context of contexts) {
        const resumeDoc = options.resume?.documents;
        if (resumeDoc?.contextId && context.id < resumeDoc.contextId) {
          console.error(`Skipping ${context.name}s: full-resume checkpoint already passed context ${context.id}`);
          continue;
        }
        console.error(`Syncing ${context.name}s...`);

        let page = resumeDoc?.contextId === context.id ? Math.max(1, resumeDoc.page ?? 1) : 1;
        let hasMore = true;

        while (hasMore) {
          let response: DocumentListResponse;
          try {
            response = await this.client.documents.list({
              contextId: context.id,
              page,
              pageLimit: 50,
            });
          } catch (error: any) {
            // 404 means we've reached the end of available pages
            if (error?.response?.status === 404) {
              hasMore = false;
              break;
            }
            // Re-throw other errors
            throw error;
          }

          const documents = this.flattenDocumentArray(response?.documents);
          if (!documents || documents.length === 0) {
            hasMore = false;
            break;
          }

          // Process documents from list response (includes line items in most cases)
          const startDocIndex = options.resume?.documents?.contextId === context.id && options.resume?.documents?.page === page
            ? Math.max(0, options.resume?.documents?.docIndex ?? 0)
            : 0;
          for (let docIndex = startDocIndex; docIndex < documents.length; docIndex++) {
            const doc = documents[docIndex];
            options.resume?.onDocumentCheckpoint?.({ contextId: context.id, page, docIndex });
            try {
              let fullDoc = doc;
              
              // Only fetch individual document if line items are missing
              if (this.shouldFetchDocumentDetail(doc, refreshInvoicePayments)) {
                fullDoc = await this.client.documents.get(doc.id);
                // Add small delay after individual fetch to avoid rate limits
                await delay(PAYMENT_DETAIL_DELAY_MS);
              }

              // Process document
              const { docRow, itemRows } = this.processDocument(fullDoc);

              const { resolvedDocId, savedItems } = await this.writeDocument(docRow, itemRows);
              const savedPayments = await this.writeInvoicePayments(fullDoc, resolvedDocId, refreshInvoicePayments);

              totalDocuments++;
              totalLineItems += savedItems;
              if (savedPayments !== null) {
                paymentDocumentsUpdated++;
                lastPaymentCursor = resolvedDocId;
              }

              options.resume?.onDocumentCheckpoint?.({ contextId: context.id, page, docIndex: docIndex + 1 });

              if (options.onProgress) {
                options.onProgress(totalDocuments, -1);
              }
            } catch (error) {
              console.error(
                `Failed to sync document ${doc.id}:`,
                error instanceof Error ? error.message : error,
              );
              throw error;
            }
          }

          options.resume?.onDocumentCheckpoint?.({ contextId: context.id, page: page + 1, docIndex: 0 });
          page++;

          // Rate limiting: pause between pages to avoid rate limits
          await delay(500);
        }
      }

      // Update cache state
      const completedAt = nowInSeconds();
      const deferGlobalWatermark = this.indexerOptions.deferGlobalWatermark === true;
      await this.cache.setCacheState({
        lastSync: deferGlobalWatermark ? state?.lastSync ?? 0 : completedAt,
        lastFullSync: deferGlobalWatermark ? state?.lastFullSync ?? 0 : completedAt,
        documentCount: await this.cache.getDocumentCount(),
        itemDocumentCount: await this.cache.getItemDocumentCount(),
        accountName: this.accountName,
        schemaVersion: CACHE_SCHEMA_VERSION,
      });
      await this.finalizePaymentRefresh(
        'full', refreshInvoicePayments, paymentRefreshStartedAt, paymentDocumentsUpdated, lastPaymentCursor,
      );

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'full',
        documentsProcessed: totalDocuments,
        lineItemsProcessed: totalLineItems,
        syncLookbackSeconds: this.syncLookbackSeconds,
        duration: `${duration}s`,
      };
    } catch (error) {
      try {
        await this.failPaymentRefresh(
          'full', refreshInvoicePayments, paymentRefreshStartedAt, paymentDocumentsUpdated,
          lastPaymentCursor, previousPaymentStatus?.lastSuccessfulSync, error,
        );
      } catch { /* Preserve the original sync failure. */ }
      console.error('Full sync failed:', error);
      throw error;
    }
  }

  /**
   * Perform delta sync - fetch only modified documents
   */
  private async deltaSync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const state = (await this.cache.getCacheState())!;
    let documentsUpdated = 0;
    const documentsDeleted = 0;
    let lineItemsUpdated = 0;
    let paymentDocumentsUpdated = 0;
    let lastPaymentCursor: string | null = null;
    const paymentRefreshStartedAt = nowInSeconds();
    const previousPaymentStatus = await this.cache.getPaymentSyncStatus();
    const refreshInvoicePayments = isPaymentSyncInitialized(previousPaymentStatus);

    try {
      const lastSyncTime = Math.max(0, state.lastSync - this.syncLookbackSeconds);
      const contexts = [DocumentContextId.Estimate, DocumentContextId.Invoice, DocumentContextId.PurchaseOrder];

      for (const contextId of contexts) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          let response: DocumentListResponse;
          try {
            response = await this.client.documents.list({
              contextId,
              modifiedSince: lastSyncTime,
              page,
              pageLimit: 50,
            });
          } catch (error: any) {
            // 404 means we've reached the end of available pages
            if (error?.response?.status === 404) {
              hasMore = false;
              break;
            }
            // Re-throw other errors
            throw error;
          }

          const documents = this.flattenDocumentArray(response?.documents);
          if (!documents || documents.length === 0) {
            hasMore = false;
            break;
          }

          for (const doc of documents) {
            try {
              let fullDoc = doc;
              
              // Only fetch individual document if line items are missing
              if (this.shouldFetchDocumentDetail(doc, refreshInvoicePayments)) {
                fullDoc = await this.client.documents.get(doc.id);
                await delay(PAYMENT_DETAIL_DELAY_MS);
              }
              
              const { docRow, itemRows } = this.processDocument(fullDoc);

              const { resolvedDocId, savedItems } = await this.writeDocument(docRow, itemRows);
              const savedPayments = await this.writeInvoicePayments(fullDoc, resolvedDocId, refreshInvoicePayments);

              documentsUpdated++;
              lineItemsUpdated += savedItems;
              if (savedPayments !== null) {
                paymentDocumentsUpdated++;
                lastPaymentCursor = resolvedDocId;
              }

              if (options.onProgress) {
                options.onProgress(documentsUpdated, -1);
              }
            } catch (error) {
              console.error(
                `Failed to sync document ${doc.id}:`,
                error instanceof Error ? error.message : error,
              );
              throw error;
            }
          }

          page++;
          await delay(500);
        }
      }

      // Update cache state
      const updatedState: CacheState = {
        ...state,
        lastSync: this.indexerOptions.deferGlobalWatermark === true
          ? state.lastSync
          : nowInSeconds(),
        documentCount: await this.cache.getDocumentCount(),
        itemDocumentCount: await this.cache.getItemDocumentCount(),
      };
      await this.cache.setCacheState(updatedState);
      await this.finalizePaymentRefresh(
        'delta', refreshInvoicePayments, paymentRefreshStartedAt, paymentDocumentsUpdated, lastPaymentCursor,
      );

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'delta',
        documentsProcessed: documentsUpdated,
        documentsDeleted,
        lineItemsProcessed: lineItemsUpdated,
        syncLookbackSeconds: this.syncLookbackSeconds,
        duration: `${duration}s`,
      };
    } catch (error) {
      try {
        await this.failPaymentRefresh(
          'delta', refreshInvoicePayments, paymentRefreshStartedAt, paymentDocumentsUpdated,
          lastPaymentCursor, previousPaymentStatus?.lastSuccessfulSync, error,
        );
      } catch { /* Preserve the original sync failure. */ }
      console.error('Delta sync failed:', error);
      throw error;
    }
  }

  /**
   * Remove characters PostgreSQL text columns cannot store.
   *
   * SalesBinder API can return literal NUL bytes inside free-text fields
   * (seen in estimate 31723 / document 5bf132ca-4cee-4f0b-8cab-5dd9a6435d96).
   * PostgreSQL rejects those strings with:
   *   invalid byte sequence for encoding "UTF8": 0x00
   * Sanitizing only cache rows keeps source data untouched while allowing sync
   * to complete.
   */
  private sanitizeText(value: string | null | undefined): string | null {
    if (value == null) return null;
    return value.replaceAll(String.fromCharCode(0), '');
  }

  /**
   * Process a document into database rows
   */
  private processDocument(doc: Document): {
    docRow: DocumentRow;
    itemRows: Omit<ItemDocumentRow, 'id'>[];
  } {
    // Normalize issue_date to YYYY-MM-DD format for consistent querying
    const issueDate = doc.issue_date ? doc.issue_date.split('T')[0] : doc.issue_date;
    const accountContextId = doc.context_id === DocumentContextId.PurchaseOrder ? 10 : 2;
    const accountName = doc.customer?.name ?? null;
    const salespersonName = doc.user?.name
      ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ')
      ?? null;
    const statusName = doc.status?.name ?? null;
    
    const docRow: DocumentRow = {
      doc_id: doc.id,
      context_id: doc.context_id,
      doc_number: doc.document_number,
      issue_date: issueDate,
      customer_id: doc.customer_id,
      api_doc_id: doc.id,
      cache_source: 'api',
      document_name: this.sanitizeText(doc.name),
      account_id: doc.customer_id,
      account_context_id: accountContextId,
      account_name: this.sanitizeText(accountName),
      account_number: doc.customer?.customer_number ?? null,
      user_id: doc.user_id,
      salesperson_name: this.sanitizeText(salespersonName || null),
      customer_name: doc.context_id === DocumentContextId.PurchaseOrder ? null : this.sanitizeText(accountName),
      customer_number: doc.context_id === DocumentContextId.PurchaseOrder ? null : doc.customer?.customer_number ?? null,
      supplier_name: doc.context_id === DocumentContextId.PurchaseOrder ? this.sanitizeText(accountName) : null,
      supplier_number: doc.context_id === DocumentContextId.PurchaseOrder ? doc.customer?.customer_number ?? null : null,
      status_id: doc.status_id,
      status_name: this.sanitizeText(statusName),
      total_price: doc.total_price,
      total_cost: doc.total_cost,
      subtotal: doc.total_price,
      date_sent: doc.date_sent ?? null,
      shipped_percent: doc.shipped_percent ?? null,
      is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
      archived: doc.archived == null ? null : doc.archived ? 1 : 0,
      modified: Math.floor(new Date(doc.modified).getTime() / 1000),
    };

    const itemRows: Omit<ItemDocumentRow, 'id'>[] = (doc.document_items || [])
      .filter((item) => item.item_id)
      .map((item) => ({
        item_id: item.item_id!,
        doc_id: doc.id,
        document_item_id: item.id,
        quantity: item.quantity,
        price: item.price,
        item_name: this.sanitizeText(item.name ?? item.description ?? null),
        line_description: this.sanitizeText(item.description),
        quantity_received: item.quantity_partially_received ?? null,
        quantity_shipped: item.quantity_partially_shipped ?? null,
        cost: item.cost ?? null,
        total_amount: item.quantity * item.price,
        discounted_price: item.discounted_price ?? null,
        discount_percent: item.discount_percent ?? null,
      }));

    return { docRow, itemRows };
  }

  private async writeDocument(
    docRow: DocumentRow,
    itemRows: Omit<ItemDocumentRow, 'id'>[],
  ): Promise<{ resolvedDocId: string; savedItems: number }> {
    const existingByApiId = docRow.api_doc_id ? await this.cache.getDocumentByApiId(docRow.api_doc_id) : undefined;
    const existingByNumber = await this.cache.getDocumentByNumber(docRow.context_id, docRow.doc_number);
    const existing = existingByApiId ?? existingByNumber;
    const resolvedDocId = existing?.doc_id ?? docRow.doc_id;
    const resolvedDoc = { ...docRow, doc_id: resolvedDocId };
    const resolvedItems = itemRows.map((item) => ({ ...item, doc_id: resolvedDocId }));

    await this.cache.deleteItemDocuments(resolvedDocId);
    await this.cache.insertDocument(resolvedDoc);
    await this.cache.batchInsertItemDocuments(resolvedItems);
    return { resolvedDocId, savedItems: resolvedItems.length };
  }

  private shouldFetchInvoicePayments(doc: Pick<Document, 'context_id'>, refreshInvoicePayments: boolean): boolean {
    return refreshInvoicePayments && doc.context_id === DocumentContextId.Invoice;
  }

  private shouldFetchDocumentDetail(doc: Pick<Document, 'context_id' | 'document_items'>, refreshInvoicePayments: boolean): boolean {
    if (!doc.document_items || doc.document_items.length === 0) {
      return true;
    }

    return refreshInvoicePayments && doc.context_id === DocumentContextId.Invoice;
  }

  private async writeInvoicePayments(
    doc: Document,
    resolvedDocId: string,
    refreshInvoicePayments: boolean,
  ): Promise<number | null> {
    if (!this.shouldFetchInvoicePayments(doc, refreshInvoicePayments)) {
      return null;
    }

    const rows = normalizeDocumentPaymentTransactions(doc, resolvedDocId, nowInSeconds());
    await this.cache.replacePaymentTransactions(resolvedDocId, rows);
    return rows.length;
  }

  private async finalizePaymentRefresh(
    mode: PaymentSyncMode,
    refreshInvoicePayments: boolean,
    startedAt: number,
    processedDocuments: number,
    cursor: string | null,
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
    error: unknown,
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
      error: sanitizePaymentSyncError(error),
    });
  }

  /**
   * Flatten nested document array from API response
   */
  private flattenDocumentArray(documents?: Document[][]): Document[] {
    if (!documents) return [];
    return Array.isArray(documents[0]) ? documents.flat() : documents as unknown as Document[];
  }
}
