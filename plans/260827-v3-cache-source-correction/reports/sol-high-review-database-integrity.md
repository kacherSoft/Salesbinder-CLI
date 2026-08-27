# Database Integrity Review - v3 Cache Source Correction

Date: 2026-08-27
Reviewer: sol_high
Scope: uncommitted diff against `origin/main`, excluding unrelated user-owned `plans/260724-1358-salesbinder-api-v3-migration/`.

## Scope

- Files reviewed: cache services/indexers, v3 resources/client, config/cache CLI paths, checkpointing, CSV import collision paths, mirror service, plan/research/spec/test reports.
- Diff size: 42 changed files, +4902/-226 total in `git diff --stat origin/main`; main source surface is `packages/sdk/src/cache/*`, `packages/sdk/src/resources/v3-*`, `packages/sdk/src/client/v3-axios.factory.ts`, and `packages/cli/src/commands/cache/*`.
- Focus: SQLite/PostgreSQL schema v7 migration safety, source provenance/nullability, atomic replacement/rollback, CSV/API preservation, category reconciliation, metadata validity, mirror propagation, account isolation, idempotency.
- Scout findings: local scout used instead of subagents due runtime no-delegation rule. Found three edge cases not covered by current tests: SQLite alias collision bypasses account binding, category reconciliation can stale inventory fingerprint, count-stable source pagination churn can still publish destructive snapshots.

## Overall Assessment

No Critical issue found. The implementation materially fixes the false-zero v2/v3 stock problem and PostgreSQL binding is much stronger than before, but three Important database-integrity gaps remain before landing if the acceptance criteria are strict: SQLite account isolation is still alias-based, inventory metadata can claim authority after rows are mutated by category reconciliation, and snapshot publication still trusts count-stable pagination during live source churn.

## Critical Issues

None.

## Important Issues

1. `packages/sdk/src/cache/sqlite-cache.service.ts:99`, `packages/sdk/src/cache/sqlite-cache.service.ts:106`, `packages/sdk/src/cache/sqlite-cache.service.ts:1106` - SQLite account isolation is still a no-op and lossy account-alias sanitization can bind different SalesBinder subdomains to the same local database file.

Impact: two configured aliases such as `sales/east` and `sales:east` both resolve to `sales_east`, and `ensureAccountBinding` / `verifyAccountBinding` always resolve successfully. A local sync, status, pull, delete, or CSV import can read or overwrite another account's SQLite cache while reporting the requested alias. Current tests explicitly bless this no-op behavior at `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:226`.

Cause: SQLite path identity is derived only from sanitized CLI account alias, not normalized SalesBinder subdomain/account identity. The PostgreSQL path has durable `cache_account_binding` enforcement at `packages/sdk/src/cache/postgres-cache.service.ts:656`, but SQLite does not store or verify equivalent metadata.

Fix: persist a SQLite binding marker, for example `cache_meta.account_identity = salesbinder:<normalized-subdomain>`, during first empty-cache write/open and verify it in `ensureAccountBinding`/`verifyAccountBinding`. For populated unbound SQLite files, fail with a migration/rebind instruction unless the file is empty. Also make cache filename collision-resistant, e.g. include a short hash of `accountIdentity` or reject aliases whose sanitized name differs/collides.

2. `packages/sdk/src/cache/sqlite-cache.service.ts:1137`, `packages/sdk/src/cache/sqlite-cache.service.ts:1165`, `packages/sdk/src/cache/sqlite-cache.service.ts:1205`; `packages/sdk/src/cache/postgres-cache.service.ts:732`, `packages/sdk/src/cache/postgres-cache.service.ts:744`, `packages/sdk/src/cache/postgres-cache.service.ts:1528`; `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:77` - Category reconciliation mutates inventory rows after inventory metadata is fingerprinted, but inventory authority validation only checks counts/source tags.

Impact: after a v3 inventory snapshot is published, a later category snapshot can rewrite `items.category_name` and `item_stock_locations.category_name`. `getInventoryCacheMeta()` still returns the old `fingerprint` as authoritative because SQLite checks only account/count/source-version at `packages/sdk/src/cache/sqlite-cache.service.ts:1217` and PostgreSQL checks only binding/schema/source/counts at `packages/sdk/src/cache/postgres-cache.service.ts:1553`. Full-resume checkpoint evidence uses that fingerprint at `packages/cli/src/commands/cache/cache.commands.ts:856` and `packages/cli/src/commands/cache/full-resume-checkpoint.ts:109`, so it can miss row-content drift. Mirror can introduce the same bug: `replaceMirror` validates incoming rows before applying `replaceCategorySnapshotInTransaction`, then writes inventory metadata after category reconciliation.

Cause: `InventoryCacheMeta.fingerprint` is built over item/stock rows including derived category names at `packages/sdk/src/cache/v3-inventory-indexer.service.ts:186`, but later category reconciliation treats those same fields as mutable derived data without regenerating or invalidating inventory metadata.

