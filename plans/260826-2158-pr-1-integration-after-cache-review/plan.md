---
title: "PR 1 Integration After Cache Review"
description: "Merge origin/pr-1 on top of the reviewed cache/archive/payment update without losing safety fixes."
status: pending
priority: P1
effort: "1d"
branch: main
pr: 1
tags: [cache, archive, payments, integration, github]
created: 2026-08-26
---

# PR 1 Integration After Cache Review

## Overview

Integrate GitHub PR #1 (`feat/merge-kachersoft-customizations`, commit `8bc950a`) into the current dirty, reviewed cache update. GitHub reports PR #1 open, non-draft, clean, and mergeable into `main`; local risk is the heavy overlap with uncommitted archive schema v4, payment sync, writer locks, and atomic mirror fixes.

## Scope

In: resolve overlapping cache command/service changes, preserve reviewed cache safety fixes, add PR #1 shipping fields/resume/retry/script work where still valid, run focused tests/build/lint, commit, push, update PR #1, and merge only after gates pass.

Out: API v3 migration, new analytics behavior, production data writes, live SalesBinder or PostgreSQL smoke unless credentials and explicit run approval are provided, broad script rewrites beyond making retained scripts safe to commit.

## Intended Files And Areas

- Current dirty baseline to preserve: `README.md`, `packages/cli/src/commands/cache/*`, `packages/sdk/src/cache/**`, `packages/sdk/src/types/{documents.types.ts,items.types.ts}`.
- PR #1 overlap: cache command orchestration, account/document/item indexers, PG/SQLite services, PG->SQLite pull, cache types, document/item type fields.
- PR #1 non-overlap: `jest.config.js`, `packages/sdk/src/client/axios.factory.ts`, `packages/sdk/src/resources/items.resource.ts`, `scripts/*.mjs`, `scripts/monitor-item-full-sync.sh`.
- Generated plan detail: [Phase 1](./phase-01-start.md).

## Conflict Strategy

- Treat the reviewed dirty work as authoritative for schema v4, tri-state `archived`, payment transactions, duplicate transaction rejection, atomic `replaceMirror`, shared writer locks, explicit failed `syncTarget`, and original payment-sync error preservation.
- Apply PR #1 selectively: keep `date_sent`, `shipped_percent`, `quantity_shipped`, NUL sanitization, 522 retry and retry delay env support, item-detail retry/fallback only if tests prove no masking of real API contract failures, and `--full-resume` only after it coexists with locks/status/watermarks.
- Do not accept PR #1 schema version `2` or cache-state writes that regress `CACHE_SCHEMA_VERSION = 4`, archive null-preservation, payment table mirror pulls, or failure semantics.
- Operational scripts must not read or write hard-coded user paths, leak `.env` values, or bypass shared cache APIs. Commit only scripts that are portable and documented enough to maintain.

## Required Fixes

- Merge shipping fields into SQLite/PostgreSQL schemas, migrations, column lists, coercion, PG->SQLite snapshots, and document mappers with v4 migration tests.
- Add resume checkpoint types without weakening `SyncOptions` and update CLI output/failure handling to use `process.exitCode`, close services once, and release locks.
- Extend payment-aware mirror pull counts when adding PR #1 fields.
- Add or adjust tests for shipping field persistence, PR resume checkpoints, retry behavior, NUL sanitization, and existing payment/archive review defects.

## Gates

- Pre-commit: `git diff --check`; focused SDK cache tests including sqlite, pg-to-sqlite, csv import, payment sync, archive-state indexers; new tests for PR #1 behavior.
- Build: `pnpm --filter @salesbinder/sdk build` and `pnpm --filter @salesbinder/cli build`.
- Lint: `pnpm -r --filter './packages/**' lint`; warnings acceptable only if pre-existing and unchanged in count/class.
- Optional before merge if time permits: `pnpm test`.
- GitHub: push integration branch, update PR #1 with final summary/checks, merge only when local gates pass and `gh pr view 1` still reports open/mergeable with no failing checks.

## Rollback

Keep a pre-integration patch/commit reference before source edits. If integration fails, restore to the reviewed dirty cache update plus this plan; do not reset unrelated user changes. If PR #1 merge breaks only a retained feature, revert that feature's files/scripts and rerun focused gates.

## Docs Impact

Minor to moderate: update `README.md` only if committed behavior changes user-facing cache commands, schema fields, env vars, sync status, or scripts. Do not churn evergreen docs for rejected PR-only code.

## Unresolved Questions

- Should PR #1 operational scripts be maintained as supported repo scripts or kept out of the merge after extracting their reusable code?
- Is live PostgreSQL/SalesBinder smoke authorized after local gates, or should PR #1 merge rely on unit/build/lint only?

## Success Criteria

- [ ] Reviewed archive/payment/cache fixes remain intact.
- [ ] Useful PR #1 behavior is integrated without schema, lock, mirror, or payment regressions.
- [ ] Tests/build/lint gates recorded in PR #1 before merge.

<!-- slug: pr-1-integration-after-cache-review -->
