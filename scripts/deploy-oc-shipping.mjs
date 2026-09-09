#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const APP_UUID = 'boc8wkgsckk0o4084s84gkk8';
export const OLD_APP_UUID = 's0gcsk404kso88sc48s88wok';
export const PRIOR_SHA = 'dec07eb12c46aad5b51e206e8a3cf908ee4b2d1d';
export const REMOTE_REPOSITORY = 'https://github.com/kacherSoft/Salesbinder-CLI.git';
const NAME = 'SalesBinder Incremental Sync';
const REPOSITORIES = new Set([
  REMOTE_REPOSITORY,
  'kacherSoft/Salesbinder-CLI',
  'kacherSoft/Salesbinder-CLI.git',
]);
const ACTIVE_STATUSES = new Set([
  'queued',
  'pending',
  'initializing',
  'starting',
  'building',
  'in_progress',
  'running',
]);
const EXPECTED_ENV = {
  false: {
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: '300',
    SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'cycle',
    SALESBINDER_SCHEDULER_TIMEZONE: 'Asia/Ho_Chi_Minh',
    SALESBINDER_SCHEDULER_DAYS: '1,2,3,4,5,6',
    SALESBINDER_SCHEDULER_START_HOUR: '7',
    SALESBINDER_SCHEDULER_END_HOUR: '22',
  },
  true: {
    SALESBINDER_SCHEDULER_DISABLED: 'true',
    SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: '300',
    SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'cycle',
    SALESBINDER_SCHEDULER_TIMEZONE: 'Asia/Ho_Chi_Minh',
    SALESBINDER_SCHEDULER_DAYS: '1,2,3,4,5,6',
    SALESBINDER_SCHEDULER_START_HOUR: '7',
    SALESBINDER_SCHEDULER_END_HOUR: '22',
  },
};

function fail(code) {
  throw new Error(code);
}
function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}
function validDeployment(value) {
  return typeof value === 'string' && /^[a-z0-9-]{8,80}$/i.test(value);
}

export function parseArguments(argv) {
  const valueFlags = new Set(['--sha', '--deployment', '--configuration-hash']);
  const booleanFlags = new Set([
    '--dry-run',
    '--status',
    '--apply',
    '--confirm-oc-shipping-release',
  ]);
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanFlags.has(arg)) {
      if (flags.has(arg)) fail('duplicate_argument');
      flags.add(arg);
      continue;
    }
    if (!valueFlags.has(arg) || values[arg] !== undefined || index === argv.length - 1)
      fail('invalid_arguments');
    values[arg] = argv[(index += 1)];
  }
  const modes = ['--dry-run', '--status', '--apply'].filter((flag) => flags.has(flag));
  if (modes.length !== 1) fail('select_one_mode');
  const mode = modes[0].slice(2);
  if (mode !== 'status' && !validSha(values['--sha'])) fail('invalid_sha');
  if (mode === 'apply' && !flags.has('--confirm-oc-shipping-release'))
    fail('confirmation_required');
  if (mode !== 'apply' && flags.has('--confirm-oc-shipping-release')) fail('invalid_arguments');
  const verification = [values['--sha'], values['--deployment'], values['--configuration-hash']];
  if (mode === 'status' && verification.some(Boolean) && !verification.every(Boolean))
    fail('incomplete_status_verification');
  if (values['--sha'] && !validSha(values['--sha'])) fail('invalid_sha');
  if (values['--deployment'] && !validDeployment(values['--deployment']))
    fail('invalid_deployment');
  if (values['--configuration-hash'] && !/^[0-9a-f]{64}$/i.test(values['--configuration-hash']))
    fail('invalid_configuration_hash');
  return {
    mode,
    sha: values['--sha'],
    deployment: values['--deployment'],
    configurationHash: values['--configuration-hash'],
  };
}

export function deploymentRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.deployments)) return value.deployments;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

export function activeDeployments(value) {
  return deploymentRows(value).filter((row) =>
    ACTIVE_STATUSES.has(String(row?.status).toLowerCase())
  );
}

