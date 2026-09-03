# Red Team: Assumption Destroyer

Scope: plan-only review. No source edits. No lint/build/test. Used `rg`, line-number reads, package metadata, and non-test package `exec pwd` checks to verify claims against code.

## Findings

### High: v2 bucket key is credential-scoped without a v2 per-key contract

Location: `phase-01-start.md:23`, `phase-01-start.md:36-37`, `phase-01-start.md:79`; `plan.md:40-41`.

Flaw: The plan correctly scopes v3 by authenticated API key, but applies the same credential-fingerprint pattern to v2. Current SalesBinder v3 docs explicitly describe independent limits per authenticated API key; the v2 docs checked during this review state the 50/min and 15/10s limits but do not state independent per-key buckets. A v2 key fingerprint in the bucket key therefore assumes isolation the contract does not prove.

Failure scenario: Two configured CLI accounts point at the same SalesBinder subdomain with different v2 `apiKey` values. The process-local registry creates two v2 buckets and allows each up to `45/60s` and `12/10s`, so one process can send ~90/min to the same v2 account. That violates the documented v2 account/API allowance even though every bucket individually passes tests.

Evidence:

- Plan bucket rule: "Key buckets by normalized subdomain, API version, and a non-secret credential fingerprint" at `phase-01-start.md:23`.
- Plan v2 implementation: "derive bucket from subdomain + api version + v2 key fingerprint" at `phase-01-start.md:79`.
- Code supports multiple account aliases and only validates each loaded account has an `apiKey`; it does not enforce one alias per subdomain: `packages/sdk/src/config/config.loader.ts:67-75`, `packages/sdk/src/config/config.schema.ts:10-12`.
- Account binding normalizes subdomain into a stable account identity separate from credential: `packages/sdk/src/cache/types.ts:238-245`.
- Current v2 transport is keyed from loaded account config and Basic auth: `packages/sdk/src/client/axios.factory.ts:47-63`.

Suggested fix: Make v2 bucket identity subdomain/API-version scoped, not credential-scoped, unless SalesBinder v2 documentation or live headers prove per-key isolation. Keep v3 scoped by v3 API key fingerprint. Add a test where two v2 API keys for the same normalized subdomain share one bucket, and two v3 keys do not.

### High: rate-limit progress has no usable propagation path from transport to cache status

Location: `phase-01-start.md:44`, `phase-02-instrument-sync-progress.md:100`, `phase-03-integrate-cli-progress-and-verify.md:81-83`.

Flaw: The plan says Phase 1 transport observer events become Phase 2/3 `waiting_rate_limit` cache progress, but it never specifies how `cache sync` passes a reporter/controller into the SDK transport. Current public constructors accept only `accountName`, load config internally, and immediately create Axios clients; `cache sync` constructs both clients before any proposed progress controller exists.

Failure scenario: The limiter works and sleeps correctly, but `cache status` never shows `waiting_rate_limit`, and CLI progress never renders rate-limit waits, because the Axios-layer limiter has no reference to the cache reporter. Tests could pass against a mocked controller while real `SalesBinderClient`/`SalesBinderV3Client` wiring drops the event.

Evidence:

- Plan says response interceptors update bucket state and apply cooldown: `phase-01-start.md:44`.
- Plan says limiter observer translates to `waiting_rate_limit`: `phase-02-instrument-sync-progress.md:100`; Phase 3 says wire controller to limiter events: `phase-03-integrate-cli-progress-and-verify.md:82`.
- `SalesBinderClient` constructor only accepts `accountName`, loads config, and calls `createAxiosClient(account)`: `packages/sdk/src/resources/index.ts:35-38`.
- `SalesBinderV3Client` constructor only accepts `accountName`, loads config, checks `v3ApiKey`, and calls `createV3AxiosClient(account)`: `packages/sdk/src/resources/index.ts:53-58`.
- `cache sync` constructs both clients at `packages/cli/src/commands/cache/cache.commands.ts:90-91`; current sync status is created later at `packages/cli/src/commands/cache/cache.commands.ts:144-152`.

