#!/usr/bin/env node
import pg from '../packages/sdk/node_modules/pg/lib/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';

const { Pool } = pg;
const CURRENT_STATE_KEY = 'official_v3_sync.state.v1';
const CURRENT_RUN_KEY = 'official_v3_sync.current_run.v1';
const RUN_PREFIX = 'official_v3_sync.run.v1:';
const TASK_PREFIX = 'official_v3_sync.task.v1:';
const RECEIPT_PREFIX = 'official_v3_sync.latest_receipt.v1:';
const REFRESH_KEY = 'reference_refresh.v1';
const DIRECTORY_KEY = 'salesperson_directory.v1';
const LEGACY_STATE_KEY = 'state';
const LEGACY_SYNC_STATUS_KEY = 'sync_status';
const PAYMENT_SYNC_STATUS_KEY = 'payment_sync_status';
const OC_SHIPPING_STATUS_KEY = 'oc_shipping.reconciliation_status.v1';
const OC_SHIPPING_WARNING_PREFIX = 'oc_shipping.warning.v1:';
const RESOURCES = ['item', 'invoice', 'estimate', 'purchase_order'];
const STATUSES = ['pending', 'waiting_children', 'done', 'superseded', 'failed'];
const OPERATIONS = ['upsert', 'delete', 'refresh'];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const parseJson = (value, label) => {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} metadata is invalid.`);
  }
};
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const hashBinding = (identity) => createHash('sha256').update(identity, 'utf8').digest('hex');
const asNumber = (value) => (value == null ? null : Number(value));

export function taskCheckpointKey(task) {
  return `${task.runId}:${task.taskId}`;
}

export function validateCheckpoint(value, now = Math.floor(Date.now() / 1000)) {
  if (!isRecord(value) || value.version !== 1 || !safeInteger(value.observedAt) ||
    value.observedAt > now || !/^[0-9a-f]{64}$/.test(String(value.accountBindingHash)) ||
    !Array.isArray(value.tasks) || (value.runs !== undefined && !Array.isArray(value.runs))) {
    throw new Error('Sync interval checkpoint is invalid or from the future.');
  }
  const seen = new Set();
  for (const task of value.tasks) {
    if (!isRecord(task) || typeof task.runId !== 'string' || typeof task.taskId !== 'string' ||
      !RESOURCES.includes(task.resource) || typeof task.id !== 'string' || !task.id ||
      !STATUSES.includes(task.status)) {
      throw new Error('Sync interval checkpoint is invalid.');
    }
    const key = taskCheckpointKey(task);
    if (seen.has(key)) throw new Error('Sync interval checkpoint contains duplicate task keys.');
    seen.add(key);
  }
  const seenRuns = new Set();
  for (const run of value.runs ?? []) {
    if (!isRecord(run) || typeof run.runId !== 'string' || !run.runId || seenRuns.has(run.runId)) {
      throw new Error('Sync interval checkpoint is invalid.');
    }
    seenRuns.add(run.runId);
  }
  return value;
}

export async function readCheckpoint(path, now = Math.floor(Date.now() / 1000)) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Sync interval checkpoint must be a private regular file.');
    }
    return validateCheckpoint(JSON.parse(await readFile(path, 'utf8')), now);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('Sync interval checkpoint is invalid.');
    throw error;
  }
}

export async function writeCheckpoint(path, checkpoint) {
  validateCheckpoint(checkpoint);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Sync interval audit directory must be a private owned directory.');
  }
  await chmod(path, 0o700);
}

async function writeImmutablePrivateJson(path, value) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

/**
 * Write immutable, sanitized interval evidence before replacing the rolling
 * checkpoint. A failed audit write leaves the established checkpoint intact.
 */
export async function saveCheckpointWithAudit(path, checkpoint, report, options = {}) {
  validateCheckpoint(checkpoint);
  const auditDirectory = `${path}.audit`;
  const compact = formatCliReport(report);
  const evidence = {
    version: 1,
    observedAt: compact.observedAt,
    checkpointFrom: compact.interval.from,
    report: compact,
  };
  const evidenceId = createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex').slice(0, 16);
  const prefix = `${checkpoint.observedAt}-${evidenceId}`;
  const writeImmutable = options.writeImmutable ?? writeImmutablePrivateJson;
  const writeCurrent = options.writeCurrent ?? writeCheckpoint;
  await ensurePrivateDirectory(auditDirectory);
  await writeImmutable(resolve(auditDirectory, `${prefix}.report.json`), evidence);
  if (options.previousCheckpoint) {
    await writeImmutable(resolve(auditDirectory, `${prefix}.previous-checkpoint.json`), options.previousCheckpoint);
  }
  await writeCurrent(path, checkpoint);
}

function runFields(run) {
  if (!run) return null;
  return {
    runId: typeof run.runId === 'string' ? run.runId : null,
    status: typeof run.status === 'string' ? run.status : null,
    ingestionComplete: typeof run.ingestionComplete === 'boolean' ? run.ingestionComplete : null,
    pageCount: safeInteger(run.pageCount) ? run.pageCount : null,
    startedAt: safeInteger(run.startedAt) ? run.startedAt : null,
    updatedAt: safeInteger(run.updatedAt) ? run.updatedAt : null,
    finishedAt: safeInteger(run.finishedAt) ? run.finishedAt : null,
  };
}

function runState(run) {
  const fields = runFields(run);
  return fields;
}

function emptyStatuses() {
  return Object.fromEntries(STATUSES.map((status) => [status, 0]));
}

function emptyOperations() {
  return Object.fromEntries(OPERATIONS.map((operation) => [operation, { tasks: 0, uniqueIds: [] }]));
}

function taskAggregate(tasks, previous, exact) {
  const byResource = Object.fromEntries(RESOURCES.map((resource) => [resource, {
    tasks: emptyStatuses(),
    operations: emptyOperations(),
    uniqueIds: [],
    doneTransitions: exact ? 0 : null,
    doneTransitionUniqueIds: [],
  }]));
  const doneSets = new Map(RESOURCES.map((resource) => [resource, new Set()]));
  const idSets = new Map(RESOURCES.map((resource) => [resource, new Set()]));
  const operationIdSets = new Map(RESOURCES.map((resource) =>
    [resource, new Map(OPERATIONS.map((operation) => [operation, new Set()]))]
  ));
  for (const task of tasks) {
    const resource = byResource[task.resource];
    if (!resource || !STATUSES.includes(task.status) || !OPERATIONS.includes(task.operation)) continue;
    resource.tasks[task.status] += 1;
    idSets.get(task.resource).add(task.id);
    const newlyDone = task.status === 'done' && previous.get(taskCheckpointKey(task)) !== 'done';
    if (task.status === 'done' && (!exact || newlyDone)) {
      operationIdSets.get(task.resource).get(task.operation)?.add(task.id);
    }
    if (exact && newlyDone) {
      resource.doneTransitions += 1;
      doneSets.get(task.resource).add(task.id);
      resource.operations[task.operation].tasks += 1;
    }
    if (!exact && task.status === 'done') {
      resource.doneTransitionUniqueIds.push(task.id);
      resource.operations[task.operation].tasks += 1;
    }
  }
  for (const resource of RESOURCES) {
    byResource[resource].uniqueIds = [...idSets.get(resource)].sort();
    byResource[resource].doneTransitionUniqueIds = exact
      ? [...doneSets.get(resource)].sort()
      : [...new Set(byResource[resource].doneTransitionUniqueIds)].sort();
    for (const operation of OPERATIONS) {
      byResource[resource].operations[operation].uniqueIds =
        [...operationIdSets.get(resource).get(operation)].sort();
    }
  }
  return byResource;
}

function mergeTotals(runs, exact) {
  const totals = Object.fromEntries(RESOURCES.map((resource) => [resource, {
    tasks: emptyStatuses(), operations: emptyOperations(), uniqueIds: [],
    doneTransitions: exact ? 0 : null, doneTransitionUniqueIds: exact || runs.length ? [] : null,
  }]));
  const sets = new Map(RESOURCES.map((resource) => [resource, new Set()]));
  const doneSets = new Map(RESOURCES.map((resource) => [resource, new Set()]));
  for (const run of runs) for (const resource of RESOURCES) {
    const source = run.resources[resource];
    const target = totals[resource];
    for (const status of STATUSES) target.tasks[status] += source.tasks[status];
    if (exact) target.doneTransitions += source.doneTransitions ?? 0;
    for (const id of source.uniqueIds) sets.get(resource).add(id);
    for (const id of source.doneTransitionUniqueIds ?? []) doneSets.get(resource).add(id);
    for (const operation of OPERATIONS) {
      target.operations[operation].tasks += source.operations[operation].tasks;
      for (const id of source.operations[operation].uniqueIds) {
        target.operations[operation].uniqueIds.push(id);
      }
    }
  }
  for (const resource of RESOURCES) {
    totals[resource].uniqueIds = [...sets.get(resource)].sort();
    totals[resource].doneTransitionUniqueIds = exact || runs.length
      ? [...doneSets.get(resource)].sort() : null;
    for (const operation of OPERATIONS) {
      totals[resource].operations[operation].uniqueIds =
        [...new Set(totals[resource].operations[operation].uniqueIds)].sort();
    }
  }
  return totals;
}

function sanitizeAggregates(aggregates) {
  if (!aggregates) return null;
  return Object.fromEntries(RESOURCES.map((resource) => {
    const value = aggregates[resource];
    return [resource, {
      tasks: value.tasks,
      operations: Object.fromEntries(OPERATIONS.map((operation) => [operation, {
        tasks: value.operations[operation].tasks,
        uniqueIdCount: value.operations[operation].uniqueIds.length,
      }])),
      uniqueIdCount: value.uniqueIds.length,
      doneTransitions: value.doneTransitions,
      doneTransitionUniqueIdCount: value.doneTransitionUniqueIds === null
        ? null : value.doneTransitionUniqueIds.length,
    }];
  }));
}

function sanitizeReferences(refs = {}) {
  const refresh = refs.refresh;
  const resources = {};
  for (const resource of ['categories', 'accounts', 'users', 'payments']) {
    const source = refresh?.resources?.[resource];
    resources[resource] = {
      outcome: typeof source?.outcome === 'string' ? source.outcome : null,
      recordCount: Number.isSafeInteger(source?.recordCount) ? source.recordCount : null,
    };
  }
  return {
    inventory: { count: refs.inventoryCount, label: 'current inventory item total; not interval changes' },
    directory: { count: refs.directoryCount, label: 'current salesperson directory user total; not interval changes' },
    refresh: {
      status: typeof refresh?.run?.status === 'string' ? refresh.run.status : null,
      resources,
    },
    payments: {
      excludedFromOfficialCoverage: true,
      referenceRefreshOutcome: resources.payments.outcome,
      syncStatus: typeof refs.paymentSyncStatus?.status === 'string' ? refs.paymentSyncStatus.status : null,
      label: 'payment refresh is separate from official V3 partial catch-up coverage',
    },
  };
}

function sanitizeOfficialAuthority(authority) {
  if (!authority || authority.authority !== 'official_v3') return null;
  return {
    authority: 'official_v3',
    availability: authority.status === 'available' ? 'available' : 'unavailable',
    syncHealth: typeof authority.syncHealth === 'string' ? authority.syncHealth : 'unavailable',
    freshness: authority.freshness === 'FRESH' ? 'FRESH' : 'STALE',
    lastAppliedAt: safeInteger(authority.lastAppliedAt) ? authority.lastAppliedAt : null,
    lastAttemptAt: safeInteger(authority.lastAttemptAt) ? authority.lastAttemptAt : null,
    coverage: 'partial_catch_up',
  };
}

function sanitizeOCShipping(status, warningCount) {
  return {
    status: typeof status?.status === 'string' ? status.status : null,
    failed: safeInteger(status?.failed) ? status.failed : null,
    persistedWarningCount: safeInteger(warningCount) ? warningCount : 0,
    label: 'OC shipping reconciliation is a separate status from official V3 cursor application',
  };
}

function sanitizeLegacy(legacy, officialAuthority) {
  const status = typeof legacy?.syncStatus?.status === 'string' ? legacy.syncStatus.status : null;
  const lastSync = safeInteger(legacy?.state?.lastSync) ? legacy.state.lastSync : null;
  return {
    activity: officialAuthority ? 'inactive_legacy' : 'legacy_authority_or_unavailable',
    syncStatus: status,
    lastSync,
    label: officialAuthority
      ? 'legacy sync metadata is diagnostic only while official V3 metadata exists'
      : 'legacy sync metadata is the available diagnostic source',
  };
}

export function buildIntervalReport(snapshot, checkpoint = null, options = {}) {
  const now = options.now ?? snapshot.observedAt ?? Math.floor(Date.now() / 1000);
  if (!safeInteger(now) || !safeInteger(snapshot.observedAt) || snapshot.observedAt > now) {
    throw new Error('Sync interval snapshot time is invalid.');
  }
  if (checkpoint) {
    validateCheckpoint(checkpoint, now);
    if (snapshot.accountBindingHash && checkpoint.accountBindingHash !== snapshot.accountBindingHash) {
      throw new Error('Sync interval checkpoint belongs to another cache account.');
    }
  }
  const previous = new Map((checkpoint?.tasks ?? []).map((task) =>
    [taskCheckpointKey(task), task.status]
  ));
  const previousRuns = new Map((checkpoint?.runs ?? []).map((run) => [run.runId, JSON.stringify(run)]));
  const tasksByRun = new Map();
  for (const task of snapshot.tasks ?? []) {
    if (!tasksByRun.has(task.runId)) tasksByRun.set(task.runId, []);
    tasksByRun.get(task.runId).push(task);
  }
  const runs = (snapshot.runs ?? []).filter((run) => run && typeof run.runId === 'string');
  const currentTaskKeys = new Set((snapshot.tasks ?? []).map(taskCheckpointKey));
  const currentRunKeys = new Set(runs.map((run) => run.runId));
  const missingCheckpointTasks = (checkpoint?.tasks ?? []).filter(
    (task) => !currentTaskKeys.has(taskCheckpointKey(task))
  ).length;
  const missingCheckpointRuns = (checkpoint?.runs ?? []).filter(
    (run) => !currentRunKeys.has(run.runId)
  ).length;
  const changed = [];
  let mode = 'baseline';
  let exact = Boolean(checkpoint) && missingCheckpointTasks === 0 && missingCheckpointRuns === 0;
  if (checkpoint) {
    mode = 'checkpoint';
    for (const run of runs) {
      const tasks = tasksByRun.get(run.runId) ?? [];
      const taskChanged = tasks.some((task) => previous.get(taskCheckpointKey(task)) !== task.status);
      const runStateChanged = previousRuns.has(run.runId) &&
        previousRuns.get(run.runId) !== JSON.stringify(runState(run));
      const runUpdated = safeInteger(run.updatedAt) && run.updatedAt > checkpoint.observedAt;
      if (taskChanged || runUpdated || runStateChanged || !previousRuns.has(run.runId)) {
        changed.push({
          ...runFields(run),
          reasons: [...(taskChanged ? ['task_status_changed'] : []),
            ...(runUpdated ? ['run_updated'] : []),
            ...(runStateChanged ? ['run_state_changed'] : []),
            ...(!previousRuns.has(run.runId) ? ['run_not_in_checkpoint'] : [])],
          resources: taskAggregate(tasks, previous, exact),
        });
      }
    }
  } else if (options.since !== undefined) {
    mode = 'logical-run-cohort';
    const since = options.since;
    for (const run of runs) {
      if ((safeInteger(run.startedAt) && run.startedAt >= since) ||
        (safeInteger(run.updatedAt) && run.updatedAt >= since)) {
        changed.push({
          ...runFields(run),
          reasons: ['logical_run_started_or_updated_since'],
          resources: taskAggregate(tasksByRun.get(run.runId) ?? [], new Map(), false),
        });
      }
    }
  }
  changed.sort((left, right) => String(left.runId).localeCompare(String(right.runId)));
  return {
    version: 1,
    observedAt: snapshot.observedAt,
    interval: {
      mode,
      exact,
      since: checkpoint ? checkpoint.observedAt : (options.since ?? null),
      historicalCountsAvailable: exact,
      checkpointComplete: !checkpoint || (missingCheckpointTasks === 0 && missingCheckpointRuns === 0),
      missingCheckpointTasks,
      missingCheckpointRuns,
      runsChanged: changed.map(({ resources, ...run }) => ({
        ...run,
        resources: sanitizeAggregates(resources),
      })),
      totals: sanitizeAggregates(mergeTotals(changed, exact)),
      countsBasis: exact ? 'durable_task_status_transitions' :
        (mode === 'logical-run-cohort' ? 'current_task_status_cohort_estimate' : 'unavailable'),
      unavailable: exact ? [] : [
        'historical task event times are unavailable because tasks have no timestamps',
        'transient failed attempts cannot be reconstructed from overwritten metadata',
        ...(missingCheckpointTasks || missingCheckpointRuns
          ? ['checkpoint keys are missing from the current cache; exact interval counts are unavailable'] : []),
        ...(mode === 'logical-run-cohort' ? ['cohort counts are current metadata estimates, not event-time counts'] : []),
      ],
    },
    latestHealth: {
      official: sanitizeOfficialAuthority(snapshot.officialAuthority),
      officialRun: runFields(snapshot.currentRun),
      state: snapshot.state ? {
        appliedGeneration: safeInteger(snapshot.state.appliedGeneration) ? snapshot.state.appliedGeneration : null,
        nextGeneration: safeInteger(snapshot.state.nextGeneration) ? snapshot.state.nextGeneration : null,
        hasIngestionCursor: typeof snapshot.state.ingestionCursor === 'string',
        hasAppliedCursor: typeof snapshot.state.appliedCursor === 'string',
        cursorGap: typeof snapshot.state.ingestionCursor === 'string' &&
          snapshot.state.ingestionCursor !== snapshot.state.appliedCursor,
      } : null,
      currentRunTaskCounts: snapshot.currentRun
        ? sanitizeAggregates(taskAggregate(tasksByRun.get(snapshot.currentRun.runId) ?? [], new Map(), false))
        : null,
      latestReceiptCounts: snapshot.receiptCounts ?? Object.fromEntries(RESOURCES.map((resource) => [resource, 0])),
    },
    ocShipping: sanitizeOCShipping(snapshot.ocShipping, snapshot.ocShippingWarningCount),
    legacy: sanitizeLegacy(snapshot.legacy, snapshot.officialAuthority),
    references: sanitizeReferences(snapshot.refs),
    limits: [
      'logical runs are not cron invocations',
      'unique IDs are deduplicated within each resource; task totals count task rows',
      'transient failed attempts cannot be reconstructed from overwritten task metadata',
      'reference inventory and directory values are current totals, not interval changes',
    ],
  };
}

export function makeCheckpoint(snapshot, previousCheckpoint = null) {
  if (!snapshot.accountBindingHash) throw new Error('Cannot checkpoint an unbound cache snapshot.');
  const taskMap = new Map((previousCheckpoint?.tasks ?? []).map((task) => [taskCheckpointKey(task), {
    runId: task.runId,
    taskId: task.taskId,
    resource: task.resource,
    id: task.id,
    status: task.status,
  }]));
  for (const task of snapshot.tasks ?? []) taskMap.set(taskCheckpointKey(task), {
    runId: task.runId,
    taskId: task.taskId,
    resource: task.resource,
    id: task.id,
    status: task.status,
  });
  const runMap = new Map((previousCheckpoint?.runs ?? []).map((run) => [run.runId, run]));
  for (const run of snapshot.runs ?? []) runMap.set(run.runId, runState(run));
  return {
    version: 1,
    observedAt: snapshot.observedAt,
    accountBindingHash: snapshot.accountBindingHash,
    tasks: [...taskMap.values()],
    runs: [...runMap.values()],
  };
}

function compactResource(value, transitionDone = false) {
  return {
    doneTasks: transitionDone ? value.doneTransitions : value.tasks.done,
    doneUniqueIds: value.doneTransitionUniqueIdCount,
    operations: Object.fromEntries(OPERATIONS.map((operation) => [operation, {
      doneTasks: value.operations[operation].tasks,
      uniqueIds: value.operations[operation].uniqueIdCount,
    }])),
    failedTasks: value.tasks.failed,
    pendingTasks: value.tasks.pending + value.tasks.waiting_children,
    supersededTasks: value.tasks.superseded,
  };
}

export function formatCliReport(report) {
  const outcomeCounts = {};
  for (const run of report.interval.runsChanged) {
    outcomeCounts[run.status] = (outcomeCounts[run.status] ?? 0) + 1;
  }
  return {
    version: report.version,
    observedAt: report.observedAt,
    interval: {
      from: report.interval.since,
      to: report.observedAt,
      mode: report.interval.mode,
      exact: report.interval.exact,
      countsBasis: report.interval.countsBasis,
      logicalRunsChanged: report.interval.runsChanged.length,
      logicalRunOutcomeCounts: outcomeCounts,
      checkpointComplete: report.interval.checkpointComplete,
      missingCheckpointTasks: report.interval.missingCheckpointTasks,
      missingCheckpointRuns: report.interval.missingCheckpointRuns,
      resources: Object.fromEntries(RESOURCES.map((resource) =>
        [resource, compactResource(report.interval.totals[resource], report.interval.exact)])),
      unavailable: report.interval.unavailable,
    },
    latestHealth: {
      official: report.latestHealth.official,
      status: report.latestHealth.officialRun?.status ?? null,
      ingestionComplete: report.latestHealth.officialRun?.ingestionComplete ?? null,
      taskCounts: report.latestHealth.currentRunTaskCounts
        ? Object.fromEntries(RESOURCES.map((resource) => [resource,
          compactResource(report.latestHealth.currentRunTaskCounts[resource])]))
        : null,
      state: report.latestHealth.state,
      latestReceiptCounts: report.latestHealth.latestReceiptCounts,
    },
    ocShipping: report.ocShipping,
    legacy: report.legacy,
    references: report.references,
    limits: report.limits,
  };
}

/** A concise relay-safe status view; it never includes cursors, IDs, or source payloads. */
export function formatMarkdownReport(report) {
  const compact = formatCliReport(report);
  const official = compact.latestHealth.official;
  const intervalOutcomes = Object.entries(compact.interval.logicalRunOutcomeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ') || 'none';
  const intervalDoneTotal = RESOURCES.reduce(
    (total, resource) => total + (compact.interval.resources[resource].doneTasks ?? 0), 0
  );
  const lines = [
    '# Scheduled sync report / Báo cáo đồng bộ định kỳ',
    '',
    `- Observed: ${formatTimestamp(compact.observedAt)}; checkpoint complete=${compact.interval.checkpointComplete}.`,
    `- Interval: ${formatTimestamp(compact.interval.from)} → ${formatTimestamp(compact.interval.to)}; exact=${compact.interval.exact}; basis=${compact.interval.countsBasis}; logical runs=${compact.interval.logicalRunsChanged} (${intervalOutcomes}).`,
    `- Official V3: status=${compact.latestHealth.status ?? 'unavailable'}; health=${official?.syncHealth ?? 'unavailable'}; coverage=${official?.coverage ?? 'unavailable'}; cursor gap=${compact.latestHealth.state?.cursorGap === true}.`,
    `- OC shipping: status=${compact.ocShipping.status ?? 'unavailable'}; failed=${compact.ocShipping.failed ?? 'unavailable'}; persisted warnings=${compact.ocShipping.persistedWarningCount}.`,
    `- Legacy diagnostic: ${compact.legacy.activity}; status=${compact.legacy.syncStatus ?? 'unavailable'}; last sync=${formatTimestamp(compact.legacy.lastSync)}.`,
    `- References: ${formatReferenceRefresh(compact.references.refresh)}; payments excluded from official coverage=${compact.references.payments.excludedFromOfficialCoverage}.`,
    '',
    `## Interval activity / Hoạt động trong khoảng (${compact.interval.countsBasis}; done=${intervalDoneTotal})`,
    '',
    '| Resource | Done tasks | Unique IDs | Failed | Pending |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const resource of RESOURCES) {
    const counts = compact.interval.resources[resource];
    lines.push(`| ${resource} | ${counts.doneTasks ?? 0} | ${counts.doneUniqueIds ?? 0} | ${counts.failedTasks ?? 0} | ${counts.pendingTasks ?? 0} |`);
  }
  lines.push('', '## Current official run task state / Trạng thái run chính thức hiện tại', '');
  if (!compact.latestHealth.taskCounts) {
    lines.push('No current official run metadata.');
  } else {
    lines.push('| Resource | Done tasks | Unique IDs | Failed | Pending |', '| --- | ---: | ---: | ---: |');
    for (const resource of RESOURCES) {
      const counts = compact.latestHealth.taskCounts[resource];
      lines.push(`| ${resource} | ${counts.doneTasks ?? 0} | ${counts.doneUniqueIds ?? 0} | ${counts.failedTasks ?? 0} | ${counts.pendingTasks ?? 0} |`);
    }
  }
  if (!compact.interval.exact) lines.push('', `Interval limitation: ${compact.interval.unavailable.join('; ')}`);
  return `${lines.join('\n')}\n`;
}

