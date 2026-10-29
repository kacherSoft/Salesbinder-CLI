import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIntervalReport,
  deletedLogSince,
  mergeDeletedLog,
  summarizeDeletedLog,
  formatCliReport,
  formatMarkdownReport,
  makeCheckpoint,
  readCheckpoint,
  saveCheckpointWithAudit,
  snapshotDatabase,
  taskCheckpointKey,
  validateCheckpoint,
  writeCheckpoint,
} from './report-sync-interval.mjs';

const ids = {
  itemA: '00000000-0000-4000-8000-000000000001',
  itemB: '00000000-0000-4000-8000-000000000002',
  invoiceA: '00000000-0000-4000-8000-000000000003',
};
const task = (runId, taskId, resource, id, status, operation = 'upsert') =>
  ({ runId, taskId, resource, id, status, operation });
const run = (runId, startedAt = 100, updatedAt = 100, status = 'success') =>
  ({ runId, startedAt, updatedAt, status, pageCount: 1, ingestionComplete: true });
const snapshot = (runs, tasks, observedAt = 200) => ({
  observedAt,
  accountBindingHash: 'a'.repeat(64),
  runs,
  tasks,
  refs: { inventoryCount: 4, directoryCount: 2 },
  receiptCounts: { item: 0, invoice: 0, estimate: 0, purchase_order: 0 },
});

test('baseline report is explicit about unavailable historical counts', () => {
  const report = buildIntervalReport(snapshot([run('run-new')], [
    task('run-new', 'm:1:0', 'item', ids.itemA, 'done'),
  ]));
  assert.equal(report.interval.mode, 'baseline');
  assert.equal(report.interval.exact, false);
  assert.deepEqual(report.interval.runsChanged, []);
  assert.match(report.interval.unavailable.join(' '), /no timestamps/i);
  assert.equal(report.references.inventory.count, 4);
  assert.match(report.references.inventory.label, /not interval changes/);
});

test('unchanged snapshot has no changed runs or done transitions', () => {
  const current = snapshot([run('run-old', 100, 100)], [
    task('run-old', 'm:1:0', 'item', ids.itemA, 'done'),
  ], 200);
  const report = buildIntervalReport(current, makeCheckpoint(current), { now: 300 });
  assert.deepEqual(report.interval.runsChanged, []);
  assert.equal(report.interval.totals.item.doneTransitions, 0);
});

test('resumed old run counts a failed to done transition', () => {
  const prior = snapshot([run('run-old', 100, 100, 'failed')], [
    task('run-old', 'm:1:0', 'invoice', ids.invoiceA, 'failed'),
  ], 200);
  const checkpoint = makeCheckpoint(prior);
  const current = snapshot([run('run-old', 100, 300, 'success')], [
    task('run-old', 'm:1:0', 'invoice', ids.invoiceA, 'done'),
  ], 300);
  const report = buildIntervalReport(current, checkpoint, { now: 300 });
  assert.equal(report.interval.runsChanged.length, 1);
  assert.equal(report.interval.runsChanged[0].resources.invoice.doneTransitions, 1);
  assert.equal(report.interval.runsChanged[0].resources.invoice.doneTransitionUniqueIdCount, 1);
});

test('exact compact applied count excludes already-done tasks in a changed run', () => {
  const prior = snapshot([run('run-old', 100, 100)], [
    task('run-old', 'm:1:0', 'item', ids.itemA, 'done'),
  ], 200);
  const current = snapshot([run('run-old', 100, 300)], [
    task('run-old', 'm:1:0', 'item', ids.itemA, 'done'),
    task('run-old', 'm:1:1', 'item', ids.itemB, 'done'),
  ], 300);
  const report = buildIntervalReport(current, makeCheckpoint(prior), { now: 300 });
  const compact = formatCliReport(report);
  assert.equal(compact.interval.resources.item.doneTasks, 1);
  assert.equal(compact.interval.resources.item.doneUniqueIds, 1);
  assert.equal(compact.interval.resources.item.operations.upsert.doneTasks, 1);
});

