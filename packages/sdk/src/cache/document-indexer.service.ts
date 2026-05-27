/**
 * Document indexer service for syncing documents from API to cache
 */

import type { SalesBinderClient } from '../resources/index.js';
import type { CacheService } from './cache.interface.js';
import type { DocumentRow, ItemDocumentRow, SyncOptions, SyncResult, CacheState } from './types.js';
import { DocumentContextId } from './types.js';
import type { Document, DocumentListResponse } from '../types/documents.types.js';

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
    syncLookbackSeconds?: number
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
    let totalDocuments = 0;
    let totalLineItems = 0;

    try {
      const contexts = [
        { id: DocumentContextId.Estimate, name: 'Estimate' },
        { id: DocumentContextId.Invoice, name: 'Invoice' },
        { id: DocumentContextId.PurchaseOrder, name: 'Purchase Order' },
      ];

      for (const context of contexts) {
        console.error(`Syncing ${context.name}s...`);

        let page = 1;
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
          for (const doc of documents) {
            try {
              let fullDoc = doc;
              
              // Only fetch individual document if line items are missing
              if (!doc.document_items || doc.document_items.length === 0) {
                fullDoc = await this.client.documents.get(doc.id);
                // Add small delay after individual fetch to avoid rate limits
                await this.delay(200);
              }

              // Process document
              const { docRow, itemRows } = this.processDocument(fullDoc);

              const savedItems = await this.writeDocument(docRow, itemRows);

              totalDocuments++;
              totalLineItems += savedItems;

              if (options.onProgress) {
                options.onProgress(totalDocuments, -1);
              }
            } catch (error: any) {
              const isRateLimit = error?.response?.status === 429;
              if (!isRateLimit) {
                console.error(`Failed to fetch document ${doc.id}:`, error?.message || error);
              }
            }
          }

          page++;

          // Rate limiting: pause between pages to avoid rate limits
          await this.delay(500);
        }
      }

      // Update cache state
      const now = Math.floor(Date.now() / 1000);
      await this.cache.setCacheState({
        lastSync: now,
        lastFullSync: now,
        documentCount: totalDocuments,
        itemDocumentCount: totalLineItems,
        accountName: this.accountName,
        schemaVersion: 2,
      });

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
              if (!doc.document_items || doc.document_items.length === 0) {
                fullDoc = await this.client.documents.get(doc.id);
                await this.delay(200);
              }
              
              const { docRow, itemRows } = this.processDocument(fullDoc);

              const savedItems = await this.writeDocument(docRow, itemRows);

              documentsUpdated++;
              lineItemsUpdated += savedItems;

              if (options.onProgress) {
                options.onProgress(documentsUpdated, -1);
              }
            } catch (error: any) {
              const isRateLimit = error?.response?.status === 429;
              if (!isRateLimit) {
                console.error(`Failed to fetch document ${doc.id}:`, error?.message || error);
              }
            }
          }

          page++;
          await this.delay(500);
        }
      }

      // Update cache state
      const now = Math.floor(Date.now() / 1000);
      const updatedState: CacheState = {
        ...state,
        lastSync: now,
        documentCount: await this.cache.getDocumentCount(),
        itemDocumentCount: await this.cache.getItemDocumentCount(),
      };
      await this.cache.setCacheState(updatedState);

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
      console.error('Delta sync failed:', error);
      throw error;
    }
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
      total_price: doc.total_price,
      total_cost: doc.total_cost,
      subtotal: doc.total_price,
      is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
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
        item_name: item.name ?? item.description ?? null,
        line_description: item.description ?? null,
        quantity_received: item.quantity_partially_received ?? null,
        cost: item.cost ?? null,
        total_amount: item.quantity * item.price,
        discounted_price: item.discounted_price ?? null,
        discount_percent: item.discount_percent ?? null,
      }));

    return { docRow, itemRows };
  }

  private async writeDocument(docRow: DocumentRow, itemRows: Omit<ItemDocumentRow, 'id'>[]): Promise<number> {
    const existingByApiId = docRow.api_doc_id ? await this.cache.getDocumentByApiId(docRow.api_doc_id) : undefined;
    const existingByNumber = await this.cache.getDocumentByNumber(docRow.context_id, docRow.doc_number);
    const existing = existingByApiId ?? existingByNumber;
    const resolvedDocId = existing?.doc_id ?? docRow.doc_id;
    const resolvedDoc = { ...docRow, doc_id: resolvedDocId };
    const resolvedItems = itemRows.map((item) => ({ ...item, doc_id: resolvedDocId }));

    await this.cache.deleteItemDocuments(resolvedDocId);
    await this.cache.insertDocument(resolvedDoc);
    await this.cache.batchInsertItemDocuments(resolvedItems);
    return resolvedItems.length;
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
