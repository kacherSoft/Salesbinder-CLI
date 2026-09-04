---
phase: 2
title: 'CLI Fail-Closed Orchestration'
status: complete
priority: P1
effort: '3h'
dependencies: [1]
---

# Phase 2: CLI Fail-Closed Orchestration

## Context Links

- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache.commands.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-progress-controller.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/cache-sync-progress-reporter.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-cache.service.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/pg-to-sqlite-sync.service.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`

## Overview

Use the Postgres-only lock-loss signal to abort `cache sync` promptly. The old run must stop before success/warning terminal publish, final cache state/watermark publish, pull settlement success, and stdout success JSON. Failed status compensation after loss must use a fresh client only if persisted `sync_status.runId` still belongs to this run. The final behavior also uses a UUID run-ownership token, atomically mirrors source `sync_status` into the SQLite snapshot, and splits the abort path so SQLite side effects are never abandoned mid-cleanup.

## Key Insights

- Owner-session fencing in Phase 1 prevents old-run data writes after loss.
- CLI still needs a signal to stop API work and avoid success output after a lock session dies.
- Existing `terminalRequested` prevents duplicate terminal writes inside one process; it does not protect against stale writes after a successor run starts.
- `setSyncStatus()` currently overwrites `cache_meta.sync_status` unconditionally.
- `cache sync --pull` relies on the outer PG lock through pull terminal persistence; lock loss must turn the whole sync into failure.
- The outer CLI must not abandon the inner PG-to-SQLite pull before SQLite cleanup settles; only the safe PostgreSQL work is raced.

## Requirements

- Functional: call the Postgres-only lock-loss API when acquiring the PostgreSQL sync lock.
- Functional: race the active sync workflow against a lock-loss promise.
- Functional: after lock loss, never publish success, warnings, final cache state, clean watermarks, or stdout success JSON.
- Functional: failed `sync_status` after lock loss may use a fresh client only with conditional `runId` match.
- Functional: if a successor already wrote `sync_status`, old failure compensation must not overwrite it.
- Functional: atomic SQLite mirror replacement carries source `sync_status` in the same commit.
- Non-functional: exactly one stderr error object; stdout remains empty on failure; `process.exitCode = 1`.

## Architecture

Use the class-specific `PostgresCacheService.tryAcquireSyncLock(lockKey, { onLost })` overload only on the PostgreSQL branch. Do not change `CacheService` method signatures.

```ts
const lockLoss = createLockLossSignal();
lockAcquired = await pgService.tryAcquireSyncLock(syncLockKey, {
  onLost: (error) => lockLoss.fail(error),
});

await awaitWhileSyncLockHeld(lockLoss, runAbortablePhase);
```

`PostgresCacheService.setSyncStatus(status)` internal behavior:

- Normal active lease: run through owner-session queue like any other `withVerifiedWrite`.
- Lost lease + `status.status === 'failed'`: open a fresh client, update `cache_meta.sync_status` only where stored JSON `runId` equals `status.runId`; otherwise throw or return a stale-status result that CLI suppresses.
- Lost lease + `success` or `success_with_warnings`: reject; never fresh-client publish success after lock loss.

CLI failure path:

1. Convert lock-loss error to a fixed safe error.
2. Attempt `progressReporter.markFailure()` once.
3. Let stale-status mismatch be suppressed after it proves no overwrite happened.
4. Finish stderr progress line.
5. Print one `formatError()` object to stderr.
6. Set `process.exitCode = 1`.
7. Release/close idempotently.
8. Keep the PG-to-SQLite pull on its own checked/awaited lifecycle so SQLite cleanup is not abandoned by the outer race.

## Related Code Files

- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache.commands.ts` - Postgres-only loss signal, lock-loss race, fail-closed output handling.
- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-cache.service.ts` - internal failed-status conditional fresh-client compensation after lost lease.
- Read/verify unchanged: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/cache-sync-progress-reporter.ts` - no expected-run API required; it keeps calling `setSyncStatus(status)`.
- Read/verify unchanged unless tests prove needed: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-progress-controller.ts`.
- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts` - CLI lock-loss and stale-status regressions.
- Create: none unless a tiny local helper keeps `cache.commands.ts` under control.
- Delete: none.

