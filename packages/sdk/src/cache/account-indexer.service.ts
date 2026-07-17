import type { SalesBinderClient } from '../resources/index.js';
import { ContextId } from '../types/common.types.js';
import type { Customer, CustomerListResponse } from '../types/customers.types.js';
import type { CacheService } from './cache.interface.js';
import type { AccountRow, CacheState } from './types.js';
import {
  assertCacheMutationCompatible,
  CACHE_PENDING_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
} from './types.js';

export interface AccountSyncResult {
  accountsProcessed: number;
  customersProcessed: number;
  suppliersProcessed: number;
}

export class AccountIndexerService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {}

  async sync(full = false): Promise<AccountSyncResult> {
    const state = await this.cache.getCacheState();
    await assertCacheMutationCompatible(this.cache, state, this.accountName);
    const effectiveFull = full
      || !state
      || state.accountName !== this.accountName
      || state.schemaVersion !== CACHE_SCHEMA_VERSION
      || !state.lastAccountSync;
    const allowExistingEnrichment = state?.accountName === this.accountName;
    const syncStartedAt = Math.floor(Date.now() / 1000);
    const since = effectiveFull || state?.lastAccountSync == null
      ? 0
      : Math.max(0, state.lastAccountSync - this.syncLookbackSeconds);
    const existingAccounts = allowExistingEnrichment
      ? new Map((await this.cache.getAllAccounts()).map((account) => [account.account_id, account]))
      : new Map<string, AccountRow>();
    const customers = await this.syncContext(ContextId.Customer, since, existingAccounts);
    const suppliers = await this.syncContext(ContextId.Supplier, since, existingAccounts);
    const now = Math.floor(Date.now() / 1000);

    await this.cache.setCacheState(this.mergeState(state, syncStartedAt, now));

    return {
      accountsProcessed: customers + suppliers,
      customersProcessed: customers,
      suppliersProcessed: suppliers,
    };
  }

  private async syncContext(
    contextId: ContextId,
    modifiedSince: number,
    existingAccounts: Map<string, AccountRow>
  ): Promise<number> {
    let page = 1;
    let processed = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.customers.list({
        contextId,
        modifiedSince,
        page,
        pageLimit: 200,
      });
      const accounts = this.flattenCustomers(response);
      if (accounts.length === 0) break;

      const rows = accounts.map((account) => this.toAccountRow(
        account,
        contextId,
        existingAccounts.get(account.id)?.context_id === contextId
          ? existingAccounts.get(account.id)
          : undefined
      ));
      await this.cache.batchInsertAccounts(rows);
      for (const row of rows) existingAccounts.set(row.account_id, row);
      processed += accounts.length;
      hasMore = page < Number(response.pages ?? page);
      page++;
    }

    return processed;
  }

  private flattenCustomers(response: CustomerListResponse): Customer[] {
    const customers = response.customers ?? [];
    return Array.isArray(customers[0]) ? (customers as unknown as Customer[][]).flat() : customers;
  }

  private toAccountRow(
    account: Customer,
    contextId: ContextId,
    existing?: AccountRow
  ): AccountRow {
    if (account.context_id != null && account.context_id !== contextId) {
      throw new Error(`Account context mismatch: requested ${contextId}, received ${account.context_id}`);
    }

    const archived = directPresence<boolean | null>(account, 'archived');
    const modified = directPresence<string | null>(account, 'modified');
    return {
      account_id: account.id,
      context_id: account.context_id ?? contextId,
      account_number: resolveDirect(account, 'customer_number', existing?.account_number) ?? null,
      name: resolveDirect(account, 'name', existing?.name) ?? 'Unknown',
      office_email: resolveDirect(account, 'office_email', existing?.office_email) ?? null,
      office_phone: resolveDirect(account, 'office_phone', existing?.office_phone) ?? null,
      office_fax: resolveDirect(account, 'office_fax', existing?.office_fax) ?? null,
      url: resolveDirect(account, 'url', existing?.url) ?? null,
      billing_address_1: resolveDirect(
        account,
        'billing_address_1',
        existing?.billing_address_1
      ) ?? null,
      billing_address_2: resolveDirect(
        account,
        'billing_address_2',
        existing?.billing_address_2
      ) ?? null,
      billing_city: resolveDirect(account, 'billing_city', existing?.billing_city) ?? null,
      billing_region: resolveDirect(account, 'billing_region', existing?.billing_region) ?? null,
      billing_postal_code: resolveDirect(
        account,
        'billing_postal_code',
        existing?.billing_postal_code
      ) ?? null,
      billing_country: resolveDirect(account, 'billing_country', existing?.billing_country) ?? null,
      shipping_address_1: resolveDirect(
        account,
        'shipping_address_1',
        existing?.shipping_address_1
      ) ?? null,
      shipping_address_2: resolveDirect(
        account,
        'shipping_address_2',
        existing?.shipping_address_2
      ) ?? null,
      shipping_city: resolveDirect(account, 'shipping_city', existing?.shipping_city) ?? null,
      shipping_region: resolveDirect(account, 'shipping_region', existing?.shipping_region) ?? null,
      shipping_postal_code: resolveDirect(
        account,
        'shipping_postal_code',
        existing?.shipping_postal_code
      ) ?? null,
      shipping_country: resolveDirect(
        account,
        'shipping_country',
        existing?.shipping_country
      ) ?? null,
      vat_number: resolveDirect(account, 'vat_number', existing?.vat_number) ?? null,
      account_manager: resolveDirect(account, 'account_manager', existing?.account_manager) ?? null,
      label_name: resolveDirect(account, 'label_name', existing?.label_name) ?? null,
      archived: archived.present
        ? archived.value === null ? 0 : archived.value ? 1 : 0
        : existing?.archived ?? 0,
      last_invoiced: resolveDirect(account, 'last_invoiced', existing?.last_invoiced) ?? null,
      created: resolveDirect(account, 'created', existing?.created) ?? null,
      modified: modified.present
        ? toUnix(modified.value ?? undefined)
        : existing?.modified ?? null,
      cache_source: 'api',
      imported_at: existing?.imported_at ?? null,
    };
  }

  private mergeState(state: CacheState | null, syncWatermark: number, now: number): CacheState {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      // Document reconciliation owns these completion signals. Preserve an
      // existing mismatch so running accounts first cannot downgrade a
      // required historical document backfill into a delta sync.
      accountName: state?.accountName?.trim() ? state.accountName : this.accountName,
      schemaVersion: state?.schemaVersion ?? CACHE_PENDING_SCHEMA_VERSION,
      lastAccountSync: syncWatermark,
    };
  }
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

type Presence<T> = { present: true; value: T } | { present: false };

function directPresence<T>(source: unknown, key: string): Presence<T> {
  if (!source || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, key)) {
    return { present: false };
  }
  return { present: true, value: (source as Record<string, unknown>)[key] as T };
}

function resolveDirect<T>(source: unknown, key: string, existing: T | undefined): T | undefined {
  const value = directPresence<T>(source, key);
  return value.present ? value.value : existing;
}
