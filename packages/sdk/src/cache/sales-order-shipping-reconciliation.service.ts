import type { V3SalesOrderListParams } from '../resources/v3-documents-read.resource.js';
import type { V3ListResponse } from '../types/items.types.js';
import {
  hydrateOcShippingFromSalesOrder,
  hydrateOcShippingPatchSafely,
} from './oc-shipping-hydrator.js';
import {
  OCShippingContractError,
  type OCShippingDocumentsReadPort,
  type OCShippingHydrationIssue,
  type OCShippingPatch,
} from './oc-shipping.types.js';
import type { OCShippingWarning } from './postgres-oc-shipping-warning.store.js';
import type {
  OCShippingProvenance,
  OCShippingReconciliationStatus,
} from './postgres-oc-shipping.store.js';
import {
  assertRequestedSalesOrderId,
  assertRequestedWarningDocument,
  isRecordFailure,
  isSalesOrderAuthority,
  readCompleteSalesOrders,
  requiredSalesOrderId,
  safeReconciliationErrorCode,
} from './sales-order-shipping-reconciliation-validation.js';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_WARNING_LIMIT = 500;

export interface SalesOrderShippingDocumentsPort extends OCShippingDocumentsReadPort {
  listSalesOrders(
    params?: V3SalesOrderListParams
  ): Promise<V3ListResponse<Record<string, unknown>>>;
}

export interface SalesOrderShippingCachePort {
  applyOCShippingPatch(patch: OCShippingPatch): Promise<'applied' | 'skipped_missing' | 'skipped_stale'>;
  clearOCShippingAuthority(authorityId: string): Promise<void>;
  getOCShippingPendingWarnings(): Promise<readonly OCShippingWarning[]>;
  setOCShippingWarning(warning: OCShippingWarning): Promise<void>;
  clearOCShippingWarning(contextId: 4 | 5, documentId: string): Promise<void>;
  getOCShippingKnownLinks(): Promise<readonly OCShippingProvenance[]>;
  getOCShippingReconciliationStatus(): Promise<OCShippingReconciliationStatus | null>;
  setOCShippingReconciliationStatus(status: OCShippingReconciliationStatus): Promise<void>;
}

export interface SalesOrderShippingReconciliationOptions {
  accountIdentity: string;
  onProgress?: (progress: SalesOrderShippingReconciliationProgress) => void;
}

export interface SalesOrderShippingReconciliationProgress {
  event:
    | 'scan_started'
    | 'record_applied'
    | 'record_warning'
    | 'authority_unavailable'
    | 'warning_retry_applied'
    | 'warning_retry_pending';
  scanned: number;
  applied: number;
  failed: number;
}

export interface SalesOrderShippingReconciliationResult {
  status: OCShippingReconciliationStatus;
  failures: readonly OCShippingHydrationIssue[];
  pendingWarnings: number;
}

export interface SalesOrderShippingReconciliationDependencies {
  documents: SalesOrderShippingDocumentsPort;
  cache: SalesOrderShippingCachePort;
  guard?: () => void | Promise<void>;
  now?: () => number;
  pageLimit?: number;
  warningLimit?: number;
  hydrate?: typeof hydrateOcShippingFromSalesOrder;
  hydrateWarning?: typeof hydrateOcShippingPatchSafely;
}

/** Completes one bounded, full-membership sales-order reconciliation cycle. */
export class SalesOrderShippingReconciliationService {
  private readonly now: () => number;
  private readonly guard: () => Promise<void>;
  private readonly pageLimit: number;
  private readonly warningLimit: number;

