import type { SalesBinderClient } from '../resources/index.js';
import { ContextId } from '../types/common.types.js';
import type { Customer, CustomerListResponse } from '../types/customers.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type { AccountRow, CacheState } from './types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

export interface AccountSyncResult {
  accountsProcessed: number;
  customersProcessed: number;
  suppliersProcessed: number;
}

export interface AccountSyncOptions {
  full?: boolean;
  onProgressEvent?: CacheSyncProgressCallback;
}

interface ContextSyncResult {
  processed: number;
  total: number | null;
}

type AccountProgress = Omit<CacheSyncProgress, 'phase' | 'apiVersion'>;

export class AccountIndexerService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {}

  async sync(fullOrOptions: boolean | AccountSyncOptions = false): Promise<AccountSyncResult> {
    const options = typeof fullOrOptions === 'boolean' ? { full: fullOrOptions } : fullOrOptions;
    const full = options.full ?? false;
    this.emit(options.onProgressEvent, {
      event: 'phase_started',
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    const state = await this.cache.getCacheState();
    const since = full
      ? 0
      : Math.max(0, (state?.lastAccountSync ?? state?.lastSync ?? 0) - this.syncLookbackSeconds);
    const customers = await this.syncContext(ContextId.Customer, since, 1, options.onProgressEvent);
    const suppliers = await this.syncContext(ContextId.Supplier, since, 2, options.onProgressEvent);
    const now = Math.floor(Date.now() / 1000);

    await this.cache.setCacheState(this.mergeState(state, now));
    const total = sumKnownTotals(customers.total, suppliers.total);
    const processed = customers.processed + suppliers.processed;
    this.emit(options.onProgressEvent, {
      event: 'phase_completed',
      recordsProcessed: processed,
      recordsTotal: total,
      indeterminate: total === null,
    });

    return {
      accountsProcessed: processed,
      customersProcessed: customers.processed,
      suppliersProcessed: suppliers.processed,
    };
  }

  private async syncContext(
    contextId: ContextId,
    modifiedSince: number,
    pass: number,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<ContextSyncResult> {
    let page = 1;
    let processed = 0;
    let pagesTotal: number | null = null;
    let recordsTotal: number | null = null;
    let lastCompletedPage = 0;
    let hasMore = true;

    this.emit(onProgressEvent, {
      event: 'pass_started',
      pass,
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    while (hasMore) {
      this.emit(onProgressEvent, {
        event: 'page_started',
        pass,
        page,
        pagesTotal,
        recordsProcessed: processed,
        recordsTotal,
        indeterminate: recordsTotal === null,
      });
      const response = await this.client.customers.list({
        contextId,
        modifiedSince,
        page,
        pageLimit: 200,
      });
      const accounts = this.flattenCustomers(response);
      const reportedPages = parseOptionalCount(response.pages);
      const reportedTotal = parseOptionalCount(response.count);
      const coherentPages =
        reportedPages !== null &&
        (accounts.length === 0
          ? reportedPages === 0 || reportedPages >= page
          : reportedPages >= page);
      if (page === 1) {
        pagesTotal = coherentPages ? reportedPages : null;
        recordsTotal = pagesTotal === null ? null : reportedTotal;
      } else {
        if (!coherentPages || reportedPages !== pagesTotal) pagesTotal = null;
        if (pagesTotal === null || reportedTotal === null || reportedTotal !== recordsTotal)
          recordsTotal = null;
      }
      if (accounts.length === 0) {
        lastCompletedPage = page;
        this.emit(onProgressEvent, {
          event: 'page_completed',
          pass,
          page,
          pagesTotal,
          recordsProcessed: processed,
          recordsTotal,
          indeterminate: recordsTotal === null,
        });
        break;
      }

      await this.cache.batchInsertAccounts(
        accounts.map((account) => this.toAccountRow(account, contextId))
      );
      for (let index = 0; index < accounts.length; index++) {
        processed++;
        if (recordsTotal !== null && processed > recordsTotal) recordsTotal = null;
        this.emit(onProgressEvent, {
          event: 'record_processed',
          pass,
          page,
          pagesTotal,
          recordsProcessed: processed,
          recordsTotal,
          indeterminate: recordsTotal === null,
        });
      }
      this.emit(onProgressEvent, {
        event: 'page_completed',
        pass,
        page,
        pagesTotal,
        recordsProcessed: processed,
        recordsTotal,
        indeterminate: recordsTotal === null,
      });
      lastCompletedPage = page;
      hasMore = page < Number(response.pages ?? page);
      page++;
    }

    recordsTotal = completedRecordTotal(processed, recordsTotal, pagesTotal, lastCompletedPage);
    this.emit(onProgressEvent, {
      event: 'pass_completed',
      pass,
      recordsProcessed: processed,
      recordsTotal,
      indeterminate: recordsTotal === null,
    });
    return { processed, total: recordsTotal };
  }

  private emit(callback: CacheSyncProgressCallback | undefined, progress: AccountProgress): void {
    callback?.({ phase: 'accounts', apiVersion: '2.0', ...progress });
  }

  private flattenCustomers(response: CustomerListResponse): Customer[] {
    const customers = response.customers ?? [];
    return Array.isArray(customers[0]) ? (customers as unknown as Customer[][]).flat() : customers;
  }

  private toAccountRow(account: Customer, contextId: ContextId): AccountRow {
    if (account.context_id != null && account.context_id !== contextId) {
      throw new Error(
        `Account context mismatch: requested ${contextId}, received ${account.context_id}`
      );
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
      // The CLI owns the global lastSync watermark and advances it only after
      // all sync phases complete successfully.
      lastSync: state?.lastSync ?? 0,
      lastFullSync: state?.lastFullSync ?? 0,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastAccountSync: now,
    };
  }
}

function completedRecordTotal(
  processed: number,
  recordsTotal: number | null,
  pagesTotal: number | null,
  lastCompletedPage: number
): number | null {
  if (recordsTotal === null || pagesTotal === null || processed !== recordsTotal) return null;
  return pagesTotal === 0
    ? processed === 0
      ? 0
      : null
    : lastCompletedPage >= pagesTotal
      ? recordsTotal
      : null;
}

function parseOptionalCount(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sumKnownTotals(...totals: Array<number | null>): number | null {
  return totals.every((total): total is number => total !== null)
    ? totals.reduce<number>((sum, total) => sum + total, 0)
    : null;
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}
