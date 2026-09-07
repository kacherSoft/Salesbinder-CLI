import { CategoryIndexerService } from './category-indexer.service.js';
import { SALESPERSON_DIRECTORY_SOURCE } from './salesperson-directory.js';
import type { CacheService } from './cache.interface.js';
import type { AccountRow } from './types.js';
import {
  type ReferenceCategoryRefreshClient,
  type ReferenceRefreshResource,
  type ReferenceRefreshResourceResult,
  type ReferenceRefreshResult,
  type ReferenceRefreshStore,
  type ReferenceRefreshSyncOptions,
  type ReferenceRefreshStatus,
  type ReferenceUsersRefreshClient,
} from './reference-refresh.types.js';
import {
  V3_ACCOUNT_RESOURCE_CONTEXT,
  type V3Account,
  type V3AccountResourceName,
} from '../resources/v3-accounts.resource.js';
import type { V3ListResponse } from '../types/items.types.js';

const ACCOUNT_RESOURCES: readonly V3AccountResourceName[] = [
  'customers',
  'prospects',
  'suppliers',
] as const;
const MANAGED_RESOURCES: readonly ReferenceRefreshResource[] = [
  'categories',
  'accounts',
  'users',
  'payments',
] as const;
const MAX_ACCOUNT_PAGES = 10_000;
const MAX_ACCOUNT_COUNT = 1_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ReferenceRefreshCache extends CacheService {
  getReferenceRefreshStore(): ReferenceRefreshStore;
  upsertReferenceAccounts?(accounts: AccountRow[]): Promise<number>;
  applySalespersonDirectoryRepair?(input: {
    accountIdentity: string;
    source: typeof SALESPERSON_DIRECTORY_SOURCE;
    fetchedAt: number;
    users: { userId: string; displayName: string }[];
  }): Promise<{ updatedCount: number; unresolvedUserCounts: Record<string, number> }>;
}

export interface ReferenceAccountsRefreshClient {
  list(
    resource: V3AccountResourceName,
    params?: { page?: number; limit?: number }
  ): Promise<V3ListResponse<V3Account>>;
}

export interface ReferenceRefreshServiceOptions {
  cache: ReferenceRefreshCache;
  categories: ReferenceCategoryRefreshClient;
  accounts: ReferenceAccountsRefreshClient;
  users?: ReferenceUsersRefreshClient;
  now?: () => number;
  guard?: () => void | Promise<void>;
}

export class ReferenceRefreshService {
  constructor(private readonly options: ReferenceRefreshServiceOptions) {}

  async status(accountIdentity: string): Promise<ReferenceRefreshStatus | null> {
    return this.options.cache.getReferenceRefreshStore().getStatus(accountIdentity);
  }

  async sync(options: ReferenceRefreshSyncOptions): Promise<ReferenceRefreshResult> {
    validateSyncOptions(options);
    const now = this.now();
    const store = this.options.cache.getReferenceRefreshStore();
    const run = await store.beginRun(
      options.accountIdentity,
      MANAGED_RESOURCES,
      options.ifStaleSeconds,
      now
    );
    if (run.skipped) {
      return { status: run.status, resources: [], skipped: true, coverage: 'references_only' };
    }

    const results: ReferenceRefreshResourceResult[] = [];
    results.push(await this.runResource('categories', () => this.refreshCategories(options.accountIdentity)));
    results.push(await this.runResource('accounts', () => this.refreshAccounts()));
    results.push(await this.runResource('users', () => this.refreshUsers(options.accountIdentity)));
    results.push(excludedPaymentsResult(this.now()));

    const status = await store.finishRun(options.accountIdentity, run.runId, results, this.now());
    return { status, resources: results, skipped: false, coverage: 'references_only' };
  }

