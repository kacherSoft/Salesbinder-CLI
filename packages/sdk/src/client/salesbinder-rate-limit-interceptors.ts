import type { AxiosInstance } from 'axios';
import type { SalesBinderRateLimiter } from './salesbinder-rate-limiter.js';
import type { RateLimitBucketKey, RateLimitObserver } from './salesbinder-rate-limit-types.js';

const RATE_LIMIT_RESERVATION = Symbol('salesbinder-rate-limit-reservation');

/** Install first: Axios request interceptors are LIFO and response interceptors are FIFO. */
export function installRateLimiterInterceptors(
  client: AxiosInstance,
  limiter: SalesBinderRateLimiter,
  key: RateLimitBucketKey,
  observer?: RateLimitObserver
): void {
  client.interceptors.request.use(async (config) => {
    await limiter.beforeRequest(key, config.signal, observer);
    (config as unknown as Record<symbol, boolean>)[RATE_LIMIT_RESERVATION] = true;
    return config;
  });
  client.interceptors.response.use(
    (response) => {
      if (consumeReservation(response.config)) {
        limiter.observeResponse(
          key,
          { status: response.status, headers: response.headers, receivedResponse: true },
          observer
        );
      }
      return response;
    },
    (error: unknown) => {
      const response = responseFromError(error);
      if (consumeReservation(configFromError(error))) {
        limiter.observeResponse(
          key,
          {
            status: response?.status,
            headers: response?.headers,
            receivedResponse: response !== undefined,
          },
          observer
        );
      }
      return Promise.reject(error);
    }
  );
}

function responseFromError(error: unknown): { status?: number; headers?: unknown } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  return response && typeof response === 'object'
    ? (response as { status?: number; headers?: unknown })
    : undefined;
}

function configFromError(error: unknown): object | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const config = (error as { config?: unknown }).config;
  return config && typeof config === 'object' ? config : undefined;
}

function consumeReservation(config: object | undefined): boolean {
  if (!config) return false;
  const record = config as Record<symbol, boolean>;
  if (!record[RATE_LIMIT_RESERVATION]) return false;
  delete record[RATE_LIMIT_RESERVATION];
  return true;
}