test('new runs report all current task statuses and deduplicate duplicate resource IDs', () => {
  const current = snapshot([run('run-new', 250, 290)], [
    task('run-new', 'm:1:0', 'item', ids.itemA, 'done'),
    task('run-new', 'm:1:1', 'item', ids.itemA, 'done'),
    task('run-new', 'm:1:2', 'item', ids.itemB, 'failed', 'delete'),
    task('run-new', 'm:1:3', 'item', ids.itemB, 'pending'),
  ], 300);
  const report = buildIntervalReport(current, {
    version: 1, observedAt: 200, accountBindingHash: 'a'.repeat(64), tasks: [],
  }, { now: 300 });
  const item = report.interval.runsChanged[0].resources.item;
  assert.equal(item.tasks.done, 2);
  assert.equal(item.tasks.failed, 1);
  assert.equal(item.tasks.pending, 1);
  assert.equal(item.uniqueIdCount, 2);
  assert.equal(item.doneTransitionUniqueIdCount, 1);
  assert.equal(typeof item.uniqueIdCount, 'number');
});

test('same ID in distinct resources remains distinct', () => {
  const current = snapshot([run('run-mixed', 250, 290)], [
    task('run-mixed', 'm:1:0', 'item', ids.itemA, 'done'),
    task('run-mixed', 'm:1:1', 'invoice', ids.itemA, 'done'),
  ], 300);
  const checkpoint = { version: 1, observedAt: 200, accountBindingHash: 'a'.repeat(64), tasks: [] };
  const totals = buildIntervalReport(current, checkpoint, { now: 300 }).interval.totals;
  assert.equal(totals.item.doneTransitions, 1);
  assert.equal(totals.invoice.doneTransitions, 1);
  assert.equal(totals.item.doneTransitionUniqueIdCount, 1);
  assert.equal(totals.invoice.doneTransitionUniqueIdCount, 1);
});

test('since cohort reports estimated current done totals and compact output contains no IDs', () => {
  const current = snapshot([run('run-cohort', 250, 290)], [
    task('run-cohort', 'm:1:0', 'item', ids.itemA, 'done'),
    task('run-cohort', 'm:1:1', 'item', ids.itemB, 'failed'),
  ], 300);
  const report = buildIntervalReport(current, null, { since: 200, now: 300 });
  assert.equal(report.interval.countsBasis, 'current_task_status_cohort_estimate');
  assert.equal(report.interval.totals.item.doneTransitions, null);
  assert.equal(report.interval.totals.item.operations.upsert.tasks, 1);
  const compact = formatCliReport(report);
  assert.equal(compact.interval.logicalRunsChanged, 1);
  assert.equal(compact.interval.resources.item.doneUniqueIds, 1);
  assert.equal(compact.interval.exact, false);
  assert.equal(JSON.stringify(compact).includes(ids.itemA), false);
});

test('failures, pending, and superseded statuses are retained in run aggregates', () => {
  const current = snapshot([run('run-status', 250, 290)], [
    task('run-status', 'm:1:0', 'item', ids.itemA, 'failed'),
    task('run-status', 'm:1:1', 'item', ids.itemB, 'pending'),
    task('run-status', 'm:1:2', 'item', ids.invoiceA, 'superseded'),
  ], 300);
  const item = buildIntervalReport(current, {
    version: 1, observedAt: 200, accountBindingHash: 'a'.repeat(64), tasks: [],
  }, { now: 300 }).interval.runsChanged[0].resources.item;
  assert.deepEqual(item.tasks, { pending: 1, waiting_children: 0, done: 0, superseded: 1, failed: 1 });
});

test('corrupt checkpoint is rejected, including duplicate keys and future timestamps', async () => {
  const duplicate = {
    version: 1, observedAt: 100, accountBindingHash: 'a'.repeat(64),
    tasks: [task('r', 't', 'item', ids.itemA, 'done'), task('r', 't', 'item', ids.itemA, 'done')],
  };
  assert.throws(() => validateCheckpoint(duplicate, 200), /duplicate/i);
  assert.throws(() => validateCheckpoint({ ...duplicate, tasks: [], observedAt: 201 }, 200), /future/i);
  const directory = await mkdtemp(join(tmpdir(), 'sync-interval-test-'));
  const path = join(directory, 'checkpoint.json');
  await writeFile(path, '{not-json', { mode: 0o600 });
  await assert.rejects(readCheckpoint(path, 200), /invalid/i);
  await rm(directory, { recursive: true, force: true });
});

