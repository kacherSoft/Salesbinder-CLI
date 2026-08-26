---
title: "Pre-commit Review Fixes"
description: "Fix six accepted cache/payment review defects before any commit."
status: completed
priority: P0
effort: 1d
branch: main
tags: [cache, sqlite, postgresql, payments, cli]
created: 2026-08-26
---

# Pre-commit Review Fixes

## Context

Read: `README.md`; no root `CLAUDE.md` exists; `plans/260826-1336-archived-record-cache-schema/plan.md`; cache services, payment sync, PG pull, CSV import, CLI cache commands, and focused tests. Worktree is dirty; preserve all existing edits. No commit until user requests/approves.

## Outcome

Repair all six accepted defects: genuine SQLite v1/v2->v4 migration coverage; duplicate payment transaction ID rejection; atomic PG->SQLite mirror replacement; shared writer locking for cache clear and non-dry-run CSV import; correct failed sync backend metadata; original payment sync error preserved if failed-status write fails.

## Ownership

Worker 1 - SDK persistence contracts:
- Owns: `packages/sdk/src/cache/sqlite-cache.service.ts`, `packages/sdk/src/cache/postgres-cache.service.ts`, `packages/sdk/src/cache/cache.interface.ts`, `packages/sdk/src/cache/payment-sync.helpers.ts`.
- Implements migration ordering, real duplicate-ID guard shared by SQLite/Postgres payment writes, and any minimal transaction/snapshot API needed by Worker 2.

Worker 2 - Sync orchestration:
- Owns: `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts`, `packages/sdk/src/cache/payment-sync.service.ts`.
- Uses Worker 1 APIs to replace the SQLite mirror in one atomic transaction and preserves the original `PaymentSyncService` error when persisting failed status throws.

Worker 3 - CLI/import writer coordination:
- Owns: `packages/cli/src/commands/cache/cache.commands.ts`, `packages/sdk/src/cache/csv-cache-import.service.ts`.
- Applies shared writer locks to PostgreSQL/SQLite cache clear and non-dry-run CSV import; dry-run remains lock-free. Persists explicit selected sync backend in failed `sync_status.syncTarget`.

Tester - tests only:
- Owns: `packages/sdk/src/cache/__tests__/**` and any new test fixture files under that tree only. Reads implementation files, does not edit them.

Reviewer:
- Read-only review after tests pass; inline or report findings only. No source/test edits.

## Dependencies

1. Worker 1 first: shared helper/API decisions unblock Worker 2 and Worker 3.
2. Worker 2 after Worker 1 API shape is available.
3. Worker 3 can start after Worker 1 lock/interface shape is available.
4. Tester runs after all three workers finish and resolves only test files.
5. Reviewer runs after focused tests and build/typecheck pass.

## Acceptance Criteria

- SQLite migration tests use genuine legacy v1 and v2 database fixtures/builders, not current-schema mutation, and prove ordered v1->v2->v3->v4 migration preserves records and leaves item/document `archived` as `NULL`.
- Duplicate transaction IDs in one replacement or batch insert are rejected before overwrite/upsert semantics can silently hide data in SQLite or PostgreSQL; existing rows remain unchanged on failure.
- PG->SQLite pull cannot leave a cleared/partial mirror if any insert or metadata write fails; previous SQLite data remains readable after failure.
- `cache clear` and non-dry-run `cache import-export` honor the same per-account writer lock as sync/pull/payment sync and always release locks on success/failure.
- Failed cache sync metadata records the actual selected backend (`postgresql` when PG service was selected, otherwise `sqlite`) instead of inferring from lock-key presence.
- `PaymentSyncService.syncHistoricalPayments()` rethrows the original sync/fetch/normalization error even if writing failed status also fails.

## Completion

- [x] Six accepted defects fixed; cross-document collision hardening added.
- [x] Verified: 193 tests, build, lint 0 errors / 26 warnings, diff check; final review found no findings.
- [x] Docs impact: minor; README already covers behavior.
- [x] No commit; dirty workspace preserved.
- [x] Release gaps remain: live disposable PostgreSQL smoke; no durable CLI unit harness.

## Test Gates

- Focused: `pnpm --filter @salesbinder/sdk test -- --runTestsByPath packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts packages/sdk/src/cache/__tests__/payment-sync.service.test.ts packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts packages/sdk/src/cache/__tests__/csv-cache-import.service.test.ts`.
- CLI/source compile: `pnpm --filter @salesbinder/sdk build` and `pnpm --filter @salesbinder/cli build`.
- If CLI command tests are added, run their focused path too.
- Broad before handoff: `pnpm test` if focused gates pass and runtime permits.

## Rollback

Revert only files owned by the worker whose change fails review; do not touch unrelated dirty files. For atomic-pull changes, rollback must restore previous SQLite mirror contents by leaving old DB untouched on failure. No database downgrade or schema decrement.

## Unresolved Questions

None.
