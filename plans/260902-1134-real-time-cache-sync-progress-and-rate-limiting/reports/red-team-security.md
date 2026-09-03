## Red-Team Security Review

Scope: plan review only. Checked plan files, two research reports, README, and source contracts with `rg`/`nl`. No source or plan edits.

### 1. High - Cache authority remains subdomain-only while limiter identity becomes credential-scoped

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/plan.md:41-44`, `phase-01-start.md:23`, `phase-01-start.md:79`, `phase-01-start.md:123-125`

Flaw: The plan scopes rate-limit buckets by credential fingerprint but keeps cache authority and writer locks bound only to normalized subdomain. It explicitly avoids persisting limiter state/fingerprints. That misses a cross-credential cache poisoning path: two account aliases for the same SalesBinder subdomain but different v2/v3 keys, scopes, or visibility can write the same cache database as the same account identity.

Failure scenario: A lower-privilege or stale v3 key for `salesbinder:acme` runs `cache sync` against shared PostgreSQL. It passes the subdomain binding, takes the same writer lock, and atomically replaces category/inventory with only records visible to that key. Readers then trust incomplete cache state as authoritative for the account.

Code evidence:

- Cache binding identity is derived only from subdomain: `packages/sdk/src/cache/types.ts:237-245`.
- `cache sync` derives binding from `accountConfig.subdomain`, not credentials: `packages/cli/src/commands/cache/cache.commands.ts:81-90`.
- Cache writer locks use only `accountBinding.accountIdentity`: `packages/cli/src/commands/cache/cache.commands.ts:100-114`.
- Category/inventory metadata carry `accountIdentity`, not credential/scope identity: `packages/sdk/src/cache/types.ts:185-227`.
- PostgreSQL snapshot replacement validates account binding only before publish: `packages/sdk/src/cache/postgres-cache.service.ts:707-711`.

Suggested fix: Add a cache credential/scope continuity decision to the plan. Persist a non-secret, truncated/keyed fingerprint or explicit cache credential binding for each authoritative source scope, separate from limiter internals. Refuse cache writes when the configured credential fingerprint changes for a bound cache unless user runs an explicit rebuild/rebind command. Add tests for same subdomain + different v2/v3 key attempting to write existing SQLite/PostgreSQL cache.

### 2. High - Transport retries remain unsafe for non-idempotent writes

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/plan.md:43`, `phase-01-start.md:35`, `phase-01-start.md:80-81`, `phase-01-start.md:101-103`

Flaw: The plan says all requests and retries go through the limiter and preserves existing retry behavior, but does not add a method/idempotency policy. Current retry interceptors retry any Axios request config for 429/network/5xx. That includes create/update/delete operations.

Failure scenario: `items create`, `documents create`, or `customers create` succeeds server-side but the response is lost or a transient 522/timeout is raised. The transport retries the POST without an idempotency key, creating duplicates or repeating a mutation. A limiter only paces the duplicate write; it does not make retry safe.

Code evidence:

- v2 retry gate checks only response/network status and attempt count, not HTTP method or idempotency: `packages/sdk/src/client/axios.factory.ts:89-95`.
- v2 retries by reissuing the same config through `client.request(config)`: `packages/sdk/src/client/axios.factory.ts:123-131`.
- v3 has the same status-only retry gate and request replay: `packages/sdk/src/client/v3-axios.factory.ts:72-89`.
- Resource mutations use the same retried Axios clients: `packages/sdk/src/resources/items.resource.ts:60-77`, `packages/sdk/src/resources/documents.resource.ts:67-89`, `packages/sdk/src/resources/customers.resource.ts:50-72`.

Suggested fix: Add retry safety requirements before limiter work ships. Retry only safe/idempotent methods by default (`GET`, maybe `HEAD`). Permit write retries only when an explicit idempotency key is supported and preserved across attempts, with tests proving POST/PUT/DELETE are not retried absent that key. If SalesBinder v2 lacks idempotency, do not retry v2 writes on network/429/5xx.