test('checkpoint keys include run and task identity', () => {
  assert.equal(taskCheckpointKey({ runId: 'r1', taskId: 't1' }), 'r1:t1');
});

test('checkpoint retains pruned task keys so a later reappearance is not double-counted', () => {
  const prior = snapshot([run('old', 100, 100)], [
    task('old', 'm:1:0', 'item', ids.itemA, 'done'),
  ], 200);
  const retained = makeCheckpoint(prior);
  const later = snapshot([], [], 300);
  const next = makeCheckpoint(later, retained);
  assert.equal(next.tasks.length, 1);
  const reappeared = snapshot([run('old', 100, 400)], [
    task('old', 'm:1:0', 'item', ids.itemA, 'done'),
  ], 400);
  const report = buildIntervalReport(reappeared, next, { now: 400 });
  assert.equal(report.interval.runsChanged.length, 1);
  assert.deepEqual(report.interval.runsChanged[0].reasons, ['run_updated', 'run_state_changed']);
  assert.equal(report.interval.totals.item.doneTransitions, 0);
});

test('missing checkpoint metadata makes the interval non-exact and blocks checkpoint completeness', () => {
  const prior = snapshot([run('old', 100, 100)], [
    task('old', 'm:1:0', 'item', ids.itemA, 'done'),
  ], 200);
  const current = snapshot([], [], 300);
  const report = buildIntervalReport(current, makeCheckpoint(prior), { now: 300 });
  assert.equal(report.interval.exact, false);
  assert.equal(report.interval.checkpointComplete, false);
  assert.equal(report.interval.missingCheckpointTasks, 1);
  assert.equal(report.interval.missingCheckpointRuns, 1);
});

test('reports official partial coverage, OC warnings, and failed legacy diagnostics separately', () => {
  const current = snapshot([run('official-success', 250, 290)], [
    task('official-success', 'm:1:0', 'estimate', ids.itemA, 'done'),
  ], 300);
  current.officialAuthority = {
    authority: 'official_v3', status: 'available', syncHealth: 'healthy', freshness: 'FRESH',
    lastAppliedAt: 290, lastAttemptAt: 290, coverage: 'partial_catch_up',
  };
  current.ocShipping = { status: 'success_with_warnings', failed: 4 };
  current.ocShippingWarningCount = 4;
  current.legacy = { state: { lastSync: 100 }, syncStatus: { status: 'failed' } };
  const compact = formatCliReport(buildIntervalReport(current, null, { since: 200, now: 300 }));
  assert.equal(compact.latestHealth.official.coverage, 'partial_catch_up');
  assert.equal(compact.ocShipping.persistedWarningCount, 4);
  assert.equal(compact.ocShipping.failed, 4);
  assert.equal(compact.legacy.activity, 'inactive_legacy');
  assert.equal(compact.legacy.syncStatus, 'failed');
  assert.equal(compact.references.payments.excludedFromOfficialCoverage, true);
  const markdown = formatMarkdownReport(buildIntervalReport(current, null, { since: 200, now: 300 }));
  assert.match(markdown, /coverage=partial_catch_up/);
  assert.match(markdown, /persisted warnings=4/);
  assert.equal(markdown.includes(ids.itemA), false);
});

test('keeps official failure and current 280 pending tasks visible', () => {
  const pending = Array.from({ length: 280 }, (_, index) =>
    task('official-failed', `m:1:${index}`, 'item', `${ids.itemA.slice(0, -3)}${String(index).padStart(3, '0')}`, 'pending')
  );
  const current = snapshot([run('official-failed', 250, 290, 'failed')], pending, 300);
  current.currentRun = current.runs[0];
  current.officialAuthority = {
    authority: 'official_v3', status: 'available', syncHealth: 'failed', freshness: 'STALE',
    lastAppliedAt: null, lastAttemptAt: 290, coverage: 'partial_catch_up',
  };
  const compact = formatCliReport(buildIntervalReport(current, null, { since: 200, now: 300 }));
  assert.equal(compact.latestHealth.status, 'failed');
  assert.equal(compact.latestHealth.official.lastAppliedAt, null);
  assert.equal(compact.latestHealth.taskCounts.item.pendingTasks, 280);
});

