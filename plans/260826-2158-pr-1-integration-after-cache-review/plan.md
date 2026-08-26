---
title: "PR 1 Integration After Cache Review"
description: "Local integration of PR #1 on the reviewed cache/archive/payment baseline; GitHub push/merge still pending."
status: in-progress
priority: P1
effort: "1d"
branch: main
pr: 1
tags: [cache, archive, payments, integration, github]
created: 2026-08-26
---

# PR 1 Integration After Cache Review

## Overview

Integrate GitHub PR #1 (`feat/merge-kachersoft-customizations`, commit `8bc950a`) into the reviewed cache update. The local work is already in place: schema v4 archive/payment safety remains intact, schema v5 shipping fields are layered on top, the full-resume checkpoint is fail-closed, retry/items behavior is wired, the unsafe PR-added operational scripts are excluded, and the final review gaps around PG self-lock, Retry-After cap, and payment-evidence checkpointing are closed. GitHub push/update/merge is the only remaining execution step.

## Scope

In: preserve reviewed cache safety fixes, keep the v4 archive/payment behavior intact, layer in the v5 shipping fields and resume/retry behavior, record the validation result, then push/update/merge once GitHub work resumes.

Out: API v3 migration, new analytics behavior, production data writes, live SalesBinder or PostgreSQL smoke unless credentials and explicit run approval are provided, and any support for the PR-added operational scripts that were intentionally excluded.

## Intended Files And Areas

- Current dirty baseline to preserve: `README.md`, `packages/cli/src/commands/cache/*`, `packages/sdk/src/cache/**`, `packages/sdk/src/types/{documents.types.ts,items.types.ts}`.
- PR #1 overlap: cache command orchestration, account/document/item indexers, PG/SQLite services, PG->SQLite pull, cache types, document/item type fields.
- PR #1 non-overlap now resolved by exclusion: `jest.config.js`, `packages/sdk/src/client/axios.factory.ts`, `packages/sdk/src/resources/items.resource.ts`, and all 16 PR-added scripts remain out of the merge.
- Generated plan detail: [Phase 1](./phase-01-start.md).

## Conflict Strategy

- Treat the reviewed dirty work as authoritative for schema v4, tri-state `archived`, payment transactions, duplicate transaction rejection, atomic `replaceMirror`, shared writer locks, explicit failed `syncTarget`, and original payment-sync error preservation.
- Layer PR #1 behavior on top where it is now implemented: `date_sent`, `shipped_percent`, `quantity_shipped`, NUL sanitization, 522 retry and retry delay env support, item-detail retry/fallback guarded by tests, and `--full-resume` checkpointing that coexists with locks/status/watermarks.
- Final review gaps were closed for PG self-lock, Retry-After cap, and payment-evidence checkpoint handling.
- Do not accept PR #1 schema version `2` or cache-state writes that regress `CACHE_SCHEMA_VERSION = 4`, archive null-preservation, payment table mirror pulls, or failure semantics.
- All 16 PR-added operational scripts are excluded from the merge instead of being rewritten into supported repo scripts.

## Required Fixes

- [x] Shipping fields are integrated into SQLite/PostgreSQL schemas, migrations, column lists, coercion, PG->SQLite snapshots, and document mappers with v4 safety preserved.
- [x] Resume checkpoint types exist without weakening `SyncOptions`; CLI output/failure handling uses `process.exitCode`, closes services once, and releases locks.
- [x] Payment-aware mirror pull counts are extended for the PR #1 field set.
- [x] Tests cover shipping field persistence, PR resume checkpoints, retry behavior, NUL sanitization, and the existing payment/archive review defects.

## Gates

- Local validation: `git diff --check` passed; focused SDK cache tests passed; `pnpm --filter @salesbinder/sdk build` and `pnpm --filter @salesbinder/cli build` passed; `pnpm -r --filter './packages/**' lint` passed with 0 errors and 17 warnings; root test run recorded 12 suites / 244 tests passing (SDK 225, CLI 19).
- Not run: live PostgreSQL/SalesBinder smoke.
- Remaining GitHub step: push the integration branch, update PR #1 with the final summary/checks, and merge once GitHub confirms mergeability.

## Rollback

Keep a pre-integration patch/commit reference before source edits. If integration fails, restore to the reviewed dirty cache update plus this plan; do not reset unrelated user changes. If PR #1 merge breaks only a retained feature, revert that feature's files/scripts and rerun focused gates.

## Docs Impact

Minor to moderate: `README.md` already reflects the committed behavior for cache commands, schema fields, env vars, sync status, and checkpointing. No further evergreen docs churn is needed for the excluded scripts.

## Unresolved Questions

- None. The retained decision is to exclude all 16 PR-added scripts, and live PostgreSQL/SalesBinder smoke was intentionally not run.

## Success Criteria

- [x] Reviewed archive/payment/cache fixes remain intact.
- [x] Useful PR #1 behavior is integrated without schema, lock, mirror, or payment regressions.
- [x] Tests/build/lint gates are recorded; only GitHub push/update/merge remains.

<!-- slug: pr-1-integration-after-cache-review -->
