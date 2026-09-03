# Research Report: Real-Time Cache Sync Progress Contract

Conducted: 2026-09-02

## Executive Summary

Minimum architecture: add a typed `CacheSyncProgress` payload inside existing `CacheSyncStatus`, publish it through a throttled reporter owned by the CLI orchestration, and pass typed progress callbacks into each SDK indexer. Keep `stdout` as the final JSON only; human terminal progress remains `stderr`; machine polling uses `salesbinder cache status` reading `cache_meta.sync_status`.

Do not make category or v3 inventory metadata “running”. Both are validated complete snapshots and published atomically through `replaceCategorySnapshot` / `replaceInventorySnapshot`; progress events should describe pre-publication work only. The authoritative category/inventory meta should remain absent/old until final replacement succeeds.

Add `waiting_rate_limit` as an event and status phase. Current SalesBinder v3 rate-limit docs expose `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`; persist only numeric/header-derived timing and remaining quota, never API keys or request auth.

## Evidence

### CLI orchestration and status

- `cache sync` selects backend, verifies account binding, acquires per-account writer lock, then writes `CacheSyncStatus(status: running)` before phases start: `packages/cli/src/commands/cache/cache.commands.ts:95`, `:100`, `:103`, `:111`, `:114`, `:144`.
- Phase order is accounts -> categories -> documents -> items -> deleted-log: `packages/cli/src/commands/cache/cache.commands.ts:204`, `:210`, `:216`, `:242`, `:248`.
- Current document progress is terminal-only stderr and not persisted: `packages/cli/src/commands/cache/cache.commands.ts:231`.
- Final success status is persisted once with aggregate counts: `packages/cli/src/commands/cache/cache.commands.ts:281`.
- Failure status is best-effort and preserves the original error if status persistence fails: `packages/cli/src/commands/cache/cache.commands.ts:395`.
- Final command result is the only success payload on stdout: `packages/cli/src/commands/cache/cache.commands.ts:335`, `:386`; errors use JSON on stderr: `packages/cli/src/output/json.formatter.ts:19`.
- `cache status` already exposes `sync_status`, `payment_sync_status`, `categories`, and `inventory` for both PostgreSQL and SQLite: `packages/cli/src/commands/cache/cache.commands.ts:668`, `:702`, `:750`, `:776`.
- Count collection covers documents, invoices, POs, estimates, line items, payments, accounts, items, categories, and stock rows: `packages/cli/src/commands/cache/cache.commands.ts:925`.

### Persisted metadata

- `CacheSyncStatus` currently supports `running | success | failed`, timestamps, target, type, aggregate counts, and error: `packages/sdk/src/cache/types.ts:273`.
- `SyncOptions` only has document-style `onProgress(current,total)` and document resume callbacks: `packages/sdk/src/cache/types.ts:293`.
- SQLite stores `sync_status` as JSON in `cache_meta`: `packages/sdk/src/cache/sqlite-cache.service.ts:1008`.
- PostgreSQL stores `sync_status` as JSON in `cache_meta` through verified write transaction: `packages/sdk/src/cache/postgres-cache.service.ts:1289`.
- SQLite/PostgreSQL schemas use generic `cache_meta(key,value)`: `packages/sdk/src/cache/sqlite-cache.service.ts:325`, `packages/sdk/src/cache/postgres-cache.service.ts:247`.

### Atomic snapshot constraints

- Category sync requires current schema, fetches full snapshot, v3 does two stability passes, then calls one `replaceCategorySnapshot`: `packages/sdk/src/cache/category-indexer.service.ts:38`.
- Category pagination has determinate totals after page 1: `count`, `page`, `pages`: `packages/sdk/src/cache/category-indexer.service.ts:82`.
- Category replacement is atomic in SQLite transaction and writes rows, typed meta, generation marker, state, reconciliation, then invalidates inventory authority: `packages/sdk/src/cache/sqlite-cache.service.ts:728`, `:1212`.
- PostgreSQL category replacement runs under `withVerifiedWrite` and publishes rows/meta/state/marker in one write transaction: `packages/sdk/src/cache/postgres-cache.service.ts:707`.
- V3 inventory does two complete source reads for stability, fetches items and variations, then calls one `replaceInventorySnapshot`: `packages/sdk/src/cache/v3-inventory-indexer.service.ts:35`.
- V3 inventory page totals are determinate per resource after first page and validated across pages: `packages/sdk/src/cache/v3-inventory-indexer.service.ts:147`.
- SQLite inventory replacement atomically replaces API inventory rows and writes inventory meta/state: `packages/sdk/src/cache/sqlite-cache.service.ts:860`.
- PostgreSQL inventory replacement locks state and writes API rows/meta/state together: `packages/sdk/src/cache/postgres-cache.service.ts:1091`.
- PG -> SQLite pull reads full PG data and then uses `replaceMirror`, preserving mirror atomicity: `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts:72`, `:84`.

