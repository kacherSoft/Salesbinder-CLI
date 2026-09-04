---
title: 'PostgreSQL Sync Lock Loss Fail-Closed'
description: 'Fence PostgreSQL cache writes to the lock-owning session, abort cache sync on lock-session loss, atomically mirror source sync status into SQLite, and prevent stale terminal status from overwriting a successor run.'
status: complete
priority: P1
effort: 1d
issue: null
branch: main
tags: [bugfix, cache, postgresql, cli, critical]
blockedBy: []
blocks: []
created: 2026-09-03
---

# PostgreSQL Sync Lock Loss Fail-Closed

## Overview

Fix the P1 cache writer-lock hole with owner-session fencing. A checked-out PostgreSQL client holds `pg_try_advisory_lock`; if that session emits `error` or `end`, PostgreSQL releases the lock. Local lost-state checks alone are race-unsafe because an old run can keep using fresh pool clients while a successor acquires the released lock. While a sync lock is held, every PostgreSQL `withVerifiedWrite` transaction must run on the retained lock client, serialized by a per-lease queue. Sticky lost state blocks fallback after the owner session dies. The final implementation also drains acquisition/close races, destroys clients when lock-acquire or transaction outcomes are unknown, and carries a UUID run-ownership token so stale terminal writes cannot win over a successor run.

## Scope

In: PostgreSQL owner-session write fencing, checked-out lock-client `error`/`end` handling, a concrete Postgres-only lock-loss signal for CLI, CLI abort/fail-closed behavior, conditional failed `sync_status` after lock loss, stale terminal status protection, regression tests, forced disposable PostgreSQL disconnect validation.

Out: retry redesign, progress UX redesign, webhook/MCP, multi-account PostgreSQL tenancy, SalesBinder API v2/v3 fallback changes, database schema changes, and `CacheService` method signature changes.

## Design Decision

- Do not rely on local lost-state checks as the main guard.
- Keep `CacheService` unchanged. Add a Postgres-only lock-loss signal/API on `PostgresCacheService`.
- During a held PostgreSQL sync lock, route all `withVerifiedWrite` transactions through the lock-owning client.
- Serialize owner-session writes with one promise queue per lock lease.
- On owner session `error` or `end`, idempotently mark sticky lost state, detach handlers, notify CLI, and reject/skip later owner-session writes.
- Acquisition and close both wait for in-flight lease setup to settle before ending the pool, so a lock cannot appear live after shutdown starts.
- Unknown `pg_try_advisory_lock`, `BEGIN`, `COMMIT`, or `ROLLBACK` outcomes destroy the checked-out client instead of trusting it.
- After loss, permit only a fresh-client failed `sync_status` compensation, and only when persisted `sync_status.runId` still equals the old run's UUID ownership token.
- Atomic SQLite mirror replacement carries the source `sync_status` snapshot into the same transaction, and the outer CLI uses a prompt abort split that never abandons SQLite side effects.

## Cross-Plan Overlap

| Plan                                              | Status      | Relationship                                                                                                                                           |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `260724-1358-salesbinder-api-v3-migration`        | pending     | Overlaps cache lock/interface files; stale relative to current v3-required cache-sync behavior. Rebase after this fix. Not edited per task constraint. |
| `260826-2158-pr-1-integration-after-cache-review` | in-progress | Mentions full-resume, locks, status, and GitHub-only remaining step. No dependency. Not edited per task constraint.                                    |
| `260903-1215-pr2-production-safeguards-fix`       | complete    | Touched `postgres-cache.service.ts` for idle pool error handling only. This plan extends checked-out lock-client coverage and write fencing.           |

## Phases

| Phase | Name                                                                               | Status   | Purpose                                                                                                            |
| ----- | ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | [SDK Owner-Session Fencing](./phase-01-sdk-lock-invalidation.md)                   | Complete | Route locked PostgreSQL writes through the advisory-lock client and make lock loss sticky/idempotent.              |
| 2     | [CLI Fail-Closed Orchestration](./phase-02-cli-fail-closed-orchestration.md)       | Complete | Abort the sync workflow through the Postgres-only signal and protect failed terminal status by run ID.             |
| 3     | [Regression And Integration Gates](./phase-03-regression-and-integration-gates.md) | Complete | Prove owner-session queueing, lock loss, stale-status protection, builds, and real PostgreSQL disconnect behavior. |

## Acceptance Criteria

- [x] Checked-out PostgreSQL sync-lock client `error` and `end` events are handled; no unhandled EventEmitter crash.
- [x] While lock held, every PostgreSQL `withVerifiedWrite` transaction uses the retained lock client, not a fresh pool client.
- [x] Per-lease write queue serializes owner-session transactions.
- [x] Sticky lost state blocks fallback writes after lock-client loss.
- [x] Lock loss immediately invalidates SDK owner-session state and notifies the active CLI run.
- [x] Old run fails closed after lock loss: no success publish, no final cache state/watermark publish, no stdout success JSON.
- [x] Cleanup is idempotent after error/end/release/close ordering changes.
- [x] Next run can reacquire the PostgreSQL advisory lock after the old session is gone.
- [x] CLI emits one sanitized error and exits with code `1`.
- [x] Old run cannot overwrite a successor run's terminal or running `sync_status`; failed compensation writes only when persisted `runId` still matches.
- [x] Regression unit tests cover SDK and CLI failure paths.
- [x] Focused SDK/CLI tests, package builds, lint, and forced PostgreSQL disconnect integration test pass.

## Dependencies

- Current `pg` dependency in `packages/sdk/package.json`.
- Existing `PostgresCacheService.withVerifiedWrite()` boundary.
- Existing `cache_meta.sync_status` JSON contract.
- Existing `CacheSyncProgressReporter` serialized status writer.
- Disposable PostgreSQL for the forced disconnect gate.

## Verification

- `pnpm --filter @salesbinder/sdk exec jest --runTestsByPath src/cache/__tests__/postgres-cache.service.test.ts --runInBand` - pass, 87 tests.
- `pnpm --filter @salesbinder/sdk exec jest --runTestsByPath src/cache/__tests__/pg-to-sqlite-sync.test.ts src/cache/__tests__/sqlite-cache.service.test.ts src/cache/__tests__/sqlite-category-cache.service.test.ts --runInBand` - pass, 214 tests.
- `pnpm --filter @salesbinder/cli test --runTestsByPath src/commands/cache/cache-sync-pull-lock.test.ts --runInBand` - pass, 54 tests.
- `pnpm --filter @salesbinder/cli exec jest --silent --runInBand` - pass, 139 tests.
- `pnpm --filter @salesbinder/sdk exec jest --silent --runInBand` - pass, 841 tests, 1 env-gated integration skipped.
- `pnpm build` - pass.
- `pnpm lint` - pass with 0 errors and 7 pre-existing warnings.
- Targeted Prettier checks for every touched source, test, and documentation file - pass.
- Forced PostgreSQL disconnect integration against disposable local PostgreSQL - pass.
- `git diff --check` - pass.

## Docs Impact

Minor. `README.md` now documents fail-closed PostgreSQL writer loss, retry behavior, and PostgreSQL-to-SQLite terminal alignment.

## Unresolved Questions

None.