function formatTimestamp(timestamp) {
  if (!safeInteger(timestamp)) return 'unavailable';
  const date = new Date(timestamp * 1000);
  const ict = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
  }).format(date);
  return `${date.toISOString()} (${ict} ICT)`;
}

function formatReferenceOutcomes(resources) {
  const outcomes = Object.entries(resources ?? {})
    .map(([resource, status]) => `${resource}=${status?.outcome ?? 'unavailable'}`)
    .join(', ');
  return outcomes || 'unavailable';
}

function formatReferenceRefresh(refresh) {
  const status = refresh?.status ?? 'unavailable';
  const outcomes = formatReferenceOutcomes(refresh?.resources);
  return status === 'running'
    ? `reference run in progress; resource outcomes are provisional (${outcomes})`
    : `refresh run=${status}; resource outcomes=${outcomes}`;
}

async function readOnly(client, operation) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

let authorityProjector;

async function projectOfficialAuthority(state, currentRun, tasks, observedAt) {
  if (!state || !currentRun) return null;
  authorityProjector ??= import('../packages/sdk/dist/cache/public-sync-authority.js')
    .then(({ projectPublicCacheSyncAuthority }) => projectPublicCacheSyncAuthority);
  const project = await authorityProjector;
  const currentTasks = tasks.filter((task) => task.runId === currentRun.runId);
  return project({
    run: currentRun,
    state: {
      ...state,
      hasIngestionCursor: typeof state.ingestionCursor === 'string',
      hasAppliedCursor: typeof state.appliedCursor === 'string',
      cursorGap: state.ingestionCursor !== state.appliedCursor,
    },
    tasks: {
      discovered: currentTasks.length,
      applied: currentTasks.filter((task) => task.status === 'done').length,
      failed: currentTasks.filter((task) => task.status === 'failed').length,
      pending: currentTasks.filter((task) => task.status === 'pending' || task.status === 'waiting_children').length,
      superseded: currentTasks.filter((task) => task.status === 'superseded').length,
    },
    failures: [],
    coverage: 'partial_catch_up',
  }, { staleThresholdSeconds: reportStaleThreshold(), nowSeconds: observedAt });
}