## Implementation Steps

1. Add a small local lock-loss signal helper in `cache.commands.ts`; attach a catch/noop handler immediately to avoid unhandled rejection before `Promise.race`.
2. Pass `{ onLost }` only to the PostgreSQL `tryAcquireSyncLock` call; keep SQLite path unchanged.
3. Move the current post-lock sync body into a nested `runLockedSyncWorkflow()` or minimal equivalent so it can be raced.
4. Ensure any lock-loss race winner prevents later success/warning terminal calls and stdout JSON.
5. Make `toSafeCacheSyncError()` preserve either a fixed lock-lost message or existing `Cache sync failed.`; never raw PG detail.
6. In PostgreSQL `setSyncStatus()`, detect lost lease. For failed status only, perform conditional fresh-client update:
   - `key = 'sync_status'`
   - existing JSON `runId` equals incoming `status.runId`
   - write fixed sanitized failed status
7. On conditional mismatch, leave successor status unchanged and surface a safe stale-status error for CLI to suppress.
8. Ensure `cache sync --pull` treats lock loss before/during `onSettledWhileLocked` as fatal and does not mirror success.
9. Do not abort-race the whole PG-to-SQLite pull from the outer CLI. The pull service owns SQLite lock cleanup and performs its own abortable PostgreSQL reads plus checked SQLite writes.
10. Keep `releaseCacheWriterLockAndClose()` unchanged except for any type adjustment needed for idempotent Postgres release.

## Todo List

- [x] Add CLI lock-loss operation guard.
- [x] Use Postgres-only `onLost` signal without changing `CacheService` method signatures.
- [x] Block success/warning terminal publish after loss.
- [x] Block final cache-state/watermark publish after loss.
- [x] Add conditional fresh-client failed `sync_status` compensation.
- [x] Suppress stale-status mismatch only after no overwrite occurs.
- [x] Keep one sanitized stderr error and no stdout on failure.
- [x] Preserve SQLite sync path.
- [x] Keep outer CLI from abandoning PG-to-SQLite pull before SQLite cleanup settles.

## Success Criteria

- [x] Simulated Postgres lock loss during accounts/categories/documents/items/deleted-log causes exit `1`, no stdout, one stderr error, and no success/warning terminal status.
- [x] Simulated successor `sync_status.runId` is not overwritten by old failure.
- [x] Failed status after loss writes only when persisted `runId` still matches this run.
- [x] Existing success, warning, pull, checkpoint, and missing-v3-key CLI tests keep expected output.
- [x] SQLite sync path remains behavior-compatible.

## Results

- Focused CLI suite: pass, 54 tests.
- Prompt abort split keeps SQLite cleanup and replacement commit intact while still failing the outer sync closed.
- Post-success failure compensation now uses the actual outer owner run and the UUID ownership token, so a successor run cannot be overwritten.

## Risk Assessment

- Risk: `Promise.race` leaves in-flight API work running. Mitigation: owner-session fencing blocks later writes; CLI failure path closes cache service and skips success output.
- Risk: failed-status fresh-client path could become a general fallback. Mitigation: restrict it to lost-lease `status === 'failed'` and matching persisted `runId`.
- Risk: stale status mismatch could mask another failure. Mitigation: suppress only the known stale-status error after the conditional update proves zero rows changed.
- Risk: success pull settlement races with lock loss. Mitigation: test `cache sync --pull` loss before terminal persistence and require fatal settlement.

## Security Considerations

- No raw PG error details in CLI output.
- Do not persist connection URLs, backend PIDs, account secrets, or request payloads.
- Status fencing protects user-facing cache health from stale-run poisoning.

## Next Steps

Phase 3 adds direct owner-session queue tests, CLI fail-closed tests, and a real PostgreSQL disconnect gate.
