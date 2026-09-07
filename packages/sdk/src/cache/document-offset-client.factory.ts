import type { AccountConfig } from '../config/config.schema.js';
import type { ClientRuntimeOptions } from '../client/salesbinder-rate-limiter.js';
import { createAxiosClient } from '../client/axios.factory.js';
import { createV3AxiosClient } from '../client/v3-axios.factory.js';
import { DocumentsResource } from '../resources/documents.resource.js';
import { V3DocumentsReadResource } from '../resources/v3-documents-read.resource.js';
import { V3ItemsResource } from '../resources/v3-items.resource.js';
import type { CacheService } from './cache.interface.js';
import type { DocumentOffsetStore } from './document-offset-sync.types.js';
import { DocumentOffsetSyncService } from './document-offset-sync.service.js';
import { V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';

/** Explicit hybrid selection, never a transport fallback after a failed V3 request. */
export function createDocumentOffsetSyncService(
  account: AccountConfig,
  cache: CacheService & DocumentOffsetStore,
  runtimeOptions: ClientRuntimeOptions = {},
  guard?: () => void
): DocumentOffsetSyncService {
  const v2 = createAxiosClient({ ...account, apiVersion: '2.0' }, runtimeOptions);
  const v3 = createV3AxiosClient(account, runtimeOptions);
  return new DocumentOffsetSyncService({
    cache,
    store: cache,
    documentsV2: new DocumentsResource(v2),
    documentsV3: new V3DocumentsReadResource(v3),
    hydrator: new V3ExactItemHydratorService({ items: new V3ItemsResource(v3) }),
    guard,
  });
}
