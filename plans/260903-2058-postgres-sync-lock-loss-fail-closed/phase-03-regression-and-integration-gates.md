---
phase: 3
title: 'Regression And Integration Gates'
status: complete
priority: P1
effort: '2h'
dependencies: [1, 2]
---

# Phase 3: Regression And Integration Gates

## Context Links

- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`
- `package.json`
- `packages/sdk/package.json`
- `packages/cli/package.json`

## Overview

Prove the repaired behavior with direct unit tests for owner-session fencing, CLI orchestration tests for fail-closed output/status, builds, and a disposable PostgreSQL forced-disconnect integration test.

## Requirements

- Functional: tests fail on current code and pass after implementation.
- Functional: include owner-session write routing and per-lease queue tests, not only local lost-state tests.
- Functional: include a real PostgreSQL session termination test.
- Non-functional: tests do not require SalesBinder network calls or real credentials.

## Architecture

Use three test layers:

1. SDK unit tests with fake retained lock clients and separate fresh pool clients.
2. CLI Jest tests using existing `cache-sync-pull-lock.test.ts` mocks plus a Postgres-only loss callback.
3. Disposable PostgreSQL integration test using two `PostgresCacheService` instances and controlled session termination.

For integration, prefer a focused Jest file gated by an explicit env var, plus a manual forced run during delivery:

```text
SALESBINDER_POSTGRES_DISCONNECT_TEST_URL=postgres://... pnpm --filter @salesbinder/sdk test -- --runTestsByPath packages/sdk/src/cache/__tests__/postgres-sync-lock-disconnect.integration.test.ts
```

The implementation runner can start disposable PostgreSQL with Docker when available, create a temporary database/schema, terminate the backend session holding the advisory lock from a second connection, and assert:

- old service receives the lock-loss signal;
- an inventory replacement interrupted after partial transactional mutation rolls back to the prior authoritative rows and metadata;
- old service refuses fallback writes;
- old failed `sync_status` update only applies when `runId` still matches;
- new service reacquires the lock and can write as the owner session.

## Related Code Files

- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts` - owner-session routing, queue, loss, cleanup, conditional failed status.
- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts` - CLI fail-closed, stdout/stderr, no stale terminal overwrite.
- Create: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/postgres-sync-lock-disconnect.integration.test.ts` - real PostgreSQL disconnect test.
- Read/verify unchanged: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/cache-sync-progress-reporter.test.ts` - no reporter API change expected.
- Delete: none.

## Implementation Steps

1. SDK unit: acquire lock with fake retained client, call a representative `withVerifiedWrite` method, assert SQL ran on retained client and fresh pool client was not used for the transaction.
2. SDK unit: start two writes while lock held; block the first and assert the second starts only after first commit/rollback.
3. SDK unit: emit `error` on retained client; assert no unhandled crash, loss callback called once, sticky state set, and later data write refuses fresh-client fallback.
4. SDK unit: emit `end`; assert same invalidation path.
5. SDK unit: call `releaseSyncLock()` and `close()` after loss; assert no duplicate unlock/release.
6. SDK unit: failed `setSyncStatus()` after loss uses conditional fresh-client update only when stored `runId` matches.
7. SDK unit: successor `sync_status.runId` mismatch remains unchanged and surfaces stale-status result/error.
8. CLI unit: force lock-loss callback mid-sync; assert exit `1`, no stdout success JSON, one sanitized stderr error, and no success/warning terminal status.
9. CLI unit: simulate successor `sync_status.runId` before old failure; assert old failure does not overwrite it and stale-status error is suppressed.
10. CLI unit: `cache sync --pull` lock loss before terminal persistence is fatal and does not mirror success.
11. Integration: block an inventory replacement mid-transaction, terminate the backend session holding the advisory lock, and assert rollback to the prior snapshot, no fallback write, conditional failed status, successor-run preservation, and next-run reacquire.
12. Run narrow tests first, then package builds.

## Todo List

- [x] Add SDK owner-session routing regression.
- [x] Add SDK per-lease queue regression.
- [x] Add SDK error/end lock-loss regressions.
- [x] Add SDK sticky no-fallback regression.
- [x] Add SDK conditional failed-status regression.
- [x] Add CLI lock-loss fail-closed tests.
- [x] Add CLI stale-successor status protection test.
- [x] Add `cache sync --pull` lock-loss test.
- [x] Add forced PostgreSQL disconnect integration test.
- [x] Run focused SDK tests.
- [x] Run focused CLI tests.
- [x] Run SDK and CLI builds.
- [x] Run forced disposable PostgreSQL disconnect test.

## Success Criteria

- [x] `pnpm --filter @salesbinder/sdk exec jest --runTestsByPath src/cache/__tests__/postgres-cache.service.test.ts --runInBand`
- [x] `pnpm --filter @salesbinder/cli test --runTestsByPath src/commands/cache/cache-sync-pull-lock.test.ts --runInBand`
- [x] `pnpm build`
- [x] `pnpm lint`
- [x] Forced PostgreSQL disconnect integration test passes against disposable PostgreSQL.

## Risk Assessment

- Risk: queue tests become brittle if they assert incidental SQL order. Mitigation: assert lease/fresh-client ownership, transaction boundaries, and second-write start timing only.
- Risk: integration test flakes on backend termination timing. Mitigation: wait on explicit lock-loss signal with a short bounded timeout; do not rely on arbitrary sleep.
- Risk: Docker unavailable in the implementation environment. Mitigation: integration test must also run with any supplied PostgreSQL URL; delivery records which source was used.
- Risk: normal test suite hangs when no PostgreSQL URL exists. Mitigation: gate integration file explicitly and run it forcibly in implementation with a disposable URL.

## Security Considerations

- Never print PostgreSQL URLs.
- Use temporary database/schema names without customer data.
- No SalesBinder API credentials or network calls.

## Rollback

Rollback source and tests for this plan only. No schema downgrade and no cache-data migration required. If owner-session fencing breaks unrelated PostgreSQL writes, first restore no-lock fresh-client path for operations executed when no sync lock is held; do not restore fresh-client fallback while a sync lock is active.

## Results

- Focused SDK owner-session suite: pass, 87 tests.
- Focused PG-to-SQLite/SQLite mirror suites: pass, 214 tests.
- Focused CLI lock-ordering suite: pass, 54 tests.
- Full CLI suite: pass, 139 tests.
- Full SDK suite: pass, 841 tests, 1 env-gated integration skipped in default mode.
- Forced PostgreSQL disconnect integration: pass against disposable local PostgreSQL.
- Build: pass.
- Lint: pass with 0 errors and 7 pre-existing warnings.
- Targeted Prettier checks: pass for every touched source, test, and documentation file.
- Diff whitespace check: pass.

## Next Steps

Code review complete. Commit/push can proceed after maintainer approval.
