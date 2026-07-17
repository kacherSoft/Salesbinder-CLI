/**
 * Document indexer service for syncing documents from API to cache
 */

import type { SalesBinderClient } from '../resources/index.js';
import type { CacheService } from './cache.interface.js';
import type {
  DocumentNonItemLineRow,
  DocumentRow,
  DocumentSnapshot,
  DocumentSyncCheckpoint,
  ItemDocumentRow,
  SyncOptions,
  SyncResult,
} from './types.js';
import { CACHE_SCHEMA_VERSION, DocumentContextId } from './types.js';
import type { Document, DocumentListResponse } from '../types/documents.types.js';

/**
 * Document indexer service for syncing API data to cache
 */
export class DocumentIndexerService {
  private readonly staleThreshold: number;
  private readonly syncLookbackSeconds: number;
  private readonly detailRequestIntervalMs: number;
  private nextDetailRequestAt = 0;

  constructor(
    private client: SalesBinderClient,
    private cache: CacheService,
    private readonly accountName: string,
    staleThresholdSeconds?: number,
    syncLookbackSeconds?: number,
    detailRequestsPerSecond = 0.75
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
    const detailRate = Number.isFinite(detailRequestsPerSecond) && detailRequestsPerSecond > 0
      ? detailRequestsPerSecond
      : 0.75;
    this.detailRequestIntervalMs = Math.ceil(1000 / detailRate);
  }

  /**
   * Perform sync (full or delta based on options and cache state)
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const state = await this.cache.getCacheState();
    const pendingSyncType = state?.documentSyncCheckpoint?.accountName === this.accountName
      ? state.documentSyncCheckpoint.syncType
      : undefined;
    const needsInitialSync = !state
      || state.accountName !== this.accountName
      || state.schemaVersion !== CACHE_SCHEMA_VERSION
      || !state.lastDocumentSync;

    if (options.full || pendingSyncType === 'full' || (!pendingSyncType && needsInitialSync)) {
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
    if (!state?.lastDocumentSync) return true;
    const staleTime = Math.floor(Date.now() / 1000) - this.staleThreshold;
    return state.lastDocumentSync < staleTime;
  }

  /**
   * Perform full sync - fetch all documents
   */
  private async fullSync(options: SyncOptions): Promise<SyncResult> {
    return this.runSync('full', options);
  }

  /**
   * Perform delta sync - fetch only modified documents
   */
  private async deltaSync(options: SyncOptions): Promise<SyncResult> {
    return this.runSync('delta', options);
  }

