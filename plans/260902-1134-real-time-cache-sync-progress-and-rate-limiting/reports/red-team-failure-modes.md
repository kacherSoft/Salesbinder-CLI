# Red-Team Failure Modes: Real-Time Cache Sync Progress and Rate Limiting

Conducted: 2026-09-02

Scope: hostile plan review only. Verified plan claims against code with `rg`, `nl`, and direct source reads. No source/plan edits, no lint/build/test.

## Findings

### Critical: Axios limiter installation order is underspecified, so 429s and retries can bypass the governor state

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/phase-01-start.md:44`, `:79-80`

Flaw: The plan says factories should "install limiter request/response interceptors" and then keep retries routed through the same Axios instance, but it never mandates exact interceptor order. Axios request interceptors execute LIFO by `unshift`, while response interceptors execute FIFO by `push`. A limiter installed in the wrong spot can run before retry metadata/auth exists, or fail to observe the first 429 because the existing retry error handler consumes it and returns a retried response.

Failure scenario: Implementer adds a limiter helper after current interceptors because the plan says to wire factories in implementation step 5. In request path, the limiter runs before `_retry` is initialized. In response path, if the limiter is registered after retry, it only sees the final successful retry response, never the original 429, so v3 `RateLimit-*`/cooldown state and `waiting_rate_limit` progress are wrong. Subsequent retries are "through Axios" but not through the correct limiter state transition.

Evidence:

- Axios source unshifts request interceptors and pushes response interceptors: `packages/sdk/node_modules/axios/lib/core/Axios.js:133-147`, `:154-199`.
- Existing v2 registers Basic auth first, request ID/retry metadata second, then retry response handler: `packages/sdk/src/client/axios.factory.ts:58-81`.
- Existing v2 retry consumes errors, sleeps, marks `__isRetry`, then calls `client.request(config)`: `packages/sdk/src/client/axios.factory.ts:98-131`.
- Existing v3 has the same request metadata and response retry shape: `packages/sdk/src/client/v3-axios.factory.ts:51-89`.
- The plan only tests "retry attempts hit limiter twice" but not that the first 429 is observed before retry recovery or that request metadata/auth is available at limiter time: `phase-01-start.md:65`.

Suggested fix: Amend Phase 1 to require exact order and tests: register limiter request interceptor so it executes after retry metadata is prepared if it depends on config metadata; register limiter response interceptor before the retry response interceptor so it records headers/429 cooldown before retry handling. Add a factory test where adapter fails once with 429 then succeeds, asserting the limiter observes both the original 429 error and final success in order, and that retry request IDs stay stable.

### High: 429 cooldown can double-sleep or fight retry scheduling

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/phase-01-start.md:36-37`, `:44`, `:79`, `research/researcher-progress-contract.md:139`

Flaw: The plan mixes two timing owners. It says the response interceptor should "apply cooldown on 429 before retry scheduling" and progress should emit `waiting_rate_limit` "before sleeping/retry backoff", while the existing retry interceptors already sleep before retrying. The plan does not say whether retry sleep is removed, delegated to the limiter, or retained only for non-rate-limit retries.

Failure scenario: A v3 429 with `Retry-After: 60` causes the limiter response interceptor to apply/sleep cooldown, then the existing retry handler sleeps another 60s before retrying. CLI appears hung for twice the documented wait; status remains `waiting_rate_limit` too long; tests that only assert "at least 60s" pass while production gets pathological cooldowns.

Evidence:

- Existing v2 retry sleeps inside the response error handler before retry: `packages/sdk/src/client/axios.factory.ts:100-121`.
- Existing v3 retry sleeps the same way: `packages/sdk/src/client/v3-axios.factory.ts:77-85`.
- Current retry handlers cap parsed `Retry-After` at 60000ms and then retry: `packages/sdk/src/client/axios.factory.ts:23-39`, `:106-131`; `packages/sdk/src/client/v3-axios.factory.ts:20-31`, `:77-89`.
- Plan requires cooldown tests for "waits at least 60s" and `Retry-After` precedence, but not single-owner timing or no double-wait: `phase-01-start.md:63-64`.

Suggested fix: Make rate-limit timing single-owner. Prefer moving 429 delay calculation into the limiter and making retry handler ask the limiter for the next retry time, or keep retry sleep for all retries and make limiter response handling update bucket state only without awaiting sleep. Add tests that total elapsed fake-clock time for a single `Retry-After: 60` retry is one cooldown plus jitter, not cooldown plus retry backoff.

