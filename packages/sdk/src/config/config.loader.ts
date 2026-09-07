/**
 * Configuration loader with security validation
 */

import fs from 'node:fs';
import type { SalesBinderConfig, AccountConfig, V3AccountConfig } from './config.schema.js';
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
    throw new Error(`Configuration file not found at ${CONFIG_PATH}\nRun: salesbinder config init`);
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
  if (
    account.v3ApiKey !== undefined &&
    (typeof account.v3ApiKey !== 'string' ||
      !account.v3ApiKey.trim() ||
      account.v3ApiKey.includes('\0'))
  ) {
    throw new Error(`Account "${targetAccount}" has an invalid v3ApiKey`);
  }

  return account;
}

/** Load account identity for V3-only commands without requiring a V2 API key. */
export function loadV3Config(accountName?: string): V3AccountConfig {
  const account = readAccount(accountName);
  validateV3Account(account, accountName);
  return Object.fromEntries(
    Object.entries(account).filter(([key]) => key !== 'apiKey')
  ) as V3AccountConfig;
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

function readAccount(accountName?: string): AccountConfig {
  if (!fs.existsSync(CONFIG_PATH))
    throw new Error(`Configuration file not found at ${CONFIG_PATH}`);
  const stats = fs.statSync(CONFIG_PATH);
  if ((stats.mode & PERM_MASK) !== REQUIRED_PERMS)
    throw new Error('Insecure config file permissions.');
  let raw: SalesBinderConfig;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as SalesBinderConfig;
  } catch (error) {
    throw new Error(`Failed to parse config file: ${(error as Error).message}`);
  }
  if (!raw.accounts || Object.keys(raw.accounts).length === 0)
    throw new Error('No accounts configured in config file');
  const target = accountName || raw.defaultAccount || Object.keys(raw.accounts)[0];
  const account = raw.accounts[target];
  if (!account) throw new Error(`Account "${target}" not found.`);
  return account;
}

function validateV3Account(account: AccountConfig, accountName?: string): void {
  const name = accountName || 'account';
  if (!account.subdomain) throw new Error(`Account "${name}" missing subdomain`);
  if (
    account.v3ApiKey !== undefined &&
    (typeof account.v3ApiKey !== 'string' ||
      !account.v3ApiKey.trim() ||
      account.v3ApiKey.includes('\0'))
  ) {
    throw new Error(`Account "${name}" has an invalid v3ApiKey`);
  }
}
