import type { SalesOrderShippingDocumentsPort } from './sales-order-shipping-reconciliation.service.js';
import {
  SalesOrderShippingReconciliationService,
  type SalesOrderShippingCachePort,
} from './sales-order-shipping-reconciliation.service.js';

/** Shares an already-governed document client with the official sync runtime. */
export function createSalesOrderShippingReconciliationService(
  documents: SalesOrderShippingDocumentsPort,
  cache: SalesOrderShippingCachePort,
  guard?: () => void | Promise<void>
): SalesOrderShippingReconciliationService {
  return new SalesOrderShippingReconciliationService({ documents, cache, guard });
}
