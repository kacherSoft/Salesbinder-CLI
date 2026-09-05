---
phase: 5
title: 'Integration Validation and Rollout'
status: runner_deployed_disabled_pending_credentials_and_live_canary
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

Validate the complete two-database handoff, production event behavior, operational monitoring and rollback. Cutover is not complete until a real event reaches the cache through receiver → ledger → CLI → receipt → ledger completion.

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

- Prefer an existing real inventory event with the read-only V3 credential. Use a uniquely marked disposable item only with separate explicit write authorization.
- If mutation is authorized, exercise create, update, archive/unarchive, quantity/variation-location change where permitted, and delete/cleanup.
- Capture start `S` and target `T`; verify cache item/stock rows, cache receipts, ledger completion and zero blocker at/below `T`.
- Verify unrelated document events do not enter or block the inventory stream.
- Never print API keys, worker DB URLs, webhook secrets or business payloads.

## Rollout

1. Back up ledger and cache databases; record current V7 inventory generation/counts.
2. Deploy Phase 1 ledger migration and worker login; receiver remains on least-privilege ingest role.
3. Deploy CLI code with `SALESBINDER_SCHEDULER_DISABLED=true`; run container runtime verification before credential/cutover preflight.
4. Run initial resumable baseline and bounded replay; do not set feed-bound state until clean promotion.
5. Enable normal event drain every 900 seconds through the approved runner app.
6. Let `cache status` trigger weekly `cache sync --full`; repeated full attempts stay throttled for 24 hours through an atomic cache-DB metadata claim that survives runner replacement.
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
5. Verify an existing real inventory event; perform the disposable-item mutation matrix only with separate write authorization.
6. Run two code reviews, security/redaction scan, lint, tests and build.
7. Enable scheduler, observe at least one normal production event and one clean fixed-target drain.
8. Update durable docs and record rollback evidence.

## Todo

- [x] Pass unit, integration, chaos, lint and build gates.
- [x] Complete two independent code reviews.
- [x] Verify backups and deploy the reviewed runner in explicit disabled mode.
- [ ] Configure credentials and complete a read-only real-event canary.
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

## Current Deployment Evidence

- Cache and ledger backup executions succeeded before deployment.
- Coolify application `s0gcsk404kso88sc48s88wok` built and runs commit `f41159cb1fceed772b60eb7a43bdbdf37ac331b7` from the repository Dockerfile.
- Runtime startup verified compiled CLI/SDK resolution and a native in-memory SQLite query.
- The runner remains intentionally disabled; no production sync or database mutation has run from it.
- Coolify `4.0.0-beta.463` returned `404` for application scheduled-task REST routes during research; that constraint is superseded by the approved URL-less runner app.

## Next Steps

Add the V3 credential and authorize/configure the remaining secrets, restart with `SALESBINDER_SCHEDULER_DISABLED=false`, run the real-event canary, then let the runner continue on 900-second normal sync plus weekly status-driven `--full` with 24-hour full-attempt throttling. After acceptance, mark the plan complete and treat feed status plus periodic reconciliation as the production freshness contract.
