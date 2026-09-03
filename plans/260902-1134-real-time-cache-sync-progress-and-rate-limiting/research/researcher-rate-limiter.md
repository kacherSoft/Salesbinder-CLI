# Research Report: SalesBinder Request Limiter

Conducted: 2026-09-02

## Scope

Read-only research for an account/credential-scoped request limiter integrated with current v2/v3 Axios factories, cache sync, retry behavior, progress/status, and process coordination. External verification limited to official SalesBinder docs.

Checks completed:

- Read `README.md`; `CLAUDE.md` is referenced by repo instructions but absent at repo root.
- Inspected SDK Axios factories, retry helper, resources, cache indexers, sync locks, progress/status fields, and tests.
- Verified current SalesBinder v2/v3 rate-limit contracts from official docs only.

## Official Contract

v2 legacy docs: <https://www.salesbinder.com/api/v2/getting-started/rate-limiting/>

- Limits: `50 requests per 1 minute` and `15 requests per 10 seconds`; whichever hits first starts blocking.
- Exceeding limits blocks automatically for 1 minute; repeated violations can increase block time and eventually disable API access.
- Docs do not promise `Retry-After` headers for v2.

v3 docs: <https://www.salesbinder.com/api/v3/rate-limits/>

- Limits apply independently to each authenticated API key, not one combined account bucket.
- Default allowance: 120 authenticated requests / 60 seconds per API key.
- Allowances may change; docs explicitly say to read response headers instead of hard-coding current default.
- Authenticated responses include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.
- `429 Too Many Requests` includes `Retry-After`; rate-limited write is rejected before API action runs.
- Retry guidance: wait `Retry-After`, add random delay, keep workers within one shared allowance for the API key, and reuse original idempotency key for supported writes.

## Current Code Evidence

Transport:

- v2 client is created in `createAxiosClient(account)` with base URL `https://${account.subdomain}.salesbinder.com/api/${account.apiVersion}` and Basic auth interceptor: `packages/sdk/src/client/axios.factory.ts:47-63`.
- v2 retry state/request ID interceptor skips only retry metadata reset when `__isRetry`: `packages/sdk/src/client/axios.factory.ts:65-78`.
- v2 retries network errors plus `429, 500, 502, 503, 504, 522` up to 5 attempts: `packages/sdk/src/client/axios.factory.ts:89-95`.
- v2 parses `retry-after`, caps any retry delay at 60s, otherwise exponential backoff + 0-50% jitter: `packages/sdk/src/client/axios.factory.ts:100-121`.
- v3 client duplicates retry/backoff logic with Bearer auth and fixed `/api/v3` base URL: `packages/sdk/src/client/v3-axios.factory.ts:35-89`.
- `retry.handler.ts` exports older retry helpers but no production import uses them; `rg` found only its own exports. It also lacks 522 and `Retry-After`: `packages/sdk/src/client/retry.handler.ts:8-18`, `packages/sdk/src/client/retry.handler.ts:73-104`.
- SDK public clients construct v2/v3 Axios separately: `packages/sdk/src/resources/index.ts:35-45`, `packages/sdk/src/resources/index.ts:48-61`.

High-volume callers:

