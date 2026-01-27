/**
 * HTTP Basic Authentication interceptor for SalesBinder API
 * Uses API key as username, "x" as password, Base64 encoded
 */

import type { AxiosInterceptorOptions, InternalAxiosRequestConfig } from 'axios';

/**
 * Create Basic Auth header value
 * @param apiKey - SalesBinder API key
 * @returns Base64 encoded "apiKey:x" string
 */
export function createBasicAuthHeader(apiKey: string): string {
  const credentials = `${apiKey}:x`;
  const encoded = Buffer.from(credentials).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Axios request interceptor options for Basic Auth
 */
export const basicAuthInterceptorOptions: AxiosInterceptorOptions = {
  synchronous: true, // Run before request is sent
};

/**
 * Axios request interceptor function
 * Adds Authorization header with Basic Auth
 * @param config - Axios request config
 * @returns Modified config with Authorization header
 */
export function basicAuthInterceptor(
  config: InternalAxiosRequestConfig,
  apiKey: string
): InternalAxiosRequestConfig {
  config.headers = config.headers || {};
  config.headers.Authorization = createBasicAuthHeader(apiKey);
  return config;
}
