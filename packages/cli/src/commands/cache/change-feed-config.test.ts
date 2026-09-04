import {
  CHANGE_FEED_DATABASE_URL_ENV,
  ChangeFeedConfigError,
  loadChangeFeedConfig,
} from './change-feed-config.js';

const SALESBINDER_CLI_INVENTORY_CONSUMER = 'salesbinder-cli-inventory-v1';

jest.mock(
  '@salesbinder/sdk',
  () => ({
    SALESBINDER_CLI_INVENTORY_CONSUMER: 'salesbinder-cli-inventory-v1',
  }),
  { virtual: true }
);

describe('loadChangeFeedConfig', () => {
  const secretUrl = 'postgres://worker:super-secret@ledger.example/salesbinder';

  it.each([
    ['absent', {}],
    ['blank', { [CHANGE_FEED_DATABASE_URL_ENV]: '   ' }],
  ])('returns null when the change-feed URL is %s', (_label, env) => {
    expect(loadChangeFeedConfig(env)).toBeNull();
  });

  it.each([
    'postgres://worker:secret@ledger.example/salesbinder',
    'postgresql://worker:secret@ledger.example:5432/salesbinder',
  ])('accepts %s URLs and returns the fixed inventory consumer', (databaseUrl) => {
    expect(loadChangeFeedConfig({ [CHANGE_FEED_DATABASE_URL_ENV]: databaseUrl })).toEqual({
      databaseUrl,
      consumerName: SALESBINDER_CLI_INVENTORY_CONSUMER,
    });
  });

  it.each([
    {
      label: 'malformed URL',
      databaseUrl: 'not a url',
      code: 'invalid_database_url',
      message: 'Change-feed database URL must be a valid PostgreSQL URL.',
    },
    {
      label: 'unsupported scheme',
      databaseUrl: 'mysql://worker:secret@ledger.example/salesbinder',
      code: 'invalid_database_url',
      message: 'Change-feed database URL must use the postgres or postgresql scheme.',
    },
    {
      label: 'surrounding whitespace',
      databaseUrl: ` ${secretUrl}`,
      code: 'invalid_database_url',
      message: 'Change-feed database URL must use the postgres or postgresql scheme.',
    },
    {
      label: 'missing username',
      databaseUrl: 'postgres://:secret@ledger.example/salesbinder',
      code: 'missing_database_credentials',
      message: 'Change-feed database URL requires non-empty worker credentials.',
      secrets: ['secret'],
    },
    {
      label: 'missing password',
      databaseUrl: 'postgres://worker@ledger.example/salesbinder',
      code: 'missing_database_credentials',
      message: 'Change-feed database URL requires non-empty worker credentials.',
      secrets: ['worker@ledger.example'],
    },
    {
      label: 'blank decoded password',
      databaseUrl: 'postgres://worker:%20@ledger.example/salesbinder',
      code: 'missing_database_credentials',
      message: 'Change-feed database URL requires non-empty worker credentials.',
      secrets: ['worker:%20'],
    },
    {
      label: 'missing database name',
      databaseUrl: 'postgres://worker:secret@ledger.example/',
      code: 'missing_database_name',
      message: 'Change-feed database URL requires a database name.',
    },
    {
      label: 'blank decoded database name',
      databaseUrl: 'postgres://worker:secret@ledger.example/%20',
      code: 'missing_database_name',
      message: 'Change-feed database URL requires a database name.',
    },
    {
      label: 'invalid credential encoding',
      databaseUrl: 'postgres://worker:%E0%A4%A@ledger.example/salesbinder',
      code: 'invalid_database_url',
      message: 'Change-feed database URL contains invalid encoding.',
    },
    {
      label: 'invalid database name encoding',
      databaseUrl: 'postgres://worker:secret@ledger.example/%E0%A4%A',
      code: 'invalid_database_url',
      message: 'Change-feed database URL contains invalid encoding.',
    },
  ])('rejects $label without retaining credentials', ({ databaseUrl, code, message, secrets }) => {
    expectConfigError(databaseUrl, code, message, secrets ?? ['worker', 'secret', 'super-secret']);
  });

  it('rejects a parsed URL with credentials but no host without retaining credentials', () => {
    const OriginalURL = globalThis.URL;
    class HostlessPostgresUrl {
      readonly protocol = 'postgres:';
      readonly username = 'worker';
      readonly password = 'super-secret';
      readonly hostname = '   ';
      readonly pathname = '/salesbinder';
    }

    try {
      globalThis.URL = HostlessPostgresUrl as unknown as typeof URL;
      expectConfigError(
        secretUrl,
        'missing_database_host',
        'Change-feed database URL requires a host.',
        ['worker', 'super-secret', 'ledger.example', 'salesbinder']
      );
    } finally {
      globalThis.URL = OriginalURL;
    }
  });
});

function expectConfigError(
  databaseUrl: string,
  code: string,
  message: string,
  sensitiveFragments: readonly string[]
): void {
  let thrown: unknown;
  try {
    loadChangeFeedConfig({ [CHANGE_FEED_DATABASE_URL_ENV]: databaseUrl });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ChangeFeedConfigError);
  const configError = thrown as ChangeFeedConfigError;
  expect(configError).toMatchObject({ code, message, sanitized: true });
  expect(configError.message).toBe(message);

  const rendered = `${String(configError)} ${JSON.stringify(configError)}`;
  expect(rendered).not.toContain(databaseUrl);
  for (const fragment of sensitiveFragments) {
    expect(rendered).not.toContain(fragment);
  }
}