- `cache sync` creates both `SalesBinderClient` and `SalesBinderV3Client`, requires `v3ApiKey`, and has no v2 fallback for category/inventory snapshots: `packages/cli/src/commands/cache/cache.commands.ts:81-92`.
- Full cache pipeline order: accounts, categories, documents, v3 inventory, deleted log: `packages/cli/src/commands/cache/cache.commands.ts:204-252`.
- Account sync fetches customers and suppliers page-by-page with `pageLimit: 200`: `packages/sdk/src/cache/account-indexer.service.ts:38-57`.
- Category sync fetches every page, and v3 mode does two complete reads for stability: `packages/sdk/src/cache/category-indexer.service.ts:43-52`, `packages/sdk/src/cache/category-indexer.service.ts:82-114`.
- Document sync fetches three document contexts page-by-page at `pageLimit: 50`; optional detail gets happen per document; current page delay is only 500ms: `packages/sdk/src/cache/document-indexer.service.ts:96-180`, `packages/sdk/src/cache/document-indexer.service.ts:239-304`.
- V3 inventory sync performs two complete source reads, fetches all items, then variations for every item with variations: `packages/sdk/src/cache/v3-inventory-indexer.service.ts:35-45`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:67-95`, `packages/sdk/src/cache/v3-inventory-indexer.service.ts:147-185`.
- Deleted log sync loops six contexts page-by-page: `packages/sdk/src/cache/deleted-log-sync.service.ts:22-65`.
- Payment backfill fetches invoice detail per cached invoice, with progress callback and delay between invoices: `packages/sdk/src/cache/payment-sync.service.ts:62-85`.
- Existing payment detail delay is 1250ms, explicitly justified against v2 `50/min` and `15/10s`: `packages/sdk/src/cache/payment-cache.constants.ts:10-13`.

Locks/progress:

- Cache sync takes a per-account writer lock for PostgreSQL or SQLite: `packages/cli/src/commands/cache/cache.commands.ts:95-118`.
- Payment sync also takes the same cache writer lock: `packages/cli/src/commands/cache/cache-payment-sync.command.ts:43-50`.
- SQLite lock is a cache-file sidecar lock; it guards cache writers, not arbitrary API traffic: `packages/sdk/src/cache/sqlite-cache.service.ts:1129-1162`.
- PostgreSQL lock uses account binding and `pg_try_advisory_lock`; also cache-writer scoped: `packages/sdk/src/cache/postgres-cache.service.ts:1319-1354`.
- `CacheSyncStatus` supports running/success/failed plus counts, but no explicit rate-limit delay/cooldown fields: `packages/sdk/src/cache/types.ts:273-290`.
- `cache sync` sets `sync_status` only at start, final success, and failure; document progress is console-only: `packages/cli/src/commands/cache/cache.commands.ts:144-152`, `packages/cli/src/commands/cache/cache.commands.ts:231-238`, `packages/cli/src/commands/cache/cache.commands.ts:281-297`, `packages/cli/src/commands/cache/cache.commands.ts:395-408`.

Tests:

- Current v2 tests cover retry status 522, retry-after precedence/date/cap, env delay validation, jitter: `packages/sdk/src/client/__tests__/axios.factory.test.ts:42-123`.
- Current v3 tests cover base URL/auth, missing v3 key, and retry status parity only: `packages/sdk/src/client/__tests__/v3-axios.factory.test.ts:19-87`.
- Package test/build commands: root `pnpm test`, `pnpm build`; SDK `jest` and `tsc`: `package.json:10-19`, `packages/sdk/package.json:17-23`.

## Retry Timing vs v2 One-Minute Block

Current default fallback retry schedule on repeated `429` without `Retry-After`:

- Attempts before final failure: 5 retry waits, attempts 0-4.
- Base waits: 1s, 2s, 4s, 8s, 16s.
- With 0-50% additive jitter: total wait is 31s minimum, 46.5s maximum.

Impact:

- v2 says exceeding limits blocks for 1 minute. If v2 does not send `Retry-After`, current default five-retry behavior can exhaust all retries before the first block expires.
- If v2 or v3 sends `Retry-After: 60`, current cap allows a 60s wait, but adds no post-cooldown jitter. v3 docs ask for random delay after `Retry-After`.
- Retries currently call `client.request(config)`, so Axios request interceptors run again. Any limiter must run on retries too and must not be bypassed by `__isRetry`; only request-ID reset should be skipped.

## Recommended Minimum Architecture

Implement transport-level scheduling in the SDK, shared by both Axios factories.

Key points:

- Do not add limiter calls into every indexer/resource. Put it in Axios request/response interceptors so all CLI commands, cache sync, payment sync, and retry attempts use the same gate.
- Do not combine v2 and v3 into one account bucket. Bucket by normalized account identity + API version + credential fingerprint:
  - `salesbinder:<subdomain>:v2:<apiKey fingerprint>`
  - `salesbinder:<subdomain>:v3:<v3ApiKey fingerprint>`
- Fingerprint credentials with a non-secret hash only for in-memory key separation. Never log raw key or full fingerprint.
- Keep no v2 fallback changes. V3 cache resources still require `v3ApiKey`; limiter only schedules requests.

Proposed files/symbols:

- Add `packages/sdk/src/client/salesbinder-rate-limiter.ts`
  - `SalesBinderRateLimiter`
  - `RateLimitBucketKey`
  - `RateLimitPolicy`
  - `createSalesBinderRateLimiterRegistry()`
  - `parseRetryAfterMs()`
  - `parseRateLimitHeaders()`
  - `createLimiterBucketKey(account, version)`
- Add/modify `packages/sdk/src/client/request-scheduler.interceptor.ts` only if keeping factories small helps; otherwise keep install helper in limiter file.
- Refactor shared retry parsing from both factories into limiter/retry helper. Current `retry.handler.ts` is stale; either update it into the shared helper or remove it if no public export depends on it.
- Modify `packages/sdk/src/client/axios.factory.ts` and `packages/sdk/src/client/v3-axios.factory.ts` to install the limiter.
- Re-export limiter test-only helpers only if tests need them; avoid public SDK contract unless needed.

Limiter behavior:

- v2 default policy: dual rolling windows with headroom.
  - Recommend 45 requests / 60s and 12 requests / 10s.
  - Reason: stays below official 50/min and 15/10s, handles clock jitter, request bursts, and process-local contention.
  - If 429 without valid `Retry-After`, set bucket cooldown to 65s + 250-1000ms jitter because v2 block is documented as 1 minute.
- v3 default policy:
  - Start with conservative fallback, e.g. 100 requests / 60s, as a seed only.
  - On every response, read `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.
  - Adjust bucket to server header state. Do not treat 120 as a permanent constant.
  - If remaining is at/below reserved headroom, cool down until reset + jitter.
  - On 429, prefer `Retry-After`, then `RateLimit-Reset`, then conservative 60s fallback + jitter.
