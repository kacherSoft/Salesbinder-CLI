import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';
import {
  normalizeV3InventoryItem,
  type NormalizedV3InventoryItem,
} from './v3-inventory-normalizer.js';
import {
  fetchAllV3PageSnapshot,
  fetchAllV3Pages,
  sameV3PaginationSignature,
  type V3PageSnapshot,
  type V3PaginationSignature,
} from './v3-inventory-pagination.js';
import {
  assertInventoryCandidateIntegrity,
  buildInventoryWarningResults,
  classifyInventoryLocalFailure,
  contentChangedReason,
  createInventorySnapshot,
  invalidRecordReason,
  invalidVariationsReason,
  type LocalIssueReason,
} from './v3-inventory-recovery.js';
import {
  assertCanonicalV3SourceId,
  compareSourceIds,
  createV3ItemSourceFingerprint,
  sameSourceIdArray,
} from './v3-inventory-source-validation.js';

const PAGE_LIMIT = 100;
const INVENTORY_SNAPSHOT_READ_CAPABILITY_ERROR =
  'V3 inventory sync requires inventory snapshot read support.';

export interface V3InventoryClient {
  items: {
    list(params: { page: number; limit: number; archived: 'all' }): Promise<V3ListResponse<V3Item>>;
    get(itemId: string): Promise<V3Item>;
    listVariations(
      itemId: string,
      params: { page: number; limit: number; include: 'locations' }
    ): Promise<V3ListResponse<V3ItemVariation>>;
  };
}

export interface V3InventorySyncOptions {
  onProgressEvent?: CacheSyncProgressCallback;
}

export interface V3InventorySyncResult {
  itemsProcessed: number;
  stockRowsProcessed: number;
  recordIssues: SyncRecordIssue[];
}

interface ItemObservation {
  item: V3Item;
  normalized?: NormalizedV3InventoryItem;
  fingerprint?: string;
  failure?: LocalIssueReason;
}

interface SourcePass {
  ids: string[];
  observations: Map<string, ItemObservation>;
  paginationSignature: V3PaginationSignature;
}

type InventoryProgress = Omit<CacheSyncProgress, 'phase' | 'apiVersion'>;

export class V3InventoryIndexerService {
  constructor(
    private readonly client: V3InventoryClient,
    private readonly cache: CacheService,
    _accountName: string,
    private readonly accountIdentity: string
  ) {}

