import type { SalesBinderClient } from '../resources/index.js';
import { ContextId } from '../types/common.types.js';
import type { Customer, CustomerListResponse } from '../types/customers.types.js';
import type { CacheService } from './cache.interface.js';
import type { AccountRow, CacheState } from './types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

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
    const since = full ? 0 : Math.max(0, (state?.lastAccountSync ?? state?.lastSync ?? 0) - this.syncLookbackSeconds);
    const customers = await this.syncContext(ContextId.Customer, since);
    const suppliers = await this.syncContext(ContextId.Supplier, since);
    const now = Math.floor(Date.now() / 1000);

    await this.cache.setCacheState(this.mergeState(state, now));

    return {
      accountsProcessed: customers + suppliers,
      customersProcessed: customers,
      suppliersProcessed: suppliers,
    };
  }

  private async syncContext(contextId: ContextId, modifiedSince: number): Promise<number> {
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

      await this.cache.batchInsertAccounts(accounts.map((account) => this.toAccountRow(account, contextId)));
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

  private toAccountRow(account: Customer, contextId: ContextId): AccountRow {
    if (account.context_id != null && account.context_id !== contextId) {
      throw new Error(`Account context mismatch: requested ${contextId}, received ${account.context_id}`);
    }

    return {
      account_id: account.id,
      context_id: account.context_id ?? contextId,
      account_number: account.customer_number,
      name: account.name,
      office_email: account.office_email ?? null,
      office_phone: account.office_phone ?? null,
      office_fax: account.office_fax ?? null,
      url: account.url ?? null,
      billing_address_1: account.billing_address_1 ?? null,
      billing_address_2: account.billing_address_2 ?? null,
      billing_city: account.billing_city ?? null,
      billing_region: account.billing_region ?? null,
      billing_postal_code: account.billing_postal_code ?? null,
      billing_country: account.billing_country ?? null,
      shipping_address_1: account.shipping_address_1 ?? null,
      shipping_address_2: account.shipping_address_2 ?? null,
      shipping_city: account.shipping_city ?? null,
      shipping_region: account.shipping_region ?? null,
      shipping_postal_code: account.shipping_postal_code ?? null,
      shipping_country: account.shipping_country ?? null,
      vat_number: account.vat_number ?? null,
      account_manager: account.account_manager ?? null,
      label_name: account.label_name ?? null,
      archived: account.archived ? 1 : 0,
      last_invoiced: account.last_invoiced ?? null,
      created: account.created,
      modified: toUnix(account.modified),
      cache_source: 'api',
    };
  }

  private mergeState(state: CacheState | null, now: number): CacheState {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastAccountSync: now,
    };
  }
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}
