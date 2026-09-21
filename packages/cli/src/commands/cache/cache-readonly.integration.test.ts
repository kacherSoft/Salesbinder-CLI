import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const testDbUrl = process.env.SALESBINDER_READONLY_CLI_TEST_DB_URL;
const describeIfPostgres = testDbUrl ? describe : describe.skip;
const accountName = 'default';
const accountSubdomain = 'readonly-cli-test';
const accountIdentity = `salesbinder:${accountSubdomain}`;
const itemId = '7fb6a3a8-d591-4761-98e5-b5275d20f5e4';
const customerId = '90b266c8-628f-48ce-a83c-21013cb740f6';
const docId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const lineId = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';
const testPath = ['/opt/homebrew/opt/postgresql@17/bin', process.env.PATH ?? ''].filter(Boolean).join(':');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describeIfPostgres('compiled CLI PostgreSQL read-only cache commands', () => {
  jest.setTimeout(60_000);

  let baseUrl = '';
  let tempHome = '';
  let missingSchema = '';
  let fixtureSchema = '';
  let readerRole = '';
  let latestAttemptAt = 0;
  let fixtureIssueDate = '';

  beforeAll(() => {
    baseUrl = guardedUrl();
    const suffix = `${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    missingSchema = `cli_readonly_missing_${suffix}`;
    fixtureSchema = `cli_readonly_fixture_${suffix}`;
    readerRole = `cli_readonly_reader_${suffix}`;
    tempHome = mkdtempSync(join(tmpdir(), 'salesbinder-cli-readonly-'));
    latestAttemptAt = Math.floor(Date.now() / 1000) - 60;
    fixtureIssueDate = new Date((latestAttemptAt - 30 * 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
    writeConfig(tempHome);

    psql(`
      CREATE SCHEMA ${quoteIdentifier(missingSchema)};
      CREATE SCHEMA ${quoteIdentifier(fixtureSchema)};
      CREATE ROLE ${quoteIdentifier(readerRole)} LOGIN;
      ALTER ROLE ${quoteIdentifier(readerRole)} SET default_transaction_read_only = on;
      GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName(baseUrl))} TO ${quoteIdentifier(readerRole)};
      GRANT USAGE ON SCHEMA ${quoteIdentifier(missingSchema)} TO ${quoteIdentifier(readerRole)};
      GRANT USAGE ON SCHEMA ${quoteIdentifier(fixtureSchema)} TO ${quoteIdentifier(readerRole)};
    `);
    seedFixture();
    psql(`
      GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdentifier(fixtureSchema)} TO ${quoteIdentifier(readerRole)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(fixtureSchema)}
        GRANT SELECT ON TABLES TO ${quoteIdentifier(readerRole)};
    `);
  });

  afterAll(() => {
    try {
      psql(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE usename = ${quoteLiteral(readerRole)} AND pid <> pg_backend_pid();
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(readerRole)}) THEN
            EXECUTE ${quoteLiteral(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(fixtureSchema)} REVOKE SELECT ON TABLES FROM ${quoteIdentifier(readerRole)}`)};
            EXECUTE ${quoteLiteral(`REVOKE USAGE ON SCHEMA ${quoteIdentifier(missingSchema)} FROM ${quoteIdentifier(readerRole)}`)};
            EXECUTE ${quoteLiteral(`REVOKE USAGE ON SCHEMA ${quoteIdentifier(fixtureSchema)} FROM ${quoteIdentifier(readerRole)}`)};
            EXECUTE ${quoteLiteral(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName(baseUrl))} FROM ${quoteIdentifier(readerRole)}`)};
          END IF;
        END
        $$;
        DROP SCHEMA IF EXISTS ${quoteIdentifier(missingSchema)} CASCADE;
        DROP SCHEMA IF EXISTS ${quoteIdentifier(fixtureSchema)} CASCADE;
        DROP ROLE IF EXISTS ${quoteIdentifier(readerRole)};
      `);
    } finally {
      if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('fails missing-schema status without initializing PostgreSQL tables', () => {
    expect(applicationTableCount(missingSchema)).toBe(0);

    const result = runCli(['cache', 'status'], missingSchema);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cache_account_binding|account binding|relation .* does not exist|schema is not initialized/i);
    expect(result.stderr).not.toMatch(/create table|read-only transaction|permission denied/i);
    expect(applicationTableCount(missingSchema)).toBe(0);
  });

  it('reports failed official health from an initialized read-only PostgreSQL cache', () => {
    const before = applicationTableCount(fixtureSchema);

    const result = runCli(['cache', 'status'], fixtureSchema);

    expect(result.status).toBe(0);
    const output = parseJson(result.stdout);
    expect(output).toMatchObject({
      backend: 'postgresql',
      account: accountName,
      cache_authority: 'official_v3',
      sync_health: 'failed',
      overall_health: 'failed',
      last_sync: null,
      document_count: 1,
      item_count: 1,
      line_item_count: 1,
    });
    expect(output.latest_sync_attempt).toBe(new Date(latestAttemptAt * 1000).toISOString());
    expect(applicationTableCount(fixtureSchema)).toBe(before);
  });

  it('runs cached customer analytics against read-only PostgreSQL without DDL or source enrichment', () => {
    const before = applicationTableCount(fixtureSchema);

    const result = runCli(['analytics', 'customers', itemId, '--cached'], fixtureSchema);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Warning: Could not fetch item details|https?:\/\//i);
    const output = parseJson(result.stdout);
    expect(output).toMatchObject({
      item_id: itemId,
      item_name: 'Cached readonly widget',
      total_customers: 1,
      total_quantity: 2,
      total_revenue: 10,
    });
    expect(output.top_customers).toEqual([
      expect.objectContaining({ customer_id: customerId, quantity: 2, revenue: 10 }),
    ]);
    expect(applicationTableCount(fixtureSchema)).toBe(before);
  });

  it('fails closed for default stale analytics instead of syncing from the CLI', () => {
    const before = applicationTableCount(fixtureSchema);

    const result = runCli(['analytics', 'customers', itemId], fixtureSchema);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Official V3 cache is failed/i);
    expect(result.stderr).toMatch(/cache sync-v3 --resume|--cached/i);
    expect(result.stderr).not.toMatch(/syncing cache|cache sync started|create table/i);
    expect(applicationTableCount(fixtureSchema)).toBe(before);
  });

  function runCli(args: string[], schema: string): CliResult {
    const cliPath = [
      resolve(process.cwd(), 'dist/cli.js'),
      resolve(process.cwd(), 'packages/cli/dist/cli.js'),
    ].find((candidate) => existsSync(candidate));
    if (!cliPath) throw new Error('Compiled CLI missing. Run pnpm build first.');
    const result = spawnSync(process.execPath, [cliPath, '--account', accountName, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: testPath,
        HOME: tempHome,
        NODE_ENV: 'test',
        CI: '1',
        SALESBINDER_DB_URL: scopedUrl(baseUrl, schema, { role: readerRole, readOnly: true }),
        SALESBINDER_READ_BACKEND: 'postgresql',
        SALESBINDER_CACHE_STALE_SECONDS: '60',
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function seedFixture(): void {
    const writerUrl = scopedUrl(baseUrl, fixtureSchema);
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const sdk = await import('@salesbinder/sdk');
          const service = await sdk.createPostgresCacheService();
          if (!service) throw new Error('PostgreSQL cache service unavailable');
          const binding = sdk.createSalesBinderAccountBinding(${JSON.stringify(accountSubdomain)});
          await service.ensureAccountBinding(binding);
          await service.insertItem({
            item_id: ${JSON.stringify(itemId)},
            name: 'Cached readonly widget',
            quantity: 2,
            quantity_reserved: null,
            quantity_available: null,
            quantity_incoming: null,
            in_transit: null,
            cache_source: 'api',
            source_api_version: '3',
            imported_at: ${latestAttemptAt}
          });
          await service.insertDocument({
            doc_id: ${JSON.stringify(docId)},
            api_doc_id: ${JSON.stringify(docId)},
            context_id: 5,
            doc_number: 1002,
            issue_date: ${JSON.stringify(fixtureIssueDate)},
            customer_id: ${JSON.stringify(customerId)},
            customer_name: 'Cached Customer',
            modified: ${latestAttemptAt},
            cache_source: 'api',
            imported_at: ${latestAttemptAt}
          });
          await service.insertItemDocument({
            item_id: ${JSON.stringify(itemId)},
            doc_id: ${JSON.stringify(docId)},
            document_item_id: ${JSON.stringify(lineId)},
            quantity: 2,
            price: 5
          });
          await service.getOfficialV3SyncStore().beginRun({
            version: 1,
            runId: 'run-readonly-cli',
            accountIdentity: ${JSON.stringify(accountIdentity)},
            entry: { kind: 'since', value: '1789026270' },
            status: 'failed',
            ingestionComplete: true,
            pageCount: 0,
            startedAt: ${latestAttemptAt - 60},
            updatedAt: ${latestAttemptAt},
            finishedAt: ${latestAttemptAt},
            errorCode: 'authentication_failed'
          });
          await service.close();
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          PATH: testPath,
          HOME: tempHome,
          NODE_ENV: 'test',
          CI: '1',
          SALESBINDER_DB_URL: writerUrl,
        },
      }
    );
  }
});

