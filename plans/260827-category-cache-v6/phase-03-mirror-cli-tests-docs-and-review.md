---
phase: 3
title: "Mirror, CLI, Tests, Docs, and Review"
status: complete
priority: P1
effort: "1d"
dependencies: [2]
---

# Phase 3: Mirror, CLI, Tests, Docs, and Review

## Context Links

- Plan: [Category Cache v6](./plan.md)
- Phase 2: [Category Indexing and Atomic Cache Replace](./phase-02-category-sync-and-cache-services.md)
- Mirror: `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts`
- Cache commands: `packages/cli/src/commands/cache/*`
- Checkpoint store: `packages/cli/src/commands/cache/full-resume-checkpoint.ts`

## Overview

Finish operator-visible integration. Mirror categories atomically, preserve PG binding on clear, expose typed status/output, invalidate stale checkpoints, update docs, and run focused tests plus review.

## Key Insights

- Mirror write failure must preserve old SQLite categories, category meta, item names, and stock names.
- Invalid or uninitialized PG category authority during full mirror clears target SQLite category rows/meta/marker, marks category authority uninitialized, copies PG item/stock names unchanged, and skips reconciliation.
- v6 `cache clear` physically deletes category rows/meta/marker on SQLite and PostgreSQL; PostgreSQL preserves only immutable `cache_account_binding`.
- Full-resume v5 checkpoints are stale because v6 adds a required categories-before-items phase and category generation marker.
- v6 status/output reads typed snapshot JSON from stable `category_cache_meta` key and confirms generation against legacy `cache_meta` marker plus `cache_meta.state.schemaVersion === 6`.
- Backend open, `ensureSchema`, read, and status are non-mutating for category marker; status/output fail closed on state schema mismatch or generation mismatch.

## Requirements

- Functional: extend `SQLiteMirrorSnapshot` with categories and typed category snapshot JSON.
- Functional: mirror replacement is atomic across all mirrored tables and category reconciliation, but category data is authoritative only when typed meta is complete, generation marker valid, and `cache_meta.state.schemaVersion === 6`.
- Functional: during full mirror from PG with invalid/uninitialized category authority, clear target SQLite `categories`, `category_cache_meta`, and generation marker; mark category authority uninitialized; copy PG item/stock names unchanged; skip category reconciliation; never retain old local category snapshot.
- Functional: v6 clear on SQLite and PostgreSQL physically deletes `categories`, `category_cache_meta`, and `cache_meta.category_cache.v6.generation`; PostgreSQL preserves only `cache_account_binding`.
- Functional: `cache status` and sync output report category count, status, completion timestamp, schema version, generation, and fingerprint summary through typed APIs when authority is valid.
- Functional: status/output tests cover stale rows/meta/marker with state version 5, non-mutating open/read/status, later account/document state write to schema version 6 through `setCacheState`, stale marker invalidation there, and still-uninitialized category state.
- Functional: full-resume checkpoint version/fingerprint changes on category capability/generation and fails closed for v5 checkpoints.
- Functional: mirror/clear/resume tests updated for old-state preservation and binding retention.
- Non-functional: implementation phase still adds no scripts and performs no staging/commit/push without separate instruction.

## Architecture

```text
PostgreSQL complete category snapshot
  -> read categories + category_cache_meta snapshot JSON by typed API
  -> require complete meta + matching cache_meta generation marker + cache_meta.state.schemaVersion 6
  -> SQLiteMirrorSnapshot includes authoritative category rows/meta
  -> SQLite replaceMirror() single transaction
  -> write categories/meta, reconcile items and stock names
  -> old mirror preserved on write failure after category authority is accepted
```

If PG category authority is missing, uninitialized, marker-mismatched, or state schema version is not 6, full mirror must clear target SQLite category rows/meta/marker, mark uninitialized by absence of authoritative marker/meta, preserve PG item/stock snapshot names as received, and skip reconciliation from stale rows. Do not retain old local category snapshot.

CLI output contract is additive:

```json
{
  "categories": {
    "status": "complete",
    "count": 123,
    "completedAt": 1798320000,
    "schemaVersion": 6,
    "generation": 4,
    "fingerprint": "sha256:..."
  }
}
```

If category meta is absent, marker mismatch, or `cache_meta.state.schemaVersion !== 6`, count can report physical rows separately only with an explicit non-authoritative label. Do not present stale rows as complete.

## Related Code Files

