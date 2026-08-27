---
phase: 2
title: "Category Indexing and Atomic Cache Replace"
status: complete
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 2: Category Indexing and Atomic Cache Replace

## Context Links

- Plan: [Category Cache v6](./plan.md)
- Phase 1: [Exact Contract, Schema, and PG Binding](./phase-01-contract-schema-and-account-binding.md)
- Category resource: `packages/sdk/src/resources/categories.resource.ts`
- New indexer: `packages/sdk/src/cache/category-indexer.service.ts`
- Item indexer: `packages/sdk/src/cache/item-indexer.service.ts`
- CSV import: `packages/sdk/src/cache/csv-cache-import.service.ts`

## Overview

Add dedicated category indexing and backend snapshot replacement. Every normal, delta, full, and full-resume sync runs an independent categories phase before items and fetches a complete category snapshot every invocation.

## Key Insights

- Delta item sync still requires full category snapshot first. Category freshness cannot be inferred from item deltas.
- Validation and fetch failures must perform zero writes: old categories, category meta, `items.category_name`, and `item_stock_locations.category_name` stay untouched.
- Same-count changes matter. Fingerprint must change on rename, parent changes, top-level `count/page/pages`, source/stored counts, schema, generation, and account identity.
- Embedded item category names are only fallback before an authoritative category snapshot exists.

## Requirements

- Functional: create `CategoryIndexerService` with full snapshot fetch and strict pagination validation.
- Functional: CLI sync orchestration has explicit `categories` phase before `items` for normal, delta, full, and full-resume paths; Lead owns this CLI wiring and CLI tests.
- Functional: reject invalid pagination before any write; all rejection tests assert zero backend writes.
- Functional: compute `parent_name` from the validated snapshot by `parent_id`; missing parent gives `NULL`.
- Functional: replace category snapshot atomically; then reconcile both `items` and `item_stock_locations`.
- Functional: known category ID gets canonical name; unmatched category ID preserves ID and nulls name.
- Functional: CSV rows without category ID are preserved; weak CSV category names cannot erase API-backed ID/name.
- Non-functional: no partial replacement; no stale meta overwrite on running/failed global sync; physical meta remains key/value JSON only.

## Strict Pagination Invariants

A snapshot is authoritative only if all invariants pass before opening a write transaction:

1. Fetch starts at page `1`; requested pages are contiguous with no skips or repeats.
2. Each response exposes top-level string-compatible `count`, `page`, and `pages`; convert only integer strings/numbers with `Number.isSafeInteger` and reject missing, fractional, negative, non-numeric, overflow, or unsafe values.
3. Response `page` equals requested page; `count` and `pages` remain stable across every fetched page.
4. Coherent zero supports documented zero/one-page representation: page `1`, empty category array, `count = 0`, and `pages` is `0` or `1`.
5. Before loop/allocation, reject `pages > MAX_CATEGORY_PAGES` or `count > MAX_CATEGORY_COUNT`; both constants must be explicit, conservative, finite SDK constants covered by tests.
6. Non-zero snapshots require `pages >= 1`, requested pages contiguous from `1..pages`, and every fetched page except coherent zero is non-empty.
7. Do not infer page size or derived page-count math; SalesBinder only provides `count/page/pages` for this plan.
8. Total fetched rows equals `count` after final page.
9. Every row has non-empty `category_id` and `name`; duplicate category IDs reject the whole snapshot.
10. Parent IDs may point to missing rows, but then computed `parent_name` is `NULL`.

## Architecture

```text
CategoryIndexerService.fetchFullSnapshot()
  -> validate every page and row
  -> compute parent_name from snapshot map
  -> compute deterministic fingerprint from sorted exact rows + typed meta
  -> CacheService.replaceCategorySnapshot()
  -> transaction: write categories, write complete category_cache_meta, reconcile item and stock names
  -> ItemIndexerService starts
```

