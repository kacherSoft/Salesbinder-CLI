# Pre-commit Review Fixes

**Date**: 2026-08-26 21:16
**Severity**: High
**Component**: cache sync, CSV import, payment sync
**Status**: Resolved

## What Happened

We took a six-defect pre-commit review and split the work across persistence, sync, and import owners so the fixes could land without trampling each other. Worker 1 fixed real migration ordering for SQLite v1/v2→v4 instead of pretending current-schema mutation proved anything. Worker 2 made PG→SQLite mirror replacement atomic and preserved the original payment-sync error even when the failed-status write also blew up. Worker 3 added shared writer locking for cache clear and non-dry-run CSV import, and the cache sync path now records the explicit `syncTarget` instead of guessing from lock state.

The ugly part was the payment collision path. Duplicate transaction IDs now get rejected before overwrite/upsert semantics can hide data, including the cross-document case where the same payment identity shows up in more than one document. That was the kind of bug that looks “fine” until reconciliation turns into a lie.

## The Brutal Truth

This was exactly the sort of pre-commit mess that burns a day because the first pass is too optimistic. The debugger caught the bad assumptions, then we had to rework the path instead of hand-waving it away. It was frustrating, but the alternative was shipping a cache layer that could silently corrupt sync state and payment history.

## Technical Details

The completion report is clean: 193 tests passed, both `pnpm --filter @salesbinder/sdk build` and `pnpm --filter @salesbinder/cli build` passed, lint reported 0 errors and 26 warnings, diff check was done, and the final reviewer found no findings. Docs impact was none. No commit was created.

## What We Tried

We first chased the failures as isolated issues, then split the ownership so the migration, sync, and writer-lock changes could be proven independently. After the debugger caught the error-preservation and backend-selection gaps, we tightened the implementation and reran the focused gates instead of trying to paper over the failures.

## Root Cause Analysis

The real problem was trusting inferred state and partial writes. Migration order, mirror replacement, and payment dedupe all needed hard guarantees, not best-effort behavior. The old paths were too willing to guess.

## Lessons Learned

Never treat a dirty sync path as “good enough” just because the happy case passes. If the code can lose the original error, silently overwrite a payment, or leave a half-pulled mirror behind, it is not safe.

## Next Steps

Keep the two release gaps visible: run a live disposable PostgreSQL smoke before release, and add a durable CLI unit-test harness so this class of fix is not validated only through focused SDK and build gates.

## Unresolved Questions

None on the remediation itself. The remaining release gaps are still open work: live disposable PostgreSQL smoke and a durable CLI unit-test harness.