Suggested fix: Specify a backward-compatible transport options path. Example: `new SalesBinderClient(accountName, { rateLimitObserver })`, `new SalesBinderV3Client(accountName, { rateLimitObserver })`, and matching optional factory options. Create the controller/reporter before client construction in `cache sync`, pass observer into both clients, and add an integration test proving a real Axios retry/429 updates persisted `sync_status.progress.event === 'waiting_rate_limit'`.

### High: progress API changes are under-specified across all constructor/sync consumers

Location: `phase-02-instrument-sync-progress.md:87`, `phase-02-instrument-sync-progress.md:95`, `phase-03-integrate-cli-progress-and-verify.md:83`.

Flaw: The plan tells implementers to add `onProgressEvent` support to five sync paths and "preserve existing boolean overloads or add option overloads", but does not define exact signatures or enumerate consumers. This is not enough for the current API surface because only `DocumentIndexerService` uses `SyncOptions`; the others have incompatible `sync()` shapes.

Failure scenario: An implementer adds an options object as the first argument to `AccountIndexerService.sync`, breaking existing boolean `full` callers; or adds constructor params to `DocumentIndexerService`, shifting `staleThresholdSeconds`, `syncLookbackSeconds`, and `indexerOptions`; or instruments only document sync because `SyncOptions` is the only existing option type. The plan's compatibility promise then fails even if TypeScript catches some internal call sites.

Evidence:

- Current `SyncOptions` only contains `full`, document `onProgress`, and document resume callbacks: `packages/sdk/src/cache/types.ts:293-300`.
- `DocumentIndexerService.sync(options: SyncOptions = {})` is the only current `SyncOptions` consumer: `packages/sdk/src/cache/document-indexer.service.ts:54-62`.
- `AccountIndexerService.sync(full = false)` accepts a boolean, not an options object: `packages/sdk/src/cache/account-indexer.service.ts:22-26`.
- `CategoryIndexerService.sync()` accepts no arguments: `packages/sdk/src/cache/category-indexer.service.ts:38-44`.
- `V3InventoryIndexerService.sync()` accepts no arguments: `packages/sdk/src/cache/v3-inventory-indexer.service.ts:35-42`.
- `DeletedLogSyncService.sync()` accepts no arguments: `packages/sdk/src/cache/deleted-log-sync.service.ts:22-24`.
- Relevant current callers include analytics document indexers at `packages/cli/src/commands/analytics/customers.command.ts:88`, `pricing.command.ts:78`, `patterns.command.ts:90`, `item-sales.command.ts:55`, `inventory.command.ts:79`, `trends.command.ts:72`, `forecast.command.ts:74`; cache command constructors at `packages/cli/src/commands/cache/cache.commands.ts:158-179`; and tests at `packages/sdk/src/cache/__tests__/archive-state-indexers.test.ts:20`, `:48`, `:60`, `:131`, `:157`, `:181-182`, `sync-resume-indexers.test.ts:86`, `category-indexer.service.test.ts:71`, `:103`, `:167`, `:229`, `v3-inventory-indexer.service.test.ts:13`, `:46`, `:71`, `:92`, `:103`, `:118`, `:146`, `:164`.

Suggested fix: Add a migration table to the plan with exact signatures and all consumers. Recommended shapes: `AccountIndexerService.sync(fullOrOptions: boolean | AccountSyncOptions = false)`, `CategoryIndexerService.sync(options: CategorySyncOptions = {})`, `V3InventoryIndexerService.sync(options: V3InventorySyncOptions = {})`, `DeletedLogSyncService.sync(options: DeletedLogSyncOptions = {})`, and `DocumentIndexerService.sync(options: SyncOptions & { onProgressEvent?: ... } = {})`. Keep constructor signatures unchanged except where the plan explicitly lists all call-site updates.

### High: verification commands are path-wrong under `pnpm --filter`

Location: `phase-01-start.md:95-97`, `phase-02-instrument-sync-progress.md:115-118`, `phase-03-integrate-cli-progress-and-verify.md:101-105`, `research/researcher-rate-limiter.md:213-218`.

Flaw: The plan's filtered package test commands pass repository-root paths such as `packages/sdk/src/client` and `packages/cli/src/commands/cache/...` to package-local Jest scripts. `pnpm --filter @salesbinder/sdk exec node -e 'console.log(process.cwd())'` resolved to `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk`; the CLI package similarly resolved to `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli`. Those path args are therefore wrong from the script cwd.