Fix: either remove derived category names from the inventory fingerprint and add an explicit `categoryGeneration` dependency, or invalidate/recompute inventory metadata inside every category reconciliation transaction. For mirror, validate/write inventory metadata after all mirror transformations, or recompute the mirrored fingerprint from the final stored rows before publishing authority.

3. `packages/sdk/src/cache/sqlite-cache.service.ts:841`, `packages/sdk/src/cache/sqlite-cache.service.ts:851`, `packages/sdk/src/cache/sqlite-cache.service.ts:852`; `packages/sdk/src/cache/postgres-cache.service.ts:1087`, `packages/sdk/src/cache/postgres-cache.service.ts:1097`, `packages/sdk/src/cache/postgres-cache.service.ts:1098`; `packages/sdk/src/cache/csv-cache-import.service.ts:310` - Shared CSV/API item IDs preserve CSV stock rows, but lose CSV master item values.

Impact: a CSV-imported `items` row stores aggregate CSV balances/cost/valuation/name/category data. When a v3 snapshot contains the same `item_id`, `replaceInventorySnapshot` keeps CSV stock rows but upserts the API item into the same `items.item_id` primary key, overwriting the CSV master row. The SQLite regression test at `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts:393` expects this overwrite, so current coverage confirms the behavior rather than protecting CSV master values.

Cause: `items` has one row per `item_id` and `upsertSql` overwrites every non-key column except nullable `archived` (`packages/sdk/src/cache/sqlite-cache.service.ts:1356`, `packages/sdk/src/cache/postgres-cache.service.ts:1778`). The attempted CSV preservation step only protects CSV stock rows, not the CSV-owned item-master row.

Fix: decide and encode source ownership explicitly. If CSV master values must be preserved, do not upsert API inventory over `cache_source='csv'` rows; use source-scoped item storage, a companion API inventory table, or a merge policy that keeps CSV-owned stock/cost/valuation fields while storing API identity/provenance separately. Then update metadata counts/fingerprint so authority no longer depends on every API item owning the single `items` row.

4. `packages/sdk/src/cache/v3-inventory-indexer.service.ts:107`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:116`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:123`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:132`, `packages/sdk/src/cache/sqlite-cache.service.ts:841`, `packages/sdk/src/cache/postgres-cache.service.ts:1087` - Count-stable pagination races can still publish a destructive v3 snapshot.

Impact: the v3 indexer aborts when `total_records`, `total_pages`, or `per_page` changes, and it rejects duplicate IDs. But if SalesBinder changes records while paging without changing counts, for example delete one item and insert another, or move/update rows across pages without duplicates, the checks pass. The backend then deletes all API-owned stock/items and publishes the mixed snapshot atomically. Local rollback is safe on DB errors, but the source snapshot can be internally inconsistent and replace the previous good cache.

Cause: pagination validation proves envelope consistency, not source snapshot stability. The research notes v3 has no documented delta/snapshot token and page position is unsafe during live changes (`plans/260827-v3-cache-source-correction/research/v3-contract-research.md:86`).

Fix: add a bounded stability pass before destructive publish. Fetch all inventory/category pages, compute a canonical fingerprint from stable source fields such as IDs, `updated_at`, archive flags, variation IDs/counts, and stock balances, then repeat the read and publish only if the fingerprints match. If a full double-read is too expensive, at least retry on first/last page fingerprint drift and document weaker guarantees.

## Minor Issues

None blocking. PostgreSQL category/binding schema repair drops unexpected columns in cache-owned tables at `packages/sdk/src/cache/postgres-cache.service.ts:412` and `packages/sdk/src/cache/postgres-cache.service.ts:508`; acceptable for managed cache tables, but document that external columns inside cache tables are unsupported.

## Candidate Defect Adjudication

- SQLite account binding no-op plus lossy alias collisions: verified. See Important issue 1.
- Category mutations leaving authoritative inventory metadata/fingerprint stale: verified. See Important issue 2.
- Shared CSV/API item IDs losing CSV master values: verified for `items` master rows; refuted only for stock rows, which are preserved. See Important issue 3.
- Destructive publication after count-stable pagination races: verified as a source-consistency gap. See Important issue 4.

Refuted/clean checks:

- Fabricated balances: fixed for reviewed paths. v2 fallback now maps observed values only (`packages/sdk/src/cache/item-indexer.service.ts:103`, `packages/sdk/src/cache/item-indexer.service.ts:136`, `packages/sdk/src/cache/item-indexer.service.ts:167`), v3 normalizer requires source quantities and preserves unknown `quantity_available` as `null` (`packages/sdk/src/cache/v3-inventory-normalizer.ts:19`, `packages/sdk/src/cache/v3-inventory-normalizer.ts:40`, `packages/sdk/src/cache/v3-inventory-normalizer.ts:135`), and both DB normalizers preserve nullable stock fields (`packages/sdk/src/cache/sqlite-cache.service.ts:1407`, `packages/sdk/src/cache/postgres-cache.service.ts:1858`).
- PostgreSQL one-database-one-account binding: fixed for normal readers/writers. Writes require expected binding and re-check persisted binding in transaction (`packages/sdk/src/cache/postgres-cache.service.ts:1408`); populated unbound DBs fail before payload schema mutation (`packages/sdk/src/cache/postgres-cache.service.ts:668`).
- Repeat/idempotent v7 nullable migration: generally sound. SQLite runs v7 cleanup only when `fromVersion < 7` (`packages/sdk/src/cache/sqlite-cache.service.ts:359`); PostgreSQL uses `schema.v7.inventory-nullability-migrated` (`packages/sdk/src/cache/postgres-cache.service.ts:340`).
- Atomic DB replacement/rollback: DB-side category/inventory replacement uses transactions in both backends (`packages/sdk/src/cache/sqlite-cache.service.ts:724`, `packages/sdk/src/cache/sqlite-cache.service.ts:832`, `packages/sdk/src/cache/postgres-cache.service.ts:707`, `packages/sdk/src/cache/postgres-cache.service.ts:1077`). This does not solve source pagination races above.

## Positive Observations

- v3 transport is separate from v2 and uses Bearer auth with `/api/v3` and no `.json` suffix (`packages/sdk/src/client/v3-axios.factory.ts:35`, `packages/sdk/src/resources/index.ts:48`).
- v3 inventory requests `archived: 'all'` and variation pages with `include: 'locations'` (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:63`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:70`).
- PostgreSQL write paths now avoid the prior pool-swapping transaction pattern and use one verified transaction helper (`packages/sdk/src/cache/postgres-cache.service.ts:1802`).
- Focused cache tests and TypeScript builds pass.

## Verification

- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-category-cache.service.test.ts src/cache/__tests__/cache-account-binding.test.ts` - PASS, 7 suites / 133 tests.
- `pnpm --filter @salesbinder/sdk build` - PASS.
- `pnpm --filter @salesbinder/cli build` - PASS.
- `git diff --check origin/main` - PASS.

