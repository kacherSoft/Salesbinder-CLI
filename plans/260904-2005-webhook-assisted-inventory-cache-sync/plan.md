---
title: 'Webhook-Assisted Inventory Cache Sync'
description: 'Replace repeated full V3 item hydration with resumable baselines plus receipt-backed inventory change-feed replay.'
status: deployed_disabled_pending_credentials_and_live_canary
priority: P1
effort: 10d
branch: main
tags: [feature, backend, database, api, critical]
blockedBy: []
created: 2026-09-04
---

# Webhook-Assisted Inventory Cache Sync

## Overview

Before this update, `cache sync` always performed a complete V3 item membership scan and hydrated every item/variation twice. Any root membership or pagination drift after bounded retries aborted inventory publication and wasted the long hydration work. The implemented replacement uses the separately deployed webhook ledger as the change-discovery source, exact V3 `ids` hydration as the canonical read, and resumable PostgreSQL staging for full baselines.

## Decisions

- Receiver/immutable ledger stay separate; CLI consumes a scoped **inventory** stream while other events remain stored without blocking it.
- `created_at`/`updated_at` are version guards only. They are not list cursors; V3 exposes no timestamp filter.
- Initial/forced full sync still exists, but detail hydration runs once and resumes from PostgreSQL staging.
- Changes during a full run are replayed from the ledger between start and fixed cutover barriers before promotion.
- After cutover, normal `cache sync` drains ledger events and fetches exact IDs in batches of at most 50.
- No V2 inventory fallback or post-cutover snapshot fallback. Change-feed writes only to shared PostgreSQL; SQLite remains an explicit mirror/read target.
- Isolated records retry and end as `success_with_warnings`; systemic, binding, lock, auth, or uncertain-storage failures fail closed.

## Scope

**In:** ledger consumer contract v2 prerequisite, exact-ID item hydration, cache schema v8 staging/receipts, resumable full cutover, incremental event drain, progress/status, recovery tests, production canary and rollout.
**Out:** webhook HTTP ingress inside CLI, MCP server work, document/account event hydration, timestamp polling, always-on daemon, automatic deletion from unexplained API omission, and removal of periodic reconciliation.

## Phases

| Phase | Name                                                                                                | Status                                   | Depends on |
| ----- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| 1     | [Resource-Scoped Ledger Contract](./phase-01-start.md)                                              | Implemented externally                   | —          |
| 2     | [Exact-ID Hydration and Cache Receipts](./phase-02-exact-id-hydration-and-cache-receipts.md)        | Implemented                              | 1          |
| 3     | [Resumable Baseline and Cutover Replay](./phase-03-resumable-baseline-and-cutover-replay.md)        | Implemented                              | 1, 2       |
| 4     | [Incremental Worker, Progress and Recovery](./phase-04-incremental-worker-progress-and-recovery.md) | Implemented                              | 1, 2, 3    |
| 5     | [Integration Validation and Rollout](./phase-05-integration-validation-and-rollout.md)              | Runner deployed disabled; canary pending | 1–4        |

## Runtime Result Matrix

| Case                              | Legacy behavior                               | Implemented design                                           |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Normal sync                       | Full item snapshot twice                      | Drain inventory events to fixed target                       |
| First/forced full                 | Full detail twice; no durable item progress   | Stable root IDs, one detail pass, resumable staging, replay  |
| Create/update/archive during full | Often causes drift/abort                      | Event captured and exact-ID replayed                         |
| Delete during full                | Next stable snapshot only                     | Signed delete event + confirmed missing read = tombstone     |
| Page drift                        | Retries whole expensive operation, then fails | Retry root discovery before detail; retain live/staged state |
| One bad item                      | Preserve/omit with warning after full pass    | Retry only that item; other events continue                  |
| Crash after cache commit          | Ambiguous cross-DB state                      | Cache receipt proves idempotent replay/completion            |
| Duplicate/out-of-order webhook    | No consumer                                   | Dedup event ID; per-object watermark prevents regression     |
| Ledger unavailable after cutover  | N/A                                           | Clear nonzero fail; no snapshot fallback                     |
| Missed/disabled webhook           | Undetected until next full                    | Status lag/blocker + scheduled full reconciliation           |

## Dependencies

- Deployed `kacherSoft/Salesbinder-Webhook-Service` and its private PostgreSQL ledger.
- Official V3 exact-ID mode: `GET /api/v3/items?ids=...`, maximum 50, includes archived/sold known IDs.
- One SalesBinder account per cache DB and per ledger DB; account bindings must match.
- Least-privilege ledger worker login separate from receiver and migration identities.

## Success Criteria

- A day-long baseline resumes without rehydrating completed items and never publishes partial staging.
- Production creates, updates, archives, deletes, duplicate events, and concurrent writes converge to canonical V3 state.
- Normal sync makes no full item-list pass after verified cutover.
- Cache and ledger cross-DB handoff is at-least-once and receipt-idempotent.
- Progress is ID-free; final warnings list only sanitized item IDs and reasons.
- Full test/lint/build gates and two-database PostgreSQL integration/chaos suite pass.
- Live canary reaches a fixed ledger target with zero blocker at or below that target.

## Remaining Input

Add a durable read-only `SALESBINDER_V3_API_KEY`; authorize or directly configure V2 and least-privilege database credentials; choose a supported task interface because Coolify `4.0.0-beta.463` returns `404` for application task REST routes.
