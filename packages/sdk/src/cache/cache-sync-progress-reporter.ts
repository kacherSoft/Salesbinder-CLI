import type { CacheService } from './cache.interface.js';
import type {
  CacheSyncPhase,
  CacheSyncProgress,
  CacheSyncRateLimitObservation,
  CacheSyncRateLimitProgress,
} from './cache-sync-progress.types.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';
import type { CacheSyncStatus } from './types.js';

export interface CacheSyncProgressReporterContext {
  runId: string;
  accountName: string;
  syncTarget: 'sqlite' | 'postgresql';
  startedAt: number;
  syncType?: 'full' | 'delta';
}

export interface CacheSyncProgressReporterOptions {
  /** Millisecond wall clock used for throttling and persisted Unix timestamps. */
  now?: () => number;
  minIntervalMs?: number;
  rateLimitIntervalMs?: number;
  materialRateLimitIncreaseSeconds?: number;
}

type ProtectedStatusKey =
  | 'status'
  | 'runId'
  | 'accountName'
  | 'syncTarget'
  | 'startedAt'
  | 'updatedAt'
  | 'finishedAt'
  | 'phase'
  | 'progress'
  | 'progressUpdatedAt';

export type CacheSyncStatusSummary = Partial<Omit<CacheSyncStatus, ProtectedStatusKey>>;

const FORCED_EVENTS = new Set<CacheSyncProgress['event']>(['phase_started', 'phase_completed']);

/** Serializes and throttles complete cache sync status replacements for one run. */
export class CacheSyncProgressReporter {
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly rateLimitIntervalMs: number;
  private readonly materialRateLimitIncreaseSeconds: number;
  private status: CacheSyncStatus;
  private pending: Promise<void> = Promise.resolve();
  private terminalCommitted = false;
  private terminalAttempt?: Promise<void>;
  private terminalPromise?: Promise<void>;
  private hasWriteError = false;
  private writeError?: unknown;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private lastRateLimitWriteAt = Number.NEGATIVE_INFINITY;
  private lastRateLimitSignature?: string;
  private lastRateLimitDeadline?: number;
  private persistedWaiting = false;

  constructor(
    private readonly cache: Pick<CacheService, 'setSyncStatus'>,
    context: CacheSyncProgressReporterContext,
    options: CacheSyncProgressReporterOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.minIntervalMs = validInterval(options.minIntervalMs, 1_000);
    this.rateLimitIntervalMs = validInterval(options.rateLimitIntervalMs, 5_000);
    this.materialRateLimitIncreaseSeconds = validInterval(
      options.materialRateLimitIncreaseSeconds,
      5
    );
    this.status = { ...context, status: 'running', updatedAt: context.startedAt };
  }

  markRunning(summary: CacheSyncStatusSummary = {}): Promise<void> {
    if (this.terminalCommitted || this.terminalAttempt)
      return this.terminalPromise ?? this.terminalAttempt ?? this.flush();
    this.scheduleStatus('running', summary);
    return this.flush();
  }

  emit(event: CacheSyncProgress): void {
    if (this.terminalCommitted || this.terminalAttempt) return;
    const progress = projectProgress(event);
    const now = this.now();
    if (!this.shouldPersist(progress, now)) return;

    this.lastWriteAt = now;
    this.persistedWaiting = progress.event === 'waiting_rate_limit';
    if (this.persistedWaiting) this.recordRateLimitWrite(progress, now);
    this.enqueue(async () => {
      const timestamp = toUnixSeconds(now);
      this.status = {
        ...this.status,
        status: 'running',
        phase: progress.phase,
        progress,
        progressUpdatedAt: timestamp,
        updatedAt: timestamp,
      };
      await this.cache.setSyncStatus(this.status);
    });
  }

  emitRateLimit(phase: CacheSyncPhase, event: CacheSyncRateLimitObservation): void {
    if (event.type !== 'wait' && event.type !== 'cooldown') return;
    const previous = this.status.progress?.phase === phase ? this.status.progress : undefined;
    this.emit({
      phase,
      event: 'waiting_rate_limit',
      recordsProcessed: previous?.recordsProcessed ?? 0,
      recordsTotal: previous?.recordsTotal ?? null,
      indeterminate: previous?.indeterminate ?? true,
      apiVersion: event.apiVersion === 'v2' ? '2.0' : '3',
      timestamp: toUnixSeconds(this.now()),
      rateLimit: projectRateLimit(event),
    });
  }

  markSuccess(summary: CacheSyncStatusSummary = {}): Promise<void> {
    return this.finish('success', summary);
  }

  markSuccessWithWarnings(
    summary: CacheSyncStatusSummary = {},
    recordIssues: SyncRecordIssue[] = []
  ): Promise<void> {
    return this.finish('success_with_warnings', { ...summary, recordIssues });
  }

