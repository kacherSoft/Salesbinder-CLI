# Transport / Orchestration Review

Date: 2026-08-27
Target: uncommitted v3 cache source-correction diff vs `origin/main`
Reviewer: sol

## Scope

- Files reviewed: v3 transport/resources, category and inventory indexers/normalizers, SQLite/PostgreSQL cache services, PG -> SQLite mirror, cache CLI orchestration, full-resume checkpoint, config commands, README.
- Excluded: unrelated user-owned `plans/260724-1358-salesbinder-api-v3-migration/`.
- Diff scale: 42 changed files, 4902 insertions, 226 deletions.
- External contract spot-check: official SalesBinder v3 docs confirm Bearer auth, `/api/v3`, standard pagination, `archived=all`, variation `include=locations`, item-category list, and location visibility:
  - https://www.salesbinder.com/api/v3/authentication/
  - https://www.salesbinder.com/api/v3/pagination/
  - https://www.salesbinder.com/api/v3/items/
  - https://www.salesbinder.com/api/v3/item-categories/
  - https://www.salesbinder.com/api/v3/locations/

## Overall Assessment

The core source-correction is mostly sound: v3 uses separate Bearer transport, v2 account/document/deleted-log paths stay on the existing client, v3 item sync requests `archived=all`, v3 variation calls use `include=locations`, unknown stock fields round-trip as `NULL`, and config listing does not print API keys.

I found no critical secret leak or fallback false-zero regression. Main risks are authority claims around snapshots/checkpoints: page-based list races can still publish a mixed inventory/category snapshot, category reconciliation can make inventory fingerprint metadata stale, and full-resume can skip completed inventory when restarting from an in-progress deleted-log phase.

## Critical Issues

None.

## Important Issues

1. `packages/cli/src/commands/cache/full-resume-checkpoint.ts:256` - Restarting while `checkpoint.phase === 'deleted-log'` validates only category evidence and then returns. It does not validate completed `documents` or `items` evidence, even though item evidence now includes `inventoryGeneration` and `inventoryFingerprint` at `packages/cli/src/commands/cache/full-resume-checkpoint.ts:124-129`. In orchestration, completed phases are skipped at `packages/cli/src/commands/cache/cache.commands.ts:180-184`, so a changed/stale inventory snapshot can be skipped before `deletedLogSync.sync()` resumes.
   Impact: violates "checkpoint cannot incorrectly skip stale inventory"; a resumed full rebuild can finish with deleted-log evidence attached to an inventory snapshot that no longer matches the checkpointed item phase.
   Fix: in the `checkpoint.phase === 'deleted-log'` branch, validate every completed earlier phase needed for consistency, at minimum `categories`, `documents`, and `items` using `PHASE_FIELDS`. Add a regression test mirroring `rejects deleted-log resume when category authority changed`, but mutating `inventoryGeneration`/`inventoryFingerprint`.

