import { createHash, randomUUID } from 'node:crypto';
import type {
  OfficialV3SyncDependencies,
  OfficialV3SyncOptions,
  OfficialV3SyncProgress,
  OfficialV3SyncResult,
} from './official-v3-sync.contracts.js';
import { fatalOfficialV3Failure, OfficialV3SyncError } from './official-v3-sync-failure.js';
import {
  OFFICIAL_V3_SYNC_RESOURCES,
  type OfficialV3SyncPageEnvelope,
  type OfficialV3SyncRun,
  type OfficialV3SyncTask,
} from './official-v3-sync.types.js';
import { sanitizeOfficialV3SyncRun } from './official-v3-sync-status.js';
import { drainOfficialV3Tasks } from './official-v3-sync-task-runner.js';
import { hasAsciiControlCharacter } from './official-v3-sync.validation.js';

const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_MAX_PAGES = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

export type {
  OfficialV3SyncDependencies,
  OfficialV3SyncOptions,
  OfficialV3SyncProgress,
  OfficialV3SyncResult,
} from './official-v3-sync.contracts.js';
export { OfficialV3SyncError } from './official-v3-sync-failure.js';

export class OfficialV3SyncService {
  constructor(private readonly deps: OfficialV3SyncDependencies) {}

  async sync(options: OfficialV3SyncOptions): Promise<OfficialV3SyncResult> {
    try {
      return await this.execute(options);
    } catch (error) {
      throw error instanceof OfficialV3SyncError
        ? error
        : new OfficialV3SyncError(fatalOfficialV3Failure(error));
    }
  }

  private async execute(options: OfficialV3SyncOptions): Promise<OfficialV3SyncResult> {
    validateOptions(options);
    const now = this.deps.now ?? (() => Math.floor(Date.now() / 1000));
    const guard = async () => {
      await this.deps.guard?.();
    };
    await guard();
    const existingState = await this.deps.store.getState();
    const existingRun = await this.deps.store.getRun();
    if (existingState && existingState.accountIdentity !== options.accountIdentity) {
      throw new OfficialV3SyncError('account_mismatch');
    }
    if (existingRun && existingRun.accountIdentity !== options.accountIdentity) {
      throw new OfficialV3SyncError('account_mismatch');
    }
    const run = await this.openRun(options, existingState, existingRun, now());
    try {
      await this.ingest(run, guard);
      const executionDeps = {
        ...this.deps,
        categoryNames:
          this.deps.categoryNames !== undefined
            ? this.deps.categoryNames
            : await this.deps.loadCategoryNames?.(),
      };
      await drainOfficialV3Tasks({
        deps: executionDeps,
        runId: run.runId,
        now,
        guard,
        progress: (event) => this.progress(run.runId, 'tasks', event, options),
      });
      await this.deps.store.advanceAppliedPrefix(run.runId);
      const result = await this.project(run);
      const failed = result.tasks.failed + result.tasks.pending;
      const finished: OfficialV3SyncRun = {
        ...run,
        status: failed === 0 && !result.state.cursorGap ? 'success' : 'success_with_warnings',
        updatedAt: now(),
        finishedAt: now(),
      };
      delete finished.errorCode;
      await guard();
      await this.deps.store.finishRun(finished);
      await this.progress(finished.runId, 'complete', finished.status, options);
      return this.project(finished);
    } catch (error) {
      const code = fatalOfficialV3Failure(error);
      const failedRun: OfficialV3SyncRun = {
        ...run,
        status: 'failed',
        errorCode: code,
        updatedAt: now(),
        finishedAt: now(),
      };
      try {
        await guard();
        await this.deps.store.finishRun(failedRun);
      } catch {
        throw new OfficialV3SyncError('checkpoint_failed');
      }
      throw new OfficialV3SyncError(code);
    }
  }