  markFailure(error: unknown, summary: CacheSyncStatusSummary = {}): Promise<void> {
    return this.finish('failed', { ...summary, error: safeFailureMessage(error) });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.hasWriteError) throw this.writeError;
  }

  private finish(
    status: Exclude<CacheSyncStatus['status'], 'running'>,
    summary: CacheSyncStatusSummary
  ): Promise<void> {
    if (this.terminalCommitted) return this.terminalPromise ?? this.flush();
    if (this.terminalAttempt) return this.terminalAttempt;

    const write = this.scheduleStatus(status, summary);
    const attempt = write.then(
      () => {
        this.terminalCommitted = true;
        this.terminalPromise = attempt;
        if (this.terminalAttempt === attempt) this.terminalAttempt = undefined;
      },
      (error: unknown) => {
        if (this.terminalAttempt === attempt) this.terminalAttempt = undefined;
        throw error;
      }
    );
    this.terminalAttempt = attempt;
    return attempt;
  }

  private scheduleStatus(
    status: CacheSyncStatus['status'],
    summary: CacheSyncStatusSummary
  ): Promise<void> {
    const now = this.now();
    this.lastWriteAt = now;
    return this.enqueue(async () => {
      if ((status === 'success' || status === 'success_with_warnings') && this.hasWriteError) {
        throw this.writeError;
      }
      const timestamp = toUnixSeconds(now);
      this.status = {
        ...this.status,
        ...summary,
        status,
        updatedAt: timestamp,
        ...(status === 'running' ? {} : { finishedAt: timestamp }),
      };
      await this.cache.setSyncStatus(this.status);
      if (status === 'failed') {
        this.hasWriteError = false;
        this.writeError = undefined;
      }
    });
  }

  private shouldPersist(progress: CacheSyncProgress, now: number): boolean {
    if (progress.event === 'waiting_rate_limit') return this.shouldPersistRateLimit(progress, now);
    if (this.persistedWaiting || FORCED_EVENTS.has(progress.event)) return true;
    return now - this.lastWriteAt >= this.minIntervalMs;
  }

  private shouldPersistRateLimit(progress: CacheSyncProgress, now: number): boolean {
    if (!this.persistedWaiting) return true;
    const signature = rateLimitSignature(progress);
    if (signature !== this.lastRateLimitSignature) return true;
    const deadline = progress.rateLimit?.waitUntil;
    if (
      deadline !== undefined &&
      this.lastRateLimitDeadline !== undefined &&
      deadline - this.lastRateLimitDeadline >= this.materialRateLimitIncreaseSeconds
    )
      return true;
    return now - this.lastRateLimitWriteAt >= this.rateLimitIntervalMs;
  }

  private recordRateLimitWrite(progress: CacheSyncProgress, now: number): void {
    this.lastRateLimitWriteAt = now;
    this.lastRateLimitSignature = rateLimitSignature(progress);
    this.lastRateLimitDeadline = progress.rateLimit?.waitUntil;
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const writeResult = this.pending.then(write);
    this.pending = writeResult.then(
      () => undefined,
      (error: unknown) => {
        if (!this.hasWriteError) {
          this.hasWriteError = true;
          this.writeError = error;
        }
      }
    );
    return writeResult;
  }
}

function projectProgress(event: CacheSyncProgress): CacheSyncProgress {
  const projected: CacheSyncProgress = {
    phase: event.phase,
    event: event.event,
    recordsProcessed: event.recordsProcessed,
    recordsTotal: event.recordsTotal,
    indeterminate: event.indeterminate,
  };
  for (const key of ['pass', 'page', 'pagesTotal', 'apiVersion', 'timestamp'] as const) {
    if (event[key] !== undefined) Object.assign(projected, { [key]: event[key] });
  }
  if (event.rateLimit) projected.rateLimit = projectRateLimit(event.rateLimit);
  return projected;
}

function projectRateLimit(source: CacheSyncRateLimitProgress): CacheSyncRateLimitProgress {
  const projected: CacheSyncRateLimitProgress = {};
  for (const key of [
    'waitMs',
    'waitUntil',
    'retryAfterSeconds',
    'limit',
    'remaining',
    'resetSeconds',
  ] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) projected[key] = value;
  }
  return projected;
}

function rateLimitSignature(progress: CacheSyncProgress): string {
  const rateLimit = progress.rateLimit;
  return JSON.stringify([
    progress.phase,
    progress.apiVersion,
    rateLimit?.limit,
    rateLimit?.remaining,
  ]);
}

function validInterval(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toUnixSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1_000);
}

function safeFailureMessage(_error: unknown): string {
  return 'Cache sync failed.';
}