Failure scenario: The implementer runs the plan's commands and gets no matching tests, misleading test selection, or a Jest "No tests found" failure. The plan then cannot prove limiter/progress regressions, especially because these are path-filtered focused commands rather than broad package commands.

Evidence:

- SDK script is package-local `jest`: `packages/sdk/package.json:17-23`.
- CLI script is package-local `jest --passWithNoTests`: `packages/cli/package.json:20-27`.
- Root scripts only orchestrate workspace commands: `package.json:10-19`.
- Actual test files are under package-local `src/...`, e.g. SDK client tests at `packages/sdk/src/client/__tests__/axios.factory.test.ts:1-3` and CLI cache tests at `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts:236-247`.
- Plan commands use repo-root paths after `--filter`, e.g. `pnpm --filter @salesbinder/sdk test -- --runInBand packages/sdk/src/client` at `phase-01-start.md:95`.

Suggested fix: Rewrite filtered commands to package-relative paths: `pnpm --filter @salesbinder/sdk test -- --runInBand src/client`, `pnpm --filter @salesbinder/sdk test -- --runInBand src/cache/__tests__/payment-sync.service.test.ts src/cache/__tests__/sync-resume-indexers.test.ts`, `pnpm --filter @salesbinder/cli test -- --runInBand src/commands/cache/cache-sync-progress-controller.test.ts ...`. Or run from repo root with explicit Jest `--rootDir`/workspace command that actually treats repo-root paths as roots.

### Medium: plan claims no unresolved questions while research leaves schema and behavior decisions open

Location: `plan.md:64-66`, `phase-01-start.md:139-141`, `phase-02-instrument-sync-progress.md:162-164`, `phase-03-integrate-cli-progress-and-verify.md:154-156`.

Flaw: All plan files say "Unresolved Questions: None", but the research files still contain material open decisions: where `sync_health` belongs, whether `sync-payments` gets generic progress, throttle interval, global-vs-cache-only rate-limit event emission, env knobs, and whether multi-machine same-credential sync is in scope.

Failure scenario: Two implementers can produce incompatible contracts from the same plan: one persists `sync_health` inside `sync_status`, another adds a top-level `sync_health`; one maps payment backfill into generic progress, another leaves it only in `payment_sync_status`; one emits transport limiter events globally, another only from `cache sync`. Existing `cache status` currently returns raw `sync_status` and `payment_sync_status` for both PostgreSQL and SQLite, so these choices change machine-readable output.

Evidence:

- Research open questions: `research/researcher-progress-contract.md:204-209`; `research/researcher-rate-limiter.md:239-243`.
- Plan says none unresolved: `plan.md:64-66`, `phase-01-start.md:139-141`, `phase-02-instrument-sync-progress.md:162-164`, `phase-03-integrate-cli-progress-and-verify.md:154-156`.
- Current `cache status` emits `sync_status` and `payment_sync_status` for PostgreSQL: `packages/cli/src/commands/cache/cache.commands.ts:689-704`; and SQLite: `packages/cli/src/commands/cache/cache.commands.ts:761-779`.
- Payment sync already has a separate persisted status and callback: `packages/sdk/src/cache/payment-sync.service.ts:43-59`, `:80-83`; `cache sync-payments` prints progress and outputs final JSON at `packages/cli/src/commands/cache/cache-payment-sync.command.ts:52-75`.

Suggested fix: Resolve these in the plan, not during implementation. Recommended minimum: add top-level derived `sync_health` to `cache status` output only, keep persisted `CacheSyncStatus.status` unchanged, leave `cache sync-payments` on `payment_sync_status` for MVP unless explicitly added, set default progress throttle to 1000ms, and define the transport observer as global but only cache commands persist/render it.

## Status

Status: DONE
Summary: Found five evidence-backed plan defects: unsafe v2 credential scoping, missing limiter-to-progress wiring, under-specified indexer progress API migration, wrong focused test paths, and unresolved contract decisions falsely closed.
Concerns/Blockers: None for this review task. Report written only; no source or plan edits beyond this assigned report.