2. `packages/sdk/src/cache/sqlite-cache.service.ts:1165` and `packages/sdk/src/cache/postgres-cache.service.ts:732` - `replaceCategorySnapshot` reconciles `items.category_name` and `item_stock_locations.category_name` after writing the category snapshot, but inventory authority metadata is neither invalidated nor recomputed. The inventory fingerprint is created from item and stock rows at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:186-205`; inventory metadata readers only check schema/source/counts (`sqlite-cache.service.ts:1205-1220`, `postgres-cache.service.ts:1528-1565`), not the fingerprint against current rows.
   Impact: candidate defect confirmed. A category rename/parent correction can change fingerprinted inventory row content while `getInventoryCacheMeta()` still returns the old "complete" inventory metadata. That undermines cache status and full-resume item evidence.
   Fix: either remove derived `category_name` from the inventory fingerprint, or better, invalidate/recompute inventory metadata whenever category reconciliation mutates API item/stock rows. Fail-closed option: delete `INVENTORY_SNAPSHOT_META_KEY` and clear `state.inventorySourceApiVersion` during category reconciliation; normal `cache sync` will immediately publish fresh inventory afterward.

3. `packages/sdk/src/cache/v3-inventory-indexer.service.ts:107` and `packages/sdk/src/cache/category-indexer.service.ts:38` - Complete snapshots validate count/pages/page size and duplicate IDs, but do not detect count-stable membership changes during page-based pagination. SalesBinder docs warn results can change while paging. A rename/create/delete pair can keep `total_records`, `total_pages`, and page sizes stable with no duplicate IDs while one old ID is missed and one new ID is included. The code then accepts `rows.length === expectedTotal` at `v3-inventory-indexer.service.ts:132-134` / `category-indexer.service.ts:61-62` and publishes as authoritative at `v3-inventory-indexer.service.ts:58` / `category-indexer.service.ts:90`.
   Impact: candidate defect confirmed. The snapshot can be internally count-complete but not represent a stable SalesBinder membership set; publishing it can drop or add API-owned cache rows incorrectly.
   Fix: add a stability pass before publish: fetch the paged ID set twice and require identical sorted IDs plus stable updated/category fields, retry bounded times on mismatch, then fetch details/variations for that stable item ID set. If that cannot be guaranteed with the API contract, downgrade metadata wording from authoritative point-in-time snapshot to best-effort paged snapshot and do not allow it to satisfy fail-closed checkpoint authority.

## Minor Issues

1. `README.md:135` says v3 sync fetches "items, variations, locations, and categories", but the implementation has v3 item/category resources only. Parent/direct-location stock rows set `location_name: null` at `packages/sdk/src/cache/v3-inventory-normalizer.ts:70-72`, and there is no `/api/v3/locations` resource or list call. Variation-managed rows do preserve embedded `location_name` at `v3-inventory-normalizer.ts:130-132`.
   Impact: README overstates the implemented locations contract, and direct-location item rows lose location names under v3. Quantities remain source-safe, but docs/status imply stronger coverage than code provides.
   Fix: either add a read-only v3 locations resource and pass an ID -> name map into the normalizer for parent/direct-location rows, or adjust README to say variation-location details come from `include=locations` and direct-location names are currently unknown.

## Candidate Defect Verdicts

- Count-stable pagination membership races: confirmed. Current validation rejects count/page-size/page-count changes and duplicate IDs, but not same-count membership drift across pages.
- Inventory metadata fingerprint stale after category reconciliation: confirmed. Reconciliation mutates fingerprinted row content without invalidating/recomputing inventory metadata.
- Fallback never fabricates v3-only balances: refuted. The v2 fallback now maps `quantity_reserved`, `quantity_available`, `quantity_incoming`, and `in_transit` with `observedNumber()` at `packages/sdk/src/cache/item-indexer.service.ts:102-106`, `136-139`, and `167-170`; missing values become `null` at `item-indexer.service.ts:206-210`. SQLite and PostgreSQL writers preserve `null` at `sqlite-cache.service.ts:1407-1416` and `postgres-cache.service.ts:1858-1867`, and PostgreSQL reads preserve DB nulls at `postgres-cache.service.ts:1913-1920`.

## Positive Observations

- v3 transport uses `/api/v3` and Bearer auth without `.json` suffixes (`packages/sdk/src/client/v3-axios.factory.ts:40-48`, `packages/sdk/src/resources/v3-items.resource.ts:21-40`, `packages/sdk/src/resources/v3-categories.resource.ts:15-28`).
- CLI selects v3 only when `v3ApiKey` exists and keeps v2 client for accounts/documents/deleted-log (`packages/cli/src/commands/cache/cache.commands.ts:80-170`).
- v3 item list requests `archived: 'all'` and variation list requests `include: 'locations'` (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:63-74`).
- Snapshot publish is transactional in both cache backends (`sqlite-cache.service.ts:832-878`, `postgres-cache.service.ts:1077-1139`).
- PostgreSQL account binding still verifies before writes (`postgres-cache.service.ts:656-689`, `1077-1079`).
- Config output reports only `has_v3_api_key`, not the key value (`packages/cli/src/commands/config/config.list.command.ts:50-64`); retry logs print request IDs/statuses only (`packages/sdk/src/client/v3-axios.factory.ts:82-84`).

