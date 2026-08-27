# Plan Complete: SalesBinder v3 Cache Source Correction

Date: 2026-08-27
Branch: `codex/category-cache-v6`
Status: completed

## Delivered

| Contract | Result |
|---|---|
| v3 source | Separate Bearer `/api/v3` client for category and inventory snapshots |
| v2 compatibility | Accounts, documents, deltas, deleted log, and CLI CRUD remain v2 |
| Archive coverage | Item list requests `archived=all` |
| Inventory detail | Variations request `include=locations`; observed balances preserved |
| Unknown values | Missing v3-only balances persist as SQL `NULL`, never fabricated zero |
| Snapshot safety | Two full content-stable reads required; publish atomic or not at all |
| Authority | Item/stock/category mutations invalidate stale inventory metadata |
| Binding | PostgreSQL one-account binding preserved; SQLite alias collisions rejected |
| Recovery | Checkpoint v4 validates category/inventory authority; legacy SQLite clear uses explicit unbound-only option |
| CSV policy | CSV stock rows/values preserved; v3 remains canonical shared-ID item master |

## Verification

| Gate | Result |
|---|---|
| SDK tests | 21 suites / 335 passed |
| CLI tests | 2 suites / 37 passed |
| Build | SDK + CLI passed |
| Lint | 0 errors; 16 baseline warnings |
| Diff check | passed |
| PostgreSQL smoke | PG14 + PG16 passed; disposable containers removed |
| Sol-high transport review | APPROVE, no findings |
| Sol-high database review | APPROVE, no findings |

## Documentation

- README updated: optional `v3ApiKey`, hybrid API ownership, schema v7, `NULL` semantics, double-read stability, checkpoint authority, durable bindings, `cache clear --force-unbound`.
- Docs impact: major.

## Unresolved Questions

None.
