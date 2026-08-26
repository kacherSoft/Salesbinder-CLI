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
      databaseUrl: syncTarget === 'postgresql' ? 'postgres://user:secret@localhost/salesbinder' : undefined,
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
    evidence: ResumeCacheSnapshot = snapshot(),
  ) {
    store.markPhaseStarted(checkpoint, phase);
    store.markPhaseComplete(checkpoint, phase, {}, evidence);
  }

  it('sanitizes account names consistently for checkpoint and SQLite identities', () => {
    expect(sanitizeCheckpointAccountName(ACCOUNT)).toBe('sales___east');
    expect(getFullResumeCheckpointPath(ACCOUNT, cacheDirectory)).toBe(
      join(cacheDirectory, 'full-resume-sales___east.json'),
    );
    expect(buildFullResumeCacheIdentity({ accountName: ACCOUNT, syncTarget: 'sqlite', cacheDirectory }))
      .toBe(`sqlite:${join(cacheDirectory, 'salesbinder-sales___east.db')}`);
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
    expect(buildPaymentSyncStatusFingerprint(status)).toBe(buildPaymentSyncStatusFingerprint({ ...status }));
    expect(buildPaymentSyncStatusFingerprint({ ...status, updatedAt: 101 }))
      .not.toBe(buildPaymentSyncStatusFingerprint(status));
    expect(buildPaymentSyncStatusFingerprint(null)).toBeNull();
  });

  it('writes checkpoint files atomically with private permissions', async () => {
    chmodSync(cacheDirectory, 0o755);
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'accounts');

    const diskCheckpoint = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as { phase: string };
    expect(diskCheckpoint.phase).toBe('accounts');
    expect(await readdir(cacheDirectory)).toEqual(['full-resume-sales___east.json']);
    if (process.platform !== 'win32') {
      expect(statSync(cacheDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(store.checkpointPath).mode & 0o777).toBe(0o600);
    }
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
    ['version', 'version', 1],
    ['account', 'accountName', 'another-account'],
    ['schema', 'schemaVersion', 99],
    ['cache identity', 'cacheIdentity', 'sqlite:another-cache'],
  ])('rejects a stale %s identity', (_label, field, value) => {
    const store = createStore();
    store.loadOrCreate();
    const checkpoint = JSON.parse(readFileSync(store.checkpointPath, 'utf8')) as Record<string, unknown>;
    checkpoint[field] = value;
    writeFileSync(store.checkpointPath, JSON.stringify(checkpoint), 'utf8');

    expect(() => store.loadOrCreate()).toThrow(new RegExp(`${String(_label)}.*reset-checkpoint`, 'i'));
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

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({ accountCount: 9 })))
      .toThrow(/accounts.*reset-checkpoint/i);
  });

  it('rejects document resume after the payment transaction count changes', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    const completedSnapshot = snapshot({ paymentTransactionCount: 5 });
    completePhase(store, checkpoint, 'accounts', completedSnapshot);
    completePhase(store, checkpoint, 'documents', completedSnapshot);

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({ paymentTransactionCount: 6 })))
      .toThrow(/documents.*reset-checkpoint/i);
  });

  it('rejects document resume after payment sync metadata changes with the same count', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'documents');

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({
      paymentSyncStatusFingerprint: 'b'.repeat(64),
    })))
      .toThrow(/documents.*reset-checkpoint/i);
  });

  it('allows deleted-log resume after earlier phase counts changed', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
    completePhase(store, checkpoint, 'documents');
    completePhase(store, checkpoint, 'items');
    store.markPhaseStarted(checkpoint, 'deleted-log');

    expect(() => store.validateCompletedPhases(checkpoint, snapshot({
      accountCount: 9,
      documentCount: 18,
      itemDocumentCount: 27,
      paymentTransactionCount: 34,
      paymentSyncStatusFingerprint: 'b'.repeat(64),
      itemCount: 39,
      stockLocationCount: 49,
      lastDeletedSync: 301,
    }))).not.toThrow();
  });

  it('validates deleted-log completion against the final cache snapshot', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    completePhase(store, checkpoint, 'accounts');
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
    expect(() => store.validateCompletedPhases(checkpoint, {
      ...deletedLogSnapshot,
      paymentSyncStatusFingerprint: 'c'.repeat(64),
    })).toThrow(/deleted-log.*reset-checkpoint/i);
    expect(() => store.validateCompletedPhases(checkpoint, snapshot({
      accountCount: 8,
      documentCount: 17,
      itemDocumentCount: 26,
      paymentTransactionCount: 33,
      paymentSyncStatusFingerprint: 'c'.repeat(64),
      itemCount: 38,
      stockLocationCount: 48,
      lastDeletedSync: 302,
    }))).toThrow(/deleted-log.*reset-checkpoint/i);
  });

  it('does not complete a phase when an indexer reports failure', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'documents');

    expect(() => store.markPhaseComplete(checkpoint, 'documents', { success: false }, snapshot()))
      .toThrow(/unsuccessful/);
    expect(checkpoint.completedPhases).toEqual([]);
    expect(store.loadOrCreate().completedPhases).toEqual([]);
  });

  it('persists the original failure and removes the checkpoint only on success', () => {
    const store = createStore();
    const checkpoint = store.loadOrCreate();
    store.markPhaseStarted(checkpoint, 'documents');
    store.recordFailure(checkpoint, new Error('upstream failed'));

    expect(store.loadOrCreate().lastError).toBe('upstream failed');
    store.removeAfterSuccess();
    expect(() => statSync(store.checkpointPath)).toThrow();
  });
});
