import { ReferenceRefreshService, type ReferenceRefreshCache } from '../reference-refresh.service.js';
import type {
  ReferenceRefreshResourceResult,
  ReferenceRefreshStore,
  ReferenceRefreshStatus,
} from '../reference-refresh.types.js';
import { CACHE_SCHEMA_VERSION, type AccountRow, type CategorySnapshot } from '../types.js';

const accountIdentity = 'salesbinder:example';
const categoryId = '10000000-0000-4000-8000-000000000010';
const customerId = '10000000-0000-4000-8000-000000000020';
const prospectId = '10000000-0000-4000-8000-000000000021';
const supplierId = '10000000-0000-4000-8000-000000000022';
const userId = '10000000-0000-4000-8000-000000000030';

describe('ReferenceRefreshService', () => {
  it('refreshes V3 categories/accounts and marks users skipped when V2 is absent', async () => {
    let now = 1_800_000_000;
    const finishRun = jest.fn(
      async (_account, runId, resources: ReferenceRefreshResourceResult[]): Promise<ReferenceRefreshStatus> => ({
      version: 1,
      accountIdentity,
      updatedAt: now,
      run: { runId, status: 'success_with_warnings', startedAt: now, finishedAt: now },
      resources: Object.fromEntries(resources.map((row) => [row.resource, row])) as never,
    }));
    const store: ReferenceRefreshStore = {
      getStatus: jest.fn(async () => null),
      beginRun: jest.fn(async () => ({
        runId: 'run-1',
        skipped: false,
        status: emptyStatus(now),
      })),
      finishRun,
    };
    const categories = {
      categories: {
        list: jest.fn(async () => ({
          count: 1,
          page: 1,
          pages: 1,
          categories: [v3Category()],
        })),
      },
    };
    const accounts = { list: jest.fn(accountPage) };
    const upsertReferenceAccounts = jest.fn(async (rows: AccountRow[]) => rows.length);
    const replaceCategorySnapshot = jest.fn(async (_snapshot: CategorySnapshot) => undefined);
    const cache = {
      getCacheState: jest.fn(async () => ({ schemaVersion: CACHE_SCHEMA_VERSION })),
      replaceCategorySnapshot,
      upsertReferenceAccounts,
      getReferenceRefreshStore: () => store,
    } as unknown as ReferenceRefreshCache;
    const service = new ReferenceRefreshService({
      cache,
      categories,
      accounts,
      now: () => now++,
    });

    const result = await service.sync({ accountIdentity, ifStaleSeconds: 86_400 });

    expect(result.status.run?.status).toBe('success_with_warnings');
    expect(categories.categories.list).toHaveBeenCalledTimes(2);
    expect(accounts.list.mock.calls.map(([resource]) => resource)).toEqual([
      'customers',
      'prospects',
      'suppliers',
    ]);
    const accountRows = upsertReferenceAccounts.mock.calls[0][0];
    expect(accountRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: customerId,
          name: 'Customer A',
          office_email: null,
        }),
      ])
    );
    expect(accountRows[0]).not.toHaveProperty('account_manager');
    expect(accountRows[0]).not.toHaveProperty('label_name');
    expect(accountRows[0]).not.toHaveProperty('archived');
    expect(result.resources.find((row) => row.resource === 'users')).toMatchObject({
      outcome: 'skipped',
      code: 'v2_users_not_configured',
    });
    expect(result.resources.find((row) => row.resource === 'payments')).toMatchObject({
      outcome: 'skipped',
      code: 'excluded',
    });
  });

  it('persists the salesperson directory through the existing atomic repair port', async () => {
    const store = memoryStore();
    const applySalespersonDirectoryRepair = jest.fn(async () => ({
      updatedCount: 0,
      unresolvedUserCounts: {},
    }));
    const service = new ReferenceRefreshService({
      cache: cacheWith(store, applySalespersonDirectoryRepair),
      categories: categoryClient(),
      accounts: accountClient(),
      users: { listDirectoryUsers: jest.fn(async () => [{ userId, displayName: 'Sales User A' }]) },
      now: () => 1_800_000_000,
    });

    const result = await service.sync({ accountIdentity });

    expect(applySalespersonDirectoryRepair).toHaveBeenCalledWith({
      accountIdentity,
      source: 'salesbinder_v2_users',
      fetchedAt: 1_800_000_000,
      users: [{ userId, displayName: 'Sales User A' }],
    });
    expect(result.status.run?.status).toBe('success_with_warnings');
    expect(result.resources.find((row) => row.resource === 'users')).toMatchObject({
      outcome: 'success',
      recordCount: 1,
    });
  });
});

function emptyStatus(now: number): ReferenceRefreshStatus {
  return {
    version: 1,
    accountIdentity,
    updatedAt: now,
    resources: { categories: {}, accounts: {}, users: {}, payments: {} },
  };
}

function memoryStore(): ReferenceRefreshStore {
  let status = emptyStatus(1);
  return {
    getStatus: jest.fn(async () => status),
    beginRun: jest.fn(async (_account, _resources, _ifStale, now) => {
      status = { ...emptyStatus(now), run: { runId: 'run-1', status: 'running', startedAt: now } };
      return { runId: 'run-1', skipped: false, status };
    }),
    finishRun: jest.fn(async (_account, runId, resources, now) => {
      status = {
        ...emptyStatus(now),
        run: { runId, status: 'success_with_warnings', startedAt: now, finishedAt: now },
        resources: Object.fromEntries(resources.map((row) => [row.resource, row])) as never,
      };
      return status;
    }),
  };
}

function cacheWith(
  store: ReferenceRefreshStore,
  applySalespersonDirectoryRepair?: ReferenceRefreshCache['applySalespersonDirectoryRepair']
): ReferenceRefreshCache {
  return {
    getCacheState: jest.fn(async () => ({ schemaVersion: CACHE_SCHEMA_VERSION })),
    replaceCategorySnapshot: jest.fn(async () => undefined),
    upsertReferenceAccounts: jest.fn(async (rows: AccountRow[]) => rows.length),
    getReferenceRefreshStore: () => store,
    applySalespersonDirectoryRepair,
  } as unknown as ReferenceRefreshCache;
}

function categoryClient() {
  return {
    categories: {
      list: jest.fn(async () => ({ count: 1, page: 1, pages: 1, categories: [v3Category()] })),
    },
  };
}

function accountClient() {
  return { list: jest.fn(accountPage) };
}

function v3Category() {
  return {
    id: categoryId,
    object: 'item_category' as const,
    name: 'Parts',
    parent_id: null,
    item_count: 0,
    inventory_type: 'quantity' as const,
    custom_fields: [],
  };
}

async function accountPage(resource: string) {
  const objects = {
    customers: 'customer' as const,
    prospects: 'prospect' as const,
    suppliers: 'supplier' as const,
  };
  const ids = { customers: customerId, prospects: prospectId, suppliers: supplierId };
  const names = { customers: 'Customer A', prospects: 'Prospect A', suppliers: 'Supplier A' };
  return {
    object: 'list' as const,
    url: `/${resource}`,
    has_more: false,
    pagination: { page: 1, per_page: 100, total_pages: 1, total_records: 1 },
    data: [
      {
        id: ids[resource as keyof typeof ids],
        object: objects[resource as keyof typeof objects],
        name: names[resource as keyof typeof names],
        customer_number: null,
        office_email: null,
        created_at: '2026-09-07T00:00:00Z',
        updated_at: '2026-09-07T00:00:00Z',
      },
    ],
  };
}
