import type { GenericAbortSignal } from 'axios';
import { RateLimitAbortError } from './salesbinder-rate-limit-types.js';

export function abortableRateLimitSleep(
  delayMs: number,
  signal?: GenericAbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RateLimitAbortError());
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      signal?.removeEventListener?.('abort', onAbort);
    }
    function onAbort(): void {
      clearTimeout(timer);
      cleanup();
      reject(new RateLimitAbortError());
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}
