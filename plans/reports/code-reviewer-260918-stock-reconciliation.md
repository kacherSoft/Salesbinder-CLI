---
type: code-reviewer-report
date: 2026-09-18
scope: official V3 selective stock reconciliation final core re-review
worktree: /Volumes/OCW-2TB/LocalProjects/worktrees/Salesbinder CLI-codex-stock-reconciliation
baseline: e367fa3
status: approved
---

# Code Review — Official V3 Stock Reconciliation

## Verdict

Spec compliance: PASS for the current core implementation.

No P1/P2 implementation findings remain in the read-only re-review. PostgreSQL integration is now green per the owning worker's final evidence.

## Rechecked Prior Findings

### Delayed stock children vs immediate item receipts

Resolved. `stock_reconciliation` tasks are no longer superseded by generic same-item upsert receipts. The real Postgres receipt persists `operation`, and `hasNewerReceipt` only lets a later item delete supersede a stock reconciliation task.

Evidence:

- `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:483-490`
- `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:762-777`
- focused service test covers same-item upsert before due stock child.

### Stock-child delay clock and wait bounds

Resolved. The runner passes the injected sync clock into document upsert/delete calls, and the store validates the supplied `notBefore`. Waits use the nearest due child and are bounded to 30 seconds.

Evidence:

- `packages/sdk/src/cache/official-v3-sync-task-runner.ts:83-88`
- `packages/sdk/src/cache/official-v3-sync-task-runner.ts:196-200`
- `packages/sdk/src/cache/official-v3-sync-task-runner.ts:304-326`
- `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:700-705`

### First no-sidecar bootstrap policy

Resolved per clarified root decision. First no-sidecar active stock effect queues the union of old/new item IDs once, then persists the exact sidecar. Later metadata-only edits with an exact sidecar do not hydrate.

Evidence:

- fallback/sidecar distinction in `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:508-558`
- bootstrap union policy in `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:687-697`
- upsert selection in `packages/sdk/src/cache/postgres-official-v3-sync.store.ts:222-226`

### Purchase-order send transition

Resolved. Stock signatures include `dateSent`, payload parsing carries `date_sent`, and PO stock state treats a valid sent date as active.

Evidence:

- `packages/sdk/src/cache/official-v3-stock-reconciliation.ts:13-43`
- `packages/sdk/src/cache/official-v3-stock-reconciliation.ts:52-62`
- `packages/sdk/src/cache/official-v3-stock-reconciliation.ts:136-151`

## Verification

- `pnpm --dir packages/sdk exec tsc --noEmit` — PASS.
- `pnpm --dir packages/sdk exec jest src/cache/__tests__/official-v3-sync.service.test.ts src/cache/__tests__/official-v3-stock-reconciliation.test.ts src/cache/__tests__/postgres-official-v3-sync.store.test.ts --runInBand --no-cache` — PASS, 39 tests.
- Owner-reported PostgreSQL official integration + store slice — PASS, 21/21 tests in 7.1s.
- Owner-reported SDK build/tsc and diff-check — PASS.

Reviewer note:

- I did not rerun PG tests in parallel because full validation had exclusive PG ownership. The earlier replay validation failure was a fixture-only issue: the fake clock advanced beyond a store wall-time invariant, while production delay eligibility is runner-clock-derived, persisted as `notBefore`, and bounded in the runner.

## Notes

- No production writes, external API calls, commits, or source edits performed.
- Report-only ownership respected.

## Unresolved Questions

None.

**Status:** DONE  
**Summary:** Current core implementation passes read-only re-review, focused non-PG verification, and owner-reported PG integration/store verification.  
**Concerns/Blockers:** None from code review.
