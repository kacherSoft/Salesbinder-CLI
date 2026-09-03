---
phase: 2
title: 'Instrument Resilient Sync Progress'
status: completed
priority: P1
effort: '3d'
dependencies: [1]
---

# Phase 2: Instrument Resilient Sync Progress

## Context Links

- Plan index: [plan.md](./plan.md)
- Research: [researcher-progress-contract.md](./research/researcher-progress-contract.md)
- Types/status: `packages/sdk/src/cache/types.ts`, `packages/sdk/src/cache/cache.interface.ts`
- Indexers: `account-indexer.service.ts`, `category-indexer.service.ts`, `document-indexer.service.ts`, `v3-inventory-indexer.service.ts`, `deleted-log-sync.service.ts`
- Atomic stores: `sqlite-cache.service.ts`, `postgres-cache.service.ts`
- Resume: `packages/cli/src/commands/cache/full-resume-checkpoint.ts`

## Overview

Add typed progress plus a shared record-issue contract. Documents and inventory complete their primary scan, retry collected record failures once, then return unresolved warnings without aborting valid work or breaking atomic writes and existing callbacks.

## Key Insights

- `CacheSyncStatus` currently stores `running | success | failed`, aggregate counts, message, and error only.
- `SyncOptions.onProgress(current,total)` is document-only today and uses `-1` for unknown totals.
- Category and v3 inventory do two complete reads before atomic replacement; progress must not imply partial authority.
- Documents currently rethrow the first per-record error, and `writeDocument()` performs delete/insert steps without a shared transaction.
- Inventory currently throws the first per-item variation/normalization error. Both behaviors prevent a recovery pass and cancel later work.
- Existing item/document reads provide last-known-good data; inventory already has atomic replacement, while documents need one backend-atomic bundle write before failures can be safely collected.
- SQLite/PostgreSQL sync status is JSON in `cache_meta.sync_status`, so optional fields need no DB schema-version bump.
- Payment backfill has separate `payment_sync_status`; unresolved invoice documents must not falsely advance it to complete.

## Requirements

- Functional: add `CacheSyncPhase`, `CacheSyncProgressEventType`, and `CacheSyncProgress` in a focused SDK progress-types module, re-exported from the cache package.
- Functional: extend `CacheSyncStatus` with optional `phase`, `progress`, `progressUpdatedAt`, and optional redacted rate-limit timing; old JSON remains valid.
- Functional: preserve `SyncOptions.onProgress(current,total)` compatibility; add `onProgressEvent?: (event: CacheSyncProgress) => void` rather than changing callback arity.
- Functional: instrument accounts, categories, documents, v3 inventory, and deleted log.
- Functional: preserve exact public call compatibility while adding options: `AccountIndexerService.sync(fullOrOptions: boolean | AccountSyncOptions = false)`, `CategoryIndexerService.sync(options: CategorySyncOptions = {})`, `DocumentIndexerService.sync(options: SyncOptions = {})`, `V3InventoryIndexerService.sync(options: V3InventorySyncOptions = {})`, and `DeletedLogSyncService.sync(options: DeletedLogSyncOptions = {})`.
- Functional: categories and inventory emit observational progress during fetch/validation passes and publish only through existing atomic `replace*Snapshot`.
- Functional: introduce `SyncRecordIssue` with resource (`document | item`), SalesBinder ID, optional document context, sanitized error code/message, attempt count, and `preservedLastKnownGood | omittedNew` outcome. Never include source payloads, names, headers, URLs, or credentials.
- Functional: on the primary document/item pass, catch only attributable record-local validation/detail-fetch failures after a usable ID exists, append one deduplicated issue per resource+ID, emit `record_failed_collected`, and continue. Cache reads, writes, and transaction failures remain fatal.
- Functional: for inventory's two reads, require root pagination and the complete item-ID set to match. Compare valid content per ID; if either read is locally invalid or the two per-item fingerprints differ, queue that ID for recovery instead of failing all inventory.
- Functional: after the primary pass for that resource, run exactly one application recovery pass. Refetch canonical document detail or v3 item detail plus all variations, revalidate, and atomically write/insert it. Transport-layer retries from Phase 1 still apply inside that attempt.
- Functional: remove recovered IDs from the issue list and emit `record_retry_succeeded`. A failed recovery never stops the remaining queue. After all retries, sort unresolved entries by resource/context/ID; retain existing cached bundles or omit new records with no last-known-good copy.
- Functional: add backend-atomic `replaceDocumentBundle` so an attempted document refresh cannot delete old line items/payments before its replacement is complete.
- Functional: inventory builds fresh valid rows plus retained rows for unresolved existing items, then publishes once atomically. Metadata format v2 (not SalesBinder API v2) supports `complete | complete_with_warnings` plus fresh/preserved/omitted/warning counts and `lastCompleteAt`; format-v1 complete remains readable.
- Functional: root document/item list failures, unusable/missing identity, duplicates, root pagination/count or item-ID-set drift, source bounds, exhausted auth/network/rate errors, unknown exceptions, and systemic cache transaction failures remain fatal.
- Functional: persist aggregate counts plus the full deduplicated/sorted sanitized unresolved list in final `CacheSyncStatus`; final CLI output exposes the same list for owner action. `attempts` counts the primary plus application recovery attempt, not internal transport retries. Live progress omits IDs until terminal reporting.
- Functional: keep the previous global `lastSync`/`lastFullSync` on warning completion and record `lastSyncAttempt`; this guarantees the next delta run reconsiders unresolved documents rather than advancing past them.
- Functional: never invent overall percent or unknown totals; represent unknown totals with `recordsTotal: null` and `indeterminate: true`.
- Functional: add terminal cache sync state `success_with_warnings`; unresolved record issues complete the command, while fatal errors retain `failed`.
- Functional: keep `payment_sync_status` as the payment progress contract; generic payment progress is explicitly deferred.
- Non-functional: serialize status writes per run; routine progress writes at most once per second, repeated rate-wait updates at most once per five seconds unless the state changes or the deadline materially increases, with terminal state written last.
- Non-functional: persisted/public progress uses only an allowlist of phase, event type, pass/page/count totals, indeterminate flag, API version, numeric wait/reset/remaining, and timestamps; it never contains record IDs, names, payloads, credentials, request headers, fingerprints, or URLs.