### High: Throttled progress writes can overwrite terminal success/failed status

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/phase-02-instrument-sync-progress.md:45`, `:78`, `:94`; `phase-03-integrate-cli-progress-and-verify.md:84`

Flaw: The plan introduces routine throttled `setSyncStatus` writes and replaces the existing initial/success/failure writes with reporter/controller helpers, but it does not require serialized writes, terminal-state guarding, or compare-and-set by `runId`. Current cache services overwrite the whole `sync_status` JSON last-writer-wins.

Failure scenario: A `record_processed` progress write starts against PostgreSQL and stalls in `withVerifiedWrite`. The sync then fails and writes terminal `failed`. The older progress write completes last with `status: running`, making `cache status` report stale/running instead of the actual failure. Similar race can clobber `success` after final JSON prints.

Evidence:

- `CacheService` exposes only `getSyncStatus()` and `setSyncStatus(status)`, no conditional update/CAS contract: `packages/sdk/src/cache/cache.interface.ts:177-180`.
- SQLite `setSyncStatus` does blind `INSERT OR REPLACE` of full JSON: `packages/sdk/src/cache/sqlite-cache.service.ts:1013-1015`.
- PostgreSQL `setSyncStatus` does blind `ON CONFLICT ... DO UPDATE SET value = EXCLUDED.value`: `packages/sdk/src/cache/postgres-cache.service.ts:1294-1301`.
- Current CLI has only one start write, one success write, and best-effort failure write: `packages/cli/src/commands/cache/cache.commands.ts:144-152`, `:281-297`, `:395-408`.
- Plan forces `phase_started`, `phase_completed`, `waiting_rate_limit`, `success`, and `failed`, but does not say nonterminal writes must be dropped after terminal finalize or awaited/drained before final status: `phase-02-instrument-sync-progress.md:78`.

Suggested fix: Add reporter invariants to the plan: one serialized write queue per run; `markSuccess/markFailure` sets a terminal flag, flushes or cancels pending nonterminal writes, then writes terminal state last; later `emit()` is a no-op. For PostgreSQL/SQLite, add a conditional status update helper or read-modify-write guard that only updates when current `runId` matches and current status is not terminal, then test delayed write completion cannot revert `success`/`failed`.

### Medium: Abort/cancellation and FIFO queue removal are missing

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/phase-01-start.md:23`, `:62`, `:77`, `:103`; `research/researcher-rate-limiter.md:129-132`, `:172`

Flaw: The plan requires a process-local FIFO scheduler and cooldown waits, but it has no cancellation contract for queued requests, retry sleeps, or limiter cooldown sleeps. Axios supports `signal` and `cancelToken`; current factory `timeout` applies to dispatched HTTP requests, not to time spent waiting before dispatch in a custom limiter.

Failure scenario: Request A is queued behind a 65s v2 cooldown, then its command is interrupted or aborts. If the limiter does not remove A and advance the queue, requests B/C behind it hang until A's stale timer resolves or forever if the scheduler waits on a promise that never rejects. During cache sync, SIGINT/cancellation can leave `sync_status` as `running` and release locks only after the pre-dispatch wait completes.

Evidence:

- Existing clients only configure Axios `timeout` on the instance: `packages/sdk/src/client/axios.factory.ts:48-50`; `packages/sdk/src/client/v3-axios.factory.ts:40-42`.
- Axios request config supports cancellation through `cancelToken` and `signal`: `packages/sdk/node_modules/axios/index.d.ts:353-356`.
- Repo search found no current AbortSignal/cancel handling in SDK/CLI request paths beyond timeout configuration: `rg "Abort|AbortSignal|signal|CancelToken|timeout" packages/sdk/src packages/cli/src`.
- Plan FIFO tests cover order and delayed windows, not cancellation, queue compaction, or shutdown during cooldown: `phase-01-start.md:62`.

Suggested fix: Add cancellation requirements and tests. Limiter queue entries must watch `config.signal` and `cancelToken`, remove themselves from the bucket queue on abort, reject with Axios cancellation semantics, and advance the next queued request. Retry/cooldown sleep helpers should be abort-aware. CLI should ensure lock release/failure status happens promptly on interrupted sync.

