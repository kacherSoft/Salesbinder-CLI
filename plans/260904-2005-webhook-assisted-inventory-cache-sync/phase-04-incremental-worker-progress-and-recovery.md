---
phase: 4
title: 'Incremental Worker, Progress and Recovery'
status: implemented
priority: P1
effort: '2d'
dependencies: [1, 2, 3]
---

# Phase 4: Incremental Worker, Progress and Recovery

## Context Links

- [Plan](./plan.md)
- `packages/cli/src/commands/cache/cache.commands.ts`
- `packages/sdk/src/cache/cache-sync-progress.types.ts`
- `packages/cli/src/commands/cache/postgres-sync-lock-loss.guard.ts`

## Overview

Make normal `cache sync` drain the inventory ledger to a fixed target. Events are leased, coalesced by item, hydrated from canonical V3 state, written with receipts, and completed after receipt readback. Existing account/document deltas and category snapshot remain unchanged.

## Requirements

### Functional

- Add `SALESBINDER_CHANGE_FEED_DB_URL`; it must use a least-privilege worker login.
- Use stable consumer `salesbinder-cli-inventory-v1`; use a unique per-process lease owner.
- Preflight contract version, ledger/cache account binding and consumer scope before setting sync status to running.
- Normal mode selection:
  - no feed config and no feed-bound cache: retain current full-snapshot compatibility;
  - configured but no verified baseline: start/resume Phase 3;
  - verified feed-bound baseline: capture target and drain inventory events only;
  - feed-bound cache with missing/unreachable ledger: fail clearly, no fallback.
- Claim small batches, coalesce events by item ID, and call V3 exact-ID batches of at most 50.
- Renew leases while rate-limited or hydrating large item subtrees.
- Apply one current item bundle and receipts for all coalesced events in one cache transaction.
- Complete ledger events only after exact receipt readback.
- Record-local failure calls fenced ledger failure for that item’s events, continues other items, retries on later claims and ends with warnings when unresolved.
- `cache sync --full` runs Phase 3 reconciliation; `--full-resume` keeps document semantics while inventory staging is always resumable.

### Event Semantics

| Event                    | Action                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `inventory.item_created` | Exact hydrate/upsert                                                                                |
| `inventory.item_updated` | Exact hydrate/upsert; includes archive/unarchive and stock-affecting changes                        |
| `inventory.low_stock`    | Exact hydrate/upsert; no special cache mutation                                                     |
| `inventory.item_deleted` | Exact batch read, then direct GET if omitted; only confirmed 404 with delete evidence may tombstone |

Omitted IDs on create/update/low-stock are retryable/blocked, never deletion. Unknown inventory event types quarantine and block this stream until operator resolution.

## Progress and Result Contract

- Extend inventory progress with `mode: baseline | replay | incremental` and ID-free events: target captured, batch claimed, batch applied, lease renewed, checkpoint saved and blocker observed.
- `cache status` reports baseline generation, observed/applied/blocker event sequences as decimal strings, queue/retry/dead-letter counts and last event timestamp.
- Clean target reached: exit `0`, `status=success`, advance clean sync timestamp.
- Isolated retry/dead-letter/blocker: exit `0`, `status=success_with_warnings`, preserve last clean timestamp, list deterministic sanitized item IDs/reasons.
- Auth, binding, schema, cache/ledger connection, lock loss or uncertain transaction: exit `1`, `status=failed`.

## Related Code Files

- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/change-feed/change-feed.types.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/change-feed/postgres-change-feed.repository.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/inventory-change-feed-sync.service.ts`.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/cache-sync-progress.types.ts`.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/types.ts` for status/result metadata.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-orchestrator.ts`.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/inventory-sync-result-formatter.ts`.
- Reduce `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache.commands.ts` to command registration/dependency wiring.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/cache-sync-progress-controller.ts` and focused tests.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/README.md` only after behavior is verified.

## Implementation Steps

1. Add a small typed repository against ledger SECURITY DEFINER functions; represent BIGINT cursors as strings.
2. Add config validation/redaction and fail-closed post-cutover mode selection.
3. Capture a target before claims so one-shot sync has deterministic completion despite ongoing ingest.
4. Claim/renew/coalesce batches; order completion deterministically by numeric event sequence without JavaScript number conversion.
5. Hydrate exact IDs, apply cache bundles/receipts, read receipts, then complete each lease.
6. On per-item errors, fail only that group’s leases and continue; on systemic errors stop and let uncommitted leases expire.
7. Wire baseline replay to the same engine with sync-run ID and `(S,T]` bounds.
8. Extend progress, final JSON and `cache status`; keep stdout as one JSON object and live progress on stderr.
9. Extract orchestration from the 1,600-line command file rather than adding more branches to it.

## Todo

- [x] Add ledger repository and config preflight.
- [x] Add deterministic incremental/replay engine.
- [x] Add coalescing, lease renewal and failure classification.
- [x] Integrate command mode selection.
- [x] Extend progress/status/warning output.

## Success Criteria

- Normal post-cutover sync does not call paginated item listing.
- Duplicate delivery/event or crash replay causes no duplicate cache effect.
- New events arriving above target never prevent the current command from finishing.
- One invalid item does not cancel other items; owner receives one final warning entry for it.
- Cache lock loss never completes a ledger event or prints success.

## Risk Assessment

- Coalescing can accidentally hide tombstones. Resolve desired action from canonical current read plus newest claimed event, but write a receipt for every covered event.
- A global 429 pause can expire leases. Renew before long waits; stop before uncertain expiry rather than committing unfenced work.

## Security Considerations

- Do not log raw event bodies or ledger/database credentials.
- Validate UUID/object/account fields even though ingress was signed; ledger contents remain untrusted input at the CLI boundary.

## Next Steps

Phase 5 proves cross-database, production-concurrency and rollback behavior before enabling the feed-bound marker.