## Verification

- `pnpm --filter @salesbinder/sdk test -- --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/resources/__tests__/v3-items.resource.test.ts src/resources/__tests__/v3-categories.resource.test.ts src/client/__tests__/v3-axios.factory.test.ts`
  - PASS: 8 suites, 125 tests.
- `pnpm --filter @salesbinder/cli test -- --runInBand --silent src/commands/cache/full-resume-checkpoint.test.ts`
  - PASS: 1 suite, 19 tests.
- `git diff --check -- ':!plans/260724-1358-salesbinder-api-v3-migration/**'`
  - PASS.

## Metrics

- Type coverage: not measured.
- Test coverage: not measured.
- Linting issues: not run by this reviewer; tester report says `pnpm lint` exit 0 with SDK warnings only.

## Unresolved Questions

None.

Status: DONE_WITH_CONCERNS
Summary: Review complete. Core v3 transport/nullability/fallback behavior is sound, but snapshot authority has three production-readiness gaps that should be fixed before landing.
Concerns/Blockers: Important checkpoint and metadata authority issues can let stale or mixed inventory appear authoritative; count-stable pagination drift remains possible under SalesBinder's documented page-based list behavior.

## Re-review - 2026-08-27

Target: current fixed worktree vs prior report. Scope unchanged; excluded unrelated `plans/260724-1358-salesbinder-api-v3-migration/`.

Pre-Landing Review: No new issues found.

### Verdict

All three prior Important findings are resolved. No new Critical, Important, or Minor findings in this re-review.

### Prior Finding Verification

1. Deleted-log resume evidence: RESOLVED.
   Evidence: `packages/cli/src/commands/cache/full-resume-checkpoint.ts:109-128` now includes inventory source/status/generation/fingerprint in item phase evidence, and `validateCompletedPhases()` delegates in-progress deleted-log checkpoints to `validateDeletedLogResume()` at `full-resume-checkpoint.ts:264-272`. That helper checks every completed earlier phase field and rejects non-count drift at `full-resume-checkpoint.ts:330-346`, allows only count decreases caused by partial deleted-log replay at `full-resume-checkpoint.ts:335-342`, and rejects deleted-log watermark advancement at `full-resume-checkpoint.ts:350-351`. Tests cover inventory fingerprint drift, earlier-phase authority drift, count increases, count decreases, and watermark advance at `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts:231-327`.

2. Inventory authority invalidation after category/non-snapshot mutations: RESOLVED.
   Evidence: SQLite invalidates v3 inventory authority after item and stock mutators at `packages/sdk/src/cache/sqlite-cache.service.ts:768-855`; category replacement reconciles item/stock category names then invalidates inventory meta/state at `sqlite-cache.service.ts:1195-1243` and `sqlite-cache.service.ts:1296-1305`. PostgreSQL does the same for item/stock mutators at `packages/sdk/src/cache/postgres-cache.service.ts:1000-1088`; category replacement reconciles names then calls `invalidateInventoryAuthority()` before writing state at `postgres-cache.service.ts:707-780` and `postgres-cache.service.ts:1430-1450`. Tests cover non-snapshot item/stock invalidation and category reconciliation invalidation at `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts:484-529` and `packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts:361-464`.