Metrics:

- Type coverage: not measured.
- Test coverage: not measured.
- Linting issues: not run in this review; prior tester report says 16 SDK warnings / 0 errors and CLI pass.

## Recommended Actions

1. Add durable SQLite binding and collision-resistant cache identity before shipping account-isolation claims.
2. Make inventory metadata/fingerprint truthful after category reconciliation and mirror transforms.
3. Resolve CSV/API master-row ownership explicitly; preserve CSV master values or update acceptance/docs/tests if API master is intended to win.
4. Add a count-stable pagination race test and bounded source-stability check before destructive snapshot publish.

## Unresolved Questions

- Should `items` expose one canonical row per item or source-scoped rows when CSV and API both have the same SalesBinder item ID? Current implementation chooses API; stated acceptance appears to require CSV master preservation.

Status: DONE_WITH_CONCERNS
Summary: Reviewed v3 cache source-correction diff and wrote this report. No Critical issue found; four Important integrity gaps remain.
Concerns/Blockers: Landing should block until SQLite binding, metadata truthfulness, CSV/API master-row ownership, and count-stable pagination race handling are resolved or explicitly accepted.

---

# Re-review Addendum - 2026-08-27 after fixes

## Scope

- Re-reviewed current uncommitted worktree against prior report.
- Focus: SQLite durable binding, alias-collision paths for sync/status/pull/import/clear, populated legacy cache handling, clear binding semantics, category/inventory metadata invalidation, PostgreSQL mirror final authority, v3 canonical item-master decision, preserved CSV stock rows, and two-pass source stability.
- Excluded unrelated `plans/260724-1358-salesbinder-api-v3-migration/`.

## Overall Assessment

Most prior findings are fixed or made explicit by product docs. Remaining source-supported issues are narrower:

- SQLite service-level binding is durable and service `clearAll()` preserves binding, but CLI SQLite `cache clear` deletes the sanitized-account file without verifying the file's persisted binding.
- v3 two-pass stability now detects count-stable membership changes, including variation membership, but the stability fingerprint omits persisted stock balance/content fields. A balance/content change with same IDs can pass stability verification and publish.

No Critical findings in this pass.

## Important Issues

1. `packages/cli/src/commands/cache/cache.commands.ts:467`, `packages/cli/src/commands/cache/cache.commands.ts:486`, `packages/cli/src/commands/cache/cache.commands.ts:489`, `packages/cli/src/commands/cache/cache.commands.ts:500` - SQLite `cache clear` can still delete another account's cache file after an alias collision.

Impact: sync, import, status, and pull now bind/verify before use, but local clear remains destructive by sanitized CLI alias. If two configured account aliases normalize to the same `salesbinder-${sanitizedAccount}.db`, running `cache clear` under the second account deletes the first account's bound cache file without checking the durable account identity. This is local cache loss and it removes the only binding evidence with the file.