Fingerprint input order: account identity, schema version, `cache_meta.state.schemaVersion`, generation, top-level `count`, final `page`, `pages`, source row count, stored row count, then rows sorted by `category_id` with exact fields `category_id,name,item_count,parent_id,parent_name,created,modified,cache_source,imported_at`. Same-count rename/parent/meta changes must produce a different fingerprint.

## Related Code Files

- Create: `packages/sdk/src/cache/category-indexer.service.ts` - dedicated indexer.
- Modify: `packages/sdk/src/resources/categories.resource.ts` - normalized pages with strict metadata.
- Modify: `packages/sdk/src/types/categories.types.ts` - category list/page response types.
- Modify: `packages/sdk/src/cache/item-indexer.service.ts` - embedded-name fallback only before authoritative category snapshot.
- Modify: `packages/sdk/src/cache/csv-cache-import.service.ts` - CSV weak-name preservation rules; owned by A.
- Modify: `packages/sdk/src/cache/sqlite-cache.service.ts` - atomic replace/reconcile.
- Modify: `packages/sdk/src/cache/postgres-cache.service.ts` - atomic replace/reconcile.
- Modify/Create: SDK category indexer/resource/item/csv tests owned by A; backend cache tests owned by B/C; CLI orchestration tests owned by Lead.
- Delete: none.

## Implementation Steps

1. Owner A builds `CategoryIndexerService` and validation tests for each strict invariant.
2. Owner A adds zero-write rejection tests: malformed page, duplicate ID, failed fetch after first page, ambiguous zero, count mismatch.
3. Lead wires categories as an independent CLI sync phase before items for normal, delta, full, and full-resume; every invocation fetches full snapshot. Lead owns CLI tests for this ordering.
4. Owner A updates item indexing so embedded category names are fallback only while category meta is uninitialized.
5. Owner B implements SQLite atomic replacement and reconciliation for `categories`, `category_cache_meta`, `items`, and `item_stock_locations`.
6. Owner C implements PostgreSQL atomic replacement and reconciliation with binding verification.
7. Owners B/C test that validation/fetch/replacement failures preserve old categories, meta, item names, and stock names.
8. Owners B/C test deterministic fingerprint changes on same-count rename, parent change, top-level `count/page/pages` change, source row count change, stored row count change, schema/generation change, and `cache_meta.state.schemaVersion` change.
9. Owner A updates CSV import tests so rows without category ID remain display-only and weak CSV cannot erase API-backed ID/name.

## Todo List

- [x] `CategoryIndexerService` exists and owns category full snapshots.
- [x] Categories phase runs before items in normal/delta/full/full-resume sync.
- [x] Strict pagination invariants implemented exactly.
- [x] Pagination parsing uses `Number.isSafeInteger` and rejects overflow/out-of-bound `MAX_CATEGORY_PAGES` or `MAX_CATEGORY_COUNT` with zero writes.
- [x] All rejection/fetch failure tests assert zero writes.
- [x] Atomic replacement updates complete meta only after rows and reconciliation succeed.
- [x] Both `items` and `item_stock_locations` reconcile names.
- [x] Embedded item names and CSV weak names cannot erase API-backed category identity.
- [x] Fingerprint changes on same-count content and meta changes.

## Success Criteria

- [x] No invalid or failed category fetch can delete/null old category-derived data.
- [x] A validated authoritative empty snapshot is the only path that can empty `categories` and null stale item/stock names.
- [x] Item sync never runs before the category phase in any sync mode.
- [x] Category meta remains last complete state when global sync is running or failed.
- [x] SQLite and PostgreSQL replacement tests prove previous snapshot remains visible after injected failure.

## Risk Assessment

Main risk: making delta sync cheaper by skipping full categories. Mitigation: sync orchestration tests assert `CategoryIndexerService` runs before items for every mode, including delta.

Rollback: if category sync fails, old category snapshot and names remain authoritative; operators fix the cause and rerun sync.

## Security Considerations

Validation errors should include structural cause and page number but no raw customer/item/category payload dumps. PG writes still verify account binding before mutation.

## Next Steps

Phase 3 integrates mirror, clear/status/output, checkpoints, docs, and final review.