3. Count-stable v3 inventory/category/variation drift: RESOLVED for the intended membership-stability contract.
   Evidence: v3 inventory now performs two complete source reads before normalization/publish at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:35-63`. The stability fingerprint includes sorted item IDs plus source membership/topology fields, variation IDs, variation `location_count`, variation-location row IDs, and `location_id` at `v3-inventory-indexer.service.ts:118-148`; pagination still rejects incoherent count/pages/page shape and duplicates at `v3-inventory-indexer.service.ts:151-229`. Tests reject equal-count item and variation membership drift at `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:118-150`. Categories use the same two-pass rule at `packages/sdk/src/cache/category-indexer.service.ts:38-52`, fingerprint sorted category rows with category ID/name/parent/custom-field fields at `category-indexer.service.ts:117-136`, and test same-count category drift at `packages/sdk/src/cache/__tests__/category-indexer.service.test.ts:94-112`.

### Fingerprint / Authority Challenge

The two-pass inventory stability fingerprint covers enough source fields for membership/topology stability: item identity/lifecycle/category/location/update fields plus variation identity/count and variation-location identity/location. It intentionally excludes volatile quantities/prices/names. That is acceptable because publication uses the second complete read, not pass-one values; tests explicitly prove changed balances between pass one and pass two publish pass-two values at `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:41-58`.

Second-pass publication can claim complete authority for the validated second read. It cannot claim a globally linearizable SalesBinder state at DB commit time because the v3 API exposes page-based lists, not a server snapshot token. README wording matches that boundary: complete validated v3 snapshots, two consecutive membership reads before publication, previous snapshot unchanged on validation failure at `README.md:135` and `README.md:628-630`.

### Regression Checks

- v3 transport/API contract: current SalesBinder docs still specify Bearer auth and `/api/v3`; item list supports `archived=all`; variation list supports `include=locations`; item categories and locations use standard v3 list pagination. Implementation matches with Bearer base URL at `packages/sdk/src/client/v3-axios.factory.ts:34-49`, item `archived: 'all'` requests at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:83-87`, variation `include: 'locations'` requests at `v3-inventory-indexer.service.ts:90-94`, and category `/item-categories` mapping at `packages/sdk/src/resources/v3-categories.resource.ts:15-28`.
- v2 account/docs/deltas/deleted-log unaffected: CLI still constructs the v2 `SalesBinderClient` for accounts, documents, and deleted log at `packages/cli/src/commands/cache/cache.commands.ts:82-171`; v3 client is selected only for category/inventory cache snapshots at `cache.commands.ts:154-170`.
- v2 fallback does not fabricate v3-only balances: `ItemIndexerService` maps only observed reserved/available/incoming/in-transit values with `observedNumber()` at `packages/sdk/src/cache/item-indexer.service.ts:102-106`, `136-139`, `167-170`, and missing values become `null` at `item-indexer.service.ts:207-212`. Regression tests cover old false-zero paths and fallback state demotion at `packages/sdk/src/cache/__tests__/inventory-source-correctness.test.ts:12-88`.
- NULL unknown semantics preserved: schema v7 makes target stock fields nullable in SQLite/PostgreSQL at `packages/sdk/src/cache/sqlite-cache.service.ts:271-284` and `packages/sdk/src/cache/postgres-cache.service.ts:213-226`; migrations null pre-v7 API values while preserving CSV values at `sqlite-cache.service.ts:378-434` and `postgres-cache.service.ts:319-361`; PostgreSQL reads preserve DB nulls at `postgres-cache.service.ts:1935-1957`.
- Request count/contract: two-pass v3 inventory doubles list/variation reads by design; tests assert two item-list and two variation-list calls at `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:17-22`. This is the explicit stability cost, not a hidden regression.
- Checkpoint partial deleted-log replay: count decreases remain allowed for completed earlier phases at `packages/cli/src/commands/cache/full-resume-checkpoint.ts:335-342` and tested at `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts:231-248`.
- Secrets: `config:list` emits only `has_v3_api_key` at `packages/cli/src/commands/config/config.list.command.ts:50-64`; `config:init` success output omits keys at `packages/cli/src/commands/config/config.init.command.ts:89-99`; v3 retry logs include request ID/status only at `packages/sdk/src/client/v3-axios.factory.ts:82-84`; PostgreSQL checkpoint identity hashes the DB URL at `packages/cli/src/commands/cache/full-resume-checkpoint.ts:151-155`.
- README accuracy: location wording is now scoped. It says embedded variation locations retain names while parent direct `location_id` rows lack `location_name` unless supplied by item payload at `README.md:135`, and it documents the two-pass membership boundary at `README.md:628`.

