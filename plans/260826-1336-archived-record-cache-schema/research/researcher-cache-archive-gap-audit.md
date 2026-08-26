# Cache Archived/Lifecycle Gap Audit

Date: 2026-08-26
Scope: repository cache schema/data flows only. Read-only source audit. Report path only modified.

## Summary

Cache schema version is `3` (`packages/sdk/src/cache/types.ts:149`). Current durable archive support exists only for accounts/customers/suppliers: `AccountRow.archived`, `accounts.archived`, `idx_accounts_archived`, API account indexer mapping, and CSV account import.

Missing cache fields for an archived/lifecycle schema update:

- `DocumentRow.archived` + `documents.archived` only if SalesBinder documents expose archive state. Current repo wire type does not expose it.
- `Item.archived`, `ItemRow.archived`, `items.archived`.
- `ItemStockLocationRow.archived` / `item_archived` only if stock rows must stand alone without joining `items`; current repo has no stock-location archive source.
- Optional tombstone/deleted-log table only if deleted record audit/history required. Current deleted-log sync hard-deletes cache rows.

Docs wire answer: `Document` currently does not expose `archived`; it exposes `status_id`, optional `status`, and derived cache `is_cancelled` only (`packages/sdk/src/types/documents.types.ts:52-87`, `packages/sdk/src/cache/document-indexer.service.ts:336-363`).

## Existing Schema Inventory

Types:

- `DocumentRow`: no `archived`; has `status_id`, `status_name`, `is_cancelled` (`packages/sdk/src/cache/types.ts:6-37`).
- `AccountRow`: has `archived?: number` (`packages/sdk/src/cache/types.ts:60-90`).
- `ItemRow`: no `archived`; has `published` only (`packages/sdk/src/cache/types.ts:93-117`).
- `ItemStockLocationRow`: no lifecycle/archive field (`packages/sdk/src/cache/types.ts:120-140`).
- `CacheState.schemaVersion`: version metadata (`packages/sdk/src/cache/types.ts:151-167`).

SQLite:

- Column arrays: `DOCUMENT_COLUMNS` no archive (`sqlite-cache.service.ts:30-38`); `ACCOUNT_COLUMNS` includes `archived` (`:46-53`); `ITEM_COLUMNS` no archive (`:55-60`); `STOCK_COLUMNS` no archive (`:62-67`).
- `accounts.archived INTEGER NOT NULL DEFAULT 0` (`:122-151`).
- `documents` has `status_id`, `status_name`, `is_cancelled`; no `archived` (`:154-185`).
- `items` has `published`; no `archived` (`:208-231`).
- `item_stock_locations` has no archive/lifecycle field (`:234-254`).
- `idx_accounts_archived` only archive index (`:372-375`).
- Migration: `initializeSchema()` sets `PRAGMA user_version = CACHE_SCHEMA_VERSION`; `migrateSchema()` handles `<2` document/item-document columns and `<3` payment table only (`:106-117`, `:274-295`). New archive fields require version `4` plus `addColumnsIfMissing()` calls for every touched table.

PostgreSQL:

- Column arrays mirror SQLite: documents/items/stock no archive; accounts includes archive (`postgres-cache.service.ts:25-62`).
- `accounts.archived INTEGER NOT NULL DEFAULT 0` (`:77-107`).
- `documents`, `items`, `item_stock_locations` have no archive columns in base CREATE (`:109-173`).
- Existing PG migration only alters `documents` and `item_documents` (`:191-238`). It does not run account/item/stock migration helpers.
- Indexes: `idx_accounts_archived` only (`:241-268`).
- No DB schema version table/user_version equivalent for PG; schema evolves by idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

## Source Mapping Matrix

