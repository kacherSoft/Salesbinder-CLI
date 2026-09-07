import type { SalesBinderClient } from '../resources/index.js';
import { ContextId } from '../types/common.types.js';
import type { Customer, CustomerListResponse } from '../types/customers.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';
import { resolveSyncLookbackSeconds } from './sync-lookback.js';
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
  total: number;
}

interface AccountPaginationState {
  count: number;
  pages: number;
}

type AccountProgress = Omit<CacheSyncProgress, 'phase' | 'apiVersion'>;

const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_ACCOUNT_PAGES = 10_000;
const MAX_ACCOUNT_RECORDS = 1_000_000;

export class AccountIndexerService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    syncLookbackSeconds: unknown = undefined
  ) {
    this.syncLookbackSeconds = resolveSyncLookbackSeconds(syncLookbackSeconds);
  }

  private readonly syncLookbackSeconds: number;

  async sync(fullOrOptions: boolean | AccountSyncOptions = false): Promise<AccountSyncResult> {
    const options = typeof fullOrOptions === 'boolean' ? { full: fullOrOptions } : fullOrOptions;
    const full = options.full ?? false;
    const scanStartedAt = nowInSeconds();
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
    const seenIds = new Set<string>();
    const customers = await this.syncContext(
      ContextId.Customer,
      since,
      1,
      seenIds,
      options.onProgressEvent
    );
    const suppliers = await this.syncContext(
      ContextId.Supplier,
      since,
      2,
      seenIds,
      options.onProgressEvent
    );

    await this.cache.setCacheState(this.mergeState(state, scanStartedAt));
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
    seenIds: Set<string>,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<ContextSyncResult> {
    let page = 1;
    let processed = 0;
    let paginationState: AccountPaginationState | null = null;
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
        pagesTotal: paginationState?.pages ?? null,
        recordsProcessed: processed,
        recordsTotal: paginationState?.count ?? null,
        indeterminate: paginationState === null,
      });
      const response = await this.client.customers.list({
        contextId,
        modifiedSince,
        page,
        pageLimit: 200,
      });
      const accounts = this.validatePageAccounts(response, contextId, seenIds);
      paginationState = validateAccountPagination(
        response,
        page,
        processed,
        accounts.length,
        paginationState
      );
      if (accounts.length === 0) {
        this.emit(onProgressEvent, {
          event: 'page_completed',
          pass,
          page,
          pagesTotal: paginationState.pages,
          recordsProcessed: processed,
          recordsTotal: paginationState.count,
          indeterminate: false,
        });
        break;
      }

      await this.cache.batchInsertAccounts(
        accounts.map((account) => this.toAccountRow(account, contextId))
      );
      for (let index = 0; index < accounts.length; index++) {
        processed++;
        this.emit(onProgressEvent, {
          event: 'record_processed',
          pass,
          page,
          pagesTotal: paginationState.pages,
          recordsProcessed: processed,
          recordsTotal: paginationState.count,
          indeterminate: false,
        });
      }
      this.emit(onProgressEvent, {
        event: 'page_completed',
        pass,
        page,
        pagesTotal: paginationState.pages,
        recordsProcessed: processed,
        recordsTotal: paginationState.count,
        indeterminate: false,
      });
      hasMore = page < paginationState.pages;
      page++;
    }

    if (!paginationState || processed !== paginationState.count) {
      throw new Error('Account pagination ended before its declared record count.');
    }
    this.emit(onProgressEvent, {
      event: 'pass_completed',
      pass,
      recordsProcessed: processed,
      recordsTotal: paginationState.count,
      indeterminate: false,
    });
    return { processed, total: paginationState.count };
  }

  private emit(callback: CacheSyncProgressCallback | undefined, progress: AccountProgress): void {
    callback?.({ phase: 'accounts', apiVersion: '2.0', ...progress });
  }

  private validatePageAccounts(
    response: CustomerListResponse,
    contextId: ContextId,
    seenIds: Set<string>
  ): Customer[] {
    if (!isRecord(response) || !Array.isArray(response.customers)) {
      throw new Error('Account response envelope is invalid.');
    }
    const envelope = response.customers as unknown[];
    const nested = envelope.every(Array.isArray);
    const flat = envelope.every(isRecord);
    if (!nested && !flat) throw new Error('Account response envelope is invalid.');
    const candidates = nested ? envelope.flat() : envelope;
    if (!candidates.every(isRecord)) throw new Error('Account response envelope is invalid.');

    const pageIds = new Set<string>();
    for (const candidate of candidates) {
      const id = requireCanonicalAccountId(candidate.id);
      if (candidate.context_id != null && candidate.context_id !== contextId) {
        throw new Error(
          `Account context mismatch: requested ${contextId}, received ${String(candidate.context_id)}`
        );
      }
      if (seenIds.has(id) || pageIds.has(id)) {
        throw new Error('Account response contains a duplicate identity.');
      }
      pageIds.add(id);
    }
    for (const id of pageIds) seenIds.add(id);
    return candidates as unknown as Customer[];
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

function parsePaginationCount(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validateAccountPagination(
  response: CustomerListResponse,
  requestedPage: number,
  processed: number,
  pageRecordCount: number,
  previous: AccountPaginationState | null
): AccountPaginationState {
  const page = parsePaginationCount(response.page);
  const pages = parsePaginationCount(response.pages);
  const count = parsePaginationCount(response.count);
  if (
    page !== requestedPage ||
    pages === null ||
    count === null ||
    pages > MAX_ACCOUNT_PAGES ||
    count > MAX_ACCOUNT_RECORDS ||
    (previous !== null && (pages !== previous.pages || count !== previous.count))
  ) {
    throw new Error('Account pagination metadata is invalid or changed.');
  }
  if (count === 0) {
    if (
      requestedPage !== 1 ||
      (pages !== 0 && pages !== 1) ||
      pageRecordCount !== 0
    ) {
      throw new Error('Account pagination does not match its records.');
    }
    return { count, pages };
  }
  if (pages === 0 || requestedPage > pages || (requestedPage < pages && pageRecordCount === 0)) {
    throw new Error('Account pagination ended before its declared final page.');
  }
  const prospectiveProcessed = processed + pageRecordCount;
  if (
    prospectiveProcessed > count ||
    (requestedPage === pages && prospectiveProcessed !== count)
  ) {
    throw new Error('Account pagination record count does not match metadata.');
  }
  return { count, pages };
}

function requireCanonicalAccountId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACCOUNT_ID_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error('Account identity is invalid.');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sumKnownTotals(...totals: number[]): number {
  return totals.reduce((sum, total) => sum + total, 0);
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
