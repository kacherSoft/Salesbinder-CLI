---
title: 'PR #2 Production Safeguards Fix'
status: complete
branch: 'codex/pr2-production-safeguards'
pr: 2
created: '2026-09-03'
scope:
  - 'packages/cli/src/commands/cache/cache-sync-progress-controller.ts'
  - 'packages/cli/src/commands/cache/cache.commands.ts'
  - 'packages/sdk/src/cache/cache-sync-progress-reporter.ts'
  - 'packages/sdk/src/cache/v3-inventory-indexer.service.ts'
  - 'packages/sdk/src/cache/v3-inventory-normalizer.ts'
  - 'packages/sdk/src/cache/postgres-cache.service.ts'
  - 'packages/sdk/src/cache/__tests__/*'
---

# PR #2 Production Safeguards Fix

## Outcome

Prepare PR #2 for merge by repairing v3 inventory snapshot safety regressions, adding direct regression tests, formatting all changed files, and updating the PR branch only after verification and review pass.

## Constraints

- Preserve existing v3 cache snapshot architecture, retry/LKG/omit warning contract, and PostgreSQL idle pool error handling.
- Keep changes limited to PR-affected SDK cache files and their tests.
- Use real validation behavior; no fake pass-throughs, weakened checks, or skipped failures.
- Do not merge until tests and code review confirm the final branch state.

## Non-Goals

- No cache schema changes, CLI UX changes, or new retry framework.
- No redesign of item, variation, or category pagination contracts.
- No changes outside the current PR fix surface unless verification proves required.

## Acceptance Criteria

- Invalid SKU, serial, barcode, and source IDs still fail strict validation and route through existing item retry plus last-known-good or omit warning handling.
- Optional display/free-text fields remove PostgreSQL-invalid NUL characters without relaxing canonical identifier validation.
- Every observed root is compared with an adjacent root before its variation endpoints are read.
- Root pagination layout drift and root item membership drift are included in the same bounded retry path.
- A non-rendering heartbeat remains continuous across the complete root-stability retry lifecycle.
- Direct tests cover transient and exhausted drift for intra-pass pagination changes and cross-pass membership changes.
- All PR-changed files are formatted; targeted tests pass; branch is pushed; merge occurs only after review approval.

## Phase 1: Scout

- Read `README.md`, current branch diff, and affected v3 inventory/cache tests.
- Confirm PR-changed files: inventory indexer, normalizer, PostgreSQL cache service, and related tests.
- Check existing warning/recovery helpers before changing validation behavior.

## Phase 2: Diagnose

- Prove where optional text sanitation currently overlaps with strict source identifier validation.
- Trace root pass ordering to confirm variation calls can occur before root stability is fully proven.
- Identify drift errors that are retryable versus record-local validation failures that must enter LKG/omit recovery.

## Phase 3: Implement

- Split display-text sanitation from canonical SKU, serial, barcode, item ID, variation ID, and location ID validation.
- Validate each candidate root against an adjacent root before hydrating that candidate's variations.
- Extend bounded retry to cover root membership drift, not only root pagination signature drift.
- Keep one heartbeat cadence across root reads, variation hydration, and retry backoff.
- Keep item-level invalid data on the existing retry/recovery path instead of turning it into fatal snapshot failure.

## Phase 4: Verify

- Add tests for transient and exhausted intra-pass root pagination drift.
- Add tests for transient and exhausted cross-pass root membership drift.
- Add tests proving invalid canonical identifiers still produce warning outcomes while optional NUL display text is sanitized.
- Keep native SQLite storage-error assertions stable across Jest VM boundaries.
- Run focused SDK cache tests, then the package test/build command required by the repo.

## Phase 5: Code Review

- Review final diffs for retry bounds, ordering, validation strictness, and warning metadata accuracy.
- Confirm tests assert direct causes, not incidental call counts alone.
- Reject any change that weakens source identity validation or publishes an unverified snapshot.

## Phase 6: Finalize

- Format every file changed by PR #2.
- Re-run verification after formatting.
- Push the updated PR branch.
- Merge PR #2 only after tests pass and review approves the branch.

## Verification Result

- SDK: 32 suites, 797 tests passed.
- CLI: 4 suites, 126 tests passed.
- SDK and CLI builds passed.
- Lint passed with zero errors; seven SDK warnings are baseline findings outside changed hunks.
- Prettier and `git diff --check origin/main` passed.
- The formerly flaky PostgreSQL-before-SQLite suite order passed after replacing the cross-realm-sensitive Jest matcher.
- Two independent Sol High reviews and the mandatory code review approved the final code with no P0-P3 findings.
- Docs impact: none for evergreen product docs; public commands, configuration, schema, and API-version contract did not change.

## Unresolved Questions

None.
