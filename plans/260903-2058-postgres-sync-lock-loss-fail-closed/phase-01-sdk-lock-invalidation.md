---
phase: 1
title: 'SDK Owner-Session Fencing'
status: complete
priority: P1
effort: '3h'
dependencies: []
---

# Phase 1: SDK Owner-Session Fencing

## Context Links

- `README.md`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-cache.service.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/cache.interface.ts`
- `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts`

## Overview

Make the PostgreSQL sync lock a real write lease. While the lease exists, every `withVerifiedWrite` transaction must execute on the retained advisory-lock client through a per-lease queue. If that owner session is lost, sticky lost state prevents fresh-client fallback and notifies the CLI through a Postgres-only signal. Final behavior also drains in-flight acquisition and close paths, destroys clients when `pg_try_advisory_lock`, `BEGIN`, `COMMIT`, or `ROLLBACK` outcomes are unknown, and keeps the lock lease consistent across shutdown.

## Key Insights

- Current pool-level listener only covers idle clients.
- `tryAcquireSyncLock()` stores a raw `PoolClient`; checked-out lock client has no `error`/`end` handler.
- PostgreSQL releases session advisory locks when the owning session ends.
- Fresh-client writes after lock loss are unsafe: the old process can mutate cache after a successor acquires the same advisory lock.
- Correct guard is owner-session fencing, not local lost-state checks alone.
- Unknown transaction or lock-acquire outcomes are safer to destroy than to keep.
- Read-only snapshot flows now treat checked-out client errors as owned-client failures and tear down the client instead of trusting the pool.
- SQLite file-lock semantics are unrelated and should not be touched.

## Requirements

- Functional: keep `CacheService` interface/signatures unchanged.
- Functional: add a concrete Postgres-only lock-loss signal/API for `PostgresCacheService` callers.
- Functional: while a PostgreSQL sync lock is held, route all `withVerifiedWrite` transactions through the retained lock client.
- Functional: serialize owner-session transactions with a per-lease promise queue.
- Functional: attach idempotent checked-out client `error` and `end` handlers.
- Functional: sticky lost state blocks fallback writes after owner-session loss.
- Functional: close and acquisition drain in-flight lease setup before the pool ends.
- Non-functional: no connection string, SQL params, API key, account private data, or raw PG error detail in public output.

## Architecture

Keep the existing public `CacheService` contract:

```ts
interface CacheService {
  tryAcquireSyncLock(lockKey: string): Promise<boolean>;
  releaseSyncLock(lockKey: string): Promise<void>;
}
```

Add a Postgres-only class API, not an interface change:

```ts
type PostgresSyncLockOptions = {
  onLost?: (error: Error) => void | Promise<void>;
};

class PostgresCacheService {
  tryAcquireSyncLock(lockKey: string, options?: PostgresSyncLockOptions): Promise<boolean>;
}
```

Represent the lock as a lease:

```ts
type HeldPostgresSyncLock = {
  client: PoolClient;
  lockKey: string;
  queue: Promise<void>;
  lostError?: Error;
  releaseStarted: boolean;
  cleanupListeners: () => void;
  onLost?: (error: Error) => void | Promise<void>;
};
```

`withVerifiedWrite()` chooses execution path:

1. If a matching active sync lease exists, enqueue the transaction on that lease and run `BEGIN`/`pg_advisory_xact_lock`/binding recheck/payload write/`COMMIT` on `lease.client`.
2. If no sync lease exists, keep current fresh-client transaction behavior.
3. If sticky lost state exists for the canonical lock, throw `PostgresSyncLockLostError`; do not fallback to pool.

Lock-client `error`/`end` handler:

1. Build fixed-message `PostgresSyncLockLostError`.
2. Mark lease lost once.
3. Remove held lease from active map but retain sticky lost state for the service lifetime.
4. Detach listeners.
5. Call `onLost(error)` inside try/catch.
6. Never throw from the event listener.

## Related Code Files

- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-cache.service.ts` - lease record, owner-session write routing, queue, loss signal, sticky lost state, idempotent cleanup.
- Read/verify unchanged: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/cache.interface.ts` - must not change signatures.
- Modify: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts` - unit regressions for routing, queueing, loss, cleanup.
- Create: none unless implementation needs a local Postgres-only exported type from `postgres-cache.service.ts`.
- Delete: none.

## Implementation Steps

1. Add `PostgresSyncLockOptions` and `PostgresSyncLockLostError` in `postgres-cache.service.ts`.
2. Replace raw `Map<string, PoolClient>` with lease records plus sticky lost-state map/set.
3. On lock acquisition, install `once('error')` and `once('end')` handlers on the retained client.
4. Add an internal `runWithSyncLease()` helper that serializes work through `lease.queue`.
5. Change `withVerifiedWrite()` to route through active lease when present; keep existing `withDatabaseTransaction()` only when no sync lease is active.
6. Ensure each queued lease transaction uses the same transaction discipline as fresh-client writes: `BEGIN`, database write xact lock, binding recheck, payload work, `COMMIT`/`ROLLBACK`.
7. On lock-client loss, mark sticky lost state and reject future queued work before it starts.
8. Make `releaseSyncLock()` idempotent for active, already-lost, already-released, and close-time paths.
9. Make `close()` drain/release active leases and tolerate lost leases before `pool.end()`.
10. Keep SQLite and `CacheService` interface untouched.

## Todo List

- [x] Add Postgres-only lock-loss option/type.
- [x] Implement held-lock lease record.
- [x] Route locked `withVerifiedWrite` transactions through retained lock client.
- [x] Serialize owner-session writes with per-lease queue.
- [x] Add checked-out client `error` and `end` handling.
- [x] Add sticky lost state that blocks fallback.
- [x] Make release/close idempotent.
- [x] Preserve `CacheService` method signatures and SQLite lock behavior.

## Success Criteria

- [x] A write while sync lock held uses the retained lock client.
- [x] Two concurrent writes while lock held run sequentially on the lease queue.
- [x] Emitting `error` on the retained lock client does not crash tests and marks the lease lost.
- [x] Emitting `end` follows the same lost path.
- [x] A data write after loss rejects with the public-safe lock-lost error without using a fresh pool client.
- [x] `releaseSyncLock()` after loss does not query unlock or double-release.
- [x] A separate service can acquire after the first service's owner session is gone.

## Risk Assessment

- Risk: serializing all locked writes on one client can expose latent assumptions about concurrent PG writes. Mitigation: cache sync is already single-writer; per-lease queue preserves order and advisory-lock semantics.
- Risk: lease queue can swallow rejection and keep accepting writes. Mitigation: sticky lost state checked before enqueue and after previous queue settles.
- Risk: listener cleanup can double-release. Mitigation: one release flag and tests for error/end/release/close ordering.
- Risk: failure status after loss cannot use owner session. Mitigation: Phase 2 uses a constrained fresh-client compensation only for failed `sync_status` with matching `runId`.

## Security Considerations

- Sanitize lock-lost errors.
- Do not log PG connection strings.
- Do not expose raw server errors in persisted `sync_status.error`; keep existing `Cache sync failed.` unless CLI chooses a fixed safe lock-loss message.

## Next Steps

Phase 2 wires the Postgres-only loss signal into `cache sync` and adds run-ID-guarded failed status compensation.

## Results

- Focused SDK core suite: pass, 87 tests.
- All four read-only snapshot transactions now handle checked-out client errors and destroy sessions after client errors or uncertain transaction boundaries.
- Owner-session queueing, loss invalidation, release/close idempotence, and no-fresh-fallback after loss are covered by regression tests.
