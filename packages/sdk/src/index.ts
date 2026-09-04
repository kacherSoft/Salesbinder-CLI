/**
 * SalesBinder SDK - Main entry point
 */

export { SalesBinderClient, SalesBinderV3Client } from './resources/index.js';

// Re-export types for convenience
export * from './types/common.types.js';
export * from './types/items.types.js';
export * from './types/customers.types.js';
export * from './types/documents.types.js';
export * from './types/locations.types.js';
export * from './types/categories.types.js';
export * from './types/deleted-log.types.js';
export * from './config/config.schema.js';

// Export config loader
export { loadConfig, loadPreferences, listAccounts } from './config/config.loader.js';

// Export redacted transport observability and injectable limiter support.
export { SalesBinderRateLimiter } from './client/salesbinder-rate-limiter.js';
export type {
  ClientRuntimeOptions,
  RateLimitApiVersion,
  RateLimitObserver,
  RateLimitObserverEvent,
  RateLimitObserverEventType,
  RateLimitReason,
  SalesBinderRateLimiterOptions,
} from './client/salesbinder-rate-limiter.js';

// Export cache types and services
export * from './cache/index.js';

// Export the strict PostgreSQL inventory change-feed consumer contract.
export * from './change-feed/index.js';