  private async openRun(
    options: OfficialV3SyncOptions,
    state: Awaited<ReturnType<OfficialV3SyncDependencies['store']['getState']>>,
    run: OfficialV3SyncRun | null,
    timestamp: number
  ): Promise<OfficialV3SyncRun> {
    if (options.resume) {
      if (!run && !state?.ingestionCursor) throw new OfficialV3SyncError('no_run_to_resume');
      if (run && run.status === 'running') return run;
      if (run && run.status === 'success') return run;
      if (run) {
        const entry =
          run.ingestionComplete || run.pageCount > 0
            ? cursorEntry(state?.ingestionCursor)
            : run.entry;
        if (!entry.value) throw new OfficialV3SyncError('resume_cursor_missing');
        const resumed: OfficialV3SyncRun = {
          ...run,
          entry,
          status: 'running',
          ingestionComplete: false,
          updatedAt: timestamp,
        };
        delete resumed.errorCode;
        delete resumed.finishedAt;
        await this.deps.store.beginRun(resumed);
        return resumed;
      }
      return this.createRun(options.accountIdentity, { kind: 'cursor', value: state!.ingestionCursor! }, timestamp);
    }
    if (options.since !== undefined) {
      if (state) throw new OfficialV3SyncError('since_state_exists');
      return this.createRun(options.accountIdentity, { kind: 'since', value: String(options.since) }, timestamp);
    }
    if (run && run.status !== 'success') throw new OfficialV3SyncError('resume_required');
    if (!state?.appliedCursor) throw new OfficialV3SyncError('since_required');
    return this.createRun(options.accountIdentity, { kind: 'cursor', value: state.appliedCursor }, timestamp);
  }