### Verification

- `git diff --check -- ':!plans/260724-1358-salesbinder-api-v3-migration/**'`
  - PASS.
- `pnpm --filter @salesbinder/sdk test -- --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/category-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/resources/__tests__/v3-items.resource.test.ts src/resources/__tests__/v3-categories.resource.test.ts src/client/__tests__/v3-axios.factory.test.ts`
  - PASS: 9 suites, 163 tests.
- `pnpm --filter @salesbinder/cli test -- --runInBand --silent src/commands/cache/full-resume-checkpoint.test.ts`
  - PASS: 1 suite, 27 tests.
- `pnpm test`
  - PASS: SDK 21 suites / 333 tests; CLI 2 suites / 30 tests.

## Unresolved Questions

None.

Status: DONE
Summary: Re-review complete. The fixed worktree resolves the three prior Important findings and preserves the v3/v2/cache/checkpoint/secrets contracts checked here.
Concerns/Blockers: None.

## Final-tree Signoff Re-review - 2026-08-27

Target: current final worktree after two additional fixes: full-content inventory stability fingerprint and SQLite clear binding verification / forced unbound recovery.

### Overall Verdict

Not full APPROVE due one Minor CLI behavior regression. No Critical or Important findings. The transport, pagination/snapshot authority, checkpoint, v2 fallback/null semantics, secret safety, and README contract checks pass.

Pre-Landing Review: 1 issue (0 critical, 1 informational).

### Critical Issues

None.

### Important Issues

None.

### Minor Issues

1. `packages/cli/src/commands/cache/cache.commands.ts:442-445` - `cache clear` now loads account config before the SQLite branch checks whether the cache file exists and before `--force-unbound` can inspect an unbound legacy file. `origin/main` returned success for a missing SQLite cache without requiring config. Current code can fail on a missing/removed config even when there is no cache file to protect, and it weakens the documented legacy recovery path.
   Impact: CLI behavior regression for local cleanup/recovery flows after config removal/corruption. No data-safety regression; normal existing-file deletion correctly verifies binding first.
   Fix: move `loadConfig()` / `createSalesBinderAccountBinding()` into the PostgreSQL branch and into the normal SQLite existing-file path. In SQLite, compute `accountName`/`cacheFile` first; return existing "Cache file does not exist" success before config load. For `--force-unbound`, call `verifyUnboundForDeletion()` without requiring config, then acquire the existing file lock using a file/account-name-scoped key.

### Signoff Checks