test('Markdown separates interval activity from current official tasks and preserves running references', () => {
  const runs = [run('current', 1_790_000_000, 1_790_000_100)];
  for (let index = 1; index <= 70; index += 1) runs.push(run(`success-${index}`, 1_790_000_000, 1_790_000_100));
  runs.push(run('failed-run', 1_790_000_000, 1_790_000_100, 'failed'));
  const tasks = [];
  const add = (runId, resource, status, count) => {
    for (let index = 0; index < count; index += 1) {
      tasks.push(task(runId, `${resource}:${status}:${index}:${tasks.length}`, resource,
        `${ids.itemA.slice(0, -3)}${String(tasks.length % 1000).padStart(3, '0')}`, status));
    }
  };
  add('current', 'item', 'done', 10); add('current', 'invoice', 'done', 8);
  add('current', 'estimate', 'done', 4); add('current', 'purchase_order', 'done', 5);
  add('current', 'item', 'pending', 69); add('current', 'invoice', 'pending', 169);
  add('current', 'estimate', 'pending', 20); add('current', 'purchase_order', 'pending', 43);
  add('success-1', 'item', 'done', 5);
  const current = snapshot(runs, tasks, 1_790_000_200);
  current.currentRun = runs[0];
  current.officialAuthority = {
    authority: 'official_v3', status: 'available', syncHealth: 'incomplete', freshness: 'STALE',
    lastAppliedAt: null, lastAttemptAt: 1_790_000_100, coverage: 'partial_catch_up',
  };
  current.refs.refresh = { run: { status: 'running' }, resources: {
    categories: { outcome: 'failed' }, accounts: { outcome: 'success' },
    users: { outcome: 'warning' }, payments: { outcome: 'failed' },
  } };
  const markdown = formatMarkdownReport(buildIntervalReport(current, null, { since: 1_789_999_900, now: 1_790_000_200 }));
  assert.match(markdown, /Observed: 2026-09-21T/);
  assert.match(markdown, /ICT/);
  assert.match(markdown, /checkpoint complete=true/);
  assert.match(markdown, /logical runs=72 \(failed=1, success=71\)/);
  assert.match(markdown, /reference run in progress; resource outcomes are provisional \(categories=failed, accounts=success, users=warning, payments=failed\)/);
  assert.match(markdown, /Interval activity/);
  assert.match(markdown, /Current official run task state/);
  assert.equal((markdown.match(/\| --- \| ---: \| ---: \| ---: \| ---: \|/g) ?? []).length, 2);
  assert.match(markdown, /done=32/);
  assert.match(markdown, /\| item \| 15 \| 15 \| 0 \| 69 \|/);
  assert.match(markdown, /\| item \| 10 \| 10 \| 0 \| 69 \|/);
  assert.match(markdown, /\| invoice \| 8 \| 8 \| 0 \| 169 \|/);
});

