# Planner Summary: Category Cache v6 Final Revision

## Scope

Revised existing plan artifacts only under `plans/260827-category-cache-v6`. No source edits, no staging, no commit, no push.

## Files Revised

- `plans/260827-category-cache-v6/plan.md`
- `plans/260827-category-cache-v6/phase-01-contract-schema-and-account-binding.md`
- `plans/260827-category-cache-v6/phase-02-category-sync-and-cache-services.md`
- `plans/260827-category-cache-v6/phase-03-mirror-cli-tests-docs-and-review.md`
- `plans/260827-category-cache-v6/reports/planner-summary.md`

## Sol Review Fixes Applied

- Added zero-write validation/fetch failure rule preserving old categories, meta, item names, and stock names.
- Replaced structured category meta with exact key/value schema and typed versioned snapshot JSON at stable key.
- Corrected `categories` schemas: nullable `item_count`, `created TEXT`, modified integer/bigint, default cache source without CHECK.
- Replaced old pagination-shape assumptions with top-level string-compatible `count/page/pages` invariants and documented coherent zero forms.
- Added dedicated `CategoryIndexerService` and required categories phase before items for normal/delta/full/full-resume sync.
- Added deterministic fingerprint inputs covering same-count rename, parent, count, schema, generation, and meta changes.
- Added immutable durable `cache_account_binding` keyed by stable normalized SalesBinder identity, not CLI alias; populated unbound DB fails safely.
- Added reconciliation for both `items` and `item_stock_locations`, embedded-name fallback limits, and CSV weak-name preservation.
- Added genuine forced v5-to-v6 DDL/index rollback test and PostgreSQL original/partial/twice/order repair tests.
- Moved v6 capability/generation marker to legacy `cache_meta` at `category_cache.v6.generation`; authority requires matching marker and complete typed meta.
- Made `category_cache_meta` key/value snapshot JSON plus legacy marker the typed complete snapshot authority and protected it from running/failed global sync overwrite.
- Added final authority requirement: matching generation marker and `cache_meta.state.schemaVersion === 6`; state version 5 survival is non-authoritative.
- Replaced rejected open-time marker mutation: backend open, ensureSchema, read, and status are non-mutating for category marker.
- Added `setCacheState` transition rule: ordinary non-category transition from persisted state schemaVersion not 6 to new schemaVersion 6 invalidates stale marker inside one serialized, binding-verified transaction that re-reads persisted state.
- Added tests: stale rows/meta/marker plus state v5 remain non-authoritative on read/status; later state transition invalidates marker but does not reauthorize; only successful category replacement restores authority.
- Added SQLite/PG interleaving tests so a concurrent successful category snapshot cannot have its fresh marker deleted from stale observation.
- Added PG mismatch/unbound populated DB state transition zero-mutation tests.
- Clarified v6 clear physically deletes category rows/meta/marker on SQLite and PostgreSQL; PostgreSQL preserves only `cache_account_binding`.
- Clarified full mirror with invalid PG category authority clears target SQLite category authority, copies PG item/stock names unchanged, and skips reconciliation.
- Added safe-integer pagination parsing and conservative finite `MAX_CATEGORY_PAGES` / `MAX_CATEGORY_COUNT` rejection tests.
- Resolved final ownership: Lead owns CLI orchestration/CLI tests/shared mirror caller/integration; A owns SDK resource/indexer/item/csv tests; B owns SQLite backend/atomicity tests; C owns PG backend/readers/tests.
- Updated mirror/clear/resume tests and verified phase links point to actual filenames.

## Validation

Passed: `ak plan validate plans/260827-category-cache-v6 --no-interactive`.

## Unresolved Questions

None.