function guardedUrl(): string {
  if (!testDbUrl) throw new Error('SALESBINDER_READONLY_CLI_TEST_DB_URL is not configured.');
  const url = new URL(testDbUrl);
  const dbName = databaseName(testDbUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Read-only CLI integration tests require localhost PostgreSQL.');
  }
  if (!/(test|integration|scratch|sync_health)/i.test(dbName)) {
    throw new Error('Read-only CLI integration tests require an isolated test database.');
  }
  return url.toString();
}

function scopedUrl(
  base: string,
  schema: string,
  options: { role?: string; readOnly?: boolean } = {}
): string {
  const url = new URL(base);
  if (options.role) {
    url.username = options.role;
    url.password = '';
  }
  const pgOptions = [`-c search_path=${schema}`];
  if (options.readOnly) pgOptions.push('-c default_transaction_read_only=on');
  url.searchParams.set('options', pgOptions.join(' '));
  url.searchParams.set('application_name', `salesbinder-cli-readonly-${schema.slice(-20)}`);
  return url.toString();
}

function writeConfig(home: string): void {
  const salesbinderDir = join(home, '.salesbinder');
  execFileSync('mkdir', ['-p', salesbinderDir]);
  const configPath = join(salesbinderDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        defaultAccount: accountName,
        accounts: {
          [accountName]: {
            subdomain: accountSubdomain,
            apiKey: 'readonly-cli-test-key',
            v3ApiKey: 'readonly-cli-test-v3-key',
            apiVersion: '2.0',
          },
        },
        preferences: { cacheStaleSeconds: 60 },
      },
      null,
      2
    )
  );
  chmodSync(configPath, 0o600);
}

function applicationTableCount(schema: string): number {
  return Number(
    psql(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema = ${quoteLiteral(schema)} AND table_type = 'BASE TABLE';`,
      ['-Atq']
    ).trim()
  );
}

function psql(sql: string, extraArgs: string[] = []): string {
  if (!testDbUrl) throw new Error('SALESBINDER_READONLY_CLI_TEST_DB_URL is not configured.');
  return execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', ...extraArgs, testDbUrl], {
    input: sql,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
}

function parseJson(stdout: string): Record<string, any> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Expected JSON output, received empty stdout.');
  return JSON.parse(trimmed) as Record<string, any>;
}

function databaseName(urlString: string): string {
  const url = new URL(urlString);
  return decodeURIComponent(url.pathname.slice(1));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
