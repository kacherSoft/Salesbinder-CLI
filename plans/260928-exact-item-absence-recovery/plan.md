# Exact Item Absence Recovery

Status: implementation and isolated validation complete; canary and release pending

## Outcome

Allow official V3 item upsert and stock-reconciliation tasks to treat an ID omitted
from a successful, complete exact-ID response as authoritative current absence.
Remove only API-owned inventory, complete the task atomically, and let the applied
cursor advance through the normal writer path.

## Constraints

- Preserve sealed source marker operation and cursor history.
- Keep baseline, offset, and change-feed hydration behavior unchanged by default.
- Never remove inventory after HTTP failure, malformed/truncated response, identity
  mismatch, variation failure, or local validation failure.
- Preserve CSV stock and existing writer lock, transaction, CAS, and monotonic receipt
  guards.
- Implementation worker performs no production database, scheduler, deployment, or
  credential changes, and no SalesBinder business API writes. The lead owns the separately
  authorized restored-backup canary, issue 1 release, and production recovery.

## Implementation

1. Completed: add explicit exact-response absence authority to the shared item hydrator. Default
   omissions remain `missing_unproven`; official callers opt in and receive
   `verified_absent` only after all exact response validation succeeds.
2. Completed: route official item marker and stock-reconciliation absence through a dedicated
   store method.
3. Completed: in one verified transaction, remove API inventory and complete the original task.
   Record latest receipt materialization as `absent` with its original source operation.
4. Completed: treat a newer `absent` receipt like a delete receipt when superseding stale stock
   reconciliation work.

## Validation

- Shared hydrator: default versus opt-in omission, mixed found/absent batch, malformed
  partition rejection.
- Official runner: marker and stock child absence; failed reads and local failures remain
  non-destructive.
- Store: atomic task/cache/receipt mutation, rollback, already-absent idempotence,
  monotonic newer-receipt protection.
- PostgreSQL integration: resume closes a failed contiguous prefix, API rows are removed,
  CSV rows survive, latest receipt reports absence, and stale tasks cannot regress it.
- Full workspace build passed for all three packages.
- Full workspace lint passed for all three packages with no errors and 14 existing SDK warnings.
- Full workspace tests passed: SDK 1,292 passed and 68 skipped; CLI passed; runner 35 passed.
- Script tests passed: 54 tests.
- Real isolated PostgreSQL official integration passed 19 of 19 tests, including rollback,
  CSV preservation, and cursor recovery.

## Pending Release Work

- Lead: run the restored-backup canary against the current source read path.
- Lead: complete reviewed issue 1 release and production recovery under separate authorization.
- Shipping and warning behavior remains check-only and unchanged in this implementation.

## Acceptance Criteria

- A validated official exact-ID omission completes through normal retry/resume.
- `failed=0`, blocked page completes, and applied cursor catches ingestion cursor when no
  other failures exist.
- No destructive write occurs without successful exact-response absence proof.
- Existing non-official consumers retain their current missing-ID policy.

## Unresolved Questions

None.
