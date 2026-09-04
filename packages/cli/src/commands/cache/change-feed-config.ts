import { SALESBINDER_CLI_INVENTORY_CONSUMER } from '@salesbinder/sdk';

export const CHANGE_FEED_DATABASE_URL_ENV = 'SALESBINDER_CHANGE_FEED_DB_URL' as const;

export type ChangeFeedConfigErrorCode =
  | 'invalid_database_url'
  | 'missing_database_credentials'
  | 'missing_database_host'
  | 'missing_database_name';

/** Configuration error safe for stderr/JSON output. It never retains the rejected URL. */
export class ChangeFeedConfigError extends Error {
  readonly sanitized = true as const;

  constructor(
    readonly code: ChangeFeedConfigErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ChangeFeedConfigError';
  }
}

export interface ChangeFeedConfig {
  readonly databaseUrl: string;
  readonly consumerName: typeof SALESBINDER_CLI_INVENTORY_CONSUMER;
}

/** Load the optional worker connection without reading unrelated process state. */
export function loadChangeFeedConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): ChangeFeedConfig | null {
  const databaseUrl = env[CHANGE_FEED_DATABASE_URL_ENV];
  if (databaseUrl === undefined || databaseUrl.trim() === '') return null;

  const parsed = parseDatabaseUrl(databaseUrl);
  assertCredentials(parsed);
  if (!parsed.hostname.trim()) {
    throw configError('missing_database_host', 'Change-feed database URL requires a host.');
  }
  if (!isUsableValue(decodedValue(parsed.pathname.replace(/^\/+/, '')))) {
    throw configError(
      'missing_database_name',
      'Change-feed database URL requires a database name.'
    );
  }

  return Object.freeze({
    databaseUrl,
    consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
  });
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw configError(
      'invalid_database_url',
      'Change-feed database URL must be a valid PostgreSQL URL.'
    );
  }
  if (
    databaseUrl !== databaseUrl.trim() ||
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
  ) {
    throw configError(
      'invalid_database_url',
      'Change-feed database URL must use the postgres or postgresql scheme.'
    );
  }
  return parsed;
}

function assertCredentials(parsed: URL): void {
  let username: string;
  let password: string;
  try {
    username = decodedValue(parsed.username);
    password = decodedValue(parsed.password);
  } catch {
    throw configError(
      'invalid_database_url',
      'Change-feed database URL contains invalid encoding.'
    );
  }
  if (!isUsableValue(username) || !isUsableValue(password)) {
    throw configError(
      'missing_database_credentials',
      'Change-feed database URL requires non-empty worker credentials.'
    );
  }
}

function isUsableValue(value: string): boolean {
  return value.trim().length > 0 && !value.includes('\0');
}

function decodedValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw configError(
      'invalid_database_url',
      'Change-feed database URL contains invalid encoding.'
    );
  }
}

function configError(code: ChangeFeedConfigErrorCode, message: string): ChangeFeedConfigError {
  return new ChangeFeedConfigError(code, message);
}