- Jitter:
  - Add small positive jitter before releasing from cooldown, especially after `Retry-After`.
  - Keep normal pacing jitter small enough not to make cache sync noisy.
- Scheduling:
  - A request waits until both bucket windows and cooldown allow it.
  - Consume reservation immediately before dispatch, not after response.
  - Queue order FIFO per bucket to avoid starvation.
  - All retry attempts go through `beforeRequest`.

Observability/progress:

- Emit throttling logs only when a wait exceeds a threshold, e.g. 2s, and rate-limit them to at most once per 10s per bucket.
- Add optional limiter observer events: `scheduled`, `delayed`, `cooldown`, `headers`.
- Wire `cache sync` observer to update console progress and optionally `sync_status.message` / `updatedAt` during long cooldowns. Avoid writing cache meta for every request.
- Extend `CacheSyncStatus` only if needed with optional fields like `rateLimitDelayedMs`, `rateLimitCooldownUntil`, `rateLimitBucket`; compatibility safe because metadata is JSON.

Process-local vs distributed coordination:

- MVP: process-local registry in SDK.
- Defer distributed token coordination.

Why defer:

- Current cache writer lock already prevents two `cache sync`/`sync-payments` writers for one account in this CLI process model.
- Distributed coordination would need a durable shared bucket store, TTLs, crash recovery, and clock-skew handling. That is more moving parts than required to stop current high-volume single-command bursts.
- Ordinary concurrent CLI commands from multiple shells remain a residual risk, but typical list/get operations are low volume compared with cache sync.

When to add distributed coordination:

- Multiple scheduled workers or CI jobs run against same v2/v3 key.
- Users run cache/report jobs from several machines without shared orchestration.
- SalesBinder 429s still appear after process-local limiter ships.

Deferred design:

- SQLite/local: file-backed token bucket under `~/.salesbinder/rate-limits/` with atomic lock files.
- PostgreSQL/shared: advisory lock + `cache_meta` or dedicated table keyed by account/version/credential fingerprint.
- Must coordinate per API key for v3, per credential/version for v2.

## Failure and Rollback Behavior

Expected failure behavior:

- Limiter waits before sending requests; no cache writes are made solely by waiting.
- On v3 429, docs say write was rejected before API action; retry can be safe if idempotency keys are preserved for supported writes.
- On v2 429, assume one-minute block when no header exists and cool down. Do not burn five retries inside the block.
- If limiter header parsing sees invalid values, ignore that header and keep local conservative policy.
- If a wait/cooldown is interrupted, current sync failure paths preserve cache safety: `cache sync` records failed status and exits nonzero; v3 snapshots are only published after complete validation.

Rollback:

