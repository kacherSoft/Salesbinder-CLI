# Implementation Plan: Item Sales Analytics with SQLite Cache

**Created:** 2026-01-28
**Status:** Ready for Implementation
**Effort:** 12 hours total

## Summary

Comprehensive plan for implementing local SQLite caching layer to enable fast item sales analytics without repeated API calls. The solution implements incremental sync, auto-refresh, and complex aggregations for inventory items.

## Key Deliverables

### 1. CLI Commands
```bash
salesbinder analytics item-sales <item-id> [--months 3|6|12] [--refresh] [--cached]
salesbinder cache sync [--full]
salesbinder cache clear
salesbinder cache status
```

### 2. Architecture Components
- **SQLiteCacheService**: DB connection, CRUD operations, query execution
- **DocumentIndexerService**: Initial/delta sync, index building, deletion handling
- **Analytics Command**: Aggregates sales data from cache
- **Cache Management Commands**: Sync, clear, status operations

### 3. Performance Targets
- First sync: 5-10 minutes (33K documents)
- Delta sync: <1 minute (changes only)
- Cached queries: <100ms
- Cache size: ~20-50MB

## Phase Breakdown

| Phase | Effort | Focus |
|-------|--------|-------|
| 01 - Environment and Types | 1.5h | Dependencies, TypeScript interfaces |
| 02 - SQLite Cache Infrastructure | 3h | Database service, schema, CRUD operations |
| 03 - Document Indexer and Sync | 3h | Full/delta sync, deletion handling, progress reporting |
| 04 - Analytics Commands | 2.5h | Sales aggregation CLI command |
| 05 - Cache Management Commands | 1h | Sync, clear, status commands |
| 06 - Testing and Integration | 1h | Unit tests, integration tests, documentation |

## Technical Highlights

### Database Schema
```sql
documents (doc_id, context_id, doc_number, issue_date, customer_id, modified)
item_documents (id, item_id, doc_id, quantity, price)
cache_meta (key, value)
```

### Sync Strategy
1. Initial sync: Fetch all documents (context=4,5,11)
2. Delta sync: Use `modifiedSince` API parameter
3. Deletions: Poll deleted-log API
4. Auto-sync: Refresh when cache stale (>1 hour)

### Analytics Output
```json
{
  "item_id": "abc123",
  "current_stock": 150,
  "latest_oc_date": "2026-01-15",
  "latest_po_date": "2026-01-20",
  "sales_periods": {
    "3_months": { "sold": 45, "revenue": 1350.00 },
    "6_months": { "sold": 120, "revenue": 3600.00 },
    "12_months": { "sold": 280, "revenue": 8400.00 }
  }
}
```

## New Files

### SDK (packages/sdk/src/cache/)
- `types.ts` - Cache type definitions
- `sqlite-cache.service.ts` - SQLite connection, CRUD operations
- `document-indexer.service.ts` - Sync logic, index building

### CLI (packages/cli/src/commands/)
- `analytics/item-sales.command.ts` - Main analytics command
- `cache/cache.commands.ts` - Cache management commands

## Dependencies

**New packages:**
- `better-sqlite3` - Synchronous SQLite driver
- `@types/better-sqlite3` - TypeScript definitions

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Large initial sync time | Progress bar, pagination with rate limiting |
| Deleted document handling | Poll deleted-log API |
| Cache corruption | Validate on open, rebuild if needed |
| Multi-account support | Separate cache file per account |
| Concurrent access | SQLite WAL mode, file locking |

## Success Criteria

- [ ] Initial sync completes in 5-10 minutes
- [ ] Cached analytics queries return in <100ms
- [ ] Delta sync updates only changed documents
- [ ] Deleted documents properly removed from cache
- [ ] Multi-account isolation maintained
- [ ] Test coverage >80%
- [ ] Documentation complete

## Next Steps

1. Review and approve plan
2. Begin Phase 01: Install dependencies, define types
3. Follow phases in order (01 → 06)
4. Each phase should be tested before proceeding

## Plan Files

- Main plan: `plans/260128-1952-item-sales-analytics-cache/plan.md`
- Phase 01: `phase-01-environment-and-types.md`
- Phase 02: `phase-02-sqlite-cache-infrastructure.md`
- Phase 03: `phase-03-document-indexer-and-sync.md`
- Phase 04: `phase-04-analytics-commands.md`
- Phase 05: `phase-05-cache-management-commands.md`
- Phase 06: `phase-06-testing-and-integration.md`

## Unresolved Questions

None - plan is complete and ready for implementation.
