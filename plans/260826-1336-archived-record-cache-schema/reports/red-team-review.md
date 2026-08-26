# Archived Record Cache Schema Red-Team Review

## Summary

Standard-tier fact and contract review completed against all plan files, both research reports, current cache/type/indexer sources, tests, and the dependent API v3 plan.

## Findings Applied

1. P1: account omission semantics contradicted the scoped compatibility decision. `AccountIndexerService.toAccountRow()` currently maps missing `archived` to `0`; Phase 2 said preserve/unknown. Plan now states account compatibility explicitly while item/document fields remain tri-state.
2. P1: dependent v3 plan still promised a stable cache schema despite now being blocked by schema v4. Decision text now consumes the prerequisite schema without creating a second lifecycle representation.

## Accepted Constraints

- Official v3 documents expose no archive field and exclude archived records. `NULL` remains correct unless a source explicitly proves a value.
- PostgreSQL has no local schema-version integer. Idempotent DDL and a configured integration gate are required; deterministic unit tests alone do not prove live PostgreSQL readiness.
- The optional current document wire field must be labeled observed/legacy, not official v3 contract.

## Verification Results

- Tier: Standard
- Claims checked: 24
- Verified after edits: 24
- Failed: 0
- Unverified: 0
- Whole-plan consistency: 5 plan files plus 2 research reports reread; 2 stale references reconciled; 0 unresolved contradictions.

## Unresolved Questions

None blocking approved scope.

Status: DONE
