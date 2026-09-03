---
phase: 3
title: 'Integrate CLI Progress and Verify'
status: completed
priority: P1
effort: '1.5d'
dependencies: [1, 2]
---

# Phase 3: Integrate CLI Progress and Verify

## Context Links

- Plan index: [plan.md](./plan.md)
- Research: [researcher-progress-contract.md](./research/researcher-progress-contract.md), [researcher-rate-limiter.md](./research/researcher-rate-limiter.md)
- CLI cache command: `packages/cli/src/commands/cache/cache.commands.ts`
- Payment command reference: `packages/cli/src/commands/cache/cache-payment-sync.command.ts`
- JSON formatter: `packages/cli/src/output/json.formatter.ts`
- Lock/resume tests: `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`, `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts`
- User docs: `README.md`

## Overview

Wire progress reporting into `cache sync`, render human progress safely on stderr, expose latest progress through `cache status`, and run the regression gates for limiter, progress, locks, resume, and v3 no-fallback behavior.

## Key Insights

- `cache sync` currently writes status only at start/success/failure and prints document progress directly to stderr.
- Successful `cache sync` currently prints one JSON object via `console.log(formatJson(output))`.
- `cache status` already includes raw `sync_status`, `payment_sync_status`, categories, and inventory metadata for both PostgreSQL and SQLite.
- `cache.commands.ts` is 968 lines, so new rendering/status logic should live in a focused helper module.
- `formatError` writes JSON errors to stderr; progress must not corrupt stdout automation.

## Requirements

- Functional: create CLI progress controller/renderer module; keep `cache.commands.ts` changes minimal.
- Functional: human progress goes to stderr. TTY in-place rendering is capped at 10 Hz; non-TTY emits phase/state boundaries and at most one routine line per five seconds.
- Functional: stdout contains exactly one final JSON object on clean or warning completion; fatal-error stdout remains empty.
- Functional: persist optional progress inside existing JSON `CacheSyncStatus`; no DB schema-version bump.
- Functional: the Phase 2 reporter owns status write throttling and terminal ordering; the CLI renderer does not create a second persistence path.
- Functional: `cache status` exposes the allowlisted latest progress and a top-level `sync_health`; do not auto-clear status or another writer's lock.
- Functional: derive `sync_health` as `running` while a validated limiter deadline is in the future, `clock_skew` when the persisted timestamp exceeds reader time by more than 30 seconds, and `stale_running` when a running status has no future wait and its latest progress/status timestamp is older than 120 seconds; terminal states map to `success`, `success_with_warnings`, or `failed`.
- Functional: unresolved record issues finish with exit code `0` and final JSON `{ success: true, status: "success_with_warnings", failed_documents: SyncRecordIssue[], failed_items: SyncRecordIssue[] }`; include every unresolved ID once with sanitized reason and preservation outcome. Fatal errors remain exit code `1`.
- Functional: preserve locks, full-resume semantics, `--pull`, and no-v2-fallback v3 requirement.
- Functional: checkpoint format v5 stores sanitized phase result summaries so `--full-resume` restores unresolved lists when skipping an already completed warning phase. PostgreSQL-to-SQLite `--pull` preserves inventory `complete_with_warnings` metadata.
- Functional: after final clean or warning completion, persist terminal status/output first and then remove the full-resume checkpoint; a fatal later phase keeps checkpoint results for retry.
- Non-functional: no dashboard/webhook/MCP/TUI; `cache status --watch` deferred unless later evidence proves necessary.

## Architecture

Add `cache-sync-progress-controller.ts` to combine the SDK reporter with terminal rendering. It receives `stderr`, TTY detection, clock, and render intervals for tests. The command constructs dependencies in this order: validate configuration and the v3 key before cache mutation; open/bind the cache and acquire its writer lock; create reporter/controller; construct v2/v3 clients with the optional limiter observer; mark running; run phases; await terminal reporter/controller finalization; then release the lock. Retry messages flow through the observer when present, so cache sync does not also receive the client's fallback `console.warn`.

`cache status` continues returning JSON and adds top-level `sync_health` for both backends. Health derivation is read-only, uses `progressUpdatedAt ?? updatedAt`, recognizes a validated future limiter deadline as active work, detects future clock skew before staleness, and never mutates `sync_status` or removes another process lock.

Terminal warning shape is stable and machine-readable:

