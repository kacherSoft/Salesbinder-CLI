---
title: Coolify Scheduler Deployment Research
created_at: 2026-09-04 22:11:05 +07
scope: SalesBinder CLI Coolify app plus scheduled cache sync
status: done
---

# Coolify Scheduler Deployment Research

## Summary

Actual deployed path supersedes the initial Nixpacks recommendation below: Coolify application `s0gcsk404kso88sc48s88wok` builds the repository `Dockerfile`, pins reviewed commit `f41159cb1fceed772b60eb7a43bdbdf37ac331b7`, has no domain or HTTP health check, and runs with `SALESBINDER_SCHEDULER_DISABLED=true` until credential/canary gates pass. Nixpacks was rejected after its generated build artifact contained an invalid `null` field and failed before image creation.

The repository Dockerfile now owns the security/runtime contract: digest-pinned Node 22.23.2, production-only dependencies, non-root process, root-owned application files, atomic environment-to-config bootstrap, and a startup probe that loads compiled CLI/SDK code and exercises `better-sqlite3` in memory. The deployed container emitted both expected pre-canary markers and is running.

The installed Coolify version is `4.0.0-beta.463`. Its application scheduled-task REST routes return `404`, so the REST examples later in this research note are not executable on the current server. Use the supported task interface for that version or a separately authorized Coolify upgrade. The durable current procedure is [docs/deployment.md](../../../docs/deployment.md).

The background-container model remains necessary because Coolify tasks are container-scoped: they execute commands only while the application is running. A pure one-shot CLI container would exit and scheduled tasks would skip or fail.

## Evidence Checked

- Repo root: `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI`
- Git main/local remote commit at research start was the pre-feature baseline; deployment must resolve and record the final reviewed `origin/main` commit instead of reusing that stale value.
- Repo is Node `>=20`, pnpm `>=8`, workspace packages under `packages/*`.
- No Dockerfile, Compose file, or `nixpacks.toml` found.
- Root scripts: `pnpm build`, `pnpm test`, `pnpm lint`.
- CLI bin: `packages/cli/dist/cli.js`; package bin name `salesbinder`.
- Current config loader reads only `${HOME}/.salesbinder/config.json`; it does not read SalesBinder account credentials directly from env vars.
- Local `.env` contains `SALESBINDER_DB_URL`, `COOLIFY_MONITOR_BASE_URL`, `COOLIFY_MONITOR_API_TOKEN`; no SalesBinder v2/v3 credential env keys observed.
- Local `~/.salesbinder/config.json` has account `phuthaitech`, subdomain `phuthaitech`, v2 key present, v3 key absent.
- Coolify read-only live state:
  - Project `PHUTHAITECH`: `rkk8w40ck08o08cskg8s04g4`
  - Environment `dev`: `m0s88c8oswkkws0wcgogg0ws`
  - Servers: `localhost` `tg8wwksc8cc8480g0okcoks4`; `Linux4Game` `qgkog0cgcwscsw884o4ocgo4`
  - No existing application tagged `salesbinder`.
  - Existing related resources include `Salesbinder Cache DB`, `SalesBinder Webhook Ledger DB`, `SalesBinder Webhook Ledger Service`, and `SalesBinder Webhook Ledger Migrations`.

## Official Coolify Sources

- API requests: `https://next.coolify.io/docs/api/making-requests`
- API authorization/permissions: `https://next.coolify.io/docs/api/authorization`, `https://next.coolify.io/docs/api/permissions`
- Create public application: `https://next.coolify.io/docs/api/endpoints/applications/create-public-application`
- Create private GitHub App application: `https://next.coolify.io/docs/api/endpoints/applications/create-private-github-app-application`
- Application env create/bulk update: `https://next.coolify.io/docs/api/endpoints/applications/create-env-by-application-uuid`, `https://next.coolify.io/docs/api/endpoints/applications/update-envs-by-application-uuid`
- Deploy endpoint: `https://next.coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid`
- CLI deploy workflow: `https://next.coolify.io/docs/cli/deploy-applications`
- CLI scheduled task create: `https://next.coolify.io/docs/cli/command-reference/commands/app/task-create`
- Scheduled task behavior/history: `https://next.coolify.io/docs/core/automation/scheduled-tasks/overview`, `https://next.coolify.io/docs/core/automation/scheduled-tasks/manage-tasks`, `https://next.coolify.io/docs/core/automation/scheduled-tasks/execution-history`
- Cron syntax: `https://next.coolify.io/docs/core/automation/cron-syntax`
- Health checks: `https://next.coolify.io/docs/applications/configuration/health-checks`
- Official upstream OpenAPI: `https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml`
- Coolify changelog: `https://coolify.io/changelog`