### 3. Medium - Malicious or corrupt rate-limit headers can stall the CLI

Location: `phase-01-start.md:37`, `phase-01-start.md:78`, `phase-01-start.md:117`, `phase-01-start.md:123-124`

Flaw: The plan requires v3 adaptation from `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`, but only says invalid headers are ignored. It does not require sane upper/lower bounds for valid-looking values. A server, proxy, or compromised network path can send huge reset values, zero/negative remaining values, or extreme limits to force excessive cooldowns or break local scheduling.

Failure scenario: A response carries `RateLimit-Reset: 315360000` or `RateLimit-Limit: 0`. The new limiter treats it as valid numeric quota state and sleeps for months or serializes all requests behind a disabled bucket. `cache sync` stays `running`, operators see stale progress, and automation stalls.

Code evidence:

- Existing retry parsing clamps `Retry-After` to `MAX_RETRY_DELAY_MS = 60000`: `packages/sdk/src/client/axios.factory.ts:12-13`, `packages/sdk/src/client/axios.factory.ts:29-39`.
- v3 retry parsing also clamps `Retry-After` to 60 seconds: `packages/sdk/src/client/v3-axios.factory.ts:8-9`, `packages/sdk/src/client/v3-axios.factory.ts:20-31`.
- The planned new `RateLimit-*` parsing has tests for invalid headers but no equivalent max cooldown/quota clamp: `phase-01-start.md:62-66`.

Suggested fix: Specify bounded header parsing: clamp reset/cooldown to a small maximum, reject limit/remaining outside safe integer ranges, enforce `0 <= remaining <= limit`, use monotonic wait math where practical, and treat absurd values as untrusted. Add tests for huge reset, zero limit, negative remaining, non-integer, and reset-before-now.

### 4. Medium - Process-local registry can accidentally become per-client

Location: `plans/260902-1134-real-time-cache-sync-progress-and-rate-limiting/plan.md:42`, `phase-01-start.md:44-46`, `phase-01-start.md:76`, `phase-01-start.md:108`

Flaw: The plan says "process-local registry" but does not require a module-level singleton default or tests proving separate SDK client instances share the same bucket. Current constructors create a fresh Axios instance per `new SalesBinderClient` / `new SalesBinderV3Client`. If the limiter registry is instantiated inside each factory, the promised process-local coordination collapses to per-client coordination.

Failure scenario: A long-running embedding process, tests, or future CLI orchestration creates multiple `SalesBinderClient` instances for the same account/key. Each client gets its own full allowance and sends bursts in parallel, violating v2/v3 limits even inside one process.

Code evidence:

- `SalesBinderClient` loads config and calls `createAxiosClient(account)` for every instance: `packages/sdk/src/resources/index.ts:35-38`.
- `SalesBinderV3Client` loads config and calls `createV3AxiosClient(account)` for every instance: `packages/sdk/src/resources/index.ts:53-59`.
- Current CLI already creates separate SDK clients in different command paths: `packages/cli/src/commands/cache/cache.commands.ts:90-91`, `packages/cli/src/commands/cache/cache.commands.ts:659-665`, `packages/cli/src/commands/cache/cache-payment-sync.command.ts:36-39`.

Suggested fix: Require a package-level default limiter registry shared by all factories in a process, with explicit injectable registry only for tests. Add tests that two v2 clients and two v3 clients for the same subdomain/key share allowance, while different credentials/API versions do not.

### 5. Medium - `cache status` would expose raw progress state without a redacted projection

Location: `phase-02-instrument-sync-progress.md:36-41`, `phase-02-instrument-sync-progress.md:99`, `phase-03-integrate-cli-progress-and-verify.md:41`, `phase-03-integrate-cli-progress-and-verify.md:85`, `phase-03-integrate-cli-progress-and-verify.md:136-138`

