---
title: "Scheduled Official V3 Incremental Sync"
description: "Run ledger-independent official V3 cursor polling in the existing URL-less Coolify runner with safe state selection, configurable cadence, and explicit reference refresh."
status: in_progress
priority: P1
effort: "1-2d"
branch: codex/cache-sync-runner
tags: [feature, backend, cache, scheduler, api]
blockedBy: [260907-0700-official-v3-sync]
blocks: [260904-2005-webhook-assisted-inventory-cache-sync]
created: 2026-09-07
---

# Scheduled Official V3 Incremental Sync

## Outcome

Convert the existing `packages/cache-sync-runner` service to schedule `cache sync-v3` against the official SalesBinder feed. Keep one URL-less Coolify app, one self-scheduling process, one PostgreSQL writer lock, and no webhook-ledger dependency for incremental polling.

## Boundaries

- Official incremental scope stays `item`, `invoice`, `estimate`, `purchase_order`; it is partial catch-up, not proof that accounts, categories, users, payments, archives, or the old cache baseline are complete.
- Ledger remains available for other workflows, but is not configured, inspected, or required by this runner mode.
- No automatic V2 fallback. A separate reference-refresh job may intentionally use proven V3 endpoints and one governed V2 users read.
- No new repository, web server, public URL, second scheduler, or concurrent duplicate schedule.
- No automatic weekly `cache sync --full` until a ledger-free, resumable full-baseline design exists. Weekly audit/backup is allowed but must not run the expensive legacy full path.
- Cold bootstrap is separate: capture `start=now` before complete enumeration, publish a verified baseline, then replay from that cursor. Existing partial cache contents cannot be promoted to complete authority.

## Runtime Design

1. Start immediately, then use a start-to-start cadence. Default `300s`; enforce `60s` minimum until measured rate/runtime evidence supports lower. Exact X-minute mode uses an interval (not naive `*/X` cron). Document `300`/`86400`/`604800` as relative every-five-minutes/daily/weekly presets.
2. Maintain at most one active cycle and one coalesced missed tick. Poll interval is not an execution timeout: a healthy run continues past the next tick. Never queue a backlog after a long run or restart. PostgreSQL advisory-lock contention is a safe skipped cycle, not a second writer or fatal container exit.
3. Read `cache sync-v3 --status` before every cycle and choose exactly one action:
   - `null`: run `--since <configured-known-since>` once; for PHUTHAITECH use `1788670542`, the original scan start. Missing initialization input fails readiness without guessing.
   - `running`, `failed`, or `success_with_warnings`: run `--resume`.
   - `success` with applied cursor: run no-option `cache sync-v3`.
   - malformed/unreadable/mismatched/`409 rebuild_required`: do not reset state; emit actionable reconcile-required status.
4. Never schedule a fixed `--since` after state exists. Never use `--resume` for a clean run because current behavior is a successful no-op, not a new poll.
5. Parse sanitized official-feed status/result JSON for run state, task counts, cursor gap, warnings, and last outcome. Do not derive cadence or health from legacy `last_sync`/`last_full_sync` timestamps.
6. Run a distinct daily reference-refresh command only after endpoint contracts are proven: accounts and categories use their authoritative read paths; users use the explicit account-bound V2 directory read. It is not a fallback from V3 and has its own status/freshness. Payments remain explicitly incomplete unless a separate payment job is enabled. Calendar-time daily/weekly mode, if selected later, uses explicit `Asia/Ho_Chi_Minh` time and a persisted last-due slot.

## Implementation Work

### 1. Make official V3 scheduling a first-class runner mode

- Update `packages/cache-sync-runner/src/scheduler-config.ts` so enabled incremental mode requires account, subdomain, V3 key, cache PostgreSQL URL, and cadence only. V2 key and `SALESBINDER_CHANGE_FEED_DB_URL` become optional, job-specific inputs.
- Update `packages/cache-sync-runner/src/container-config.ts` and `bootstrap-main.ts` so V3-only startup does not fabricate or require a V2 credential.
- Add a bounded V3-only account loader/resolver for `cache sync-v3`; current `packages/sdk/src/config/config.loader.ts` and `AccountConfig.apiKey` reject missing V2. Preserve V2 validation for existing commands; never write a dummy secret or reuse the V3 key as `apiKey`.
- Replace full-attempt-store construction in `packages/cache-sync-runner/src/main.ts`; keep the same executor, signal handling, runtime probe, container, and Coolify application.