| Entity | Current source field | Current cache field | Writer | Gap |
|---|---|---|---|---|
| Accounts/customers/suppliers | `Customer.archived?: boolean` (`customers.types.ts:8-36`) | `accounts.archived` | API: `AccountIndexerService.toAccountRow()` maps bool to 1/0 (`account-indexer.service.ts:67-101`); CSV reads `Archived` (`csv-cache-import.service.ts:22-29`, `:225-252`) | Covered, but no query helpers filter/report it. |
| Documents | no `Document.archived`; status only (`documents.types.ts:52-87`) | `status_id`, `status_name`, `is_cancelled` | `DocumentIndexerService.processDocument()` maps status/cancelled only (`document-indexer.service.ts:330-363`) | Cannot populate `documents.archived` until wire type/source verified. Add optional field only after API/export evidence. |
| Items | no `Item.archived`; `published?: boolean` only (`items.types.ts:8-35`) | no item archive | `ItemIndexerService.toItemRow()` maps item fields without archive (`item-indexer.service.ts:71-90`) | Add `Item.archived`, `ItemRow.archived`, SQL column, column arrays, normalization, index. |
| Stock locations | no `ItemVariationLocation.archived`; location resource no archive (`items.types.ts:44-50`, `locations.types.ts:8-25`) | no stock archive | `toStockRows()` / `toStockRow()` map quantities/location only (`item-indexer.service.ts:93-143`) | Decide join-to-item vs denormalized `item_archived`; no direct source for stock-location archive. |
| CSV accounts | `Archived` required header | `accounts.archived` | `readAccounts()` (`csv-cache-import.service.ts:225-252`) | Covered; tests do not assert value. |
| CSV inventory | no `Archived` header in `INVENTORY_HEADERS` (`csv-cache-import.service.ts:44-49`) | no item/stock archive | `readInventory()` (`:255-319`) | Add optional header support if exports include item archive; do not make required unless all fixture/export sources have it. |
| CSV documents | invoice/PO headers no lifecycle/archive (`csv-cache-import.service.ts:31-42`) | status fields often null; `mergeDocument()` preserves API status/cancelled (`:456-467`) | `readDocuments()` (`:322-380`) | No CSV document archive source. |
| Deleted log | `DeletedLogEntry.context_id`, `record_id` (`deleted-log.types.ts:3-18`) | none; rows removed | `DeletedLogSyncService.deleteCachedRecord()` hard-deletes accounts/items/documents (`deleted-log-sync.service.ts:25-32`, `:70-83`) | Add tombstones only if deleted history required; archive is not deletion. |

## Callers/Consumers To Cover

Write paths:

- `cache sync`: constructs `AccountIndexerService`, `DocumentIndexerService`, `ItemIndexerService`, `DeletedLogSyncService` (`packages/cli/src/commands/cache/cache.commands.ts:97-106`).
- API account archive mapping call: `batchInsertAccounts()` from account indexer (`account-indexer.service.ts:53`).
- API item writes: `insertItem()` and `replaceItemStockLocations()` (`item-indexer.service.ts:48-49`).
- API document writes: `insertDocument()` and `batchInsertItemDocuments()` (`document-indexer.service.ts:390-399`).
- CSV import writes all major tables: accounts/items/stock/documents/line items (`csv-cache-import.service.ts:163-171`).
- Deleted-log sync hard-deletes: accounts, items, documents (`deleted-log-sync.service.ts:70-83`).

Mirror paths:

- PG -> SQLite pulls all documents, line items, payments, accounts, items, stock rows (`pg-to-sqlite-sync.service.ts:57-65`) then re-inserts into SQLite (`:70-88`) and copies state/payment metadata (`:90-98`).
- Master table fields will copy automatically once row interfaces, PG `SELECT *` helpers, SQLite column arrays, and PG column arrays include new fields.
- `getAllItemDocuments()` manually rehydrates line-item fields (`pg-to-sqlite-sync.service.ts:145-175`); update only if line-item lifecycle fields are added.

Read/query paths needing policy decision:

- Cache helper SQL joins no archive filters today: SQLite methods at `sqlite-cache.service.ts:618-699`; PG methods at `postgres-cache.service.ts:479-576`.
- CLI analytics consumers: `item-sales` uses latest dates and invoice line period (`item-sales.command.ts:102-118`); `inventory` uses sales period (`inventory.command.ts:125`); `trends` uses sales period (`trends.command.ts:120`); `forecast` uses monthly sales (`forecast.command.ts:119`); `pricing` uses price distribution (`pricing.command.ts:119`); `customers` uses cached item + customer sales (`customers.command.ts:118`, `:137`); `patterns` uses order patterns (`patterns.command.ts:134`).
- Payment backfill consumes invoice cache via `getDocumentsByContext(DocumentContextId.Invoice)` twice (`payment-sync.service.ts:31`, `:89`). Decide whether archived/cancelled invoices still need payment refresh.
- Cache status `collectCacheCounts()` reports aggregate counts only (`cache.commands.ts:598-638`). Add archived/active counts only if user-visible status output is in scope.

Observed callsite counts by `rg`:

- `archived`: 12 matches total across scoped files; only accounts path has real storage/query index.
- Analytics cache helper use in CLI: 10 calls across 6 analytics commands.
- Core cache writer calls in scoped source: account API 1, item API 2, document API 2, CSV 5, deleted-log 4, mirror 6.
- API resource calls in source/CLI: documents 7, items 6, customers 5, deleted-log 1 in the broad source/CLI scan.

## Required Update Surface

Minimum item archive implementation:

- Add `archived?: boolean` to `Item` wire type if SalesBinder v2 item response confirmed.
- Add `archived?: number` to `ItemRow`.
- Add `archived` to `ITEM_COLUMNS` in SQLite and PG.
- Add `items.archived INTEGER NOT NULL DEFAULT 0` to SQLite and PG create SQL.
- Add SQLite v4 migration: `ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`; `CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived)`.
- Add PG migration helper for `items` with `ADD COLUMN IF NOT EXISTS archived INTEGER NOT NULL DEFAULT 0`; create same index.
- Map `ItemIndexerService.toItemRow()` from API boolean; default 0 in `normalizeItem()`.
- CSV inventory: support optional `Archived` column; map aggregate item archive deterministically.
- Tests: schema columns/migration, API item mapping, CSV optional header, analytics behavior.

