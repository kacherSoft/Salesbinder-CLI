/** Axios factory for SalesBinder API v3 Bearer-authenticated resources. */

import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { AccountConfig } from '../config/config.schema.js';
import { generateRequestId } from '../utils/request-id.generator.js';
import type { RetryConfig } from './retry.handler.js';

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504, 522];

function getRetryInitialDelayMs(): number {
  const configuredDelay = Number(process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS);
  if (!Number.isSafeInteger(configuredDelay) || configuredDelay <= 0) {
    return DEFAULT_RETRY_INITIAL_DELAY_MS;
  }
  return Math.min(configuredDelay, MAX_RETRY_DELAY_MS);
}

function getRetryAfterDelayMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;

  const retryAfter = String(value).trim();
  if (/^[+-]?\d+$/.test(retryAfter)) {
    const delayMs = Number(retryAfter) * 1000;
    return delayMs > 0 ? Math.min(delayMs, MAX_RETRY_DELAY_MS) : undefined;
  }

  const delayMs = Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(delayMs) || delayMs <= 0) return undefined;
  return Math.min(delayMs, MAX_RETRY_DELAY_MS);
}

/** Create a v3 client without changing the existing v2 Basic-auth transport. */
export function createV3AxiosClient(account: AccountConfig): AxiosInstance {
  if (!account.v3ApiKey) {
    throw new Error('SalesBinder API v3 key is not configured for this account');
  }

  const client = axios.create({
    baseURL: `https://${account.subdomain}.salesbinder.com/api/v3`,
    timeout: account.timeout || 30000,
    headers: {
      Authorization: `Bearer ${account.v3ApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'salesbinder-cli/0.1.0',
    },
  });

  client.interceptors.request.use((config) => {
    if ((config as InternalAxiosRequestConfig & { __isRetry?: boolean }).__isRetry) {
      delete (config as InternalAxiosRequestConfig & { __isRetry?: boolean }).__isRetry;
      return config;
    }
    (config as InternalAxiosRequestConfig & { _retry?: RetryConfig })._retry = {
      attempt: 0,
      requestId: generateRequestId(),
    };
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const errorObj = error as AxiosError<unknown>;
      const config = errorObj.config as
        | (InternalAxiosRequestConfig & { _retry?: RetryConfig })
        | undefined;
      if (!config?._retry) return Promise.reject(error);

      const isRetryable =
        !errorObj.response || RETRYABLE_STATUSES.includes(errorObj.response?.status);
      if (!isRetryable || config._retry.attempt >= 5) return Promise.reject(error);

      const { attempt, requestId } = config._retry;
      const retryAfterDelay = getRetryAfterDelayMs(errorObj.response?.headers?.['retry-after']);
      const exponentialDelay = getRetryInitialDelayMs() * Math.pow(2, attempt);
      const delay = retryAfterDelay ?? exponentialDelay + exponentialDelay * 0.5 * Math.random();
      const reason = errorObj.response?.status || 'network';

      console.warn(
        `[${requestId}] Retry ${attempt + 1}/5 after ${(delay / 1000).toFixed(1)}s (reason: ${reason})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      config._retry.attempt++;
      (config as InternalAxiosRequestConfig & { __isRetry?: boolean }).__isRetry = true;
      return client.request(config);
    }
  );

  return client;
}