  private async runResource(
    resource: ReferenceRefreshResource,
    run: () => Promise<{
      recordCount?: number;
      safeMessage?: string;
      code?: string;
      outcome?: 'success' | 'warning' | 'skipped';
    }>
  ): Promise<ReferenceRefreshResourceResult> {
    const lastAttemptAt = this.now();
    try {
      await this.options.guard?.();
      const result = await run();
      await this.options.guard?.();
      return {
        resource,
        outcome: result.outcome ?? 'success',
        lastAttemptAt,
        lastSuccessAt: this.now(),
        recordCount: result.recordCount,
        code: result.code,
        safeMessage: result.safeMessage,
      };
    } catch (error) {
      return {
        resource,
        outcome: 'failed',
        lastAttemptAt,
        code: safeCode(error),
        safeMessage: safeMessage(resource, error),
      };
    }
  }

  private async refreshCategories(accountIdentity: string): Promise<{ recordCount: number }> {
    const result = await new CategoryIndexerService(
      this.options.categories,
      this.options.cache,
      accountIdentity,
      '3'
    ).sync();
    return { recordCount: result.categoriesProcessed };
  }

  private async refreshAccounts(): Promise<{ recordCount: number }> {
    const rows: AccountRow[] = [];
    const seen = new Set<string>();
    for (const resource of ACCOUNT_RESOURCES) {
      rows.push(...(await this.fetchAccountRows(resource, seen)));
    }
    if (!this.options.cache.upsertReferenceAccounts) {
      throw new Error('Reference account writer is unavailable.');
    }
    return { recordCount: await this.options.cache.upsertReferenceAccounts(rows) };
  }

  private async refreshUsers(accountIdentity: string): Promise<{
    recordCount: number;
    safeMessage?: string;
    code?: string;
    outcome?: 'skipped';
  }> {
    if (!this.options.users) {
      return {
        recordCount: 0,
        outcome: 'skipped',
        code: 'v2_users_not_configured',
        safeMessage: 'V2 users credential is not configured; cached directory was not changed.',
      };
    }
    if (!this.options.cache.applySalespersonDirectoryRepair) {
      throw new Error('Salesperson directory writer is unavailable.');
    }
    const users = await this.options.users.listDirectoryUsers();
    await this.options.cache.applySalespersonDirectoryRepair({
      accountIdentity,
      source: SALESPERSON_DIRECTORY_SOURCE,
      fetchedAt: this.now(),
      users,
    });
    return { recordCount: users.length };
  }

  private async fetchAccountRows(
    resource: V3AccountResourceName,
    seen: Set<string>
  ): Promise<AccountRow[]> {
    const first = await this.options.accounts.list(resource, { page: 1, limit: 100 });
    validateAccountPage(first, resource, 1);
    const rows = first.data.map((account) => accountRow(account, resource, seen));
    const totalPages = boundedCount(first.pagination.total_pages, MAX_ACCOUNT_PAGES);
    const totalRecords = boundedCount(first.pagination.total_records, MAX_ACCOUNT_COUNT);
    for (let page = 2; page <= totalPages; page++) {
      const response = await this.options.accounts.list(resource, { page, limit: 100 });
      validateAccountPage(response, resource, page, totalPages, totalRecords);
      rows.push(...response.data.map((account) => accountRow(account, resource, seen)));
    }
    if (rows.length !== totalRecords) {
      throw new Error(`V3 ${resource} pagination ended before its declared count.`);
    }
    return rows;
  }

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }
}

function validateSyncOptions(options: ReferenceRefreshSyncOptions): void {
  if (!/^salesbinder:[a-z0-9-]+$/.test(options.accountIdentity)) {
    throw new Error('Reference refresh account identity is invalid.');
  }
  if (
    options.ifStaleSeconds !== undefined &&
    (!Number.isSafeInteger(options.ifStaleSeconds) || options.ifStaleSeconds < 0)
  ) {
    throw new Error('--if-stale must be a non-negative integer.');
  }
}