function canonicalEnvironment(rows) {
  if (!Array.isArray(rows)) fail('coolify_invalid_envs');
  return rows
    .map((row) => ({
      key: typeof row?.key === 'string' ? row.key : fail('coolify_invalid_envs'),
      value: typeof row?.value === 'string' ? row.value : fail('coolify_invalid_envs'),
      preview: Boolean(row?.is_preview),
      literal: Boolean(row?.is_literal),
      runtime: Boolean(row?.is_runtime),
      buildtime: Boolean(row?.is_buildtime),
      shownOnce: Boolean(row?.is_shown_once),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function configurationHash(rows) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalEnvironment(rows)))
    .digest('hex');
}

export function assertSchedulerEnvironment(rows) {
  for (const preview of [false, true])
    for (const [key, expected] of Object.entries(EXPECTED_ENV[String(preview)])) {
      const matches = rows.filter(
        (row) => row?.key === key && Boolean(row?.is_preview) === preview
      );
      if (matches.length !== 1 || matches[0]?.value !== expected)
        fail('unexpected_scheduler_environment');
    }
}

function assertApplication(app) {
  if (
    app?.uuid !== APP_UUID ||
    app?.name !== NAME ||
    !REPOSITORIES.has(app?.git_repository) ||
    app?.source_id !== 1 ||
    app?.git_branch !== 'main' ||
    app?.build_pack !== 'dockerfile' ||
    app?.dockerfile_location !== '/Dockerfile' ||
    app?.health_check_enabled !== false ||
    (app?.fqdn !== null && app?.fqdn !== '') ||
    app?.settings?.is_auto_deploy_enabled !== false ||
    app?.settings?.is_preview_deployments_enabled !== false
  ) {
    fail('unexpected_application_identity');
  }
}

function assertOldRunner(app, rows, logs, deployments) {
  if (
    app?.uuid !== OLD_APP_UUID ||
    app?.source_id !== 0 ||
    app?.git_branch !== 'main' ||
    app?.build_pack !== 'dockerfile' ||
    app?.dockerfile_location !== '/Dockerfile' ||
    app?.health_check_enabled !== false ||
    (app?.fqdn !== null && app?.fqdn !== '')
  )
    fail('old_runner_identity_mismatch');
  const disabled = rows.filter((row) => row?.key === 'SALESBINDER_SCHEDULER_DISABLED');
  if (
    disabled.length !== 2 ||
    disabled.some((row) => row?.value !== 'true') ||
    new Set(disabled.map((row) => Boolean(row?.is_preview))).size !== 2
  )
    fail('old_runner_not_disabled');
  const text = typeof logs?.logs === 'string' ? logs.logs : '';
  if (
    !text.includes('SalesBinder scheduler is explicitly disabled.') ||
    text.includes('SalesBinder config initialized.')
  )
    fail('old_runner_runtime_not_contained');
  if (activeDeployments(deployments).length !== 0) fail('old_runner_active_deployment');
}

function logSummary(value) {
  const logs = typeof value?.logs === 'string' ? value.logs : '';
  return {
    runtimeVerified: logs.includes('SalesBinder container runtime verified.'),
    enabledMarker: logs.includes('SalesBinder config initialized.'),
    failureKeyword: /\b(error|failed|fatal)\b/i.test(logs),
  };
}

async function readState(request) {
  const [app, envs, deployments, logs, oldApp] = await Promise.all([
    request(`/applications/${APP_UUID}`),
    request(`/applications/${APP_UUID}/envs`),
    request(`/deployments/applications/${APP_UUID}`),
    request(`/applications/${APP_UUID}/logs?lines=80&show_timestamps=false`),
    request(`/applications/${OLD_APP_UUID}`, 'GET', undefined, { allowNotFound: true }),
  ]);
  assertApplication(app);
  assertSchedulerEnvironment(envs);
  let oldRunner = 'absent';
  if (oldApp) {
    const [oldEnvs, oldLogs, oldDeployments] = await Promise.all([
      request(`/applications/${OLD_APP_UUID}/envs`),
      request(`/applications/${OLD_APP_UUID}/logs?lines=80&show_timestamps=false`),
      request(`/deployments/applications/${OLD_APP_UUID}`, 'GET', undefined, {
        allowNotFound: true,
      }),
    ]);
    assertOldRunner(oldApp, oldEnvs, oldLogs, oldDeployments);
    oldRunner = 'disabled';
  }
  return { app, envs, deployments, logs, oldRunner };
}

function assertNoActive(deployments) {
  if (activeDeployments(deployments).length !== 0) fail('active_deployment_conflict');
}
function deploymentUuid(value) {
  const rows = deploymentRows(value);
  const uuid = rows[0]?.deployment_uuid;
  if (rows.length !== 1 || rows[0]?.resource_uuid !== APP_UUID || !validDeployment(uuid))
    fail('unexpected_deploy_response');
  return uuid;
}

export async function execute(argv, dependencies) {
  const args = parseArguments(argv);
  const write = dependencies.write ?? ((value) => console.log(JSON.stringify(value)));
  const state = await readState(dependencies.request);
  const hash = configurationHash(state.envs);
  if (args.mode === 'status') {
    const result = {
      event: 'status',
      appUuid: APP_UUID,
      configuredSha: validSha(state.app.git_commit_sha) ? state.app.git_commit_sha : null,
      containerStatus: typeof state.app.status === 'string' ? state.app.status : null,
      configurationHash: hash,
      environmentRows: state.envs.length,
      activeDeployments: activeDeployments(state.deployments).length,
      scheduler: {
        normalEnabled: true,
        previewDisabled: true,
        cadenceSeconds: 300,
        references: 'cycle',
        timezone: 'Asia/Ho_Chi_Minh',
        days: '1,2,3,4,5,6',
        hours: '07:00-22:00',
      },
      logs: logSummary(state.logs),
      rollbackSha: PRIOR_SHA,
    };
    result.oldRunner = state.oldRunner;
    if (args.deployment) {
      const record = await dependencies.request(`/deployments/${args.deployment}`);
      const belongsToApp = deploymentRows(state.deployments).some(
        (row) => row?.deployment_uuid === args.deployment
      );
      result.deployment = {
        uuid: args.deployment,
        status: typeof record?.status === 'string' ? record.status : null,
        belongsToApp,
        commitMatches: record?.commit === args.sha,
        complete:
          belongsToApp &&
          record?.commit === args.sha &&
          ['finished', 'success'].includes(record?.status),
      };
      result.configurationPreserved = hash === args.configurationHash;
    }
    write(result);
    return result;
  }
  assertNoActive(state.deployments);
  if (state.app.git_commit_sha !== PRIOR_SHA) fail('current_release_sha_mismatch');
  const mainSha = await dependencies.remoteMainSha();
  if (mainSha !== args.sha) fail('target_is_not_remote_main');
  if (args.sha === PRIOR_SHA) fail('target_matches_current_release');
  const ready = {
    event: 'dry_run_ready',
    appUuid: APP_UUID,
    currentSha: PRIOR_SHA,
    targetSha: args.sha,
    targetIsNew: args.sha !== PRIOR_SHA,
    configurationHash: hash,
    environmentRows: state.envs.length,
    noActiveDeployment: true,
    environmentWrites: 0,
    rollbackSha: PRIOR_SHA,
  };
  if (args.mode === 'dry-run') {
    write(ready);
    return ready;
  }
  await dependencies.request(`/applications/${APP_UUID}`, 'PATCH', { git_commit_sha: args.sha });
  const [pinnedApp, pinnedEnvs, pinnedDeployments] = await Promise.all([
    dependencies.request(`/applications/${APP_UUID}`),
    dependencies.request(`/applications/${APP_UUID}/envs`),
    dependencies.request(`/deployments/applications/${APP_UUID}`),
  ]);
  assertApplication(pinnedApp);
  assertSchedulerEnvironment(pinnedEnvs);
  assertNoActive(pinnedDeployments);
  if (pinnedApp.git_commit_sha !== args.sha) fail('target_pin_verification_failed');
  if (configurationHash(pinnedEnvs) !== hash) fail('configuration_changed_after_pin');
  const queued = await dependencies.request(`/deploy?uuid=${APP_UUID}`, 'POST');
  const result = {
    event: 'deployment_queued',
    appUuid: APP_UUID,
    deploymentUuid: deploymentUuid(queued),
    targetSha: args.sha,
    configurationHash: hash,
    configurationPreserved: true,
    environmentWrites: 0,
    rollbackSha: PRIOR_SHA,
  };
  write(result);
  return result;
}

function runtimeConfig() {
  const base = process.env.COOLIFY_MONITOR_BASE_URL?.trim();
  const token = process.env.COOLIFY_MONITOR_API_TOKEN?.trim();
  if (!base || !token) fail('coolify_configuration_missing');
  return { base: `${base.replace(/\/$/, '')}/api/v1`, token };
}

function requester(settings) {
  return async (path, method = 'GET', body, options = {}) => {
    let response;
    try {
      response = await fetch(`${settings.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${settings.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      fail('coolify_network_failure');
    }
    if (response.status === 404 && options.allowNotFound) return null;
    if (!response.ok) fail(`coolify_http_${response.status}`);
    try {
      return await response.json();
    } catch {
      fail('coolify_invalid_json');
    }
  };
}

function remoteMainSha() {
  const result = spawnSync(
    'git',
    ['ls-remote', '--exit-code', REMOTE_REPOSITORY, 'refs/heads/main'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  const sha = result.status === 0 ? result.stdout.trim().split(/\s+/)[0] : null;
  if (!validSha(sha)) fail('remote_main_lookup_failed');
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await execute(process.argv.slice(2), { request: requester(runtimeConfig()), remoteMainSha });
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_-]{1,80}$/i.test(error.message)
        ? error.message
        : 'oc_shipping_deploy_failed';
    console.error(JSON.stringify({ error: true, code, rollbackSha: PRIOR_SHA }));
    process.exitCode = 1;
  }
}
