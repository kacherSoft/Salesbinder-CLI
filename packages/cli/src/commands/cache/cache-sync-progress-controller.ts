import type {
  CacheSyncProgress,
  CacheSyncProgressCallback,
  CacheSyncRateLimitObservation,
  CacheSyncStatus,
} from '@salesbinder/sdk';

export type CacheSyncHealth =
  | 'not_initialized'
  | 'running'
  | 'clock_skew'
  | 'stale_running'
  | 'success'
  | 'success_with_warnings'
  | 'failed';

export interface CacheSyncProgressReporterPort {
  emit(progress: CacheSyncProgress): void;
  touchRunning?(): void;
}

type WritableProgressStream = { write(chunk: string): unknown };
type RateObservation = CacheSyncRateLimitObservation & {
  attempt?: number;
  maxAttempts?: number;
  reason?: 'network' | 'rate_limit' | 'server_error';
};

interface ControllerOptions {
  reporter: CacheSyncProgressReporterPort;
  stderr?: WritableProgressStream;
  isTTY?: boolean;
  now?: () => number;
  ttyIntervalMs?: number;
  nonTtyIntervalMs?: number;
}

const BOUNDARY_EVENTS = new Set<CacheSyncProgress['event']>([
  'phase_started',
  'pass_started',
  'pass_completed',
  'retry_pass_started',
  'waiting_rate_limit',
  'target_captured',
  'batch_claimed',
  'batch_applied',
  'checkpoint_saved',
  'blocker_observed',
  'phase_completed',
]);
const PHASES = new Set<CacheSyncProgress['phase']>([
  'initializing',
  'accounts',
  'categories',
  'documents',
  'inventory',
  'deleted-log',
  'pg-to-sqlite-pull',
  'finalizing',
]);
const EVENTS = new Set<CacheSyncProgress['event']>([
  'phase_started',
  'pass_started',
  'page_started',
  'record_processed',
  'record_failed_collected',
  'page_completed',
  'pass_completed',
  'retry_pass_started',
  'record_retry_succeeded',
  'record_retry_failed',
  'waiting_rate_limit',
  'target_captured',
  'batch_claimed',
  'batch_applied',
  'lease_renewed',
  'checkpoint_saved',
  'blocker_observed',
  'phase_completed',
]);

export class CacheSyncProgressController {
  private readonly reporter: CacheSyncProgressReporterPort;
  private readonly stderr: WritableProgressStream;
  private readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly ttyIntervalMs: number;
  private readonly nonTtyIntervalMs: number;
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private lastRoutineAt = Number.NEGATIVE_INFINITY;
  private lastBoundaryKey = '';
  private current?: CacheSyncProgress;
  private ttyLineOpen = false;

  readonly onProgressEvent: CacheSyncProgressCallback = (event) => {
    const progress = projectCacheSyncProgress(event);
    if (!progress) return;
    this.current = progress;
    this.reporter.emit(progress);
    this.render(progress);
  };

  readonly onProgressHeartbeat = (): void => {
    this.reporter.touchRunning?.();
  };

  readonly rateLimitObserver = (observation: RateObservation): void => {
    if (observation.type === 'headers') return;
    if (observation.type === 'retry') {
      this.renderRetry(observation);
      return;
    }
    const current = this.current;
    this.onProgressEvent({
      phase: current?.phase ?? 'initializing',
      event: 'waiting_rate_limit',
      recordsProcessed: current?.recordsProcessed ?? 0,
      recordsTotal: current?.recordsTotal ?? null,
      indeterminate: current?.indeterminate ?? true,
      ...pickInventoryProgress(current),
      apiVersion: observation.apiVersion === 'v3' ? '3' : '2.0',
      timestamp: Math.floor(this.now() / 1000),
      rateLimit: pickRateLimit(observation),
    });
  };

  constructor(options: ControllerOptions) {
    this.reporter = options.reporter;
    this.stderr = options.stderr ?? process.stderr;
    this.isTTY = options.isTTY ?? Boolean(process.stderr.isTTY);
    this.now = options.now ?? Date.now;
    this.ttyIntervalMs = options.ttyIntervalMs ?? 100;
    this.nonTtyIntervalMs = options.nonTtyIntervalMs ?? 5000;
  }

  finish(): void {
    if (this.isTTY && this.ttyLineOpen) {
      this.stderr.write('\n');
      this.ttyLineOpen = false;
    }
  }

