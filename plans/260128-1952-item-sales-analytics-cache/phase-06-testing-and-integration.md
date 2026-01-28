# Phase 06: Testing and Integration

**Priority:** P2
**Status:** pending
**Effort:** 1h
**Dependencies:** All previous phases complete

## Overview

Write comprehensive tests for cache services and CLI commands. Update documentation with new features. Ensure integration with existing codebase is complete.

## Context Links

- Parent plan: [plan.md](./plan.md)
- All previous phases required

## Requirements

### Functional
- Unit tests for SQLiteCacheService
- Unit tests for DocumentIndexerService
- Integration tests for analytics command
- Test coverage >80%

### Non-Functional
- Tests run quickly
- Mock external dependencies (API, filesystem)
- Clear test documentation
- Update README with new commands

## Architecture

```
Test Structure
├── Unit Tests
│   ├── SQLiteCacheService
│   │   ├── Connection management
│   │   ├── CRUD operations
│   │   ├── Batch operations
│   │   └── Metadata operations
│   └── DocumentIndexerService
│       ├── Sync logic
│       ├── Delta sync
│       └── Progress reporting
└── Integration Tests
    ├── Analytics command
    ├── Cache commands
    └── End-to-end workflows
```

## Related Code Files

### New Files
- `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts`
- `packages/sdk/src/cache/__tests__/document-indexer.service.test.ts`
- `packages/cli/src/commands/analytics/__tests__/item-sales.command.test.ts`
- `packages/cli/src/commands/cache/__tests__/cache.commands.test.ts`

### Modified Files
- `README.md` - Document new commands
- `packages/sdk/src/index.ts` - Verify exports
- `packages/cli/src/index.ts` - Verify registration

## Implementation Steps

1. **Create test structure**
   - Create __tests__ directories
   - Setup test configuration
   - Create test fixtures

2. **Write SQLiteCacheService unit tests**
   - Test connection and schema creation
   - Test document CRUD operations
   - Test item_document CRUD operations
   - Test batch operations
   - Test metadata operations

3. **Write DocumentIndexerService unit tests**
   - Test sync logic with mocked API
   - Test delta sync
   - Test progress reporting
   - Test error handling

4. **Write integration tests**
   - Test analytics command end-to-end
   - Test cache commands
   - Test multi-account isolation

5. **Update documentation**
   - Add analytics section to README
   - Add cache management section
   - Update examples
   - Document performance expectations

6. **Run full test suite**
   - Ensure all tests pass
   - Check coverage >80%
   - Fix any failing tests

## Implementation Details

### SQLiteCacheService Tests

```typescript
// packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts

import Database from 'better-sqlite3';
import { SQLiteCacheService } from '../sqlite-cache.service.js';
import { DocumentContext } from '../types.js';
import { rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('SQLiteCacheService', () => {
  let service: SQLiteCacheService;
  const testAccount = 'test-account';
  const testCachePath = join(tmpdir(), `test-cache-${Date.now()}.db`);

  beforeEach(() => {
    // Create service with test database
    service = new SQLiteCacheService(testAccount, testCachePath);
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(testCachePath);
    } catch {
      // Ignore
    }
  });

  describe('Connection and Schema', () => {
    it('should create database file', () => {
      expect(existsSync(testCachePath)).toBe(true);
    });

    it('should initialize schema', () => {
      const tables = service.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as { name: string }[];

      expect(tables.map(t => t.name)).toContain('documents');
      expect(tables.map(t => t.name)).toContain('item_documents');
      expect(tables.map(t => t.name)).toContain('cache_meta');
    });
  });

  describe('Document CRUD', () => {
    it('should insert and retrieve document', () => {
      const doc: DocumentRow = {
        doc_id: 'test-doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1001,
        issue_date: '2026-01-28',
        customer_id: 'customer-1',
        modified: 1706457600
      };

      service.insertDocument(doc);
      const retrieved = service.getDocument('test-doc-1');

      expect(retrieved).toEqual(doc);
    });

    it('should update existing document', () => {
      const doc: DocumentRow = {
        doc_id: 'test-doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1001,
        issue_date: '2026-01-28',
        customer_id: 'customer-1',
        modified: 1706457600
      };

      service.insertDocument(doc);

      const updated = { ...doc, issue_date: '2026-01-29' };
      service.insertDocument(updated); // INSERT OR REPLACE

      const retrieved = service.getDocument('test-doc-1');
      expect(retrieved?.issue_date).toBe('2026-01-29');
    });

    it('should delete document', () => {
      const doc: DocumentRow = {
        doc_id: 'test-doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1001,
        issue_date: '2026-01-28',
        customer_id: 'customer-1',
        modified: 1706457600
      };

      service.insertDocument(doc);
      service.deleteDocument('test-doc-1');

      const retrieved = service.getDocument('test-doc-1');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('Item Document CRUD', () => {
    it('should insert and retrieve item documents', () => {
      const doc: DocumentRow = {
        doc_id: 'test-doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1001,
        issue_date: '2026-01-28',
        customer_id: 'customer-1',
        modified: 1706457600
      };

      service.insertDocument(doc);

      const item: ItemDocumentRow = {
        id: 1,
        item_id: 'item-1',
        doc_id: 'test-doc-1',
        quantity: 10,
        price: 29.99
      };

      service.insertItemDocument(item);
      const items = service.getItemDocuments('test-doc-1');

      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(item);
    });
  });

  describe('Analytics Queries', () => {
    it('should get latest item document date by context', () => {
      // Setup test data
      const doc1: DocumentRow = {
        doc_id: 'doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1,
        issue_date: '2026-01-15',
        customer_id: 'cust-1',
        modified: 1706457600
      };

      const doc2: DocumentRow = {
        doc_id: 'doc-2',
        context_id: DocumentContext.INVOICE,
        doc_number: 2,
        issue_date: '2026-01-20',
        customer_id: 'cust-1',
        modified: 1706457600
      };

      service.insertDocument(doc1);
      service.insertDocument(doc2);

      service.insertItemDocument({
        id: 1,
        item_id: 'item-1',
        doc_id: 'doc-1',
        quantity: 5,
        price: 10
      });

      service.insertItemDocument({
        id: 2,
        item_id: 'item-1',
        doc_id: 'doc-2',
        quantity: 3,
        price: 15
      });

      const latestDate = service.getLatestItemDocumentDate('item-1', DocumentContext.INVOICE);
      expect(latestDate).toBe('2026-01-20');
    });

    it('should get item documents for period', () => {
      const doc: DocumentRow = {
        doc_id: 'doc-1',
        context_id: DocumentContext.INVOICE,
        doc_number: 1,
        issue_date: '2026-01-15',
        customer_id: 'cust-1',
        modified: 1706457600
      };

      service.insertDocument(doc);

      service.insertItemDocument({
        id: 1,
        item_id: 'item-1',
        doc_id: 'doc-1',
        quantity: 10,
        price: 29.99
      });

      const items = service.getItemDocumentsForPeriod(
        'item-1',
        '2026-01-01',
        '2026-01-31',
        DocumentContext.INVOICE
      );

      expect(items).toHaveLength(1);
      expect(items[0].quantity).toBe(10);
    });
  });

  describe('Cache Metadata', () => {
    it('should save and retrieve cache state', () => {
      const state: CacheState = {
        lastSync: 1706457600,
        lastFullSync: 1706457600,
        documentCount: 100,
        itemDocumentCount: 500,
        accountName: 'test-account',
        schemaVersion: 1
      };

      service.setCacheState(state);
      const retrieved = service.getCacheState();

      expect(retrieved).toEqual(state);
    });

    it('should return null for missing state', () => {
      const state = service.getCacheState();
      expect(state).toBeNull();
    });
  });
});
```

