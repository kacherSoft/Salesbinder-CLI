import {
  RateLimitWaitExceededError,
  type ParsedRateLimitHeaders,
  type GateDecision,
  type RateLimitApiVersion,
  type RateLimitBucketState,
} from './salesbinder-rate-limit-types.js';

const V2_SHORT_LIMIT = 12;
const V2_SHORT_WINDOW_MS = 10_000;
const V2_LONG_LIMIT = 45;
const V2_LONG_WINDOW_MS = 60_000;
const V3_FALLBACK_LIMIT = 100;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;
export const V3_QUOTA_RESERVE = 1;

export function createRateLimitBucketState(
  apiVersion: RateLimitApiVersion,
  now: number
): RateLimitBucketState {
  return {
    apiVersion,
    timestamps: [],
    queue: [],
    draining: false,
    inFlight: 0,
    lastUsed: now,
    cooldownUntil: 0,
    v3Initialized: false,
    v3BootstrapInFlight: false,
    revision: 0,
    listeners: new Set(),
  };
}

export function decideRateLimitGate(bucket: RateLimitBucketState, now: number): GateDecision {
  bucket.lastUsed = now;
  if (bucket.excessiveDirectiveUntil !== undefined) {
    if (bucket.excessiveDirectiveUntil > now) {
      return {
        kind: 'error',
        error: new RateLimitWaitExceededError(
          bucket.apiVersion,
          bucket.excessiveDirectiveUntil - now
        ),
      };
    }
    bucket.excessiveDirectiveUntil = undefined;
  }
  if (bucket.cooldownUntil > now) {
    return { kind: 'wait', waitMs: bucket.cooldownUntil - now };
  }
  bucket.cooldownMetadata = undefined;

  return bucket.apiVersion === 'v2' ? decideV2(bucket, now) : decideV3(bucket, now);
}

export function reserveRateLimitCapacity(bucket: RateLimitBucketState, now: number): void {
  bucket.inFlight++;
  if (bucket.apiVersion !== 'v3') {
    bucket.timestamps.push(now);
    return;
  }

  if (!bucket.v3Initialized || !bucket.v3Quota) bucket.timestamps.push(now);
  if (!bucket.v3Initialized) bucket.v3BootstrapInFlight = true;
  else if (bucket.v3Quota) bucket.v3Quota.remaining = Math.max(0, bucket.v3Quota.remaining - 1);
}

/** Merge concurrent response headers without letting an older response restore spent capacity. */
export function updateAdaptiveQuota(
  bucket: RateLimitBucketState,
  parsed: ParsedRateLimitHeaders,
  now: number
): void {
  bucket.timestamps.length = 0;
  const parsedResetAt = now + parsed.resetSeconds * 1000;
  const current = bucket.v3Quota;
  if (!current || now >= current.resetAt) {
    bucket.v3Quota = {
      ...parsed,
      // The response has already left inFlight; reserve the remaining local dispatches.
      remaining: Math.max(0, parsed.remaining - bucket.inFlight),
      resetAt: parsedResetAt,
    };
    return;
  }

  const limit = Math.min(current.limit, parsed.limit);
  const resetAt = Math.max(current.resetAt, parsedResetAt);
  bucket.v3Quota = {
    limit,
    remaining: Math.min(current.remaining, parsed.remaining, limit),
    resetSeconds: Math.ceil((resetAt - now) / 1000),
    resetAt,
  };
}

function decideV2(bucket: RateLimitBucketState, now: number): GateDecision {
  pruneBefore(bucket.timestamps, now - V2_LONG_WINDOW_MS);
  let shortStart = bucket.timestamps.length;
  while (shortStart > 0 && bucket.timestamps[shortStart - 1] > now - V2_SHORT_WINDOW_MS) {
    shortStart--;
  }
  const shortCount = bucket.timestamps.length - shortStart;
  const waits: number[] = [];
  if (shortCount >= V2_SHORT_LIMIT) {
    waits.push(
      bucket.timestamps[shortStart + shortCount - V2_SHORT_LIMIT] + V2_SHORT_WINDOW_MS - now
    );
  }
  if (bucket.timestamps.length >= V2_LONG_LIMIT) {
    waits.push(
      bucket.timestamps[bucket.timestamps.length - V2_LONG_LIMIT] + V2_LONG_WINDOW_MS - now
    );
  }
  return waits.length === 0 ? { kind: 'allow' } : { kind: 'wait', waitMs: Math.max(...waits) };
}

function decideV3(bucket: RateLimitBucketState, now: number): GateDecision {
  if (!bucket.v3Initialized) {
    return bucket.v3BootstrapInFlight ? { kind: 'change' } : { kind: 'allow' };
  }

  if (bucket.v3Quota) {
    if (now >= bucket.v3Quota.resetAt) {
      // Outstanding local dispatches may not be reflected in the new server window yet.
      bucket.v3Quota.remaining = Math.max(0, bucket.v3Quota.limit - bucket.inFlight);
      bucket.v3Quota.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }
    if (bucket.v3Quota.remaining <= quotaReserve(bucket.v3Quota.limit)) {
      const directiveMs = Math.max(0, bucket.v3Quota.resetAt - now);
      return {
        kind: 'cooldown',
        directiveMs,
        metadata: { resetSeconds: Math.ceil(directiveMs / 1000) },
      };
    }
    return { kind: 'allow' };
  }

  pruneBefore(bucket.timestamps, now - RATE_LIMIT_WINDOW_MS);
  if (bucket.timestamps.length < V3_FALLBACK_LIMIT) return { kind: 'allow' };
  return {
    kind: 'wait',
    waitMs:
      bucket.timestamps[bucket.timestamps.length - V3_FALLBACK_LIMIT] + RATE_LIMIT_WINDOW_MS - now,
  };
}

function pruneBefore(timestamps: number[], threshold: number): void {
  let firstValid = 0;
  while (firstValid < timestamps.length && timestamps[firstValid] <= threshold) firstValid++;
  if (firstValid > 0) timestamps.splice(0, firstValid);
}

export function quotaReserve(limit: number): number {
  return limit > V3_QUOTA_RESERVE ? V3_QUOTA_RESERVE : 0;
}
