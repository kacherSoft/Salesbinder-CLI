# Item Sales Analytics - Incremental Cache Solution

**Date:** 2026-01-28
**Type:** Brainstorm Report
**Status:** Approved for Implementation

## Problem Statement

Build an `item-sales-report` analytics command that shows:
- Current stock level
- Latest OC (Order Confirmation) date
- Latest PO (Purchase Order) date
- Total sold quantity (with -3, -6, -12 month filters)

**Challenge:** API requires scanning 33,779 invoices to find item sales. Real-time on-demand reports need caching strategy.

## Requirements

| Requirement | Value |
|-------------|-------|
| Scale | 38K items, 33K invoices |
| Freshness | Real-time priority |
| Frequency | On-demand |
| Cache location | Local filesystem |
| Sync strategy | Incremental |

## Evaluated Approaches

### 1. Full Snapshot Cache
- **Pros:** Simple, fast reads
- **Cons:** Stale data, long initial sync
- **Verdict:** ❌ Not real-time enough

### 2. Per-Item Lazy Cache
- **Pros:** Lazy loading
- **Cons:** First run slow, no global sync
- **Verdict:** ❌ Doesn't solve on-demand latency

### 3. Incremental Cache (Selected)
- **Pros:** Fresh data, fast subsequent runs
- **Cons:** More complex
- **Verdict:** ✅ Best fit

## Final Solution: SQLite Incremental Cache

### Database Schema

```sql
-- Document index for fast lookups
CREATE TABLE documents (
  doc_id TEXT PRIMARY KEY,
  context_id INTEGER,
  doc_number INTEGER,
  issue_date TEXT,
  customer_id TEXT,
  modified INTEGER
);

CREATE INDEX idx_context_date ON documents(context_id, issue_date);
CREATE INDEX idx_modified ON documents(modified);

-- Item-document relationships
CREATE TABLE item_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  quantity INTEGER,
  price REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id)
);

CREATE INDEX idx_item_doc ON item_documents(item_id, doc_id);
CREATE INDEX idx_item_date ON item_documents(item_id)
  JOIN documents ON item_documents.doc_id = documents.doc_id;

-- Metadata for sync
CREATE TABLE cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### Cache File Structure

```
~/.salesbinder/cache/
└── salesbinder-cache.db    # SQLite database
```

### Sync Algorithm

```
┌─────────────────────────────────────────────────────────────┐
│ INITIAL SYNC (First Run)                                    │
│ 1. Fetch all documents (context=4,5,11) with pagination     │
│ 2. For each document:                                       │
│    - Insert into documents table                           │
│    - For each item in document_items:                      │
│      - Insert into item_documents table                    │
│ 3. Store last_sync timestamp in cache_meta                 │
├─────────────────────────────────────────────────────────────┤
│ DELTA SYNC (Subsequent Runs)                               │
│ 1. Check cache freshness (threshold: 1 hour)               │
│ 2. If stale:                                               │
│    - Fetch documents with modifiedSince > last_sync        │
│    - UPSERT into documents table                           │
│    - Re-index changed document_items                        │
│    - Process deleted-log API for removals                  │
│    - Update last_sync timestamp                            │
│ 3. Serve from cache                                        │
└─────────────────────────────────────────────────────────────┘
```

### CLI Interface

```bash
# Item sales report (auto-syncs cache if stale)
salesbinder analytics item-sales <item-id> --months 3

# With all time ranges
salesbinder analytics item-sales <item-id> --months 3 --months 6 --months 12

# Force full cache refresh
salesbinder analytics item-sales <item-id> --refresh

# Use stale cache (skip sync)
salesbinder analytics item-sales <item-id> --cached

# Cache management commands
salesbinder cache sync              # Manual delta sync
salesbinder cache sync --full       # Full rebuild
salesbinder cache clear             # Delete cache
salesbinder cache status            # Show cache stats
```

### Output Format

```json
{
  "item_id": "abc123",
  "item_name": "KNIPEX® CutiX Universal Cutter",
  "current_stock": 35,
  "latest_oc": {
    "date": "2026-01-15",
    "doc_number": 456,
    "doc_id": "..."
  },
  "latest_po": {
    "date": "2026-01-10",
    "doc_number": 789,
    "doc_id": "..."
  },
  "sales": {
    "3_months": {
      "quantity": 48,
      "revenue": 1536.00,
      "orders": 4
    },
    "6_months": {
      "quantity": 96,
      "revenue": 3072.00,
      "orders": 8
    },
    "12_months": {
      "quantity": 156,
      "revenue": 4992.00,
      "orders": 12
    }
  }
}
```

## Implementation Plan

### New SDK Components

| File | Purpose | Lines |
|------|---------|-------|
| `cache/sqlite-cache.service.ts` | SQLite connection & queries | ~150 |
| `cache/document-indexer.service.ts` | Sync logic, index building | ~200 |
| `cache/types.ts` | Cache interfaces | ~50 |

### New CLI Components

| File | Purpose | Lines |
|------|---------|-------|
| `commands/analytics/item-sales.command.ts` | Analytics command | ~120 |
| `commands/cache/cache.commands.ts` | Cache management | ~100 |

### Dependencies

```json
{
  "better-sqlite3": "^9.0.0"
}
```

## Performance Estimates

| Operation | First Run | Cached | Delta Sync |
|-----------|-----------|--------|------------|
| Full index build | ~5-10 min | - | ~30-60 sec |
| Item report | ~5-10 min | ~50ms | ~50ms |
| Cache sync | - | - | ~30-60 sec |

**Disk Usage:** ~5MB compressed vs ~38MB JSON

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Large initial sync time | Poor UX | Show progress bar |
| Cache corruption | Wrong data | Validation + rebuild flag |
| Deleted documents | Stale data | Use deleted-log API |
| Rate limit on sync | Incomplete sync | Exponential backoff |
| DB lock contention | Slow reads | WAL mode, timeout handling |

## Success Criteria

- [ ] First sync completes within 10 minutes for 33K documents
- [ ] Cached item report returns within 100ms
- [ ] Delta sync completes within 60 seconds
- [ ] Cache file stays under 10MB
- [ ] Handles deleted documents correctly
- [ ] Works with existing config/account system

## Next Steps

1. Create detailed implementation plan with phases
2. Implement SDK cache services
3. Implement CLI analytics and cache commands
4. Test with real data (33K invoices)
5. Update README with analytics documentation

## Dependencies

- None (new feature)
- Requires: `better-sqlite3` package
- Builds on: Existing SDK resources, CLI framework
