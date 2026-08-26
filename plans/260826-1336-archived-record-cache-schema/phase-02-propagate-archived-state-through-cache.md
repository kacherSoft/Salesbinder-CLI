---
phase: 2
title: "Propagate Archived State Through Cache"
status: completed
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 2: Propagate Archived State Through Cache

## Context Links

- [Plan](./plan.md)
- [Phase 1](./phase-01-define-lifecycle-contract-and-migration.md)
- [Cache gap audit](./research/researcher-cache-archive-gap-audit.md)
- [Pending v3 cache phase](../260724-1358-salesbinder-api-v3-migration/phase-05-protect-cache-and-roll-out.md)

## Overview

Carry source-backed archive state through API sync, CSV import, cache upserts, and PostgreSQL-to-SQLite mirror without altering analytics or deletion semantics.

## Key Insights

- Account API and CSV paths already write archive state but lack direct regression assertions.
- Item detail is fetched before cache write, providing the strongest current v2 source when `archived` is present.
- Current document wire/cache paths provide status and cancellation, not documented archive state.

## Requirements

- Functional: map a boolean item payload to `0/1`; map omitted item state to `NULL`.
- Functional: map document archive state only when the payload contains a boolean; otherwise write `NULL` and preserve known cache data.
- Functional: retain and test account API/CSV mapping.
- Functional: treat optional CSV `Archived` columns as evidence; files without the column stay valid and map to `NULL` for items/documents.
- Functional: mirror tri-state values PostgreSQL -> SQLite without transformation.
- Non-functional: no stock-row archive column, no tombstone table, no archive filters in analytics, and no change to deleted-log hard deletes.

## Architecture

| Source | Account | Item | Document |
|---|---|---|---|
| Explicit boolean | `0/1` | `0/1` | `0/1` |
| Field omitted | Existing compatibility maps `0` | `NULL` | `NULL` |
| v3 active-only document adapter (future plan) | N/A | N/A | Explicit normalized `0` for returned rows only |
| List absence / 404 | No inference | No inference | No inference |
| Deleted log | Hard delete | Hard delete | Hard delete |

Stock/location queries derive lifecycle by joining `item_stock_locations.item_id` to `items.item_id` when a future consumer needs it.

## Related Code Files

- Modify `packages/sdk/src/cache/account-indexer.service.ts` tests or add focused coverage beside it.
- Modify `packages/sdk/src/cache/item-indexer.service.ts` and add focused tests.
- Modify `packages/sdk/src/cache/document-indexer.service.ts` and its tests without disturbing payment refresh behavior.
- Modify `packages/sdk/src/cache/csv-cache-import.service.ts`.
- Modify `packages/sdk/src/cache/__tests__/csv-cache-import.service.test.ts`.
- Modify `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts`.
- Read-only contract check: `packages/sdk/src/cache/deleted-log-sync.service.ts`, `packages/sdk/src/cache/cache-analytics.service.ts`.

## Implementation Steps

1. Add failing indexer tests for explicit true/false, omitted fields, and preservation after a later unknown write.
2. Map `Item.archived` in `ItemIndexerService.toItemRow()`; keep detail fetch behavior unchanged.
3. Map an optional observed document boolean in `DocumentIndexerService.processDocument()`; do not derive archive from status, cancellation, absence, or `404`.
4. Assert existing `AccountIndexerService.toAccountRow()` and account CSV mapping retain true/false values, including the current omitted-field-to-`0` compatibility behavior.
5. Read optional CSV archive headers without adding them to required header sets. For repeated inventory rows, require consistent explicit values; warn or reject conflicts deterministically.
6. Update CSV merge rules so unknown item/document values do not erase API-known values.
7. Extend mirror fixtures to cover `0`, `1`, and `NULL` across items/documents and existing account values.
8. Run analytics and payment-sync regression tests to prove query semantics and invoice selection did not change.

## Todo

- [x] Add API indexer lifecycle fixtures.
- [x] Map accounts/items/documents under the source matrix.
- [x] Add backward-compatible optional CSV ingestion.
- [x] Preserve known state across mixed-source writes.
- [x] Verify PostgreSQL-to-SQLite parity.
- [x] Prove analytics, payments, and deleted-log behavior remain unchanged.

## Success Criteria

- [x] Every root cached row exposes an archive column/value, including `NULL` when the source cannot know.
- [x] Explicit false is distinguishable from unknown.
- [x] Re-importing source data without archive evidence cannot erase a known value.
- [x] No archived item is inferred from `status_id`; no document is inferred from status/404.
- [x] Existing historical analytics results remain identical.

## Risk Assessment

- Mixed API/CSV writes can downgrade known state. Mitigation: database-level null-preserving precedence plus merge tests.
- Inventory exports repeat one item per stock row. Mitigation: deterministic aggregation and conflict validation.
- Current payment-sync edits overlap document files. Mitigation: rebase changes around existing behavior and rerun focused payment tests.

## Security Considerations

Archive state is not an authorization signal. Continue enforcing API visibility and never expose inaccessible payloads through diagnostics.

## Next Steps

Phase 3 verifies migration/backfill behavior and documents observable coverage.

## Unresolved Questions

None.
