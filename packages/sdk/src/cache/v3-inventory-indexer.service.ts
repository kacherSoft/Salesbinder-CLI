import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';
import type { NormalizedV3InventoryItem } from './v3-inventory-normalizer.js';
import {
  observeV3InventorySnapshotItem,
  type V3ItemHydrationObservation,
} from './v3-exact-item-hydrator.service.js';
import {
  fetchAllV3PageSnapshot,
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
  type LocalIssueReason,
} from './v3-inventory-recovery.js';
import {
  assertCanonicalV3SourceId,
  compareSourceIds,
  sameSourceIdArray,
} from './v3-inventory-source-validation.js';

const PAGE_LIMIT = 100;
const SNAPSHOT_MAX_ATTEMPTS = 3;
const SNAPSHOT_RETRY_DELAY_MS = 2_000;
const STABILITY_HEARTBEAT_INTERVAL_MS = 45_000;
const INTRA_ROOT_PAGINATION_DRIFT_MESSAGE = 'V3 items pagination changed during snapshot';
const ITEM_MEMBERSHIP_DRIFT_MESSAGE = 'V3 item membership changed during stability verification';
const ROOT_PAGINATION_DRIFT_MESSAGE =
  'V3 item root pagination changed during stability verification';
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
  onProgressHeartbeat?: () => void;
}

export interface V3InventorySyncResult {
  itemsProcessed: number;
  stockRowsProcessed: number;
  recordIssues: SyncRecordIssue[];
}

type ItemObservation = V3ItemHydrationObservation;

interface RootPass {
  items: V3Item[];
  ids: string[];
  paginationSignature: V3PaginationSignature;
}

interface RootSnapshotRead {
  root: RootPass;
  progressEvents: CacheSyncProgress[];
}

interface SourcePass {
  ids: string[];
  observations: Map<string, ItemObservation>;
}