function reportStaleThreshold() {
  const value = process.env.SALESBINDER_CACHE_STALE_SECONDS?.trim();
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : 3600;
}

export async function snapshotDatabase(client, observedAt = Math.floor(Date.now() / 1000)) {
  return readOnly(client, async (tx) => {
    const binding = (await tx.query(
      'SELECT account_identity FROM cache_account_binding WHERE id = 1'
    )).rows[0];
    if (!binding?.account_identity) throw new Error('PostgreSQL cache account binding is missing.');
    const rows = (await tx.query(
      `SELECT key, value FROM cache_meta
       WHERE key = ANY($1) OR starts_with(key, $2) OR starts_with(key, $3) OR starts_with(key, $4)
         OR starts_with(key, $5)
       ORDER BY key`,
      [[CURRENT_STATE_KEY, CURRENT_RUN_KEY, REFRESH_KEY, DIRECTORY_KEY, LEGACY_STATE_KEY,
        LEGACY_SYNC_STATUS_KEY, PAYMENT_SYNC_STATUS_KEY, OC_SHIPPING_STATUS_KEY],
      RUN_PREFIX, TASK_PREFIX, RECEIPT_PREFIX, OC_SHIPPING_WARNING_PREFIX]
    )).rows;
    const runs = new Map();
    const tasks = [];
    const receiptCounts = Object.fromEntries(RESOURCES.map((resource) => [resource, 0]));
    let state = null;
    let currentRun = null;
    let refresh = null;
    let directory = null;
    let legacyState = null;
    let legacySyncStatus = null;
    let paymentSyncStatus = null;
    let ocShipping = null;
    let ocShippingWarningCount = 0;
    const assertAccount = (value) => {
      if (typeof value.accountIdentity !== 'string' || value.accountIdentity !== binding.account_identity) {
        throw new Error('PostgreSQL cache metadata account binding mismatch.');
      }
    };
    for (const row of rows) {
      const key = String(row.key);
      if (key.startsWith(OC_SHIPPING_WARNING_PREFIX)) {
        ocShippingWarningCount += 1;
        continue;
      }
      const value = parseJson(row.value, 'Cache report');
      if (key === CURRENT_STATE_KEY) { assertAccount(value); state = value; }
      else if (key === CURRENT_RUN_KEY) { assertAccount(value); currentRun = value; }
      else if (key === REFRESH_KEY) { assertAccount(value); refresh = value; }
      else if (key === DIRECTORY_KEY) { assertAccount(value); directory = value; }
      else if (key === LEGACY_STATE_KEY) legacyState = value;
      else if (key === LEGACY_SYNC_STATUS_KEY) legacySyncStatus = value;
      else if (key === PAYMENT_SYNC_STATUS_KEY) paymentSyncStatus = value;
      else if (key === OC_SHIPPING_STATUS_KEY) { assertAccount(value); ocShipping = value; }
      else if (key.startsWith(RUN_PREFIX)) {
        assertAccount(value);
        if (value.runId !== key.slice(RUN_PREFIX.length)) throw new Error('Official V3 run metadata is invalid.');
        runs.set(value.runId, value);
      } else if (key.startsWith(TASK_PREFIX)) {
        const suffix = key.slice(TASK_PREFIX.length);
        const separator = suffix.indexOf(':');
        if (separator <= 0 || value.runId !== suffix.slice(0, separator) ||
          value.taskId !== suffix.slice(separator + 1) || !RESOURCES.includes(value.resource) ||
          !STATUSES.includes(value.status) || !OPERATIONS.includes(value.operation) ||
          typeof value.id !== 'string' || !value.id) {
          throw new Error('Official V3 task metadata is invalid.');
        }
        tasks.push(value);
      }
      else if (key.startsWith(RECEIPT_PREFIX)) {
        const resource = key.slice(RECEIPT_PREFIX.length).split(':', 1)[0];
        if (Object.prototype.hasOwnProperty.call(receiptCounts, resource)) receiptCounts[resource] += 1;
      }
    }
    for (const task of tasks) if (!runs.has(task.runId)) {
      throw new Error('Official V3 task metadata has no matching run.');
    }
    const inventoryCount = Number((await tx.query(
      `SELECT COUNT(*)::bigint AS count FROM items
       WHERE cache_source = 'api' AND source_api_version = '3'`
    )).rows[0]?.count ?? 0);
    const officialAuthority = await projectOfficialAuthority(state, currentRun, tasks, observedAt);
    return {
      observedAt,
      accountBindingHash: hashBinding(String(binding.account_identity)),
      state,
      currentRun,
      runs: [...runs.values()],
      tasks,
      receiptCounts,
      officialAuthority,
      ocShipping,
      ocShippingWarningCount,
      legacy: { state: legacyState, syncStatus: legacySyncStatus },
      refs: {
        refresh,
        inventoryCount: Number.isSafeInteger(inventoryCount) ? inventoryCount : asNumber(inventoryCount),
        directoryCount: Array.isArray(directory?.users) ? directory.users.length : null,
        paymentSyncStatus,
      },
    };
  });
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseSince(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('--since must be a UNIX timestamp in seconds.');
  const since = Number(value);
  if (!safeInteger(since) || since > Math.floor(Date.now() / 1000)) {
    throw new Error('--since must be a non-future UNIX timestamp.');
  }
  return since;
}

async function main() {
  const args = process.argv.slice(2);
  const connectionString = process.env.SALESBINDER_DB_URL;
  if (!connectionString) throw new Error('SALESBINDER_DB_URL is required.');
  const checkpointPath = argValue(args, '--checkpoint');
  const save = args.includes('--save-checkpoint');
  const format = argValue(args, '--format') ?? 'json';
  if (save && !checkpointPath) throw new Error('--save-checkpoint requires --checkpoint PATH.');
  if (format !== 'json' && format !== 'markdown') throw new Error('--format must be json or markdown.');
  const checkpoint = checkpointPath ? await readCheckpoint(checkpointPath) : null;
  const since = parseSince(argValue(args, '--since'));
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: 'salesbinder-sync-interval-report',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000,
    query_timeout: 20_000,
  });
  const client = await pool.connect();
  try {
    const snapshot = await snapshotDatabase(client);
    const report = buildIntervalReport(snapshot, checkpoint, { since });
    const output = format === 'markdown'
      ? formatMarkdownReport(report)
      : `${JSON.stringify(formatCliReport(report), null, 2)}\n`;
    await new Promise((resolveOutput, rejectOutput) => {
      process.stdout.write(output, (error) => error ? rejectOutput(error) : resolveOutput());
    });
    if (save && report.interval.checkpointComplete) {
      await saveCheckpointWithAudit(checkpointPath, makeCheckpoint(snapshot, checkpoint), report, {
        previousCheckpoint: checkpoint,
      });
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Sync interval report failed.');
    process.exitCode = 1;
  });
}
