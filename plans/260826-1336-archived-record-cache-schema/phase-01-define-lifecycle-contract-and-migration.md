---
phase: 1
title: "Define Lifecycle Contract and Migration"
status: completed
priority: P1
effort: "6h"
dependencies: []
---

# Phase 1: Define Lifecycle Contract and Migration

## Context Links

- [Plan](./plan.md)
- [Official API research](./research/researcher-official-archive-contract.md)
- [Cache gap audit](./research/researcher-cache-archive-gap-audit.md)
- [Pending v3 resource phase](../260724-1358-salesbinder-api-v3-migration/phase-03-add-v3-resource-adapters.md)

## Overview

Lock archive semantics in TypeScript and add an additive SQLite/PostgreSQL migration before any writer begins supplying values.

## Key Insights

- Cache schema version is currently `3`; only `accounts.archived` exists.
- Official v3 account/item objects expose booleans. Official v3 document objects do not; archived invoices, estimates, and purchase orders are not returned.
- The safe contract is `0 | 1 | NULL`, where `NULL` is information, not a migration failure.

## Requirements

- Functional: add nullable archive state to `ItemRow` and `DocumentRow`; retain account archive support; expose optional wire fields only where payloads can contain them.
- Functional: bump SQLite `CACHE_SCHEMA_VERSION` to `4`; add nullable `items.archived` and `documents.archived` plus indexes.
- Functional: add matching idempotent PostgreSQL `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations and indexes.
- Functional: make item/document conflict updates preserve stored `0/1` when the incoming value is `NULL`.
- Non-functional: migration must be additive, transactional where supported, idempotent, and compatible with current dirty payment-sync work.

## Architecture

`wire/export field -> boolean normalizer -> 0 | 1 | NULL -> cache upsert`

Precedence: explicit incoming `0/1` replaces stored state; incoming `NULL` preserves stored state; a new row with no evidence stores `NULL`.

## Related Code Files

- Modify `packages/sdk/src/types/items.types.ts`.
- Modify `packages/sdk/src/types/documents.types.ts` only for an optional observed field; do not claim it is documented.
- Modify `packages/sdk/src/cache/types.ts`.
- Modify `packages/sdk/src/cache/sqlite-cache.service.ts`.
- Modify `packages/sdk/src/cache/postgres-cache.service.ts`.
- Modify `packages/sdk/src/cache/__tests__/sqlite-cache.service.test.ts`.
- Add or extend the narrowest existing PostgreSQL schema test surface; do not introduce a fake database abstraction.

## Implementation Steps

1. Write migration tests first: open a v3 SQLite fixture with representative rows, initialize the service, and assert version 4, preserved data, and `NULL` item/document archive values.
2. Add row/wire types using `0 | 1 | null` cache semantics and optional booleans at wire boundaries.
3. Add `archived` to item/document column arrays, fresh-schema DDL, SQLite v4 migration, and archive indexes.
4. Add PostgreSQL item/document migration helpers and indexes; keep `ensureSchema()` reruns idempotent.
5. Extend upsert generation or the item/document statements with a tested null-preserving update expression; avoid changing unrelated column behavior.
6. Test new row insertion, explicit `0 -> 1` and `1 -> 0` updates, `NULL` preservation, fresh schema, repeat migration, and backend value coercion.

## Todo

- [x] Add failing SQLite v3-to-v4 migration coverage.
- [x] Define tri-state row contracts.
- [x] Add SQLite and PostgreSQL columns/indexes.
- [x] Preserve known values across null writes.
- [x] Verify migration idempotency and data preservation.

## Success Criteria

- [x] Existing rows and payment tables survive migration unchanged.
- [x] New unknown values are SQL `NULL`, never implicit active.
- [x] Both backends return equivalent numeric/null values.
- [x] Re-running schema initialization makes no further changes or errors.

## Risk Assessment

- Defaulting new columns to `0` would corrupt meaning. Mitigation: nullable DDL and migration assertions.
- Generic upsert changes could affect unrelated fields. Mitigation: scope null preservation to archive columns and run cache regression tests.
- PostgreSQL lacks a schema version. Mitigation: idempotent DDL plus repeat-initialization integration coverage.

## Security Considerations

No credential or authorization changes. Fixtures must contain synthetic IDs only; never copy production records or connection strings.

## Next Steps

Phase 2 maps every existing writer into the contract.

## Unresolved Questions

None.