Evidence: SQLite cache filenames still come from sanitized account names (`packages/sdk/src/cache/sqlite-cache.service.ts:103`, `packages/sdk/src/cache/sqlite-cache.service.ts:110`, `packages/sdk/src/cache/sqlite-cache.service.ts:114`). The clear command reconstructs that same path from the raw account alias (`packages/cli/src/commands/cache/cache.commands.ts:467` to `packages/cli/src/commands/cache/cache.commands.ts:469`), opens `new SQLiteCacheService(accountName)` (`packages/cli/src/commands/cache/cache.commands.ts:486` to `packages/cli/src/commands/cache/cache.commands.ts:488`), acquires only the requested account's lock (`packages/cli/src/commands/cache/cache.commands.ts:489` to `packages/cli/src/commands/cache/cache.commands.ts:492`), then unlinks the database/WAL/SHM files (`packages/cli/src/commands/cache/cache.commands.ts:499` to `packages/cli/src/commands/cache/cache.commands.ts:502`). There is no `ensureAccountBinding()` or `verifyAccountBinding()` on the SQLite clear path.

Why this was not fully covered by the fix: the durable binding itself is implemented in `cache_meta` (`packages/sdk/src/cache/sqlite-cache.service.ts:94` to `packages/sdk/src/cache/sqlite-cache.service.ts:95`) and mismatch checks fail closed (`packages/sdk/src/cache/sqlite-cache.service.ts:1326` to `packages/sdk/src/cache/sqlite-cache.service.ts:1360`). Service-level payload clear preserves binding (`packages/sdk/src/cache/sqlite-cache.service.ts:1495` to `packages/sdk/src/cache/sqlite-cache.service.ts:1507`) and tests cover that (`packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:258` to `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:269`). The CLI file-delete path bypasses those checks.

Cause-aligned fix: before unlinking SQLite cache files, open the DB and call `verifyAccountBinding(accountBinding)`. For populated legacy unbound files, either require an explicit recovery flag such as `--force-unbound-legacy` or print the exact manual removal command. Prefer calling a SDK helper that verifies binding, closes the DB, and then deletes the DB/WAL/SHM files so clear semantics stay centralized and testable.

2. `packages/sdk/src/cache/v3-inventory-indexer.service.ts:118`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:132`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:139`; `packages/sdk/src/cache/v3-inventory-normalizer.ts:19`, `packages/sdk/src/cache/v3-inventory-normalizer.ts:73`, `packages/sdk/src/cache/v3-inventory-normalizer.ts:108`, `packages/sdk/src/cache/v3-inventory-normalizer.ts:133` - v3 two-pass stability omits stock balances and other persisted content.

Impact: the previous count-stable item/variation membership race is partially fixed, but a same-ID content change can still pass stability verification. The second read is then published through destructive API-row replacement. This can silently publish internally mixed or unstable inventory values when quantities, reserved/incoming/in-transit balances, price/cost, barcode, location names, or location-level quantities change without an item-level `updated_at` change that the fingerprint observes. Variation and variation-location wire types do not expose their own updated timestamp in the current type contract (`packages/sdk/src/types/items.types.ts:102` to `packages/sdk/src/types/items.types.ts:124`).

Evidence: `sync()` reads the source twice and compares `createSourceStabilityFingerprint()` (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:41` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:45`). That fingerprint includes item identity/status/category/location/`updated_at` plus variation IDs/counts and variation-location IDs/location IDs (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:118` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:148`). It omits fields that are persisted into the cache: item `quantity`, `quantity_reserved`, `quantity_incoming`, `threshold`, `price`, `cost`, `barcode`, and `location_inventory.quantity_available` (`packages/sdk/src/cache/v3-inventory-normalizer.ts:19` to `packages/sdk/src/cache/v3-inventory-normalizer.ts:54`); parent stock balances (`packages/sdk/src/cache/v3-inventory-normalizer.ts:73` to `packages/sdk/src/cache/v3-inventory-normalizer.ts:80`); aggregate variation balances (`packages/sdk/src/cache/v3-inventory-normalizer.ts:108` to `packages/sdk/src/cache/v3-inventory-normalizer.ts:115`); and variation-location balances/location names (`packages/sdk/src/cache/v3-inventory-normalizer.ts:130` to `packages/sdk/src/cache/v3-inventory-normalizer.ts:140`). Current tests cover membership drift only (`packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:118` to `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:150`).

Cause-aligned fix: compute the two-pass stability fingerprint from the same canonical normalized rows that will be published, with volatile fields such as `imported_at`, generation, and completed time excluded. This covers all persisted balances and derived stock rows. Alternative: expand `createSourceStabilityFingerprint()` to include every source field consumed by `normalizeV3InventoryItem()`, including nested `location_inventory` and variation-location quantity fields.

## Resolved / Refuted Prior Findings

