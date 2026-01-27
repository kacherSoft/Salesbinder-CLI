/**
 * Axios HTTP client factory for SalesBinder API
 * Creates configured axios instance with auth, retry, and request tracking
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { basicAuthInterceptor, basicAuthInterceptorOptions } from '../auth/basic-auth.interceptor.js';
import { retryHandler, type RetryConfig } from './retry.handler.js';
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
      try {
        return await retryHandler(error);
      } catch {
        return Promise.reject(error);
      }
    }
  );

  return client;
}
