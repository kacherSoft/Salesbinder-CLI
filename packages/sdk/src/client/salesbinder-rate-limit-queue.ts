import type { GenericAbortSignal } from 'axios';
import {
  RateLimitAbortError,
  type CooldownMetadata,
  type GateDecision,
  type RateLimitBucketState,
  type RateLimitObserver,
  type RateLimitQueueEntry,
} from './salesbinder-rate-limit-types.js';

export interface RateLimitQueueDependencies {
  now: () => number;
  sleep: (delayMs: number, signal?: GenericAbortSignal) => Promise<void>;
  decide: (bucket: RateLimitBucketState, now: number) => GateDecision;
  reserve: (bucket: RateLimitBucketState, now: number) => void;
  applyCooldown: (
    bucket: RateLimitBucketState,
    directiveMs: number,
    observer: RateLimitObserver | undefined,
    metadata: CooldownMetadata
  ) => void;
  emitWait: (
    bucket: RateLimitBucketState,
    observer: RateLimitObserver | undefined,
    waitMs: number
  ) => void;
}

export function enqueueRateLimitedRequest(
  bucket: RateLimitBucketState,
  dependencies: RateLimitQueueDependencies,
  signal?: GenericAbortSignal,
  observer?: RateLimitObserver
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RateLimitAbortError());
  bucket.lastUsed = dependencies.now();

  return new Promise<void>((resolve, reject) => {
    const entry: RateLimitQueueEntry = {
      signal,
      observer,
      aborted: false,
      settled: false,
      resolve,
      reject,
    };
    entry.abortListener = () => abortEntry(bucket, entry);
    signal?.addEventListener?.('abort', entry.abortListener, { once: true });
    bucket.queue.push(entry);
    void drainBucket(bucket, dependencies);
  });
}

export function notifyRateLimitBucket(bucket: RateLimitBucketState): void {
  bucket.revision++;
  for (const listener of [...bucket.listeners]) listener();
}

async function drainBucket(
  bucket: RateLimitBucketState,
  dependencies: RateLimitQueueDependencies
): Promise<void> {
  if (bucket.draining) return;
  bucket.draining = true;
  try {
    while (bucket.queue.length > 0) {
      const entry = bucket.queue[0];
      if (entry.aborted || entry.signal?.aborted) {
        removeHead(bucket, entry, new RateLimitAbortError());
        continue;
      }

      const decision = dependencies.decide(bucket, dependencies.now());
      if (decision.kind === 'error') {
        removeHead(bucket, entry, decision.error);
        continue;
      }
      if (decision.kind === 'cooldown') {
        dependencies.applyCooldown(bucket, decision.directiveMs, entry.observer, decision.metadata);
        continue;
      }
      if (decision.kind === 'change') {
        try {
          await waitForChange(bucket, entry.signal);
        } catch {
          removeHead(bucket, entry, new RateLimitAbortError());
        }
        continue;
      }
      if (decision.kind === 'wait') {
        dependencies.emitWait(bucket, entry.observer, decision.waitMs);
        try {
          await dependencies.sleep(decision.waitMs, entry.signal);
        } catch {
          removeHead(bucket, entry, new RateLimitAbortError());
        }
        continue;
      }

      dependencies.reserve(bucket, dependencies.now());
      bucket.queue.shift();
      settle(entry, 'resolve');
    }
  } finally {
    bucket.draining = false;
    if (bucket.queue.length > 0) void drainBucket(bucket, dependencies);
  }
}

function abortEntry(bucket: RateLimitBucketState, entry: RateLimitQueueEntry): void {
  if (entry.settled) return;
  entry.aborted = true;
  const index = bucket.queue.indexOf(entry);
  if (index > 0) {
    bucket.queue.splice(index, 1);
    settle(entry, 'reject', new RateLimitAbortError());
  }
  notifyRateLimitBucket(bucket);
}

function removeHead(bucket: RateLimitBucketState, entry: RateLimitQueueEntry, error: Error): void {
  if (bucket.queue[0] === entry) bucket.queue.shift();
  settle(entry, 'reject', error);
}

function settle(entry: RateLimitQueueEntry, action: 'resolve' | 'reject', error?: Error): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.abortListener) entry.signal?.removeEventListener?.('abort', entry.abortListener);
  if (action === 'resolve') entry.resolve();
  else entry.reject(error ?? new RateLimitAbortError());
}

function waitForChange(bucket: RateLimitBucketState, signal?: GenericAbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RateLimitAbortError());
  const revision = bucket.revision;
  return new Promise<void>((resolve, reject) => {
    const onChange = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new RateLimitAbortError());
    };
    const cleanup = () => {
      bucket.listeners.delete(onChange);
      signal?.removeEventListener?.('abort', onAbort);
    };
    bucket.listeners.add(onChange);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (bucket.revision !== revision) onChange();
  });
}