  private async runSync(type: 'full' | 'delta', options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const state = await this.cache.getCacheState();
    const resumable = state?.documentSyncCheckpoint?.accountName === this.accountName
      && state.documentSyncCheckpoint.syncType === type;
    const sourceModifiedSince = type === 'full'
      ? 0
      : Math.max(0, (state?.lastDocumentSync ?? 0) - this.syncLookbackSeconds);
    const checkpoint: DocumentSyncCheckpoint = resumable
      ? {
          ...state!.documentSyncCheckpoint!,
          phase: state!.documentSyncCheckpoint!.phase ?? 'primary',
          retryDocumentIds: [...state!.documentSyncCheckpoint!.retryDocumentIds],
          retryDocumentIdentities: { ...state!.documentSyncCheckpoint!.retryDocumentIdentities },
        }
      : {
          accountName: this.accountName,
          syncType: type,
          phase: 'primary',
          startedAt: Math.floor(startTime / 1000),
          sourceModifiedSince,
          nextContextIndex: 0,
          nextPage: 1,
          retryDocumentIds: [],
          retryDocumentIdentities: {},
        };
    await this.persistCheckpoint(checkpoint);
    let documentsProcessed = 0;
    let documentsDeleted = 0;
    let lineItemsProcessed = 0;
    let nonItemLinesProcessed = 0;
    const retryDocumentIds = new Set(checkpoint.retryDocumentIds);
    const retryDocumentIdentities = new Map(
      Object.entries(checkpoint.retryDocumentIdentities ?? {})
        .filter(([documentId]) => retryDocumentIds.has(documentId))
    );
    const contexts = [
      { id: DocumentContextId.Estimate, name: 'Estimate' },
      { id: DocumentContextId.Invoice, name: 'Invoice' },
      { id: DocumentContextId.PurchaseOrder, name: 'Purchase Order' },
    ];

    try {
      let shouldRunAnotherPass = true;
      while (shouldRunAnotherPass) {
        shouldRunAnotherPass = false;
        const pass = await this.traverseCheckpoint(
          checkpoint,
          contexts,
          type === 'full' && checkpoint.phase === 'primary',
          retryDocumentIds,
          retryDocumentIdentities,
          options
        );
        documentsProcessed += pass.documents;
        documentsDeleted += pass.documentsDeleted;
        lineItemsProcessed += pass.itemLines;
        nonItemLinesProcessed += pass.nonItemLines;

        const retried = await this.retryFailedDocuments(
          checkpoint,
          retryDocumentIds,
          retryDocumentIdentities,
          options
        );
        documentsProcessed += retried.documents;
        documentsDeleted += retried.documentsDeleted;
        lineItemsProcessed += retried.itemLines;
        nonItemLinesProcessed += retried.nonItemLines;

        if (retryDocumentIds.size > 0) break;
        if (type === 'full' && checkpoint.phase === 'primary') {
          checkpoint.phase = 'catch_up';
          checkpoint.sourceModifiedSince = Math.max(0, checkpoint.startedAt - 1);
          checkpoint.endWatermark = Math.floor(Date.now() / 1000);
          checkpoint.nextContextIndex = 0;
          checkpoint.nextPage = 1;
          checkpoint.retryDocumentIds = [];
          checkpoint.retryDocumentIdentities = {};
          retryDocumentIdentities.clear();
          await this.persistCheckpoint(checkpoint);
          shouldRunAnotherPass = true;
        }
      }

      const failedIds = [...retryDocumentIds];
      const success = failedIds.length === 0
        && (type === 'delta' || checkpoint.phase === 'catch_up');
      if (success) await this.commitSuccessfulState(type, checkpoint);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      return {
        success,
        type,
        documentsProcessed,
        documentsDeleted,
        lineItemsProcessed,
        nonItemLinesProcessed,
        failedDocuments: failedIds.length,
        retryDocumentIds: failedIds,
        syncLookbackSeconds: this.syncLookbackSeconds,
        duration: `${duration}s`,
      };
    } catch (error) {
      console.error(`${type === 'full' ? 'Full' : 'Delta'} sync failed:`, error);
      throw error;
    }
  }

  private async traverseCheckpoint(
    checkpoint: DocumentSyncCheckpoint,
    contexts: Array<{ id: DocumentContextId; name: string }>,
    useFullList: boolean,
    retryDocumentIds: Set<string>,
    retryDocumentIdentities: Map<string, { contextId: number; documentNumber: number }>,
    options: SyncOptions
  ): Promise<{ documents: number; documentsDeleted: number; itemLines: number; nonItemLines: number }> {
    let documents = 0;
    let documentsDeleted = 0;
    let itemLines = 0;
    let nonItemLines = 0;
    const seenDocumentIds = new Set<string>();

    for (let contextIndex = checkpoint.nextContextIndex; contextIndex < contexts.length; contextIndex++) {
      const context = contexts[contextIndex];
      console.error(`Syncing ${context.name}s${checkpoint.phase === 'catch_up' ? ' (catch-up)' : ''}...`);
      let page = contextIndex === checkpoint.nextContextIndex ? checkpoint.nextPage : 1;

      let shouldFetchPage = true;
      while (shouldFetchPage) {
        let response: DocumentListResponse;
        try {
          response = await this.client.documents.list({
            contextId: context.id,
            ...(useFullList ? {} : { modifiedSince: checkpoint.sourceModifiedSince }),
            page,
            pageLimit: 50,
          });
        } catch (error: any) {
          if (error?.response?.status === 404) {
            shouldFetchPage = false;
            continue;
          }
          throw error;
        }
        const listedDocuments = this.flattenDocumentArray(response?.documents);
        if (listedDocuments.length === 0) {
          shouldFetchPage = false;
          continue;
        }

        for (const document of listedDocuments) {
          if (seenDocumentIds.has(document.id)) continue;
          seenDocumentIds.add(document.id);
          try {
            const saved = await this.fetchAndReplaceDocument(document.id, {
              contextId: document.context_id,
              documentNumber: document.document_number,
            });
            retryDocumentIds.delete(document.id);
            retryDocumentIdentities.delete(document.id);
            documents++;
            if (saved.deleted) documentsDeleted++;
            itemLines += saved.itemLines;
            nonItemLines += saved.nonItemLines;
            options.onProgress?.(documents, -1);
          } catch (error: any) {
            retryDocumentIds.add(document.id);
            retryDocumentIdentities.set(document.id, {
              contextId: document.context_id,
              documentNumber: document.document_number,
            });
            console.error(`Failed to replace document ${document.id}:`, error?.message || error);
          }
        }

        page++;
        await this.updateCheckpoint(
          checkpoint,
          contextIndex,
          page,
          retryDocumentIds,
          retryDocumentIdentities
        );
        await this.delay(500);
      }
      await this.updateCheckpoint(
        checkpoint,
        contextIndex + 1,
        1,
        retryDocumentIds,
        retryDocumentIdentities
      );
    }
    return { documents, documentsDeleted, itemLines, nonItemLines };
  }

