import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { OCShippingWarning } from './postgres-oc-shipping-warning.store.js';
import type { OCShippingProvenance } from './postgres-oc-shipping.store.js';
import type { SalesOrderShippingDocumentsPort } from './sales-order-shipping-reconciliation.service.js';

const MAX_PAGES = 10_000;

export async function readCompleteSalesOrders(
  documents: SalesOrderShippingDocumentsPort,
  guard: () => Promise<void>,
  pageLimit: number
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let expectedPages: number | undefined;
  let expectedRecords: number | undefined;
  for (let pageNumber = 1; ; pageNumber++) {
    if (pageNumber > MAX_PAGES) throw invalidPage();
    await guard();
    const page = await documents.listSalesOrders({ page: pageNumber, limit: pageLimit });
    if (
      page.pagination.page !== pageNumber ||
      (expectedPages !== undefined && page.pagination.total_pages !== expectedPages) ||
      (expectedRecords !== undefined && page.pagination.total_records !== expectedRecords) ||
      page.has_more !== (pageNumber < page.pagination.total_pages)
    ) {
      throw invalidPage();
    }
    expectedPages ??= page.pagination.total_pages;
    expectedRecords ??= page.pagination.total_records;
    for (const record of page.data) {
      const id = requiredSalesOrderId(record);
      if (ids.has(id)) throw invalidPage();
      ids.add(id);
      records.push(record);
    }
    if (!page.has_more) break;
  }
  if (records.length !== expectedRecords) throw invalidPage();
  return records;
}

export function requiredSalesOrderId(value: Record<string, unknown>): string {
  if (
    value.object !== 'sales_order' ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
  ) {
    throw invalidPage();
  }
  return value.id;
}

export function assertRequestedSalesOrderId(
  value: Record<string, unknown>,
  expectedId: string
): void {
  if (requiredSalesOrderId(value) !== expectedId) {
    throw new ApiResponseValidationError(
      'Invalid API v3 response for sales order detail: expected requested identity',
      'identity'
    );
  }
}

export function assertRequestedWarningDocument(
  value: unknown,
  warning: OCShippingWarning
): asserts value is Record<string, unknown> {
  const record = value as Record<string, unknown> | null;
  const expectedObject = warning.contextId === 4 ? 'estimate' : 'invoice';
  if (
    !record ||
    record.id !== warning.documentId ||
    record.object !== expectedObject ||
    (record.context_id !== undefined && record.context_id !== warning.contextId)
  ) {
    throw new ApiResponseValidationError(
      'Invalid API v3 response for shipping warning retry: expected requested identity',
      'identity'
    );
  }
}

export function isSalesOrderAuthority(link: OCShippingProvenance): boolean {
  return (
    link.authorityId !== null &&
    (link.sourceKind === 'sales_order' ||
      (link.sourceKind === 'invoice' && link.sourceDocumentId !== link.authorityId))
  );
}

export function isRecordFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    error.response.status === 404
  );
}

export function safeReconciliationErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown; response?: { status?: unknown } } | null;
  const status = Number(candidate?.response?.status);
  if (status === 401 || status === 403) return 'authorization_failed';
  if (error instanceof ApiResponseValidationError) return 'invalid_source_page';
  if (
    typeof candidate?.code === 'string' &&
    /^[a-z][a-z0-9_]{0,39}$/.test(candidate.code)
  ) {
    return candidate.code;
  }
  return 'reconciliation_failed';
}

function invalidPage(): ApiResponseValidationError {
  return new ApiResponseValidationError(
    'Invalid API v3 response for sales orders: expected stable complete pagination'
  );
}