Conditional document archive implementation:

- Only after source verification: add `archived?: boolean` to `Document`, `archived?: number` to `DocumentRow`, `documents.archived`, column arrays, SQLite v4 migration, PG document migration, `idx_documents_archived`.
- Map in `DocumentIndexerService.processDocument()`.
- Add CSV support only if export header exists; otherwise default API rows from API, CSV rows to 0/null per chosen semantics.
- Update `mergeDocument()` to preserve API archive when CSV reimports.

Stock-location strategy:

- Preferred minimal: do not add stock-row archive unless direct source exists. Filter/join stock reports via `items.archived`.
- If standalone stock rows must carry lifecycle: add `item_archived INTEGER NOT NULL DEFAULT 0` to `item_stock_locations`, map from parent item in `toStockRows()` and CSV inventory aggregate, migrate SQLite/PG, add index only if queries filter by it.

Deleted lifecycle strategy:

- Keep current hard-delete for cache correctness if only current active cache matters.
- If audit/history required, add `cache_deleted_records(context_id, record_id, deleted_at, source_created, synced_at)` and have deleted-log sync upsert tombstones before hard delete. Do not overload `archived` for deleted state.

## Test Impact

Must add/adjust:

- `sqlite-cache.service.test.ts`: version 3 -> 4 migration preserving data; new columns on `items`/conditional `documents`/optional `item_stock_locations`; default 0; indexes.
- PG schema tests are absent. Add a focused test or integration harness if available; otherwise at least centralize DDL expectations and validate via build.
- `csv-cache-import.service.test.ts`: assert account archived value; add inventory archived fixture only if header support added; assert old fixture without item archive remains valid.
- Add tests for `ItemIndexerService.toItemRow()` behavior. No current direct item/account/document indexer test coverage found except payment freshness on `DocumentIndexerService`.
- If query semantics change, update SQLite analytics tests around `getItemSalesByPeriod`, `getItemPriceDistribution`, `getItemSalesByCustomer`, `getItemSalesByMonth`, `getLatestItemDocumentDate`, `getItemOrderPatterns`.
- If payment backfill excludes archived invoices, update `payment-sync.service.test.ts` fixture and snapshot/hash behavior.

Verification commands after implementation:

- `pnpm --filter @salesbinder/sdk test -- --runInBand`
- `pnpm --filter @salesbinder/sdk build`
- Broaden to root `pnpm build` if exported types changed for CLI.

## Rollback And Backfill

Recommended rollout:

1. Bump SQLite `CACHE_SCHEMA_VERSION` to 4.
2. Add nullable/defaulted integer archive columns with `DEFAULT 0`; additive only.
3. Backfill existing rows to active (`0`) during migration. This preserves current analytics output until next API/CSV sync populates true archive values.
4. Run a full `cache sync --full` or CSV import to populate item/document archive values from authoritative source.
5. Keep deleted-log hard delete unchanged unless tombstone history accepted.

Rollback:

- Code rollback can ignore additive columns. SQLite `DROP COLUMN` unnecessary and risky; leave columns in place.
- PG rollback can leave additive columns/indexes in place; removing them is not needed for functional rollback.
- If query semantics are changed to exclude archived rows, rollback is code-only by removing predicates; data remains.

## Dirty Worktree Separation

Pre-existing uncommitted edits are broad cache payment-sync work:

- Modified files include README, cache commands, cache services/interfaces, indexers, `documents.types.ts`, and tests.
- New untracked payment-sync files: `cache-payment-sync.command.ts`, `payment-sync.service.ts`, `payment-sync.helpers.ts`, `payment-sync.types.ts`, `payment-cache.constants.ts`, and `payment-sync.service.test.ts`.
- Diff scan shows uncommitted source changes are payment transaction/status additions plus `CACHE_SCHEMA_VERSION` extraction; no current uncommitted archive-field implementation beyond pre-existing account archive support.

## Unresolved Questions

- Does SalesBinder v2 item API currently return `archived` for `/items.json` list/detail?
- Does SalesBinder v2 document API currently return `archived` for `/documents.json` list/detail, or is status/cancelled the only lifecycle signal?
- Should analytics include archived items/documents historically by default, or exclude them unless explicitly requested?
- Should archived invoices still participate in payment backfill?
- Is a deleted-record tombstone/audit trail required, or is current hard-delete cache behavior acceptable?
- Do current inventory/document CSV exports include optional `Archived` columns outside the checked fixtures?

Status: DONE
Summary: Audited cache schema/data flows and wrote exact gap inventory to the assigned report path.
Concerns/Blockers: No source changes made. Main uncertainty is upstream/export availability of document and item archive fields; repo wire types currently confirm only accounts expose `archived`.
