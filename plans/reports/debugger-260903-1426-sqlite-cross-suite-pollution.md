# SQLite Cross-Suite Pollution - Investigation Report

## Executive Summary

- **Issue:** `sqlite-cache.service.test.ts` original `.rejects.toThrow(/no such table: items/i)` failed only after `pg-to-sqlite-sync.test.ts` initialized SQLite first.
- **Impact:** False Jest failure. SQLite inventory authority behavior still throws on missing storage table.
- **Root cause:** `better-sqlite3` native addon keeps first `SqliteError` constructor process-wide. In later Jest VM, thrown native errors can be from prior realm, so Jest `toThrow` fails error recognition.
- **Status:** Validated. Current local test change avoids fragile matcher and passes forced order.
- **Fix:** Match captured rejection object/message, same as existing category storage failure test.

## Evidence

- Original reproducer failed before current local test change:
  - Command from `packages/sdk`: `pnpm exec jest --runInBand --no-cache --testSequencer ./test-order-sequencer.cjs --runTestsByPath src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-cache.service.test.ts -t 'mirrors documents with null or zero modified values|propagates inventory storage failures'`
  - Failure: `Expected pattern: /no such table: items/i`; `Received function did not throw`.
- Current forced-order verification using external temp sequencer:
  - `pnpm exec jest --runInBand --no-cache --testSequencer /private/tmp/salesbinder-pg-first-test-order-sequencer.cjs --runTestsByPath src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-cache.service.test.ts -t 'mirrors documents with null or zero modified values|propagates inventory storage failures'`
  - Result: both targeted suites passed; 2 passed, 140 skipped.
- Current focused SQLite storage tests:
  - `pnpm exec jest --runInBand --no-cache --runTestsByPath src/cache/__tests__/sqlite-cache.service.test.ts -t 'propagates category storage failures|propagates inventory storage failures'`
  - Result: both storage failure tests passed.
- Runtime shape of a normal `better-sqlite3` error:
  - `{ name: "SqliteError", message: "no such table: missing", tag: "[object Object]", instanceofError: true, constructorName: "SqliteError", hasStack: true }`

## Root Cause

- `better-sqlite3/lib/database.js` initializes the native addon once:
  - `if (!addon.isInitialized) { addon.setErrorConstructor(SqliteError); addon.isInitialized = true; }`
- Native throws instantiate that stored constructor in `src/objects/database.cpp`.
- `SqliteError` is custom and reports `Object.prototype.toString.call(error) === "[object Object]"`; it is only recognized as Error by `instanceof Error` in same realm.
- Jest `expect(...).rejects.toThrow(...)` uses `toThrowMatchers.createMatcher(..., true)`:
  - It treats rejected value as thrown only if `@jest/expect-utils.isError(received)`.
  - `isError` falls back to `value instanceof Error` after tag checks.
  - Cross-realm `SqliteError` misses both checks, so matcher leaves `thrown = null`.
  - RegExp path then prints `Received function did not throw`.

## SQLite Authority State

- No durable SQLite authority leak found.
- Target test writes inventory snapshot, then verifies `getInventoryCacheMeta()` equals snapshot metadata before dropping `items`.
- `SQLiteCacheService.getInventoryCacheMeta()` calls `readAuthoritativeInventorySnapshot()`.
- `readAuthoritativeInventoryMeta()` reaches `inventoryCountsMatch()` only when cache state and inventory metadata authority exist.
- `inventoryCountsMatch()` prepares `SELECT ... FROM items`; after `DROP TABLE items`, real service behavior is `SqliteError: no such table: items`.
- Current manual outcome assertion confirms the thrown error instead of a missing-authority null.

## Impacted Files and Lines

- `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts:559-634`
  - Initializes `better-sqlite3` and mocks/restores service prototypes. No `getInventoryCacheMeta` or `replaceInventorySnapshot` mock found.
- `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts:693-699`
  - Temporarily restores real `replaceMirror()` for the selected pull test.
- `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts:1464-1481`
  - Inventory storage failure assertion. Current local version uses captured outcome/message assertion.
- `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts:645-662`
  - Existing category storage failure test already uses same robust pattern.
- `packages/sdk/src/cache/sqlite-cache.service.ts:1171-1173`
  - `getInventoryCacheMeta()` transaction wrapper.
- `packages/sdk/src/cache/sqlite-cache.service.ts:1737-1763`
  - Reads authoritative inventory metadata and validates row counts.
- `packages/sdk/src/cache/sqlite-cache.service.ts:1932-1956`
  - Queries `items` and `item_stock_locations`; missing table throws real storage error.

## Recommended Fix

- Keep the inventory test aligned with category storage failure test:
  - capture `value` or `error` via `.then(success, failure)`;
  - assert `error: expect.objectContaining({ message: expect.stringMatching(/no such table: items/i) })`.
- Do not change production SQLite service for this failure. Service behavior is correct; assertion was over-specific to Jest's cross-realm error recognition.
- Alternative lower-scope assertion: `await expect(promise).rejects.toMatchObject({ message: expect.stringMatching(...) })`, but current category-aligned manual outcome is clearer and avoids `rejects.toThrow` entirely.

## Verification

- Forced pg-before-sqlite targeted order passes with current assertion.
- Focused category + inventory storage failure tests pass.
- Temporary original lead sequencer was removed during shared-worktree work, so verification used `/private/tmp/salesbinder-pg-first-test-order-sequencer.cjs`.

## Unresolved Questions

- None.