  private async retryFailedDocuments(
    checkpoint: DocumentSyncCheckpoint,
    retryDocumentIds: Set<string>,
    retryDocumentIdentities: Map<string, { contextId: number; documentNumber: number }>,
    options: SyncOptions
  ): Promise<{ documents: number; documentsDeleted: number; itemLines: number; nonItemLines: number }> {
    let documents = 0;
    let documentsDeleted = 0;
    let itemLines = 0;
    let nonItemLines = 0;
    for (const documentId of [...retryDocumentIds]) {
      try {
        const saved = await this.fetchAndReplaceDocument(
          documentId,
          retryDocumentIdentities.get(documentId)
        );
        retryDocumentIds.delete(documentId);
        retryDocumentIdentities.delete(documentId);
        documents++;
        if (saved.deleted) documentsDeleted++;
        itemLines += saved.itemLines;
        nonItemLines += saved.nonItemLines;
        options.onProgress?.(documents, -1);
      } catch (error: any) {
        console.error(`Retry failed for document ${documentId}:`, error?.message || error);
      }
    }
    checkpoint.retryDocumentIds = [...retryDocumentIds];
    checkpoint.retryDocumentIdentities = Object.fromEntries(retryDocumentIdentities);
    await this.persistCheckpoint(checkpoint);
    return { documents, documentsDeleted, itemLines, nonItemLines };
  }

  private async fetchAndReplaceDocument(
    documentId: string,
    listedIdentity?: { contextId: number; documentNumber: number }
  ): Promise<{ itemLines: number; nonItemLines: number; deleted: boolean }> {
    let sourceFetchedAt = Math.floor(Date.now() / 1000);
    let firstRequestStart = true;
    let fullDocument: Document;
    try {
      fullDocument = await this.client.documents.get(documentId, {
        beforeRequestStart: async () => {
          await this.waitForDetailRequestSlot();
          if (firstRequestStart) {
            sourceFetchedAt = Math.floor(Date.now() / 1000);
            firstRequestStart = false;
          }
        },
      });
    } catch (error: any) {
      if (!isNotFoundError(error)) throw error;
      const cachedByApiId = await this.cache.getDocumentByApiId(documentId);
      const cachedByNumber = !cachedByApiId && listedIdentity
        ? await this.cache.getDocumentByNumber(listedIdentity.contextId, listedIdentity.documentNumber)
        : undefined;
      await this.cache.deleteDocument(cachedByApiId?.doc_id ?? cachedByNumber?.doc_id ?? documentId);
      return { itemLines: 0, nonItemLines: 0, deleted: true };
    }
    if (fullDocument.id !== documentId) {
      throw new Error(`Document detail identity mismatch for ${documentId}`);
    }
    const snapshot = this.processDocument(fullDocument, sourceFetchedAt);
    await this.cache.replaceDocumentSnapshot(snapshot);
    return {
      itemLines: snapshot.itemLines.length,
      nonItemLines: snapshot.nonItemLines.length,
      deleted: false,
    };
  }