test('database snapshot uses the shared official authority projection without exposing cursors', async () => {
  const accountIdentity = 'salesbinder:example';
  const metadata = [
    ['official_v3_sync.state.v1', {
      version: 1, accountIdentity, resources: ['item'], ingestionCursor: 'cursor-secret',
      appliedCursor: 'cursor-secret', appliedGeneration: 1, nextGeneration: 2,
      coverage: 'partial_catch_up', updatedAt: 290,
    }],
    ['official_v3_sync.current_run.v1', {
      version: 1, accountIdentity, runId: 'run-1', entry: { kind: 'cursor', value: 'cursor-secret' },
      status: 'success', ingestionComplete: true, pageCount: 1, startedAt: 250, updatedAt: 290, finishedAt: 290,
    }],
    ['official_v3_sync.run.v1:run-1', {
      version: 1, accountIdentity, runId: 'run-1', entry: { kind: 'cursor', value: 'cursor-secret' },
      status: 'success', ingestionComplete: true, pageCount: 1, startedAt: 250, updatedAt: 290, finishedAt: 290,
    }],
    ['official_v3_sync.task.v1:run-1:m:1:0', {
      runId: 'run-1', taskId: 'm:1:0', resource: 'item', id: 'record-secret', status: 'done', operation: 'upsert',
    }],
    ['oc_shipping.reconciliation_status.v1', {
      version: 1, accountIdentity, status: 'success_with_warnings', startedAt: 250, updatedAt: 290,
      scanned: 4, applied: 0, failed: 4,
    }],
    ['oc_shipping.warning.v1:4:warning-secret', { code: 'shipping_unknown' }],
    ['state', { lastSync: 100 }],
    ['sync_status', { status: 'failed' }],
  ].map(([key, value]) => ({ key, value: JSON.stringify(value) }));
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('cache_account_binding')) return { rows: [{ account_identity: accountIdentity }] };
      if (sql.includes('SELECT key, value FROM cache_meta')) return { rows: metadata };
      if (sql.includes('COUNT(*)::bigint')) return { rows: [{ count: '4' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const compact = formatCliReport(buildIntervalReport(await snapshotDatabase(client, 300), null, { since: 200, now: 300 }));
  assert.equal(compact.latestHealth.official.syncHealth, 'healthy');
  assert.equal(compact.latestHealth.official.coverage, 'partial_catch_up');
  assert.equal(compact.ocShipping.persistedWarningCount, 1);
  assert.equal(compact.legacy.activity, 'inactive_legacy');
  const serialized = JSON.stringify(compact);
  assert.equal(serialized.includes('cursor-secret'), false);
  assert.equal(serialized.includes('record-secret'), false);
});

test('audit evidence is immutable and a failed current checkpoint write preserves the established checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sync-interval-audit-test-'));
  const path = join(directory, 'checkpoint.json');
  const prior = makeCheckpoint(snapshot([run('prior')], [task('prior', 'm:1:0', 'item', ids.itemA, 'done')], 200));
  await writeCheckpoint(path, prior);
  const current = snapshot([run('current', 250, 290)], [task('current', 'm:1:1', 'item', ids.itemB, 'done')], 300);
  const report = buildIntervalReport(current, prior, { now: 300 });
  const next = makeCheckpoint(current, prior);
  await assert.rejects(
    saveCheckpointWithAudit(path, next, report, {
      previousCheckpoint: prior,
      writeCurrent: async () => { throw new Error('simulated checkpoint replacement failure'); },
    }),
    /simulated/i
  );
  assert.deepEqual(await readCheckpoint(path, 300), prior);
  const auditDirectory = `${path}.audit`;
  const files = await readdir(auditDirectory);
  assert.equal(files.filter((file) => file.endsWith('.report.json')).length, 1);
  assert.equal(files.filter((file) => file.endsWith('.previous-checkpoint.json')).length, 1);
  const reportFile = files.find((file) => file.endsWith('.report.json'));
  const savedReport = await readFile(join(auditDirectory, reportFile), 'utf8');
  assert.equal(savedReport.includes(ids.itemA), false);
  assert.equal(savedReport.includes(ids.itemB), false);
  assert.equal((await lstat(join(auditDirectory, reportFile))).mode & 0o077, 0);
  await rm(directory, { recursive: true, force: true });
});

test('successful audit save retains prior checkpoint evidence before advancing the current checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sync-interval-audit-success-test-'));
  const path = join(directory, 'checkpoint.json');
  const prior = makeCheckpoint(snapshot([run('prior')], [task('prior', 'm:1:0', 'item', ids.itemA, 'done')], 200));
  await writeCheckpoint(path, prior);
  const current = snapshot([run('current', 250, 290)], [task('current', 'm:1:1', 'item', ids.itemB, 'done')], 300);
  const report = buildIntervalReport(current, prior, { now: 300 });
  const next = makeCheckpoint(current, prior);
  await saveCheckpointWithAudit(path, next, report, { previousCheckpoint: prior });
  assert.deepEqual(await readCheckpoint(path, 300), next);
  const files = await readdir(`${path}.audit`);
  const priorFile = files.find((file) => file.endsWith('.previous-checkpoint.json'));
  assert.deepEqual(validateCheckpoint(JSON.parse(await readFile(join(`${path}.audit`, priorFile), 'utf8')), 300), prior);
  await assert.rejects(saveCheckpointWithAudit(path, next, report, { previousCheckpoint: prior }), /exist/i);
  assert.deepEqual(await readCheckpoint(path, 300), next);
  await rm(directory, { recursive: true, force: true });
});

