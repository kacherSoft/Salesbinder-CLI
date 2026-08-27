# Cache Blast Radius: v3 Inventory Source Correction

Research date: 2026-08-27

Scope: read-only trace from SalesBinder item/category payloads through SDK resources, `ItemIndexerService`, SQLite/PostgreSQL persistence and normalization, PostgreSQL-to-SQLite mirror, CLI/cache consumers, checkpoints, and tests. No source modified. The user-owned `plans/260724-1358-salesbinder-api-v3-migration/` tree was not changed.

## Summary

Current production code is still a v2-shaped path. `SalesBinderClient` builds one Axios client and wires the v2 resource classes (`packages/sdk/src/resources/index.ts:18-41`); the base URL is selected from config, but auth remains Basic (`packages/sdk/src/client/axios.factory.ts:47-63`) and item/category paths retain `.json` plus v2 envelopes (`packages/sdk/src/resources/items.resource.ts:24-26,32-44`; `packages/sdk/src/resources/categories.resource.ts:24-38`). Merely setting `apiVersion` to `v3` therefore does not create a valid v3 reader.

The cache correctness defect is later and independently reproducible: `ItemIndexerService` discards source stock fields and manufactures `quantity_reserved=0`, `quantity_available=quantity`, `quantity_incoming=0`, and `in_transit=0` for every API stock row (`packages/sdk/src/cache/item-indexer.service.ts:122-139,145-169`). Both cache backends then enforce or re-create the same zeros at schema/write/read boundaries. A v3 flat `category_name` is also ignored when no authoritative category snapshot is available. Item `archived` itself is already correctly mapped to tri-state `0 | 1 | null`; the remaining archive defect is discovery because v3 item lists are active-only unless `archived=all` is requested.

Current CLI analytics do not consume the four cached stock measures or cached item archive/category values. The bad values nevertheless escape through the public `CacheService` read contract, PostgreSQL shared cache, PostgreSQL-to-SQLite mirror, SQLite DB, and any direct SQL/cache reader. The only CLI cache-item read uses `name` (`packages/cli/src/commands/analytics/customers.command.ts:116-124`). Inventory analytics fetches live `item.quantity` and defaults failure/missing data to zero; it does not use cached stock rows (`packages/cli/src/commands/analytics/inventory.command.ts:106-117`).

Recommended resolution: make source observability explicit, make the four stock columns nullable end-to-end, migrate all pre-v7 API stock values for those columns to `NULL`, preserve CSV values, fetch v3 variations with `include=locations` before writing an item, request `archived=all`, and retain the authoritative category snapshot as primary naming authority with flat v3 `category_name` only as the no-snapshot fallback.

## Authoritative v3 Inputs

The companion official-contract audit records the current v3 conventions and source fields:

