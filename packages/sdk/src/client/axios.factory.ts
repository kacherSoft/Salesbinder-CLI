/**
 * Axios HTTP client factory for SalesBinder API
 * Creates configured axios instance with auth, retry, and request tracking
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { basicAuthInterceptor, basicAuthInterceptorOptions } from '../auth/basic-auth.interceptor.js';
import type { RetryConfig } from './retry.handler.js';
import { generateRequestId } from '../utils/request-id.generator.js';
import type { AccountConfig } from '../config/config.schema.js';

/**
 * Create configured axios instance for SalesBinder API
 * @param account - Account configuration
 * @returns Axios instance
 */
export function createAxiosClient(account: AccountConfig): AxiosInstance {
  const client = axios.create({
    baseURL: `https://${account.subdomain}.salesbinder.com/api/${account.apiVersion}`,
    timeout: account.timeout || 30000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'salesbinder-cli/0.1.0',
    },
  });

  // Add Basic Auth interceptor
  client.interceptors.request.use(
    (config) => basicAuthInterceptor(config, account.apiKey),
    undefined,
    basicAuthInterceptorOptions
  );

  // Add request ID to each request
  client.interceptors.request.use((config) => {
    // Don't reset retry state if this is a retry
    if ((config as any).__isRetry) {
      delete (config as any).__isRetry;
      return config;
    }
    const requestId = generateRequestId();
    (config as InternalAxiosRequestConfig & { _retry?: RetryConfig })._retry = {
      attempt: 0,
      requestId,
    };
    return config;
  });

  // Add retry interceptor for response errors
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config as InternalAxiosRequestConfig & { _retry?: RetryConfig };
      if (!config || !config._retry) {
        return Promise.reject(error);
      }

      // Check if we should retry
      const errorObj = error as any;
      const retryableStatus = [429, 500, 502, 503, 504];
      const isRetryable = !errorObj.response || retryableStatus.includes(errorObj.response?.status);

      if (!isRetryable || config._retry.attempt >= 5) {
        return Promise.reject(error);
      }

      const { attempt, requestId } = config._retry;

      // Check for retry-after header first (for 429 responses)
      let delay: number;
      const retryAfterHeader = errorObj.response?.headers?.['retry-after'];
      const reason = errorObj.response?.status || 'network';

      if (retryAfterHeader) {
        // Use retry-after header value (in seconds)
        const retryAfterSeconds = parseInt(retryAfterHeader, 10);
        delay = (isNaN(retryAfterSeconds) ? 5 : retryAfterSeconds) * 1000;
      } else {
        // Calculate delay with exponential backoff
        const INITIAL_DELAY = 1000;
        const JITTER_PERCENT = 0.5;
        const exponentialDelay = INITIAL_DELAY * Math.pow(2, attempt);
        const jitter = exponentialDelay * JITTER_PERCENT * Math.random();
        delay = exponentialDelay + jitter;
      }

      // Log retry
      console.warn(`[${requestId}] Retry ${attempt + 1}/5 after ${(delay / 1000).toFixed(1)}s (reason: ${reason})`);

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay));

      // Increment attempt counter BEFORE retry
      config._retry.attempt++;

      // Mark this config as already in retry to prevent the request interceptor from resetting
      (config as any).__isRetry = true;

      // Retry the request using the axios instance's request method
      // This properly executes the request instead of returning the config
      return (client as any).request(config);
    }
  );

  return client;
}