const deletionEvent = (runId, taskId, resource, id, operation, observedAt, stockHistory = 'not_applicable') => ({
  version: 1, runId, taskId, resource, id, operation, observedAt, stockHistory,
  uncertainty: stockHistory === 'unknown' ? 'stock_history_missing' : null,
});

test('deletion events survive resume without duplicate alerts while unknown stock remains visible', () => {
  const prior = snapshot([], [], 200);
  prior.deletionEvents = [];
  const event = deletionEvent('r', 't:1', 'item', ids.itemA, 'absent', 250, 'unknown');
  const current = { ...snapshot([], [], 300), deletionEvents: [event] };
  const report = buildIntervalReport(current, makeCheckpoint(prior), { now: 300 });
  assert.deepEqual(report.deletions.events, [{ resource: 'item', operation: 'absent', observedAt: 250, stockHistory: 'unknown' }]);
  assert.equal(report.deletions.unknownStockWarnings.length, 1);
  const markdown = formatMarkdownReport(report);
  assert.match(markdown, /verified item absence/);
  assert.match(markdown, /stock history=unknown/);
  assert.match(markdown, /not the source deletion time/);
  assert.equal(markdown.includes(ids.itemA), false);
  assert.equal(JSON.stringify(formatCliReport(report)).includes(ids.itemA), false);
  const resumed = buildIntervalReport({ ...current, observedAt: 400 }, makeCheckpoint(current), { now: 400 });
  assert.equal(resumed.deletions.events.length, 0);
  assert.equal(resumed.deletions.unknownStockWarnings.length, 1);
});

test('each repeated deletion event is reported independently and retains operation distinction', () => {
  const first = deletionEvent('r1', 't', 'invoice', ids.invoiceA, 'delete', 250);
  const second = deletionEvent('r2', 't', 'invoice', ids.invoiceA, 'delete', 350);
  const prior = { ...snapshot([], [], 300), deletionEvents: [first] };
  const current = { ...snapshot([], [], 400), deletionEvents: [first, second] };
  const report = buildIntervalReport(current, makeCheckpoint(prior), { now: 400 });
  assert.equal(report.deletions.events.length, 1);
  assert.equal(report.deletions.events[0].observedAt, 350);
  assert.match(formatMarkdownReport(report), /confirmed delete/);
});

test('legacy and first baselines disclose incomplete history and retain boundary events', () => {
  const old = deletionEvent('r1', 't', 'item', ids.itemA, 'delete', 100, 'unknown');
  const boundary = deletionEvent('r2', 't', 'item', ids.itemB, 'absent', 200, 'unknown');
  const current = { ...snapshot([], [], 300), deletionEvents: [old, boundary] };
  const legacy = { version: 1, observedAt: 200, accountBindingHash: 'a'.repeat(64), tasks: [], runs: [] };
  const report = buildIntervalReport(current, legacy, { now: 300 });
  assert.equal(report.deletions.history, 'legacy_checkpoint_history_incomplete');
  assert.equal(report.deletions.events.length, 2);
  assert.equal(report.deletions.events[1].observedAt, 200);
  assert.equal(report.deletions.unknownStockWarnings.length, 2);
  const baseline = buildIntervalReport(current, null, { now: 300 });
  assert.equal(baseline.deletions.history, 'baseline_history_unavailable');
  assert.equal(baseline.deletions.events.length, 2);
  assert.equal(makeCheckpoint(current, legacy).deletionEvents.length, 2);
});

test('missing or changed immutable event blocks checkpoint advancement and preserves unknown warning', () => {
  const event = deletionEvent('r', 't', 'item', ids.itemA, 'absent', 250, 'unknown');
  const checkpoint = makeCheckpoint({ ...snapshot([], [], 300), deletionEvents: [event] });
  const missing = buildIntervalReport({ ...snapshot([], [], 400), deletionEvents: [] }, checkpoint, { now: 400 });
  assert.equal(missing.interval.checkpointComplete, false);
  assert.equal(missing.deletions.history, 'retained_events_missing');
  assert.equal(missing.deletions.unknownStockWarnings.length, 1);
  const changed = buildIntervalReport({ ...snapshot([], [], 400), deletionEvents: [{ ...event, observedAt: 260 }] }, checkpoint, { now: 400 });
  assert.equal(changed.interval.checkpointComplete, false);
  assert.equal(changed.deletions.history, 'retained_events_changed');
});