  async sync(options: V3InventorySyncOptions = {}): Promise<V3InventorySyncResult> {
    const getInventorySnapshot = this.requireInventorySnapshotReader();
    const state = await this.cache.getCacheState();
    if (state?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(
        `V3 inventory sync requires cache state schema version ${CACHE_SCHEMA_VERSION}`
      );
    }
    this.emit(options.onProgressEvent, {
      event: 'phase_started',
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });

    const startedAt = nowSeconds();
    const priorSnapshot = await getInventorySnapshot();
    const categorySnapshot = await this.cache.getCategorySnapshot();
    const categoryNames = categorySnapshot
      ? new Map(categorySnapshot.rows.map((row) => [row.category_id, row.name]))
      : null;

    const firstPass = await this.readPass(1, categoryNames, options.onProgressEvent);
    const secondPass = await this.readPass(
      2,
      categoryNames,
      options.onProgressEvent,
      firstPass.ids
    );
    if (!sameV3PaginationSignature(firstPass.paginationSignature, secondPass.paginationSignature)) {
      throw new Error('V3 item root pagination changed during stability verification');
    }
    const fresh = new Map<string, NormalizedV3InventoryItem>();
    const recovery = new Map<string, LocalIssueReason>();

    for (const id of firstPass.ids) {
      const first = firstPass.observations.get(id);
      const second = secondPass.observations.get(id);
      if (!first || !second) {
        throw new Error('V3 item membership changed during stability verification');
      }
      const failure = second.failure ?? first.failure;
      if (failure) {
        recovery.set(id, failure);
      } else if (first.fingerprint !== second.fingerprint) {
        recovery.set(id, contentChangedReason());
      } else if (second.normalized) {
        fresh.set(id, second.normalized);
      } else {
        throw new Error('V3 item observation was incomplete after stability verification');
      }
    }

    const recoveryIds = [...recovery.keys()].sort(compareSourceIds);
    for (let index = 0; index < recoveryIds.length; index++) {
      this.emit(options.onProgressEvent, {
        event: 'record_failed_collected',
        pass: 2,
        recordsProcessed: fresh.size + index + 1,
        recordsTotal: firstPass.ids.length,
        indeterminate: false,
      });
    }

    const unresolved = new Map<string, LocalIssueReason>();
    if (recoveryIds.length > 0) {
      this.emit(options.onProgressEvent, {
        event: 'retry_pass_started',
        pass: 3,
        recordsProcessed: 0,
        recordsTotal: recoveryIds.length,
        indeterminate: false,
      });
    }
    let retriesProcessed = 0;
    for (const id of recoveryIds) {
      const recovered = await this.recoverItem(id, categoryNames);
      retriesProcessed++;
      if (recovered.normalized) {
        fresh.set(id, recovered.normalized);
        this.emit(options.onProgressEvent, {
          event: 'record_retry_succeeded',
          pass: 3,
          recordsProcessed: retriesProcessed,
          recordsTotal: recoveryIds.length,
          indeterminate: false,
        });
      } else if (recovered.failure) {
        unresolved.set(id, recovered.failure);
        this.emit(options.onProgressEvent, {
          event: 'record_retry_failed',
          pass: 3,
          recordsProcessed: retriesProcessed,
          recordsTotal: recoveryIds.length,
          indeterminate: false,
        });
      } else {
        throw new Error('V3 item recovery returned an incomplete result');
      }
    }

    const { preserved, issues, omittedCount } = buildInventoryWarningResults(
      unresolved,
      priorSnapshot,
      categoryNames
    );
    const items = [...[...fresh.values()].map((entry) => entry.item), ...preserved.items].sort(
      (left, right) => compareSourceIds(left.item_id, right.item_id)
    );
    const stockRows = [
      ...[...fresh.values()].flatMap((entry) => entry.stockRows),
      ...preserved.stockRows,
    ].sort((left, right) => compareSourceIds(left.stock_row_id, right.stock_row_id));
    assertInventoryCandidateIntegrity(items, stockRows);

    const completedAt = nowSeconds();
    const snapshot = createInventorySnapshot(
      this.accountIdentity,
      startedAt,
      completedAt,
      items,
      stockRows,
      fresh.size,
      preserved.items.length,
      omittedCount,
      issues,
      priorSnapshot
    );
    await this.cache.replaceInventorySnapshot(snapshot);
    this.emit(options.onProgressEvent, {
      event: 'phase_completed',
      recordsProcessed: items.length,
      recordsTotal: items.length,
      indeterminate: false,
    });
    return {
      itemsProcessed: items.length,
      stockRowsProcessed: stockRows.length,
      recordIssues: issues,
    };
  }

