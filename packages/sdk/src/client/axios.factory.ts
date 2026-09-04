/** Axios HTTP client factory for the SalesBinder v2 API. */

import axios, { type AxiosInstance } from 'axios';
import {
  basicAuthInterceptor,
  basicAuthInterceptorOptions,
} from '../auth/basic-auth.interceptor.js';
import type { AccountConfig } from '../config/config.schema.js';
import { generateRequestId } from '../utils/request-id.generator.js';
import {
  createV2RateLimitBucketKey,
  getDefaultRateLimiterRegistry,
  installRateLimiterInterceptors,
  type ClientRuntimeOptions,
} from './salesbinder-rate-limiter.js';
import {
  installRetryMetadataInterceptor,
  installRetryResponseInterceptor,
} from './retry.handler.js';

/** Create a configured, governed Axios instance for the SalesBinder v2 API. */
export function createAxiosClient(
  account: AccountConfig,
  runtimeOptions: ClientRuntimeOptions = {}
): AxiosInstance {
  const client = axios.create({
    baseURL: `https://${account.subdomain}.salesbinder.com/api/${account.apiVersion}`,
    timeout: account.timeout || 30000,
    signal: runtimeOptions.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'salesbinder-cli/0.1.0',
    },
  });

  const limiter = runtimeOptions.rateLimiterRegistry ?? getDefaultRateLimiterRegistry();
  const bucketKey = createV2RateLimitBucketKey(account.subdomain, account.apiVersion);

  // Axios request interceptors are LIFO and response interceptors FIFO. Installing the
  // limiter first makes metadata/auth run before its gate, while it observes 429 before retry.
  installRateLimiterInterceptors(client, limiter, bucketKey, runtimeOptions.rateLimitObserver);
  client.interceptors.request.use(
    (config) => basicAuthInterceptor(config, account.apiKey),
    undefined,
    basicAuthInterceptorOptions
  );
  installRetryMetadataInterceptor(client, generateRequestId);
  installRetryResponseInterceptor(client, 'v2', runtimeOptions.rateLimitObserver);

  return client;
}