## Architecture

Types live in focused progress/issue modules and are re-exported through the cache package. `CacheSyncProgressReporter` serializes and throttles status writes; its terminal guard covers `success`, `success_with_warnings`, and `failed`.

Each indexer owns a deduplicated recovery queue. Documents normalize fully before calling atomic `replaceDocumentBundle`. Inventory verifies the root ID set across two reads, accepts only per-ID content that validates and matches, and queues invalid or changed IDs. Its recovery pass refetches those IDs through existing `items.get()` and `listVariations()`. The final candidate combines recovered/stable new rows with prior v3 API rows for unresolved IDs, then publishes once with warning metadata.

Event sequence:

```text
phase_started -> pass_started? -> page_started -> record_processed* -> page_completed -> pass_completed? -> phase_completed
```

Rate-limit observer sequence from Phase 1, represented as an event inside the current phase rather than a new phase:

```text
waiting_rate_limit -> next normal phase event after request resumes
```

## Related Code Files

- Create: `packages/sdk/src/cache/cache-sync-progress-reporter.ts`
- Create: `packages/sdk/src/cache/cache-sync-progress.types.ts`
- Create: `packages/sdk/src/cache/sync-record-issue.types.ts`
- Create: `packages/sdk/src/cache/__tests__/cache-sync-progress-reporter.test.ts`
- Create: `packages/sdk/src/cache/__tests__/cache-sync-progress-contract.test.ts` if compatibility coverage is clearer outside service tests
- Modify: `packages/sdk/src/cache/types.ts`
- Modify: `packages/sdk/src/cache/index.ts`
- Modify: `packages/sdk/src/cache/account-indexer.service.ts`
- Modify: `packages/sdk/src/cache/category-indexer.service.ts`
- Modify: `packages/sdk/src/cache/document-indexer.service.ts`
- Modify: `packages/sdk/src/cache/v3-inventory-indexer.service.ts`
- Modify: `packages/sdk/src/cache/cache.interface.ts`
- Modify: `packages/sdk/src/cache/sqlite-cache.service.ts`
- Modify: `packages/sdk/src/cache/postgres-cache.service.ts`
- Modify: `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts`
- Modify: `packages/sdk/src/cache/deleted-log-sync.service.ts`
- Modify: `packages/sdk/src/cache/payment-sync.service.ts` only if needed for a regression assertion; do not add generic progress or alter `payment_sync_status` semantics
- Modify tests: `category-indexer.service.test.ts`, `v3-inventory-indexer.service.test.ts`, `sync-resume-indexers.test.ts`, `payment-sync.service.test.ts`, `sqlite-cache.service.test.ts`, `postgres-cache.service.test.ts`, `pg-to-sqlite-sync.test.ts`
- Delete: none

## Tests Before

