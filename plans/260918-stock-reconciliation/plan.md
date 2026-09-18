# Stock-impact reconciliation plan

## Outcome

Official V3 document changes queue exact item reconciliation only when the document can change stock balances, without restoring blanket referenced-item refreshes.

## Scope

- SDK official V3 sync source, store, runner, validation, and focused tests.
- No ops docs, deployment, production writes, commits, or external API calls.

## Contract

- Add a durable `stock_reconciliation` task kind for item exact hydration.
- Document parent tasks enter `waiting_children` only when stock-impact children are queued.
- Applied cursor advances only after parent and children are done or superseded.
- Invoice impact: item/quantity/location/cancelled/deleted state on inventory lines.
- Purchase-order impact: stock-state transitions, item/quantity/location/received quantity, and deletion when prior stock signature was active.
- Estimate/quotation changes remain document-only.
- Persist an official V3 document stock signature in cache metadata for future comparisons; use cached document/lines as fallback for older rows.
- Do not revive legacy `item_refresh`; old legacy tasks remain retired.

## Implementation TODO

- [x] Extend official V3 task type/validation for `stock_reconciliation`.
- [x] Add stock-impact signature helper with invoice/PO predicates.
- [x] Queue child tasks during document upsert/delete transactions when signatures differ.
- [x] Persist/delete document stock signatures atomically with document writes/deletes.
- [x] Make the runner hydrate `stock_reconciliation` tasks with exact item batching.
- [x] Add focused service/store/integration tests for lifecycle, replay, delete, cursor gating, and unchanged quote/unreceived-PO behavior.
- [x] Run focused unit/store and PostgreSQL integration validation; SDK build passes.

## Unresolved questions

- None currently; primary-doc findings supplied by root drive the predicates above.