- SQLite account binding no-op: fixed for service paths. `ensureAccountBinding()` and `verifyAccountBinding()` now both call `bindOrVerifyAccount()` (`packages/sdk/src/cache/sqlite-cache.service.ts:1164` to `packages/sdk/src/cache/sqlite-cache.service.ts:1172`), which writes binding only for empty DBs and rejects mismatches/populated legacy unbound DBs (`packages/sdk/src/cache/sqlite-cache.service.ts:1326` to `packages/sdk/src/cache/sqlite-cache.service.ts:1360`). Covered by alias and legacy tests (`packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:225` to `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:256`).
- Alias collisions stopped for sync/status/pull/import: fixed. SQLite sync ensures binding before locking/writing (`packages/cli/src/commands/cache/cache.commands.ts:103` to `packages/cli/src/commands/cache/cache.commands.ts:109`); CSV import ensures binding before non-dry-run import (`packages/cli/src/commands/cache/cache.commands.ts:568` to `packages/cli/src/commands/cache/cache.commands.ts:572`); SQLite status verifies binding before reading metadata (`packages/cli/src/commands/cache/cache.commands.ts:716` to `packages/cli/src/commands/cache/cache.commands.ts:717`); PostgreSQL-to-SQLite pull verifies both sides before mirroring (`packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:61` to `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:69`). Clear remains open; see Important issue 1.
- Populated legacy SQLite handling: operationally recoverable but intentionally conservative. Populated unbound files fail closed instead of being adopted (`packages/sdk/src/cache/sqlite-cache.service.ts:1336` to `packages/sdk/src/cache/sqlite-cache.service.ts:1341`; test at `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:248` to `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:255`). Local rebuild remains possible by deleting the cache file, but the CLI clear path needs binding-safe recovery semantics before relying on it for alias-collision recovery.
- Category mutations leaving inventory metadata/fingerprint stale: fixed for normal service mutations. SQLite item/stock non-snapshot writes invalidate inventory authority (`packages/sdk/src/cache/sqlite-cache.service.ts:768` to `packages/sdk/src/cache/sqlite-cache.service.ts:845`) and category reconciliation invalidates after mutating names (`packages/sdk/src/cache/sqlite-cache.service.ts:1223` to `packages/sdk/src/cache/sqlite-cache.service.ts:1243`). PostgreSQL mirrors the same pattern for item/stock writes (`packages/sdk/src/cache/postgres-cache.service.ts:1000` to `packages/sdk/src/cache/postgres-cache.service.ts:1080`) and category reconciliation (`packages/sdk/src/cache/postgres-cache.service.ts:727` to `packages/sdk/src/cache/postgres-cache.service.ts:757`; invalidation helper at `packages/sdk/src/cache/postgres-cache.service.ts:1430` to `packages/sdk/src/cache/postgres-cache.service.ts:1450`).
- Mirror/category ordering stale fingerprint: fixed for category-name reconciliation. SQLite mirror now validates incoming inventory metadata, rejects category reconciliation that would alter v3 inventory-covered category names, performs category replacement before final inventory metadata write, then revalidates final rows before writing metadata (`packages/sdk/src/cache/sqlite-cache.service.ts:1067` to `packages/sdk/src/cache/sqlite-cache.service.ts:1094`). Rollback/final-authority behavior has tests (`packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:185` to `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:223`; `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts:384` to `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts:400`).
- Shared CSV/API item IDs losing CSV master values: reclassified as intended v3 canonical item-master behavior, not a defect under current docs. README states CSV stock numeric values remain unchanged and v3 wins canonical item master on shared IDs (`README.md:135`). Implementation preserves CSV stock rows by deleting only API stock rows, then publishes v3 API master rows (`packages/sdk/src/cache/sqlite-cache.service.ts:870` to `packages/sdk/src/cache/sqlite-cache.service.ts:887`; PostgreSQL equivalent at `packages/sdk/src/cache/postgres-cache.service.ts:1101` to `packages/sdk/src/cache/postgres-cache.service.ts:1128`).
- Category two-pass stability: fixed for v3 category snapshots. The v3 category indexer fetches twice and compares a canonical category fingerprint before publication (`packages/sdk/src/cache/category-indexer.service.ts:44` to `packages/sdk/src/cache/category-indexer.service.ts:50`; fingerprint fields at `packages/sdk/src/cache/category-indexer.service.ts:117` to `packages/sdk/src/cache/category-indexer.service.ts:136`).
- PostgreSQL one-database-one-account binding: still sound. Binding schema is a singleton with `CHECK (id = 1)` (`packages/sdk/src/cache/postgres-cache.service.ts:120` to `packages/sdk/src/cache/postgres-cache.service.ts:127`), ensure refuses populated unbound DBs (`packages/sdk/src/cache/postgres-cache.service.ts:662` to `packages/sdk/src/cache/postgres-cache.service.ts:689`), verify does not insert into an empty DB (`packages/sdk/src/cache/postgres-cache.service.ts:691` to `packages/sdk/src/cache/postgres-cache.service.ts:705`), writes re-check binding inside the transaction (`packages/sdk/src/cache/postgres-cache.service.ts:1422` to `packages/sdk/src/cache/postgres-cache.service.ts:1427`), and truncation omits `cache_account_binding` (`packages/sdk/src/cache/postgres-cache.service.ts:1396` to `packages/sdk/src/cache/postgres-cache.service.ts:1403`; test at `packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts:568` to `packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts:577`).

