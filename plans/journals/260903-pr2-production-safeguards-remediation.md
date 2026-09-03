# PR #2 Production Safeguards Remediation

**Date**: 2026-09-03 14:44
**Severity**: High
**Component**: SDK v3 inventory sync, PostgreSQL cache, SQLite tests
**Status**: Resolved

## What Happened

PR #2 closed the gap between the intended v3 inventory contract and the actual integration path. The original implementation let root stability, variation hydration, and text cleanup interact too loosely, so this pass tightened the boundaries: canonical IDs stay strict, display/free-text fields get NUL stripping only, and each observed root is validated against the adjacent root before variation data is read.

The sync path now keeps the bounded typed retry model intact. Records that fail strict validation still flow through the existing last-known-good or omit warning path instead of turning the whole snapshot into a hard failure. The non-semantic heartbeat also stays live across the full stability loop, including retry backoff.

PostgreSQL cache handling also got a safety patch: idle pool errors are now attached to a listener so a dropped idle connection does not become an uncaught event. In test land, a cross-realm `better-sqlite3` error exposed a Jest matcher false failure, so the SQLite assertion was rewritten to check the rejection payload directly instead of relying on `toThrow` across VM boundaries.

## Technical Details

- Exact identifier/display split: canonical SKU, serial, barcode, item IDs, variation IDs, and location IDs still fail strict validation; only display-text fields sanitize literal NULs.
- Root stability now compares adjacent reads before variation hydration, rather than trusting one stable root and widening later.
- Retry behavior remains bounded and typed; recovery still uses the existing LKG/omit warning contract.
- PostgreSQL pool idle errors are handled via an `error` listener.
- Verification: SDK `797` tests passed, CLI `126` tests passed, builds passed, lint passed, formatting passed, and `git diff --check origin/main` passed.
- Review evidence: two Sol High reviews and the mandatory code review passed with no P0-P3 findings.
- Docs impact: none.

## What We Tried

- Kept the v3 snapshot architecture intact instead of introducing a new retry framework.
- Reproduced the SQLite failure under forced suite order and replaced the brittle matcher with a realm-safe assertion.
- Ran the focused SDK and CLI gates before accepting the branch state.

## Root Cause Analysis

The original PR assumed the snapshot boundary was stronger than it was. That let root identity checks, variation fetch timing, and free-text sanitization blur together. The SQLite failure was separate but related in shape: a native error crossed Jest realms and the matcher misclassified it.

## Lessons Learned

- Never let display-field cleanup dilute canonical identity validation.
- Validate adjacent root snapshots before spending work on variation hydration.
- Keep retry recovery bounded and explicit; do not widen it into a silent catch-all.
- Treat cross-realm native errors as a test design problem, not a product failure.

## Next Steps

Branch is ready for commit, push, and merge once the normal PR workflow is executed. No evergreen docs update is required.

Publishing skipped: no AgentWiki integration was available in this session.

## Unresolved Questions

None.
