---
phase: 1
title: "Exact Contract, Schema, and PG Binding"
status: complete
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Exact Contract, Schema, and PG Binding

## Context Links

- Plan: [Category Cache v6](./plan.md)
- README cache/backend behavior: `README.md`
- Cache contracts: `packages/sdk/src/cache/cache.interface.ts`, `packages/sdk/src/cache/types.ts`
- Backends: `packages/sdk/src/cache/sqlite-cache.service.ts`, `packages/sdk/src/cache/postgres-cache.service.ts`

## Overview

Define the exact v6 contract before service work starts. This phase fixes row shapes, physical table columns, typed snapshot metadata, account binding, migration repair, and rollback-marker semantics.

## Key Insights

- PostgreSQL is one SalesBinder account per DB, keyed by stable normalized SalesBinder subdomain/account identity, not CLI alias.
- `category_cache_meta` remains a compatibility key/value table. One stable key stores typed versioned snapshot JSON; no structured columns or initial row.
- v5 rollback/re-upgrade can leave stale category rows/meta/marker. Authority requires complete typed meta generation matching the legacy `cache_meta` capability marker and `cache_meta.state.schemaVersion === 6`.
- No plan item may depend on scripts.

## Requirements

- Functional: bump `CACHE_SCHEMA_VERSION` to 6.
- Functional: exact `CategoryCacheRow` columns: `category_id,name,item_count,parent_id,parent_name,created,modified,cache_source,imported_at`; `item_count` is nullable.
- Functional: `parent_name` is computed from the new snapshot only; missing parent becomes `NULL`.
- Functional: physical `category_cache_meta` is exactly `key TEXT PRIMARY KEY, value TEXT NOT NULL`; typed versioned snapshot JSON at the stable key carries account identity, status, started/completed timestamps, `count/page/pages`, source/stored row counts, schema version, generation, fingerprint.
- Functional: capability marker lives in legacy `cache_meta` at the exact namespaced key `category_cache.v6.generation`; it is written atomically with a successful snapshot.
- Functional: category authority requires both matching generation marker and `cache_meta.state.schemaVersion === 6`; surviving rows/meta/marker with state schema version 5 are non-authoritative.
- Functional: backend open, `ensureSchema`, read, and status paths are non-mutating for category authority marker.
- Functional: authority reads fail closed whenever persisted `cache_meta.state.schemaVersion !== 6` or typed meta generation mismatches legacy marker.
- Functional: ordinary non-category `setCacheState` transitions from persisted schema version not 6 to new schema version 6 delete or keep absent `cache_meta.category_cache.v6.generation` inside one serialized write transaction that re-reads persisted state before mutation.
- Functional: account/document/cache-state writes that set `cache_meta.state.schemaVersion = 6` must not reauthorize stale category rows/meta; only successful atomic category snapshot replacement may write a fresh generation marker.
- Functional: PostgreSQL binding is immutable, DB-global, lock-protected, insert-if-absent plus equality-checked, and verified before every write.
- Functional: `cache clear` will preserve PG binding by contract; Phase 3 implements command behavior.
- Non-functional: no raw category payload in cache row, no `updated_at` alias, no scripts.

## Architecture

Exact compatibility schemas:

```sql
-- SQLite categories
category_id TEXT PRIMARY KEY,
name TEXT NOT NULL,
item_count INTEGER NULL,
parent_id TEXT NULL,
parent_name TEXT NULL,
created TEXT NULL,
modified INTEGER NULL,
cache_source TEXT NOT NULL DEFAULT 'api',
imported_at INTEGER NOT NULL

-- PostgreSQL categories
category_id TEXT PRIMARY KEY,
name TEXT NOT NULL,
item_count INTEGER NULL,
parent_id TEXT NULL,
parent_name TEXT NULL,
created TEXT NULL,
modified BIGINT NULL,
cache_source TEXT NOT NULL DEFAULT 'api',
imported_at BIGINT NOT NULL
```

Physical category metadata schema is key/value only:

```sql
-- SQLite category_cache_meta
key TEXT PRIMARY KEY,
value TEXT NOT NULL

-- PostgreSQL category_cache_meta
key TEXT PRIMARY KEY,
value TEXT NOT NULL
```

Stable `category_cache_meta` key:

```text
category_cache.v6.snapshot
```

PostgreSQL binding table:

```sql
-- cache_account_binding
id SMALLINT PRIMARY KEY CHECK (id = 1),
account_identity TEXT NOT NULL UNIQUE,
account_subdomain TEXT NOT NULL,
created_at BIGINT NOT NULL
```

Typed snapshot JSON value includes `schemaVersion`, `status`, `accountIdentity`, `startedAt`, `completedAt`, top-level-compatible `count`, `page`, `pages`, `sourceRowCount`, `storedRowCount`, `generation`, and `fingerprint`. Authority check additionally reads legacy `cache_meta.state` and requires `schemaVersion === 6`.

State-transition authority guard:

```text
setCacheState(non-category state, new schemaVersion 6)
  -> enter serialized write transaction
  -> verify account binding where applicable
  -> read cache_meta.state.schemaVersion
  -> read current category generation marker
  -> if persisted schemaVersion !== 6, delete/keep absent cache_meta.category_cache.v6.generation
  -> write new cache_meta.state
  -> commit
```

Backend open, `ensureSchema`, read, and status do not mutate the marker. SQLite uses its existing write transaction. PostgreSQL uses the stable configured account identity, binding verification, dedicated client transaction, and row lock before mutation.

