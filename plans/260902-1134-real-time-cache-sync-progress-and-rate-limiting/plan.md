---
title: 'Real-Time Cache Sync Progress and Rate Limiting'
description: 'Add live progress, proactive pacing, and collect-then-retry recovery for failed document and inventory records.'
status: completed
priority: P1
effort: '6d'
branch: main
tags: [cache, cli, sdk, rate-limits, progress, tdd]
created: 2026-09-02
blockedBy: []
blocks: []
---

# Real-Time Cache Sync Progress and Rate Limiting

## Overview

Implement transport request governance, then typed progress plus record recovery, then CLI reporting. An identifiable document/item failure enters a recovery queue instead of aborting; after the primary pass it is fetched and processed once more. Unresolved records produce `success_with_warnings` plus an owner-checkable ID list while last-known-good rows remain safe.

## Goals

| #   | Goal                                                                                                        | Priority |
| --- | ----------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Prevent local cache sync and retry bursts from violating SalesBinder v2/v3 limits.                          | P1       |
| 2   | Persist additive live sync progress without breaking `SyncOptions.onProgress(current,total)`.               | P1       |
| 3   | Keep CLI automation contract: progress on stderr, exactly one final JSON object on stdout.                  | P1       |
| 4   | Collect and retry identifiable document/item failures; report unresolved IDs without cancelling valid work. | P1       |

## Phases

| #   | Phase                                                                                | Status   | Effort |
| --- | ------------------------------------------------------------------------------------ | -------- | ------ |
| 1   | [Build API-version-aware request governor](./phase-01-start.md)                      | Complete | 1.5d   |
| 2   | [Instrument resilient sync progress](./phase-02-instrument-sync-progress.md)         | Complete | 3d     |
| 3   | [Integrate CLI progress and verify](./phase-03-integrate-cli-progress-and-verify.md) | Complete | 1.5d   |

## Key Decisions

- V2 bucket is normalized subdomain + API version because v2 docs do not promise per-key isolation. Use FIFO dual rolling windows `45/60s` and `12/10s`; 429 without `Retry-After` cools down at least `60s + jitter`.
- V3 bucket is normalized subdomain + API version + process-salted key fingerprint. Bootstrap one request, then adapt from `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; on 429 prefer `Retry-After`, then reset, then fallback. Do not hardcode `120` as permanent.
- One package-level process registry is shared by all clients. Distributed coordination deferred; cache writer locks reduce sync collisions but do not guard arbitrary CLI API commands.
- One limiter owns 429 wait deadlines; retry code must not add a second sleep. Safe-method/idempotency rules prevent automatic replay of unsafe writes.
- All requests and retries go through transport limiter. No change to v3-required/no-v2-fallback cache policy.
- Live progress events are additive, typed, and ID-free. Terminal warning lists intentionally expose document/item IDs only; credentials, headers, URLs, payloads, and names remain excluded.
- Category/inventory progress is observational until one atomic snapshot publish. Never mark partial snapshots authoritative.
- During each document/item primary pass, identifiable record-local failures are collected. A recovery pass refetches each failed ID once through the governed client; transport retries remain separate.
- Records recovered on the second pass disappear from warnings. Unresolved existing records retain last-known-good rows; unresolved new records are omitted. Inventory publishes the mixed candidate atomically as `complete_with_warnings`.
- Root list/pagination/count/identity-set instability, duplicate/missing IDs, exhausted auth/network errors, and systemic cache writes remain fatal. Per-item content drift between inventory reads enters the recovery queue instead of failing the phase.
- Warning completion returns one JSON object with `success: true`, `status: success_with_warnings`, full deduplicated/sorted sanitized `failed_documents`/`failed_items` lists, and exit `0`; fatal errors retain exit `1`.
- No dashboard, webhook, MCP, TUI, or `cache status --watch` in MVP. No new env tuning knobs except retaining current retry env.

## Success Criteria

- [x] Limiter tests cover fake clock/FIFO/windows, adaptive headers, cross-client sharing, retry safety, cancellation, bounded headers, one-owner cooldown, and no secret leaks.
- [x] Progress tests cover primary collection, one recovery pass, recovered/unresolved docs/items, atomic preservation, fatal integrity boundaries, payments, and callback compatibility.
- [x] CLI tests cover `success_with_warnings`, full owner-facing failure lists, status throttling/health, stdout/stderr, locks/resume/pull/no-v2-fallback.
- [x] Focused tests, CLI tests, and `pnpm build` pass.
- [x] Docs cover durable behavior; no physical cache schema bump for JSON-only progress/inventory metadata evolution.

## Validation Log

- Read `README.md`, supplied research, and repository rules; repo-root `CLAUDE.md` is absent.
- Verified official docs on 2026-09-02: v2 rate limits at <https://www.salesbinder.com/api/v2/getting-started/rate-limiting/>; v3 rate limits at <https://www.salesbinder.com/api/v3/rate-limits/>.
- Final serialized gates passed: SDK 32/32 suites and 743/743 tests; CLI 4/4 suites and 125/125 tests; SDK/CLI build passed; lint passed with 0 errors and 7 pre-existing warnings.
- Final hygiene passed: changed-file Prettier, `git diff --check`, scoped secret scan, plan validation, and 42/42 plan task status.

## Red Team Review

- 2026-09-02: 17 findings reviewed; 16 accepted and applied; cache credential/scope binding rejected as pre-existing cache authority scope outside this progress/limiter change.
- Applied: v2 subdomain bucket, singleton registry, safe write retry policy, bounded headers, interceptor order, single cooldown owner, abort-aware FIFO, serialized terminal status, redacted status projection, exact callback migration, valid test paths, explicit observer wiring, clock-safe health, retry-log routing, and rate-event coalescing.
- User correction applied after red-team: replaced item-local fail-fast with collect-then-retry for documents and items, owner-facing unresolved ID lists, and `success_with_warnings`; fatal discovery/integrity boundaries remain fail-closed.
- Two independent Sol-high frozen-tree cross-reviews plus the mandatory final code review found no actionable P0-P2 findings; docs consistency review found no mismatch.

## Unresolved Questions

None.

<!-- slug: real-time-cache-sync-progress-and-rate-limiting -->
