# Deployment

## Platform

The approved cache-sync runner is a private monorepo package deployed as a separate Coolify application. It has no public URL and must not expose an HTTP domain.

- Application: `SalesBinder CLI Scheduler`
- Application UUID: `s0gcsk404kso88sc48s88wok`
- Project/environment: `PHUTHAITECH` / `dev`
- Source: `kacherSoft/Salesbinder-CLI`, branch `main`
- Build pack: repository `Dockerfile`
- First verified runtime commit: `f41159cb1fceed772b60eb7a43bdbdf37ac331b7`
- Health: Coolify container state plus constant startup markers; HTTP health checks are disabled

The current Coolify application is still disabled on the first verified runtime image. The official-V3 scheduler described below is the next reviewed release contract; it is not deployed until its commit reaches `main` and the canary gates pass.

The image uses a digest-pinned Node 22 base, installs production dependencies separately, runs as the unprivileged `node` user, and keeps `/app` root-owned. Startup fails before idling if the compiled CLI/SDK or native `better-sqlite3` runtime cannot load.

## Environment

Store values in Coolify; never commit them or pass secret values as command arguments.

```text
SALESBINDER_ACCOUNT_NAME
SALESBINDER_SUBDOMAIN
SALESBINDER_V3_API_KEY
SALESBINDER_DB_URL
SALESBINDER_READ_BACKEND=postgresql
SALESBINDER_V3_SYNC_INITIAL_SINCE
SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS=300
SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS=86400
```

Official incremental polling requires account name, subdomain, V3 key, cache PostgreSQL URL, and PostgreSQL read mode. It neither requires nor receives `SALESBINDER_CHANGE_FEED_DB_URL`. Reference refresh reads V3 customers, prospects, suppliers, and categories. `SALESBINDER_API_KEY` is optional and adds its explicit V2 users-directory portion; it is never an automatic fallback from V3.

`SALESBINDER_V3_SYNC_INITIAL_SINCE` is consumed only when official status is `null`. Use a non-future timestamp inside the 90-day source retention window that belongs to this account's verified initialization. The PHUTHAITECH production boundary is `1788670542` (the original scan start), not a later repair time. Once durable state exists, the scheduler never reuses a fixed `--since`.

`SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS` defaults to `300`, accepts `60`–`604800`, and also accepts the relative presets `daily` and `weekly`. Use seconds for exact X-minute intervals. `SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS` defaults to `86400`; `0` or `disabled` turns reference refresh off. The runner supplies the enabled interval to `sync-references --if-stale`; durable last-attempt time throttles attempts, while resource last-success time remains the freshness signal. Poll cadence is separate from execution timeout: one healthy run may cross ticks, and missed ticks coalesce without overlap or backlog.

Before credentials and canary validation are complete, set:

```text
SALESBINDER_SCHEDULER_DISABLED=true
```

This is the only supported credential-less startup. When enabling the runner, set `SALESBINDER_SCHEDULER_DISABLED=false` exactly; any other value keeps the container in disabled keepalive mode. Startup then fails closed unless the V3-only requirements above are valid. The bootstrap writes `/home/node/.salesbinder/config.json` atomically with mode `0600`, permits the V2 key to remain absent, and never logs values.

Each cycle reads `cache sync-v3 --status`, then initializes null state, resumes incomplete/warning state (including its expected cursor gap), or polls clean applied-cursor state. Malformed/unreadable state, an inconsistent clean-success gap, expired history, or changed permissions requires reconciliation and never causes an automatic reset. PostgreSQL advisory locking rejects another writer as a safe skipped cycle. Legacy `cache status`, normal `cache sync`, the webhook ledger, and automatic weekly `--full` do not drive this runner.

Official polling covers `item`, `invoice`, `estimate`, and `purchase_order` only. Reference data and payment history have separate status and workflows; a clean official cursor is not a complete-cache claim. Do not add automatic weekly full sync until a ledger-free resumable baseline exists. A cold baseline must capture `start=now` before complete enumeration, publish only verified authority, then replay the saved cursor.

## Release Gates

1. Verify the current cache backup succeeded; preserve any ledger independently if other workflows still use it.
2. Deploy an exact reviewed `main` commit and confirm both startup markers:
   - `SalesBinder container runtime verified.`
   - `SalesBinder config initialized.` (enabled) or `SalesBinder scheduler is explicitly disabled.` (pre-canary)
3. Run `cache sync-v3 --status`; verify account binding and select exactly one expected action: initialize, resume, or clean poll.
4. Confirm the configured initialization boundary before the first null-state run. Never set a fresh boundary to bypass existing or reconciliation-required state.
5. Run one controlled read-only official poll/resume and verify task counts, cursor gap, warnings, and writer-lock behavior. Do not mutate SalesBinder business data without separate authorization.
6. Keep the 300-second default until measured duration/rate evidence supports 60 seconds. Enable only this one incremental schedule and confirm no ledger access or legacy/full command appears.
7. Verify reference status separately. If V2 users refresh is intended, supply its read credential explicitly; otherwise disable or accept the documented partial reference result. Payment history remains a separate explicit job.

The live Coolify instance is `4.0.0-beta.463`; earlier scheduled-task REST probing returned `404`. [Current Coolify documentation](https://next.coolify.io/docs/core/automation/scheduled-tasks/overview) describes scheduled tasks, but the live instance/API was not revalidated. The approved path therefore remains the existing self-scheduled URL-less runner. A future native task may invoke the same one-shot dispatcher only with its internal loop disabled. Do not run both schedulers or write directly to Coolify's internal database.

## Commands

```bash
# Inspect official cursor/run/task state
node packages/cli/dist/cli.js --account phuthaitech cache sync-v3 --status

# Resume incomplete or warning work
node packages/cli/dist/cli.js --account phuthaitech cache sync-v3 --resume

# Start the next clean poll from the retained applied cursor
node packages/cli/dist/cli.js --account phuthaitech cache sync-v3

# Inspect/run the separate reference refresh
node packages/cli/dist/cli.js --account phuthaitech cache sync-references --status
node packages/cli/dist/cli.js --account phuthaitech cache sync-references --if-stale 86400
```

## Rollback

1. Set `SALESBINDER_SCHEDULER_DISABLED=true` and restart before changing application versions.
2. Keep any independently required webhook receiver/ledger workflow running; the official scheduler does not depend on it.
3. Roll the Coolify application back to the previous known image/commit.
4. Preserve official V3 state, sealed pages, tasks, receipts, and any separately owned ledger data.
5. If cache authority is uncertain, restore the verified pre-cutover cache backup or complete an approved ledger-free baseline reconciliation before declaring freshness. Never reset an expired cursor to hide the gap.
6. Re-enable incremental processing only after official status verifies binding, cursor continuity, and resumable pending work.

## Maintenance

- Refresh the pinned Node image digest after upstream security rebuilds and run a container vulnerability scan.
- Run `pnpm audit --prod`, `pnpm test`, `pnpm lint`, and `pnpm build` before deployment.
- Alert on official status/read failure, reconciliation-required state, cursor gap, warning/pending task age, repeated `429`, lock loss/busy frequency, failed runner cycles, container restarts, reference freshness, payment freshness, and baseline age.
