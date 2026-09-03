/** Axios factory for SalesBinder API v3 Bearer-authenticated resources. */

import axios, { type AxiosInstance } from 'axios';
import type { AccountConfig } from '../config/config.schema.js';
import { generateRequestId } from '../utils/request-id.generator.js';
import {
  createV3RateLimitBucketKey,
  getDefaultRateLimiterRegistry,
  installRateLimiterInterceptors,
  type ClientRuntimeOptions,
} from './salesbinder-rate-limiter.js';
import {
  installRetryMetadataInterceptor,
  installRetryResponseInterceptor,
} from './retry.handler.js';

/** Create a governed v3 client without changing the existing v2 Basic-auth transport. */
export function createV3AxiosClient(
  account: AccountConfig,
  runtimeOptions: ClientRuntimeOptions = {}
): AxiosInstance {
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

  const limiter = runtimeOptions.rateLimiterRegistry ?? getDefaultRateLimiterRegistry();
  const bucketKey = createV3RateLimitBucketKey(account.subdomain, account.v3ApiKey);

  installRateLimiterInterceptors(client, limiter, bucketKey, runtimeOptions.rateLimitObserver);
  installRetryMetadataInterceptor(client, generateRequestId);
  installRetryResponseInterceptor(client, 'v3', runtimeOptions.rateLimitObserver);

  return client;
}