### Indexer gaps

- Account indexer has page totals from response pages, but no progress callback: `packages/sdk/src/cache/account-indexer.service.ts:22`, `:38`, `:55`.
- Documents are indeterminate in current v2 flow because pagination stops on empty/404 and passes `-1` total: `packages/sdk/src/cache/document-indexer.service.ts:96`, `:107`, `:163`.
- Deleted-log has page totals from response pages but no progress callback: `packages/sdk/src/cache/deleted-log-sync.service.ts:22`, `:43`, `:63`.
- Payment sync already persists status per invoice and calls progress callback with determinate totals: `packages/sdk/src/cache/payment-sync.service.ts:59`, `:80`, `:82`.
- `cache sync-payments` prints payment progress to stderr and returns final JSON stdout: `packages/cli/src/commands/cache/cache-payment-sync.command.ts:52`, `:55`, `:62`.

### Full-resume

- Checkpoint phases are fixed to accounts, categories, documents, items, deleted-log: `packages/cli/src/commands/cache/full-resume-checkpoint.ts:14`, `:89`.
- Checkpoint captures document and item cursor positions: `packages/cli/src/commands/cache/full-resume-checkpoint.ts:56`, `:228`, `:237`.
- CLI currently wires document checkpointing only; v3 inventory has no resume callback: `packages/cli/src/commands/cache/cache.commands.ts:227`, `:242`.
- Completed phase evidence guards counts, watermarks, payment status fingerprint, category authority, and inventory authority: `packages/cli/src/commands/cache/full-resume-checkpoint.ts:91`, `:124`.
- Tests verify category/inventory same-count drift invalidates resume and deleted-log can allow only count decreases from partial delete replay: `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts:192`, `:204`, `:231`.

## Recommended Contract

Add these types in `packages/sdk/src/cache/types.ts`:

```ts
export type CacheSyncPhase =
  | 'initializing'
  | 'accounts'
  | 'categories'
  | 'documents'
  | 'inventory'
  | 'deleted-log'
  | 'pg-to-sqlite-pull'
  | 'finalizing'
  | 'waiting_rate_limit';

export type CacheSyncProgressEventType =
  | 'phase_started'
  | 'page_started'
  | 'page_completed'
  | 'record_processed'
  | 'pass_started'
  | 'pass_completed'
  | 'waiting_rate_limit'
  | 'phase_completed';

export interface CacheSyncProgress {
  phase: CacheSyncPhase;
  event: CacheSyncProgressEventType;
  pass?: 1 | 2;
  contextId?: number;
  contextName?: string;
  page?: number;
  pagesTotal?: number | null;
  recordsProcessed: number;
  recordsTotal?: number | null;
  recordsUnit:
    | 'accounts'
    | 'categories'
    | 'documents'
    | 'items'
    | 'variations'
    | 'deleted_records'
    | 'payments'
    | 'rows';
  currentRecordId?: string;
  indeterminate: boolean;
  message?: string;
  rateLimit?: {
    retryAfterSeconds?: number;
    waitUntil?: number;
    limit?: number;
    remaining?: number;
    resetSeconds?: number;
  };
}
```

Extend `CacheSyncStatus` with:

- `phase?: CacheSyncPhase`
- `progress?: CacheSyncProgress`
- `progressUpdatedAt?: number`
- optional per-phase counters, keeping existing aggregate fields for compatibility.

Determinate totals:

- Categories: after page 1, use `count/pages`; for v3 stability, report `pass: 1` and `pass: 2` separately.
- V3 inventory item pages: after first item page, use `pagination.total_records/total_pages`; variation totals are determinate per item after first variation page.
- Accounts and deleted-log: each context has response `pages`; total records may be page-derived only unless API exposes `count`.
- Payment sync: total invoices known before loop.
- Documents: keep `recordsTotal: null`, `indeterminate: true` unless response contract is upgraded to trust a count/pages total.

Minimum event sequence:

```text
phase_started -> pass_started? -> page_started -> record_processed* -> page_completed -> pass_completed? -> phase_completed
```

For rate limiting:

```text
waiting_rate_limit with waitUntil/retryAfterSeconds/remaining/resetSeconds
```

