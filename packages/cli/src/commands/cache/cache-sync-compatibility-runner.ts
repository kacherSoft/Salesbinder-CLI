import type {
  CacheService,
  CacheSyncProgressCallback,
  SyncRecordIssue,
  V3InventoryClient,
} from '@salesbinder/sdk';
import { V3InventoryIndexerService } from '@salesbinder/sdk';

export interface CompatibilityInventorySyncResult {
  mode: 'compatibility_snapshot';
  status: 'success' | 'success_with_warnings';
  itemsProcessed: number;
  stockRowsProcessed: number;
  recordIssues: SyncRecordIssue[];
}

/** Preserve the pre-change-feed V3 snapshot path for unbound caches. */
export async function runCompatibilityInventorySync(input: {
  client: V3InventoryClient;
  cache: CacheService;
  accountName: string;
  accountIdentity: string;
  onProgressEvent?: CacheSyncProgressCallback;
  onProgressHeartbeat?: () => void;
}): Promise<CompatibilityInventorySyncResult> {
  const result = await new V3InventoryIndexerService(
    input.client,
    input.cache,
    input.accountName,
    input.accountIdentity
  ).sync({
    onProgressEvent: input.onProgressEvent,
    onProgressHeartbeat: input.onProgressHeartbeat,
  });
  return {
    mode: 'compatibility_snapshot',
    status: result.recordIssues.length > 0 ? 'success_with_warnings' : 'success',
    ...result,
  };
}