### Medium: Wall-clock status health will misclassify active and dead writers

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/phase-03-integrate-cli-progress-and-verify.md:49`, `:69`, `:130`

Flaw: `stale_running` is derived from persisted `updatedAt`/`progressUpdatedAt`, but the plan never specifies clock source, future timestamp handling, monotonic-vs-wall behavior, or a minimum grace relative to limiter cooldown. Current code writes Unix seconds using `Date.now()`, and the new limiter/reporter also plans fake-clock-friendly clocks without separating persisted wall time from local monotonic scheduling.

Failure scenario: System clock jumps forward during a long but valid `waiting_rate_limit` cooldown; `cache status` marks a live writer as `stale_running`. Or clock jumps backward/NTP adjusts and a crashed writer's `updatedAt` is in the future, so status never becomes stale. In PostgreSQL shared mode, readers on different machines can disagree on staleness because no DB/server clock is used.

Evidence:

- `cache sync` run IDs and persisted timestamps use `Date.now()`/Unix seconds: `packages/cli/src/commands/cache/cache.commands.ts:139-150`, `:253`, `:281-288`, `:395-405`.
- Full-resume checkpoint timestamps also use `Date.now()`: `packages/cli/src/commands/cache/full-resume-checkpoint.ts:189-203`, `:288-297`, `:447-448`.
- Retry `Retry-After` HTTP-date parsing uses `Date.now()` wall clock: `packages/sdk/src/client/axios.factory.ts:34-39`; `packages/sdk/src/client/v3-axios.factory.ts:29-31`.
- Plan only says "conservative threshold based on progressUpdatedAt/updatedAt" and does not define threshold, cooldown grace, future timestamps, or DB clock handling: `phase-03-integrate-cli-progress-and-verify.md:130`.

Suggested fix: Specify two clocks: monotonic clock for limiter windows/throttling/durations and wall/Unix seconds only for persisted status. `cache status` should derive health from `max(progressUpdatedAt, updatedAt)`, treat modest future timestamps as `running` with optional `clock_skew_seconds`, and use a stale threshold greater than max planned retry/cooldown plus write throttle. In PostgreSQL mode, consider deriving read-time age with DB `now()` or document cross-machine clock-skew assumptions.

### Medium: Retry `console.warn` remains an ungoverned stderr path

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/plan.md:18`, `:28`; `phase-03-integrate-cli-progress-and-verify.md:67`, `:110-111`, `:129`

Flaw: The plan protects stdout and adds progress rendering to stderr, but it does not address existing transport-level `console.warn` retry logs. Those logs bypass the proposed CLI progress controller, are not throttled, are not TTY-aware, and can interleave with JSON errors on stderr.

Failure scenario: `cache sync` hits repeated 429/522s. The SDK retry interceptor writes multiple `[requestId] Retry ...` lines to stderr while the controller writes progress and the catch block writes `formatError`. A script that expects stderr to contain only machine JSON error plus known progress lines gets unexpected transport warning lines. Non-TTY logs also get duplicate wait messages: one from `waiting_rate_limit`, one from retry warn.

Evidence:

- v2 retry logs directly with `console.warn`: `packages/sdk/src/client/axios.factory.ts:117-119`.
- v3 retry logs directly with `console.warn`: `packages/sdk/src/client/v3-axios.factory.ts:82-84`.
- The stale `retry.handler.ts` also logs directly with `console.warn`: `packages/sdk/src/client/retry.handler.ts:90-95`.
- CLI failure path writes JSON error to stderr via `console.error(formatError(...))`: `packages/cli/src/commands/cache/cache.commands.ts:413`; `packages/cli/src/output/json.formatter.ts:19-25`.
- Plan CLI tests mention stdout/stderr but not retry warning suppression/injection: `phase-03-integrate-cli-progress-and-verify.md:67`, `:110-111`.

Suggested fix: Amend Phase 1/3 to route retry observability through an injectable logger/observer. Default SDK should be silent or structured through observer callbacks; CLI progress controller decides whether to render retry/rate-limit messages to stderr and throttles them. Add stdout/stderr tests with simulated retries to assert final stdout is single JSON, stderr contains only allowed controller/error output, and no raw SDK `console.warn` appears.

## Unresolved Questions

None.

Status: DONE
Summary: Found six concrete plan failure modes backed by repository evidence: Axios interceptor order, double cooldown sleep, terminal status overwrite races, missing cancellation, wall-clock stale-running errors, and ungoverned retry stderr.
Concerns/Blockers: None.
