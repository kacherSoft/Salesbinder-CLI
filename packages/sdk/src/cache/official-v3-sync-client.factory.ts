import type { V3AccountConfig } from '../config/config.schema.js';
import type { ClientRuntimeOptions } from '../client/salesbinder-rate-limiter.js';
import { createV3AxiosClient } from '../client/v3-axios.factory.js';
import { V3DocumentsReadResource } from '../resources/v3-documents-read.resource.js';
import { V3ItemsResource } from '../resources/v3-items.resource.js';
import { V3SyncResource } from '../resources/v3-sync.resource.js';
import { OfficialV3SyncError, OfficialV3SyncService } from './official-v3-sync.service.js';
import type { OfficialV3SyncStore } from './official-v3-sync.types.js';
import { V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';
import { createSalesOrderShippingReconciliationService } from './sales-order-shipping-reconciliation.factory.js';
import type {
  SalesOrderShippingCachePort,
  SalesOrderShippingReconciliationOptions,
  SalesOrderShippingReconciliationResult,
} from './sales-order-shipping-reconciliation.service.js';

interface OfficialV3SyncCacheWithCategories {
  getOfficialV3SyncStore(): OfficialV3SyncStore;
  getCategorySnapshot?(): Promise<{ rows: { category_id: string; name: string }[] } | null>;
}

export type OfficialV3SyncRuntime = OfficialV3SyncService & {
  reconcileOCShipping?: (
    options: SalesOrderShippingReconciliationOptions
  ) => Promise<SalesOrderShippingReconciliationResult>;
};

export function createOfficialV3SyncService(
  account: V3AccountConfig,
  cache: OfficialV3SyncCacheWithCategories | OfficialV3SyncStore,
  runtimeOptions: ClientRuntimeOptions = {},
  guard?: () => void | Promise<void>
): OfficialV3SyncRuntime {
  const client = createV3AxiosClient(account, runtimeOptions);
  const store = 'getOfficialV3SyncStore' in cache ? cache.getOfficialV3SyncStore() : cache;
  const sync = new V3SyncResource(client);
  const documents = new V3DocumentsReadResource(client);
  const documentsPort = {
    get: (contextId: 4 | 5 | 11, id: string) => documents.get(contextId, id),
    getSalesOrder: (id: string) => documents.getSalesOrder(id),
    listSalesOrders: (params?: Parameters<typeof documents.listSalesOrders>[0]) =>
      documents.listSalesOrders(params),
  };
  const runtime = new OfficialV3SyncService({
    store,
    sync: {
      read: async (params) => {
        const envelope = await sync.read(params);
        if (envelope.object !== 'sync_page') throw new OfficialV3SyncError('invalid_envelope');
        return envelope;
      },
    },
    documents: documentsPort,
    hydrator: new V3ExactItemHydratorService({ items: new V3ItemsResource(client) }),
    guard,
    loadCategoryNames:
      'getCategorySnapshot' in cache && cache.getCategorySnapshot
        ? async () => {
            const snapshot = await cache.getCategorySnapshot?.();
            return snapshot
              ? new Map(snapshot.rows.map((row) => [row.category_id, row.name]))
              : null;
          }
        : undefined,
  }) as OfficialV3SyncRuntime;
  if (isReconciliationCache(cache)) {
    const reconciliation = createSalesOrderShippingReconciliationService(documentsPort, cache, guard);
    runtime.reconcileOCShipping = (options) => reconciliation.sync(options);
  }
  return runtime;
}

function isReconciliationCache(value: unknown): value is SalesOrderShippingCachePort {
  return !!value && typeof value === 'object' && [
    'applyOCShippingPatch', 'clearOCShippingAuthority', 'getOCShippingKnownLinks',
    'getOCShippingReconciliationStatus', 'setOCShippingReconciliationStatus',
    'getOCShippingPendingWarnings', 'setOCShippingWarning', 'clearOCShippingWarning',
  ].every((key) => typeof (value as Record<string, unknown>)[key] === 'function');
}