  private render(progress: CacheSyncProgress): void {
    const now = this.now();
    const boundary = BOUNDARY_EVENTS.has(progress.event);
    if (this.isTTY) {
      if (now - this.lastRenderAt < this.ttyIntervalMs) return;
    } else if (boundary) {
      const key = boundaryKey(progress);
      if (key === this.lastBoundaryKey) return;
      this.lastBoundaryKey = key;
    } else {
      if (now - this.lastRoutineAt < this.nonTtyIntervalMs) return;
      this.lastRoutineAt = now;
    }
    this.writeLine(formatProgress(progress, now));
    this.lastRenderAt = now;
  }

  private renderRetry(observation: RateObservation): void {
    const now = this.now();
    if (this.isTTY && now - this.lastRenderAt < this.ttyIntervalMs) return;
    if (!this.isTTY && now - this.lastRoutineAt < this.nonTtyIntervalMs) return;
    const attempt = safePositive(observation.attempt);
    const maximum = safePositive(observation.maxAttempts);
    const suffix = attempt ? ` ${attempt}${maximum ? `/${maximum}` : ''}` : '';
    const reason = observation.reason?.replaceAll('_', ' ') ?? 'request failure';
    this.writeLine(`[cache sync] ${observation.apiVersion}: retry${suffix} after ${reason}`);
    this.lastRenderAt = now;
    if (!this.isTTY) this.lastRoutineAt = now;
  }

  private writeLine(line: string): void {
    if (this.isTTY) {
      this.stderr.write(`\r\u001b[2K${line}`);
      this.ttyLineOpen = true;
      return;
    }
    this.stderr.write(`${line}\n`);
  }
}

export function deriveCacheSyncHealth(
  status: CacheSyncStatus | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): CacheSyncHealth {
  if (!status) return 'not_initialized';
  if (
    status.status === 'success' ||
    status.status === 'success_with_warnings' ||
    status.status === 'failed'
  ) {
    return status.status;
  }
  if (status.status !== 'running') return 'not_initialized';
  const progress = projectCacheSyncProgress(status.progress);
  const updatedAt =
    safeNonNegative(status.progressUpdatedAt) ?? safeNonNegative(status.updatedAt) ?? 0;
  if (updatedAt > nowSeconds + 30) return 'clock_skew';
  const waitUntil = safeNonNegative(progress?.rateLimit?.waitUntil);
  if (waitUntil !== undefined && waitUntil > nowSeconds && waitUntil - nowSeconds <= 900)
    return 'running';
  if (nowSeconds - updatedAt > 120) return 'stale_running';
  return 'running';
}

export function projectCacheSyncProgress(value: unknown): CacheSyncProgress | undefined {
  if (!isRecord(value)) return undefined;
  const recordsProcessed = safeNonNegative(value.recordsProcessed);
  const recordsTotal = value.recordsTotal === null ? null : safeNonNegative(value.recordsTotal);
  if (
    !PHASES.has(value.phase as CacheSyncProgress['phase']) ||
    !EVENTS.has(value.event as CacheSyncProgress['event']) ||
    recordsProcessed === undefined ||
    recordsTotal === undefined ||
    typeof value.indeterminate !== 'boolean'
  )
    return undefined;
  const projected: CacheSyncProgress = {
    phase: value.phase as CacheSyncProgress['phase'],
    event: value.event as CacheSyncProgress['event'],
    ...(safePositive(value.pass) === undefined ? {} : { pass: safePositive(value.pass) }),
    ...(safePositive(value.page) === undefined ? {} : { page: safePositive(value.page) }),
    ...(value.pagesTotal === null
      ? { pagesTotal: null }
      : safePositive(value.pagesTotal) === undefined
        ? {}
        : { pagesTotal: safePositive(value.pagesTotal) }),
    recordsProcessed,
    recordsTotal,
    indeterminate: value.indeterminate,
    ...(value.apiVersion === '2.0' || value.apiVersion === '3'
      ? { apiVersion: value.apiVersion }
      : {}),
    ...(safeNonNegative(value.timestamp) === undefined
      ? {}
      : { timestamp: safeNonNegative(value.timestamp) }),
    ...(isRecord(value.rateLimit) ? { rateLimit: pickRateLimit(value.rateLimit) } : {}),
  };
  if (value.mode === 'baseline' || value.mode === 'replay' || value.mode === 'incremental') {
    projected.mode = value.mode;
  }
  for (const key of [
    'targetEventSeq',
    'observedThroughEventSeq',
    'appliedThroughEventSeq',
  ] as const) {
    const sequence = safeEventSequence(value[key]);
    if (sequence !== undefined) projected[key] = sequence;
  }
  if (value.blockedByEventSeq === null) {
    projected.blockedByEventSeq = null;
  } else {
    const sequence = safeEventSequence(value.blockedByEventSeq);
    if (sequence !== undefined) projected.blockedByEventSeq = sequence;
  }
  for (const key of [
    'batchEventCount',
    'batchItemCount',
    'queueCount',
    'retryCount',
    'deadLetterCount',
    'lastEventAt',
  ] as const) {
    const count = safeNonNegative(value[key]);
    if (count !== undefined) projected[key] = count;
  }
  return projected;
}

