import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  RateLimitApiVersion,
  RateLimitObserver,
  RateLimitReason,
} from './salesbinder-rate-limiter.js';
import {
  calculateRetryDelay,
  emitRetryEvent,
  logRetry,
  MAX_RETRIES,
  sleepForRetry,
} from './retry-runtime.js';

export interface RetryConfig {
  attempt: number;
  requestId: string;
  method: string;
  hasIdempotencyKey: boolean;
}

export interface AxiosConfigWithRetry extends AxiosRequestConfig {
  _retry?: RetryConfig;
  __isRetry?: boolean;
}

type InternalRetryConfig = InternalAxiosRequestConfig & AxiosConfigWithRetry;

export function installRetryMetadataInterceptor(
  client: AxiosInstance,
  generateRequestId: () => string
): void {
  client.interceptors.request.use((config) => {
    const retryConfig = config as InternalRetryConfig;
    if (retryConfig.__isRetry) {
      delete retryConfig.__isRetry;
      return config;
    }
    retryConfig._retry = {
      attempt: 0,
      requestId: generateRequestId(),
      method: normalizeMethod(config.method),
      hasIdempotencyKey: hasIdempotencyKey(config.headers),
    };
    return config;
  });
}

export function installRetryResponseInterceptor(
  client: AxiosInstance,
  apiVersion: RateLimitApiVersion,
  observer?: RateLimitObserver
): void {
  client.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const axiosError = error as AxiosError;
      const config = axiosError.config as InternalRetryConfig | undefined;
      if (!config?._retry || !shouldRetry(axiosError, config._retry, apiVersion)) {
        return Promise.reject(error);
      }

      const retry = config._retry;
      const status = axiosError.response?.status;
      const delay = nextRetryDelayMs(status, retry.attempt);
      const reason = retryReason(status);

      emitRetryEvent(observer, apiVersion, retry.attempt, delay, reason);
      if (!observer) logRetry(retry.requestId, retry.attempt, status, delay, status === 429);
      if (delay > 0) await sleepForRetry(delay, config.signal);

      retry.attempt++;
      config.__isRetry = true;
      return client.request(config);
    }
  );
}

export function isRetryableError(error: AxiosError): boolean {
  if (isCancellation(error)) return false;
  return !error.response || error.response.status === 429 || isServerError(error.response.status);
}

/** Legacy helper kept compatible for any direct internal imports. */
export async function retryHandler(error: AxiosError): Promise<AxiosRequestConfig> {
  const config = error.config as InternalRetryConfig | undefined;
  if (!config?._retry || config._retry.attempt >= MAX_RETRIES || !isRetryableError(error)) {
    return Promise.reject(error);
  }
  const delay = nextRetryDelayMs(error.response?.status, config._retry.attempt);
  if (delay > 0) await sleepForRetry(delay, config.signal);
  config._retry.attempt++;
  return config;
}

function shouldRetry(
  error: AxiosError,
  retry: RetryConfig,
  apiVersion: RateLimitApiVersion
): boolean {
  if (retry.attempt >= MAX_RETRIES || !isRetryableError(error)) return false;
  const status = error.response?.status;
  if (isSafeRetryMethod(retry.method)) return true;
  return apiVersion === 'v3' && canRetryV3Mutation(status, retry.hasIdempotencyKey);
}

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'get').trim().toLowerCase();
}

function nextRetryDelayMs(status: number | undefined, attempt: number): number {
  return status === 429 ? 0 : calculateRetryDelay(attempt);
}

function isSafeRetryMethod(method: string): boolean {
  return method === 'get' || method === 'head';
}

function canRetryV3Mutation(status: number | undefined, hasIdempotencyKey: boolean): boolean {
  if (status === 429) return true;
  return hasIdempotencyKey && (status === undefined || isServerError(status));
}

function hasIdempotencyKey(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, 'Idempotency-Key');
    return typeof value === 'string' && value.trim().length > 0;
  }
  return Object.entries(headers as Record<string, unknown>).some(
    ([name, value]) =>
      name.toLowerCase() === 'idempotency-key' &&
      typeof value === 'string' &&
      value.trim().length > 0
  );
}

function isCancellation(error: AxiosError): boolean {
  return (
    axios.isCancel(error) ||
    error.code === 'ERR_CANCELED' ||
    error.name === 'AbortError' ||
    error.name === 'RateLimitWaitExceededError'
  );
}

function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

function retryReason(status: number | undefined): RateLimitReason {
  if (status === 429) return 'rate_limit';
  return status === undefined ? 'network' : 'server_error';
}

export { calculateRetryDelay } from './retry-runtime.js';
