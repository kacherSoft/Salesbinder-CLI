import { OfficialV3SyncService } from '../official-v3-sync.service.js';
import type {
  OfficialV3SyncMarker,
  OfficialV3SyncPage,
  OfficialV3SyncRun,
  OfficialV3SyncState,
  OfficialV3SyncStore,
  OfficialV3SyncTask,
} from '../official-v3-sync.types.js';
import type { V3ExactItemHydrationResult } from '../v3-exact-item-hydrator.service.js';

const accountIdentity = 'salesbinder:acme';
const itemA = '05c86ce5-c234-438b-9908-f518e42d42e4';
const itemB = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const docId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const lineId = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';

function itemResult(id: string): V3ExactItemHydrationResult {
  return {
    id,
    status: 'found_current',
    fingerprint: `fp:${id}`,
    bundle: {
      item: { item_id: id, name: id, cache_source: 'api', source_api_version: '3' },
      stockRows: [
        {
          stock_row_id: `api:${id}`,
          item_id: id,
          quantity_on_hand: 1,
          quantity_reserved: 0,
          quantity_available: 1,
          quantity_incoming: 0,
          in_transit: 0,
          cache_source: 'api',
          source_api_version: '3',
        },
      ],
    },
  };
}

function invoice(id = docId): Record<string, unknown> {
  return {
    object: 'invoice',
    id,
    invoice_number: 123,
    customer_id: itemB,
    customer_name: 'Acme',
    customer_kind: 'customer',
    salesperson_id: 'b16f844f-4b40-4f05-a468-407106563e03',
    status: 'Sent',
    issue_date: '2026-09-06',
    updated_at: '2026-09-06T12:00:00Z',
    subtotal: '10.00',
    total: '10.00',
    lines: [
      {
        object: 'invoice_line',
        id: lineId,
        invoice_id: id,
        item_id: itemA,
        line_type: 'inventory',
        quantity: '1',
        unit_price: '10.00',
      },
    ],
  };
}

function harness() {
  const store = new MemoryOfficialStore();
  const pages = new Map<string, { changes: OfficialV3SyncMarker[]; has_more: boolean; next_cursor: string }>();
  const sync = {
    read: jest.fn(async (params: { since?: string | number; cursor?: string }) => {
      const key = params.since !== undefined ? `since:${params.since}` : `cursor:${params.cursor}`;
      const page = pages.get(key);
      if (!page) throw new Error(`missing page ${key}`);
      return {
        object: 'sync_page' as const,
        resources: ['item', 'invoice', 'estimate', 'purchase_order'] as const,
        changes: page.changes,
        has_more: page.has_more,
        next_cursor: page.next_cursor,
      };
    }),
  };
  const hydrate = jest.fn(async (ids: readonly string[]): Promise<V3ExactItemHydrationResult[]> =>
    ids.map((id) => (id === itemB ? { id, status: 'missing_unproven' } : itemResult(id)))
  );
  const documents = { get: jest.fn(async () => invoice()) };
  const service = new OfficialV3SyncService({
    store,
    sync,
    hydrator: { hydrate },
    documents,
    now: () => 100,
  });
  return { service, store, pages, sync, hydrate, documents };
}