class RootSnapshotDriftError extends Error {}

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

    const { firstPass, secondPass } = await this.readStablePassPair(
      categoryNames,
      options.onProgressEvent,
      options.onProgressHeartbeat
    );
    const fresh = new Map<string, NormalizedV3InventoryItem>();
    const recovery = new Map<string, LocalIssueReason>();

    for (const id of firstPass.ids) {
      const first = firstPass.observations.get(id);
      const second = secondPass.observations.get(id);
      if (!first || !second) {
        throw new Error(ITEM_MEMBERSHIP_DRIFT_MESSAGE);
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

  private async readStablePassPair(
    categoryNames: Map<string, string> | null,
    onProgressEvent?: CacheSyncProgressCallback,
    onProgressHeartbeat?: () => void
  ): Promise<{ firstPass: SourcePass; secondPass: SourcePass }> {
    const heartbeat = startStabilityHeartbeat(onProgressHeartbeat);
    try {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt++) {
        try {
          // A silent preflight rejects immediately unstable roots without spending
          // requests on variations or exposing a pass that can never complete.
          const { root: preflightRoot } = await this.readRootSnapshot();
          const firstRootRead = await this.readRootSnapshot(1);
          assertSameRootSnapshot(preflightRoot, firstRootRead.root);
          replayProgressEvents(firstRootRead.progressEvents, onProgressEvent);
          const firstPass = await this.observePass(
            1,
            firstRootRead.root,
            categoryNames,
            onProgressEvent
          );

          // Read and validate the next root after observing pass 1. This catches
          // changes that occurred while its variation snapshots were hydrated.
          const secondRootRead = await this.readRootSnapshot(2);
          assertSameRootSnapshot(firstRootRead.root, secondRootRead.root);
          replayProgressEvents(secondRootRead.progressEvents, onProgressEvent);
          const secondPass = await this.observePass(
            2,
            secondRootRead.root,
            categoryNames,
            onProgressEvent
          );
          return { firstPass, secondPass };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!(lastError instanceof RootSnapshotDriftError) || attempt === SNAPSHOT_MAX_ATTEMPTS) {
            throw lastError;
          }
          await sleep(SNAPSHOT_RETRY_DELAY_MS * attempt);
        }
      }
      throw lastError ?? new Error('Unable to verify a stable v3 item root snapshot');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async readRootSnapshot(pass?: number): Promise<RootSnapshotRead> {
    const progressEvents: CacheSyncProgress[] = [];
    const bufferProgressEvent: CacheSyncProgressCallback | undefined =
      pass === undefined
        ? undefined
        : (event) => {
            progressEvents.push(event);
          };
    if (pass !== undefined) {
      this.emit(bufferProgressEvent, {
        event: 'pass_started',
        pass,
        recordsProcessed: 0,
        recordsTotal: null,
        indeterminate: true,
      });
    }
    const source = await this.fetchAllItems(pass, bufferProgressEvent);
    const items = source.rows;
    const ids = items.map((item) => item.id).sort(compareSourceIds);
    return {
      root: { items, ids, paginationSignature: source.signature },
      progressEvents,
    };
  }

  private async observePass(
    pass: number,
    root: RootPass,
    categoryNames: Map<string, string> | null,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<SourcePass> {
    const observations = new Map<string, ItemObservation>();
    let recordsProcessed = 0;
    for (const item of root.items) {
      observations.set(
        item.id,
        await observeV3InventorySnapshotItem(this.client, item, categoryNames)
      );
      recordsProcessed++;
      this.emit(onProgressEvent, {
        event: 'record_processed',
        pass,
        recordsProcessed,
        recordsTotal: root.items.length,
        indeterminate: false,
      });
    }
    this.emit(onProgressEvent, {
      event: 'pass_completed',
      pass,
      recordsProcessed,
      recordsTotal: root.items.length,
      indeterminate: false,
    });
    return {
      ids: root.ids,
      observations,
    };
  }

  private requireInventorySnapshotReader(): NonNullable<CacheService['getInventorySnapshot']> {
    const reader = this.cache.getInventorySnapshot;
    if (typeof reader !== 'function') throw new Error(INVENTORY_SNAPSHOT_READ_CAPABILITY_ERROR);
    return reader.bind(this.cache);
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
      if (failure) return { failure };
      throw error;
    }
    assertCanonicalV3SourceId(item.id, 'item detail');
    if (item.id !== id) {
      throw new Error('V3 item detail identity did not match the requested item');
    }
    return observeV3InventorySnapshotItem(this.client, item, categoryNames);
  }

  private fetchAllItems(
    pass?: number,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<V3PageSnapshot<V3Item>> {
    return fetchAllV3PageSnapshot(
      (page) => this.client.items.list({ page, limit: PAGE_LIMIT, archived: 'all' }),
      'items',
      rootSnapshotError,
      pass === undefined
        ? undefined
        : {
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

  private emit(
    onProgressEvent: CacheSyncProgressCallback | undefined,
    progress: InventoryProgress
  ): void {
    onProgressEvent?.({ phase: 'inventory', apiVersion: '3', ...progress });
  }
}

function assertSameRootSnapshot(left: RootPass, right: RootPass): void {
  if (!sameSourceIdArray(left.ids, right.ids)) {
    throw new RootSnapshotDriftError(ITEM_MEMBERSHIP_DRIFT_MESSAGE);
  }
  if (!sameV3PaginationSignature(left.paginationSignature, right.paginationSignature)) {
    throw new RootSnapshotDriftError(ROOT_PAGINATION_DRIFT_MESSAGE);
  }
}

function rootSnapshotError(message: string): Error {
  return message === INTRA_ROOT_PAGINATION_DRIFT_MESSAGE
    ? new RootSnapshotDriftError(message)
    : new Error(message);
}

function replayProgressEvents(
  progressEvents: readonly CacheSyncProgress[],
  onProgressEvent?: CacheSyncProgressCallback
): void {
  if (!onProgressEvent) return;
  for (const event of progressEvents) onProgressEvent(event);
}

function startStabilityHeartbeat(onProgressHeartbeat?: () => void): NodeJS.Timeout | undefined {
  if (!onProgressHeartbeat) return undefined;
  const heartbeat = setInterval(() => {
    try {
      onProgressHeartbeat();
    } catch {
      // Heartbeats are best-effort and must never change the stability result.
    }
  }, STABILITY_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  return heartbeat;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