- Modify: `packages/sdk/src/cache/cache.interface.ts` - mirror snapshot category fields and typed status API.
- Modify: `packages/sdk/src/cache/pg-to-sqlite-sync.service.ts` - shared mirror caller/orchestration; owned by Lead.
- Modify: `packages/sdk/src/cache/sqlite-cache.service.ts` - mirror replacement and clear backend implementation; owned by B.
- Modify: `packages/sdk/src/cache/postgres-cache.service.ts` - typed snapshot read and clear readers preserving binding; owned by C.
- Modify: `packages/cli/src/commands/cache/cache.commands.ts` and related files - categories phase, status, clear, output; owned by Lead with CLI tests.
- Modify: `packages/cli/src/commands/cache/full-resume-checkpoint.ts` and tests - version/fingerprint invalidation; owned by Lead.
- Modify: `README.md` and owning docs discovered during implementation.
- Modify/Create: Lead owns mirror integration, CLI, resume, and output tests; B owns SQLite backend atomicity/clear tests; C owns PG backend clear/read tests.
- Delete: none.

## Implementation Steps

1. Lead extends mirror snapshot types and calls PG readers for exact category rows and typed `category_cache_meta` JSON.
2. B updates SQLite mirror backend replacement so categories/meta/reconciliation join the existing single transaction.
3. B adds backend atomicity tests proving old categories/meta/item names/stock names survive injected category/meta/reconcile failure.
4. Lead implements mirror caller behavior for invalid PG category authority: clear target SQLite category rows/meta/marker, mark uninitialized, copy PG item/stock names unchanged, skip reconciliation, and never retain old local category snapshot.
5. B/C implement v6 clear backend semantics: delete category rows/meta/marker; PG preserves only `cache_account_binding`. Tests assert zero category/category_meta rows after clear.
6. Lead updates status/output to use typed snapshot JSON plus marker plus `cache_meta.state.schemaVersion === 6` and mark absent/mismatched/version-5 rows non-authoritative without mutating marker.
7. Lead adds integration test that stale rows/meta/marker plus state version 5 survive non-mutating open/read/status; a subsequent non-category `setCacheState` transition to schema version 6 invalidates marker but does not reauthorize category cache.
8. Lead adds SQLite and PostgreSQL interleaving tests proving a concurrent successful category snapshot cannot have its marker deleted from stale observation.
9. Lead adds PG tests proving binding mismatch and populated-unbound DB state transition perform zero mutation.
10. Lead bumps full-resume checkpoint version/fingerprint for category capability/generation/schema authority and rejects v5 checkpoints with reset guidance.
11. Add resume tests proving categories phase evidence precedes item evidence and stale v5 checkpoints cannot skip categories.
12. Update README/docs for exact schemas, full snapshot every sync, PG binding, v6 clear deletion, v5 rollback leftovers, mirror/status behavior, rollback/re-upgrade.
13. Run focused SDK/CLI tests, SDK/CLI builds, then broad tests if focused gates pass.
14. Run code review and fix correctness findings before completion.

## Todo List

- [x] Mirror snapshot includes exact category rows and typed complete JSON meta only when marker and state schema authority are valid.
- [x] Mirror write failure after accepted authority preserves old categories/meta/item names/stock names.
- [x] Invalid PG category authority during full mirror clears target SQLite category rows/meta/marker and preserves PG item/stock names unchanged.
- [x] v6 `cache clear` deletes category rows/meta/marker and preserves only PG binding; tests assert zero category/meta rows.
- [x] Status/output expose typed category state.
- [x] Read/status initialization tests prove marker is not mutated outside write paths.
- [x] `setCacheState` transition tests prove stale marker invalidation happens only inside serialized state transition and is not reversed into category authority.
- [x] SQLite and PostgreSQL interleaving tests prove fresh category marker is not deleted from stale observation.
- [x] PG mismatch/unbound populated DB state transition makes zero mutation.
- [x] Full-resume checkpoint v6 invalidates stale v5 state.
- [x] Mirror, clear, resume, output tests updated.
- [x] README/docs updated; no scripts added.
- [x] Focused tests, builds, broad tests, and review complete.

## Success Criteria

- [x] PG-to-SQLite mirror cannot leave a partial category snapshot or partially reconciled item/stock names.
- [x] Clear cannot unbind a PostgreSQL DB from its SalesBinder account.
- [x] Re-upgrade after v5 rollback treats stale category rows/meta/marker with state schema version 5 as uninitialized until successful v6 snapshot writes marker, typed meta, and state schema version 6.
- [x] Operators can distinguish complete vs uninitialized category cache state from JSON output.
- [x] All planned validation gates pass before implementation closeout.

## Risk Assessment

Main risk: status output accidentally treats physical stale rows as authoritative. Mitigation: output is driven by typed snapshot JSON plus matching `cache_meta.category_cache.v6.generation` marker and `cache_meta.state.schemaVersion === 6`.

Rollback: keep new output additive. If v6 is rolled back and later re-applied, stale rows are non-authoritative until a v6 snapshot completes and atomically writes marker, typed meta, and state schema version 6.

## Security Considerations

Do not expose DB URL, API key, local cache path, or private raw payloads in status/errors/docs. Binding mismatch output gives operator action without secrets.

## Next Steps

After review passes, report docs impact and validation results. Commit/push only if separately requested.