## Verification

- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-category-cache.service.test.ts src/cache/__tests__/category-indexer.service.test.ts` - PASS, 7 suites / 167 tests.
- `pnpm --filter @salesbinder/cli exec jest --runInBand --silent src/commands/cache/cache-sync-pull-lock.test.ts src/commands/cache/full-resume-checkpoint.test.ts` - PASS, 2 suites / 30 tests.
- `pnpm --filter @salesbinder/sdk build` - PASS.
- `pnpm --filter @salesbinder/cli build` - PASS.
- `git diff --check origin/main` - PASS.

## Recommended Actions

1. Add binding verification to SQLite `cache clear` before file deletion; require explicit recovery mode for populated unbound legacy files.
2. Expand v3 inventory stability fingerprint to cover all persisted source content, ideally by hashing normalized rows with volatile fields stripped.
3. Add CLI tests for alias-colliding SQLite `cache clear` and v3 tests for same-ID stock balance drift between stability passes.

## Unresolved Questions

- Should populated unbound legacy SQLite caches be recoverable only by destructive rebuild, or should there be an explicit one-time binding adoption workflow after user confirmation and evidence review?

Status: DONE_WITH_CONCERNS
Summary: Prior major fixes largely landed; SQLite binding now protects sync/status/pull/import, metadata invalidation/restore and mirror final authority are materially fixed, and CSV master overwrite is now an explicit v3 canonical-master policy. Two Important issues remain: SQLite CLI clear bypasses binding verification before unlinking, and v3 two-pass stability omits persisted balance/content fields.
Concerns/Blockers: Address the two remaining issues before claiming full account-isolated, content-stable cache publication.

---

# Final Signoff Re-review - 2026-08-27

## Verdict

APPROVE. No remaining database-integrity findings in the reviewed scope.

The two prior Important findings are fixed, and the original candidate defects are resolved or explicitly reclassified by the accepted v3 canonical item-master policy.

## Evidence

- Full-content v3 two-pass stability: fixed. `V3InventoryIndexerService.sync()` reads the complete source twice before normalization/publish and rejects differing fingerprints (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:41` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:45`). The fingerprint now hashes each full source item plus sorted full variation objects and sorted locations using stable key ordering (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:118` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:145`), so same-ID balance/content drift is covered. Tests reject item balance/content drift and nested variation-location balance drift before publish (`packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:41` to `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:80`) plus membership drift (`packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:141` to `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:160`).
- Normal SQLite clear verifies binding before deleting: fixed. The CLI opens `SQLiteCacheService`, then either verifies the durable account binding or the explicit unbound-recovery precondition before lock and unlink (`packages/cli/src/commands/cache/cache.commands.ts:493` to `packages/cli/src/commands/cache/cache.commands.ts:500`). Tests assert normal clear verifies binding, closes SQLite before unlink, and does not delete on mismatch (`packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:261` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:285`).
- `--force-unbound` cannot override mismatched or partial bindings: fixed. `verifyUnboundForDeletion()` rejects when either SQLite binding marker exists (`packages/sdk/src/cache/sqlite-cache.service.ts:1174` to `packages/sdk/src/cache/sqlite-cache.service.ts:1184`). Tests cover both service-level complete-unbound-only behavior and CLI no-delete mismatch behavior (`packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:272` to `packages/sdk/src/cache/__tests__/sqlite-category-cache.service.test.ts:280`; `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:287` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:306`).
- Lock/close/unlink cleanup: acceptable. SQLite clear obtains the external sync lock before destructive unlink, calls `closeDatabaseForDeletion()` before unlinking DB/WAL/SHM files, and the command `finally` releases the lock and closes any remaining service handle (`packages/cli/src/commands/cache/cache.commands.ts:501` to `packages/cli/src/commands/cache/cache.commands.ts:518`; cleanup at `packages/cli/src/commands/cache/cache.commands.ts:854` to `packages/cli/src/commands/cache/cache.commands.ts:862`). `SQLiteCacheService.closeDatabaseForDeletion()` only closes the DB handle; `close()` separately releases locks and is idempotent against a closed DB (`packages/sdk/src/cache/sqlite-cache.service.ts:1187` to `packages/sdk/src/cache/sqlite-cache.service.ts:1205`).
- Category/inventory metadata truthfulness: fixed. SQLite item/stock mutators invalidate inventory authority, category reconciliation invalidates after mutating names, and mirror revalidates final rows before writing inventory metadata (`packages/sdk/src/cache/sqlite-cache.service.ts:768` to `packages/sdk/src/cache/sqlite-cache.service.ts:854`; `packages/sdk/src/cache/sqlite-cache.service.ts:1223` to `packages/sdk/src/cache/sqlite-cache.service.ts:1260`; `packages/sdk/src/cache/sqlite-cache.service.ts:1067` to `packages/sdk/src/cache/sqlite-cache.service.ts:1094`). PostgreSQL remains aligned for item/stock/category mutation invalidation and account-bound metadata reads (`packages/sdk/src/cache/postgres-cache.service.ts:1000` to `packages/sdk/src/cache/postgres-cache.service.ts:1088`; `packages/sdk/src/cache/postgres-cache.service.ts:727` to `packages/sdk/src/cache/postgres-cache.service.ts:757`; `packages/sdk/src/cache/postgres-cache.service.ts:1565` to `packages/sdk/src/cache/postgres-cache.service.ts:1604`).
- PostgreSQL account binding/clear semantics unchanged and sound. The binding table remains singleton-constrained (`packages/sdk/src/cache/postgres-cache.service.ts:120` to `packages/sdk/src/cache/postgres-cache.service.ts:127`), writes re-check binding in transaction (`packages/sdk/src/cache/postgres-cache.service.ts:1422` to `packages/sdk/src/cache/postgres-cache.service.ts:1427`), and `truncateAll()` omits `cache_account_binding` while clearing payload/meta tables (`packages/sdk/src/cache/postgres-cache.service.ts:1396` to `packages/sdk/src/cache/postgres-cache.service.ts:1403`).
- CSV/API collision policy: accepted and documented. README states CSV stock numeric values remain unchanged and v3 is the canonical item master for shared IDs (`README.md:135`). The replacement path deletes API-owned stock only, preserves CSV stock, and then upserts v3 API master rows (`packages/sdk/src/cache/sqlite-cache.service.ts:870` to `packages/sdk/src/cache/sqlite-cache.service.ts:887`; PostgreSQL equivalent at `packages/sdk/src/cache/postgres-cache.service.ts:1101` to `packages/sdk/src/cache/postgres-cache.service.ts:1128`).
- Docs are accurate for reviewed behavior. README documents v7 source provenance, nullable unknown stock, v3 snapshot publication, canonical item-master policy, and SQLite/PG clear binding semantics (`README.md:135`; `README.md:628` to `README.md:632`). The stability wording is conservative: it mentions membership agreement, while current code verifies full source content.

## Original Candidate Defect Adjudication

- SQLite account binding no-op plus lossy alias collisions: resolved for sync/status/pull/import/clear through durable binding verification and explicit unbound recovery.
- Category mutations leaving authoritative inventory metadata/fingerprint stale: resolved by mutation invalidation and final mirror revalidation.
- Shared CSV/API item IDs losing CSV master values: not a defect under current accepted policy; v3 row is documented canonical item master and CSV stock values are preserved.
- Destructive publication after count-stable pagination races: resolved for same-count membership and content drift by two complete source reads with stable full-content fingerprinting before destructive publish.

## Pre-landing Checklist Result

Pre-Landing Review: No issues found.

Critical pass: no injection/path traversal beyond the bounded cache-file path, no unguarded account-isolation bypass found, no destructive cache mutation before binding/recovery precondition, no new secret leak.

Informational pass: no source-backed test/docs/API-contract gaps found in the reviewed cache-integrity scope.

## Verification

- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-category-cache.service.test.ts src/cache/__tests__/category-indexer.service.test.ts src/cache/__tests__/cache-account-binding.test.ts` - PASS, 8 suites / 175 tests.
- `pnpm --filter @salesbinder/cli exec jest --runInBand --silent src/commands/cache/cache-sync-pull-lock.test.ts src/commands/cache/full-resume-checkpoint.test.ts` - PASS, 2 suites / 34 tests.
- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent` - PASS, 21 suites / 335 tests.
- `pnpm --filter @salesbinder/cli exec jest --runInBand --silent` - PASS, 2 suites / 34 tests.
- `pnpm --filter @salesbinder/sdk build` - PASS.
- `pnpm --filter @salesbinder/cli build` - PASS.
- `git diff --check origin/main` - PASS.
- Note: `pnpm --filter @salesbinder/sdk test -- --runInBand --silent` is not a valid invocation for this package; Jest treated the flags as filename patterns and returned "No tests found." Re-run via `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent` passed.

## Unresolved Questions

None.

Status: DONE
Summary: Final-tree database-integrity signoff complete. Prior remaining SQLite clear and full-content stability findings are fixed; all original findings are resolved/reclassified with source evidence and tests passing.
Concerns/Blockers: None.

---

# Final Exact-tree Regression Signoff - 2026-08-27

## Verdict

APPROVE. No database-integrity regressions found after the CLI-only config-precondition fix.

## Evidence

- SQLite clear still verifies normal binding before deletion. Existing-file normal clear constructs `SQLiteCacheService`, loads config only for the normal bound path, verifies `accountBinding`, then uses the account sync lock before unlinking (`packages/cli/src/commands/cache/cache.commands.ts:496` to `packages/cli/src/commands/cache/cache.commands.ts:508`). Tests assert verification precedes unlink and mismatch prevents deletion (`packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:263` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:286`).
- CLI config precondition fix is safe. Missing SQLite cache returns success without loading account config (`packages/cli/src/commands/cache/cache.commands.ts:485` to `packages/cli/src/commands/cache/cache.commands.ts:493`; test at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:311` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:321`). `--force-unbound` also avoids config and uses only the unbound-file deletion path (`packages/cli/src/commands/cache/cache.commands.ts:499` to `packages/cli/src/commands/cache/cache.commands.ts:502`; test at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:324` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:337`). Normal clear of an existing SQLite cache still requires config before deleting (`packages/cli/src/commands/cache/cache.commands.ts:503` to `packages/cli/src/commands/cache/cache.commands.ts:506`; test at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:340` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:350`).
- `--force-unbound` cannot override mismatched or partial binding. `verifyUnboundForDeletion()` rejects if either binding marker exists (`packages/sdk/src/cache/sqlite-cache.service.ts:1174` to `packages/sdk/src/cache/sqlite-cache.service.ts:1184`), and the CLI does not acquire the lock or unlink on that rejection (`packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:298` to `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:308`).
- Lock/close/unlink cleanup remains safe. SQLite `tryAcquireSyncLock()` uses a DB-path lock file (`packages/sdk/src/cache/sqlite-cache.service.ts:1129` to `packages/sdk/src/cache/sqlite-cache.service.ts:1153`), so normal and force clear coordinate on the same local file. Clear closes the SQLite handle before unlink (`packages/cli/src/commands/cache/cache.commands.ts:517` to `packages/cli/src/commands/cache/cache.commands.ts:524`) and `finally` releases the lock then closes remaining handles (`packages/cli/src/commands/cache/cache.commands.ts:852` to `packages/cli/src/commands/cache/cache.commands.ts:866`).
- Full-content v3 two-pass fingerprint remains intact. The indexer still performs two complete source reads before publish and rejects differing fingerprints (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:41` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:45`). The fingerprint hashes full sorted item/variation/location source objects with stable key ordering (`packages/sdk/src/cache/v3-inventory-indexer.service.ts:118` to `packages/sdk/src/cache/v3-inventory-indexer.service.ts:145`), and tests reject same-ID item balance/content drift plus nested location-balance drift (`packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:41` to `packages/sdk/src/cache/__tests__/v3-inventory-indexer.service.test.ts:80`).
- PostgreSQL DB-integrity paths unchanged in the CLI-only fix. PostgreSQL clear still rejects `--force-unbound`, ensures schema/binding, locks by account identity, and truncates through existing binding-preserving service logic (`packages/cli/src/commands/cache/cache.commands.ts:445` to `packages/cli/src/commands/cache/cache.commands.ts:465`; `packages/sdk/src/cache/postgres-cache.service.ts:1396` to `packages/sdk/src/cache/postgres-cache.service.ts:1403`).