test('database snapshot reads and validates deletion event metadata in the read-only transaction', async () => {
  const event = deletionEvent('r', 't:1', 'item', ids.itemA, 'absent', 250, 'unknown');
  const queries = [];
  const client = { async query(sql, params) {
    queries.push(sql);
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('cache_account_binding')) return { rows: [{ account_identity: 'salesbinder:example' }] };
    if (sql.includes('SELECT key, value FROM cache_meta')) {
      assert.ok(params.includes('official_v3_sync.deletion_event.v1:'));
      return { rows: [{ key: 'official_v3_sync.deletion_event.v1:r:t:1', value: JSON.stringify(event) }] };
    }
    if (sql.includes('COUNT(*)::bigint')) return { rows: [{ count: '0' }] };
    throw new Error('Unexpected query');
  } };
  const result = await snapshotDatabase(client, 300);
  assert.deepEqual(result.deletionEvents, [event]);
  assert.ok(queries[0].includes('READ ONLY'));
  assert.equal(queries.at(-1), 'COMMIT');
});

test('document deletions may carry unknown stock history and a missing observation time is rejected', () => {
  const document = deletionEvent('r', 't', 'invoice', ids.invoiceA, 'delete', 250, 'unknown');
  const current = { ...snapshot([], [], 300), deletionEvents: [document] };
  const checkpoint = makeCheckpoint(current);
  assert.doesNotThrow(() => validateCheckpoint(checkpoint, 300));
  const report = buildIntervalReport(current, null, { now: 300 });
  assert.equal(report.deletions.unknownStockWarnings[0].resource, 'invoice');
  assert.match(formatMarkdownReport(report), /invoice: confirmed delete/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, deletionEvents: [{ ...document, observedAt: undefined }] }, 300), /invalid/i);
});

test('since selection filters baseline observations but preserves unknown-stock warnings', () => {
  const old = deletionEvent('r', 'old', 'item', ids.itemA, 'delete', 100, 'unknown');
  const recent = deletionEvent('r', 'new', 'item', ids.itemB, 'absent', 250, 'unknown');
  const current = { ...snapshot([], [], 300), deletionEvents: [old, recent] };
  const report = buildIntervalReport(current, null, { now: 300, since: 200 });
  assert.equal(report.deletions.events.length, 1);
  assert.equal(report.deletions.events[0].observedAt, 250);
  assert.equal(report.deletions.unknownStockWarnings.length, 2);
});

const sourceEvent = (id, recordId = 'source-record-secret') => ({
  id: String(id), contextId: 5, recordId, created: '2026-10-20 12:00:00',
});
const sourceScan = (time, status, events = [], since = 1) => ({
  scanStartedAt: time, since, contexts: [{ contextId: 5, resource: 'invoice', status, events }],
});

test('source baseline is disclosed, then overlap uses log IDs to avoid repeated notices', () => {
  const scan = sourceScan(700_000, 'complete', [sourceEvent(1)]);
  const current = { ...snapshot([], [], 700_000), deletedLog: scan };
  const first = buildIntervalReport(current, null, { now: 700_000 });
  const source = first.deletedLog.contexts.find((context) => context.resource === 'invoice');
  assert.equal(source.baseline, true);
  assert.equal(source.events.length, 1);
  assert.match(formatMarkdownReport(first), /baseline records=1/);
  assert.equal(formatMarkdownReport(first).includes('source-record-secret'), false);
  assert.equal(JSON.stringify(formatCliReport(first)).includes('source-record-secret'), false);
  const checkpoint = makeCheckpoint(current);
  const nextScan = sourceScan(700_300, 'complete', [sourceEvent(1), sourceEvent(2)]);
  const next = buildIntervalReport({ ...snapshot([], [], 700_300), deletedLog: nextScan }, checkpoint, { now: 700_300 });
  const nextSource = next.deletedLog.contexts.find((context) => context.resource === 'invoice');
  assert.equal(nextSource.baseline, false);
  assert.equal(nextSource.events.length, 1);
  assert.equal(deletedLogSince(checkpoint, 700_300), 1); // Other contexts have not completed their first scan.
  const persisted = makeCheckpoint({ ...snapshot([], [], 700_300), deletedLog: nextScan }, checkpoint);
  assert.equal(persisted.deletedLog.contexts[0].events.length, 2);
  assert.equal(summarizeDeletedLog(nextScan, persisted.deletedLog).contexts[0].events.length, 0);
});