### 2. Replace legacy cadence selection with the official state machine

- Refactor `packages/cache-sync-runner/src/cache-sync-scheduler.ts` to dispatch status → initialize/resume/poll, fixed cadence, missed-tick coalescing, shutdown, lock-skip, and reconcile-required behavior.
- Give `packages/cli/src/commands/cache/cache-v3-sync.command.ts` a stable machine-readable scheduled outcome for writer-lock contention and V3-only credential resolution; keep human CLI behavior and sanitized errors compatible.
- Retire scheduler use of `statusNeedsFullSync`, `FullAttemptStore`, legacy `cache status`, normal `cache sync`, and weekly `--full`. Remove dead full-attempt code only after repository references prove it unused.

### 3. Add bounded reference refresh, observability, and release docs

- Reuse existing account/category indexers and salesperson-directory writer behind one explicit reference-refresh command; validate endpoint pagination/authority before enabling its daily schedule.
- Update runner/CLI focused tests for every state transition, null initialization, clean no-op avoidance, lock contention, warning resume, `409`, cadence bounds, overrun coalescing, termination, and a real config path with only account/subdomain/V3/cache DB (no V2 or ledger).
- Update `README.md` and `docs/deployment.md`: partial coverage matrix, cadence presets, cold-bootstrap boundary, optional V2/reference settings, rollback, and no weekly full.
- Treat current Coolify scheduled tasks as an optional one-shot adapter only, invoking the same dispatcher with its internal loop disabled. Primary deployment remains the existing self-scheduled runner because the live instance version/API was not verified.

## Validation and Rollout

- Focused runner + CLI tests, TypeScript build, lint, and relevant SDK regression suites pass; no ignored failures.
- Measure one dry/read-only state cycle and one controlled official poll duration/rate behavior before choosing `60s`; retain `300s` default otherwise.
- Merge the reviewed official-V3 dependency commit (`137d652` is pushed but not `main`), then deploy an exact reviewed `main` commit to `SalesBinder CLI Scheduler` (`s0gcsk404kso88sc48s88wok`) in `PHUTHAITECH/dev`.
- Canary disabled first; verify startup, account binding, V3 status, initialization input, and backups. Enable one schedule only. Confirm cursor/task progress, no ledger access, no overlapping writer, and no legacy full invocation.
- Roll back by disabling the scheduler and restoring the prior image. Preserve official V3 state/pages/tasks and cache data; never clear/reset cursors to hide a failure.

## Success Criteria

- [x] Clean cycles poll from the saved applied cursor; incomplete/warning cycles resume; initialization occurs once from the known original boundary.
- [x] Incremental runner starts with only account/subdomain/V3/cache DB configuration, without V2 or ledger, and never invokes legacy normal/full sync.
- [x] Default five-minute cadence works; daily, weekly, and bounded X-minute settings use the same state machine without duplicate schedules.
- [x] Long runs and external writers produce one coalesced/skip outcome, not overlap or backlog.
- [x] Dispatcher distinguishes lock-busy skip, clean success, exit-zero warnings, and auth/transport/storage failure from structured status/result—not child exit code alone.
- [ ] Status and alerts expose official run/task/cursor health, `409` reconciliation, coverage gaps, and reference/payment freshness separately.
- [ ] Documentation and canary evidence match deployed behavior; existing partial baseline remains labeled partial.

Current evidence: build passed; frozen runner 6 suites/26 tests plus lint/typecheck, CLI sync-v3 12 tests, and SDK V3 config/service 10 tests passed. Compiled startup smoke passed with no V2 key or ledger URL and wrote a mode-`0600` V3-only config. `sync-references` is registered and visible in compiled CLI help. Broad gates, final reference-service validation, main promotion, and canary remain pending.

## Dependencies and Sources

- Depends on [Official V3 Sync](../260907-0700-official-v3-sync/plan.md) landing on `main`.
- Supersedes runner cadence/credential assumptions in [Webhook-Assisted Inventory Cache Sync](../260904-2005-webhook-assisted-inventory-cache-sync/plan.md), not its ledger storage use cases.
- SalesBinder sync contract: https://www.salesbinder.com/api/v3/sync/
- Coolify scheduled tasks (optional alternative): https://next.coolify.io/docs/core/automation/scheduled-tasks/overview

## Unresolved Questions

- None blocking implementation. Calendar-time daily/weekly cron needs live Coolify version/UI verification; relative interval presets do not.

<!-- slug: scheduled-official-v3-incremental-sync -->
