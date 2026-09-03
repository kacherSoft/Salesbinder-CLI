import type { GenericAbortSignal } from 'axios';

export type RateLimitApiVersion = 'v2' | 'v3';
export type RateLimitObserverEventType = 'wait' | 'cooldown' | 'headers' | 'retry';
export type RateLimitReason = 'network' | 'rate_limit' | 'server_error';

/** Deliberately allowlisted transport telemetry. It never includes request identity or content. */
export interface RateLimitObserverEvent {
  type: RateLimitObserverEventType;
  apiVersion: RateLimitApiVersion;
  waitMs?: number;
  /** Unix epoch seconds. */
  waitUntil?: number;
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: RateLimitReason;
}

export type RateLimitObserver = (event: RateLimitObserverEvent) => void;

/** Opaque in-memory key. Its credential fingerprint is held outside this object. */
export interface RateLimitBucketKey {
  readonly apiVersion: RateLimitApiVersion;
}

export interface SalesBinderRateLimiterOptions {
  now?: () => number;
  wallNow?: () => number;
  sleep?: (delayMs: number, signal?: GenericAbortSignal) => Promise<void>;
  random?: () => number;
  idleBucketTtlMs?: number;
}

export interface RateLimitResponseObservation {
  status?: number;
  headers?: unknown;
  receivedResponse: boolean;
}

export interface ParsedRateLimitHeaders {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface AdaptiveQuota extends ParsedRateLimitHeaders {
  resetAt: number;
}

export interface CooldownMetadata {
  retryAfterSeconds?: number;
  resetSeconds?: number;
}

export interface RateLimitBucketState {
  apiVersion: RateLimitApiVersion;
  timestamps: number[];
  queue: RateLimitQueueEntry[];
  draining: boolean;
  inFlight: number;
  lastUsed: number;
  cooldownUntil: number;
  cooldownMetadata?: CooldownMetadata;
  excessiveDirectiveUntil?: number;
  v3Initialized: boolean;
  v3BootstrapInFlight: boolean;
  v3Quota?: AdaptiveQuota;
  revision: number;
  listeners: Set<() => void>;
}

export interface RateLimitQueueEntry {
  signal?: GenericAbortSignal;
  observer?: RateLimitObserver;
  aborted: boolean;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
}

export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'change' }
  | { kind: 'wait'; waitMs: number }
  | { kind: 'cooldown'; directiveMs: number; metadata: CooldownMetadata }
  | { kind: 'error'; error: Error };

export class RateLimitAbortError extends Error {
  constructor() {
    super('SalesBinder request was aborted while waiting for rate-limit capacity');
    this.name = 'AbortError';
  }
}

export class RateLimitWaitExceededError extends Error {
  constructor(apiVersion: RateLimitApiVersion, waitMs: number) {
    super(
      `SalesBinder ${apiVersion} rate-limit directive requires ${Math.ceil(waitMs / 1000)}s, ` +
        'which exceeds the 15-minute safety ceiling'
    );
    this.name = 'RateLimitWaitExceededError';
  }
}
