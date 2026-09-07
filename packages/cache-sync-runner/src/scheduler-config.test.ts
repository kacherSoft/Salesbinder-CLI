import {
  DEFAULT_REFERENCE_SYNC_INTERVAL_SECONDS,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  validateSchedulerEnvironment,
} from './scheduler-config.js';

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: '/home',
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'account',
    SALESBINDER_SUBDOMAIN: 'subdomain',
    SALESBINDER_V3_API_KEY: 'v3',
    SALESBINDER_DB_URL: 'postgres://user:password@host/cache',
    SALESBINDER_READ_BACKEND: 'postgresql',
    ...extra,
  };
}

test('defaults disabled unless explicitly enabled', () => {
  expect(validateSchedulerEnvironment({})).toEqual({ disabled: true });
  expect(validateSchedulerEnvironment({ SALESBINDER_SCHEDULER_DISABLED: 'true' })).toEqual({
    disabled: true,
  });
});

test('requires only V3 account and cache configuration', () => {
  const minimal = environment();
  delete minimal.SALESBINDER_READ_BACKEND;
  const config = validateSchedulerEnvironment(minimal);
  expect(config.disabled).toBe(false);
  if (!config.disabled) {
    expect(config.apiKey).toBeUndefined();
    expect(config.cacheDatabaseUrl).toContain('/cache');
    expect(config).not.toHaveProperty('changeFeedDatabaseUrl');
  }
  expect(() => validateSchedulerEnvironment(environment({ SALESBINDER_V3_API_KEY: ' ' }))).toThrow(
    /V3_API_KEY/
  );
});

test('uses bounded intervals and accepts relative daily and weekly presets', () => {
  const defaults = validateSchedulerEnvironment(environment());
  if (defaults.disabled) throw new Error('Expected enabled configuration.');
  expect(defaults.syncIntervalSeconds).toBe(DEFAULT_SYNC_INTERVAL_SECONDS);
  expect(defaults.referenceSyncIntervalSeconds).toBe(DEFAULT_REFERENCE_SYNC_INTERVAL_SECONDS);
  expect(
    validateSchedulerEnvironment(environment({ SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: 'daily' }))
  ).toMatchObject({ syncIntervalSeconds: 86_400 });
  expect(
    validateSchedulerEnvironment(environment({ SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: 'weekly' }))
  ).toMatchObject({ syncIntervalSeconds: 604_800 });
  expect(
    validateSchedulerEnvironment(
      environment({ SALESBINDER_REFERENCE_SYNC_INTERVAL_SECONDS: 'disabled' })
    )
  ).toMatchObject({ referenceSyncIntervalSeconds: null });
  for (const value of ['0', '59', '604801', '1.5']) {
    expect(() =>
      validateSchedulerEnvironment(environment({ SALESBINDER_CACHE_SYNC_INTERVAL_SECONDS: value }))
    ).toThrow();
  }
});
