import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { createSalesBinderAccountBinding } from '../types.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('reference-refresh-test');

const accountId = '10000000-0000-4000-8000-000000000101';
const newAccountId = '10000000-0000-4000-8000-000000000102';

describeIfPostgres('PostgresCacheService reference refresh integration', () => {
  jest.setTimeout(45_000);

  let baseUrl = '';
  let adminPool: InstanceType<typeof Pool> | undefined;
  const contexts: TestContext[] = [];

  beforeAll(() => {
    baseUrl = guardedUrl();
    adminPool = new Pool({ connectionString: baseUrl });
  });

  afterEach(async () => {
    while (contexts.length) await cleanup(contexts.pop());
  });

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined);
  });

  it('clears explicit null account fields while preserving omitted existing metadata', async () => {
    const ctx = await createContext('account_metadata');
    await ctx.service.insertAccount({
      account_id: accountId,
      context_id: 2,
      account_number: 42,
      name: 'Original Customer',
      office_email: 'old@example.test',
      account_manager: 'Existing Manager',
      label_name: 'Existing Label',
      archived: 1,
      cache_source: 'api',
    });

    await ctx.service.upsertReferenceAccounts([
      {
        account_id: accountId,
        context_id: 2,
        name: 'Updated Customer',
        office_email: null,
        cache_source: 'api',
      },
      {
        account_id: newAccountId,
        context_id: 2,
        name: 'New Customer',
        cache_source: 'api',
      },
    ]);

    await expect(ctx.service.getAccount(accountId)).resolves.toMatchObject({
      name: 'Updated Customer',
      office_email: null,
      account_manager: 'Existing Manager',
      label_name: 'Existing Label',
      archived: 1,
    });
    await expect(ctx.service.getAccount(newAccountId)).resolves.toMatchObject({
      name: 'New Customer',
      archived: 0,
    });
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('admin pool unavailable');
    const schema = `reference_refresh_${label}_${randomUUID().replaceAll('-', '_')}`;
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const service = new PostgresCacheService(scopedUrl(baseUrl, schema));
    await service.ensureAccountBinding(binding);
    contexts.push({ schema, service });
    return { schema, service };
  }

  async function cleanup(context: TestContext | undefined): Promise<void> {
    if (!context) return;
    await context.service.close().catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(context.schema)} CASCADE`);
  }
});

interface TestContext {
  schema: string;
  service: PostgresCacheService;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function guardedUrl(): string {
  if (!testUrl) throw new Error('SALESBINDER_OFFSET_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Reference refresh integration tests require localhost PostgreSQL.');
  }
  if (!/(offset|test|integration)/i.test(database)) {
    throw new Error('Reference refresh integration tests require an isolated test database.');
  }
  return url.toString();
}

function scopedUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-reference-refresh-${schema.slice(-24)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
