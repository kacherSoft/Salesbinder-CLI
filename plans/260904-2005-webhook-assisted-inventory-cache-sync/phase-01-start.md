---
phase: 1
title: 'Resource-Scoped Ledger Contract'
status: in_progress
priority: P1
effort: '1.5d'
dependencies: []
---

# Phase 1: Resource-Scoped Ledger Contract

## Context Links

- [Plan](./plan.md)
- [Webhook consumer contract](../260904-1108-salesbinder-webhook-event-database-service/phase-03-private-change-feed-cutover-semantics.md)
- [SalesBinder webhook guide](https://www.salesbinder.com/kb/webhooks-setup-and-technical-guide/)
- External repository: `kacherSoft/Salesbinder-Webhook-Service`

## Overview

Upgrade the deployed ledger worker contract before CLI consumption. Raw delivery history remains global and immutable, but processing state, blockers, barriers and receipts become consumer/stream scoped. This prevents invoice, PO, estimate, quarantine, or future event types from blocking the inventory cache consumer.

## Key Insights

- Current ledger binds the first successful worker name globally and claims every canonical event.
- Production endpoint can receive several resource families; CLI phase one handles only `inventory.*`.
- A long rate-limit wait can outlive the current maximum lease. Fenced lease renewal is required.
- SalesBinder explicitly supports separate event subscriptions, but preserving one complete event history is more useful than dropping unrelated events.

## Requirements

### Functional

- Add consumer subscriptions with stable `consumer_name`, `account_identity`, and event-family scope.
- Materialize processing state per `(consumer_name, event_seq)` only for subscribed canonical events.
- Scope claim, progress, blocker, baseline cover, target promotion, quarantine and conflict impact to that consumer.
- Add exact-token lease renewal; stale owners/tokens must be rejected.
- Add read-only active-sync-run inspection so another CLI process can resume an interrupted baseline.
- Add a fixed `through_event_seq` bound for ordinary one-shot claims so new ingest cannot make a CLI run endless.
- Expose a contract-version preflight; CLI requires version 2 before mutating cache state.
- Preserve global event sequence and immutable raw event/delivery evidence.

### Non-Functional

- Migration must be online for receiver ingest and safe on an empty or not-yet-bound worker state.
- Runtime roles retain no direct writes to protected tables.
- Existing receiver URL, signature verification, deduplication and HTTP 204 behavior remain unchanged.

## Architecture

```text
immutable event ledger
        │
        ├── consumer: salesbinder-cli-inventory-v1 → inventory.* processing state
        └── future consumer(s)                    → independent processing state

global event_seq orders evidence; each consumer derives its own applied/blocked cursor.
```

## Related Code Files

External `kacherSoft/Salesbinder-Webhook-Service` changes:

- Create `migrations/007-resource-scoped-consumers-and-lease-renewal.sql`.
- Modify `src/domain/change-feed-types.ts`.
- Modify `src/db/postgres-change-feed.ts`.
- Modify `test/change-feed-contract-integration.test.ts`.
- Modify `docs/change-feed-db-consumer-contract.md` and `docs/system-architecture.md`.

No SalesBinder CLI source file changes in this phase.

## Implementation Steps

1. Add `change_feed_consumers` and consumer-specific event-state/watermark keys without changing immutable ledger rows.
2. Add stored functions to register/preflight an allowlisted inventory stream.
3. Update claim/progress/full-sync functions to join only subscribed event types and scoped unresolved evidence; registration must define how existing rows are initialized or baseline-covered.
4. Add `renew_change_feed_event_lease` guarded by owner, exact UUID token, active state and bounded extension.
5. Add `get_active_change_feed_sync_run`, bounded ordinary claims and a contract-version function; expose them in TypeScript.
6. Migrate only known empty/unbound legacy processing state automatically; require operator mapping if rows already exist.
7. Grant EXECUTE only to the fixed worker/operator roles; revoke PUBLIC.
8. Deploy migration first, verify receiver health and live ingest during/after migration.

## Todo

- [ ] Add stream-scoped schema and functions.
- [ ] Add fenced lease renewal and active-run recovery.
- [ ] Add privilege, migration and multi-consumer tests.
- [ ] Deploy contract v2 and provision worker login.
- [ ] Confirm unrelated events do not block inventory progress.

## Success Criteria

- Inventory consumer claims only the four approved `inventory.*` types.
- Non-inventory canonical/quarantine rows remain immutable but do not change its blocker.
- Two consumers can process the same source event independently without state collision.
- Expired/reclaimed lease tokens cannot renew, fail, or complete.
- Receiver stays healthy and accepts a real event during the migration window.

## Risk Assessment

- Migration could accidentally duplicate or orphan processing state. Mitigate with pre/post counts, transaction-wrapped DDL, immutable-ledger checksums and rollback backup.
- Consumer filters could hide an inventory contract drift. Match both allowlisted event types and `object_type`; unknown inventory types remain an inventory-scoped quarantine blocker.

## Security Considerations

- CLI receives only a worker-role connection string, never receiver or admin credentials.
- Consumer registration and scope changes require migration/operator authority; workers cannot widen their own subscription.

## Next Steps

Phase 2 begins only after the deployed preflight reports contract version 2 and the inventory subscription is fixed.