## Recommended Deployment Spec

> Historical research only. The deployed Dockerfile configuration and [durable deployment guide](../../../docs/deployment.md) replace this Nixpacks/start-command draft. Do not use the draft `config:init` command because secrets would be placed in process arguments.

Use Coolify application, not service, unless you decide to commit a Compose file. Minimal application fields:

```json
{
  "project_uuid": "rkk8w40ck08o08cskg8s04g4",
  "environment_uuid": "m0s88c8oswkkws0wcgogg0ws",
  "server_uuid": "tg8wwksc8cc8480g0okcoks4",
  "git_repository": "https://github.com/kacherSoft/Salesbinder-CLI",
  "git_branch": "main",
  "git_commit_sha": "<final-reviewed-origin-main-sha>",
  "build_pack": "nixpacks",
  "name": "SalesBinder CLI Scheduler",
  "description": "Runs scheduled SalesBinder cache sync commands in PHUTHAITECH dev.",
  "ports_exposes": "3000",
  "domains": "",
  "autogenerate_domain": false,
  "health_check_enabled": false,
  "install_command": "pnpm install --frozen-lockfile",
  "build_command": "pnpm build",
  "start_command": "sh -lc 'if [ ! -f \"$HOME/.salesbinder/config.json\" ]; then node packages/cli/dist/cli.js config:init --account-name phuthaitech --subdomain \"$SALESBINDER_SUBDOMAIN\" --api-key \"$SALESBINDER_API_KEY\" --v3-api-key \"$SALESBINDER_V3_API_KEY\"; fi; tail -f /dev/null'",
  "is_auto_deploy_enabled": false,
  "instant_deploy": false,
  "tags": ["salesbinder", "scheduler", "phuthaitech"]
}
```

Notes:

- `localhost` recommended because most related PHUTHAITECH resources are running there and the server proxy is healthy. Use `Linux4Game` only if you intentionally want the sync worker on `110.172.29.137`.
- `ports_exposes` is retained because Coolify app/CLI workflows expect an exposed port, but no domain is generated and health is disabled because the process is CLI-only and does not listen on HTTP.
- `start_command` is intentionally idempotent for restarts: it creates config only if missing, then idles.
- This still needs `SALESBINDER_V3_API_KEY`; current `cache sync` requires v3 key for inventory/category snapshots.

## Required Coolify Env Keys

Set these as Coolify application env vars/secrets:

```text
SALESBINDER_SUBDOMAIN=phuthaitech
SALESBINDER_API_KEY=<salesbinder-v2-api-key>
SALESBINDER_V3_API_KEY=<salesbinder-v3-bearer-key>
SALESBINDER_DB_URL=<postgres-cache-url>
SALESBINDER_CHANGE_FEED_DB_URL=<postgres-ledger-url-if-feed-mode-required>
SALESBINDER_READ_BACKEND=postgresql
```

Optional:

```text
SALESBINDER_CACHE_STALE_SECONDS=3600
SALESBINDER_RETRY_INITIAL_DELAY_MS=1000
```

Do not put secret values in shell history or repo files. Use Coolify env UI, API, or CLI with a secure secret source.

## REST Commands

> Historical API examples. Application/env/deploy endpoints were validated; scheduled-task endpoints return `404` on Coolify `4.0.0-beta.463` and must not be treated as available there.

Base:

```bash
export COOLIFY_URL="https://coolify.kachersoft.io.vn"
export COOLIFY_TOKEN="<write-or-root-token>"
```

Create application:

```bash
curl --fail-with-body -X POST "$COOLIFY_URL/api/v1/applications/public" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data '{
    "project_uuid": "rkk8w40ck08o08cskg8s04g4",
    "environment_uuid": "m0s88c8oswkkws0wcgogg0ws",
    "server_uuid": "tg8wwksc8cc8480g0okcoks4",
    "git_repository": "https://github.com/kacherSoft/Salesbinder-CLI",
    "git_branch": "main",
    "git_commit_sha": "<final-reviewed-origin-main-sha>",
    "build_pack": "nixpacks",
    "name": "SalesBinder CLI Scheduler",
    "ports_exposes": "3000",
    "domains": "",
    "autogenerate_domain": false,
    "health_check_enabled": false,
    "install_command": "pnpm install --frozen-lockfile",
    "build_command": "pnpm build",
    "start_command": "sh -lc '\''if [ ! -f \"$HOME/.salesbinder/config.json\" ]; then node packages/cli/dist/cli.js config:init --account-name phuthaitech --subdomain \"$SALESBINDER_SUBDOMAIN\" --api-key \"$SALESBINDER_API_KEY\" --v3-api-key \"$SALESBINDER_V3_API_KEY\"; fi; tail -f /dev/null'\''",
    "is_auto_deploy_enabled": false,
    "instant_deploy": false,
    "tags": ["salesbinder", "scheduler", "phuthaitech"]
  }'
```

Bulk env update after app creation:

```bash
export APP_UUID="<created-application-uuid>"

curl --fail-with-body -X PATCH "$COOLIFY_URL/api/v1/applications/$APP_UUID/envs/bulk" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data '{
    "data": [
      {"key":"SALESBINDER_SUBDOMAIN","value":"phuthaitech","is_literal":true,"is_shown_once":true},
      {"key":"SALESBINDER_API_KEY","value":"<salesbinder-v2-api-key>","is_literal":true,"is_shown_once":true},
      {"key":"SALESBINDER_V3_API_KEY","value":"<salesbinder-v3-bearer-key>","is_literal":true,"is_shown_once":true},
      {"key":"SALESBINDER_DB_URL","value":"<postgres-cache-url>","is_literal":true,"is_shown_once":true},
      {"key":"SALESBINDER_CHANGE_FEED_DB_URL","value":"<postgres-ledger-url-if-needed>","is_literal":true,"is_shown_once":true},
      {"key":"SALESBINDER_READ_BACKEND","value":"postgresql","is_literal":true}
    ]
  }'
```

Deploy exact pinned commit:

```bash
curl --fail-with-body -X POST "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID&force=true" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

Check deployment:

```bash
export DEPLOYMENT_UUID="<deployment-uuid-from-deploy-response>"

curl --fail-with-body "$COOLIFY_URL/api/v1/deployments/$DEPLOYMENT_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

Create scheduled task:

```bash
curl --fail-with-body -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/scheduled-tasks" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "salesbinder-cache-sync",
    "command": "node packages/cli/dist/cli.js --account phuthaitech cache sync",
    "frequency": "*/15 * * * *",
    "timeout": 3600,
    "enabled": true
  }'
```

Run scheduled task now:

```bash
export TASK_UUID="<created-task-uuid>"

curl --fail-with-body -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/scheduled-tasks/$TASK_UUID/execute" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

List scheduled tasks:

```bash
curl --fail-with-body "$COOLIFY_URL/api/v1/applications/$APP_UUID/scheduled-tasks" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

List execution history:

```bash
curl --fail-with-body "$COOLIFY_URL/api/v1/applications/$APP_UUID/scheduled-tasks/$TASK_UUID/executions" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

Check app logs:

```bash
curl --fail-with-body "$COOLIFY_URL/api/v1/applications/$APP_UUID/logs?lines=100&show_timestamps=true" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"
```

## Coolify CLI Commands

Official CLI workflow equivalent:

```bash
coolify context verify
coolify project list
coolify server list

coolify app create public \
  --server-uuid tg8wwksc8cc8480g0okcoks4 \
  --project-uuid rkk8w40ck08o08cskg8s04g4 \
  --environment-name dev \
  --git-repository https://github.com/kacherSoft/Salesbinder-CLI \
  --git-branch main \
  --build-pack nixpacks \
  --ports-exposes 3000 \
  --name "SalesBinder CLI Scheduler" \
  --build-command "pnpm build" \
  --start-command "sh -lc 'if [ ! -f \"$HOME/.salesbinder/config.json\" ]; then node packages/cli/dist/cli.js config:init --account-name phuthaitech --subdomain \"$SALESBINDER_SUBDOMAIN\" --api-key \"$SALESBINDER_API_KEY\" --v3-api-key \"$SALESBINDER_V3_API_KEY\"; fi; tail -f /dev/null'"

coolify app env sync <application-uuid> --file <secure-dotenv-file-not-in-repo>
coolify deploy uuid <application-uuid> --force
coolify deploy get <deployment-uuid>
coolify app get <application-uuid>
coolify app logs <application-uuid> --lines 100 --show-timestamps

