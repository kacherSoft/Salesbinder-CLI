import type { GenericAbortSignal } from 'axios';
import type {
  RateLimitApiVersion,
  RateLimitObserver,
  RateLimitReason,
} from './salesbinder-rate-limiter.js';

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
const JITTER_PERCENT = 0.5;
export const MAX_RETRIES = 5;

/** Backoff retained for compatibility and controlled by SALESBINDER_RETRY_INITIAL_DELAY_MS. */
export function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = getRetryInitialDelayMs() * Math.pow(2, attempt);
  return exponentialDelay + exponentialDelay * JITTER_PERCENT * Math.random();
}

export function emitRetryEvent(
  observer: RateLimitObserver | undefined,
  apiVersion: RateLimitApiVersion,
  attempt: number,
  waitMs: number,
  reason: RateLimitReason
): void {
  try {
    observer?.({
      type: 'retry',
      apiVersion,
      ...(waitMs > 0 ? { waitMs, waitUntil: Math.ceil((Date.now() + waitMs) / 1000) } : {}),
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES,
      reason,
    });
  } catch {
    // Observability must never alter request behavior.
  }
}

export function logRetry(
  requestId: string,
  attempt: number,
  status: number | undefined,
  waitMs: number,
  isRateLimit: boolean
): void {
  const timing = isRateLimit ? 'through rate-limit gate' : `after ${(waitMs / 1000).toFixed(1)}s`;
  console.warn(
    `[${requestId}] Retry ${attempt + 1}/${MAX_RETRIES} ${timing} ` +
      `(reason: ${status ?? 'network'})`
  );
}

export function sleepForRetry(delayMs: number, signal?: GenericAbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationError());
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      signal?.removeEventListener?.('abort', onAbort);
    }
    function onAbort(): void {
      clearTimeout(timer);
      cleanup();
      reject(cancellationError());
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

function getRetryInitialDelayMs(): number {
  const value = Number(process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_RETRY_INITIAL_DELAY_MS;
  return Math.min(value, MAX_RETRY_DELAY_MS);
}

function cancellationError(): Error {
  const error = new Error('SalesBinder retry was aborted');
  error.name = 'AbortError';
  return error;
}
