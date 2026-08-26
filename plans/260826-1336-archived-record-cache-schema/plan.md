---
title: "Archived Record Cache Schema"
description: "Persist source-aware archived state for cached accounts, items, and documents without inventing active state when the API cannot prove it."
status: completed
priority: P1
effort: 2d
issue: null
branch: main
tags: [cache, schema, lifecycle, sqlite, postgresql]
blockedBy: []
blocks: [260724-1358-salesbinder-api-v3-migration]
created: 2026-08-26
---

# Archived Record Cache Schema

## Overview

Upgrade cache schema `3 -> 4` so root cached records expose archive state consistently. Accounts retain current behavior; items and documents gain nullable `archived` columns where `0=active`, `1=archived`, and `NULL=unknown or unobservable`.

Official API limits drive the design: v3 accounts/items expose `archived`; v3 item lists support `archived=all`; v3 documents return active records only and expose no archive field; the advertised v3 OpenAPI URL returned 404 on 2026-08-26. Missing records and `404` therefore never prove archive or deletion.

## Scope

- In: account/item/document row contracts, SQLite/PostgreSQL schema parity, API/CSV writers, null-preserving upserts, PostgreSQL-to-SQLite mirror, migration/backfill tests, README semantics.
- Out: archived filtering in analytics, duplicated item archive state on stock rows, deleted tombstones, archive/unarchive CLI commands, v3 transport/resource implementation.

## Cross-Plan Dependencies

| Relationship | Plan | Reason |
|---|---|---|
| Blocks | [SalesBinder API v3 Dual-Stack Migration](../260724-1358-salesbinder-api-v3-migration/plan.md) | v3 normalized mappers and cache rollout must reuse this lifecycle contract. |

## Decision

- Store new item/document archive state as tri-state; never migrate or map absent source data to active. Preserve the existing account boolean contract in this scoped update.
- Preserve a known `0/1` when a later API or CSV writer supplies `NULL`.
- Keep `item_stock_locations` normalized through `items.item_id`; no `item_archived` duplication.
- Keep deleted-log hard deletes unchanged; archived is not deleted.
- Keep analytics behavior unchanged so cached historical documents remain queryable.

## Phases

| Phase | Name | Status | Dependency |
|---|---|---|---|
| 1 | [Define Lifecycle Contract and Migration](./phase-01-define-lifecycle-contract-and-migration.md) | Completed | None |
| 2 | [Propagate Archived State Through Cache](./phase-02-propagate-archived-state-through-cache.md) | Completed | Phase 1 |
| 3 | [Backfill, Validate, and Document](./phase-03-backfill-validate-and-document.md) | Completed | Phase 2 |

## Success Criteria

- SQLite v3 data migrates to v4 without loss; existing item/document rows receive `NULL`, not `0`.
- Fresh SQLite and PostgreSQL schemas, writes, reads, and mirror pulls agree on tri-state values.
- API/CSV omission cannot erase known archive state; absence/404 never triggers archive/delete inference.
- Existing cache, payment sync, deleted-log behavior, and analytics tests remain green.
- README states source coverage, nullable semantics, backfill limits, and rollback.

## Research

- [Official archive/lifecycle contract](./research/researcher-official-archive-contract.md)
- [Cache archive gap audit](./research/researcher-cache-archive-gap-audit.md)

## Unresolved Questions

None blocking this scope. API completeness gaps remain documented constraints and must not be guessed in code.

## Validation Log

- Tier: Standard; fact checker + contract verifier.
- Claims checked: 24; verified after edits: 24; failed/unverified: 0.
- Whole-plan sweep: `plan.md`, all 3 phase files, both research reports, and dependent v3 `plan.md` reread.
- Decision deltas checked: 2; stale references reconciled: 2; unresolved contradictions: 0.
- Completion: 3/3 phases complete, 31/31 checklist items complete, true plan completion 100%.