  private async readPass(
    pass: number,
    categoryNames: Map<string, string> | null,
    onProgressEvent?: CacheSyncProgressCallback,
    expectedIds?: string[]
  ): Promise<SourcePass> {
    this.emit(onProgressEvent, {
      event: 'pass_started',
      pass,
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    const source = await this.fetchAllItems(pass, onProgressEvent);
    const items = source.rows;
    const ids = items.map((item) => item.id).sort(compareSourceIds);
    if (expectedIds && !sameSourceIdArray(ids, expectedIds)) {
      throw new Error('V3 item membership changed during stability verification');
    }

    const observations = new Map<string, ItemObservation>();
    let recordsProcessed = 0;
    for (const item of items) {
      observations.set(item.id, await this.observeItem(item, categoryNames));
      recordsProcessed++;
      this.emit(onProgressEvent, {
        event: 'record_processed',
        pass,
        recordsProcessed,
        recordsTotal: items.length,
        indeterminate: false,
      });
    }
    this.emit(onProgressEvent, {
      event: 'pass_completed',
      pass,
      recordsProcessed,
      recordsTotal: items.length,
      indeterminate: false,
    });
    return { ids, observations, paginationSignature: source.signature };
  }

  private requireInventorySnapshotReader(): NonNullable<CacheService['getInventorySnapshot']> {
    const reader = this.cache.getInventorySnapshot;
    if (typeof reader !== 'function') throw new Error(INVENTORY_SNAPSHOT_READ_CAPABILITY_ERROR);
    return reader.bind(this.cache);
  }

  private async observeItem(
    item: V3Item,
    categoryNames: Map<string, string> | null
  ): Promise<ItemObservation> {
    if (!Number.isSafeInteger(item.variation_count) || item.variation_count < 0) {
      return { item, failure: invalidRecordReason() };
    }

    let variations: V3ItemVariation[];
    try {
      variations = item.variation_count > 0 ? await this.fetchAllVariations(item) : [];
    } catch (error) {
      const failure = classifyInventoryLocalFailure(error, 'variations');
      if (failure) return { item, failure };
      throw error;
    }
    if (variations.length !== item.variation_count) {
      return { item, failure: invalidVariationsReason() };
    }

    try {
      return {
        item,
        normalized: normalizeV3InventoryItem(item, variations, categoryNames),
        fingerprint: createV3ItemSourceFingerprint(item, variations),
      };
    } catch (error) {
      const failure = classifyInventoryLocalFailure(error, 'record');
      if (failure) return { item, failure };
      throw error;
    }
  }

  private async recoverItem(
    id: string,
    categoryNames: Map<string, string> | null
  ): Promise<ItemObservation> {
    let item: V3Item;
    try {
      item = await this.client.items.get(id);
    } catch (error) {
      const failure = classifyInventoryLocalFailure(error, 'record');
      if (failure) return { item: { id } as V3Item, failure };
      throw error;
    }
    assertCanonicalV3SourceId(item.id, 'item detail');
    if (item.id !== id) {
      throw new Error('V3 item detail identity did not match the requested item');
    }
    return this.observeItem(item, categoryNames);
  }

  private fetchAllItems(
    pass: number,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<V3PageSnapshot<V3Item>> {
    return fetchAllV3PageSnapshot(
      (page) => this.client.items.list({ page, limit: PAGE_LIMIT, archived: 'all' }),
      'items',
      (message) => new Error(message),
      {
        onPageStarted: (page, pagesTotal, recordsProcessed, recordsTotal) =>
          this.emit(onProgressEvent, {
            event: 'page_started',
            pass,
            page,
            pagesTotal,
            recordsProcessed,
            recordsTotal,
            indeterminate: recordsTotal == null,
          }),
        onPageCompleted: (page, pagesTotal, recordsProcessed, recordsTotal) =>
          this.emit(onProgressEvent, {
            event: 'page_completed',
            pass,
            page,
            pagesTotal,
            recordsProcessed,
            recordsTotal,
            indeterminate: false,
          }),
      }
    );
  }

  private fetchAllVariations(item: V3Item): Promise<V3ItemVariation[]> {
    return fetchAllV3Pages(
      (page) =>
        this.client.items.listVariations(item.id, {
          page,
          limit: PAGE_LIMIT,
          include: 'locations',
        }),
      `variations for item ${item.id}`,
      (message) => new ApiResponseValidationError(message, 'variations')
    );
  }

  private emit(
    onProgressEvent: CacheSyncProgressCallback | undefined,
    progress: InventoryProgress
  ): void {
    onProgressEvent?.({ phase: 'inventory', apiVersion: '3', ...progress });
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