This state should be emitted before sleeping/retry backoff and overwritten by the next normal event after retry resumes.

## Implementation Shape

1. Create a small SDK reporter utility, e.g. `cache-sync-progress-reporter.ts`, that accepts `{ cache, runContext, minIntervalMs = 1000 }`.
2. Reporter writes `CacheSyncStatus` only when forced, phase changes, or throttle interval elapsed. Always force on `phase_started`, `phase_completed`, `waiting_rate_limit`, `success`, and `failed`.
3. CLI owns the reporter and passes `onProgress` to indexers. SDK indexers stay backend-agnostic and emit events, not terminal strings.
4. Keep terminal output separate: CLI subscribes to the same events and prints compact human progress to stderr. Do not write incremental JSON to stdout.
5. Update `cache status` output only by including the extended `sync_status` object. Avoid a second progress table/key unless needed for compatibility.
6. For category/v3 inventory, emit progress during fetch/validation passes but do not call `replace*Snapshot` until after validation. Do not change `CategoryCacheMeta.status` or `InventoryCacheMeta.status`.
7. For crash status, leave last persisted status as `running`; consumers should treat stale `running` as `possibly_interrupted` if `updatedAt` is older than a conservative threshold. Avoid clearing another process' running status without proving lock ownership.

## Focused TDD Matrix

1. `CacheSyncStatus` compatibility:
   - old status JSON still parses with no `progress`;
   - new status round-trips in SQLite and PostgreSQL.

2. Reporter throttling:
   - many `record_processed` events produce bounded `setSyncStatus` writes;
   - `phase_started`, `phase_completed`, `waiting_rate_limit`, `failed`, `success` force writes.

3. stdout/stderr contract:
   - `cache sync` stdout remains exactly one final JSON object;
   - progress lines go to stderr only;
   - error stdout remains empty and stderr is JSON error plus optional progress lines per current command convention.

4. `cache status` polling:
   - while mocked sync is running, `cache status` returns `sync_status.status = running` and latest phase/progress;
   - stale running status is represented without claiming success/failure.

5. Category progress:
   - emits `pass_started/pass_completed` twice for v3;
   - after page 1 emits determinate `recordsTotal=count`, `pagesTotal=pages`;
   - invalid page/stability failure persists failed global sync status but does not call `replaceCategorySnapshot`.

6. V3 inventory progress:
   - emits item page progress with determinate totals;
   - emits variation page progress scoped to current item;
   - stability failure persists failed global sync status and does not call `replaceInventorySnapshot`.

7. Documents:
   - full and delta document progress remains indeterminate total unless response totals are explicitly trusted;
   - full-resume document checkpoint persistence is unaffected.

8. Accounts/deleted-log:
   - emits context/page/record events;
   - deleted-log partial failure keeps prior full-resume semantics that allow replayed delete count decreases only.

9. Payment sync:
   - existing `payment_sync_status` remains source of payment backfill polling;
   - optionally map payment progress into generic progress shape without changing resume cursor behavior.

10. Rate-limit:

- simulated 429 with headers produces `waiting_rate_limit` with wait timing and no credential-bearing fields;
- next successful request overwrites `waiting_rate_limit` with the active phase event.

## Risks and Resolution Proposals

- Write amplification: solved by throttled reporter plus forced boundary writes.
- Atomic snapshot weakening: solved by treating progress as global sync status only; category/inventory authoritative meta remains complete-only.
- Mixed JSON output: solved by preserving final JSON stdout and putting live terminal progress on stderr.
- Crashed process leaves `running`: acceptable current behavior; add stale-running interpretation in `cache status`, not automatic mutation.
- Full-resume item checkpoint mismatch: `FullResumeCheckpointStore` supports item position, but current v3 inventory path has no resume. Keep progress separate from resume unless a later phase explicitly adds checkpointed v3 inventory.

## Unresolved Questions

- Should `cache status` add a derived `sync_health: running | stale_running | success | failed`, or should consumers derive it from `sync_status.updatedAt`?
- Should generic progress also be added to `cache sync-payments`, or should payment backfill continue to expose only `payment_sync_status`?
- What throttle interval is acceptable for PostgreSQL shared polling: 1s default recommended; make env override only if operators need it.
- Should rate-limit events be emitted from Axios retry handler globally or only from cache sync callers? Global is more complete but larger API surface.

Status: DONE
Summary: Researched current cache sync/status/indexer/payment/resume contracts and proposed a minimum progress architecture that preserves stdout JSON and atomic category/inventory snapshots.
Concerns/Blockers: None.
