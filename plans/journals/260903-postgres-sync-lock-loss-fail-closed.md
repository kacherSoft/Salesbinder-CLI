# PostgreSQL Sync Lock Loss Fail-Closed

**Date**: 2026-09-04
**Severity**: High
**Component**: PostgreSQL cache lock lifecycle, CLI sync orchestration
**Status**: Resolved

## What Happened

A production cache sync could crash when the checked-out PostgreSQL client holding the advisory sync lock emitted an `error` event. The pool-level listener only handled idle clients, so the retained owner client had no lifecycle handling. Worse, once PostgreSQL dropped that session, the advisory lock was gone, but the old process could still try writes through fresh pool clients.

The first fix was not enough. Cross-review found more races: close/acquire setup could overlap, the `onLost` callback could reject asynchronously, `cache sync --pull` could publish success before the outer PostgreSQL loss raced in, the pull service had an inherited inner-service TOCTOU around SQLite cleanup, and unknown `pg_try_advisory_lock` / `BEGIN` / `COMMIT` / `ROLLBACK` outcomes still needed hard failure behavior. We had to treat the advisory lock as a lease, not a boolean.

## Technical Details

- Added checked-out lock-client `error`/`end` lifecycle handlers.
- Added owner-session write fencing and serialized writes while the sync lock is held.
- Added sticky `PostgresSyncLockLostError` state so later writes cannot silently use fresh clients.
- Added same-run failed `sync_status` CAS after lock loss and stale-successor protection.
- Propagated lock-loss abort signals into CLI sync, clear, import, payment sync, and SalesBinder v2/v3 clients.
- Made PG-to-SQLite pull preserve source sync status atomically with mirror replacement and compensate local terminal status on post-replace failures.
- Avoided abort-racing the whole PG-to-SQLite pull from the outer CLI so SQLite cleanup always settles.
- Fixed the follow-up races from review: close/acquire draining, async `onLost` rejection, post-success PG/SQLite compensation timing, and the inherited outer/inner pull ownership split.
- Routed all checked-out read-only snapshot clients through handled error and transaction-boundary cleanup; uncertain sessions are destroyed instead of returned to the pool.
- Replaced timestamp-only `runId` values with UUID-backed ownership tokens, closing the same-millisecond stale-CAS collision path.
- Confirmed rollback, same-run compensation, successor fencing, and snapshot preservation during a real backend kill while an inventory write was blocked mid-transaction.
- `README.md` picked up a small reliability note for the fail-closed sync behavior and mirror alignment.

## Verification

- SDK focused PostgreSQL suite: 87 tests passed.
- SDK focused PG-to-SQLite/SQLite/client suites: 214 tests passed.
- CLI focused lock-ordering suite: 54 tests passed.
- Full SDK suite: 841 tests passed, 1 env-gated integration skipped in default mode.
- Full CLI suite: 139 tests passed.
- Build passed.
- Lint passed with 0 errors and 7 pre-existing warnings.
- Forced PostgreSQL disconnect integration passed against disposable local PostgreSQL.
- Diff whitespace check passed.
- Repo-wide `pnpm format:check` still reports unrelated pre-existing drift in other files; the touched lock-loss surfaces were not the source of that noise.

## Root Cause Analysis

The old design treated advisory-lock ownership as a local boolean after acquisition. That is not enough for PostgreSQL session locks: if the owning session dies, the lock is released even though the process remains alive. Without checked-out client listeners and owner-session fencing, the process can both crash on an unhandled event and accidentally continue writing after it no longer owns the lease.

## Lessons Learned

- Pool `error` handlers do not protect checked-out clients.
- Session advisory locks must fence writes to the owner session, not just guard acquisition.
- Terminal status compensation needs run identity checks because another run can legitimately start after the old session dies.
- Abort races are safe for cancellable reads and API waits, but not for operations that own cleanup responsibilities.
- A success path needs a failure escape hatch before it can be trusted in the presence of lock loss.

## Next Steps

Branch is ready for commit after maintainer review. No unresolved questions. AgentWiki publishing was skipped because no integration was available in this session.