describe('OfficialV3SyncService', () => {
  it('seals later pages and keeps applied coverage behind an earlier record gap', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'item', id: itemB, operation: 'upsert' }],
      has_more: true,
      next_cursor: 'cursor-1',
    });
    h.pages.set('cursor:cursor-1', {
      changes: [{ resource: 'item', id: itemA, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-2',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(result.run.status).toBe('success_with_warnings');
    expect(result.state).toMatchObject({ hasIngestionCursor: true, hasAppliedCursor: false, cursorGap: true });
    expect(result.tasks).toMatchObject({ discovered: 2, applied: 1, failed: 1 });
    expect(result.failures).toEqual([
      { taskId: 'm:1:0', resource: 'item', id: itemB, code: 'missing_unproven' },
    ]);
    expect(JSON.stringify(result)).not.toContain('cursor-');
  });

  it('resume can ingest a later finite cycle from ingestion cursor while an old gap remains', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'item', id: itemB, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    await h.service.sync({ accountIdentity, since: 1788670542 });
    h.pages.set('cursor:cursor-1', {
      changes: [{ resource: 'item', id: itemA, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-2',
    });

    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.sync.read).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 500 });
    expect(result.run.entry).toEqual({ kind: 'cursor' });
    expect(result.state).toMatchObject({ hasIngestionCursor: true, hasAppliedCursor: false, cursorGap: true });
    expect(result.tasks.applied).toBe(1);
  });

  it('marks older failed work superseded before it can regress a newer receipt', async () => {
    const h = harness();
    h.store.seedState('cursor-2');
    h.store.seedRun('run-old', 'failed');
    h.store.seedTask({ taskId: 'old-delete', runId: 'run-old', page: 1, ordinal: 0, generation: 1, kind: 'marker', resource: 'item', id: itemA, operation: 'delete', status: 'failed', attempts: 1 });
    h.store.seedTask({ taskId: 'new-upsert', runId: 'run-new', page: 1, ordinal: 0, generation: 2, kind: 'marker', resource: 'item', id: itemA, operation: 'upsert', status: 'done', attempts: 1 });
    h.store.seedRun('run-old', 'running');

    const stale = (await h.store.listTasks('run-old'))[0]!;
    await h.store.markSupersededIfStale('run-old', stale);

    expect((await h.store.listTasks('run-old'))[0]).toMatchObject({ status: 'superseded' });
    expect(h.store.deletedItems).toEqual([]);
  });

  it('keeps a document page incomplete until derived item refresh receives a receipt', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'invoice', id: docId, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.documents.get).toHaveBeenCalledWith(5, docId);
    expect(h.hydrate).toHaveBeenCalledWith([itemA], { categoryNames: null });
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 2, applied: 2, failed: 0, pending: 0 });
    expect(result.state.cursorGap).toBe(false);
  });

  it('drains item refreshes created by a document that succeeds on retry', async () => {
    const h = harness();
    h.pages.set('since:1788670542', {
      changes: [{ resource: 'invoice', id: docId, operation: 'upsert' }],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    h.documents.get
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } })
      .mockResolvedValueOnce(invoice());

    const result = await h.service.sync({ accountIdentity, since: 1788670542 });

    expect(h.documents.get).toHaveBeenCalledTimes(2);
    expect(h.hydrate).toHaveBeenCalledWith([itemA], { categoryNames: null });
    expect(result.run.status).toBe('success');
    expect(result.tasks).toMatchObject({ discovered: 2, applied: 2, failed: 0, pending: 0 });
  });

  it('resumes from original since when the first source page fails before sealing', async () => {
    const h = harness();
    h.sync.read.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401 } });

    await expect(h.service.sync({ accountIdentity, since: 1788670542 })).rejects.toMatchObject({
      code: 'authentication_failed',
    });
    expect(h.store.currentRun).toMatchObject({
      status: 'failed',
      entry: { kind: 'since', value: '1788670542' },
      pageCount: 0,
    });

    h.pages.set('since:1788670542', {
      changes: [],
      has_more: false,
      next_cursor: 'cursor-1',
    });
    const result = await h.service.sync({ accountIdentity, resume: true });

    expect(h.sync.read).toHaveBeenLastCalledWith({
      since: '1788670542',
      resources: ['item', 'invoice', 'estimate', 'purchase_order'],
      limit: 500,
    });
    expect(result.run.status).toBe('success');
    expect(result.state.cursorGap).toBe(false);
  });
});

class MemoryOfficialStore implements OfficialV3SyncStore {
  state: OfficialV3SyncState | null = null;
  currentRun: OfficialV3SyncRun | null = null;
  pages: OfficialV3SyncPage[] = [];
  tasks = new Map<string, OfficialV3SyncTask>();
  deletedItems: string[] = [];