```json
{
  "success": true,
  "status": "success_with_warnings",
  "failed_documents": [
    {
      "id": "...",
      "context_id": 11,
      "code": "invalid_record",
      "message": "...",
      "attempts": 2,
      "outcome": "preserved_last_known_good"
    }
  ],
  "failed_items": [
    {
      "id": "...",
      "code": "invalid_variations",
      "message": "...",
      "attempts": 2,
      "outcome": "omitted_new"
    }
  ]
}
```

## Related Code Files

- Create: `packages/cli/src/commands/cache/cache-sync-progress-controller.ts`
- Create: `packages/cli/src/commands/cache/cache-sync-progress-controller.test.ts`
- Create: `packages/cli/src/commands/cache/cache-progress-output.test.ts` if command-level stdout/stderr tests do not fit existing lock test
- Modify: `packages/cli/src/commands/cache/cache.commands.ts`
- Modify: `packages/cli/src/commands/cache/cache-sync-pull-lock.test.ts`
- Modify: `packages/cli/src/commands/cache/full-resume-checkpoint.ts`
- Modify: `packages/cli/src/commands/cache/full-resume-checkpoint.test.ts`
- Modify: `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts`
- Modify: `packages/sdk/src/cache/__tests__/postgres-cache.service.test.ts`
- Modify: `README.md`
- Delete: none

## Tests Before

1. Add failing CLI controller tests: TTY in-place rendering, non-TTY throttled lines, rate-limit wait line, final/failure flush.
2. Add failing stdout/stderr contract test: `cache sync` emits progress only to stderr and exactly one final JSON object to stdout.
3. Add failing client-to-status integration test: a constructed client's synthetic 429 observer event reaches the controller/reporter and becomes allowlisted persisted progress without a duplicate retry warning.
4. Add failing health tests for current running, future limiter wait, 120-second stale running, over-30-second future clock skew, success, success-with-warnings, and failure; prove derivation clears neither status nor locks.
5. Add warning projection tests: live progress contains no record IDs; terminal `failed_documents`/`failed_items` contain every unresolved ID exactly once but no credentials, headers, URLs, payloads, or record/customer names.
6. Add failing regression tests for locks, `--full-resume`, `--pull`, and missing `v3ApiKey` no-v2-fallback behavior.
7. Add a command-level race test proving pending progress cannot overwrite terminal success/success-with-warnings/failure before lock release.
8. Add warning command/resume/pull tests: later phases execute, stdout has one full unresolved list and exit `0`, checkpoint skip restores it, and PG-to-SQLite retains inventory warning metadata.
9. Add checkpoint lifecycle tests: `success_with_warnings` removes checkpoint only after terminal persistence/output preparation; a fatal later phase keeps prior warning phase results.

## Refactor

1. Move terminal rendering, status-health derivation, and progress formatting out of `cache.commands.ts`.
2. Replace inline document progress callback with controller callback while preserving equivalent human information for non-TTY logs.
3. Make command orchestration explicit: configuration guard, cache binding, lock, reporter/controller, observed clients, phase execution, awaited terminal state, final JSON, cleanup.

## Implementation Steps

1. Implement CLI progress controller with injected streams, TTY flag, clock, and throttle settings.
2. Wire controller to one SDK `CacheSyncProgressReporter` and to the optional limiter observer on the actual constructed v2/v3 clients; suppress fallback retry logging only when the observer handles it.
3. Pass typed progress callbacks into `AccountIndexerService`, `CategoryIndexerService`, `DocumentIndexerService`, `V3InventoryIndexerService`, and `DeletedLogSyncService`.
4. Replace initial `setSyncStatus` and final success/success-with-warnings/failure writes with reporter/controller helpers that preserve existing aggregate fields.
5. Update `cache status` JSON for both PostgreSQL and SQLite with allowlisted latest progress and the exact top-level health derivation above.
6. Upgrade full-resume checkpoint to restore phase result summaries and propagate inventory warning metadata through PG-to-SQLite pull without promoting it to clean complete.
7. Keep final success JSON shape compatible, adding no streaming stdout JSON.
8. Update README sections for retry/rate limiting, record recovery, warning lists, status health, and residual process-local limitation.
9. Run focused then broad verification.

## Todo List

- [x] Write failing CLI rendering and stdout/stderr tests.
- [x] Implement progress controller helper.
- [x] Wire cache sync phase callbacks with minimal command file growth.
- [x] Render/persist full deduplicated terminal document/item warning lists.
- [x] Restore warning phase results across full-resume and mirror warning metadata on pull.
- [x] Add stale-running status derivation.
- [x] Update README durable behavior notes.
- [x] Run full regression gate and build.

## Tests After

