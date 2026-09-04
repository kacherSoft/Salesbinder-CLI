---
phase: 3
title: 'Resumable Baseline and Cutover Replay'
status: implemented
priority: P1
effort: '2.5d'
dependencies: [1, 2]
---

# Phase 3: Resumable Baseline and Cutover Replay

## Context Links

- [Plan](./plan.md)
- `packages/sdk/src/cache/v3-inventory-indexer.service.ts`
- `packages/cli/src/commands/cache/full-resume-checkpoint.ts`
- External `Salesbinder-Webhook-Service/docs/change-feed-db-consumer-contract.md`

## Overview

Replace the current preflight + two full detail passes with a short membership gate, one durable detail pass and bounded ledger replay. Long work survives process restarts; live production edits no longer invalidate completed item hydration.

## Requirements

### Functional

- Begin/resume a ledger sync run and capture start barrier `S` before membership discovery.
- Run two consecutive root-only `archived=all` page scans; compare canonical ID set and pagination signature.
- Do not hydrate variations until root membership is stable.
- Persist the accepted root fingerprint and stage each item bundle once with per-ID checkpoint state.
- Resume the same active run across processes after verifying cache, account, schema, ledger, root and API-scope bindings.
- Retry each record-local hydration failure once; preserve staging and return warning if unresolved.
- Promote staging only with complete clean membership and zero exclusions.
- Insert/read back a cache baseline receipt, verify it in the ledger, capture fixed target `T`, cover events `≤S`, replay `(S,T]`, then promote the ledger run.
- Leave events `>T` queued for the next incremental run.

### Non-Functional

- Root drift restarts only cheap root discovery; it never discards already promoted live cache data.
- Staging lives in PostgreSQL, not a node-local file, so another writer host can resume after acquiring the cache lock.
- Readers continue seeing the previous authoritative generation until baseline promotion.

## Architecture

```text
acquire cache lock
  → begin/resume ledger run; capture S
  → root IDs pass A + pass B (fast stability gate)
  → hydrate/stage each ID once; checkpoint in DB
  → retry unresolved IDs
  → promote complete staging + baseline receipt
  → verify receipt in ledger
  → capture T; cover ≤S
  → exact-ID replay (S,T]
  → promote sync run; release cache lock
```

## Failure Matrix

| Failure                                   | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Root page/membership drift                | Retry root-only scan; old snapshot remains live                         |
| Process stops mid hydration               | Active run + staged bundles remain; next run resumes                    |
| One item fails twice                      | `success_with_warnings`; no baseline promotion; run remains resumable   |
| Cache commit uncertain                    | Inspect exact baseline/event receipt before any retry                   |
| Cache advisory-lock loss                  | Stop immediately; do not verify/complete ledger state                   |
| Ledger connection loss after cache commit | Receipt remains; next lease/run completes idempotently                  |
| Operator resets checkpoint                | Fail active ledger run with sanitized code, then clear only its staging |

## Related Code Files

- Refactor `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/v3-inventory-indexer.service.ts` into a compatibility facade.
- Create `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/v3-inventory-baseline.service.ts`.
- Reuse `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/v3-inventory-pagination.ts`.
- Reuse `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/v3-inventory-recovery.ts` for record classification.
- Modify `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/cli/src/commands/cache/full-resume-checkpoint.ts` so legacy document checkpoints and DB-backed inventory staging do not conflict.
- Add baseline/resume/promotion tests under `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/packages/sdk/src/cache/__tests__/`.

## Implementation Steps

1. Protect current clean snapshot behavior with regression tests before refactor.
2. Split root enumeration from item observation; remove second detail/variation pass from the new path.
3. Begin the barrier before root discovery so every production change during discovery/hydration is `>S` and replayable.
4. Persist root fingerprint and expected ID count; reject resume against another account/cache/ledger/schema/run.
5. Stage item bundles transactionally and skip only verified-complete IDs on resume.
6. Retry unresolved IDs once per invocation. Keep the run active and staging durable on warning.
7. Promote baseline via DB-to-DB staging copy under one cache transaction and insert baseline receipt.
8. Verify receipt after commit, capture target and invoke Phase 4 replay machinery for `(S,T]`.
9. Promote ledger run only after scoped applied cursor reaches `T` with no blocker at/below `T`.

## Todo

- [x] Split root stability from detail hydration.
- [x] Add DB-backed item checkpoint/staging.
- [x] Add clean-only baseline promotion and receipt.
- [x] Add start/target barrier replay.
- [x] Add safe reset/resume semantics.

## Success Criteria

- A stopped 30,000-item baseline resumes without refetching completed item details.
- Routine create/update/delete activity during the run does not force detail rehydration from zero.
- No partial or warning baseline becomes authoritative.
- Cache visible generation changes once, atomically, before replay completes under `sync_status=running`.
- Promotion proves the exact fixed target, not “whatever is currently latest.”

## Risk Assessment

- Webhook delivery is not a point-in-time database snapshot. The protocol therefore retains periodic full reconciliation and refuses to claim completeness when ledger blockers or receiver gaps are known.
- Event `≤S` is assumed visible to an API scan begun after `S`; live canary must test this ordering. If violated, add a bounded settle/overlap reconciliation before cover.

## Security Considerations

- Checkpoints store IDs and hashes in the private cache DB only; CLI output shows counts, not payloads.
- Reset affects one validated run ID and cannot clear arbitrary generations.

## Next Steps

Phase 4 implements normal event draining and supplies the replay engine used here.
