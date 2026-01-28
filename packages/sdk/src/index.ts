/**
 * SalesBinder SDK - Main entry point
 */

export { SalesBinderClient } from './resources/index.js';

// Re-export types for convenience
export * from './types/common.types.js';
export * from './types/items.types.js';
export * from './types/customers.types.js';
export * from './types/documents.types.js';
export * from './types/locations.types.js';
export * from './types/categories.types.js';
export * from './config/config.schema.js';

// Export config loader
export { loadConfig, loadPreferences, listAccounts } from './config/config.loader.js';

// Export cache types and services
export * from './cache/index.js';
