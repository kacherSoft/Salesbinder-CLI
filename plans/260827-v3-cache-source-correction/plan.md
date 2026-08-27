---
title: "SalesBinder v3 Cache Source Correction"
description: "Fix inventory/category cache authority by adding v3 snapshot reads and schema v7 nullable stock provenance."
status: completed
priority: P1
effort: 3d
issue:
branch: codex/category-cache-v6
tags: [bugfix, api, database, cache]
blockedBy: []
blocks: []
created: 2026-08-27
---

# SalesBinder v3 Cache Source Correction

## Outcome

Correct cache source of truth for inventory and categories without a full CLI v3 rewrite. Keep v2 for accounts, documents, `modifiedSince`, and deleted-log. Add a separate Bearer-auth v3 client for inventory/category cache snapshots. When a v3 key is configured, cache sync uses complete validated v3 snapshots for categories/items/variation stock. Without v3 key, v2 fallback may persist only fields observed in payloads; unknown stock/archive values stay `NULL`, never fabricated `0`.

## Constraints / Non-Goals

- Preserve existing v2 command behavior and current config files.
- Preserve one PostgreSQL database per normalized SalesBinder account binding, and prevent SQLite alias collisions with a durable local binding.
- Preserve CSV stock rows and their numeric values; a shared-ID v3 row remains the canonical item master. Pre-v7 API-fabricated stock values migrate to `NULL`.
- Add source/version provenance for rows touched by v3 (`cache_source`, `source_api_version`, snapshot meta).
- No full SDK/CLI migration to v3 CRUD. No source/test edits in this planning task.
- Do not touch `plans/260724-1358-salesbinder-api-v3-migration/`.

## Evidence

- v3 contract: `research/v3-contract-research.md`.
- Blast radius: `research/cache-blast-radius.md`.
- Current defects: v2 Basic `.json` resources cannot speak v3; `ItemIndexerService` fabricates stock fields; SQLite/PostgreSQL stock schema and PG coercion force nulls back to zero.

## Exact Affected Files

- Modify: `packages/sdk/src/config/config.schema.ts`, `packages/sdk/src/config/config.loader.ts`.
- Modify: `packages/cli/src/commands/config/config.init.command.ts`, `packages/cli/src/commands/config/config.list.command.ts`.
- Modify: `packages/sdk/src/resources/index.ts`, `packages/sdk/src/resources/items.resource.ts`, `packages/sdk/src/resources/categories.resource.ts`.
- Create: `packages/sdk/src/client/v3-axios.factory.ts`, `packages/sdk/src/resources/v3-items.resource.ts`, `packages/sdk/src/resources/v3-categories.resource.ts`.
- Modify: `packages/sdk/src/types/common.types.ts`, `packages/sdk/src/types/items.types.ts`, `packages/sdk/src/types/categories.types.ts`.
- Modify: `packages/sdk/src/cache/types.ts`, `packages/sdk/src/cache/item-indexer.service.ts`, `packages/sdk/src/cache/category-indexer.service.ts`.
- Modify: `packages/sdk/src/cache/cache.interface.ts`, `packages/sdk/src/cache/sqlite-cache.service.ts`, `packages/sdk/src/cache/postgres-cache.service.ts`, `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts` only if interface/type widening requires it.
- Modify orchestration only if needed: `packages/cli/src/commands/cache/cache.commands.ts`, `packages/cli/src/commands/cache/full-resume-checkpoint.ts`.
- Tests: resource, indexer, SQLite, PostgreSQL, mirror, category, resume suites under existing `__tests__` paths plus CLI cache checkpoint tests.
- Docs: `README.md` cache/config sections and smallest owning doc under `docs/` if present.

## Phase 1: Transport / Config

Implement optional v3 credentials without changing existing v2 auth. Add `AccountConfig.v3ApiKey?: string`; optionally accept `--v3-api-key` in `config:init`; expose only `hasV3ApiKey` in `config:list`. Keep `apiKey` + `apiVersion: "2.0"` as the v2 default.

Add Bearer v3 Axios factory with base URL `/api/v3`, no `.json`, `Authorization: Bearer <v3ApiKey>`, same timeout, JSON headers, request IDs, retry behavior. Add v3 resources for `GET /items?archived=all&limit=100&page=N`, `GET /items/{id}`, `GET /items/{id}/variations?include=locations`, and `GET /item-categories`.

Acceptance:
- Existing v2 resource tests still pass unchanged.
- New tests fail on current code and pass after v3 resources normalize `data`/`pagination`, preserve `archived`, `category_name`, stock fields, and variation `item_variation_location_id`.
- No command switches to v3 unless `v3ApiKey` exists.

