import { chmodSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import {
  FullResumeCheckpointStore,
  buildFullResumeCacheIdentity,
  buildPaymentSyncStatusFingerprint,
  getFullResumeCheckpointPath,
  sanitizeCheckpointAccountName,
  type FullResumeCheckpoint,
  type FullResumePhase,
  type ResumeCacheSnapshot,
} from './full-resume-checkpoint.js';

const ACCOUNT = 'sales / east';
const SCHEMA_VERSION = 7;

function snapshot(overrides: Partial<ResumeCacheSnapshot> = {}): ResumeCacheSnapshot {
  return {
    accountName: ACCOUNT,
    schemaVersion: SCHEMA_VERSION,
    accountCount: 10,
    categoryCount: 5,
    categoryStatus: 'complete',
    categoryCompletedAt: 150,
    categorySchemaVersion: 7,
    categoryGeneration: 'generation-a',
    categoryFingerprint: 'sha256:category-a',
    inventoryStatus: 'complete',
    inventoryCompletedAt: 175,
    inventorySchemaVersion: 7,
    inventorySourceApiVersion: '3',
    inventoryGeneration: 'inventory-generation-a',
    inventoryFingerprint: 'sha256:inventory-a',
    documentCount: 20,
    itemDocumentCount: 30,
    paymentTransactionCount: 35,
    paymentSyncStatusFingerprint: 'a'.repeat(64),
    itemCount: 40,
    stockLocationCount: 50,
    lastAccountSync: 100,
    lastItemSync: 200,
    lastDeletedSync: 300,
    ...overrides,
  };
}

describe('FullResumeCheckpointStore', () => {
  let cacheDirectory: string;

  beforeEach(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'salesbinder-full-resume-'));
  });

  afterEach(async () => {
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  function createStore(syncTarget: 'sqlite' | 'postgresql' = 'sqlite') {
    const cacheIdentity = buildFullResumeCacheIdentity({
      accountName: ACCOUNT,
      syncTarget,
      cacheDirectory,
      databaseUrl:
        syncTarget === 'postgresql' ? 'postgres://user:secret@localhost/salesbinder' : undefined,
    });
    return new FullResumeCheckpointStore({
      accountName: ACCOUNT,
      syncTarget,
      schemaVersion: SCHEMA_VERSION,
      cacheIdentity,
      cacheDirectory,
    });
  }

  function completePhase(
    store: FullResumeCheckpointStore,
    checkpoint: FullResumeCheckpoint,
    phase: FullResumePhase,
    evidence: ResumeCacheSnapshot = snapshot()
  ) {
    store.markPhaseStarted(checkpoint, phase);
    const results: Record<FullResumePhase, object> = {
      accounts: { accountsProcessed: 10, customersProcessed: 6, suppliersProcessed: 4 },
      categories: { categoriesProcessed: 5, snapshot: { ignored: true } },
      documents: {
        success: true,
        type: 'full',
        documentsProcessed: 20,
        documentsDeleted: 0,
        lineItemsProcessed: 30,
        duration: '1.0s',
        syncLookbackSeconds: 604800,
        recordIssues: [],
      },
      items: { itemsProcessed: 40, stockRowsProcessed: 50, recordIssues: [] },
      'deleted-log': { deletedRecordsProcessed: 0, documentTombstones: [] },
    };
    store.markPhaseComplete(checkpoint, phase, results[phase], evidence);
  }

  it('sanitizes account names consistently for checkpoint and SQLite identities', () => {
    expect(sanitizeCheckpointAccountName(ACCOUNT)).toBe('sales___east');
    expect(getFullResumeCheckpointPath(ACCOUNT, cacheDirectory)).toBe(
      join(cacheDirectory, 'full-resume-sales___east.json')
    );
    expect(
      buildFullResumeCacheIdentity({ accountName: ACCOUNT, syncTarget: 'sqlite', cacheDirectory })
    ).toBe(`sqlite:${join(cacheDirectory, 'salesbinder-sales___east.db')}`);
  });

  it('fingerprints stable payment refresh metadata', () => {
    const status = {
      status: 'complete',
      mode: 'full',
      startedAt: 90,
      updatedAt: 100,
      finishedAt: 100,
      lastSuccessfulSync: 100,
      cursor: 'invoice-20',
      snapshotHash: 'invoice-set-a',
      processedDocuments: 20,
      totalDocuments: 20,
    };

    expect(buildPaymentSyncStatusFingerprint(status)).toHaveLength(64);
    expect(buildPaymentSyncStatusFingerprint(status)).toBe(
      buildPaymentSyncStatusFingerprint({ ...status })
    );
    expect(buildPaymentSyncStatusFingerprint({ ...status, updatedAt: 101 })).not.toBe(
      buildPaymentSyncStatusFingerprint(status)
    );
    expect(buildPaymentSyncStatusFingerprint(null)).toBeNull();
  });

  it('writes checkpoint files atomically with private permissions', async () => {
    chmodSync(cacheDirectory, 0o755);
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'accounts');

    const diskCheckpoint = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as {
      phase: string;
    };
    expect(diskCheckpoint.phase).toBe('accounts');
    expect(await readdir(cacheDirectory)).toEqual(['full-resume-sales___east.json']);
    if (process.platform !== 'win32') {
      expect(statSync(cacheDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(store.checkpointPath).mode & 0o777).toBe(0o600);
    }
  });

  it('creates v5 checkpoints with sanitized resumable phase results', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();

    expect(checkpoint.version).toBe(5);
    expect(checkpoint.phaseResults).toEqual({});

    store.markPhaseStarted(checkpoint, 'documents');
    store.markPhaseComplete(
      checkpoint,
      'documents',
      {
        success: true,
        type: 'full',
        documentsProcessed: 2,
        documentsDeleted: 1,
        lineItemsProcessed: 3,
        duration: '1.2s',
        syncLookbackSeconds: 60,
        recordIssues: [
          {
            resource: 'document',
            id: 'doc-2',
            context_id: 11,
            code: 'invalid_record',
            message: 'Authorization: Bearer checkpoint-secret https://private.example/payload',
            attempts: 2,
            outcome: 'preserved_last_known_good',
            payload: { customer_name: 'must not persist' },
            authorization: 'must not persist',
            url: 'must not persist',
          },
        ],
        sourcePayload: { apiKey: 'must not persist' },
      },
      snapshot()
    );

    expect(store.getPhaseResult(checkpoint, 'documents')).toEqual({
      success: true,
      type: 'full',
      documentsProcessed: 2,
      documentsDeleted: 1,
      lineItemsProcessed: 3,
      duration: '1.2s',
      syncLookbackSeconds: 60,
      recordIssues: [
        {
          resource: 'document',
          id: 'doc-2',
          context_id: 11,
          code: 'invalid_record',
          message: 'Document failed source validation',
          attempts: 2,
          outcome: 'preserved_last_known_good',
        },
      ],
    });
    expect(readFileSync(store.checkpointPath, 'utf8')).not.toMatch(
      /customer_name|apiKey|authorization|url|checkpoint-secret|private\.example/i
    );
  });

  it('rejects a persisted issue message outside the fixed safe taxonomy', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    store.markPhaseStarted(checkpoint, 'documents');
    store.markPhaseComplete(
      checkpoint,
      'documents',
      {
        success: true,
        type: 'full',
        documentsProcessed: 0,
        documentsDeleted: 0,
        lineItemsProcessed: 0,
        duration: '0s',
        recordIssues: [
          {
            resource: 'document',
            id: 'doc-1',
            context_id: 4,
            code: 'not_found',
            message: 'Document unavailable during refresh',
            attempts: 2,
            outcome: 'omitted_new',
          },
        ],
      },
      snapshot()
    );
    const disk = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as FullResumeCheckpoint;
    const documents = disk.phaseResults.documents;
    if (!documents) throw new Error('documents phase result missing from checkpoint fixture');
    documents.recordIssues[0].message =
      'Authorization: Bearer persisted-secret https://private.example/body';
    writeFileSync(store.checkpointPath, JSON.stringify(disk), 'utf8');

    expect(() => store.loadOrCreate()).toThrow(/documents phase result.*reset-checkpoint/i);
  });

  it.each(['invalid_variations', 'content_changed'] as const)(
    'rejects persisted item-only warning code %s for a completed document phase',
    (code) => {
      const store = createStore();
      const checkpoint = store.loadOrCreate();
      completePhase(store, checkpoint, 'accounts');
      completePhase(store, checkpoint, 'categories');
      store.markPhaseStarted(checkpoint, 'documents');
      store.markPhaseComplete(
        checkpoint,
        'documents',
        {
          success: true,
          type: 'full',
          documentsProcessed: 0,
          documentsDeleted: 0,
          lineItemsProcessed: 0,
          duration: '0s',
          recordIssues: [
            {
              resource: 'document',
              id: 'doc-1',
              context_id: 4,
              code: 'invalid_record',
              message: 'Document failed source validation',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
        },
        snapshot()
      );

      const disk = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as FullResumeCheckpoint;
      const documents = disk.phaseResults.documents;
      if (!documents) throw new Error('documents phase result missing from checkpoint fixture');
      documents.recordIssues[0].code = code;
      writeFileSync(store.checkpointPath, JSON.stringify(disk), 'utf8');

      expect(() => store.loadOrCreate()).toThrow(/documents phase result.*reset-checkpoint/i);
    }
  );

  it('restores deterministic warning results for a skipped phase', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    store.markPhaseStarted(checkpoint, 'items');
    store.markPhaseComplete(
      checkpoint,
      'items',
      {
        itemsProcessed: 8,
        stockRowsProcessed: 12,
        recordIssues: [
          {
            resource: 'item',
            id: 'item-z',
            code: 'invalid_variations',
            message: 'Variations invalid',
            attempts: 2,
            outcome: 'omitted_new',
          },
          {
            resource: 'item',
            id: 'item-a',
            code: 'invalid_record',
            message: 'Item invalid',
            attempts: 2,
            outcome: 'preserved_last_known_good',
          },
        ],
      },
      snapshot()
    );

    const restored = store.getPhaseResult(store.loadOrCreate(), 'items');
    expect(restored.recordIssues.map((issue) => issue.id)).toEqual(['item-a', 'item-z']);
    restored.recordIssues.length = 0;
    expect(store.getPhaseResult(checkpoint, 'items').recordIssues).toHaveLength(2);
  });

  it('rejects conflicting issue details for the same resource and ID', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'documents');

    expect(() =>
      store.markPhaseComplete(
        checkpoint,
        'documents',
        {
          success: true,
          type: 'full',
          documentsProcessed: 0,
          documentsDeleted: 0,
          lineItemsProcessed: 0,
          duration: '0s',
          recordIssues: [
            {
              resource: 'document',
              id: 'doc-1',
              context_id: 5,
              code: 'not_found',
              message: 'Missing invoice',
              attempts: 2,
              outcome: 'omitted_new',
            },
            {
              resource: 'document',
              id: 'doc-1',
              context_id: 11,
              code: 'not_found',
              message: 'Missing purchase order',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
        },
        snapshot()
      )
    ).toThrow(/conflicting record issue/);
    expect(checkpoint.completedPhases).toEqual([]);
  });

  it('retains complete-with-warnings inventory authority in resume evidence', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(
      store,
      checkpoint,
      'items',
      snapshot({ inventoryStatus: 'complete_with_warnings' })
    );

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({ inventoryStatus: 'complete_with_warnings' })
      )
    ).not.toThrow();
    expect(() =>
      store.validateCompletedPhases(checkpoint, snapshot({ inventoryStatus: 'complete' }))
    ).toThrow(/items.*inventoryStatus/i);
  });

  it('rejects a completed v5 phase without its sanitized result', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    const disk = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as FullResumeCheckpoint;
    delete disk.phaseResults.accounts;
    writeFileSync(store.checkpointPath, JSON.stringify(disk), 'utf8');

    expect(() => store.loadOrCreate()).toThrow(/accounts phase result.*reset-checkpoint/i);
  });

  it('rejects malformed or incompatible checkpoints with reset guidance', () => {
    const store = createStore();
    store.loadOrCreate();
    writeFileSync(store.checkpointPath, '{broken', 'utf8');
    expect(() => store.loadOrCreate()).toThrow(/--full-resume --reset-checkpoint/);

    store.reset();
    store.loadOrCreate();
    const pgStore = createStore('postgresql');
    expect(() => pgStore.loadOrCreate()).toThrow(/backend.*reset-checkpoint/i);
  });

  it.each([
    ['version', 'version', 4],
    ['account', 'accountName', 'another-account'],
    ['schema', 'schemaVersion', 99],
    ['cache identity', 'cacheIdentity', 'sqlite:another-cache'],
  ])('rejects a stale %s identity', (_label, field, value) => {
    const store = createStore();
    store.loadOrCreate();
    const checkpoint = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as Record<
      string,
      unknown
    >;
    checkpoint[field] = value;
    writeFileSync(store.checkpointPath, JSON.stringify(checkpoint), 'utf8');

    expect(() => store.loadOrCreate()).toThrow(
      new RegExp(`${String(_label)}.*reset-checkpoint`, 'i')
    );
  });

  it('resets only the sanitized account checkpoint', () => {
    const store = createStore();
    store.loadOrCreate();
    const neighbor = join(cacheDirectory, 'full-resume-neighbor.json');
    writeFileSync(neighbor, '{}', 'utf8');

    store.reset();

    expect(() => statSync(store.checkpointPath)).toThrow();
    expect(readFileSync(neighbor, 'utf8')).toBe('{}');
  });

  it('validates completed phases against current cache state', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    store.validateCompletedPhases(checkpoint, snapshot());

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({ accountCount: 9 }))).toThrow(
      /accounts.*reset-checkpoint/i
    );
  });

  it('rejects document resume after the payment transaction count changes', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    const completedSnapshot = snapshot({ paymentTransactionCount: 5 });
    completePhase(store, checkpoint, 'accounts', completedSnapshot);
    completePhase(store, checkpoint, 'categories', completedSnapshot);
    completePhase(store, checkpoint, 'documents', completedSnapshot);

    expect(() =>
      store.validateCompletedPhases(checkpoint, snapshot({ paymentTransactionCount: 6 }))
    ).toThrow(/documents.*reset-checkpoint/i);
  });

  it('rejects category resume when same-count category content changes', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          categoryGeneration: 'generation-b',
          categoryFingerprint: 'sha256:category-b',
        })
      )
    ).toThrow(/categories.*reset-checkpoint/i);
  });

  it('rejects item resume when same-count inventory content changes', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          inventoryGeneration: 'inventory-generation-b',
          inventoryFingerprint: 'sha256:inventory-b',
        })
      )
    ).toThrow(/items.*reset-checkpoint/i);
  });

  it('rejects document resume after payment sync metadata changes with the same count', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          paymentSyncStatusFingerprint: 'b'.repeat(64),
        })
      )
    ).toThrow(/documents.*reset-checkpoint/i);
  });

  it('allows deleted-log resume after an interrupted run partially deleted cached rows', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          accountCount: 9,
          documentCount: 18,
          itemDocumentCount: 27,
          paymentTransactionCount: 34,
        })
      )
    ).not.toThrow();
  });

  it('rejects item or stock changes while resuming the non-item deleted-log phase', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({ itemCount: 39 }))).toThrow(
      /items.*reset-checkpoint/i
    );
    expect(() =>
      store.validateCompletedPhases(checkpoint, snapshot({ stockLocationCount: 49 }))
    ).toThrow(/items.*reset-checkpoint/i);
  });

  it('rejects deleted-log resume when category authority changed', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          categoryStatus: 'uninitialized',
          categoryCompletedAt: null,
          categorySchemaVersion: null,
          categoryGeneration: null,
          categoryFingerprint: null,
        })
      )
    ).toThrow(/categories.*reset-checkpoint/i);
  });

  it('rejects deleted-log resume when inventory authority changed with the same counts', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          inventoryGeneration: 'inventory-generation-b',
          inventoryFingerprint: 'sha256:inventory-b',
        })
      )
    ).toThrow(/items.*reset-checkpoint/i);
  });

  it.each([
    ['accounts', { lastAccountSync: 101 }],
    ['documents', { paymentSyncStatusFingerprint: 'b'.repeat(64) }],
    ['items', { lastItemSync: 201 }],
  ])('rejects deleted-log resume when completed %s authority changed', (phase, changes) => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() => store.validateCompletedPhases(checkpoint, snapshot(changes))).toThrow(
      new RegExp(`${phase}.*reset-checkpoint`, 'i')
    );
  });

  it.each([
    ['accounts', { accountCount: 11 }],
    ['documents', { documentCount: 21 }],
    ['items', { itemCount: 41 }],
  ])('rejects deleted-log resume when completed %s rows increased', (phase, changes) => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() => store.validateCompletedPhases(checkpoint, snapshot(changes))).toThrow(
      new RegExp(`${phase}.*reset-checkpoint`, 'i')
    );
  });

  it('rejects deleted-log resume after another deleted-log sync advanced the watermark', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() =>
      store.validateCompletedPhases(checkpoint, snapshot({ lastDeletedSync: 301 }))
    ).toThrow(/deleted-log.*reset-checkpoint/i);
  });

  it('validates deleted-log completion against the final cache snapshot', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'categories');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    const deletedLogSnapshot = snapshot({
      accountCount: 9,
      documentCount: 18,
      itemDocumentCount: 27,
      paymentTransactionCount: 34,
      paymentSyncStatusFingerprint: 'b'.repeat(64),
      itemCount: 39,
      stockLocationCount: 49,
      lastDeletedSync: 301,
    });
    completePhase(store, checkpoint, 'deleted-log', deletedLogSnapshot);

    expect(() => store.validateCompletedPhases(checkpoint, deletedLogSnapshot)).not.toThrow();
    expect(() =>
      store.validateCompletedPhases(checkpoint, {
        ...deletedLogSnapshot,
        paymentSyncStatusFingerprint: 'c'.repeat(64),
      })
    ).toThrow(/deleted-log.*reset-checkpoint/i);
    expect(() =>
      store.validateCompletedPhases(
        checkpoint,
        snapshot({
          accountCount: 8,
          documentCount: 17,
          itemDocumentCount: 26,
          paymentTransactionCount: 33,
          paymentSyncStatusFingerprint: 'c'.repeat(64),
          itemCount: 38,
          stockLocationCount: 48,
          lastDeletedSync: 302,
        })
      )
    ).toThrow(/deleted-log.*reset-checkpoint/i);
  });

  it('does not complete a phase when an indexer reports failure', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'documents');

    expect(() =>
      store.markPhaseComplete(checkpoint, 'documents', { success: false }, snapshot())
    ).toThrow(/unsuccessful/);
    expect(checkpoint.completedPhases).toEqual([]);
    expect(store.loadOrCreate().completedPhases).toEqual([]);
  });

  it('persists the original failure and removes the checkpoint only on success', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'documents');
    store.recordFailure(checkpoint, new Error('Bearer secret from https://private.example/body'));

    expect(store.loadOrCreate().lastError).toBe('Cache sync failed.');
    expect(readFileSync(store.checkpointPath, 'utf8')).not.toMatch(
      /Bearer secret|private\.example/
    );
    store.removeAfterSuccess();
    expect(() => statSync(store.checkpointPath)).toThrow();
  });
});
