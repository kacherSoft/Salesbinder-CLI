import { PostgresReferenceRefreshStore } from '../postgres-reference-refresh.store.js';
import { REFERENCE_REFRESH_META_KEY, type ReferenceRefreshStatus } from '../reference-refresh.types.js';

const accountIdentity = 'salesbinder:example';
const resources = ['categories', 'accounts', 'users', 'payments'] as const;

describe('PostgresReferenceRefreshStore', () => {
  it('persists terminal resource outcomes and skips only fresh terminal runs', async () => {
    let now = 100;
    const table = new Map<string, string>();
    const store = new PostgresReferenceRefreshStore(fakeOptions(table));

    const run = await store.beginRun(accountIdentity, resources, undefined, now);
    expect(run.skipped).toBe(false);
    const finished = await store.finishRun(
      accountIdentity,
      run.runId,
      [
        success('categories', now + 1),
        success('accounts', now + 2),
        skipped('users', now + 3),
        skipped('payments', now + 4),
      ],
      now + 5
    );

    expect(finished.run?.status).toBe('success_with_warnings');
    expect(finished.resources.categories.lastSuccessAt).toBe(101);
    now = 120;
    const skippedRun = await store.beginRun(accountIdentity, resources, 60, now);
    expect(skippedRun.skipped).toBe(true);
    expect(skippedRun.status.run?.status).toBe('skipped');
  });

  it('does not treat an unfinished running attempt as fresh', async () => {
    const table = new Map<string, string>();
    table.set(
      REFERENCE_REFRESH_META_KEY,
      JSON.stringify({
        version: 1,
        accountIdentity,
        updatedAt: 200,
        run: { runId: 'old-run', status: 'running', startedAt: 200 },
        resources: {
          categories: { lastAttemptAt: 200, outcome: 'success' },
          accounts: { lastAttemptAt: 200, outcome: 'success' },
          users: { lastAttemptAt: 200, outcome: 'skipped' },
          payments: { lastAttemptAt: 200, outcome: 'skipped' },
        },
      } satisfies ReferenceRefreshStatus)
    );
    const store = new PostgresReferenceRefreshStore(fakeOptions(table));

    const run = await store.beginRun(accountIdentity, resources, 86_400, 201);

    expect(run.skipped).toBe(false);
    expect(run.status.run?.status).toBe('running');
    expect(run.runId).not.toBe('old-run');
  });
});

function success(resource: (typeof resources)[number], at: number) {
  return { resource, outcome: 'success' as const, lastAttemptAt: at, lastSuccessAt: at };
}

function skipped(resource: (typeof resources)[number], at: number) {
  return { resource, outcome: 'skipped' as const, lastAttemptAt: at, code: 'skipped' };
}

function fakeOptions(table: Map<string, string>) {
  const executor = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT value FROM cache_meta')) {
        const value = table.get(String(params[0]));
        return { rows: value ? [{ value }] : [] };
      }
      if (sql.startsWith('INSERT INTO cache_meta')) {
        table.set(String(params[0]), String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected query');
    }),
  };
  return {
    withVerifiedWrite: async <T>(run: (client: never) => Promise<T>) => run(executor as never),
    withReadOnlyTransaction: async <T>(run: (client: never) => Promise<T>) => run(executor as never),
    accountIdentity: () => accountIdentity,
  };
}
