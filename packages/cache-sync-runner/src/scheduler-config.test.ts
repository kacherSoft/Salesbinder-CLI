import {
  DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  validateSchedulerEnvironment,
} from './scheduler-config.js';

function databaseUrl(protocol: 'postgres:' | 'postgresql:', database: string): string {
  return [protocol, '', 'worker:password@database-host', database].join('/');
}

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: '/configured-home',
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'configured-account',
    SALESBINDER_SUBDOMAIN: 'configured-subdomain',
    SALESBINDER_API_KEY: 'configured-v2-credential',
    SALESBINDER_V3_API_KEY: 'configured-v3-credential',
    SALESBINDER_DB_URL: databaseUrl('postgres:', 'cache'),
    SALESBINDER_CHANGE_FEED_DB_URL: databaseUrl('postgresql:', 'feed'),
    SALESBINDER_READ_BACKEND: 'postgresql',
  };
}

test('defaults to disabled and requires exact false activation', () => {
  expect(validateSchedulerEnvironment({})).toEqual({ disabled: true });
  expect(validateSchedulerEnvironment({ SALESBINDER_SCHEDULER_DISABLED: 'unexpected' })).toEqual({
    disabled: true,
  });
});

test('enabled mode requires every runtime value without logging values in errors', () => {
  expect(() => validateSchedulerEnvironment({ SALESBINDER_SCHEDULER_DISABLED: 'false' })).toThrow(
    /SALESBINDER_ACCOUNT_NAME/
  );
  const env = enabledEnvironment();
  env.SALESBINDER_API_KEY = 'private-marker';
  env.SALESBINDER_V3_API_KEY = ' ';
  try {
    validateSchedulerEnvironment(env);
    throw new Error('Expected validation to fail.');
  } catch (error) {
    expect(String(error)).toContain('SALESBINDER_V3_API_KEY');
    expect(String(error)).not.toContain('private-marker');
  }
});

test('requires PostgreSQL read mode and complete PostgreSQL URLs', () => {
  expect(() =>
    validateSchedulerEnvironment({ ...enabledEnvironment(), SALESBINDER_READ_BACKEND: 'sqlite' })
  ).toThrow(/must be postgresql/);
  const invalidValues = [
    'not-a-database-url',
    ['https:', '', 'worker:password@database-host', 'cache'].join('/'),
    ['postgres:', '', 'database-host', 'cache'].join('/'),
    ['postgres:', '', 'worker@database-host', 'cache'].join('/'),
    ['postgres:', '', 'worker:password@', 'cache'].join('/'),
    ['postgres:', '', 'worker:password@database-host'].join('/'),
  ];
  for (const value of invalidValues) {
    expect(() =>
      validateSchedulerEnvironment({ ...enabledEnvironment(), SALESBINDER_DB_URL: value })
    ).toThrow();
    try {
      validateSchedulerEnvironment({ ...enabledEnvironment(), SALESBINDER_DB_URL: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  }
});

test('rejects cache and change-feed URLs that resolve to the same database target', () => {
  const environment = enabledEnvironment();
  environment.SALESBINDER_DB_URL = databaseUrl('postgres:', 'shared%5Fdatabase');
  environment.SALESBINDER_CHANGE_FEED_DB_URL = [
    'postgresql:',
    '',
    'different-user:different-password@DATABASE-HOST:5432',
    'shared_database?sslmode=require',
  ].join('/');
  expect(() => validateSchedulerEnvironment(environment)).toThrow(
    'SALESBINDER_DB_URL and SALESBINDER_CHANGE_FEED_DB_URL must target distinct databases.'
  );
});

test('uses defaults and enforces strict bounded numeric settings', () => {
  const config = validateSchedulerEnvironment(enabledEnvironment());
  if (config.disabled) throw new Error('Expected enabled configuration.');
  expect(config.syncIntervalSeconds).toBe(DEFAULT_SYNC_INTERVAL_SECONDS);
  expect(config.fullSyncIntervalSeconds).toBe(DEFAULT_FULL_SYNC_INTERVAL_SECONDS);
  for (const value of ['0', '-1', '1.5', ' 900', '900 ', '59', '86401']) {
    expect(() =>
      validateSchedulerEnvironment({
        ...enabledEnvironment(),
        SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: value,
      })
    ).toThrow();
  }
  for (const value of ['86399', '31536001']) {
    expect(() =>
      validateSchedulerEnvironment({
        ...enabledEnvironment(),
        SALESBINDER_CACHE_FULL_INTERVAL_SECONDS: value,
      })
    ).toThrow();
  }
  const boundary = validateSchedulerEnvironment({
    ...enabledEnvironment(),
    SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: '60',
    SALESBINDER_CACHE_FULL_INTERVAL_SECONDS: '86400',
  });
  expect(boundary.disabled).toBe(false);
  if (!boundary.disabled) {
    expect(boundary.syncIntervalSeconds).toBe(60);
    expect(boundary.fullSyncIntervalSeconds).toBe(86_400);
  }
});
