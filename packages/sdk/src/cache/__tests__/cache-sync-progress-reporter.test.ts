import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import { CacheSyncProgressReporter } from '../cache-sync-progress-reporter.js';
import type { SyncRecordIssue } from '../sync-record-issue.types.js';
import type { CacheSyncStatus } from '../types.js';

const context = {
  runId: 'run-1',
  accountName: 'test',
  syncTarget: 'postgresql' as const,
  startedAt: 100,
  syncType: 'delta' as const,
};

const progress = (
  event: CacheSyncProgress['event'],
  overrides: Partial<CacheSyncProgress> = {}
): CacheSyncProgress => ({
  phase: 'documents',
  event,
  recordsProcessed: 0,
  recordsTotal: null,
  indeterminate: true,
  ...overrides,
});

describe('CacheSyncProgressReporter', () => {
  it('serializes writes, throttles routine events, and projects only allowlisted progress', async () => {
    let now = 100_000;
    const statuses: CacheSyncStatus[] = [];
    const cache = cacheWithWriter(async (status) => {
      statuses.push(status);
    });
    const reporter = new CacheSyncProgressReporter(cache, context, { now: () => now });

    await reporter.markRunning({ message: 'Starting' });
    reporter.emit(progress('phase_started'));
    await reporter.flush();

    now += 100;
    reporter.emit({
      ...progress('record_processed', { recordsProcessed: 1 }),
      recordId: 'must-not-persist',
      name: 'must-not-persist',
      message: 'must-not-persist',
    } as CacheSyncProgress);
    await reporter.flush();
    expect(statuses).toHaveLength(2);

    now += 900;
    reporter.emit(progress('record_processed', { recordsProcessed: 2 }));
    await reporter.flush();

    expect(statuses).toHaveLength(3);
    expect(statuses[2].progress).toEqual({
      phase: 'documents',
      event: 'record_processed',
      recordsProcessed: 2,
      recordsTotal: null,
      indeterminate: true,
    });
    expect(statuses[2].progress).not.toHaveProperty('recordId');
    expect(statuses[2].progress).not.toHaveProperty('name');
    expect(statuses[2].progress).not.toHaveProperty('message');
  });

  it('coalesces repeated waits and immediately replaces a persisted wait after requests resume', async () => {
    let now = 100_000;
    const statuses: CacheSyncStatus[] = [];
    const cache = cacheWithWriter(async (status) => {
      statuses.push(status);
    });
    const reporter = new CacheSyncProgressReporter(cache, context, { now: () => now });

    await reporter.markRunning();
    reporter.emitRateLimit('categories', {
      type: 'wait',
      apiVersion: 'v3',
      waitMs: 2_000,
      waitUntil: 102,
      limit: 120,
      remaining: 0,
      resetSeconds: 2,
    });
    await reporter.flush();
    expect(statuses).toHaveLength(2);

    now += 100;
    reporter.emitRateLimit('categories', {
      type: 'wait',
      apiVersion: 'v3',
      waitMs: 1_900,
      waitUntil: 102,
      limit: 120,
      remaining: 0,
      resetSeconds: 2,
    });
    await reporter.flush();
    expect(statuses).toHaveLength(2);

    now += 4_900;
    reporter.emitRateLimit('categories', {
      type: 'wait',
      apiVersion: 'v3',
      waitMs: 1_000,
      waitUntil: 102,
      limit: 120,
      remaining: 0,
      resetSeconds: 2,
    });
    await reporter.flush();
    expect(statuses).toHaveLength(3);

    now += 1;
    reporter.emitRateLimit('categories', {
      type: 'cooldown',
      apiVersion: 'v3',
      waitMs: 2_000,
      waitUntil: 108,
      limit: 120,
      remaining: 0,
      resetSeconds: 2,
    });
    await reporter.flush();
    expect(statuses).toHaveLength(4);

    reporter.emit(
      progress('page_completed', {
        phase: 'categories',
        page: 1,
        pagesTotal: 2,
        recordsProcessed: 100,
        recordsTotal: 200,
        indeterminate: false,
      })
    );
    await reporter.flush();

    expect(statuses.at(-1)?.progress?.event).toBe('page_completed');
    expect(statuses.at(-2)?.progress).toMatchObject({
      event: 'waiting_rate_limit',
      apiVersion: '3',
      rateLimit: { waitMs: 2_000, waitUntil: 108, remaining: 0 },
    });
  });

  it('drops non-numeric and non-finite rate-limit values at the reporter boundary', async () => {
    const statuses: CacheSyncStatus[] = [];
    const reporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        statuses.push(status);
      }),
      context,
      { now: () => 100_000 }
    );
    await reporter.markRunning();

    reporter.emitRateLimit('documents', {
      type: 'wait',
      apiVersion: 'v2',
      waitUntil: 101,
      limit: 50,
      waitMs: 'Authorization: Bearer secret',
      remaining: Number.POSITIVE_INFINITY,
      resetSeconds: -1,
    } as unknown as import('../cache-sync-progress.types.js').CacheSyncRateLimitObservation);
    await reporter.flush();

    expect(statuses.at(-1)?.progress?.rateLimit).toEqual({ waitUntil: 101, limit: 50 });
    expect(JSON.stringify(statuses.at(-1))).not.toMatch(/Authorization|Bearer|secret|Infinity/);
  });

  it('writes a terminal status last and ignores all later progress or terminal attempts', async () => {
    let now = 100_000;
    const statuses: CacheSyncStatus[] = [];
    let releaseRoutineWrite: (() => void) | undefined;
    const routineWriteBlocked = new Promise<void>((resolve) => {
      releaseRoutineWrite = resolve;
    });
    const cache = cacheWithWriter(async (status) => {
      if (status.progress?.event === 'record_processed') await routineWriteBlocked;
      statuses.push(status);
    });
    const reporter = new CacheSyncProgressReporter(cache, context, { now: () => now });

    await reporter.markRunning();
    now += 1_000;
    reporter.emit(progress('record_processed', { recordsProcessed: 1 }));
    const terminal = reporter.markSuccess({ documentsProcessed: 1 });
    const repeatedTerminal = reporter.markFailure(new Error('ignored'));

    expect(repeatedTerminal).toBe(terminal);

    await Promise.resolve();
    expect(statuses.map(({ status }) => status)).toEqual(['running']);
    releaseRoutineWrite?.();
    await terminal;

    reporter.emit(progress('phase_completed', { recordsProcessed: 2 }));
    await reporter.markFailure(new Error('https://secret.invalid Authorization: Bearer token'));
    await reporter.flush();

    expect(statuses.map(({ status }) => status)).toEqual(['running', 'running', 'success']);
    expect(statuses.at(-1)).toMatchObject({
      status: 'success',
      documentsProcessed: 1,
      finishedAt: 101,
    });
  });

  it.each(['success', 'success_with_warnings'] as const)(
    'rejects %s before persistence after an earlier routine write fails',
    async (terminalStatus) => {
      const attempts: CacheSyncStatus[] = [];
      const writeFailure = new Error('status write failed');
      const reporter = new CacheSyncProgressReporter(
        cacheWithWriter(async (status) => {
          attempts.push(status);
          if (status.status === 'running' && status.progress?.event === 'phase_started') {
            throw writeFailure;
          }
        }),
        context,
        { now: () => 100_000 }
      );

      await reporter.markRunning();
      reporter.emit(progress('phase_started'));
      await expect(reporter.flush()).rejects.toBe(writeFailure);

      const terminal =
        terminalStatus === 'success'
          ? reporter.markSuccess({ documentsProcessed: 1 })
          : reporter.markSuccessWithWarnings({ documentsProcessed: 1 });
      expect(reporter.markFailure(new Error('ignored'))).toBe(terminal);
      await expect(terminal).rejects.toBe(writeFailure);

      expect(attempts.map(({ status }) => status)).toEqual(['running', 'running']);

      const failed = reporter.markFailure(
        new Error('https://secret.invalid Authorization: Bearer status-token')
      );
      await expect(failed).resolves.toBeUndefined();
      expect(reporter.markSuccess()).toBe(failed);
      await expect(reporter.flush()).resolves.toBeUndefined();

      expect(attempts.map(({ status }) => status)).toEqual(['running', 'running', 'failed']);
      expect(attempts.at(-1)).toMatchObject({ status: 'failed', error: 'Cache sync failed.' });
      expect(JSON.stringify(attempts.at(-1))).not.toMatch(
        /secret\.invalid|Authorization|Bearer|status-token/
      );
    }
  );

  it('allows one sanitized failed terminal after a successful terminal write rejects', async () => {
    const attempts: CacheSyncStatus[] = [];
    const terminalFailure = new Error('terminal status write failed');
    const reporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        attempts.push(status);
        if (status.status === 'success') throw terminalFailure;
      }),
      context,
      { now: () => 100_000 }
    );

    await reporter.markRunning();
    const terminal = reporter.markSuccess();

    expect(reporter.markFailure(new Error('ignored'))).toBe(terminal);
    await expect(terminal).rejects.toBe(terminalFailure);

    const failed = reporter.markFailure(
      new Error('https://secret.invalid Authorization: Bearer terminal-token')
    );
    await expect(failed).resolves.toBeUndefined();
    expect(reporter.markSuccessWithWarnings()).toBe(failed);
    await expect(reporter.flush()).resolves.toBeUndefined();

    expect(attempts.map(({ status }) => status)).toEqual(['running', 'success', 'failed']);
    expect(attempts.at(-1)).toMatchObject({ status: 'failed', error: 'Cache sync failed.' });
    expect(JSON.stringify(attempts.at(-1))).not.toMatch(
      /secret\.invalid|Authorization|Bearer|terminal-token/
    );
  });

  it('retains the first routine error until a failed terminal actually commits', async () => {
    const routineFailure = new Error('routine status write failed');
    const failedTerminalFailure = new Error('failed terminal write failed');
    let rejectFailedTerminal = true;
    const reporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        if (status.status === 'running' && status.progress?.event === 'phase_started') {
          throw routineFailure;
        }
        if (status.status === 'failed' && rejectFailedTerminal) {
          rejectFailedTerminal = false;
          throw failedTerminalFailure;
        }
      }),
      context,
      { now: () => 100_000 }
    );

    await reporter.markRunning();
    reporter.emit(progress('phase_started'));
    await expect(reporter.markSuccess()).rejects.toBe(routineFailure);
    await expect(reporter.markFailure(new Error('private failure detail'))).rejects.toBe(
      failedTerminalFailure
    );
    await expect(reporter.flush()).rejects.toBe(routineFailure);

    await expect(reporter.markFailure(new Error('private retry detail'))).resolves.toBeUndefined();
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('tracks an undefined routine rejection until failed terminal persistence succeeds', async () => {
    const reporter = new CacheSyncProgressReporter(
      cacheWithWriter((status) =>
        status.status === 'running' && status.progress?.event === 'phase_started'
          ? Promise.reject()
          : Promise.resolve()
      ),
      context,
      { now: () => 100_000 }
    );

    await reporter.markRunning();
    reporter.emit(progress('phase_started'));

    await expect(reporter.flush()).rejects.toBeUndefined();
    await expect(reporter.markSuccess()).rejects.toBeUndefined();
    await expect(reporter.flush()).rejects.toBeUndefined();
    await expect(
      reporter.markFailure(new Error('private failure detail'))
    ).resolves.toBeUndefined();
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('keeps a failed phase start sticky across a queued successful phase completion', async () => {
    const attempts: CacheSyncStatus[] = [];
    const routineFailure = new Error('routine status write failed');
    const reporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        attempts.push(status);
        if (status.progress?.event === 'phase_started') throw routineFailure;
      }),
      context,
      { now: () => 100_000 }
    );

    await reporter.markRunning();
    reporter.emit(progress('phase_started'));
    reporter.emit(progress('phase_completed', { recordsProcessed: 3 }));
    await expect(reporter.flush()).rejects.toBe(routineFailure);

    expect(attempts.map(({ progress: statusProgress }) => statusProgress?.event)).toEqual([
      undefined,
      'phase_started',
      'phase_completed',
    ]);
  });

  it('persists warning issues and guards warning and failure terminal states', async () => {
    const warningStatuses: CacheSyncStatus[] = [];
    const warningReporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        warningStatuses.push(status);
      }),
      context,
      { now: () => 100_000 }
    );
    const issues: SyncRecordIssue[] = [
      {
        resource: 'item' as const,
        id: 'item-1',
        code: 'invalid_variations' as const,
        message: 'Item variations were invalid.',
        attempts: 2,
        outcome: 'omitted_new' as const,
      },
    ];

    await warningReporter.markRunning();
    await warningReporter.markSuccessWithWarnings({ itemsProcessed: 3 }, issues);
    await warningReporter.markSuccess();

    expect(warningStatuses.at(-1)).toMatchObject({
      status: 'success_with_warnings',
      recordIssues: issues,
    });

    const failureStatuses: CacheSyncStatus[] = [];
    const failureReporter = new CacheSyncProgressReporter(
      cacheWithWriter(async (status) => {
        failureStatuses.push(status);
      }),
      { ...context, runId: 'run-2' },
      { now: () => 100_000 }
    );
    await failureReporter.markRunning();
    await failureReporter.markFailure(
      new Error('https://secret.invalid Authorization: Bearer token')
    );
    await failureReporter.markSuccess();

    expect(failureStatuses.at(-1)).toMatchObject({ status: 'failed', error: 'Cache sync failed.' });
    expect(JSON.stringify(failureStatuses.at(-1))).not.toMatch(
      /secret\.invalid|Authorization|Bearer|token/
    );
  });
});

function cacheWithWriter(writer: (status: CacheSyncStatus) => Promise<void>): CacheService {
  return { setSyncStatus: jest.fn(writer) } as unknown as CacheService;
}