- Keep implementation isolated to SDK client files. Reverting limiter wiring restores current retry-only behavior.
- Optionally add `SALESBINDER_RATE_LIMITER=off` as an emergency diagnostic switch, but default must be on.
- Do not remove existing `PAYMENT_DETAIL_DELAY_MS` in the first limiter patch; leave it until tests and real sync behavior prove transport limiter covers payment detail reads. Later reduce/remove as cleanup.

## TDD Matrix

Unit tests for new limiter:

- v2 dual window permits 12 requests inside 10s headroom, delays 13th until 10s window clears.
- v2 minute window permits 45 requests inside 60s headroom, delays 46th until 60s window clears.
- v2 429 without headers sets 65s+jitter cooldown; next request waits past one-minute block.
- v2 valid `Retry-After` overrides fallback cooldown and adds jitter.
- v3 uses independent bucket per API key fingerprint; two v3 keys do not share allowance.
- v2 and v3 credentials for same subdomain do not share bucket.
- v3 parses `RateLimit-Limit/Remaining/Reset`; near-empty remaining delays until reset.
- v3 429 uses `Retry-After` first, then `RateLimit-Reset`, then fallback.
- Invalid/missing rate-limit headers do not throw; local conservative policy remains.
- FIFO queue order preserved under concurrent requests in one bucket.
- Retry attempts pass through limiter. Test by adapter failing once with 429 and asserting limiter `beforeRequest` called twice.
- `__isRetry` does not bypass limiter; request ID remains stable on retry.
- Logs/observer redact credentials and include only bucket version/subdomain-safe identity.

Factory tests:

- `createAxiosClient` installs v2 limiter with Basic key bucket.
- `createV3AxiosClient` installs v3 limiter with Bearer key bucket.
- Existing retry tests still pass for retry-after, 522, env initial delay.
- V3 retry tests expanded to match v2 retry-after/date/cap behavior or shared helper tests cover both.

Cache/CLI integration tests:

- `cache sync` constructs v2 and v3 clients without changing no-v2-fallback v3 requirement.
- Long limiter delay emits console progress/cooldown message without per-request cache meta churn.
- Failed sync during limiter/retry cooldown records `sync_status.status='failed'`.
- `sync-payments` detail reads go through v2 limiter; existing payment progress still fires.
- Existing lock tests still pass; limiter does not alter lock acquire/release order.

Verification commands:

- `pnpm --filter @salesbinder/sdk test -- --runInBand packages/sdk/src/client`
- `pnpm --filter @salesbinder/sdk test -- --runInBand packages/sdk/src/cache`
- `pnpm --filter @salesbinder/cli test -- --runInBand`
- `pnpm build`

## Implementation Order

1. Add limiter module with fake-clock friendly internals and no Axios dependency first.
2. Add unit tests for v2/v3 bucket policies and cooldown parsing.
3. Wire limiter into both factories with a shared install helper.
4. Refactor duplicated retry parsing if it reduces duplication without broad churn.
5. Add factory tests proving retries pass through limiter.
6. Add minimal CLI/cache status observer only for long cooldown messages.
7. Update README retry/rate-limit docs after behavior changes.

## Recommended MVP Decision

Ship an SDK transport-level, process-local, credential/version-scoped limiter now:

- v2: conservative dual window `45/min` + `12/10s`, one-minute cooldown fallback on 429.
- v3: per-key adaptive limiter seeded conservatively, governed by `RateLimit-*` and `Retry-After`.
- Retain current cache writer locks.
- Defer distributed coordination until real multi-process usage or observed 429s justify durable shared buckets.

## Unresolved Questions

- Should users get env knobs for fallback limits/headroom, or should these stay internal until there is a real support need?
- Should long cooldown state be stored in `sync_status` fields or only printed to stderr for MVP?
- Is multi-machine scheduled sync against the same SalesBinder credentials in scope for this release? If yes, distributed coordination moves from deferred to required.

Status: DONE
Summary: Verified official v2/v3 SalesBinder rate-limit contracts and mapped the current retry/indexer/lock surface. Recommended a process-local transport limiter keyed by account identity + API version + credential, with v2 conservative dual windows, v3 adaptive headers, retry/cooldown handling, and distributed coordination deferred.
Concerns/Blockers: None for MVP research. Distributed coordination remains a product/operations scope decision.
