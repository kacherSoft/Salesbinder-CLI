import { randomUUID } from 'node:crypto';
import type { DocumentOffsetRun, DocumentOffsetTask } from './document-offset-sync.types.js';
import type {
  DocumentOffsetSyncDependencies,
  DocumentOffsetSyncOptions,
  DocumentOffsetSyncResult,
  DocumentOffsetTaskCounts,
  OffsetExecution,
} from './document-offset-sync.contracts.js';
import { DocumentOffsetSyncError, fatalOffsetFailure } from './document-offset-failure.js';
import { discoverOffsetDocuments } from './document-offset-discovery.js';
import { drainOffsetTasks } from './document-offset-task-runner.js';

export type {
  DocumentOffsetSyncDependencies,
  DocumentOffsetSyncOptions,
  DocumentOffsetSyncProgress,
  DocumentOffsetSyncResult,
  DocumentOffsetTaskCounts,
} from './document-offset-sync.contracts.js';
export { DocumentOffsetSyncError } from './document-offset-failure.js';

export class DocumentOffsetSyncService {
  constructor(private readonly deps: DocumentOffsetSyncDependencies) {}

  async sync(options: DocumentOffsetSyncOptions): Promise<DocumentOffsetSyncResult> {
    try {
      return await this.execute(options);
    } catch (error) {
      throw error instanceof DocumentOffsetSyncError
        ? error
        : new DocumentOffsetSyncError(fatalOffsetFailure(error));
    }
  }

  private async execute(options: DocumentOffsetSyncOptions): Promise<DocumentOffsetSyncResult> {
    const days = options.days ?? 30;
    if (!Number.isSafeInteger(days) || days < 1 || days > 365)
      throw new DocumentOffsetSyncError('invalid_days');
    if (!/^salesbinder:[a-z0-9-]+$/.test(options.accountIdentity))
      throw new DocumentOffsetSyncError('invalid_account');
    const now = this.deps.now ?? (() => Math.floor(Date.now() / 1000));
    const guard = async () => {
      await this.deps.guard?.();
    };
    await guard();
    const existing = await this.deps.store.getOffsetSyncRun();
    if (existing && existing.accountIdentity !== options.accountIdentity)
      throw new DocumentOffsetSyncError('account_mismatch');
    if (existing && existing.status !== 'success' && !options.resume)
      throw new DocumentOffsetSyncError('resume_required');
    if (options.resume && !existing) throw new DocumentOffsetSyncError('no_run_to_resume');
    if (options.resume && existing?.status === 'success') return this.result(existing);
    if (options.resume && existing && options.days !== undefined && existing.days !== days)
      throw new DocumentOffsetSyncError('resume_days_mismatch');
    const startedAt = now();
    const run: DocumentOffsetRun =
      options.resume && existing
        ? { ...existing }
        : {
            version: 1,
            runId: randomUUID(),
            accountIdentity: options.accountIdentity,
            startedAt,
            cutoff: Math.max(0, startedAt - days * 86_400),
            days,
            updatedAt: startedAt,
            discoveryComplete: false,
            status: 'running',
          };
    run.status = 'running';
    if (
      options.resume &&
      (await this.deps.store.listOffsetSyncTasks(run.runId, 'document')).some(
        (task) => task.errorCode === 'invalid_selection_record' && task.status !== 'done'
      )
    ) {
      run.discoveryComplete = false;
    }
    run.updatedAt = now();
    delete run.errorCode;
    delete run.finishedAt;
    await guard();
    await this.deps.store.saveOffsetSyncRun(run);
    const execution: OffsetExecution = {
      deps: this.deps,
      run,
      now,
      guard,
      sleep:
        this.deps.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      progress: async (phase, event, knownTasks) => {
        const tasks =
          knownTasks ??
          (await this.deps.store.listOffsetSyncTasks(
            run.runId,
            phase === 'items' ? 'item' : 'document'
          ));
        const counts = countTasks(tasks);
        (options.onProgress ?? this.deps.onProgress)?.({
          runId: run.runId,
          phase,
          event,
          completed: counts.applied,
          total: counts.discovered,
          failed: counts.failed,
        });
      },
    };
    try {
      if (!run.discoveryComplete) await discoverOffsetDocuments(execution);
      await drainOffsetTasks(execution, 'document');
      await drainOffsetTasks(execution, 'item');
      const result = await this.result(run);
      run.status =
        result.documents.failed +
          result.documents.pending +
          result.items.failed +
          result.items.pending >
        0
          ? 'success_with_warnings'
          : 'success';
      run.updatedAt = now();
      run.finishedAt = now();
      await guard();
      await this.deps.store.saveOffsetSyncRun(run);
      (options.onProgress ?? this.deps.onProgress)?.({
        runId: run.runId,
        phase: 'complete',
        event: run.status,
        completed: result.documents.applied + result.items.applied,
        total: result.documents.discovered + result.items.discovered,
        failed: result.documents.failed + result.items.failed,
      });
      return { ...result, run };
    } catch (error) {
      const code = fatalOffsetFailure(error);
      run.status = 'failed';
      run.errorCode = code;
      run.updatedAt = now();
      // A lost writer fence cannot publish a failed summary; its prior running checkpoint remains resumable.
      try {
        await guard();
        await this.deps.store.saveOffsetSyncRun(run);
      } catch {
        throw new DocumentOffsetSyncError('checkpoint_failed');
      }
      throw new DocumentOffsetSyncError(code);
    }
  }

  private async result(run: DocumentOffsetRun): Promise<DocumentOffsetSyncResult> {
    const documents = await this.deps.store.listOffsetSyncTasks(run.runId, 'document');
    const items = await this.deps.store.listOffsetSyncTasks(run.runId, 'item');
    return {
      run,
      documents: countTasks(documents),
      items: countTasks(items),
      failures: [
        ...documents.map((task) => ({ ...task, kind: 'document' as const })),
        ...items.map((task) => ({ ...task, kind: 'item' as const })),
      ]
        .filter((task) => task.status !== 'done')
        .map((task) => ({
          kind: task.kind,
          id: task.id,
          contextId: task.contextId,
          code: task.errorCode ?? 'pending',
        })),
      coverageLimitations: [
        'Partial document-driven coverage; does not establish a complete inventory baseline.',
        'Deleted documents and direct item or variation edits are not discovered.',
        'Purchase-order balances receive a delayed read; complete source convergence is not guaranteed.',
      ],
    };
  }
}

function countTasks(tasks: DocumentOffsetTask[]): DocumentOffsetTaskCounts {
  return {
    discovered: tasks.length,
    applied: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
  };
}
