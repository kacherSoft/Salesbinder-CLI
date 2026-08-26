---
date: 2026-08-26 17:30 +07
session: archived-record-cache-schema
---

# Archived Record Cache Schema

## Context

This session implemented cache schema v4 for archived state. The durable contract lives in `README.md` and `plans/260826-1336-archived-record-cache-schema/plan.md`; this note only records what changed. The archive change touched cache types/services, indexers, CSV import, README, and tests. Existing payment-sync and CLI edits in the dirty tree were preserved.

## What Happened

We made the archive state source-aware instead of guessing. Accounts kept the existing boolean contract, while items and documents moved to `0/1/NULL` so missing source data stays unknown. That decision came from the official contract gap: v3 docs do not prove archive state for documents, and `404` never means archived.

The implementation wired the tri-state through SQLite/PostgreSQL schema, CSV import, indexers, and PG→SQLite pull behavior. Payment sync metadata and payment transaction storage stayed separate so the archive work did not trample the existing invoice backfill path.

The first SQLite test attempt used Node 22 (ABI 127) against a `better-sqlite3` binary built for ABI 137. The bundled Node 24 runtime matched ABI 137, so no dependency rebuild was needed. Under that runtime, all 180 SDK tests passed; root `pnpm test`, `pnpm build`, and `pnpm lint` passed, with lint warnings only. Publishing was skipped; no external publication or AgentWiki push was made.

## Reflection

The native-module failure was a runtime selection issue, not a logic regression. Switching to the matching bundled runtime preserved the workspace and produced trustworthy cache test evidence without rebuilding dependencies.

## Decisions Made

| Decision | Why | Outcome |
|---|---|---|
| Accounts stay boolean | Existing contract already exists and does not need tri-state churn | Compatibility preserved |
| Items/documents use `0/1/NULL` | Source cannot always prove archive state | Unknown stays unknown |
| Later `NULL` never erases known state | Avoids downgrading good evidence | Null-preserving upserts |
| Preserve payment-sync edits | That work was already in the tree and not part of this scope | No collateral damage |
| Treat live PG smoke as disposable pre-release work | Unit tests do not prove live Postgres readiness | Non-blocking release gate |

## Next Steps

1. Run a disposable PostgreSQL smoke against a throwaway database before release.
2. Keep the README and plan as the contract source, not this journal.

## Unresolved Questions

None for implementation. Release engineering owns the disposable PostgreSQL smoke gate.

Publishing skipped: no external publication and no AgentWiki invocation.