test('source context failure retains watermark and source evidence while another succeeds', () => {
  const prior = mergeDeletedLog(sourceScan(700_000, 'complete', [sourceEvent(1)]));
  const scan = { scanStartedAt: 700_300, since: 1, contexts: [
    { contextId: 5, resource: 'invoice', status: 'unavailable', events: [] },
    { contextId: 4, resource: 'estimate', status: 'complete', events: [] },
  ] };
  const next = mergeDeletedLog(scan, prior);
  assert.equal(next.contexts.find((context) => context.resource === 'invoice').watermark, 700_000);
  assert.equal(next.contexts.find((context) => context.resource === 'invoice').events.length, 1);
  assert.equal(next.contexts.find((context) => context.resource === 'estimate').watermark, 700_300);
  const summary = summarizeDeletedLog(scan, prior);
  assert.equal(summary.contexts.find((context) => context.resource === 'invoice').status, 'unavailable');
  assert.equal(summary.contexts.find((context) => context.resource === 'estimate').coverage, 'bounded_scan_complete');
});

test('inconsistent source event keeps prior evidence and never advances the context', () => {
  const prior = mergeDeletedLog(sourceScan(700_000, 'complete', [sourceEvent(1)]));
  const scan = sourceScan(700_300, 'complete', [sourceEvent(1, 'different-record')]);
  assert.deepEqual(mergeDeletedLog(scan, prior), prior);
  assert.equal(summarizeDeletedLog(scan, prior).contexts[0].status, 'incomplete');
});

test('failed initial source scan retains its original window through outages longer than a week', () => {
  const legacy = { version: 1, observedAt: 1_000_000, accountBindingHash: 'a'.repeat(64), tasks: [] };
  const firstSince = deletedLogSince(legacy, 1_000_100);
  assert.equal(firstSince, 395_200);
  const firstScan = sourceScan(1_000_100, 'unavailable', [], firstSince);
  let checkpoint = makeCheckpoint({ ...snapshot([], [], 1_000_100), deletedLog: firstScan }, legacy);
  assert.equal(validateCheckpoint(checkpoint, 1_000_100), checkpoint);
  assert.equal(checkpoint.deletedLog.pending.find((context) => context.resource === 'invoice').since, firstSince);
  for (const now of [1_700_000, 2_500_000]) {
    const since = deletedLogSince(checkpoint, now);
    assert.equal(since, firstSince);
    checkpoint = makeCheckpoint({ ...snapshot([], [], now), deletedLog: sourceScan(now, 'unavailable', [], since) }, checkpoint);
  }
  const recoveryAt = 3_000_000;
  const recovery = sourceScan(recoveryAt, 'complete', [sourceEvent(100)], deletedLogSince(checkpoint, recoveryAt));
  const report = buildIntervalReport({ ...snapshot([], [], recoveryAt), deletedLog: recovery }, checkpoint, { now: recoveryAt });
  const invoice = report.deletedLog.contexts.find((context) => context.resource === 'invoice');
  assert.equal(invoice.baseline, true);
  assert.equal(invoice.events.length, 1);
  checkpoint = makeCheckpoint({ ...snapshot([], [], recoveryAt), deletedLog: recovery }, checkpoint);
  assert.equal(checkpoint.deletedLog.contexts.find((context) => context.resource === 'invoice').watermark, recoveryAt);
  assert.equal(checkpoint.deletedLog.pending.some((context) => context.resource === 'invoice'), false);
  assert.equal(deletedLogSince(checkpoint, recoveryAt + 10), firstSince); // Other failed contexts retain the same original bound.
});

test('a source scan that skips a retained initial boundary cannot advance it', () => {
  const first = sourceScan(1_000_000, 'unavailable', [], 395_000);
  const prior = mergeDeletedLog(first);
  const skipped = sourceScan(2_000_000, 'complete', [sourceEvent(1)], 1_000_000);
  assert.deepEqual(mergeDeletedLog(skipped, prior), prior);
  assert.equal(summarizeDeletedLog(skipped, prior).contexts[0].status, 'incomplete');
});
