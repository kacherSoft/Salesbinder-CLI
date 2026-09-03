import { MAX_RATE_LIMIT_WAIT_MS } from './salesbinder-rate-limit-policy.js';
import type {
  CooldownMetadata,
  RateLimitBucketState,
  RateLimitObserver,
  RateLimitObserverEvent,
} from './salesbinder-rate-limit-types.js';

const MIN_JITTER_MS = 250;
const MAX_JITTER_MS = 1_000;

export class RateLimitCooldownController {
  constructor(
    private readonly now: () => number,
    private readonly wallNow: () => number,
    private readonly random: () => number
  ) {}

  apply(
    bucket: RateLimitBucketState,
    directiveMs: number,
    observer: RateLimitObserver | undefined,
    metadata: CooldownMetadata
  ): void {
    const now = this.now();
    if (directiveMs > MAX_RATE_LIMIT_WAIT_MS) {
      bucket.excessiveDirectiveUntil = Math.max(
        bucket.excessiveDirectiveUntil ?? 0,
        now + directiveMs
      );
      safeEmitRateLimitObserver(
        observer,
        this.waitEvent('cooldown', bucket, directiveMs, metadata)
      );
      return;
    }

    const waitMs = directiveMs + Math.min(this.jitterMs(), MAX_RATE_LIMIT_WAIT_MS - directiveMs);
    const deadline = now + waitMs;
    if (deadline > bucket.cooldownUntil) {
      bucket.cooldownUntil = deadline;
      bucket.cooldownMetadata = metadata;
    }
    safeEmitRateLimitObserver(observer, this.waitEvent('cooldown', bucket, waitMs, metadata));
  }

  emitWait(
    bucket: RateLimitBucketState,
    observer: RateLimitObserver | undefined,
    waitMs: number
  ): void {
    safeEmitRateLimitObserver(
      observer,
      this.waitEvent('wait', bucket, waitMs, bucket.cooldownMetadata ?? {})
    );
  }

  private waitEvent(
    type: 'wait' | 'cooldown',
    bucket: RateLimitBucketState,
    waitMs: number,
    metadata: CooldownMetadata
  ): RateLimitObserverEvent {
    return {
      type,
      apiVersion: bucket.apiVersion,
      waitMs,
      waitUntil: Math.ceil((this.wallNow() + waitMs) / 1000),
      ...metadata,
      ...(bucket.apiVersion === 'v3' && bucket.v3Quota
        ? { limit: bucket.v3Quota.limit, remaining: bucket.v3Quota.remaining }
        : {}),
    };
  }

  private jitterMs(): number {
    const normalized = Math.min(1, Math.max(0, this.random()));
    return MIN_JITTER_MS + Math.floor(normalized * (MAX_JITTER_MS - MIN_JITTER_MS));
  }
}

export function safeEmitRateLimitObserver(
  observer: RateLimitObserver | undefined,
  event: RateLimitObserverEvent
): void {
  try {
    observer?.(event);
  } catch {
    // Observability must never alter request behavior.
  }
}