  private async createRun(
    accountIdentity: string,
    entry: OfficialV3SyncRun['entry'],
    timestamp: number
  ): Promise<OfficialV3SyncRun> {
    const run: OfficialV3SyncRun = {
      version: 1,
      runId: randomUUID(),
      accountIdentity,
      entry,
      status: 'running',
      ingestionComplete: false,
      pageCount: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.deps.store.beginRun(run);
    return run;
  }

  private async ingest(run: OfficialV3SyncRun, guard: () => Promise<void>): Promise<void> {
    const pageLimit = bounded(this.deps.pageLimit, DEFAULT_PAGE_LIMIT, 1, 500);
    const maxPages = bounded(this.deps.maxPagesPerRun, DEFAULT_MAX_PAGES, 1, 10_000);
    let pagesRead = 0;
    for (;;) {
      const latest = await this.deps.store.getRun();
      if (!latest || latest.runId !== run.runId) throw new OfficialV3SyncError('run_lost');
      Object.assign(run, latest);
      if (run.ingestionComplete) return;
      if (pagesRead >= maxPages) throw new OfficialV3SyncError('page_limit_exceeded');
      await guard();
      const state = await this.deps.store.getState();
      const cursor = run.pageCount === 0 ? run.entry.value : state?.ingestionCursor;
      const request = run.pageCount === 0 ? run.entry : { kind: 'cursor' as const, value: cursor ?? run.entry.value };
      const read =
        run.pageCount === 0 && run.entry.kind === 'since'
          ? { since: run.entry.value, resources: OFFICIAL_V3_SYNC_RESOURCES, limit: pageLimit }
          : { cursor: cursor ?? run.entry.value, limit: pageLimit };
      const response = await this.deps.sync.read(read);
      validatePageResponse(response);
      const responseText = JSON.stringify(response);
      if (responseText.length > bounded(this.deps.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 10_000_000)) {
        throw new OfficialV3SyncError('response_too_large');
      }
      const pageNumber = run.pageCount + 1;
      const sealed = await this.deps.store.sealPage(
        run.runId,
        run.pageCount === 0 ? request : { kind: 'cursor', value: cursor ?? run.entry.value },
        {
          runId: run.runId,
          page: pageNumber,
          nextCursor: response.next_cursor,
          hasMore: response.has_more,
          markerCount: response.changes.length,
          responseHash: `sha256:${createHash('sha256').update(responseText).digest('hex')}`,
        },
        response.changes
      );
      Object.assign(run, sealed);
      pagesRead++;
      await this.progress(run.runId, 'ingestion', 'page_sealed');
      if (!response.has_more) return;
    }
  }

  private async project(run: OfficialV3SyncRun): Promise<OfficialV3SyncResult> {
    const state = await this.deps.store.getState();
    const tasks = await this.deps.store.listTasks(run.runId);
    const counts = countTasks(tasks);
    return {
      run: sanitizeOfficialV3SyncRun(run),
      state: state
        ? {
            version: state.version,
            accountIdentity: state.accountIdentity,
            resources: state.resources,
            appliedGeneration: state.appliedGeneration,
            nextGeneration: state.nextGeneration,
            coverage: state.coverage,
            updatedAt: state.updatedAt,
            hasIngestionCursor: !!state.ingestionCursor,
            hasAppliedCursor: !!state.appliedCursor,
            cursorGap: state.ingestionCursor !== state.appliedCursor,
          }
        : {
            version: 1,
            accountIdentity: run.accountIdentity,
            resources: OFFICIAL_V3_SYNC_RESOURCES,
            appliedGeneration: 0,
            nextGeneration: 0,
            coverage: 'partial_catch_up',
            updatedAt: run.updatedAt,
            hasIngestionCursor: false,
            hasAppliedCursor: false,
            cursorGap: true,
          },
      tasks: counts,
      failures: tasks
        .filter((task) => task.status === 'failed')
        .map((task) => ({
          taskId: task.taskId,
          resource: task.resource,
          id: task.id,
          code: task.errorCode ?? 'failed',
        })),
      coverage: 'partial_catch_up',
    };
  }

  private async progress(
    runId: string,
    phase: OfficialV3SyncProgress['phase'],
    event: string,
    options?: OfficialV3SyncOptions
  ): Promise<void> {
    const tasks = await this.deps.store.listTasks(runId).catch(() => []);
    const counts = countTasks(tasks);
    (options?.onProgress ?? this.deps.onProgress)?.({
      runId,
      phase,
      event,
      completed: counts.applied + counts.superseded,
      total: counts.discovered,
      failed: counts.failed,
    });
  }
}

function validateOptions(options: OfficialV3SyncOptions): void {
  if (!/^salesbinder:[a-z0-9-]+$/.test(options.accountIdentity)) {
    throw new OfficialV3SyncError('invalid_account');
  }
  if (options.resume && options.since !== undefined) throw new OfficialV3SyncError('invalid_options');
  if (
    options.since !== undefined &&
    !(
      (typeof options.since === 'number' && Number.isSafeInteger(options.since) && options.since >= 0) ||
      (typeof options.since === 'string' &&
        options.since.length > 0 &&
        options.since.length <= 128 &&
        !hasAsciiControlCharacter(options.since))
    )
  ) {
    throw new OfficialV3SyncError('invalid_since');
  }
}

function cursorEntry(value: string | undefined): { kind: 'cursor'; value: string } {
  if (!value) throw new OfficialV3SyncError('resume_cursor_missing');
  return { kind: 'cursor', value };
}

function validatePageResponse(response: OfficialV3SyncPageEnvelope): void {
  if (response.object !== 'sync_page') throw new OfficialV3SyncError('invalid_envelope');
  if (response.changes.length > 500) throw new OfficialV3SyncError('marker_limit_exceeded');
}

function countTasks(tasks: OfficialV3SyncTask[]) {
  return {
    discovered: tasks.length,
    applied: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    pending: tasks.filter((task) => task.status === 'pending' || task.status === 'waiting_children')
      .length,
    superseded: tasks.filter((task) => task.status === 'superseded').length,
  };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new OfficialV3SyncError('invalid_bounds');
  }
  return value;
}
