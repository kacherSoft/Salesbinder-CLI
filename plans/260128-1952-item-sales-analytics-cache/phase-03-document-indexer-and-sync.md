# Phase 03: Document Indexer and Sync

**Priority:** P2
**Status:** pending
**Effort:** 3h
**Dependencies:** Phase 02 complete

## Overview

Implement document indexing service that syncs data from SalesBinder API to local SQLite cache. Supports initial full sync, incremental delta sync, and handles document deletions.

## Context Links

- Parent plan: [plan.md](./plan.md)
- Previous phase: [phase-02-sqlite-cache-infrastructure.md](./phase-02-sqlite-cache-infrastructure.md)
- Sync strategy: [plan.md#sync-strategy](./plan.md#sync-strategy)

## Requirements

### Functional
- Initial full sync fetching all documents (context=4,5,11)
- Incremental sync using modifiedSince API parameter
- Handle document deletions via deleted-log API
- Progress reporting for long-running syncs
- Automatic sync when cache stale (>1 hour)

### Non-Functional
- Rate limiting and retry logic for API calls
- Idempotent sync operations (safe to re-run)
- Graceful error recovery and rollback
- Progress indicators for large syncs

## Architecture

```
DocumentIndexerService
├── Sync Orchestration
│   ├── Full sync (all documents)
│   ├── Delta sync (modified since last sync)
│   └── Deletion sync (removed documents)
├── API Integration
│   ├── Fetch documents with pagination
│   ├── Fetch document items (line items)
│   ├── Fetch deleted documents log
│   └── Rate limiting
├── Data Transformation
│   ├── Map API responses to DB rows
│   ├── Extract item_documents from document_items
│   └── Calculate timestamps
└── Cache State Management
    ├── Track last sync time
    ├── Track document counts
    └── Update cache metadata
```

## Related Code Files

### New Files
- `packages/sdk/src/cache/document-indexer.service.ts` - Sync service

### Dependencies
- `packages/sdk/src/cache/sqlite-cache.service.ts` - Cache operations (Phase 02)
- `packages/sdk/src/resources/documents.resource.ts` - API client
- `packages/sdk/src/cache/types.ts` - Type definitions (Phase 01)

## Implementation Steps

1. **Create DocumentIndexerService class**
   - Constructor: SDK client, cache service, account name
   - Initialize sync state from cache metadata

2. **Implement full sync**
   - Check if initial sync needed
   - Fetch documents by context (4, 5, 11) with pagination
   - For each document, fetch line items
   - Batch insert to cache using transactions
   - Update cache state with sync timestamp

3. **Implement delta sync**
   - Get last sync time from cache state
   - Fetch documents modified since timestamp
   - Update changed documents in cache
   - Fetch and process deleted documents log
   - Remove deleted documents from cache

4. **Implement document processing**
   - Transform Document API response to DocumentRow
   - Extract document_items to ItemDocumentRow
   - Handle both insert and update scenarios
   - Maintain referential integrity

5. **Implement deletion handling**
   - Poll deleted-log API endpoint
   - Remove deleted documents from cache
   - Cascade delete to item_documents
   - Update document counts

6. **Add progress reporting**
   - Callback for progress updates (current/total)
   - Report documents fetched
   - Report line items processed
   - Calculate sync percentage

## Implementation Details

### Service Skeleton

```typescript
export class DocumentIndexerService {
  constructor(
    private client: SalesBinderClient,
    private cache: SQLiteCacheService,
    private readonly accountName: string
  ) {}

  /**
   * Perform sync (full or delta based on options)
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
   * Check if cache is stale (older than 1 hour)
   */
  isCacheStale(): boolean {
    const state = this.cache.getCacheState();
    if (!state) return true;
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    return state.lastSync < oneHourAgo;
  }
}
```

### Full Sync Implementation

```typescript
private async fullSync(options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  let totalDocuments = 0;
  let totalLineItems = 0;

  try {
    // Sync each document context
    const contexts = [4, 5, 11]; // Estimate, Invoice, PO
    const contextNames = ['Estimate', 'Invoice', 'Purchase Order'];

    for (let i = 0; i < contexts.length; i++) {
      const contextId = contexts[i];
      const contextName = contextNames[i];

      console.error(`Syncing ${contextName}s...`);

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.documents.list({
          contextId,
          page,
          pageLimit: 50
        });

        const documents = this.flattenDocumentArray(response.documents);
        if (documents.length === 0) {
          hasMore = false;
          break;
        }

        // Process documents in batches
        for (const doc of documents) {
          // Fetch full document with line items
          const fullDoc = await this.client.documents.get(doc.id);

          // Transform to DB rows
          const docRow: DocumentRow = {
            doc_id: fullDoc.id,
            context_id: fullDoc.context_id,
            doc_number: fullDoc.document_number,
            issue_date: fullDoc.issue_date,
            customer_id: fullDoc.customer_id,
            modified: Math.floor(new Date(fullDoc.modified).getTime() / 1000)
          };

          // Extract line items
          const itemRows: ItemDocumentRow[] = (fullDoc.document_items || []).map((item, idx) => ({
            id: idx + 1, // Temporary ID, will be auto-generated
            item_id: item.item_id || '',
            doc_id: fullDoc.id,
            quantity: item.quantity,
            price: item.price
          }));

          // Insert to cache
          this.cache.insertDocument(docRow);
          this.cache.batchInsertItemDocuments(itemRows);

          totalDocuments++;
          totalLineItems += itemRows.length;

          // Progress callback
          if (options.onProgress) {
            options.onProgress(totalDocuments, -1); // Unknown total
          }
        }

        page++;

        // Rate limiting: respect SalesBinder API limits
        if (page % 10 === 0) {
          await this.delay(1000); // 1 second pause every 10 pages
        }
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
      schemaVersion: 1
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      success: true,
      type: 'full',
      documentsProcessed: totalDocuments,
      lineItemsProcessed: totalLineItems,
      duration: `${duration}s`
    };

  } catch (error) {
    console.error('Full sync failed:', error);
    throw error;
  }
}
```

### Delta Sync Implementation

```typescript
private async deltaSync(options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const state = this.cache.getCacheState()!;
  let documentsUpdated = 0;
  let documentsDeleted = 0;
  let lineItemsUpdated = 0;

  try {
    const lastSyncTime = state.lastSync;

    // Fetch modified documents
    const contexts = [4, 5, 11];

    for (const contextId of contexts) {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.documents.list({
          contextId,
          modifiedSince: lastSyncTime,
          page,
          pageLimit: 50
        });

        const documents = this.flattenDocumentArray(response.documents);
        if (documents.length === 0) {
          hasMore = false;
          break;
        }

        for (const doc of documents) {
          // Fetch full document
          const fullDoc = await this.client.documents.get(doc.id);

          // Update in cache
          const docRow: DocumentRow = {
            doc_id: fullDoc.id,
            context_id: fullDoc.context_id,
            doc_number: fullDoc.document_number,
            issue_date: fullDoc.issue_date,
            customer_id: fullDoc.customer_id,
            modified: Math.floor(new Date(fullDoc.modified).getTime() / 1000)
          };

          // Delete existing line items and re-insert
          this.cache.deleteItemDocuments(fullDoc.id);

          const itemRows: ItemDocumentRow[] = (fullDoc.document_items || []).map((item, idx) => ({
            id: idx + 1,
            item_id: item.item_id || '',
            doc_id: fullDoc.id,
            quantity: item.quantity,
            price: item.price
          }));

          this.cache.insertDocument(docRow);
          this.cache.batchInsertItemDocuments(itemRows);

          documentsUpdated++;
          lineItemsUpdated += itemRows.length;

          if (options.onProgress) {
            options.onProgress(documentsUpdated, -1);
          }
        }

        page++;
      }
    }

    // Handle deletions
    documentsDeleted = await this.syncDeletions();

    // Update cache state
    const now = Math.floor(Date.now() / 1000);
    state.lastSync = now;
    state.documentCount += documentsUpdated - documentsDeleted;
    state.itemDocumentCount += lineItemsUpdated;
    this.cache.setCacheState(state);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      success: true,
      type: 'delta',
      documentsProcessed: documentsUpdated,
      documentsDeleted,
      lineItemsProcessed: lineItemsUpdated,
      duration: `${duration}s`
    };

  } catch (error) {
    console.error('Delta sync failed:', error);
    throw error;
  }
}
```

### Deletion Handling

```typescript
/**
 * Sync deleted documents from deleted-log API
 * Note: SalesBinder API may not have this endpoint, implement as available
 */
private async syncDeletions(): Promise<number> {
  let deletedCount = 0;

  try {
    // TODO: Check if SalesBinder API has deleted-log endpoint
    // For now, implement basic logic assuming endpoint exists

    // Pseudo-code:
    // const deletedLog = await this.client.documents.getDeletedLog(state.lastSync);
    // for (const docId of deletedLog.deleted_document_ids) {
    //   this.cache.deleteDocument(docId);
    //   deletedCount++;
    // }

    // If no deleted-log API, alternative approaches:
    // 1. Compare cached document IDs with current API list
    // 2. Use document status field if available
    // 3. Skip deletion sync for MVP

  } catch (error) {
    console.warn('Deletion sync failed, continuing...', error);
  }

  return deletedCount;
}
```

### Helper Methods

```typescript
/**
 * Flatten nested document array from API response
 * API returns documents in nested arrays [[doc1, doc2], [doc3, doc4]]
 */
private flattenDocumentArray(documents?: any[][]): Document[] {
  if (!documents) return [];
  return documents.flat();
}

/**
 * Delay for rate limiting
 */
private delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sync result interface
 */
interface SyncResult {
  success: boolean;
  type: 'full' | 'delta';
  documentsProcessed: number;
  documentsDeleted?: number;
  lineItemsProcessed: number;
  duration: string;
}
```

## Todo List

- [ ] Create DocumentIndexerService class
- [ ] Implement full sync with pagination
- [ ] Implement delta sync with modifiedSince
- [ ] Implement deletion sync
- [ ] Add progress reporting callbacks
- [ ] Implement flattenDocumentArray helper
- [ ] Add rate limiting delays
- [ ] Add error handling and recovery
- [ ] Update cache state after sync
- [ ] Implement isCacheStale check
- [ ] Test with real API (small dataset)
- [ ] Test multi-account isolation

## Success Criteria

- [ ] Full sync completes successfully for all document types
- [ ] Delta sync only fetches modified documents
- [ ] Progress reporting works for large syncs
- [ ] Cache state updated correctly
- [ ] Rate limiting prevents API throttling
- [ ] Errors handled gracefully with rollback
- [ ] Multi-account isolation maintained
- [ ] Sync can be interrupted and resumed

## Risk Assessment

**Risk:** API rate limiting during full sync
**Mitigation:** Implement delays, batch processing, respect rate limits

**Risk:** Network interruption during sync
**Mitigation:** Transactional batch inserts, cache state updated on completion

**Risk:** Memory exhaustion with large datasets
**Mitigation:** Stream processing, batch inserts, don't load all data in memory

**Risk:** Deleted documents not detected
**Mitigation:** Implement deletion polling or full reconciliation periodically

## Security Considerations

- API credentials already secured in config
- No sensitive data in cache filenames
- Validate API responses before storing
- Handle malicious document IDs (SQL injection prevented by prepared statements)

## Next Steps

After completion, proceed to [Phase 04: Analytics Commands](./phase-04-analytics-commands.md)
