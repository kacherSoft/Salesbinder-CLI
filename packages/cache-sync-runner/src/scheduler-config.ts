export const DEFAULT_SYNC_INTERVAL_SECONDS = 900;
export const DEFAULT_FULL_SYNC_INTERVAL_SECONDS = 604_800;

const REQUIRED_ENV_NAME = ['SALESBINDER', 'API', 'KEY'].join('_');
const REQUIRED_NAMES = [
  'SALESBINDER_ACCOUNT_NAME',
  'SALESBINDER_SUBDOMAIN',
  REQUIRED_ENV_NAME,
  'SALESBINDER_V3_API_KEY',
  'SALESBINDER_DB_URL',
  'SALESBINDER_CHANGE_FEED_DB_URL',
] as const;

export type SchedulerConfig =
  | { disabled: true }
  | {
      disabled: false;
      accountName: string;
      subdomain: string;
      apiKey: string;
      v3ApiKey: string;
      cacheDatabaseUrl: string;
      changeFeedDatabaseUrl: string;
      homeDirectory: string;
      syncIntervalSeconds: number;
      fullSyncIntervalSeconds: number;
    };

function boundedSeconds(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

interface PostgresTarget {
  url: string;
  hostname: string;
  port: string;
  database: string;
}

function requirePostgresUrl(raw: string, name: string): PostgresTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  let databaseName = '';
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    // The common error below deliberately excludes the configured value.
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.username ||
    !parsed.password ||
    !parsed.hostname ||
    !databaseName.trim() ||
    databaseName.includes('/')
  ) {
    throw new Error(`${name} must include PostgreSQL credentials, host, and database.`);
  }
  return {
    url: raw.trim(),
    hostname: parsed.hostname.toLowerCase().replace(/\.$/, ''),
    port: parsed.port || '5432',
    database: databaseName,
  };
}

function isSameTarget(left: PostgresTarget, right: PostgresTarget): boolean {
  return (
    left.hostname === right.hostname && left.port === right.port && left.database === right.database
  );
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required scheduler environment variable: ${name}`);
  return value;
}

export function validateSchedulerEnvironment(env: NodeJS.ProcessEnv): SchedulerConfig {
  if (env.SALESBINDER_SCHEDULER_DISABLED !== 'false') return { disabled: true };
  const missing: string[] = REQUIRED_NAMES.filter((name) => !env[name]?.trim());
  if (!env.HOME?.trim()) missing.push('HOME');
  if (missing.length > 0) {
    throw new Error(`Missing required scheduler environment variables: ${missing.join(', ')}`);
  }
  if (env.SALESBINDER_READ_BACKEND?.trim() !== 'postgresql') {
    throw new Error('SALESBINDER_READ_BACKEND must be postgresql.');
  }
  const cacheDatabase = requirePostgresUrl(
    requiredValue(env, 'SALESBINDER_DB_URL'),
    'SALESBINDER_DB_URL'
  );
  const changeFeedDatabase = requirePostgresUrl(
    requiredValue(env, 'SALESBINDER_CHANGE_FEED_DB_URL'),
    'SALESBINDER_CHANGE_FEED_DB_URL'
  );
  if (isSameTarget(cacheDatabase, changeFeedDatabase)) {
    throw new Error(
      'SALESBINDER_DB_URL and SALESBINDER_CHANGE_FEED_DB_URL must target distinct databases.'
    );
  }
  return {
    disabled: false,
    accountName: requiredValue(env, 'SALESBINDER_ACCOUNT_NAME'),
    subdomain: requiredValue(env, 'SALESBINDER_SUBDOMAIN'),
    apiKey: requiredValue(env, 'SALESBINDER_API_KEY'),
    v3ApiKey: requiredValue(env, 'SALESBINDER_V3_API_KEY'),
    cacheDatabaseUrl: cacheDatabase.url,
    changeFeedDatabaseUrl: changeFeedDatabase.url,
    homeDirectory: requiredValue(env, 'HOME'),
    syncIntervalSeconds: boundedSeconds(
      env,
      'SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS',
      DEFAULT_SYNC_INTERVAL_SECONDS,
      60,
      86_400
    ),
    fullSyncIntervalSeconds: boundedSeconds(
      env,
      'SALESBINDER_CACHE_FULL_INTERVAL_SECONDS',
      DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
      86_400,
      31_536_000
    ),
  };
}
