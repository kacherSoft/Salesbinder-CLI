---
title: "Category Cache v6"
description: "Promote SalesBinder categories to a first-class SQLite and PostgreSQL cache contract with validated full snapshots and durable account binding."
status: complete
priority: P1
effort: 3d
issue: null
branch: codex/category-cache-v6
tags: [feature, cache, database, sqlite, postgresql, cli]
blockedBy: []
blocks: []
created: 2026-08-27
---

# Category Cache v6

## Outcome

First-class category cache v6 in SQLite and PostgreSQL. Every sync invocation fetches a validated full category snapshot before items. `categories` stores compatibility rows; physical `category_cache_meta` stays `key TEXT PRIMARY KEY, value TEXT NOT NULL` and stores the sole typed versioned snapshot JSON at one stable key. PostgreSQL binds immutably to exactly one stable SalesBinder account identity before every write.

## Scope

In: exact v6 schemas, v1-v5 to v6 migrations, idempotent PostgreSQL original/partial/twice/order repair, durable PG account binding, `CategoryIndexerService`, strict `count/page/pages` validation, zero-write rejection behavior, atomic replacement and name reconciliation for `items` plus `item_stock_locations`, atomic mirror, clear/status/output, checkpoint fingerprint/version bump, docs, tests, review.

Out: new scripts, category write CLI changes, multi-account PostgreSQL tenancy, analytics expansion beyond reliable cached category IDs/names.

## Non-Negotiable Decisions

- Preserve `category_id`; canonical name is `categories.name`.
- `CategoryCacheRow` columns are exactly `category_id,name,item_count,parent_id,parent_name,created,modified,cache_source,imported_at`; `item_count` is nullable.
- No `raw`; no `updated_at`.
- Parent name is computed only from the newly validated snapshot; missing parent means `parent_name = NULL`.
- Validation/fetch failure preserves old categories, meta, item names, and stock names. Only a validated authoritative snapshot may delete/null.
- Reconcile both `items.category_name` and `item_stock_locations.category_name`: known ID gets canonical name; unmatched ID keeps ID and nulls name.
- CSV rows without category ID stay as weak display data; weak CSV cannot erase API-backed ID/name.
- `category_cache_meta` physical schema is exactly `key TEXT PRIMARY KEY, value TEXT NOT NULL`; typed complete snapshot JSON includes account, status, timestamps, `count/page/pages`, source row count, stored row count, schema, generation, fingerprint.
- Capability marker lives in legacy `cache_meta` at exact key `category_cache.v6.generation` and is written atomically with a successful snapshot. Category authority requires complete typed meta generation matching the marker and `cache_meta.state.schemaVersion === 6`.
- Backend open, `ensureSchema`, read, and status paths are non-mutating for category authority marker. Authority reads fail closed whenever persisted `cache_meta.state.schemaVersion !== 6` or generation mismatches.
- Ordinary non-category `setCacheState` transitions from persisted schema version not 6 to new schema version 6 must delete or keep absent `cache_meta.category_cache.v6.generation` inside one serialized, binding-verified write transaction that re-reads persisted state before mutation. Later account/document state writes to schema version 6 must not reauthorize categories; only successful atomic category replacement may write a fresh marker.
- Running/failed global sync cannot overwrite last complete category meta.
- v6 capability/generation marker makes stale v5 rollback rows uninitialized until successful v6 snapshot.
- v6 clear physically deletes `categories`, `category_cache_meta`, and `cache_meta.category_cache.v6.generation`; PostgreSQL preserves only `cache_account_binding` from category/cache authority tables.
- v5 rollback clear/mirror leftovers can leave rows/meta/marker behind, but missing `cache_meta.state.schemaVersion === 6` makes category cache non-authoritative until a new successful v6 snapshot.

## Ownership

| Owner | Files | Responsibility |
|---|---|---|
| Lead | `packages/sdk/src/cache/cache.interface.ts`, `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts`, `packages/cli/src/commands/cache/*`, checkpoint/docs integration, CLI/integration tests | Exclusive owner for shared interface, mirror caller/orchestration, CLI phase orchestration, CLI clear/status/output, checkpoint fingerprint, docs, review |
| A | `packages/sdk/src/types/categories.types.ts`, `packages/sdk/src/resources/categories.resource.ts`, `packages/sdk/src/cache/category-indexer.service.ts`, `packages/sdk/src/cache/item-indexer.service.ts`, `packages/sdk/src/cache/csv-cache-import.service.ts`, their SDK tests | Exclusive owner for SDK types, category resource, category indexer, item indexer, CSV semantics |
| B | `packages/sdk/src/cache/sqlite-cache.service.ts`, SQLite cache tests | Exclusive owner for SQLite service/tests, including SQLite mirror/clear backend implementation and backend atomicity tests |
| C | `packages/sdk/src/cache/postgres-cache.service.ts`, PostgreSQL cache tests | Exclusive owner for PostgreSQL service/tests, including PG mirror/clear readers |

## Phases

| Phase | Name | Status | Dependency |
|---|---|---|---|
| 1 | [Exact Contract, Schema, and PG Binding](./phase-01-contract-schema-and-account-binding.md) | Complete | None |
| 2 | [Category Indexing and Atomic Cache Replace](./phase-02-category-sync-and-cache-services.md) | Complete | Phase 1 |
| 3 | [Mirror, CLI, Tests, Docs, and Review](./phase-03-mirror-cli-tests-docs-and-review.md) | Complete | Phase 2 |

## Validation Gates

- Rejection tests prove validation/fetch failures perform zero writes and preserve old category/meta/item/stock names.
- SQLite: genuine forced v5-to-v6 DDL/index migration failure rollback, v1-v5 migration, v5 normal-write schemaVersion 5 survival test, v6 clear zero-row test, snapshot atomicity, reconciliation.
- PostgreSQL: original schema, partial schema, initialize twice, out-of-order table repair, binding mismatch, populated unbound DB fails safely.
- State transition: SQLite and PostgreSQL invalidate stale category generation marker only inside ordinary non-category `setCacheState` transition from persisted schema version not 6 to new schema version 6; read/status/open stay non-mutating.
- Concurrency: tests cover interleaving so a concurrent successful category snapshot cannot have its fresh marker deleted from stale observation.
- Indexer/resource: top-level string-compatible `count/page/pages`, `Number.isSafeInteger`, conservative finite `MAX_CATEGORY_PAGES` and `MAX_CATEGORY_COUNT`, coherent zero, full snapshot every normal/delta/full/full-resume sync, deterministic fingerprint on rename/parent/meta same-count changes.
- Mirror/CLI/resume: category mirror atomicity, v6 clear physically deletes category rows/meta/marker and preserves PG binding only, invalid PG authority clears target SQLite category authority while copying PG item/stock names unchanged, typed snapshot JSON output, marker/schema authority checks, v5 checkpoint invalidation.
- Build gates: `pnpm --filter @salesbinder/sdk build`, `pnpm --filter @salesbinder/cli build`; broad gate `pnpm test` after focused tests pass.

## Docs Impact

Major. README/docs must cover category cache v6, exact PG one-account binding, full snapshot every sync, no-script migration/repair, category status output, rollback and re-upgrade semantics.

## Unresolved Questions

None.