  constructor(private readonly dependencies: SalesOrderShippingReconciliationDependencies) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
    this.guard = async () => dependencies.guard?.();
    this.pageLimit = dependencies.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.warningLimit = dependencies.warningLimit ?? DEFAULT_WARNING_LIMIT;
    if (!Number.isSafeInteger(this.pageLimit) || this.pageLimit < 1 || this.pageLimit > 500) {
      throw new RangeError('Sales-order reconciliation page limit must be between 1 and 500');
    }
    if (!Number.isSafeInteger(this.warningLimit) || this.warningLimit < 1 || this.warningLimit > 500) {
      throw new RangeError('OC shipping warning retry limit must be between 1 and 500');
    }
  }

  async sync(
    options: SalesOrderShippingReconciliationOptions
  ): Promise<SalesOrderShippingReconciliationResult> {
    const startedAt = this.now();
    const previous = await this.dependencies.cache.getOCShippingReconciliationStatus();
    let scanned = 0;
    let applied = 0;
    let failureCount = 0;
    let pendingWarnings = 0;
    let salesOrderFailures = 0;
    const failures: OCShippingHydrationIssue[] = [];
    const running = this.status(options.accountIdentity, 'running', startedAt, scanned, applied, 0, {
      lastSuccessAt: previous?.lastSuccessAt,
    });
    await this.dependencies.cache.setOCShippingReconciliationStatus(running);
    options.onProgress?.({ event: 'scan_started', scanned, applied, failed: 0 });

    try {
      const salesOrders = await readCompleteSalesOrders(
        this.dependencies.documents,
        this.guard,
        this.pageLimit
      );
      const currentIds = new Set(salesOrders.map((row) => requiredSalesOrderId(row)));
      for (const summary of salesOrders) {
        await this.guard();
        const id = requiredSalesOrderId(summary);
        try {
          const detail = await this.dependencies.documents.getSalesOrder(id);
          assertRequestedSalesOrderId(detail as Record<string, unknown>, id);
          const hydration = await (this.dependencies.hydrate ?? hydrateOcShippingFromSalesOrder)(
            this.dependencies.documents,
            detail
          );
          scanned++;
          if (hydration.patch) {
            await this.guard();
            if ((await this.dependencies.cache.applyOCShippingPatch(hydration.patch)) === 'applied') applied++;
          }
          failures.push(...hydration.issues);
          failureCount += hydration.issues.length;
          salesOrderFailures += hydration.issues.length;
          options.onProgress?.({
            event: hydration.issues.length ? 'record_warning' : 'record_applied',
            scanned,
            applied,
            failed: failureCount,
          });
        } catch (error) {
          const issue = salesOrderRecordIssue(error, id);
          if (!issue) throw error;
          scanned++;
          failures.push(issue);
          failureCount++;
          salesOrderFailures++;
          options.onProgress?.({
            event: 'record_warning',
            scanned,
            applied,
            failed: failureCount,
          });
        }
      }

      const known = await this.dependencies.cache.getOCShippingKnownLinks();
      const knownSalesOrderAuthorities = known.filter(isSalesOrderAuthority);
      if (currentIds.size === 0 && knownSalesOrderAuthorities.length > 0) {
        throw new Error('Sales-order active list was unexpectedly empty');
      }
      // A partial detail pass cannot establish an all-current projection. Retry next cycle.
      if (salesOrderFailures === 0) {
        for (const link of knownSalesOrderAuthorities) {
          if (link.authorityId === null || currentIds.has(link.authorityId)) continue;
          await this.guard();
          await this.dependencies.cache.setOCShippingWarning({
            contextId: 4,
            documentId: link.estimateId,
            code: 'shipping_unknown',
            updatedAt: this.now(),
          });
          await this.guard();
          await this.dependencies.cache.clearOCShippingAuthority(link.authorityId);
          failures.push({ code: 'source_document_not_found', documentId: link.authorityId });
          failureCount++;
          salesOrderFailures++;
          options.onProgress?.({
            event: 'authority_unavailable',
            scanned,
            applied,
            failed: failureCount,
          });
        }
      }

      const pending = [
        ...(await this.dependencies.cache.getOCShippingPendingWarnings()),
      ].sort(compareWarnings);
      pendingWarnings = Math.max(0, pending.length - this.warningLimit);
      failureCount += pendingWarnings;
      for (const warning of pending.slice(0, this.warningLimit)) {
        await this.guard();
        scanned++;
        const payload = await this.readWarningDocument(warning);
        if (payload === null) {
          pendingWarnings++;
          failureCount++;
          failures.push({ code: 'source_document_not_found', documentId: warning.documentId });
          await this.touchWarning(warning);
          options.onProgress?.({ event: 'warning_retry_pending', scanned, applied, failed: failureCount });
          continue;
        }
        const hydration = await (this.dependencies.hydrateWarning ?? hydrateOcShippingPatchSafely)(
          this.dependencies.documents,
          payload
        );
        let application: Awaited<ReturnType<SalesOrderShippingCachePort['applyOCShippingPatch']>> | null = null;
        if (hydration.patch) {
          await this.guard();
          application = await this.dependencies.cache.applyOCShippingPatch(hydration.patch);
          if (application === 'applied') applied++;
        }
        if (hydration.issues.length > 0 || (hydration.patch && application !== 'applied')) {
          pendingWarnings++;
          failureCount++;
          failures.push(...hydration.issues);
          await this.touchWarning(warning);
          options.onProgress?.({ event: 'warning_retry_pending', scanned, applied, failed: failureCount });
          continue;
        }
        if (!hydration.patch && warning.contextId === 5) {
          await this.guard();
          await this.dependencies.cache.clearOCShippingAuthority(warning.documentId);
        }
        await this.guard();
        await this.dependencies.cache.clearOCShippingWarning(warning.contextId, warning.documentId);
        options.onProgress?.({ event: 'warning_retry_applied', scanned, applied, failed: failureCount });
      }

      const completedAt = this.now();
      const status = this.status(
        options.accountIdentity,
        failureCount ? 'success_with_warnings' : 'success',
        startedAt,
        scanned,
        applied,
        failureCount,
        {
          finishedAt: completedAt,
          lastSuccessAt: failureCount ? previous?.lastSuccessAt : completedAt,
        }
      );
      await this.dependencies.cache.setOCShippingReconciliationStatus(status);
      return { status, failures, pendingWarnings };
    } catch (error) {
      const failedAt = this.now();
      const status = this.status(
        options.accountIdentity,
        'failed',
        startedAt,
        scanned,
        applied,
        failureCount + 1,
        {
          finishedAt: failedAt,
          lastSuccessAt: previous?.lastSuccessAt,
          errorCode: safeReconciliationErrorCode(error),
        }
      );
      await this.dependencies.cache.setOCShippingReconciliationStatus(status);
      throw error;
    }
  }

  private async readWarningDocument(warning: OCShippingWarning): Promise<unknown | null> {
    try {
      const payload = await this.dependencies.documents.get(warning.contextId, warning.documentId);
      assertRequestedWarningDocument(payload, warning);
      return payload;
    } catch (error) {
      if (isRecordFailure(error)) return null;
      throw error;
    }
  }

  private async touchWarning(warning: OCShippingWarning): Promise<void> {
    await this.guard();
    await this.dependencies.cache.setOCShippingWarning({ ...warning, updatedAt: this.now() });
  }

  private status(
    accountIdentity: string,
    status: OCShippingReconciliationStatus['status'],
    startedAt: number,
    scanned: number,
    applied: number,
    failed: number,
    optional: Pick<
      OCShippingReconciliationStatus,
      'lastSuccessAt' | 'finishedAt' | 'errorCode'
    >
  ): OCShippingReconciliationStatus {
    return {
      version: 1,
      accountIdentity,
      status,
      startedAt,
      updatedAt: this.now(),
      scanned,
      applied,
      failed,
      ...(optional.lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: optional.lastSuccessAt }),
      ...(optional.finishedAt === undefined ? {} : { finishedAt: optional.finishedAt }),
      ...(optional.errorCode === undefined ? {} : { errorCode: optional.errorCode }),
    };
  }
}

function salesOrderRecordIssue(
  error: unknown,
  documentId: string
): OCShippingHydrationIssue | null {
  if (error instanceof OCShippingContractError) {
    return { code: 'shipping_contract_invalid', documentId };
  }
  return isRecordFailure(error) ? { code: 'source_document_not_found', documentId } : null;
}

function compareWarnings(left: OCShippingWarning, right: OCShippingWarning): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  if (left.contextId !== right.contextId) return left.contextId - right.contextId;
  return left.documentId < right.documentId ? -1 : left.documentId > right.documentId ? 1 : 0;
}