1. Add failing status compatibility tests: old `CacheSyncStatus` JSON round-trips; new optional progress fields round-trip in SQLite and PostgreSQL.
2. Add failing reporter ordering/throttling tests: repeated `record_processed` writes are bounded to one per second; repeated rate-wait events are coalesced; terminal success/success-with-warnings/failure is last and cannot be overwritten.
3. Add failing account/deleted-log tests: context/page/record events emitted, totals remain page-derived only when source provides `pages`.
4. Add failing document tests: the primary pass collects multiple failing IDs and continues; recovery refetches each once; recovered IDs disappear; unresolved existing documents/children remain unchanged; unresolved new documents are omitted; legacy progress callback remains compatible.
5. Add failing category tests: v3 emits two pass start/completion cycles, determinate count/pages after first page, and invalid/stability failure does not call `replaceCategorySnapshot`.
6. Add failing atomic document bundle tests for both backends: injected failure cannot remove or partially replace last-known-good document, line items, or included payment rows.
7. Add failing inventory recovery tests: collect several item IDs, retry once via v3 detail/variations, continue after a failed retry, remove recovered IDs, preserve unresolved existing rows, omit unresolved new rows, update valid peers, and publish `complete_with_warnings` atomically.
8. Add failing fatal-boundary tests: root list/identity/duplicate/pagination/ID-set drift, exhausted transport/auth, unknown exceptions, and systemic DB failure still throw and retain prior state; per-item content drift is recoverable.
9. Add failing compatibility/mirror tests: format-v1 complete remains readable; format-v2 complete/complete-with-warnings survives PostgreSQL-to-SQLite pull; final status retains the full sanitized unresolved list.
10. Add failing payment regression test: unresolved invoices cannot mark payment refresh complete; existing standalone payment sync callbacks/status remain compatible.

## Refactor

1. Add narrow per-indexer option types and overload-compatible normalization; do not force all indexers to adopt document-specific `SyncOptions`.
2. Convert direct indexer console progress only where SDK currently emits progress; leave terminal rendering to CLI in Phase 3.
3. Keep reporter small and testable; avoid embedding CLI wording or ANSI behavior in SDK.

## Implementation Steps

1. Define typed progress phases/events and optional `CacheSyncStatus` fields.
2. Implement reporter with `emit(event)`, `markRunning`, `markSuccess`, `markSuccessWithWarnings`, and `markFailure`. Use one promise chain per run, explicit boundary/coalescing policy, terminal guard, and final queue drain.
3. Add `onProgressEvent` option support using the exact compatibility signatures above; normalize the account boolean overload internally without changing existing callers.
4. Emit accounts/deleted-log progress per context/page and record count; avoid customer names and deleted record names.
5. Add atomic `replaceDocumentBundle` to both cache backends; normalize/refetch before entering its transaction. Collect attributable document failures, complete the primary scan, then retry each unique ID once.
6. Emit category progress for each stability pass and page; category integrity remains strict and atomic.
7. Split root item-list/ID-set integrity from per-item content. Queue invalid or cross-read-mismatched IDs, finish both primary reads, then retry each unique ID once using v3 detail and variations.
8. Load prior v3 API rows and compose fresh + preserved inventory. Unresolved new items are omitted; format-v2 metadata records aggregate outcomes; PostgreSQL-to-SQLite mirror preserves that metadata.
9. Emit `record_failed_collected`, `retry_pass_started`, `record_retry_succeeded`, and `record_retry_failed` events; live events carry counts only, while the final warning status carries the full sanitized ID list.
10. If unresolved issues remain, keep clean global watermarks, set `lastSyncAttempt`, finalize invoice payment refresh as incomplete when affected, and call `markSuccessWithWarnings`; otherwise follow normal success semantics.
11. Translate limiter waits into `waiting_rate_limit` on the current phase. Keep all structural/source/storage failures fatal.

## Todo List

- [x] Write failing status compatibility and reporter throttling tests.
- [x] Add progress types and reporter.
- [x] Instrument accounts and deleted-log.
- [x] Instrument documents while preserving legacy callback.
- [x] Instrument category and inventory stability passes.
- [x] Add document/item failure queues and one recovery pass.
- [x] Add atomic document bundle replacement and inventory last-known-good preservation.
- [x] Add full terminal warning lists and watermark/payment safeguards.
- [x] Prove structural/source/storage failures remain fatal and non-publishing.
- [x] Add rate-limit event adapter.
- [x] Prove payment status semantics unchanged.

## Tests After

1. Run `pnpm --filter @salesbinder/sdk exec jest --runInBand src/cache/__tests__/cache-sync-progress-reporter.test.ts src/cache/__tests__/cache-sync-progress-contract.test.ts`.
2. Run `pnpm --filter @salesbinder/sdk exec jest --runInBand src/cache/__tests__/category-indexer.service.test.ts src/cache/__tests__/v3-inventory-indexer.service.test.ts src/cache/__tests__/sync-resume-indexers.test.ts src/cache/__tests__/payment-sync.service.test.ts`.
3. Run `pnpm --filter @salesbinder/sdk exec jest --runInBand src/cache`.
4. Run `pnpm --filter @salesbinder/sdk build`.