### Documentation Updates

```markdown
# README.md additions

## Analytics

### Item Sales Analytics

Generate detailed sales analytics for any inventory item:

```bash
# Basic analytics
salesbinder analytics item-sales <item-id>

# Specific periods
salesbinder analytics item-sales <item-id> --months 12

# Force cache refresh
salesbinder analytics item-sales <item-id> --refresh

# Use cached data only (skip sync check)
salesbinder analytics item-sales <item-id> --cached
```

**Output includes:**
- Current stock quantity (real-time)
- Latest Order Confirmation date
- Latest Purchase Order date
- Sold quantities and revenue for 3/6/12 month periods
- Cache freshness information

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "current_stock": 150,
  "latest_oc_date": "2026-01-15",
  "latest_po_date": "2026-01-20",
  "sales_periods": {
    "3_months": { "sold": 45, "revenue": 1350.00 },
    "6_months": { "sold": 120, "revenue": 3600.00 },
    "12_months": { "sold": 280, "revenue": 8400.00 }
  },
  "cache_freshness": {
    "last_sync": "2026-01-28T20:00:00Z",
    "stale": false
  }
}
```

## Cache Management

### Sync Cache

Sync local cache with SalesBinder API:

```bash
# Incremental sync (fast)
salesbinder cache sync

# Full sync (re-download all documents)
salesbinder cache sync --full
```

**Performance:**
- First sync: 5-10 minutes (33K documents)
- Delta sync: <1 minute (changes only)
- Cached queries: <100ms

### Cache Status

Check cache status and statistics:

```bash
salesbinder cache status
```

**Output includes:**
- Cache file location and size
- Last sync time
- Document counts
- Freshness status (FRESH/STALE)

### Clear Cache

Delete local cache file:

```bash
salesbinder cache clear
```

**Note:** Next sync will perform a full resync.
```

## Todo List

- [ ] Create test directory structure
- [ ] Write SQLiteCacheService unit tests
- [ ] Write DocumentIndexerService unit tests
- [ ] Write analytics command integration tests
- [ ] Write cache command integration tests
- [ ] Test multi-account isolation
- [ ] Measure query performance (<100ms target)
- [ ] Update README with analytics section
- [ ] Update README with cache management section
- [ ] Add performance expectations to docs
- [ ] Run full test suite
- [ ] Verify coverage >80%

## Success Criteria

- [ ] Unit tests pass for all services
- [ ] Integration tests pass
- [ ] Test coverage >80%
- [ ] Performance targets met (<100ms queries)
- [ ] README updated with new commands
- [ ] Documentation is clear and accurate
- [ ] Examples work correctly
- [ ] Multi-account isolation verified

## Risk Assessment

**Risk:** Tests are slow due to file I/O
**Mitigation:** Use in-memory SQLite for tests, mock filesystem where possible

**Risk:** Flaky tests due to timing
**Mitigation:** Avoid time-dependent assertions, use fixed timestamps

**Risk:** Coverage not meeting 80%
**Mitigation:** Add tests for edge cases, error paths

## Security Considerations

- Test data doesn't contain real credentials
- Test cache files use temp directory
- Clean up test artifacts after runs

## Final Checklist

Before marking plan complete:

- [ ] All phases implemented
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Performance targets met
- [ ] Code reviewed
- [ ] Linting passes
- [ ] TypeScript compiles
- [ ] Ready for production use