Interleaving order: the state transition must re-read state and marker inside the transaction. If a category snapshot committed first, the re-read observes schema version 6 and must not delete the fresh marker. If the state transition holds the lock first and deletes a stale marker, a later successful `replaceCategorySnapshot` writes the fresh completed meta plus generation marker after it can observe current state.

Binding algorithm: acquire DB-global lock; derive normalized account identity from SalesBinder subdomain/account, not CLI alias; atomically insert first `cache_account_binding` row if absent; compare equality; fail on mismatch. If DB is unbound but populated, do not infer identity from `cache_state` alias or other weak evidence; fail with safe rebuild/binding guidance.

## Related Code Files

- Modify: `packages/sdk/src/cache/cache.interface.ts` - typed snapshot, metadata, binding APIs.
- Modify: `packages/sdk/src/cache/types.ts` - v6 constants and exact types.
- Modify: `packages/sdk/src/cache/sqlite-cache.service.ts` - exact schema, v1-v5 migration, forced migration rollback, v6 marker.
- Modify: `packages/sdk/src/cache/postgres-cache.service.ts` - exact schema, PG binding, idempotent repair.
- Modify/Create: `packages/sdk/src/cache/__tests__/*sqlite*` - migration and rollback tests.
- Modify/Create: `packages/sdk/src/cache/__tests__/*postgres*` - original/partial/twice/order/binding tests.
- Delete: none.

## Implementation Steps

1. Define `CategoryCacheRow`, `CategorySnapshot`, `CategoryCacheMeta`, and `CacheAccountBinding` with exact columns and no raw/updated aliases.
2. Add `replaceCategorySnapshot`, `getCategorySnapshot`, `getCategoryCacheMeta`, and `ensureAccountBinding` to `CacheService`.
3. Bump schema/fingerprint constants to v6 and include category capability/generation in cache identity.
4. SQLite migration: create exact tables; create no category meta row and no account identity row during migration.
5. SQLite forced rollback tests: inject DDL/index failure during genuine v5-to-v6 migration and assert transaction rollback; simulate v5 normal-write rollback with `cache_meta.state.schemaVersion = 5` while category rows/meta/marker survive, then assert category cache is non-authoritative until a new v6 complete snapshot.
6. Add SQLite and PostgreSQL read/status tests: stale rows/meta/marker plus `cache_meta.state.schemaVersion = 5` open under v6 without mutating marker, but authority reads fail closed.
7. Add ordinary state transition tests: after non-mutating open/read/status, an account/document/cache-state write from persisted schema version 5 to new schema version 6 deletes/keeps absent the marker inside the serialized transaction and does not reauthorize category cache.
8. Add interleaving tests proving a concurrent successful `replaceCategorySnapshot` cannot have its fresh marker deleted from stale observation.
9. PostgreSQL repair: handle no category tables, partial category table, partial meta table, repeated initialization, and out-of-order creation.
10. PostgreSQL binding: DB-global lock, insert-if-absent/equality check, every write verifies, clear preserves binding.
11. Unbound populated PG DB: fail with safe rebuild/binding guidance; do not infer from `cache_state` or CLI alias.

## Todo List

- [x] Exact category row and meta schemas documented in types/tests.
- [x] `CACHE_SCHEMA_VERSION = 6`.
- [x] `category_cache_meta` remains `key,value`; typed snapshot JSON is absent until successful snapshot.
- [x] Durable PG account binding uses normalized source identity, not CLI alias.
- [x] Every PG write verifies binding under DB-global lock contract.
- [x] SQLite forced v5-to-v6 DDL/index migration failure rollback test added.
- [x] v5 normal-write survival test proves state schemaVersion 5 plus surviving rows/meta/marker is non-authoritative.
- [x] Backend open/ensureSchema/read/status are non-mutating for category marker and authority reads fail closed when state schemaVersion is not 6.
- [x] Ordinary non-category `setCacheState` transition from persisted schemaVersion not 6 to new schemaVersion 6 invalidates stale marker inside serialized transaction.
- [x] Subsequent non-category state write to schemaVersion 6 cannot reauthorize stale category rows/meta.
- [x] Interleaving tests prove fresh marker from concurrent successful category replacement is not deleted from stale observation.
- [x] PG original/partial/twice/order repair tests added.
- [x] No scripts added.

## Success Criteria

- [x] Fresh and migrated SQLite databases match exact v6 schemas.
- [x] Fresh, original, partial, repeated, and out-of-order PostgreSQL schemas repair idempotently.
- [x] Clear/re-upgrade cannot treat stale category rows/meta as complete without both matching legacy generation marker and `cache_meta.state.schemaVersion === 6`.
- [x] Category cache remains uninitialized after stale-marker invalidation until successful atomic category snapshot replacement writes fresh typed meta plus marker.
- [x] PG binding mismatch blocks every write before data mutation.
- [x] Populated unbound PG DB fails with safe rebuild/binding guidance.

## Risk Assessment

Main risk: treating CLI alias as identity. Mitigation: type `account_identity` as normalized source account/subdomain only and test alias rename does not break binding.

Rollback: v5 behavior can leave category rows/meta/marker while writing `cache_meta.state.schemaVersion = 5`. On v6 open/read/status, backends do not mutate marker but authority fails closed. The first ordinary non-category `setCacheState` transition from persisted version not 6 to new version 6 invalidates stale marker in a serialized transaction. Stale rows remain physical but are non-authoritative until a complete v6 snapshot writes typed meta, marker, and state schema version 6 atomically.

## Security Considerations

Never log API key or DB URL. Binding errors may show safe normalized account identity and action: use matching DB or rebuild a fresh DB for this SalesBinder account.

## Next Steps

Phase 2 starts after exact contract and binding tests define the service boundary.
