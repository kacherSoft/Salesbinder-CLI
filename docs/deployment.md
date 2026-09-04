# Deployment

## Platform

The production cache-sync runner is a background Coolify application. It has no public URL and must not expose an HTTP domain.

- Application: `SalesBinder CLI Scheduler`
- Application UUID: `s0gcsk404kso88sc48s88wok`
- Project/environment: `PHUTHAITECH` / `dev`
- Source: `kacherSoft/Salesbinder-CLI`, branch `main`
- Build pack: repository `Dockerfile`
- First verified runtime commit: `f41159cb1fceed772b60eb7a43bdbdf37ac331b7`
- Health: Coolify container state plus constant startup markers; HTTP health checks are disabled

The image uses a digest-pinned Node 22 base, installs production dependencies separately, runs as the unprivileged `node` user, and keeps `/app` root-owned. Startup fails before idling if the compiled CLI/SDK or native `better-sqlite3` runtime cannot load.

## Environment

Store values in Coolify; never commit them or pass secret values as command arguments.

```text
SALESBINDER_ACCOUNT_NAME
SALESBINDER_SUBDOMAIN
SALESBINDER_API_KEY
SALESBINDER_V3_API_KEY
SALESBINDER_DB_URL
SALESBINDER_CHANGE_FEED_DB_URL
SALESBINDER_READ_BACKEND=postgresql
```

`SALESBINDER_API_KEY` is the v2 credential for accounts/documents. `SALESBINDER_V3_API_KEY` is mandatory for inventory/categories; there is no v2 fallback. The change-feed URL must use the ledger worker role, not receiver or migration credentials.

Before credentials and canary validation are complete, set:

```text
SALESBINDER_SCHEDULER_DISABLED=true
```

This is the only supported credential-less startup. When enabling the scheduler, remove that variable or set it to `false`; startup then fails closed unless every required SalesBinder credential is nonblank. The bootstrap writes `/home/node/.salesbinder/config.json` atomically with mode `0600` and never logs values.

## Release Gates

1. Verify current cache and ledger backups succeeded.
2. Deploy an exact reviewed `main` commit and confirm both startup markers:
   - `SalesBinder container runtime verified.`
   - `SalesBinder config initialized.` (enabled) or `SalesBinder scheduler is explicitly disabled.` (pre-canary)
3. Run `cache status`; account, cache, ledger, consumer, and schema bindings must agree.
4. Run one manual `cache sync` against a fixed ledger target. A read-only credential is sufficient when an existing real inventory event is available; do not mutate business data without separate authorization.
5. Verify cache receipt, ledger completion, zero blocker at or below the target, and unchanged unrelated document events.
6. Enable incremental sync every 15 minutes. Advisory locking safely rejects overlap, but frequency should still exceed normal runtime.
7. Enable a weekly `cache sync --full` reconciliation until webhook delivery coverage is proven.

Coolify `4.0.0-beta.463` does not expose the application scheduled-task REST routes (they return `404`). Configure the two tasks through a supported Coolify task interface for that server version, or upgrade Coolify in a separately authorized maintenance window. Do not write directly to Coolify's internal database.

## Commands

```bash
# Normal fixed-target event drain
node packages/cli/dist/cli.js --account phuthaitech cache sync

# Periodic reconciliation
node packages/cli/dist/cli.js --account phuthaitech cache sync --full

# Operational status
node packages/cli/dist/cli.js --account phuthaitech cache status
```

## Rollback

1. Disable scheduled tasks before changing application versions.
2. Keep webhook receiver ingestion and immutable ledger history running.
3. Roll the Coolify application back to the previous known image/commit.
4. Preserve cache receipts, staging rows, event state, and ledger cursors.
5. If cache authority is uncertain, restore the verified pre-cutover cache backup or run an explicit clean V3 full reconciliation before declaring freshness.
6. Re-enable incremental processing only after status verifies bindings and unapplied events replay idempotently.

## Maintenance

- Refresh the pinned Node image digest after upstream security rebuilds and run a container vulnerability scan.
- Run `pnpm audit --prod`, `pnpm test`, `pnpm lint`, and `pnpm build` before deployment.
- Alert on receiver inactivity, oldest pending event age, blocker cursor, repeated `429`, lock loss, failed scheduled tasks, and baseline age.
