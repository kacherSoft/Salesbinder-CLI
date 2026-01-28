/**
 * Document indexer service for syncing documents from API to cache
 */

import type { SalesBinderClient } from '../resources/index.js';
import type { SQLiteCacheService } from './sqlite-cache.service.js';
import type { DocumentRow, ItemDocumentRow, SyncOptions, SyncResult, CacheState } from './types.js';
import { DocumentContextId } from './types.js';
import type { Document, DocumentListResponse } from '../types/documents.types.js';

/**
 * Document indexer service for syncing API data to SQLite cache
 */
export class DocumentIndexerService {
  private readonly staleThreshold: number;

  constructor(
    private client: SalesBinderClient,
    private cache: SQLiteCacheService,
    private readonly accountName: string,
    staleThresholdSeconds?: number
  ) {
    // Priority: env var > config parameter > default (3600s = 1 hour)
    const envValue = process.env.SALESBINDER_CACHE_STALE_SECONDS;
    this.staleThreshold = envValue
      ? parseInt(envValue, 10)
      : (staleThresholdSeconds ?? 3600);
  }

  /**
   * Perform sync (full or delta based on options and cache state)
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const state = this.cache.getCacheState();
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
  isCacheStale(): boolean {
    const state = this.cache.getCacheState();
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

              // Delete existing item documents and insert new ones
              this.cache.deleteItemDocuments(docRow.doc_id);
              this.cache.insertDocument(docRow);
              this.cache.batchInsertItemDocuments(itemRows);

              totalDocuments++;
              totalLineItems += itemRows.length;

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
      this.cache.setCacheState({
        lastSync: now,
        lastFullSync: now,
        documentCount: totalDocuments,
        itemDocumentCount: totalLineItems,
        accountName: this.accountName,
        schemaVersion: 1,
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'full',
        documentsProcessed: totalDocuments,
        lineItemsProcessed: totalLineItems,
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
    const state = this.cache.getCacheState()!;
    let documentsUpdated = 0;
    let documentsDeleted = 0;
    let lineItemsUpdated = 0;

    try {
      const lastSyncTime = state.lastSync;
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

              // Delete existing and re-insert
              this.cache.deleteItemDocuments(docRow.doc_id);
              this.cache.insertDocument(docRow);
              this.cache.batchInsertItemDocuments(itemRows);

              documentsUpdated++;
              lineItemsUpdated += itemRows.length;

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

      // Handle deletions (if API supports it)
      documentsDeleted = await this.syncDeletions();

      // Update cache state
      const now = Math.floor(Date.now() / 1000);
      const updatedState: CacheState = {
        ...state,
        lastSync: now,
        documentCount: this.cache.getDocumentCount(),
        itemDocumentCount: this.cache.getItemDocumentCount(),
      };
      this.cache.setCacheState(updatedState);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        type: 'delta',
        documentsProcessed: documentsUpdated,
        documentsDeleted,
        lineItemsProcessed: lineItemsUpdated,
        duration: `${duration}s`,
      };
    } catch (error) {
      console.error('Delta sync failed:', error);
      throw error;
    }
  }

  /**
   * Sync deleted documents
   * Note: Implement when SalesBinder API provides deleted-log endpoint
   */
  private async syncDeletions(): Promise<number> {
    // SalesBinder API may not have a deleted-log endpoint
    // For now, skip deletion sync
    // Future: implement reconciliation or deleted-log polling
    return 0;
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
    
    const docRow: DocumentRow = {
      doc_id: doc.id,
      context_id: doc.context_id,
      doc_number: doc.document_number,
      issue_date: issueDate,
      customer_id: doc.customer_id,
      modified: Math.floor(new Date(doc.modified).getTime() / 1000),
    };

    const itemRows: Omit<ItemDocumentRow, 'id'>[] = (doc.document_items || [])
      .filter((item) => item.item_id)
      .map((item) => ({
        item_id: item.item_id!,
        doc_id: doc.id,
        quantity: item.quantity,
        price: item.price,
      }));

    return { docRow, itemRows };
  }

  /**
   * Flatten nested document array from API response
   */
  private flattenDocumentArray(documents?: Document[][]): Document[] {
    if (!documents) return [];
    return documents.flat();
  }

  /**
   * Delay for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
