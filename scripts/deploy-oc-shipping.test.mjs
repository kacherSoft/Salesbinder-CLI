import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_UUID,
  OLD_APP_UUID,
  PRIOR_SHA,
  REMOTE_REPOSITORY,
  activeDeployments,
  configurationHash,
  execute,
  parseArguments,
} from './deploy-oc-shipping.mjs';

const target = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const envValues = {
  SALESBINDER_SCHEDULER_DISABLED: ['false', 'true'],
  SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: ['300', '300'],
  SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: ['cycle', 'cycle'],
  SALESBINDER_SCHEDULER_TIMEZONE: ['Asia/Ho_Chi_Minh', 'Asia/Ho_Chi_Minh'],
  SALESBINDER_SCHEDULER_DAYS: ['1,2,3,4,5,6', '1,2,3,4,5,6'],
  SALESBINDER_SCHEDULER_START_HOUR: ['7', '7'],
  SALESBINDER_SCHEDULER_END_HOUR: ['22', '22'],
};
function envs() {
  return Object.entries(envValues)
    .flatMap(([key, values]) =>
      values.map((value, index) => ({
        key,
        value,
        is_preview: Boolean(index),
        is_literal: true,
        is_runtime: true,
        is_buildtime: false,
        is_shown_once: true,
      }))
    )
    .concat([{ key: 'SECRET', value: 'never-print-this', is_preview: false, is_runtime: true }]);
}
function app(sha = PRIOR_SHA) {
  return {
    uuid: APP_UUID,
    name: 'SalesBinder Incremental Sync',
    git_repository: 'https://github.com/kacherSoft/Salesbinder-CLI.git',
    source_id: 1,
    git_branch: 'main',
    git_commit_sha: sha,
    build_pack: 'dockerfile',
    dockerfile_location: '/Dockerfile',
    health_check_enabled: false,
    fqdn: null,
    settings: { is_auto_deploy_enabled: false, is_preview_deployments_enabled: false },
  };
}
const oldApp = {
  uuid: OLD_APP_UUID,
  source_id: 0,
  git_branch: 'main',
  build_pack: 'dockerfile',
  dockerfile_location: '/Dockerfile',
  health_check_enabled: false,
  fqdn: null,
};
const oldEnvs = [
  { key: 'SALESBINDER_SCHEDULER_DISABLED', value: 'true', is_preview: false },
  { key: 'SALESBINDER_SCHEDULER_DISABLED', value: 'true', is_preview: true },
];

function harness({
  deployments = [],
  afterPinDeployments = [],
  oldAbsent = false,
  oldLogs = 'SalesBinder container runtime verified. SalesBinder scheduler is explicitly disabled.',
  oldDeployments = [],
  appPatch = {},
} = {}) {
  const calls = [];
  let pinned = false;
  const writes = [];
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === `/applications/${APP_UUID}` && method === 'PATCH') {
      pinned = true;
      return {};
    }
    if (path === `/applications/${APP_UUID}`)
      return { ...app(pinned ? target : PRIOR_SHA), ...appPatch };
    if (path === `/applications/${APP_UUID}/envs`) return envs();
    if (path === `/deployments/applications/${APP_UUID}`)
      return { deployments: pinned ? afterPinDeployments : deployments };
    if (path.startsWith(`/applications/${APP_UUID}/logs`))
      return { logs: 'SalesBinder container runtime verified. SalesBinder config initialized.' };
    if (path === `/applications/${OLD_APP_UUID}`) return oldAbsent ? null : oldApp;
    if (path === `/applications/${OLD_APP_UUID}/envs`) return oldEnvs;
    if (path.startsWith(`/applications/${OLD_APP_UUID}/logs`)) return { logs: oldLogs };
    if (path === `/deployments/applications/${OLD_APP_UUID}`)
      return { deployments: oldDeployments };
    if (path === `/deploy?uuid=${APP_UUID}`)
      return { deployments: [{ resource_uuid: APP_UUID, deployment_uuid: 'deploy-1234' }] };
    if (path === '/deployments/deploy-1234') return { status: 'finished', commit: target };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return {
    calls,
    writes,
    dependencies: {
      request,
      remoteMainSha: async () => target,
      write: (value) => writes.push(value),
    },
  };
}

test('accepts only explicit modes and guarded apply', () => {
  assert.equal(REMOTE_REPOSITORY, 'https://github.com/kacherSoft/Salesbinder-CLI.git');
  assert.deepEqual(parseArguments(['--dry-run', '--sha', target]).mode, 'dry-run');
  assert.throws(() => parseArguments(['--apply', '--sha', target]), /confirmation_required/);
  assert.throws(
    () => parseArguments(['--status', '--sha', target]),
    /incomplete_status_verification/
  );
  assert.throws(
    () => parseArguments(['--dry-run', '--sha', target, '--unknown']),
    /invalid_arguments/
  );
});

