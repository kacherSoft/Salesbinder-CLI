import type { CacheSyncProgress, CacheSyncStatus } from '@salesbinder/sdk';
import {
  CacheSyncProgressController,
  deriveCacheSyncHealth,
  projectCacheSyncProgress,
} from './cache-sync-progress-controller.js';

function progress(overrides: Partial<CacheSyncProgress> = {}): CacheSyncProgress {
  return {
    phase: 'documents',
    event: 'record_processed',
    recordsProcessed: 1,
    recordsTotal: null,
    indeterminate: true,
    ...overrides,
  };
}

function runningStatus(overrides: Partial<CacheSyncStatus> = {}): CacheSyncStatus {
  return {
    status: 'running',
    runId: 'run-1',
    accountName: 'default',
    syncTarget: 'sqlite',
    startedAt: 900,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('CacheSyncProgressController', () => {
  it('renders TTY progress in place at no more than 10Hz', () => {
    let now = 0;
    const writes: string[] = [];
    const emitted: CacheSyncProgress[] = [];
    const controller = new CacheSyncProgressController({
      reporter: { emit: (event) => emitted.push(event) },
      stderr: { write: (line) => writes.push(line) },
      isTTY: true,
      now: () => now,
    });

    controller.onProgressEvent(progress({ event: 'phase_started', recordsProcessed: 0 }));
    now = 50;
    controller.onProgressEvent(progress({ recordsProcessed: 2 }));
    now = 100;
    controller.onProgressEvent(progress({ recordsProcessed: 3 }));
    controller.finish();

    expect(emitted).toHaveLength(3);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toMatch(/^\r\u001b\[2K\[cache sync\]/);
    expect(writes[1]).toContain('3 records');
    expect(writes[2]).toBe('\n');
  });

  it('renders non-TTY boundaries and throttles routine updates to five seconds', () => {
    let now = 0;
    const writes: string[] = [];
    const controller = new CacheSyncProgressController({
      reporter: { emit: () => undefined },
      stderr: { write: (line) => writes.push(line) },
      isTTY: false,
      now: () => now,
    });

    controller.onProgressEvent(progress({ event: 'phase_started', recordsProcessed: 0 }));
    now = 1;
    controller.onProgressEvent(progress({ recordsProcessed: 1 }));
    now = 1_000;
    controller.onProgressEvent(progress({ recordsProcessed: 2 }));
    now = 5_001;
    controller.onProgressEvent(progress({ event: 'page_completed', recordsProcessed: 3 }));
    now = 5_002;
    controller.onProgressEvent(progress({ event: 'phase_completed', recordsProcessed: 3 }));

    expect(writes).toHaveLength(4);
    expect(writes.join('')).toContain('documents: started');
    expect(writes.join('')).toContain('documents: completed');
    expect(writes.join('')).not.toContain('2 records');
  });

  it('routes redacted limiter waits through the reporter and retry text through stderr', () => {
    let now = 2_000_000;
    const writes: string[] = [];
    const emitted: CacheSyncProgress[] = [];
    const controller = new CacheSyncProgressController({
      reporter: { emit: (event) => emitted.push(event) },
      stderr: { write: (line) => writes.push(line) },
      isTTY: false,
      now: () => now,
    });
    controller.onProgressEvent(progress({ phase: 'inventory', recordsProcessed: 4 }));

    controller.rateLimitObserver({
      type: 'wait',
      apiVersion: 'v3',
      waitMs: 2_500,
      waitUntil: 2_003,
      remaining: 0,
      authorization: 'Bearer secret',
      url: 'https://secret.example/items',
    } as never);
    now += 5_001;
    controller.rateLimitObserver({
      type: 'retry',
      apiVersion: 'v3',
      attempt: 2,
      maxAttempts: 5,
      reason: 'rate_limit',
      requestId: 'secret-id',
    } as never);

    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        phase: 'inventory',
        event: 'waiting_rate_limit',
        apiVersion: '3',
        rateLimit: { waitMs: 2_500, waitUntil: 2_003, remaining: 0 },
      })
    );
    const allOutput = writes.join('');
    expect(allOutput).toContain('waiting 2.5s');
    expect(allOutput).toContain('retry 2/5 after rate limit');
    expect(allOutput).not.toMatch(/secret|Bearer|requestId|items/);
  });

  it('touches running status without output or changing the current semantic phase', () => {
    const writes: string[] = [];
    const emitted: CacheSyncProgress[] = [];
    const touchRunning = jest.fn();
    const controller = new CacheSyncProgressController({
      reporter: { emit: (event) => emitted.push(event), touchRunning },
      stderr: { write: (line) => writes.push(line) },
      isTTY: false,
      now: () => 2_000_000,
    });
    controller.onProgressEvent(progress({ phase: 'inventory', recordsProcessed: 4 }));
    const writesBeforeHeartbeat = writes.length;
    const eventsBeforeHeartbeat = emitted.length;

    controller.onProgressHeartbeat();

    expect(touchRunning).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(writesBeforeHeartbeat);
    expect(emitted).toHaveLength(eventsBeforeHeartbeat);

    controller.rateLimitObserver({
      type: 'wait',
      apiVersion: 'v3',
      waitMs: 2_500,
      waitUntil: 2_003,
    });

    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        phase: 'inventory',
        event: 'waiting_rate_limit',
        recordsProcessed: 4,
      })
    );
  });

  it('shares the five-second non-TTY routine budget with transport retries', () => {
    let now = 0;
    const writes: string[] = [];
    const controller = new CacheSyncProgressController({
      reporter: { emit: () => undefined },
      stderr: { write: (line) => writes.push(line) },
      isTTY: false,
      now: () => now,
    });

    controller.rateLimitObserver({ type: 'retry', apiVersion: 'v2', attempt: 1, maxAttempts: 5 });
    now = 1_000;
    controller.rateLimitObserver({ type: 'retry', apiVersion: 'v2', attempt: 2, maxAttempts: 5 });
    controller.onProgressEvent(progress({ recordsProcessed: 2 }));
    now = 5_000;
    controller.rateLimitObserver({ type: 'retry', apiVersion: 'v2', attempt: 3, maxAttempts: 5 });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('retry 1/5');
    expect(writes[1]).toContain('retry 3/5');
  });

  it('drops non-allowlisted live fields before persistence and rendering', () => {
    const projected = projectCacheSyncProgress({
      ...progress(),
      currentRecordId: 'doc-secret',
      contextName: 'Customer secret',
      message: 'raw response secret',
      rateLimit: { waitMs: 1000, headers: { authorization: 'secret' } },
    });

    expect(projected).toEqual({
      phase: 'documents',
      event: 'record_processed',
      recordsProcessed: 1,
      recordsTotal: null,
      indeterminate: true,
      rateLimit: { waitMs: 1000 },
    });
  });
});

