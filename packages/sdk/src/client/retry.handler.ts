/**
 * Retry handler for rate limiting (429) and transient errors
 * Implements exponential backoff with jitter
 */

import type { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

/** Maximum retry attempts */
const MAX_RETRIES = 5;

/** Initial retry delay in ms */
const INITIAL_DELAY = 1000;

/** Jitter percentage (0-50% random addition) */
const JITTER_PERCENT = 0.5;

/** Status codes that trigger retry */
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Calculate delay with exponential backoff and jitter
 * @param attempt - Retry attempt number (0-based)
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = INITIAL_DELAY * Math.pow(2, attempt);
  const jitter = exponentialDelay * JITTER_PERCENT * Math.random();
  return exponentialDelay + jitter;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: AxiosError): boolean {
  if (!error.response) {
    // Network errors are retryable
    return true;
  }

  const status = error.response.status;
  return RETRYABLE_STATUS_CODES.includes(status);
}

/**
 * Retry configuration for axios
 */
export interface RetryConfig {
  /** Current retry attempt */
  attempt: number;
  /** Request ID for logging */
  requestId: string;
}

/**
 * Extended Axios config with retry metadata
 */
export interface AxiosConfigWithRetry extends AxiosRequestConfig {
  _retry?: RetryConfig;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry handler for axios interceptor
 * @param error - Axios error
 * @returns Retry the request or throw error
 */
export async function retryHandler(error: AxiosError): Promise<AxiosRequestConfig> {
  const config = error.config as AxiosConfigWithRetry;

  if (!config || !config._retry) {
    return Promise.reject(error);
  }

  // Check if we should retry
  if (!isRetryableError(error) || config._retry.attempt >= MAX_RETRIES) {
    return Promise.reject(error);
  }

  const { attempt, requestId } = config._retry;

  // Calculate delay
  const delay = calculateRetryDelay(attempt);

  // Log retry (would use proper logger in production)
  const reason = error.response?.status || 'network';
  console.warn(
    `[${requestId}] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay.toFixed(0)}ms ` +
      `(reason: ${reason})`
  );

  // Wait before retry
  await sleep(delay);

  // Increment attempt counter
  config._retry.attempt++;

  // Return config to retry
  return config as InternalAxiosRequestConfig;
}
