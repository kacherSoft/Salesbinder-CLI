# Stock reconciliation docs journal

Date: 2026-09-18

## Scope

Updated durable operator documentation to match the current official V3 stock-reconciliation contract. Documentation-only change; no SDK, tests, production data, source API, database, credential, or cursor edits.

## Evidence read

- `plans/260918-stock-reconciliation/plan.md`
- `packages/sdk/src/cache/official-v3-stock-reconciliation.ts`
- `packages/sdk/src/cache/postgres-official-v3-sync.store.ts`
- `packages/sdk/src/cache/official-v3-sync-task-runner.ts`
- `packages/sdk/src/cache/official-v3-sync.types.ts`

## Documentation updates

- `README.md`: removed the stale disabled-runner claim and replaced the outdated "only source item markers create item work" wording with selective `stock_reconciliation`, first-observation stock-signature sidecar bootstrap, fallback active-union bootstrap, exact variation/location identity, `stock_history_missing`, and durable 30-second `notBefore` source-settlement delay behavior.
- `docs/deployment.md`: documented selective document-stock reconciliation, parent/child cursor gating, missing-history delete handling, stock-reconciliation receipt supersede rules, legacy `item_refresh` retirement, and rollback compatibility when current or unapplied official state contains any `stock_reconciliation` task.

## Claim boundary

The docs intentionally describe the durable behavior only. They do not include private IDs, data values, cursors, credentials, runtime receipts, or production host details.

## Unresolved questions

- None.
