# Spec Compliance Review

Date: 2026-08-27
Target: pending diff on `codex/category-cache-v6`
Plan: `../plan.md`

| Requirement | Status | Evidence |
| --- | --- | --- |
| Preserve v2 accounts/documents/delta/deleted-log | PASS | CLI keeps `SalesBinderClient` for those indexers; existing resource/indexer suites pass. |
| Optional, separate v3 Bearer transport | PASS | `v3ApiKey` is optional; v3 factory uses `/api/v3`, Bearer auth, and suffix-free resources. |
| Complete archived inventory source | PASS | v3 indexer requests every item page with `archived=all`. |
| Complete category and variation/location source | PASS | Category pages and item variation pages are validated before a single backend publish; variation calls use `include=locations`. |
| Never fabricate unavailable inventory balances | PASS | v2 maps observed fields only; unavailable values are `NULL`; regression test covers the old false-zero payload. |
| Schema v7 provenance and safe migration | PASS | Both backends add source version, nullable balances, one-time API cleanup, CSV preservation; PG14/PG16 disposable migration smoke passed. |
| Atomic snapshot and fail-closed authority | PASS | SQLite/PG replace API-owned rows and metadata in one transaction; metadata readers verify schema, source, account/count evidence. |
| Preserve CSV rows and shared item identities | PASS | Both backends preserve non-conflicting CSV stock; repeated SQLite collision test now matches PostgreSQL behavior. |
| One PostgreSQL database per SalesBinder account | PASS | Existing immutable normalized subdomain binding remains required before payload writes. |
| Resume/checkpoint safety | PASS | Schema v7 invalidates old state; checkpoint v4 records category and inventory generation/fingerprint; v3 item phase is whole-snapshot atomic. |
| Public docs and status visibility | PASS | README documents hybrid sources/`NULL`; `cache status` includes category and inventory authority metadata. |
| No full CLI CRUD migration to v3 | PASS | v3 client is read-only and selected only for cache category/inventory snapshots. |

Verdict: PASS for requested scope. Formal code-quality cross-review and fresh final verification remain required before landing.

Unresolved questions: none. Cache authority is explicitly limited to configured v3 credential visibility.
