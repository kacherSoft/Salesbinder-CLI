---
phase: 5
title: 'Integration Validation and Rollout'
status: pending
priority: P1
effort: '2d'
dependencies: [1, 2, 3, 4]
---

# Phase 5: Integration Validation and Rollout

## Context Links

- [Plan](./plan.md)
- `packages/sdk/src/cache/__tests__/postgres-sync-lock-disconnect.integration.test.ts`
- External `Salesbinder-Webhook-Service/test/change-feed-contract-integration.test.ts`
- [Official webhook delivery/retry guide](https://www.salesbinder.com/kb/webhooks-setup-and-technical-guide/)

## Overview

Validate the complete two-database handoff, production mutation behavior, operational monitoring and rollback. Cutover is not complete until a real event reaches the cache through receiver → ledger → CLI → receipt → ledger completion.

## Test Matrix

| Scenario                              | Expected result                                        |
| ------------------------------------- | ------------------------------------------------------ |
| Initial baseline, no events           | Clean baseline receipt and promoted run                |
| Create/update/archive during baseline | Replay converges to latest V3 object                   |
| Delete during baseline                | Proven tombstone removes item bundle                   |
| Pagination drift before hydration     | Root-only retry; no staged detail loss                 |
| Process killed mid baseline           | Same run resumes completed IDs                         |
| Duplicate and out-of-order events     | One cache effect; monotonic watermark                  |
| Cache commit then process kill        | Receipt readback completes on reclaim                  |
| Ledger commit/network ambiguity       | No false completion; idempotent retry                  |
| Cache advisory-lock disconnect        | Fail closed; no receipt or success                     |
| Ledger checked-out client disconnect  | No unhandled event; leases recover                     |
| Lease expiry/reclaim                  | Old token fenced from renew/fail/complete              |
| 429 and long wait                     | Progress update plus safe renewal/backoff              |
| One malformed item                    | Others apply; deterministic warning/blocker            |
| Non-inventory/quarantine event        | Retained globally; inventory cursor unaffected         |
| SQLite pull after event updates       | Local mirror matches current PostgreSQL rows/meta      |
| Ledger/cache restore mismatch         | Worker pauses and reports receipt reconciliation steps |

## Requirements

### Automated Gates

- Unit tests for contracts, mode selection, result formatting and redaction.
- PostgreSQL integration tests with separate ledger and cache databases.
- Failure injection around every cross-database boundary and advisory-lock lifecycle.
- Full `pnpm lint`, `pnpm test`, `pnpm build`, plus package coverage report.
- Two independent code-review passes before commit; resolve all correctness/security findings.

### Live Canary

- Use one uniquely marked disposable item with explicit write authorization.
- Exercise create, update, archive/unarchive, quantity/variation-location change where permitted, and delete/cleanup.
- Capture start `S` and target `T`; verify cache item/stock rows, cache receipts, ledger completion and zero blocker at/below `T`.
- Verify unrelated document events do not enter or block the inventory stream.
- Never print API keys, worker DB URLs, webhook secrets or business payloads.

## Rollout

1. Back up ledger and cache databases; record current V7 inventory generation/counts.
2. Deploy Phase 1 ledger migration and worker login; receiver remains on least-privilege ingest role.
3. Deploy CLI code with change feed configured but cutover disabled; run contract/binding preflight.
4. Run initial resumable baseline and bounded replay; do not set feed-bound state until clean promotion.
5. Enable normal event drain every minute through the existing scheduler/service runner.
6. Schedule full reconciliation weekly initially; adjust only after observed webhook coverage proves safe.
7. Alert on receiver inactivity, queue age, retry/dead-letter, blocker cursor, repeated 429, sync lock loss and baseline age.

## Rollback

- Stop the scheduler first; keep receiver ingest and ledger history running.
- Do not delete receipts, staging, event state or cursors.
- Restore/deploy the last known CLI version and run an explicit clean V3 full snapshot before declaring freshness, or restore the pre-cutover cache backup.
- Re-enable change-feed code only after it verifies existing receipts and replays unapplied events; never reset a cursor by hand.

## Related Code Files

- Add two-database integration tests under `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/`.
- Add CLI orchestration regression tests under `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/`.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/README.md` with configuration, modes, statuses, recovery and scheduling.
- Update external `Salesbinder-Webhook-Service/docs/operations-runbook.md` with worker/stream monitoring and restore choreography.

## Implementation Steps

1. Build deterministic test harnesses around two PostgreSQL databases and a controllable V3 HTTP server.
2. Run failure matrix; fix behavior rather than weakening assertions.
3. Run a read-only production preflight for account IDs, V3 exact-ID capability, scopes and ledger contract.
4. Take backups, deploy ledger contract, provision worker role and deploy CLI canary.
5. Perform authorized disposable-item mutation matrix and verify exact database evidence.
6. Run two code reviews, security/redaction scan, lint, tests and build.
7. Enable scheduler, observe at least one normal production event and one clean fixed-target drain.
8. Update durable docs and record rollback evidence.

## Todo

- [ ] Pass unit, integration, chaos, lint and build gates.
- [ ] Complete two independent code reviews.
- [ ] Complete live disposable-item canary.
- [ ] Back up and deploy in ordered rollout.
- [ ] Verify monitoring, reconciliation schedule and rollback.

## Success Criteria

- All automated gates pass without skipped critical integration cases.
- Real SalesBinder event updates the shared cache and closes with verified receipts.
- A live event during a long baseline is replayed before target promotion.
- Normal scheduled run finishes while new higher-sequence events continue arriving.
- Rollback drill preserves ledger evidence and returns the cache to an explicitly verified state.

## Risk Assessment

- Webhook endpoint can be disabled after repeated failures. Receiver health alone does not prove delivery continuity; monitor delivery age and keep weekly reconciliation.
- Live mutation tests can affect business data. Use only a uniquely marked disposable item and clean it up with evidence.

## Security Considerations

- Backups, logs and reports must exclude credentials and raw payloads.
- Worker, receiver, operator and migration roles remain separate throughout rollout and recovery.

## Next Steps

After acceptance, mark the plan complete and treat feed status plus periodic reconciliation as the production freshness contract.
