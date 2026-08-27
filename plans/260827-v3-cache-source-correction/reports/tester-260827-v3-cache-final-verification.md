# Tester Report - 2026-08-27 - v3 cache source correction

## Result

PASS. No blocking findings.

## Commands

- `pnpm test`
  - SDK: 21 suites passed, 319 tests passed
  - CLI: 2 suites passed, 22 tests passed
- `pnpm build`
  - SDK `tsc`: pass
  - CLI `tsc`: pass
- `pnpm lint`
  - Exit 0
  - SDK: 16 warnings, 0 errors
  - CLI: pass
- `git diff --check`
  - Pass, no whitespace errors
- Focused SDK regression subset:
  - Command: `pnpm --filter @salesbinder/sdk test -- --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/resources/__tests__/v3-items.resource.test.ts src/resources/__tests__/v3-categories.resource.test.ts src/client/__tests__/v3-axios.factory.test.ts`
  - 8 suites passed, 125 tests passed
- Focused CLI checkpoint subset:
  - Command: `pnpm --filter @salesbinder/cli test -- --runInBand --silent src/commands/cache/full-resume-checkpoint.test.ts`
  - 1 suite passed, 19 tests passed

## Specific Checks

- v2 unknown stock: verified `ItemIndexerService` maps observed reserved/available/incoming/in-transit only; missing fields stay `null`. Regression test covers old false-zero behavior.
- v3 archived coverage: verified `V3InventoryIndexerService` calls item list with `{ archived: 'all' }`.
- v3 variation/location balances: verified variation calls use `{ include: 'locations' }`; normalizer preserves reserved/incoming/in-transit and leaves unavailable `quantity_available` as `null`.
- SQLite v6 to v7: verified table rebuild makes four stock fields nullable/no default, nulls API rows, preserves CSV rows, keeps FK/indexes, and sets schema 7.
- PostgreSQL migration semantics: verified tests assert nullable DDL, default/NOT NULL drops, one-time `schema.v7.inventory-nullability-migrated` marker, API-row nulling, CSV preservation, binding-before-write, and null-preserving read coercion. Existing spec review records disposable PG14/PG16 migration smoke passed; not recreated.
- Atomic snapshots: verified v3 fetch/normalization completes before backend publish; SQLite and PG `replaceInventorySnapshot` write rows, metadata, and state in transactions and roll back metadata failures.
- Mirror metadata: verified PG to SQLite mirror passes `inventoryCacheMeta`; SQLite validates matching rows before replacing and writes metadata atomically.
- Checkpoint inventory fingerprint: verified checkpoint v4 includes inventory status/schema/source/generation/fingerprint and rejects same-count inventory content changes.
- Source provenance: verified v3 rows require `source_api_version: '3'`; category metadata records `sourceApiVersion`; cache status includes inventory authority metadata.
- Fake-zero scan: production leftovers for zero defaults are outside the corrected four API balances: CSV importer still treats blank export numerics as zero by existing policy; `quantity_on_hand` remains required/defaulted as before.

## Findings

None.

## Unresolved Questions

None.
