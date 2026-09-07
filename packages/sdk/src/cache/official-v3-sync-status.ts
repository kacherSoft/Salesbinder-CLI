import type {
  OfficialV3SyncRun,
  OfficialV3SyncRunSummary,
  OfficialV3SyncStatusSummary,
  OfficialV3SyncStore,
  OfficialV3SyncTask,
} from './official-v3-sync.types.js';

export async function readOfficialV3SyncStatus(
  store: Pick<OfficialV3SyncStore, 'getState' | 'getRun' | 'listTasks'>
): Promise<OfficialV3SyncStatusSummary | null> {
  const state = await store.getState();
  const run = await store.getRun();
  if (!state || !run) return null;
  const tasks = await store.listTasks(run.runId);
  return {
    run: sanitizeRun(run),
    state: {
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
    },
    tasks: countTasks(tasks),
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

export function sanitizeOfficialV3SyncRun(run: OfficialV3SyncRun): OfficialV3SyncRunSummary {
  return sanitizeRun(run);
}

function sanitizeRun(run: OfficialV3SyncRun): OfficialV3SyncRunSummary {
  const entry =
    run.entry.kind === 'since'
      ? ({ kind: 'since', value: run.entry.value } as const)
      : ({ kind: 'cursor' } as const);
  return { ...run, entry };
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