- v3 uses Bearer auth, no `.json`, flat resource objects, and `data`/`pagination` list envelopes (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:9,33-95`).
- Item list must use `archived=all` for active and archived records (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:106-117`).
- Parent item exposes `category_id`, `category_name`, `quantity`, `quantity_reserved`, `quantity_incoming`, and `archived`, but not canonical top-level `quantity_available` or `in_transit` (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:119-157`).
- Variation totals expose `quantity`, `quantity_reserved`, `quantity_incoming`, `in_transit`; variation locations expose the same four plus authoritative `item_variation_location_id`, but not `quantity_available` (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:168-222`).
- `quantity_available` is server-sourced only in location-filtered item-list `location_inventory`; it must not be inferred as `quantity` or even `quantity - quantity_reserved` (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:154-157`).
- Categories are complete-snapshot data at `/api/v3/item-categories`; v3 category objects have `id`, `name`, `parent_id`, `inventory_type`, and `custom_fields`, but no v2 `item_count`, `created`, or `modified` (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:224-263`).
- No documented v3 item/category incremental or deleted feed exists, so safe v3 cache authority requires validated complete snapshots (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:15`).

## Current Payload-to-Cache Trace

| Layer | Current evidence | Result for fields in scope |
| --- | --- | --- |
| SDK item types | `Item` has `quantity`, optional `archived`, `category_id`, and optional nested `category`; it lacks flat `category_name`, item reserved/incoming, v3 timestamps, v3 variation totals, and v3 location fields (`packages/sdk/src/types/items.types.ts:8-50`) | Type contract cannot express v3 source authority. Runtime extra fields survive Axios but are ignored by the mapper. |
| Item resource | `list()` returns `response.data` unchanged from `/items.json`; `get()` accepts only wrapped/bare v2-shaped item and only validates string `id` (`packages/sdk/src/resources/items.resource.ts:24-26,32-52`) | No v3 list-envelope normalization; no variation endpoint; no field validation/coercion. |
| Item sync | Lists by v2 `modifiedSince`, flattens v2 nested `items`, fetches one detail, maps item, replaces stock (`packages/sdk/src/cache/item-indexer.service.ts:37-83,86-89`) | Detail is treated as all stock authority even though v3 variations/locations are separate endpoints. |
| Item master map | Maps `category_id` from flat/nested, category name only from canonical snapshot or nested v2 category, `archived` to tri-state; omits all four derived stock measures (`packages/sdk/src/cache/item-indexer.service.ts:91-111,188-197`) | v3 `category_name` lost without snapshot; v3 reserved/incoming never reach `items`; archive boolean mapping is correct. |
| Stock map | Reads only v2 `item_variations[].item_variations_locations[].quantity`; otherwise synthesizes one parent row (`packages/sdk/src/cache/item-indexer.service.ts:114-169`) | Four in-scope measures overwritten with fabricated values. v3 `item_variation_location_id` and `locations` shape not understood. |
| Cache types | `ItemRow` four measures are nullable, but `ItemStockLocationRow` declares all four non-null numbers (`packages/sdk/src/cache/types.ts:97-147`) | Master table can represent unknown; stock table/type cannot. |
| SQLite schema/write | `items` measures nullable; stock measures `NOT NULL DEFAULT 0` (`packages/sdk/src/cache/sqlite-cache.service.ts:232-280`). `normalizeStock()` replaces null/undefined with zero (`packages/sdk/src/cache/sqlite-cache.service.ts:1175-1184`) | Unknown becomes false zero; `quantity_available` cannot be null. |
| PostgreSQL schema/write/read | Same nullable master/non-null stock split (`packages/sdk/src/cache/postgres-cache.service.ts:177-225`); writer defaults null to zero (`packages/sdk/src/cache/postgres-cache.service.ts:1574-1583`); reader uses `Number(row.field)`, so even a database `NULL` becomes JS `0` (`packages/sdk/src/cache/postgres-cache.service.ts:1629-1640`) | Unknown is fabricated at three independent boundaries. |
| Upsert behavior | All columns are overwritten on conflict except item/document `archived`, which uses `COALESCE(incoming, existing)` in both SQLite and PostgreSQL (`packages/sdk/src/cache/sqlite-cache.service.ts:1124-1135`; `packages/sdk/src/cache/postgres-cache.service.ts:1494-1506`) | Unknown archive does not erase known state. Stock false values always replace prior values. |
| Stock replacement | Both backends delete every stock row for the item, then insert the mapper output (`packages/sdk/src/cache/sqlite-cache.service.ts:721-729`; `packages/sdk/src/cache/postgres-cache.service.ts:988-995`) | A forward API sync removes real CSV per-location stock and replaces it with fabricated API zeros/availability. |
| Mirror | Pull reads all PG items/stock and atomically replaces SQLite (`packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:72-108,130-136`; `packages/sdk/src/cache/sqlite-cache.service.ts:891-909`) | Values and nulls propagate exactly only if both backend contracts permit them. Current PostgreSQL coercion and SQLite stock schema do not. |

## Fabricated Defaults: Complete Inventory

### In-scope API/cache defects

| Fabrication | Evidence | Concrete effect | Required correction |
| --- | --- | --- | --- |
| Reserved is always zero | `packages/sdk/src/cache/item-indexer.service.ts:131,161` | Discards v3 parent/variation/location `quantity_reserved`. | Map source value when present; otherwise `NULL`. |
| Available equals on-hand | `packages/sdk/src/cache/item-indexer.service.ts:132,162` | Claims all stock is available even when reserved; v3 variation/location does not expose this field. | Use only source `location_inventory.quantity_available`; otherwise `NULL`. |
| Incoming is always zero | `packages/sdk/src/cache/item-indexer.service.ts:133,163` | Discards v3 `quantity_incoming`. | Map source value; otherwise `NULL`. |
| In transit is always zero | `packages/sdk/src/cache/item-indexer.service.ts:134,164` | Discards v3 variation/location `in_transit`; top-level item has no such field. | Map variation/location source; parent/master otherwise `NULL`. |
| Cache writer null-to-zero | SQLite `packages/sdk/src/cache/sqlite-cache.service.ts:1175-1184`; PG `packages/sdk/src/cache/postgres-cache.service.ts:1574-1583` | Even a corrected mapper cannot persist unknown. | Preserve `null`; validate required on-hand separately. |
| Schema-level zero | SQLite `packages/sdk/src/cache/sqlite-cache.service.ts:259-280`; PG `packages/sdk/src/cache/postgres-cache.service.ts:204-225` | Omitted values become zero; null rejected. | Drop defaults and `NOT NULL` for the four fields. |
| PG read null-to-zero | `packages/sdk/src/cache/postgres-cache.service.ts:1629-1640` | Future/manual DB null silently returns `0`. | Use `row.field == null ? null : Number(row.field)`. |
| Flat category fallback ignored | `packages/sdk/src/cache/item-indexer.service.ts:193-197`; item type `packages/sdk/src/types/items.types.ts:23-28` | A v3 `category_name` becomes null when snapshot is unavailable. | Add flat field; snapshot remains primary; flat name is fallback only with no authoritative snapshot. |

### Adjacent defaults that must not be accidentally broadened

- `quantity_on_hand` also defaults missing API quantity to zero in the mapper and both backend normalizers (`packages/sdk/src/cache/item-indexer.service.ts:130,151,160`; `packages/sdk/src/cache/sqlite-cache.service.ts:1178`; `packages/sdk/src/cache/postgres-cache.service.ts:1577`). v3 documents `quantity` as required. Recommended behavior: reject a malformed required source quantity before writes, not silently store zero.
- CSV inventory parsing defaults blank numeric cells to zero and aggregates them (`packages/sdk/src/cache/csv-cache-import.service.ts:283-324`). These values come from export columns and are outside the API fabrication migration. Preserve existing CSV values; separately decide whether a blank CSV cell means zero or unknown before changing importer behavior.
- CLI inventory analytics initializes/falls back to live current stock `0` when API retrieval fails or quantity is falsy (`packages/cli/src/commands/analytics/inventory.command.ts:106-117`). This does not consume cache stock fields, but it can still emit a false live-stock zero. It should be handled in the v3 CLI adapter or a separate analytics correctness task.

## Item Archive and Category Semantics

### Archive

The mapper is already correct: `true -> 1`, `false -> 0`, missing -> `null` (`packages/sdk/src/cache/item-indexer.service.ts:106-107`). Both item schemas are nullable (`packages/sdk/src/cache/sqlite-cache.service.ts:232-257`; `packages/sdk/src/cache/postgres-cache.service.ts:177-202`) and archive upserts preserve a known value when a weak source reports unknown.

The actual v3 risk is list coverage. Current sync calls `items.list({ modifiedSince, page, pageLimit: 100 })` (`packages/sdk/src/cache/item-indexer.service.ts:42-50`); it neither requests v3 `archived=all` nor has a v3 change-feed contract. A newly archived item can disappear from an active-only list and leave cached `archived=0`. Resolution: v3 snapshot list must explicitly include archived items; absence from an active-only/visibility-limited list is never delete evidence.

### Categories

Normal CLI cache sync deliberately runs the category snapshot before item indexing (`packages/cli/src/commands/cache/cache.commands.ts:185-234`). `ItemIndexerService` builds a canonical ID/name map (`packages/sdk/src/cache/item-indexer.service.ts:40-41,188-197`). SQLite and PostgreSQL atomically replace categories and reconcile item/stock names; missing IDs become null (`packages/sdk/src/cache/sqlite-cache.service.ts:989-1036`; `packages/sdk/src/cache/postgres-cache.service.ts:640-716`). Existing tests confirm canonical names win and unmatched embedded names are suppressed (`packages/sdk/src/cache/__tests__/category-indexer.service.test.ts:129-145`).

Keep that authority rule. Adapt the category resource/indexer to v3 envelope/fields, representing removed v2-only `item_count`, `created`, and `modified` as `NULL`. Preserve `category_id`; cache the authoritative category name. Only when no complete snapshot exists may the mapper use v3 item `category_name`. Do not let an item-embedded name override a complete snapshot.

## Actual Consumers and Blast Radius

### Production consumers

1. Cache public read contract exposes item and stock rows: `getItem`, `getAllItems`, `getItemsModifiedSince`, `getItemStockLocations`, and `getAllItemStockLocations` (`packages/sdk/src/cache/cache.interface.ts:96-112`).
2. CSV import reads cached item/category/stock rows only to preserve API category identity/name (`packages/sdk/src/cache/csv-cache-import.service.ts:194-217`). It does not consume the four numeric stock measures from API rows.
3. PostgreSQL-to-SQLite pull consumes all item and stock fields and republishes them to the local mirror (`packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:72-95,130-136`).
4. Analytics customers reads only `cachedItem.name` (`packages/cli/src/commands/analytics/customers.command.ts:116-124`).
5. Analytics inventory uses live API item quantity/cost, not item master or stock-location cached measures (`packages/cli/src/commands/analytics/inventory.command.ts:106-117`).
6. Cache status consumes counts and category metadata, not item fields (`packages/cli/src/commands/cache/cache.commands.ts:830-920`).
7. `items list/get` print raw SDK resource output, bypassing cache (`packages/cli/src/commands/items/items.commands.ts:38-52,72-79`).

No current in-repository analytics query filters on cached item `archived`, `category_id`, `category_name`, or any of the four stock measures. Therefore changing fabricated values to `NULL` has low CLI behavior risk today. Direct PostgreSQL/SQLite readers are affected: `SUM` ignores nulls, equality comparisons stop matching zero, and serializers must accept null. That behavior change is correct because zero and unknown are not equivalent.

## Pre-fix Reproduction

The following read-only runtime probe used the built `ItemIndexerService` with a v3-shaped item:

```bash
node --input-type=module -e "import { ItemIndexerService } from './packages/sdk/dist/cache/item-indexer.service.js'; const s=new ItemIndexerService({}, {}, 'demo'); const item={id:'v3-i',object:'item',item_number:1,name:'V3 Widget',inventory_type:'quantity',category_id:'cat-v3',category_name:'Canonical V3',price:'3.0000',cost:'2.0000',quantity:7,quantity_reserved:3,quantity_incoming:9,threshold:1,published:true,archived:true,created_at:'2026-08-01T00:00:00Z',updated_at:'2026-08-02T00:00:00Z'}; console.log(JSON.stringify({itemRow:s.toItemRow(item,null),stockRows:s.toStockRows(item,null)},null,2));"
```

Observed pre-fix output, reduced to fields in scope:

```json
{
  "itemRow": {
    "category_id": "cat-v3",
    "category_name": null,
    "quantity": 7,
    "archived": 1
  },
  "stockRows": [{
    "category_name": null,
    "quantity_on_hand": 7,
    "quantity_reserved": 0,
    "quantity_available": 7,
    "quantity_incoming": 0,
    "in_transit": 0
  }]
}
```

Thus archive mapping works, while reserved `3`, incoming `9`, and flat category name are lost; available and in-transit are invented. A second probe with an old-shaped variation-location object containing reserved `3`, available `2`, incoming `9`, and in-transit `4` emitted `0`, on-hand `5`, `0`, and `0`, proving runtime extra fields are ignored even when present.

Focused existing suites passed before changes: 9 suites, 151 tests. Command:

```bash
pnpm --filter @salesbinder/sdk test -- --runInBand \
  src/resources/__tests__/items.resource.test.ts \
  src/cache/__tests__/archive-state-indexers.test.ts \
  src/cache/__tests__/category-indexer.service.test.ts \
  src/cache/__tests__/sqlite-cache.service.test.ts \
  src/cache/__tests__/pg-to-sqlite-sync.test.ts \
  src/cache/__tests__/sync-resume-indexers.test.ts \
  src/cache/__tests__/csv-cache-import.service.test.ts \
  src/cache/__tests__/csv-category-semantics.test.ts \
  src/cache/__tests__/postgres-cache.service.test.ts
```

Passing tests do not disprove the defect: no current test asserts source reserved/incoming/in-transit/available mappings or nullable stock persistence.

## Schema Migration Requirement

This correction requires cache schema v7 because `item_stock_locations.quantity_reserved`, `quantity_available`, `quantity_incoming`, and `in_transit` must change from non-null/default-zero to nullable/no default. `items` already has nullable versions of all four.

### SQLite

SQLite needs a transactional table rebuild, not only `addColumnsIfMissing()`:

1. Create a v7 replacement `item_stock_locations` with the same primary/foreign keys and all columns, but four in-scope columns `REAL NULL` with no default.
2. Copy rows. For `cache_source='api'`, write `NULL` into all four columns because every pre-v7 API value was mapper- or normalizer-fabricated. Preserve all four values for `cache_source='csv'`.
3. Drop old table, rename replacement, recreate stock indexes, run `foreign_key_check`, set `PRAGMA user_version=7`, commit.
4. Preserve row IDs, item/location identity, category names, on-hand, price/cost, provenance, and timestamps exactly.

The migration belongs in `packages/sdk/src/cache/sqlite-cache.service.ts:123-138,316-349`. Existing v1-v6 fixtures must continue upgrading without row loss.

### PostgreSQL

In the verified payload-schema transaction (`packages/sdk/src/cache/postgres-cache.service.ts:99-107,125-264`):

1. `ALTER COLUMN ... DROP DEFAULT` and `DROP NOT NULL` for the four columns.
2. Before any v7 API write, `UPDATE item_stock_locations SET ... = NULL WHERE cache_source='api'` for all four fields.
3. Preserve CSV rows untouched.
4. Make the migration idempotent. If data-version evidence is needed to prevent repeatedly nulling new authoritative API values, record a one-time v7 migration marker in `cache_meta`; schema introspection alone cannot distinguish “already migrated then newly synced” from “not migrated.”

Recommended proposal: perform the API-row nulling only while promoting cache state/physical schema from `<7` to `7`, atomically with schema repair. Do not run the nulling on every `ensureSchema()`.

### Global schema/category coupling

`CACHE_SCHEMA_VERSION` is currently 6 (`packages/sdk/src/cache/types.ts:218-239`), and category metadata is also pinned to schema 6 (`packages/sdk/src/cache/types.ts:176-191`). Validators require category metadata to match the current schema (`packages/sdk/src/cache/sqlite-cache.service.ts:1039-1054,1198-1222`; PostgreSQL equivalent category validation starts at `packages/sdk/src/cache/postgres-cache.service.ts:1424`). A v7 bump must update category metadata/types/validators and deliberately invalidate old v6 category authority until a fresh v7 category snapshot completes. Normal sync order supports this because accounts update cache state before categories run.

## Backward Compatibility

- Preserve `ItemRow` and `ItemStockLocationRow` property names. Only widen the four stock properties to `number | null`; JSON and SQL consumers get explicit unknowns.
- Preserve CSV-imported numeric values. CSV is a distinct source and current imports aggregate real export columns (`packages/sdk/src/cache/csv-cache-import.service.ts:283-353`).
- Preserve archive tri-state and `COALESCE` upsert behavior. A weak/permission-limited response must not erase known archive state.
- Preserve category snapshot precedence and reconciliation. Flat item `category_name` is fallback, not a stronger authority.
- Fix PostgreSQL coercion before enabling nullable DB columns; otherwise `Number(null)` silently reintroduces zero. SQLite already returns SQL null as JS null.
- Mirror replacement remains atomic and needs no production orchestration change if both schemas/types accept null. Add null round-trip tests.
- A full v3 item/variation snapshot can replace false pre-v7 API values. Until that succeeds, migrated rows remain unknown rather than falsely zero.
- External SQL is intentionally affected: queries using `= 0` must use `IS NULL` for unknown or `COALESCE` only when the report explicitly chooses an unknown-as-zero policy.

## Resume and Checkpoint Impact

Current item resume records only list `page` and `itemIndex` (`packages/sdk/src/cache/item-indexer.service.ts:13-19,53-79`; `packages/cli/src/commands/cache/full-resume-checkpoint.ts:38-52,214-218`). The CLI marks the item phase complete from counts/watermark evidence (`packages/cli/src/commands/cache/full-resume-checkpoint.ts:109-115`; snapshot capture `packages/cli/src/commands/cache/cache.commands.ts:830-875`).

Recommended implementation preserves that checkpoint shape:

1. For one item, fetch and validate every variation page with `include=locations` before either `insertItem` or `replaceItemStockLocations`.
2. Keep the pre-item checkpoint until all item and stock writes complete; only then advance `itemIndex` (`packages/sdk/src/cache/item-indexer.service.ts:53-70`).
3. On failure, existing item/page resume retries the entire item, preventing partial variation pagination from becoming authoritative. No variation cursor belongs in the checkpoint if an item remains the atomic resume unit.
4. Schema v7 automatically rejects old checkpoints because the store binds checkpoint and phase evidence to schema version (`packages/cli/src/commands/cache/cache.commands.ts:111-125`; `packages/cli/src/commands/cache/full-resume-checkpoint.ts:309-329`). Users receive existing `--reset-checkpoint` guidance (`packages/cli/src/commands/cache/full-resume-checkpoint.ts:341-345`). Checkpoint file version need not change if its shape does not change.
5. If implementation writes variation pages incrementally, the checkpoint must gain variation page/cursor plus a version bump; otherwise resume can certify a partial item. This is not recommended.

Current v3 has no documented delta filter. The normal `modifiedSince` path cannot be treated as v3-complete. Full-resume remains compatible with validated full item snapshots; normal sync needs either a safe hybrid v2 hint plus periodic v3 full validation or v3 full snapshot semantics.

## Exact Affected Files

### Production changes required

- `packages/sdk/src/types/items.types.ts` — express v3 item, variation, variation-location, flat category, nullable/source-specific stock fields.
- `packages/sdk/src/resources/items.resource.ts` — normalize v3 list/detail envelopes and expose variation list/detail with `include=locations`; request archive coverage in the sync adapter.
- `packages/sdk/src/types/categories.types.ts` — express v3 category fields/envelope; v2-only cache fields become nullable at normalization.
- `packages/sdk/src/resources/categories.resource.ts` — v3 `/item-categories` list/pagination normalization.
- `packages/sdk/src/cache/item-indexer.service.ts` — remove four fabrications, map parent versus variation/location authority, use stable v3 variation-location ID, validate before writes, map flat category fallback, request archive-complete source.
- `packages/sdk/src/cache/types.ts` — nullable four stock measures; schema v7; category metadata schema coupling.
- `packages/sdk/src/cache/sqlite-cache.service.ts` — v7 stock-table rebuild, API false-value cleanup, null-preserving normalization.
- `packages/sdk/src/cache/postgres-cache.service.ts` — nullable schema migration, one-time API cleanup, null-preserving write/read coercion.
- `packages/cli/src/commands/cache/cache.commands.ts` — only if v3 sync selection/full-snapshot orchestration is not encapsulated by resources/indexer; retain category-before-item and schema-bound checkpoint order.

### Production files verified but no direct change required for narrow correction

- `packages/sdk/src/cache/cache.interface.ts` — method surface already transports item/stock rows; imported row types carry nullability.
- `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts` — already copies complete rows atomically; backend/type corrections suffice.
- `packages/sdk/src/cache/csv-cache-import.service.ts` — preserve CSV source values and API category precedence; no numeric API consumer.
- `packages/cli/src/commands/analytics/customers.command.ts` — reads item name only.
- `packages/cli/src/commands/analytics/inventory.command.ts` — live API stock path; separate false-zero fallback noted above.
- `packages/cli/src/commands/items/items.commands.ts` — raw resource passthrough.
- `packages/cli/src/commands/cache/full-resume-checkpoint.ts` — no change if item remains atomic and schema version invalidates prior checkpoints.

## Existing Tests and Gaps

| Existing test | What it protects | Missing assertion |
| --- | --- | --- |
| `packages/sdk/src/resources/__tests__/items.resource.test.ts:17-75` | Wrapped/bare detail and malformed-body retry | v3 list/data/pagination, flat item fields, variation locations, archived-all request. |
| `packages/sdk/src/cache/__tests__/archive-state-indexers.test.ts:29-41` | Item archive true/false/unknown mapping | Archived discovery from active+archived snapshot. |
| `packages/sdk/src/cache/__tests__/category-indexer.service.test.ts:12-127,129-145` | Atomic category snapshot validation and canonical-name precedence | v3 category envelope/field normalization and flat item-name fallback. |
| `packages/sdk/src/cache/__tests__/sync-resume-indexers.test.ts:119-160` | Item detail failure stops before fallback write and resumes same item | Multi-page variation fetch failure before writes; complete-source quantity mapping on retry. |
| `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts:34-142,222-230` | Schema upgrades, nullable archive, archive preservation | v6-to-v7 stock table rebuild, API-only null cleanup, CSV preservation, null CRUD. |
| `packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts:78-104` | Idempotent schema repair/category/binding | Drop stock defaults/not-null, one-time migration marker, null-preserving coercion. |
| `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts:266-365` | Full atomic mirror of stock/archive rows | Null four-field round trip PG -> SQLite. |
| `packages/sdk/src/cache/__tests__/csv-cache-import.service.test.ts:47-94` and `csv-category-semantics.test.ts:8-46` | Unknown/archive/category source precedence | Corrected API sync must not relabel CSV numeric stock as authoritative API data before replacement succeeds. |
| `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts:125-150` | Schema identity rejection/reset guidance | Current schema -> v7 checkpoint incompatibility and item-atomic variation retry. |

## Narrow Test Plan

1. Resource contract: v3 list normalizes `data`/`pagination`; detail preserves `archived`, flat category, reserved/incoming; variations with `include=locations` preserve all source fields and `item_variation_location_id`.
2. Mapper unit: parent item maps reserved/incoming; unavailable parent available/in-transit are null; variation-location maps reserved/incoming/in-transit; available is null unless a documented `location_inventory` source exists; flat category fallback only without authoritative snapshot; archive tri-state unchanged.
3. Malformed source: required v3 `quantity` missing/non-numeric aborts before item/stock writes; do not default to zero.
4. SQLite migration: genuine v6 fixture with API and CSV rows upgrades to v7; four API fields become null; CSV fields remain numeric; FK/index/row counts preserved; migration atomic on injected failure.
5. PostgreSQL migration: SQL drops four defaults/not-null, executes API cleanup once, and repeated `ensureSchema()` does not erase newly synced authoritative API values.
6. Backend CRUD: insert/get/batch/replace round-trip each field as `0`, nonzero, and `null`; PG `null` remains JS null.
7. Mirror: mixed null/zero/nonzero rows copy PostgreSQL -> SQLite exactly.
8. Archive/category: `archived=all` list contains both states; category snapshot still wins over embedded name; no-snapshot flat name survives.
9. Resume: failure on a later variation page makes no writes and retains current item checkpoint; retry writes full item once and advances checkpoint; old schema checkpoint rejects with reset guidance.
10. Run focused suites, then `pnpm build`, SDK tests, CLI checkpoint/cache tests, lint.

## Unresolved Questions

- Business choice required: should normal v3 `cache sync` perform a full item/variation snapshot every run, or use v2 delta hints with a scheduled v3 full validation? Official v3 provides no safe delta contract. Recommended default: full validated v3 snapshot for correctness; hybrid only as an explicitly documented optimization.
- Visibility boundary: v3 variation totals and locations reflect the API user's assigned-location visibility. Confirm whether one shared cache is intended to represent that credential's visible inventory or account-global inventory. Recommended default: bind/source-label the cache to the credential visibility scope and never present partial totals as account-global.
- CSV blank numeric meaning is not documented in repo. Preserve current CSV behavior in this change; decide separately whether blank export cells should be null rather than zero.