## Regression Gate

- Category invalid page/stability and inventory root pagination/ID-set drift cannot publish partial snapshots.
- One identifiable malformed document/item cannot abort valid peers or later sync phases.
- The recovery pass attempts every unique collected ID once; recovered IDs are absent from terminal warnings.
- Unresolved existing records retain their full last-known-good bundle; unresolved new records are listed and omitted.
- Inventory `complete_with_warnings` rows/metadata remain atomic and retain their status through PostgreSQL-to-SQLite pull.
- Fatal discovery/integrity errors preserve prior state and are never converted to warnings.
- Unresolved invoice documents cannot falsely mark their payment refresh complete; standalone payment-sync behavior remains compatible.
- No progress event claims an overall percentage when total is unknown.
- Old cache status JSON consumers can ignore optional fields.
- No DB schema-version bump for optional JSON progress.
- A queued routine write cannot overwrite a terminal state; repeated limiter waits cannot amplify PostgreSQL writes.

## Success Criteria

- [x] Progress contract covers determinate and indeterminate phases.
- [x] Reporter throttles metadata writes and forces boundary states.
- [x] All cache indexers emit typed events without backend coupling.
- [x] Terminal status distinguishes clean success from `success_with_warnings`; inventory authority distinguishes `complete` from `complete_with_warnings`.
- [x] Existing public callback compatibility preserved.

## Risk Assessment

- Risk: write amplification to PostgreSQL. Mitigation: reporter throttle plus forced boundaries only.
- Risk: event type churn leaks into CLI tests. Mitigation: central type contract and focused renderer adapter in Phase 3.
- Risk: warning completion hides stale rows. Mitigation: explicit status, full failed ID list, outcome counts, retained clean watermark, and `lastCompleteAt`.
- Risk: broad catch converts systemic corruption into warnings. Mitigation: catch only typed record-local errors after stable identity; structural/auth/transport/systemic storage tests remain fatal.
- Risk: retry duplicates work or output. Mitigation: resource+ID deduplication, exactly one application recovery attempt, and separate transport retry accounting.
- Risk: many warnings enlarge status/final JSON. Mitigation: store identifiers, codes, short sanitized messages, attempts, and outcomes only—never response bodies; full list retained because owner remediation is an explicit requirement.
- Risk: progress callback overload breaks callers. Mitigation: additive `onProgressEvent` and tests around legacy callback.

## Security Considerations

- Live progress persists only phase, event type, page/count totals, numeric timing, API version, and redacted wait details.
- Live progress excludes record IDs. Terminal warning status/output intentionally lists SalesBinder document/item IDs for owner remediation, per product decision.
- Warning entries exclude credentials, fingerprints, Authorization headers, payloads, URLs, and record/customer/item names; messages use stable sanitized codes plus safe summaries.
- Sanitize failure message consistency with current error handling; do not include request config dumps.

## Rollback / Next

- Rollback: disable record collection/recovery and format-v2 warning publication, retain format-v1 reads, and return record errors to current fail-fast behavior.
- Next: Phase 3 owns human rendering, cache status stale-running derivation, CLI stdout/stderr tests, and README updates.

## Validation Log

- Verified `CacheSyncStatus` and `SyncOptions` at `packages/sdk/src/cache/types.ts:273-300`.
- Verified SQLite status JSON at `sqlite-cache.service.ts:1008-1015`; PostgreSQL status JSON at `postgres-cache.service.ts:1289-1301`.
- Verified category atomic publish at `category-indexer.service.ts:38-79`, SQLite `replaceCategorySnapshot` at `sqlite-cache.service.ts:728-733`, PostgreSQL at `postgres-cache.service.ts:707-780`.
- Verified v3 inventory two reads and atomic publish at `v3-inventory-indexer.service.ts:35-64`, page validation at lines 147-185.
- Verified recovery endpoints already exist: v2 `documents.get(id)` and v3 `items.get(id)` plus `items.listVariations(id)`.
- Verified both backends expose `getAllItems()` and `getAllItemStockLocations()` and replace API inventory rows inside one transaction.
- Verified full-resume fixed phases and evidence checks at `full-resume-checkpoint.ts:14-16`, `89-116`, `222-277`.
- Focused validation passed for progress, recovery, source validation, cache identity/authority, atomic persistence, and resume compensation; final serialized SDK validation passed: 32/32 suites, 743/743 tests.

## Unresolved Questions

None.