  private async commitSuccessfulState(
    type: 'full' | 'delta',
    checkpoint: DocumentSyncCheckpoint
  ): Promise<void> {
    const state = await this.cache.getCacheState();
    const safeWatermark = checkpoint.endWatermark ?? checkpoint.startedAt;
    await this.cache.setCacheState({
      ...state,
      lastSync: safeWatermark,
      lastFullSync: type === 'full' ? safeWatermark : state?.lastFullSync ?? 0,
      lastDocumentSync: safeWatermark,
      lastFullDocumentSync: type === 'full' ? safeWatermark : state?.lastFullDocumentSync,
      documentCount: await this.cache.getDocumentCount(),
      itemDocumentCount: await this.cache.getItemDocumentCount(),
      nonItemDocumentCount: await this.cache.getDocumentNonItemLineCount(),
      accountName: this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      documentSyncCheckpoint: undefined,
    });
  }

  private async updateCheckpoint(
    checkpoint: DocumentSyncCheckpoint,
    nextContextIndex: number,
    nextPage: number,
    retryDocumentIds: Set<string>,
    retryDocumentIdentities: Map<string, { contextId: number; documentNumber: number }>
  ): Promise<void> {
    checkpoint.nextContextIndex = nextContextIndex;
    checkpoint.nextPage = nextPage;
    checkpoint.retryDocumentIds = [...retryDocumentIds];
    checkpoint.retryDocumentIdentities = Object.fromEntries(retryDocumentIdentities);
    await this.persistCheckpoint(checkpoint);
  }

  private async persistCheckpoint(checkpoint: DocumentSyncCheckpoint): Promise<void> {
    const state = await this.cache.getCacheState();
    await this.cache.setCacheState({
      ...state,
      lastSync: state?.lastSync ?? 0,
      lastFullSync: state?.lastFullSync ?? 0,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      documentSyncCheckpoint: checkpoint,
    });
  }

  private async waitForDetailRequestSlot(): Promise<void> {
    const waitMs = Math.max(0, this.nextDetailRequestAt - Date.now());
    if (waitMs > 0) await this.delay(waitMs);
    this.nextDetailRequestAt = Date.now() + this.detailRequestIntervalMs;
  }

