/**
 * Configuration loader with security validation
 */

import fs from 'node:fs';
import type { SalesBinderConfig, AccountConfig } from './config.schema.js';
import { CONFIG_PATH } from './config.schema.js';

/** Config file permissions (0600 = owner read/write only) */
const REQUIRED_PERMS = 0o600;

/** File permission mask */
const PERM_MASK = 0o777;

/**
 * Load and validate configuration from file
 * @throws Error if config not found, invalid, or insecure
 */
export function loadConfig(accountName?: string): AccountConfig {
  // Check if config file exists
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Configuration file not found at ${CONFIG_PATH}\nRun: salesbinder config init`
    );
  }

  // Check file permissions
  const stats = fs.statSync(CONFIG_PATH);
  const perms = stats.mode & PERM_MASK;

  if (perms !== REQUIRED_PERMS) {
    throw new Error(
      `Insecure config file permissions: ${perms.toString(8)}\n` +
        `Required: ${REQUIRED_PERMS.toString(8)}\n` +
        `Fix: chmod 600 ${CONFIG_PATH}`
    );
  }

  // Read and parse config
  let rawConfig: SalesBinderConfig;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    rawConfig = JSON.parse(content) as SalesBinderConfig;
  } catch (error) {
    throw new Error(`Failed to parse config file: ${(error as Error).message}`);
  }

  // Validate structure
  if (!rawConfig.accounts || Object.keys(rawConfig.accounts).length === 0) {
    throw new Error('No accounts configured in config file');
  }

  // Determine which account to use
  const targetAccount =
    accountName || rawConfig.defaultAccount || Object.keys(rawConfig.accounts)[0];

  const account = rawConfig.accounts[targetAccount];
  if (!account) {
    const available = Object.keys(rawConfig.accounts).join(', ');
    throw new Error(`Account "${targetAccount}" not found. Available: ${available}`);
  }

  // Validate account fields
  if (!account.subdomain) {
    throw new Error(`Account "${targetAccount}" missing subdomain`);
  }
  if (!account.apiKey) {
    throw new Error(`Account "${targetAccount}" missing apiKey`);
  }

  return account;
}

/**
 * Get list of configured account names
 */
export function listAccounts(): string[] {
  if (!fs.existsSync(CONFIG_PATH)) {
    return [];
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as SalesBinderConfig;
    return Object.keys(config.accounts || {});
  } catch {
    return [];
  }
}

/**
 * Load preferences from config file
 */
export function loadPreferences(): SalesBinderConfig['preferences'] {
  if (!fs.existsSync(CONFIG_PATH)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as SalesBinderConfig;
    return config.preferences;
  } catch {
    return undefined;
  }
}