## Re-check of Original Findings

- SQLite account binding no-op / alias collisions: resolved for sync/status/pull/import/clear.
- Category mutations leaving authoritative inventory metadata stale: resolved.
- CSV/API shared-ID master overwrite: accepted policy; v3 is canonical item master and CSV stock values are preserved.
- Destructive publication after count-stable pagination races: resolved for reviewed membership and full-content drift by two-pass source fingerprinting.
- No fabricated balances, metadata truthfulness, mirror semantics, account binding, rollback-safe transactions, and idempotent migrations: no regression found in this exact-tree pass.

## Verification

- `pnpm --filter @salesbinder/cli exec jest --runInBand --silent src/commands/cache/cache-sync-pull-lock.test.ts src/commands/cache/full-resume-checkpoint.test.ts` - PASS, 2 suites / 37 tests.
- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent src/cache/__tests__/inventory-source-correctness.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/postgres-cache.service.test.ts src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-category-cache.service.test.ts src/cache/__tests__/category-indexer.service.test.ts src/cache/__tests__/cache-account-binding.test.ts` - PASS, 8 suites / 175 tests.
- `pnpm --filter @salesbinder/sdk exec jest --runInBand --silent` - PASS, 21 suites / 335 tests.
- `pnpm --filter @salesbinder/cli exec jest --runInBand --silent` - PASS, 2 suites / 37 tests.
- `pnpm --filter @salesbinder/sdk build` - PASS.
- `pnpm --filter @salesbinder/cli build` - PASS.
- `git diff --check origin/main` - PASS.

## Unresolved Questions

None.

Status: DONE
Summary: Final exact-tree regression signoff complete after the CLI config-precondition fix. SQLite clear binding/force safety remains intact, full-content two-pass protection remains intact, and no DB-integrity regression found.
Concerns/Blockers: None.
