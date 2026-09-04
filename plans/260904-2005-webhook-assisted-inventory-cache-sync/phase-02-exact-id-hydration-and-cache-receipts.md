---
phase: 2
title: 'Exact-ID Hydration and Cache Receipts'
status: pending
priority: P1
effort: '2d'
dependencies: [1]
---

# Phase 2: Exact-ID Hydration and Cache Receipts

## Context Links

- [Plan](./plan.md)
- [Live V3 offset probe](../reports/260904-1040-v3-item-offset-live-probe.md)
- [Official V3 item exact-ID contract](https://www.salesbinder.com/api/v3/items/)
- `packages/sdk/src/cache/v3-inventory-normalizer.ts`
- `packages/sdk/src/cache/postgres-cache.service.ts`

## Overview

Add the canonical item hydration primitive and cache-side transaction/receipt contract. This phase does not orchestrate full or incremental sync yet; it builds the idempotent units both modes need.

## Key Insights

- V3 `ids` mode accepts at most 50 UUIDs, preserves requested order, and includes archived/sold known items.
- Omitted IDs are either missing or inaccessible; omission alone is not deletion proof.
- Variations and location rows remain separate per-item reads and must replace the item subtree atomically.
- Cache and ledger are separate PostgreSQL databases; cross-database 2PC is forbidden. Durable cache receipts are the recovery evidence.

## Requirements

### Functional

- Extend `V3ItemListParams` with typed `ids` and add `getMany(ids)` with 1–50 validation, canonical identity validation and deterministic omission reporting.
- Hydrate each returned item plus all variations/location rows exactly once per attempt.
- Classify result as `found_current`, `found_archived`, or `missing_unproven`.
- Add cache schema v8 staging, feed-state and immutable receipt tables.
- Atomically replace/delete one item bundle and insert receipts for every covered ledger event.
- Read back exact receipts after commit; duplicate event sequence must return the original result without rewriting state.
- Fence stale cache writes by account, consumer, baseline generation and highest applied event sequence.

### Non-Functional

- Change-feed writer capability is PostgreSQL-only; SQLite is not a second ledger consumer.
- Progress callbacks never contain item IDs; terminal issue output may contain sanitized IDs.
- Existing V7 full-snapshot reads remain usable before cutover.

## Architecture

```text
event IDs → V3 getMany(≤50) → per-item variation hydration → normalized bundle
                                                         │
cache transaction: bundle/tombstone + N event receipts + feed state
                                                         │ commit
receipt readback → ledger completion
```

Schema v8 additions:

| Table                               | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `inventory_change_feed_state`       | Bound ledger/consumer, baseline generation, applied/observed/blocker cursors |
| `inventory_event_receipts`          | Immutable unique receipt per ledger event sequence                           |
| `inventory_baseline_runs`           | Cache-side baseline receipt and lifecycle                                    |
| `inventory_staging_items`           | Durable baseline item rows keyed by sync run                                 |
| `inventory_staging_stock_locations` | Durable staged stock rows keyed by sync run                                  |
| `inventory_staging_progress`        | Root fingerprint and per-item completion/failure evidence                    |

## Related Code Files

- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/resources/v3-items.resource.ts`.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/types.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/change-feed-cache.interface.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/v3-exact-item-hydrator.service.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-inventory-change-feed.store.ts`.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/postgres-cache.service.ts` to delegate V8 operations.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/pg-to-sqlite-sync.service.ts` for current materialized inventory metadata.
- Add focused SDK resource, normalizer, store and migration tests under `packages/sdk/src/**/__tests__/`.

## Implementation Steps

1. Write contract tests for `ids`, empty/over-50 lists, duplicate IDs, omitted IDs, archived results and invalid envelopes.
2. Add `getMany`; split caller input before the resource boundary rather than silently truncating.
3. Extract reusable per-item variation hydration from the current 500-line inventory indexer.
4. Define V8 types that distinguish last verified baseline fingerprint from current feed-applied materialization state.
5. Add PostgreSQL tables, constraints, indexes and account/consumer binding checks.
6. Implement item-bundle upsert and proven tombstone operations as one transaction with receipts.
7. Implement receipt readback and idempotent duplicate handling.
8. Update PostgreSQL→SQLite pull to compute a fresh local mirror fingerprint from the rows it already reads; never copy a stale baseline fingerprint as current content proof.

## Todo

- [ ] Add V3 exact-ID resource contract.
- [ ] Extract exact-item hydrator.
- [ ] Add V8 schema and narrow PostgreSQL writer capability.
- [ ] Add atomic bundle/tombstone + receipt operations.
- [ ] Preserve mirror correctness and V7 pre-cutover compatibility.

## Success Criteria

- 51 IDs are split by orchestration, never sent as an invalid/truncated request.
- An archived item and full variation/location subtree can be atomically upserted.
- A missing non-delete item is never removed.
- A duplicate event application returns the same receipt and performs no second cache mutation.
- Crash after cache commit leaves enough evidence to complete the ledger event later.

## Risk Assessment

- Incremental writes invalidate the old whole-snapshot fingerprint. Mitigate by versioning metadata: retain baseline fingerprint as historical proof, track current state through transactional item/receipt state, and compute a new fingerprint on mirror/full reconciliation.
- Huge item subtrees can exceed lease time. Phase 1 renewal plus small claim batches bound this.

## Security Considerations

- Receipt error data uses stable codes and sanitized messages only.
- Database URLs never enter cache status, progress, error output or fixtures.

## Next Steps

Phase 3 composes these primitives into a resumable baseline and cutover protocol.