coolify app task create <application-uuid> \
  --name salesbinder-cache-sync \
  --command "node packages/cli/dist/cli.js --account phuthaitech cache sync" \
  --frequency "*/15 * * * *" \
  --timeout 3600 \
  --enabled true
```

CLI docs expose create/update/list/delete task commands. For manual run/history, REST endpoint is currently the more exact route from official OpenAPI.

## Health Strategy

Use `health_check_enabled=false` for the CLI scheduler app.

Reason:

- The container does not expose a real HTTP service.
- Coolify health checks are optional.
- HTTP checks require `curl` or `wget` inside the final image and a listening endpoint.
- Traefik removes unhealthy containers from routing when health checks are enabled.
- This app has no domain and no user traffic; liveness is proven by container status plus scheduled task execution history.

Operational health checks:

- Container status is `running`.
- First manual task execution is `success`.
- `cache status` task or manual command reports `sync_status` not `failed`.
- Coolify scheduled-task history has recent successful execution.
- Coolify notifications should enable scheduled task failure events.

Optional second task:

```json
{
  "name": "salesbinder-cache-status",
  "command": "node packages/cli/dist/cli.js --account phuthaitech cache status",
  "frequency": "hourly",
  "timeout": 300,
  "enabled": true
}
```

## Minimal Idle Container vs Cron/Service Design

| Option                              | Pros                                                                                                                               | Cons                                                                              | Verdict                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| Minimal idle Coolify app            | Fewest repo changes, uses built-in task history/notifications, no Docker socket, no host cron, exact commit pinning, easy rollback | Keeps one idle container running; config file created at startup from env secrets | Recommended now                               |
| Dockerfile app with tiny idle image | More deterministic image, can add `HEALTHCHECK CMD test -f ...`, smaller runtime if optimized                                      | Requires repo change; must maintain Dockerfile/pnpm workspace pruning             | Good next hardening step                      |
| Docker Compose service/cron         | Can model worker explicitly, multi-container health/storage better                                                                 | Requires Compose creation as service, more moving parts, maybe shared file edits  | Use only if adding queue/webhook worker stack |
| Host cron calling `docker exec`     | No idle application design constraints                                                                                             | Outside Coolify UI/history/notifications; host coupling; harder audit             | Not recommended                               |
| Container-internal cron             | Self-contained                                                                                                                     | Duplicates Coolify scheduler, weak run history, harder failure surfacing          | Not recommended                               |

## Risks

- Hard blocker before real sync: `SALESBINDER_V3_API_KEY` must be available. Current local config lacks it, and `cache sync` exits before cache mutation when v3 key missing.
- The current monitor token may not have write/deploy permission. Official docs require token permissions selected during creation; write endpoints need `write`, deploy endpoints need `deploy`, or use `root`.
- The `.env` file is not safe to shell-source; parse it as dotenv data or use Coolify secret store directly.
- Scheduled task commands run inside the current running container; if the app is stopped, unhealthy, or container name changes in a multi-container resource, execution skips/fails.
- Scheduled task overlap policy is not clearly documented in official current docs. Use a frequency longer than worst-case sync runtime or rely on the CLI/PostgreSQL advisory lock, which already fails concurrent sync attempts.
- Commands longer than practical DB/UI limits are risky; keep scheduled task command short. The recommended command is short.

## Exit Criteria

- Application exists in PHUTHAITECH dev with `git_commit_sha=d3f2947661a7ff461ff8f59f2d1ca581ba62f1de`, `build_pack=nixpacks`, no domain, health check disabled.
- Deployment created by API/CLI finishes successfully and deployment detail reports the pinned commit.
- App container is `running`.
- Coolify app env keys exist; secret values are not printed in logs.
- Startup config file exists inside container with 0600 permissions and account `phuthaitech`.
- Manual scheduled task execution queues and reaches `success`.
- Execution history endpoint returns the success record.
- `cache status` reports PostgreSQL backend and acceptable sync health.
- Next scheduled run occurs in the target server timezone and records success.

## Unresolved Questions

- Which server should own this scheduler long-term: `localhost` or `Linux4Game`? Recommendation: `localhost` unless isolating PHUTHAITECH sync workload is desired.
- Where is the SalesBinder v3 bearer key stored? It is required for current `cache sync`.
- Is `SALESBINDER_CHANGE_FEED_DB_URL` mandatory for this deployment phase, or should the scheduler run compatibility PostgreSQL sync only?
