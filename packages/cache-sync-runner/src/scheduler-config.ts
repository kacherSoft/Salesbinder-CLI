export const DEFAULT_SYNC_INTERVAL_SECONDS = 300;
export const DEFAULT_REFERENCE_SYNC_INTERVAL_SECONDS = 86_400;
export const MIN_SYNC_INTERVAL_SECONDS = 60;
export const MAX_SYNC_INTERVAL_SECONDS = 604_800;

export type SchedulerConfig =
  | { disabled: true }
  | {
      disabled: false;
      accountName: string;
      subdomain: string;
      v3ApiKey: string;
      apiKey?: string;
      cacheDatabaseUrl: string;
      homeDirectory: string;
      syncIntervalSeconds: number;
      initialSince?: string;
      referenceSyncIntervalSeconds: number | null;
    };

function boundedSeconds(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  allowDisabled = false
): number | null {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (allowDisabled && (raw === '0' || raw === 'disabled')) return null;
  const preset = raw === 'daily' ? 86_400 : raw === 'weekly' ? 604_800 : undefined;
  if (preset !== undefined) return preset;
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(`${name} must be a positive integer or supported preset.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function requirePostgresUrl(raw: string, name: string): string {
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
  return raw.trim();
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required scheduler environment variable: ${name}`);
  return value;
}

export function validateSchedulerEnvironment(env: NodeJS.ProcessEnv): SchedulerConfig {
  if (env.SALESBINDER_SCHEDULER_DISABLED !== 'false') return { disabled: true };
  const required = [
    'SALESBINDER_ACCOUNT_NAME',
    'SALESBINDER_SUBDOMAIN',
    'SALESBINDER_V3_API_KEY',
    'SALESBINDER_DB_URL',
    'HOME',
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required scheduler environment variables: ${missing.join(', ')}`);
  }
  const initialSince = env.SALESBINDER_V3_SYNC_INITIAL_SINCE?.trim();
  const syncIntervalSeconds = boundedSeconds(
    env,
    'SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS',
    DEFAULT_SYNC_INTERVAL_SECONDS,
    MIN_SYNC_INTERVAL_SECONDS,
    MAX_SYNC_INTERVAL_SECONDS
  );
  if (syncIntervalSeconds === null) {
    throw new Error('SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS cannot be disabled.');
  }
  return {
    disabled: false,
    accountName: requiredValue(env, 'SALESBINDER_ACCOUNT_NAME'),
    subdomain: requiredValue(env, 'SALESBINDER_SUBDOMAIN'),
    v3ApiKey: requiredValue(env, 'SALESBINDER_V3_API_KEY'),
    ...(env.SALESBINDER_API_KEY?.trim() ? { apiKey: env.SALESBINDER_API_KEY.trim() } : {}),
    cacheDatabaseUrl: requirePostgresUrl(
      requiredValue(env, 'SALESBINDER_DB_URL'),
      'SALESBINDER_DB_URL'
    ),
    homeDirectory: requiredValue(env, 'HOME'),
    syncIntervalSeconds,
    ...(initialSince ? { initialSince } : {}),
    referenceSyncIntervalSeconds: boundedSeconds(
      env,
      'SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS',
      DEFAULT_REFERENCE_SYNC_INTERVAL_SECONDS,
      MIN_SYNC_INTERVAL_SECONDS,
      MAX_SYNC_INTERVAL_SECONDS,
      true
    ),
  };
}