function formatProgress(progress: CacheSyncProgress, now: number): string {
  const prefix = `[cache sync] ${progress.phase}`;
  if (progress.event === 'phase_started') return `${prefix}: started`;
  if (progress.event === 'phase_completed') return `${prefix}: completed (${countText(progress)})`;
  if (progress.event === 'waiting_rate_limit') {
    const waitMs =
      progress.rateLimit?.waitMs ??
      (progress.rateLimit?.waitUntil ? Math.max(0, progress.rateLimit.waitUntil * 1000 - now) : 0);
    return `${prefix}: waiting ${(waitMs / 1000).toFixed(1)}s for API ${progress.apiVersion ?? ''} rate limit`.replace(
      'API  rate',
      'API rate'
    );
  }
  return `${prefix}: ${progress.event.replaceAll('_', ' ')} (${countText(progress)})`;
}

function countText(progress: CacheSyncProgress): string {
  const count =
    progress.recordsTotal === null
      ? String(progress.recordsProcessed)
      : `${progress.recordsProcessed}/${progress.recordsTotal}`;
  const page = progress.page
    ? `, page ${progress.page}${progress.pagesTotal ? `/${progress.pagesTotal}` : ''}`
    : '';
  const pass = progress.pass ? `, pass ${progress.pass}` : '';
  return `${count} records${page}${pass}`;
}

function boundaryKey(progress: CacheSyncProgress): string {
  return [
    progress.phase,
    progress.event,
    progress.pass,
    progress.apiVersion,
    progress.mode,
    progress.targetEventSeq,
    progress.observedThroughEventSeq,
    progress.appliedThroughEventSeq,
    progress.blockedByEventSeq,
    progress.rateLimit?.waitUntil,
  ].join(':');
}

function pickRateLimit(value: Record<string, unknown> | CacheSyncRateLimitObservation) {
  return Object.fromEntries(
    ['waitMs', 'waitUntil', 'retryAfterSeconds', 'limit', 'remaining', 'resetSeconds'].flatMap(
      (key) => {
        const number = safeNonNegative((value as Record<string, unknown>)[key]);
        return number === undefined ? [] : [[key, number]];
      }
    )
  );
}

type InventoryProgressProjection = Partial<
  Pick<
    CacheSyncProgress,
    | 'mode'
    | 'targetEventSeq'
    | 'observedThroughEventSeq'
    | 'appliedThroughEventSeq'
    | 'blockedByEventSeq'
    | 'batchEventCount'
    | 'batchItemCount'
    | 'queueCount'
    | 'retryCount'
    | 'deadLetterCount'
    | 'lastEventAt'
  >
>;

function pickInventoryProgress(source: CacheSyncProgress | undefined): InventoryProgressProjection {
  if (!source) return {};
  const projected: InventoryProgressProjection = {};
  for (const key of [
    'mode',
    'targetEventSeq',
    'observedThroughEventSeq',
    'appliedThroughEventSeq',
    'blockedByEventSeq',
    'batchEventCount',
    'batchItemCount',
    'queueCount',
    'retryCount',
    'deadLetterCount',
    'lastEventAt',
  ] as const) {
    if (source[key] !== undefined) Object.assign(projected, { [key]: source[key] });
  }
  return projected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePositive(value: unknown): number | undefined {
  const number = safeNonNegative(value);
  return number && number > 0 ? number : undefined;
}

function safeEventSequence(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined;
  } catch {
    return undefined;
  }
}