test('hash is stable across row order and changes with a secret value without exposing it', () => {
  const rows = envs();
  const hash = configurationHash(rows);
  assert.equal(hash, configurationHash([...rows].reverse()));
  assert.notEqual(
    hash,
    configurationHash(
      rows.map((row) => (row.key === 'SECRET' ? { ...row, value: 'changed' } : row))
    )
  );
  assert.doesNotMatch(hash, /never-print-this/);
});

test('classifies conflicting deployment states', () => {
  assert.equal(
    activeDeployments({ deployments: [{ status: 'finished' }, { status: 'running' }] }).length,
    1
  );
  assert.equal(activeDeployments({ deployments: [{ status: 'success' }] }).length, 0);
});

test('dry run performs no mutations and reports only a configuration hash', async () => {
  const h = harness();
  const result = await execute(['--dry-run', '--sha', target], h.dependencies);
  assert.equal(result.event, 'dry_run_ready');
  assert.equal(result.environmentWrites, 0);
  assert.equal(
    h.calls.some((call) => call.method !== 'GET'),
    false
  );
  assert.doesNotMatch(JSON.stringify(result), /never-print-this/);
});

test('dry run rejects the already deployed main SHA', async () => {
  const h = harness();
  h.dependencies.remoteMainSha = async () => PRIOR_SHA;
  await assert.rejects(
    () => execute(['--dry-run', '--sha', PRIOR_SHA], h.dependencies),
    /target_matches_current_release/
  );
  assert.equal(
    h.calls.some((call) => call.method !== 'GET'),
    false
  );
});

test('apply patches only the target SHA and queues one deployment', async () => {
  const h = harness();
  const result = await execute(
    ['--apply', '--sha', target, '--confirm-oc-shipping-release'],
    h.dependencies
  );
  const mutations = h.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(mutations, [
    { path: `/applications/${APP_UUID}`, method: 'PATCH', body: { git_commit_sha: target } },
    { path: `/deploy?uuid=${APP_UUID}`, method: 'POST', body: undefined },
  ]);
  assert.equal(result.configurationPreserved, true);
  assert.equal(result.rollbackSha, PRIOR_SHA);
  assert.equal(result.environmentWrites, 0);
});

test('conflicting deployment blocks before mutations', async () => {
  const h = harness({ deployments: [{ status: 'queued' }] });
  await assert.rejects(
    () => execute(['--apply', '--sha', target, '--confirm-oc-shipping-release'], h.dependencies),
    /active_deployment_conflict/
  );
  assert.equal(
    h.calls.some((call) => call.method !== 'GET'),
    false
  );
});

test('status verifies deployment and configuration hash without emitting values', async () => {
  const h = harness({
    deployments: [{ deployment_uuid: 'deploy-1234', status: 'finished', commit: target }],
  });
  const hash = configurationHash(envs());
  const result = await execute(
    ['--status', '--sha', target, '--deployment', 'deploy-1234', '--configuration-hash', hash],
    h.dependencies
  );
  assert.equal(result.deployment.belongsToApp, true);
  assert.equal(result.deployment.complete, true);
  assert.equal(result.configurationPreserved, true);
  assert.doesNotMatch(JSON.stringify(result), /never-print-this/);
});

test('absent retired runner is treated as contained', async () => {
  const h = harness({ oldAbsent: true });
  const result = await execute(['--status'], h.dependencies);
  assert.equal(result.oldRunner, 'absent');
  assert.equal(
    h.calls.some((call) => call.path === `/applications/${OLD_APP_UUID}/envs`),
    false
  );
});

test('existing retired runner must prove runtime containment and deployment quiescence', async () => {
  const enabled = harness({ oldLogs: 'SalesBinder config initialized.' });
  await assert.rejects(
    () => execute(['--dry-run', '--sha', target], enabled.dependencies),
    /old_runner_runtime_not_contained/
  );
  const active = harness({ oldDeployments: [{ status: 'running' }] });
  await assert.rejects(
    () => execute(['--dry-run', '--sha', target], active.dependencies),
    /old_runner_active_deployment/
  );
});

test('missing active-app deployment safety flags fail before mutations', async () => {
  const h = harness({ appPatch: { settings: {} } });
  await assert.rejects(
    () => execute(['--apply', '--sha', target, '--confirm-oc-shipping-release'], h.dependencies),
    /unexpected_application_identity/
  );
  assert.equal(
    h.calls.some((call) => call.method !== 'GET'),
    false
  );
});