## Phase 2: Schema / Indexers

Bump `CACHE_SCHEMA_VERSION` to `7`. Add nullable `source_api_version` where v3 writes rows (`items`, `item_stock_locations`, `categories`) and category snapshot meta records schema `7`. Keep category snapshot as naming authority; v3 item `category_name` is fallback only when no complete category snapshot exists.

SQLite v7 migration: transactionally rebuild `item_stock_locations`; four fields `quantity_reserved`, `quantity_available`, `quantity_incoming`, `in_transit` become `REAL NULL` with no default. Copy existing rows, setting those four fields to `NULL` for `cache_source='api'`, preserving CSV values. Recreate indexes, run FK check, set `user_version=7`.

PostgreSQL v7 migration: in verified DB transaction, drop defaults and `NOT NULL` on the same four stock columns; add provenance columns idempotently; null pre-v7 API rows exactly once while promoting from `<7` to `7` using cache-state/schema evidence or a `cache_meta` migration marker. Do not rerun cleanup on later `ensureSchema()`.

Indexer rules: map only observed source values. Required v3 `quantity` must validate or abort before writes. `quantity_available` is `NULL` unless source `location_inventory.quantity_available` is present. Variation/location stock maps v3 `quantity`, `quantity_reserved`, `quantity_incoming`, `in_transit`, threshold, location fields, and stable `item_variation_location_id`; v2 fallback maps analogous observed fields only.

Atomic publish: collect and validate full v3 category/item/variation snapshot before publishing. Require two consecutive v3 membership reads to agree before the destructive publish. Publish in backend transaction/staging step; replace only API/v3-owned category, item, and stock rows; preserve CSV stock rows and existing v2 account/document/deleted-log data. A shared-ID v3 item is the canonical item master. Keep PostgreSQL account binding check before writes.

Resume/checkpoint: keep item as atomic checkpoint unit. Fetch/validate all variation pages for an item before item/stock writes; advance `itemIndex` only after writes complete. Schema v7 naturally invalidates old checkpoints with existing reset guidance. Do not add variation cursor unless implementation writes partial item pages, which is not recommended.

Acceptance:
- Payload-to-row tests prove v3 reserved/incoming/in-transit survive and unknown available is `NULL`.
- Existing false-zero paths fail tests before fix.
- PG reads preserve DB `NULL` as JS `null`, not `Number(null)`.
- One PostgreSQL database remains bound to one normalized account.

## Phase 3: Verification / Review / Rollback

Focused tests: `items.resource`, `categories.resource`, `archive-state-indexers`, `category-indexer`, `sync-resume-indexers`, `sqlite-cache.service`, `postgres-cache.service`, `pg-to-sqlite-sync`, CSV category/stock preservation, CLI full-resume checkpoint. Then run `pnpm --filter @salesbinder/sdk test`, `pnpm --filter @salesbinder/cli test`, `pnpm build`, and lint if time allows.

Docs: update README config/cache section to document optional `v3ApiKey`, schema v7 nullable unknown stock, v3 snapshot source, v2 fallback, and external SQL `NULL` handling. Docs impact: major because cache contract changes for direct readers.

Rollback: code rollback is normal git revert. Data rollback to v6 is not lossless for unknown stock because v7 intentionally nulls fabricated API values; restore from DB backup if false zeros are required temporarily. Downgraded v6 binaries may fail on nullable stock/provenance columns; supported rollback path is restore pre-v7 DB backup or run a forward v7 binary.

Review gates: code-review after tests; reject any implementation that reuses Basic auth for v3, treats active-only v3 item absence as delete evidence, fabricates stock zeros, or rewrites CLI CRUD to v3.

## Unresolved Questions

None for bounded implementation. Assumption: shared cache represents the configured v3 credential visibility scope; it must not claim account-global stock if the key is location-restricted.

## Completion Evidence

- Final tests: SDK 21 suites / 335 tests; CLI 2 suites / 37 tests.
- Build: SDK and CLI TypeScript builds passed.
- Lint: 0 errors; 16 pre-existing SDK warnings.
- Database smoke: disposable PostgreSQL 14 and 16 migration, idempotence, nullability, CSV preservation, binding, and atomic snapshot checks passed.
- Reviews: both independent Sol-high final-tree reviews APPROVE with no remaining findings.
- Docs impact: major; README updated for hybrid v2/v3 sync, schema v7, nullable unknowns, source stability, bindings, checkpoint authority, and legacy SQLite clear recovery.