1. Run `pnpm --filter @salesbinder/cli exec jest --runInBand src/commands/cache/cache-sync-progress-controller.test.ts src/commands/cache/cache-progress-output.test.ts`.
2. Run `pnpm --filter @salesbinder/cli exec jest --runInBand src/commands/cache/cache-sync-pull-lock.test.ts src/commands/cache/full-resume-checkpoint.test.ts`.
3. Run `pnpm --filter @salesbinder/sdk exec jest --runInBand src/client src/cache`.
4. Run `pnpm --filter @salesbinder/cli exec jest --runInBand`.
5. Run `pnpm build`.
6. Optional manual local smoke with test credentials only if user supplies/authorizes them; not required for MVP plan completion.

## Regression Gate

- One stdout JSON object on success; no progress stdout.
- Unresolved documents/items yield `success_with_warnings`, full deduplicated ID lists, exit `0`, and do not prevent later phases/finalization.
- Error stdout empty; stderr remains JSON error plus allowed human progress lines.
- Status metadata writes throttled under noisy progress but forced at boundaries.
- Running/waiting/stale/clock-skew health is derived with the stated thresholds, not auto-cleared.
- Awaited reporter finalization guarantees no routine progress write lands after success/success-with-warnings/failure or lock release.
- Cache writer locks still acquired/released; with `--pull`, the outer PostgreSQL writer lock remains continuously held through the pull, terminal status/output, and checkpoint cleanup while the pull also locks SQLite.
- Full-resume still validates category/inventory/payment evidence and keeps deleted-log replay semantics.
- Missing `v3ApiKey` still fails before cache mutation; no v2 fallback for category/inventory.
- Existing payment delay remains.

## Success Criteria

- [x] Users see live primary/retry progress and explicit `success_with_warnings` without breaking shell automation.
- [x] Final JSON and `cache status` list every unresolved document/item ID once with a sanitized reason and preservation outcome.
- [x] `cache status` exposes machine-readable latest progress and conservative health.
- [x] Command file stays mostly orchestration; helper owns rendering/status formatting.
- [x] README matches shipped command behavior and residual limitations.
- [x] All focused tests and `pnpm build` pass.

## Risk Assessment

- Risk: mixed stderr progress and JSON error surprises scripts reading stderr. Mitigation: stdout contract remains strict; README documents stderr as human/errors channel.
- Risk: stale-running threshold too aggressive. Mitigation: conservative threshold based on progressUpdatedAt/updatedAt and no mutation.
- Risk: helper abstraction hides command state. Mitigation: simple constructor/context object and tests for all three terminal boundaries.
- Risk: `cache.commands.ts` still grows. Mitigation: keep helper responsible for rendering and health; command only wires callbacks.
- Risk: warning arrays can be large. Mitigation: one compact JSON object, deterministic order, no duplicated IDs or raw response bodies; retaining every unresolved ID is required for owner remediation.

## Security Considerations

- Live renderer displays phase, counts, wait/reset seconds, and API version only; it never prints record IDs or names.
- Terminal `failed_documents`/`failed_items` intentionally print IDs for owner remediation. They must not include record names, customer data, payloads, credentials, headers, or URLs.
- Full-resume checkpoint warning results retain existing `0600` file permissions.
- Mask DB URL behavior remains unchanged for `cache status` PostgreSQL output.

## Rollback / Next

- Rollback: remove CLI helper wiring and optional README updates; SDK progress fields remain harmless optional JSON if Phase 2 stays.
- Next: defer distributed limiter coordination and `cache status --watch` until real usage shows process-local pacing/status polling is insufficient.

## Validation Log

- Verified `cache sync` v3 key guard and clients at `cache.commands.ts:81-92`.
- Verified cache writer locks at `cache.commands.ts:95-118`, SQLite lock at `sqlite-cache.service.ts:1129-1162`, PostgreSQL lock at `postgres-cache.service.ts:1319-1354`.
- Verified phase order at `cache.commands.ts:204-252`.
- Verified document stderr progress at `cache.commands.ts:231-238`, final status at lines 281-297, final stdout JSON at line 386, failure status/error at lines 395-414.
- Verified `cache status` JSON includes `sync_status` for PostgreSQL at `cache.commands.ts:668-712` and SQLite at `750-786`.
- Verified `formatJson`/`formatError` in `json.formatter.ts:10-25`.
- Final serialized CLI validation passed: 4/4 suites, 125/125 tests; monorepo build passed; lint passed with 0 errors and 7 pre-existing warnings.

## Unresolved Questions

None.