describe('deriveCacheSyncHealth', () => {
  it.each([
    ['not_initialized', undefined, 1_000],
    ['running', runningStatus(), 1_100],
    [
      'running',
      runningStatus({
        updatedAt: 700,
        progress: progress({
          event: 'waiting_rate_limit',
          rateLimit: { waitUntil: 1_300 },
        }),
      }),
      1_200,
    ],
    [
      'clock_skew',
      runningStatus({
        progressUpdatedAt: 1_031,
        progress: progress({
          event: 'waiting_rate_limit',
          rateLimit: { waitUntil: 1_200 },
        }),
      }),
      1_000,
    ],
    ['clock_skew', runningStatus({ progressUpdatedAt: 1_031 }), 1_000],
    ['stale_running', runningStatus({ progressUpdatedAt: 879 }), 1_000],
    ['success', runningStatus({ status: 'success' }), 1_000],
    ['success_with_warnings', runningStatus({ status: 'success_with_warnings' }), 1_000],
    ['failed', runningStatus({ status: 'failed' }), 1_000],
  ] as const)('returns %s for the persisted status', (expected, status, now) => {
    expect(deriveCacheSyncHealth(status, now)).toBe(expected);
  });

  it('does not trust an implausibly distant limiter deadline', () => {
    const status = runningStatus({
      updatedAt: 700,
      progress: progress({
        event: 'waiting_rate_limit',
        rateLimit: { waitUntil: 2_000 },
      }),
    });
    expect(deriveCacheSyncHealth(status, 1_000)).toBe('stale_running');
    expect(status.status).toBe('running');
  });
});