function validateAccountPage(
  response: V3ListResponse<V3Account>,
  resource: V3AccountResourceName,
  expectedPage: number,
  expectedPages?: number,
  expectedCount?: number
): void {
  const { page, per_page, total_pages, total_records } = response.pagination;
  if (
    page !== expectedPage ||
    per_page < 1 ||
    per_page > 100 ||
    boundedCount(total_pages, MAX_ACCOUNT_PAGES) !== total_pages ||
    boundedCount(total_records, MAX_ACCOUNT_COUNT) !== total_records ||
    (expectedPages !== undefined && total_pages !== expectedPages) ||
    (expectedCount !== undefined && total_records !== expectedCount) ||
    response.has_more !== page < total_pages
  ) {
    throw new Error(`Invalid V3 ${resource} pagination.`);
  }
}

function accountRow(
  account: V3Account,
  resource: V3AccountResourceName,
  seen: Set<string>
): AccountRow {
  if (!UUID.test(String(account.id)) || seen.has(account.id)) {
    throw new Error(`Invalid V3 ${resource} account identity.`);
  }
  if (account.object !== resource.slice(0, -1)) {
    throw new Error(`Invalid V3 ${resource} object discriminator.`);
  }
  if (typeof account.name !== 'string' || account.name.trim().length === 0) {
    throw new Error(`Invalid V3 ${resource} name.`);
  }
  seen.add(account.id);
  const row: AccountRow = {
    account_id: account.id,
    context_id: V3_ACCOUNT_RESOURCE_CONTEXT[resource],
    name: account.name.trim(),
    cache_source: 'api',
  };
  assignNumber(row, 'account_number', account, 'customer_number');
  assignString(row, 'office_email', account, 'office_email');
  assignString(row, 'office_phone', account, 'office_phone');
  assignString(row, 'office_fax', account, 'office_fax');
  assignString(row, 'url', account, 'url');
  assignString(row, 'billing_address_1', account, 'billing_address_1');
  assignString(row, 'billing_address_2', account, 'billing_address_2');
  assignString(row, 'billing_city', account, 'billing_city');
  assignString(row, 'billing_region', account, 'billing_region');
  assignString(row, 'billing_postal_code', account, 'billing_postal_code');
  assignString(row, 'billing_country', account, 'billing_country');
  assignString(row, 'shipping_address_1', account, 'shipping_address_1');
  assignString(row, 'shipping_address_2', account, 'shipping_address_2');
  assignString(row, 'shipping_city', account, 'shipping_city');
  assignString(row, 'shipping_region', account, 'shipping_region');
  assignString(row, 'shipping_postal_code', account, 'shipping_postal_code');
  assignString(row, 'shipping_country', account, 'shipping_country');
  assignString(row, 'vat_number', account, 'vat_number');
  assignString(row, 'last_invoiced', account, 'last_invoice_date');
  assignString(row, 'created', account, 'created_at');
  if (hasOwn(account, 'updated_at')) row.modified = timestampOrNull(account.updated_at);
  if (hasOwn(account, 'archived')) {
    row.archived = typeof account.archived === 'boolean' ? (account.archived ? 1 : 0) : null;
  }
  return row;
}

function boundedCount(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid count.');
  return value;
}

function numberOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function timestampOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function assignString<T extends keyof AccountRow>(
  row: AccountRow,
  target: T,
  source: V3Account,
  sourceKey: keyof V3Account
): void {
  if (hasOwn(source, sourceKey)) {
    (row[target] as string | null) = stringOrNull(source[sourceKey]);
  }
}

function assignNumber<T extends keyof AccountRow>(
  row: AccountRow,
  target: T,
  source: V3Account,
  sourceKey: keyof V3Account
): void {
  if (hasOwn(source, sourceKey)) {
    (row[target] as number | null) = numberOrNull(source[sourceKey]);
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'failed';
}

function safeMessage(resource: ReferenceRefreshResource, error: unknown): string {
  const status = Number((error as { response?: { status?: unknown } })?.response?.status);
  if (status === 401 || status === 403) return `${resource} refresh authorization failed.`;
  return `${resource} refresh failed.`;
}

function excludedPaymentsResult(now: number): ReferenceRefreshResourceResult {
  return {
    resource: 'payments',
    outcome: 'skipped',
    lastAttemptAt: now,
    code: 'excluded',
    safeMessage: 'Payments are excluded from reference refresh.',
  };
}