- Inventory stability fingerprint: PASS. `packages/sdk/src/cache/v3-inventory-indexer.service.ts:118-145` now sorts items/variations/variation locations and `stableSerialize()` sorts object keys before hashing the full source payload, so item content, balances, prices, category fields, and nested variation-location balances all participate in the two-pass stability check. Tests reject same-membership item/balance/content drift and nested variation-location balance drift at `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:41-80`, plus membership drift at `v3-inventory-indexer.service.test.ts:141-173`.
- Second-pass publication authority: PASS. `V3InventoryIndexerService.sync()` reads pass one, reads pass two, compares the full-source fingerprint, then normalizes/publishes only pass-two data at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:35-63`. This supports a complete validated API-read snapshot; as before, SalesBinder v3 page-based lists do not provide a server snapshot token or linearizable commit-time lock.
- v3 request contracts: PASS. Current SalesBinder docs still show Bearer auth and `/api/v3` with page-based list pagination, `GET /api/v3/items` accepting `archived=all`, variation list accepting `include=locations`, `GET /api/v3/item-categories`, and `GET /api/v3/locations`. Implementation uses Bearer `/api/v3` at `packages/sdk/src/client/v3-axios.factory.ts:34-49`, item `archived: 'all'` at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:83-87`, variation `include: 'locations'` at `v3-inventory-indexer.service.ts:90-94`, and item-category `/item-categories` at `packages/sdk/src/resources/v3-categories.resource.ts:15-28`.
- SQLite clear binding safety: PASS for protected deletes. CLI verifies matching durable binding before deleting SQLite files at `packages/cli/src/commands/cache/cache.commands.ts:493-518`; `--force-unbound` calls explicit unbound verification instead at `cache.commands.ts:496-500`. SQLite rejects bound or partially-bound files for forced unbound deletion at `packages/sdk/src/cache/sqlite-cache.service.ts:1174-1184`, and normal binding verification rejects populated unbound/mismatched files at `sqlite-cache.service.ts:1343-1377`. Tests cover verified deletion, mismatch no-delete, unbound forced delete, and forced mismatch no-delete at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:261-307`.
- Checkpoint authority: PASS. In-progress deleted-log validation still checks completed earlier phase evidence and allows only deleted-log count decreases at `packages/cli/src/commands/cache/full-resume-checkpoint.ts:264-351`; tests remain in `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts`.
- CLI v2/v3 orchestration: PASS. CLI keeps v2 `SalesBinderClient` for accounts/documents/deleted-log and selects v3 only for category/inventory cache snapshots when `v3ApiKey` exists at `packages/cli/src/commands/cache/cache.commands.ts:82-171`.
- Secret safety: PASS. `config:list` prints only `has_v3_api_key` at `packages/cli/src/commands/config/config.list.command.ts:50-64`; `config:init` success output omits keys at `packages/cli/src/commands/config/config.init.command.ts:89-99`; v3 retry logs print request ID/status only at `packages/sdk/src/client/v3-axios.factory.ts:82-84`; PostgreSQL checkpoint identity hashes DB URL at `packages/cli/src/commands/cache/full-resume-checkpoint.ts:151-155`.
- README accuracy: PASS except the Minor command precondition nuance above. README documents v3 schema/source/null semantics at `README.md:135`, two-pass membership boundary at `README.md:628`, full-resume checkpoint evidence at `README.md:630`, and SQLite `cache clear --force-unbound` constraints at `README.md:632`.

### Verification

- `git diff --check -- ':!plans/260724-1358-salesbinder-api-v3-migration/**'`
  - PASS.
- `pnpm --filter @salesbinder/sdk test -- --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/category-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/resources/__tests__/v3-items.resource.test.ts src/resources/__tests__/v3-categories.resource.test.ts src/client/__tests__/v3-axios.factory.test.ts`
  - PASS: 9 suites, 164 tests.
- `pnpm --filter @salesbinder/cli test -- --runInBand --silent src/commands/cache/full-resume-checkpoint.test.ts src/commands/cache/cache-sync-pull-lock.test.ts`
  - PASS: 2 suites, 34 tests.
- `pnpm test`
  - PASS: SDK 21 suites / 335 tests; CLI 2 suites / 34 tests.
- `pnpm build`
  - PASS: SDK and CLI `tsc`.
- `pnpm lint`
  - PASS exit 0; SDK reports 16 warnings / 0 errors; CLI pass.

## Unresolved Questions

None.

Status: DONE_WITH_CONCERNS
Summary: Final-tree re-review complete. No Critical/Important issues remain; the added inventory stability and SQLite clear safety fixes hold under focused and full verification.
Concerns/Blockers: One Minor CLI cleanup regression: SQLite `cache clear` now requires config before missing-file and forced-unbound recovery paths can complete.

## Final Minor Fix Verification - 2026-08-27

Target: current tree after the final CLI cleanup fix for SQLite `cache clear` missing-file and `--force-unbound` config independence.

### Verdict

APPROVE. No findings in this final Minor scope.

### Evidence

- Missing SQLite file no longer requires config: `cache clear` computes `dbUrl`, `accountName`, and the SQLite cache path at `packages/cli/src/commands/cache/cache.commands.ts:441-483`, then returns success when the main SQLite file is absent at `cache.commands.ts:485-493`. The normal SQLite config load is now only in the existing-file non-`--force-unbound` branch at `cache.commands.ts:502-506`. Regression test covers missing file + throwing config loader + no unlink at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:311-321`.
- `cache clear --force-unbound` no longer requires config: the forced SQLite branch imports only `SQLiteCacheService`, calls `verifyUnboundForDeletion()`, and sets a file-scoped lock key at `cache.commands.ts:496-501`; it does not call `loadConfig()`. Test covers throwing config loader, unbound verification, file lock, unlink, and zero exit at `cache-sync-pull-lock.test.ts:324-337`.
- Normal existing SQLite clear still requires config and binding verification: existing-file normal clear loads config and creates the account binding at `cache.commands.ts:502-504`, verifies it before locking/deleting at `cache.commands.ts:505-508`, and the test forces `loadConfig()` to throw and confirms no binding verification or unlink occurs at `cache-sync-pull-lock.test.ts:340-350`.
- PostgreSQL clear still requires config and binding: the PostgreSQL branch rejects `--force-unbound`, loads config, constructs the binding, ensures schema, verifies/binds the database, then locks/truncates at `cache.commands.ts:445-465`. PostgreSQL binding remains outside the truncated table set: `ensureAccountBinding()` writes/verifies `cache_account_binding` at `packages/sdk/src/cache/postgres-cache.service.ts:656-688`, while `truncateAll()` truncates payload/cache metadata tables but not `cache_account_binding` at `postgres-cache.service.ts:1396-1403`.
- Lock contention and no-unlink safety preserved: SQLite deletion happens only after successful `tryAcquireSyncLock()` at `cache.commands.ts:508-524`; failed binding/forced-bound paths skip lock and unlink in tests at `cache-sync-pull-lock.test.ts:279-287` and `cache-sync-pull-lock.test.ts:298-308`. Cleanup still releases the acquired lock and closes the service in `finally` at `cache.commands.ts:535-539`, via `releaseCacheWriterLockAndClose()` at `cache.commands.ts:852-869`.
- Durable SQLite binding semantics remain fail-closed: forced unbound deletion rejects any full or partial binding marker at `packages/sdk/src/cache/sqlite-cache.service.ts:1174-1184`; normal verification rejects populated unbound and mismatched files at `sqlite-cache.service.ts:1343-1377`.
- README wording remains accurate for this behavior: it states SQLite verifies durable account binding before deleting, and `--force-unbound` works only when both markers are absent and never overrides mismatched/partial bindings at `README.md:632`.

### Verification

- `git diff --check -- packages/cli/src/commands/cache/cache.commands.ts packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts packages/sdk/src/cache/sqlite-cache.service.ts README.md`
  - PASS.
- `pnpm --filter @salesbinder/cli test -- --runInBand --silent src/commands/cache/cache-sync-pull-lock.test.ts`
  - PASS: 1 suite, 10 tests.
- `pnpm --filter @salesbinder/cli exec jest src/commands/cache/cache-sync-pull-lock.test.ts src/commands/cache/full-resume-checkpoint.test.ts --runInBand --silent`
  - PASS: 2 suites, 37 tests.
- `pnpm --filter @salesbinder/cli build`
  - PASS.

## Unresolved Questions

None.

Status: DONE
Summary: Final Minor fix verified. Missing SQLite files and explicit unbound legacy recovery no longer require config; normal existing SQLite and PostgreSQL clears still verify account authority before destructive work.
Concerns/Blockers: None.
