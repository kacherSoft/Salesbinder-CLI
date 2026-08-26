---
phase: 3
title: "Backfill, Validate, and Document"
status: completed
priority: P1
effort: "4h"
dependencies: [2]
---

# Phase 3: Backfill, Validate, and Document

## Context Links

- [Plan](./plan.md)
- [Phase 2](./phase-02-propagate-archived-state-through-cache.md)
- [Official API research](./research/researcher-official-archive-contract.md)
- [SalesBinder API v3 migration](../260724-1358-salesbinder-api-v3-migration/plan.md)

## Overview

Prove the additive rollout on old and fresh caches, refresh only source-observable values, and document the boundary between active, archived, unknown, and deleted.

## Key Insights

- A schema migration cannot reconstruct archive history; existing item/document rows must remain `NULL` until authoritative refresh.
- Current v2 delta sync may populate items when payloads include the field, but completeness needs a full sync.
- v3 cannot enumerate archived documents, so document archive coverage must never be presented as complete.

## Requirements

- Functional: provide a safe backfill procedure using normal `cache sync --full` and optional CSV re-import; no bespoke destructive rewrite.
- Functional: verify known/unknown counts directly in synthetic SQLite and PostgreSQL fixtures.
- Functional: document rollback as code-only; additive columns/indexes remain in place.
- Functional: update README cache schema/source behavior and v3 handoff constraints.
- Non-functional: validation must not use production data, live write operations, or weaken failing tests.

## Architecture

`open old cache -> additive migration -> unknown item/document values -> authoritative full sync/import -> observable values only`

Rollback: deploy previous code; it ignores additive columns. Do not drop columns or decrement SQLite `user_version` in normal rollback.

## Related Code Files

- Modify `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts`.
- Modify `packages/sdk/src/cache/__tests__/csv-cache-import.service.test.ts`.
- Modify `packages/sdk/src/cache/__tests__/pg-to-sqlite-sync.test.ts`.
- Modify focused indexer/payment/analytics tests identified in Phase 2.
- Modify `README.md`.
- During the later v3 plan, update its phase 3 mappers and phase 5 cache rollout to this contract.

## Implementation Steps

1. Build a synthetic pre-v4 SQLite cache with accounts, items, documents, line items, and payments; migrate and compare IDs, counts, amounts, relationships, and archive values.
2. Validate fresh SQLite and PostgreSQL schemas and repeat initialization.
3. Run full API-sync fixtures where item true/false is explicit and documents omit archive; verify expected `1/0/NULL` results.
4. Run CSV fixtures with and without optional archive headers, followed by API writes and PostgreSQL-to-SQLite pull; verify precedence and parity.
5. Prove deletion behavior remains explicit through deleted-log tests and that analytics/payment results are unchanged.
6. Update README with tri-state definition, per-source coverage, v3 limitations, full-sync backfill, and additive rollback.
7. Run focused SDK tests, full SDK tests, build, root tests, and lint. Fix regressions; never convert unknown values to pass assertions.

## Todo

- [x] Validate old-cache migration and fresh schemas.
- [x] Validate API, CSV, mixed-source, and mirror matrices.
- [x] Validate analytics, payment, and deletion regressions.
- [x] Document backfill, limitations, and rollback.
- [x] Complete full quality gates.

## Success Criteria

- [x] `pnpm --filter @salesbinder/sdk test -- --runInBand` passes.
- [x] `pnpm --filter @salesbinder/sdk build` passes.
- [x] `pnpm test`, `pnpm build`, and `pnpm lint` pass.
- [x] Migrated and fresh caches have matching schema behavior with no lost rows.
- [x] Documentation never promises archived-document completeness from v3.
- [x] The pending v3 plan is explicitly blocked until this normalized contract lands.

## Risk Assessment

- Full sync may still leave unknown documents. Mitigation: document source coverage; unknown is the correct result.
- PostgreSQL integration may not be available in every local run. Mitigation: retain deterministic SQL/unit checks and require the configured integration gate before release.
- Rollback code may write without new columns. Mitigation: additive nullable schema stays backward-compatible.

## Security Considerations

Use synthetic fixtures and masked connection identifiers. Do not print API keys, database credentials, customer data, or full live payloads.

## Next Steps

After implementation and review, resume the v3 migration with its normalized lifecycle mappers aligned to schema v4.

- Pre-release smoke still pending a live PostgreSQL URL: `SALESBINDER_DB_URL=<live-postgres-url> node packages/cli/dist/cli.js cache sync --full && node packages/cli/dist/cli.js cache status`.

## Unresolved Questions

None.
