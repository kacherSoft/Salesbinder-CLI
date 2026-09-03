import { performance } from 'node:perf_hooks';
import type { GenericAbortSignal } from 'axios';
import {
  RateLimitCooldownController,
  safeEmitRateLimitObserver,
} from './salesbinder-rate-limit-cooldown.js';
import {
  parseRateLimitHeaders,
  parseRateLimitResetSeconds,
  parseRetryAfterMs,
  readRateLimitHeader,
} from './salesbinder-rate-limit-headers.js';
import { getRateLimitBucketIdentity } from './salesbinder-rate-limit-key.js';
import {
  createRateLimitBucketState,
  decideRateLimitGate,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  quotaReserve,
  reserveRateLimitCapacity,
  updateAdaptiveQuota,
} from './salesbinder-rate-limit-policy.js';
import {
  enqueueRateLimitedRequest,
  notifyRateLimitBucket,
  type RateLimitQueueDependencies,
} from './salesbinder-rate-limit-queue.js';
import { abortableRateLimitSleep } from './salesbinder-rate-limit-sleep.js';
import type {
  RateLimitBucketKey,
  RateLimitBucketState,
  RateLimitObserver,
  RateLimitResponseObservation,
  SalesBinderRateLimiterOptions,
} from './salesbinder-rate-limit-types.js';

const DEFAULT_IDLE_BUCKET_TTL_MS = 30 * 60_000;

export interface ClientRuntimeOptions {
  rateLimitObserver?: RateLimitObserver;
  rateLimiterRegistry?: SalesBinderRateLimiter;
}

/** A process-local FIFO registry shared by all SDK clients unless explicitly injected. */
export class SalesBinderRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucketState>();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly idleBucketTtlMs: number;
  private readonly cooldown: RateLimitCooldownController;
  private readonly queueDependencies: RateLimitQueueDependencies;

  constructor(options: SalesBinderRateLimiterOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.idleBucketTtlMs = options.idleBucketTtlMs ?? DEFAULT_IDLE_BUCKET_TTL_MS;
    this.cooldown = new RateLimitCooldownController(
      this.now,
      this.wallNow,
      options.random ?? Math.random
    );
    this.queueDependencies = {
      now: this.now,
      sleep: options.sleep ?? abortableRateLimitSleep,
      decide: decideRateLimitGate,
      reserve: reserveRateLimitCapacity,
      applyCooldown: (bucket, directiveMs, observer, metadata) =>
        this.cooldown.apply(bucket, directiveMs, observer, metadata),
      emitWait: (bucket, observer, waitMs) => this.cooldown.emitWait(bucket, observer, waitMs),
    };
  }

  beforeRequest(
    key: RateLimitBucketKey,
    signal?: GenericAbortSignal,
    observer?: RateLimitObserver
  ): Promise<void> {
    return enqueueRateLimitedRequest(this.getBucket(key), this.queueDependencies, signal, observer);
  }

  observeResponse(
    key: RateLimitBucketKey,
    observation: RateLimitResponseObservation,
    observer?: RateLimitObserver
  ): void {
    const bucket = this.getBucket(key);
    const now = this.now();
    bucket.lastUsed = now;
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);

    if (bucket.apiVersion === 'v3') {
      bucket.v3BootstrapInFlight = false;
      if (observation.receivedResponse) {
        const parsed = parseRateLimitHeaders(observation.headers);
        bucket.v3Initialized = true;
        if (parsed) {
          safeEmitRateLimitObserver(observer, {
            type: 'headers',
            apiVersion: 'v3',
            limit: parsed.limit,
            remaining: parsed.remaining,
            resetSeconds: parsed.resetSeconds,
          });
          if (observation.status !== 429) {
            updateAdaptiveQuota(bucket, parsed, now);
            const quota = bucket.v3Quota;
            if (quota && quota.remaining <= quotaReserve(quota.limit)) {
              const resetSeconds = Math.ceil((quota.resetAt - now) / 1000);
              this.cooldown.apply(bucket, resetSeconds * 1000, observer, {
                resetSeconds,
              });
            }
          }
        }
      }
    }

    if (observation.status === 429) {
      if (bucket.apiVersion === 'v3') bucket.v3Quota = undefined;
      this.observeRateLimitResponse(bucket, observation, observer);
    }
    notifyRateLimitBucket(bucket);
  }

  private observeRateLimitResponse(
    bucket: RateLimitBucketState,
    observation: RateLimitResponseObservation,
    observer: RateLimitObserver | undefined
  ): void {
    const retryAfterMs = parseRetryAfterMs(
      readRateLimitHeader(observation.headers, 'retry-after'),
      this.wallNow()
    );
    const resetSeconds = parseRateLimitResetSeconds(observation.headers);
    const directiveMs =
      retryAfterMs ??
      (resetSeconds !== undefined ? resetSeconds * 1000 : DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    this.cooldown.apply(bucket, directiveMs, observer, {
      retryAfterSeconds: retryAfterMs === undefined ? undefined : retryAfterMs / 1000,
      resetSeconds: retryAfterMs === undefined ? resetSeconds : undefined,
    });
  }

  private getBucket(key: RateLimitBucketKey): RateLimitBucketState {
    const identity = getRateLimitBucketIdentity(key);
    this.pruneIdleBuckets();
    let bucket = this.buckets.get(identity);
    if (!bucket) {
      bucket = createRateLimitBucketState(key.apiVersion, this.now());
      this.buckets.set(identity, bucket);
    }
    return bucket;
  }

  private pruneIdleBuckets(): void {
    const now = this.now();
    for (const [identity, bucket] of this.buckets) {
      if (
        bucket.queue.length === 0 &&
        bucket.inFlight === 0 &&
        bucket.cooldownUntil <= now &&
        (bucket.excessiveDirectiveUntil ?? 0) <= now &&
        now - bucket.lastUsed >= this.idleBucketTtlMs
      ) {
        this.buckets.delete(identity);
      }
    }
  }
}

const defaultRateLimiterRegistry = new SalesBinderRateLimiter();

export function getDefaultRateLimiterRegistry(): SalesBinderRateLimiter {
  return defaultRateLimiterRegistry;
}

export { parseRateLimitHeaders, parseRetryAfterMs } from './salesbinder-rate-limit-headers.js';
export {
  createV2RateLimitBucketKey,
  createV3RateLimitBucketKey,
} from './salesbinder-rate-limit-key.js';
export { installRateLimiterInterceptors } from './salesbinder-rate-limit-interceptors.js';
export { RateLimitAbortError, RateLimitWaitExceededError } from './salesbinder-rate-limit-types.js';
export type {
  RateLimitApiVersion,
  RateLimitBucketKey,
  RateLimitObserver,
  RateLimitObserverEvent,
  RateLimitObserverEventType,
  RateLimitReason,
  RateLimitResponseObservation,
  SalesBinderRateLimiterOptions,
} from './salesbinder-rate-limit-types.js';
