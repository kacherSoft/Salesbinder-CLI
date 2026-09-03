import { createHmac, randomBytes } from 'node:crypto';
import type { RateLimitApiVersion, RateLimitBucketKey } from './salesbinder-rate-limit-types.js';

const PROCESS_SALT = randomBytes(32);
const bucketIdentities = new WeakMap<RateLimitBucketKey, string>();

export function createV2RateLimitBucketKey(
  subdomain: string,
  apiVersion: string
): RateLimitBucketKey {
  return createBucketKey(
    'v2',
    `v2:${normalizeSubdomain(subdomain)}:${apiVersion.trim().toLowerCase()}`
  );
}

export function createV3RateLimitBucketKey(subdomain: string, apiKey: string): RateLimitBucketKey {
  const fingerprint = createHmac('sha256', PROCESS_SALT).update(apiKey).digest('base64url');
  return createBucketKey('v3', `v3:${normalizeSubdomain(subdomain)}:${fingerprint}`);
}

export function getRateLimitBucketIdentity(key: RateLimitBucketKey): string {
  const identity = bucketIdentities.get(key);
  if (!identity) throw new Error('Invalid SalesBinder rate-limit bucket key');
  return identity;
}

function createBucketKey(apiVersion: RateLimitApiVersion, identity: string): RateLimitBucketKey {
  const key = Object.freeze({ apiVersion });
  bucketIdentities.set(key, identity);
  return key;
}

function normalizeSubdomain(subdomain: string): string {
  return subdomain.trim().toLowerCase();
}
