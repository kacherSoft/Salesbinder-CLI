import type { V3AccountConfig } from '../config/config.schema.js';
import type { ClientRuntimeOptions } from '../client/salesbinder-rate-limiter.js';
import { createV3AxiosClient } from '../client/v3-axios.factory.js';
import { V3DocumentsReadResource } from '../resources/v3-documents-read.resource.js';
import { V3ItemsResource } from '../resources/v3-items.resource.js';
import { V3SyncResource } from '../resources/v3-sync.resource.js';
import { OfficialV3SyncError, OfficialV3SyncService } from './official-v3-sync.service.js';
import type { OfficialV3SyncStore } from './official-v3-sync.types.js';
import { V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';

interface OfficialV3SyncCacheWithCategories {
  getOfficialV3SyncStore(): OfficialV3SyncStore;
  getCategorySnapshot?(): Promise<{ rows: { category_id: string; name: string }[] } | null>;
}

export function createOfficialV3SyncService(
  account: V3AccountConfig,
  cache: OfficialV3SyncCacheWithCategories | OfficialV3SyncStore,
  runtimeOptions: ClientRuntimeOptions = {},
  guard?: () => void | Promise<void>
): OfficialV3SyncService {
  const client = createV3AxiosClient(account, runtimeOptions);
  const store = 'getOfficialV3SyncStore' in cache ? cache.getOfficialV3SyncStore() : cache;
  const sync = new V3SyncResource(client);
  return new OfficialV3SyncService({
    store,
    sync: {
      read: async (params) => {
        const envelope = await sync.read(params);
        if (envelope.object !== 'sync_page') throw new OfficialV3SyncError('invalid_envelope');
        return envelope;
      },
    },
    documents: new V3DocumentsReadResource(client),
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
  });
}
