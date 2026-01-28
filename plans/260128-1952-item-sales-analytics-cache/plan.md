---
title: "Item Sales Analytics with SQLite Cache"
description: "Implement local SQLite cache for fast item sales analytics with incremental sync"
status: complete
priority: P2
effort: 12h
branch: main
tags: [analytics, cache, sqlite, performance]
created: 2026-01-28
completed: 2026-01-28
---

## Overview

Add local SQLite caching layer to enable fast item sales analytics without repeated API calls. Implements incremental sync, auto-refresh, and complex aggregations (stock levels, latest OC/PO dates, sold quantities by period).

**Target Performance:** First sync 5-10min, cached queries <100ms

## Phases

| Phase | Status | Effort | Description |
|-------|--------|--------|-------------|
| [Phase 01](./phase-01-environment-and-types.md) | complete | 1.5h | Setup dependencies, cache types, interfaces |
| [Phase 02](./phase-02-sqlite-cache-infrastructure.md) | complete | 3h | SQLite service, schema, connection management |
| [Phase 03](./phase-03-document-indexer-and-sync.md) | complete | 3h | Sync logic, delta updates, deletion handling |
| [Phase 04](./phase-04-analytics-commands.md) | complete | 2.5h | Analytics CLI command with sales aggregations |
| [Phase 05](./phase-05-cache-management-commands.md) | complete | 1h | Cache sync, clear, status commands |
| [Phase 06](./phase-06-testing-and-integration.md) | complete | 1h | Unit tests, integration tests, documentation |

## Architecture

```
CLI Command Analytics
    ↓
SQLite Cache Service
    ↓
Document Indexer Service
    ↓
SalesBinder SDK → API
```

**Key Components:**
- **SQLite Cache Service**: DB connection, CRUD operations, query execution
- **Document Indexer**: Initial/delta sync, index building, deletion handling
- **Analytics Command**: Aggregates sales data from cache
- **Cache Management**: Sync, clear, status commands

## Database Schema

```sql
-- Documents table (invoices, estimates, POs)
CREATE TABLE documents (
  doc_id TEXT PRIMARY KEY,
  context_id INTEGER NOT NULL,  -- 4=Estimate, 5=Invoice, 11=PO
  doc_number INTEGER NOT NULL,
  issue_date TEXT NOT NULL,     -- YYYY-MM-DD
  customer_id TEXT NOT NULL,
  modified INTEGER NOT NULL     -- Unix timestamp
);

-- Item-document relationships (line items)
CREATE TABLE item_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

-- Cache metadata (sync state)
CREATE TABLE cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_item_documents_item ON item_documents(item_id);
CREATE INDEX idx_documents_context ON documents(context_id);
CREATE INDEX idx_documents_modified ON documents(modified);
```

## CLI Commands

```bash
# Analytics command
salesbinder analytics item-sales <item-id> [--months 3|6|12] [--refresh] [--cached]

# Cache management
salesbinder cache sync [--full]
salesbinder cache clear
salesbinder cache status
```

## Analytics Output

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

## Dependencies

**New packages:**
- `better-sqlite3` - Synchronous SQLite driver for Node.js
- `@types/better-sqlite3` - TypeScript definitions

## Data Scale

- **Items:** ~38K
- **Documents:** ~33K (invoices + estimates + POs)
- **Line items:** ~100K-200K estimated
- **Cache size:** ~20-50MB SQLite database

## Sync Strategy

1. **Initial Sync**: Fetch all documents (context=4,5,11) with pagination
2. **Delta Sync**: Use `modifiedSince` API parameter for incremental updates
3. **Deletions**: Poll deleted-log API for removed documents
4. **Auto-sync**: Refresh when cache stale (>1 hour old)
5. **Manual sync**: `--refresh` flag or `cache sync` command

## Key Risks

| Risk | Mitigation |
|------|------------|
| Large initial sync time | Show progress bar, implement pagination with rate limiting |
| Deleted document handling | Poll deleted-log API periodically |
| Cache corruption | Validate on open, rebuild if needed |
| Multi-account support | Separate cache file per account |
| Concurrent access | SQLite WAL mode, file locking |

## Success Criteria

- [ ] Initial sync completes in 5-10 minutes for 33K documents
- [ ] Cached analytics queries return in <100ms
- [ ] Delta sync updates only changed documents
- [ ] Deleted documents properly removed from cache
- [ ] Multi-account isolation (separate cache per account)
- [ ] Graceful handling of cache corruption
- [ ] Comprehensive test coverage (>80%)
- [ ] Documentation updated with new commands

## Related Files

**New Files:**
- `packages/sdk/src/cache/sqlite-cache.service.ts`
- `packages/sdk/src/cache/document-indexer.service.ts`
- `packages/sdk/src/cache/types.ts`
- `packages/cli/src/commands/analytics/item-sales.command.ts`
- `packages/cli/src/commands/cache/cache.commands.ts`

**Modified Files:**
- `packages/sdk/src/index.ts` - Export cache services
- `packages/cli/src/index.ts` - Register new commands
- `packages/sdk/package.json` - Add better-sqlite3
- `README.md` - Document new commands

## Next Steps

1. Review and approve this plan
2. Begin Phase 01: Environment and Types setup
3. Proceed with implementation following phase order