Flaw: The plan persists progress directly inside `CacheSyncStatus` and exposes latest progress through `cache status`, but it does not require a separate allowlisted public projection. It even permits `currentRecordId` "when needed". In a shared PostgreSQL cache, `cache status` is a read-side observability surface; raw record IDs, account aliases, phase cursors, and failure strings can leak operational or business metadata to any actor with read DB access for the bound cache.

Failure scenario: A support user or read-only automation polls `cache status` during sync and receives document/item/customer IDs or detailed failure strings. Those IDs can be correlated with API routes, logs, exports, or downstream systems, even though the plan correctly bans names and payloads.

Code evidence:

- `CacheSyncStatus` currently includes free-form `accountName`, `message`, and `error`: `packages/sdk/src/cache/types.ts:273-290`.
- SQLite/PostgreSQL persist the status JSON exactly as supplied: `packages/sdk/src/cache/sqlite-cache.service.ts:1008-1015`, `packages/sdk/src/cache/postgres-cache.service.ts:1289-1301`.
- `cache status` returns raw `sync_status` in both PostgreSQL and SQLite outputs: `packages/cli/src/commands/cache/cache.commands.ts:668-703`, `packages/cli/src/commands/cache/cache.commands.ts:750-777`.
- Failure handling stores raw `error.message` and prints `formatError(error)`: `packages/cli/src/commands/cache/cache.commands.ts:395-413`.
- `formatError` can include stack traces when `DEBUG=true`: `packages/cli/src/output/json.formatter.ts:19-25`.

Suggested fix: Define a strict persisted/public schema with no free-form message propagation from Axios/config errors and no record IDs by default. Store detailed correlation data only in local checkpoint/debug surfaces, not shared `sync_status`. Add redaction tests against `cache status`, failure status, `formatError`, Axios errors, DB URLs, Authorization, record IDs, and payload-shaped strings.

### 6. Medium - Forced rate-limit status writes create a PostgreSQL write-amplification vector

Location: `phase-02-instrument-sync-progress.md:77-78`, `phase-02-instrument-sync-progress.md:93-100`, `phase-03-integrate-cli-progress-and-verify.md:40`, `phase-03-integrate-cli-progress-and-verify.md:112`

Flaw: The plan throttles routine metadata writes but forces every `waiting_rate_limit` boundary. It does not define coalescing or a minimum force interval for repeated rate-limit events. A 429 storm or malicious header pattern can turn every retry/cooldown into a shared `cache_meta.sync_status` write.

Failure scenario: SalesBinder or a proxy emits repeated 429s. The limiter emits `waiting_rate_limit` before each sleep/retry. The reporter forces a `setSyncStatus` write each time. On PostgreSQL this takes the verified write transaction path and competes with real cache writes, making the progress feature a self-inflicted write bottleneck during the exact failure mode it is supposed to report.

Code evidence:

- PostgreSQL `setSyncStatus` writes `cache_meta.sync_status` via `withVerifiedWrite`: `packages/sdk/src/cache/postgres-cache.service.ts:1294-1301`.
- `withVerifiedWrite` opens a transaction and verifies account binding before each write: `packages/sdk/src/cache/postgres-cache.service.ts:1422-1427`.
- Current sync writes status only at start/success/failure: `packages/cli/src/commands/cache/cache.commands.ts:144-152`, `packages/cli/src/commands/cache/cache.commands.ts:281-297`, `packages/cli/src/commands/cache/cache.commands.ts:395-408`.

Suggested fix: Coalesce rate-limit status updates by phase/bucket and write only when `waitUntil` increases materially, a minimum interval elapsed, or status changes from/to waiting. Add tests for 100 repeated `waiting_rate_limit` events producing bounded writes while still forcing final success/failure.

Status: DONE
Summary: Found six concrete security/abuse gaps in the plan: credential-scope cache mixing, unsafe write retries, unbounded rate-limit headers, ambiguous registry sharing, raw status exposure, and rate-limit write amplification.
Concerns/Blockers: CLAUDE.md and /Users/kacher/AGENTS.md were absent at the specified paths; used injected instructions, README, loaded security skill, plan docs, research reports, and code evidence.