  async getState() { return this.state ? structuredClone(this.state) : null; }
  async getRun() { return this.currentRun ? structuredClone(this.currentRun) : null; }
  async beginRun(run: OfficialV3SyncRun) {
    this.currentRun = structuredClone(run);
    this.state ??= { version: 1, accountIdentity, resources: ['item', 'invoice', 'estimate', 'purchase_order'], appliedGeneration: 0, nextGeneration: 1, coverage: 'partial_catch_up', updatedAt: 100 };
  }
  async sealPage(runId: string, request: OfficialV3SyncPage['request'], page: Omit<OfficialV3SyncPage, 'request' | 'status' | 'firstGeneration' | 'lastGeneration'>, markers: readonly OfficialV3SyncMarker[]) {
    const firstGeneration = this.state!.nextGeneration;
    this.pages.push({ ...page, request, firstGeneration, lastGeneration: firstGeneration + Math.max(markers.length, 1) - 1, status: 'sealed' });
    markers.forEach((marker, index) => this.tasks.set(this.key(runId, `m:${page.page}:${index}`), { taskId: `m:${page.page}:${index}`, runId, page: page.page, ordinal: index, generation: firstGeneration + index, kind: 'marker', resource: marker.resource, id: marker.id, operation: marker.operation, status: 'pending', attempts: 0 }));
    this.state = { ...this.state!, ingestionCursor: page.nextCursor, nextGeneration: firstGeneration + Math.max(markers.length, 1) };
    this.currentRun = { ...this.currentRun!, ingestionComplete: !page.hasMore, pageCount: page.page, status: 'running' };
    return structuredClone(this.currentRun);
  }
  async listTasks(runId: string) { return [...this.tasks.values()].filter((task) => task.runId === runId).sort((a, b) => a.page - b.page || a.ordinal - b.ordinal || a.taskId.localeCompare(b.taskId)).map((task) => structuredClone(task)); }
  async saveTaskFailure(_runId: string, task: OfficialV3SyncTask, code: string) {
    this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'failed', errorCode: code });
  }
  async markSupersededIfStale(_runId: string, task: OfficialV3SyncTask) {
    const newer = [...this.tasks.values()].some((other) => other.resource === task.resource && other.id === task.id && other.generation > task.generation && ['done', 'superseded'].includes(other.status));
    if (newer) this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'superseded' });
    return newer;
  }
  async applyItemUpsert(runId: string, task: OfficialV3SyncTask) { await this.done(runId, task); }
  async applyItemRefresh(runId: string, task: OfficialV3SyncTask) { await this.done(runId, task); await this.completeParents(runId); }
  async applyItemDelete(runId: string, task: OfficialV3SyncTask) { this.deletedItems.push(task.id); await this.done(runId, task); }
  async applyDocumentUpsertAndQueueRefreshes(_runId: string, task: OfficialV3SyncTask, _document: unknown, lines: { item_id: string }[]) {
    for (const line of lines) this.tasks.set(this.key(task.runId, `${task.taskId}:refresh:${line.item_id}`), { ...task, taskId: `${task.taskId}:refresh:${line.item_id}`, kind: 'item_refresh', parentTaskId: task.taskId, resource: 'item', id: line.item_id, operation: 'refresh', status: 'pending' });
    this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: lines.length ? 'waiting_children' : 'done' });
  }
  async applyDocumentDeleteAndQueueRefreshes(runId: string, task: OfficialV3SyncTask) { await this.done(runId, task); }
  async completeTaskGroup(runId: string, task: OfficialV3SyncTask) { await this.completeParents(runId, task); }
  async advanceAppliedPrefix() {
    for (const page of this.pages.sort((a, b) => a.firstGeneration - b.firstGeneration)) {
      const tasks = [...this.tasks.values()].filter((task) => task.runId === page.runId && task.page === page.page);
      if (!tasks.every((task) => ['done', 'superseded'].includes(task.status))) return structuredClone(this.state);
      this.state = { ...this.state!, appliedCursor: page.nextCursor, appliedGeneration: page.lastGeneration };
    }
    return structuredClone(this.state);
  }
  async finishRun(run: OfficialV3SyncRun) { this.currentRun = structuredClone(run); }
  seedState(cursor: string) { this.state = { version: 1, accountIdentity, resources: ['item', 'invoice', 'estimate', 'purchase_order'], ingestionCursor: cursor, appliedGeneration: 0, nextGeneration: 3, coverage: 'partial_catch_up', updatedAt: 100 }; }
  seedRun(runId: string, status: OfficialV3SyncRun['status']) { this.currentRun = { version: 1, runId, accountIdentity, entry: { kind: 'cursor', value: 'cursor-2' }, status, ingestionComplete: true, pageCount: 1, startedAt: 100, updatedAt: 100 }; }
  seedTask(task: OfficialV3SyncTask) { this.tasks.set(this.key(task.runId, task.taskId), structuredClone(task)); }
  private async done(_runId: string, task: OfficialV3SyncTask) { this.tasks.set(this.key(task.runId, task.taskId), { ...task, status: 'done' }); }
  private async completeParents(runId: string, task?: OfficialV3SyncTask) {
    const parents = [...this.tasks.values()].filter((candidate) => candidate.runId === runId && candidate.status === 'waiting_children' && (!task || candidate.taskId === task.taskId));
    for (const parent of parents) {
      const children = [...this.tasks.values()].filter((child) => child.parentTaskId === parent.taskId);
      if (children.every((child) => ['done', 'superseded'].includes(child.status))) this.tasks.set(this.key(parent.runId, parent.taskId), { ...parent, status: 'done' });
    }
  }
  private key(runId: string, taskId: string) { return `${runId}:${taskId}`; }
}