  /**
   * Process a document into database rows
   */
  private processDocument(doc: Document, sourceFetchedAt: number): DocumentSnapshot {
    if (!Array.isArray(doc.document_items)) {
      throw new Error(`Authoritative detail for document ${doc.id} omitted document_items`);
    }
    // Normalize issue_date to YYYY-MM-DD format for consistent querying
    const issueDate = doc.issue_date ? doc.issue_date.split('T')[0] : doc.issue_date;
    const accountContextId = doc.context_id === DocumentContextId.PurchaseOrder ? 10 : 2;
    const accountName = doc.customer?.name ?? null;
    const salespersonName = doc.user?.name
      ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ')
      ?? null;
    const statusName = doc.status?.name ?? null;
    const headerSubtotal = finiteDocumentNumber(doc.total_price, 'total_price', doc.id);
    const headerCogs = finiteDocumentNumber(doc.total_cost, 'total_cost', doc.id);
    
    const docRow: DocumentRow = {
      doc_id: doc.id,
      context_id: doc.context_id,
      doc_number: doc.document_number,
      issue_date: issueDate,
      customer_id: doc.customer_id,
      api_doc_id: doc.id,
      cache_source: 'api',
      document_name: doc.name ?? null,
      account_id: doc.customer_id,
      account_context_id: accountContextId,
      account_name: accountName,
      account_number: doc.customer?.customer_number ?? null,
      user_id: doc.user_id,
      salesperson_name: salespersonName || null,
      customer_name: doc.context_id === DocumentContextId.PurchaseOrder ? null : accountName,
      customer_number: doc.context_id === DocumentContextId.PurchaseOrder ? null : doc.customer?.customer_number ?? null,
      supplier_name: doc.context_id === DocumentContextId.PurchaseOrder ? accountName : null,
      supplier_number: doc.context_id === DocumentContextId.PurchaseOrder ? doc.customer?.customer_number ?? null : null,
      status_id: doc.status_id,
      status_name: statusName,
      total_price: headerSubtotal,
      total_cost: headerCogs,
      subtotal: headerSubtotal,
      date_sent: doc.date_sent,
      shipped_percent: doc.shipped_percent,
      source_fetched_at: sourceFetchedAt,
      snapshot_version: CACHE_SCHEMA_VERSION,
      snapshot_complete: 1,
      is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
      modified: Math.floor(new Date(doc.modified).getTime() / 1000),
    };
    if (!Number.isFinite(docRow.modified)) {
      throw new Error(`Document ${doc.id} has invalid modified timestamp`);
    }

    const sourceIds = new Set<string>();
    const itemLines: Omit<ItemDocumentRow, 'id'>[] = [];
    const nonItemLines: Omit<DocumentNonItemLineRow, 'id'>[] = [];
    for (const item of doc.document_items) {
      if (!item.id?.trim() || item.document_id !== doc.id) {
        throw new Error(`Document ${doc.id} contains a line with invalid source identity`);
      }
      if (sourceIds.has(item.id)) {
        throw new Error(`Document ${doc.id} contains duplicate source line ${item.id}`);
      }
      sourceIds.add(item.id);
      const quantity = finiteNumber(item.quantity, 'quantity', doc.id, item.id);
      const price = finiteNumber(item.price, 'price', doc.id, item.id);
      const discountPercent = finiteNumber(item.discount_percent ?? 0, 'discount_percent', doc.id, item.id);
      const totalAmount = quantity * price;

      if (item.item_id) {
        const cost = finiteNumber(item.cost, 'cost', doc.id, item.id);
        itemLines.push({
          item_id: item.item_id,
          doc_id: doc.id,
          document_item_id: item.id,
          quantity,
          price,
          item_name: item.name ?? item.description ?? null,
          line_description: item.description ?? null,
          quantity_received: item.quantity_partially_received ?? null,
          quantity_shipped: item.quantity_partially_shipped,
          cost,
          total_amount: totalAmount,
          discounted_price: item.discounted_price ?? null,
          discount_percent: discountPercent,
        });
        continue;
      }

      nonItemLines.push({
        doc_id: doc.id,
        document_item_id: item.id,
        line_type: 'non_item',
        name: item.name ?? null,
        line_description: item.description ?? null,
        service_category_id: item.service_category_id ?? null,
        unit_id: item.unit_id ?? null,
        quantity,
        price,
        cost: item.cost ?? null,
        total_amount: totalAmount,
        discounted_price: item.discounted_price ?? null,
        discount_percent: discountPercent,
        net_amount: totalAmount * (1 - discountPercent / 100),
        tax: item.tax ?? null,
        tax2: item.tax2 ?? null,
        weight: item.weight ?? null,
        source_created: item.created ?? null,
        source_modified: item.modified ?? null,
        raw_classification: JSON.stringify({
          has_item_id: false,
          source_name: item.name ?? null,
          service_category_id: item.service_category_id ?? null,
          unit_id: item.unit_id ?? null,
          item_variations_location_id: item.item_variations_location_id ?? null,
          item_variation_data: item.item_variation_data ?? null,
        }),
      });
    }

    return { document: docRow, itemLines, nonItemLines, sourceFetchedAt };
  }

  /**
   * Flatten nested document array from API response
   */
  private flattenDocumentArray(documents?: Document[][]): Document[] {
    if (!documents) return [];
    return Array.isArray(documents[0]) ? documents.flat() : documents as unknown as Document[];
  }

  /**
   * Delay for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function finiteNumber(value: unknown, field: string, docId: string, lineId: string): number {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Document ${docId} line ${lineId} omitted ${field}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Document ${docId} line ${lineId} has invalid ${field}`);
  }
  return numeric;
}

function finiteDocumentNumber(value: unknown, field: string, docId: string): number {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Document ${docId} omitted ${field}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Document ${docId} has invalid ${field}`);
  return numeric;
}

function isNotFoundError(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}
