/**
 * Configuration schema for SalesBinder CLI
 */

/** Single account configuration */
export interface AccountConfig {
  /** SalesBinder subdomain (e.g., "acme" from acme.salesbinder.com) */
  subdomain: string;
  /** API key from SalesBinder profile */
  apiKey: string;
  /** API version (default: "2.0") */
  apiVersion: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/** User preferences */
export interface Preferences {
  /** Default records per page (1-100 for items, 1-200 for others) */
  defaultLimit?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Cache stale threshold in seconds (default: 3600 = 1 hour) */
  cacheStaleSeconds?: number;
}

/** Complete configuration file structure */
export interface SalesBinderConfig {
  /** Default account name to use */
  defaultAccount: string;
  /** Map of account name to configuration */
  accounts: Record<string, AccountConfig>;
  /** Optional user preferences */
  preferences?: Preferences;
}

/** Config file location */
export const CONFIG_PATH = `${process.env.HOME}/.salesbinder/config.json`;

/** State file for sync timestamps */
export interface SyncState {
  lastSync: {
    items?: number;
    customers?: number;
    documents?: number;
  };
}

/** State file location */
export const STATE_PATH = `${process.env.HOME}/.salesbinder/state.json`;
