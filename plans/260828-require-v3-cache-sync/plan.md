---
title: "Require v3 For Cache Sync Snapshots"
description: "Make cache sync fail before cache mutation when v3ApiKey is absent, while preserving v2 clients for non-inventory sync phases."
status: complete
priority: P1
effort: 2h
branch: main
tags: [cache, cli, api-v3, inventory, categories]
created: 2026-08-28
blockedBy: []
blocks: []
---

# Require v3 For Cache Sync Snapshots

## Outcome

`salesbinder cache sync` must require SalesBinder API v3 for category and inventory cache snapshots. If the selected account has no `v3ApiKey`, the command fails with a clear error before creating or mutating any cache backend state. Accounts, documents, and deleted-log sync keep using the existing v2 `SalesBinderClient`.

## Current Evidence

- `README.md` currently documents `v3ApiKey` as optional and says cache sync keeps a v2 inventory/category fallback when absent. That user-facing contract must change.
- `packages/cli/src/commands/cache/cache.commands.ts:83` loads account config, then `:86` creates `v3Client` only when `v3ApiKey` exists.
- `cache.commands.ts:154` currently constructs `CategoryIndexerService` with `v3Client ?? client`, and `:168` chooses `V3InventoryIndexerService` or `ItemIndexerService`. Those are the v2 fallback branches to remove for cache snapshots.
- `cache.commands.ts:90-147` selects/opens the backend, ensures account binding, acquires the writer lock, and writes running sync status. The missing-key guard must run before this block.
- `cache.commands.ts:153`, `:160`, and `:171` already keep v2 clients for accounts, documents, and deleted-log. Preserve those.
- `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:6` mocks config without `v3ApiKey`, and `:108-129` mocks the SDK without v3 constructors. Existing tests need updating to represent the new required key for successful `cache sync`.
- Read-only live v3 smoke already passed for item listing with `archived=all`, category listing, and variation listing with `include=locations`. The credential stayed in process memory, no response records were printed, and no write request was sent.

## Constraints

- Do not remove or weaken v2 behavior outside cache category/inventory snapshots.
- Do not add a v2 fallback for category or inventory cache snapshots.
- Do not access, print, or document any real credential values.
- Preserve existing dirty work and unrelated plan directories.
- Keep the change small; no schema migration, no new API client, no broad refactor.

## Non-Goals

- No full CLI migration to v3 CRUD.
- No changes to accounts, documents, payment sync, deleted-log, import/export, cache pull, or cache clear behavior except test fixture updates required by `cache sync`.
- No live SalesBinder or PostgreSQL mutation smoke in this plan.

## Implementation

1. In `packages/cli/src/commands/cache/cache.commands.ts`, after `loadConfig(accountName)` and before `createPostgresCacheService()`, validate `accountConfig.v3ApiKey`.
2. If absent, throw a clear actionable error, for example: `SalesBinder API v3 key is required for cache sync category and inventory snapshots. Add v3ApiKey to this account config or rerun config:init with --v3-api-key.`
3. Instantiate `SalesBinderV3Client` only after the guard; make `v3Client` non-null for the rest of the sync path.
4. Construct `CategoryIndexerService` with `v3Client` and source version `'3'`.
5. Construct `V3InventoryIndexerService` unconditionally for the items phase.
6. Keep `SalesBinderClient` for `AccountIndexerService`, `DocumentIndexerService`, and `DeletedLogSyncService`.
7. Update sync output so `inventory_source_api_version` is always `'3'` on successful `cache sync`.
8. Update `README.md` cache/config wording: `v3ApiKey` is required for `cache sync`; `apiKey` remains required for v2 account/document/deleted-log endpoints.

## Exact Files

- Modify: `packages/cli/src/commands/cache/cache.commands.ts`
- Modify: `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`
- Modify: `README.md`
- Do not modify SDK v2 clients, SDK v3 clients, schema files, or cache services unless tests reveal a direct compile contract mismatch.

## Tests

- Update the successful `cache sync --pull` test fixture so `mockLoadConfig` returns both `subdomain` and a truthy placeholder `v3ApiKey`.
- Add SDK mocks for `SalesBinderV3Client` and `V3InventoryIndexerService`; assert successful sync phase order remains `accounts`, `categories`, `documents`, `items`, `deleted-log`.
- Add a missing-`v3ApiKey` test for `cache sync` that asserts:
  - `process.exitCode` becomes `1`;
  - error text explains v3 is required for category/inventory cache snapshots;
  - `createPostgresCacheService` is not called;
  - no backend binding, lock, `setSyncStatus`, category sync, item sync, or pull starts.
- Preserve existing `cache clear` tests where config without `v3ApiKey` remains valid.
- Run focused test: `pnpm --filter @salesbinder/cli test -- --runTestsByPath packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`.
- Run compile gates after source edits: `pnpm --filter @salesbinder/sdk build` and `pnpm --filter @salesbinder/cli build`.

## Rollback

Rollback is a small source/test/docs revert: restore the optional `v3Client` branch in `cache.commands.ts`, restore the test fixture to omit `v3ApiKey`, and restore README wording that describes v2 fallback. No database downgrade or cache data rollback is required because the new guard happens before cache backend mutation.

## Acceptance Criteria

- `salesbinder cache sync` fails before cache mutation when the selected account lacks `v3ApiKey`.
- Successful cache sync uses v3 for both categories and inventory with no v2 fallback path.
- v2 clients remain in place for accounts, documents, and deleted-log sync.
- CLI tests prove both the pre-mutation failure and the successful v3-only sync path.
- README accurately documents the required v3 key for cache sync.

## Docs Impact

Minor. Update only README cache/config wording because the user-facing setup contract changes.

## Verification

- Live read-only API v3 smoke passed for items with archive coverage, categories, and variations with locations.
- Missing-key binary smoke exited non-zero with the documented error before backend/API work.
- Full suite passed: SDK 335 tests and CLI 38 tests.
- Build and lint passed; lint has 16 pre-existing SDK warnings and no errors.
- Independent tester passed; final code review approved with no remaining findings.

## Unresolved Questions

None.
