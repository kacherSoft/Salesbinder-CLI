import type {
  ChangeFeedHydrationOutcome,
  ClaimedChangeFeedEvent,
  VerifiedCacheReceipt,
} from '../change-feed/change-feed.types.js';
import axios from 'axios';
import type {
  InventoryChangeFeedBinding,
  InventoryChangeFeedState,
  InventoryEventReceipt,
  InventoryEventReceiptInput,
} from './types.js';
import { createInventoryEventReceiptId } from './types.js';
import type { InventoryChangeFeedCache } from './change-feed-cache.interface.js';
import {
  hydrateV3InventoryItem,
  type V3ExactItemHydrationResult,
  type V3ExactItemHydratorService,
} from './v3-exact-item-hydrator.service.js';
import type { InventoryChangeFeedLeaseRenewal } from './inventory-change-feed-lease-renewal.js';

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

export interface V3DirectItemReadPort {
  items: {
    get(id: string): Promise<V3Item>;
    listVariations(
      id: string,
      params: { page: number; limit: number; include: 'locations' }
    ): Promise<V3ListResponse<V3ItemVariation>>;
  };
}

export interface InventoryChangeFeedSyncIssue {
  itemId: string | null;
  eventSeq: string | null;
  code:
    | 'missing_unproven'
    | 'invalid_record'
    | 'invalid_variations'
    | 'not_found'
    | 'content_changed'
    | 'target_not_reached';
  message: string;
  outcome: 'retry' | 'dead_letter' | 'blocked';
}

export interface InventoryChangeFeedItemGroup {
  objectId: string;
  events: ClaimedChangeFeedEvent[];
  newestEvent: ClaimedChangeFeedEvent;
  maxEventSeq: string;
}

export function coalesceInventoryEvents(
  events: readonly ClaimedChangeFeedEvent[]
): InventoryChangeFeedItemGroup[] {
  const grouped = new Map<string, ClaimedChangeFeedEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.objectId) ?? [];
    group.push(event);
    grouped.set(event.objectId, group);
  }
  return [...grouped.entries()]
    .map(([objectId, group]) => {
      group.sort(compareClaimedEvents);
      const newestEvent = group.at(-1);
      if (!newestEvent) throw new Error('Inventory change-feed group is unexpectedly empty');
      return { objectId, events: group, newestEvent, maxEventSeq: newestEvent.eventSeq };
    })
    .sort((left, right) => compareEventSequences(left.maxEventSeq, right.maxEventSeq));
}

export function chunkInventoryGroups(
  groups: readonly InventoryChangeFeedItemGroup[],
  limit = 50
): InventoryChangeFeedItemGroup[][] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('Inventory hydration batch limit must be between 1 and 50');
  }
  const chunks: InventoryChangeFeedItemGroup[][] = [];
  for (let offset = 0; offset < groups.length; offset += limit) {
    chunks.push(groups.slice(offset, offset + limit));
  }
  return chunks;
}

export function toReceiptInputs(group: InventoryChangeFeedItemGroup): InventoryEventReceiptInput[] {
  return group.events.map(({ eventSeq, eventType, objectId }) => ({
    eventSeq,
    eventType,
    objectId,
  }));
}

export function verifyInventoryReceipt(
  receipt: InventoryEventReceipt,
  event: ClaimedChangeFeedEvent,
  binding: InventoryChangeFeedBinding,
  cacheGeneration: string
): VerifiedCacheReceipt {
  const bindingMatches =
    receipt.accountIdentity === binding.accountIdentity &&
    receipt.ledgerDatabaseId.toLowerCase() === binding.ledgerDatabaseId.toLowerCase() &&
    receipt.consumerName === binding.consumerName;
  const materializationMatches =
    (receipt.appliedAction === 'upsert' &&
      receipt.materializationOutcome === 'upserted' &&
      receipt.sourceFingerprint !== null) ||
    (receipt.appliedAction === 'tombstone' &&
      receipt.materializationOutcome === 'tombstoned' &&
      receipt.sourceFingerprint === null) ||
    (receipt.appliedAction === 'fenced_noop' &&
      receipt.materializationOutcome === 'superseded' &&
      receipt.sourceFingerprint === null);
  if (
    !bindingMatches ||
    receipt.eventSeq !== event.eventSeq ||
    receipt.eventType !== event.eventType ||
    receipt.objectId !== event.objectId ||
    receipt.cacheGeneration !== cacheGeneration ||
    receipt.receiptId !== createInventoryEventReceiptId(binding, event.eventSeq) ||
    !materializationMatches ||
    !isHydrationOutcome(receipt.hydrationOutcome) ||
    !Number.isSafeInteger(receipt.committedAt) ||
    receipt.committedAt < 0
  ) {
    throw new Error('Inventory receipt readback did not match the claimed event');
  }
  return {
    receiptId: receipt.receiptId,
    cacheGeneration: receipt.cacheGeneration,
    committedAt: new Date(receipt.committedAt * 1_000),
    hydrationOutcome: receipt.hydrationOutcome,
    receiptVerified: true,
  };
}

export function compareClaimedEvents(
  left: ClaimedChangeFeedEvent,
  right: ClaimedChangeFeedEvent
): number {
  return compareEventSequences(left.eventSeq, right.eventSeq);
}

export function compareEventSequences(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function maxEventSequence(left: string | null, right: string): string {
  return left === null || compareEventSequences(left, right) < 0 ? right : left;
}

export interface InventoryGroupProcessorDependencies {
  binding: InventoryChangeFeedBinding;
  cache: InventoryChangeFeedCache;
  hydrator: Pick<V3ExactItemHydratorService, 'hydrate'>;
  directItemReader: V3DirectItemReadPort;
  categoryNames?: Map<string, string> | null;
  generation: string;
  maxAttempts: number;
  now: () => number;
  critical<T>(operation: (operationSignal?: AbortSignal) => Promise<T>): Promise<T>;
  complete(event: ClaimedChangeFeedEvent, receipt: VerifiedCacheReceipt): Promise<void>;
  fail(
    event: ClaimedChangeFeedEvent,
    reason: { code: string; message: string }
  ): Promise<'retry' | 'dead_letter'>;
  onApplied(eventCount: number): void;
}

export interface InventoryGroupProcessingResult {
  completed: number;
  failed: number;
  items: number;
  stockRows: number;
  highestAppliedEventSeq: string | null;
  issues: InventoryChangeFeedSyncIssue[];
}

export async function processInventoryGroups(
  groups: InventoryChangeFeedItemGroup[],
  state: InventoryChangeFeedState,
  renewal: InventoryChangeFeedLeaseRenewal,
  dependencies: InventoryGroupProcessorDependencies
): Promise<InventoryGroupProcessingResult> {
  const summary: InventoryGroupProcessingResult = {
    completed: 0,
    failed: 0,
    items: 0,
    stockRows: 0,
    highestAppliedEventSeq: state.highestAppliedEventSeq,
    issues: [],
  };
  for (const chunk of chunkInventoryGroups(groups)) {
    await renewal.checkpoint();
    const results = await dependencies.hydrator.hydrate(
      chunk.map((group) => group.objectId),
      { categoryNames: dependencies.categoryNames }
    );
    const byId = exactHydrationMap(results, chunk);
    for (const group of chunk) {
      let result = byId.get(group.objectId);
      if (!result) throw new Error('Exact V3 hydration omitted a requested item result');
      if (
        result.status === 'missing_unproven' &&
        group.newestEvent.eventType === 'inventory.item_deleted'
      ) {
        result = await confirmDeletedItem(group.objectId, renewal, dependencies);
      }
      if (result.status === 'local_failure' || result.status === 'missing_unproven') {
        if (
          result.status === 'missing_unproven' &&
          group.newestEvent.eventType === 'inventory.item_deleted'
        ) {
          await applyTombstone(group, summary, dependencies);
        } else {
          await failGroup(group, result, summary, dependencies);
        }
      } else {
        await applyBundle(group, result, summary, dependencies);
      }
      summary.items++;
    }
  }
  return summary;
}

async function confirmDeletedItem(
  itemId: string,
  renewal: InventoryChangeFeedLeaseRenewal,
  dependencies: InventoryGroupProcessorDependencies
): Promise<V3ExactItemHydrationResult> {
  await renewal.checkpoint();
  let item: V3Item;
  try {
    item = await dependencies.directItemReader.items.get(itemId);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return { id: itemId, status: 'missing_unproven' };
    }
    throw error;
  }
  if (item.id !== itemId) throw new Error('Direct V3 item read returned an unexpected identity');
  const observed = await hydrateV3InventoryItem(
    dependencies.directItemReader,
    item,
    dependencies.categoryNames ?? null
  );
  if (observed.failure) return { id: itemId, status: 'local_failure', failure: observed.failure };
  if (!observed.normalized || !observed.fingerprint) {
    throw new Error('Direct V3 item hydration returned an incomplete result');
  }
  return {
    id: itemId,
    status: item.archived ? 'found_archived' : 'found_current',
    bundle: observed.normalized,
    fingerprint: observed.fingerprint,
  };
}

async function applyBundle(
  group: InventoryChangeFeedItemGroup,
  result: Extract<V3ExactItemHydrationResult, { status: 'found_current' | 'found_archived' }>,
  summary: InventoryGroupProcessingResult,
  dependencies: InventoryGroupProcessorDependencies
): Promise<void> {
  const application = await dependencies.critical((operationSignal) =>
    dependencies.cache.applyInventoryItemBundle({
      ...dependencies.binding,
      cacheGeneration: dependencies.generation,
      item: result.bundle.item,
      stockRows: result.bundle.stockRows,
      events: toReceiptInputs(group),
      hydrationOutcome: result.status,
      expectedHighestAppliedEventSeq: summary.highestAppliedEventSeq,
      observedThroughEventSeq: group.maxEventSeq,
      committedAt: dependencies.now(),
      operationSignal: operationSignal ?? NEVER_ABORTED_SIGNAL,
    })
  );
  if (!application.duplicate && application.materialized) {
    summary.stockRows += result.bundle.stockRows.length;
  }
  await verifyAndComplete(group, result.status, summary, dependencies);
}

async function applyTombstone(
  group: InventoryChangeFeedItemGroup,
  summary: InventoryGroupProcessingResult,
  dependencies: InventoryGroupProcessorDependencies
): Promise<void> {
  const confirmedAt = dependencies.now();
  await dependencies.critical((operationSignal) =>
    dependencies.cache.applyInventoryTombstone({
      ...dependencies.binding,
      cacheGeneration: dependencies.generation,
      objectId: group.objectId,
      events: toReceiptInputs(group),
      proof: {
        deleteEventSeq: group.maxEventSeq,
        confirmation: 'v3_exact_404',
        confirmedMissingAt: confirmedAt,
      },
      expectedHighestAppliedEventSeq: summary.highestAppliedEventSeq,
      observedThroughEventSeq: group.maxEventSeq,
      committedAt: confirmedAt,
      operationSignal: operationSignal ?? NEVER_ABORTED_SIGNAL,
    })
  );
  await verifyAndComplete(group, 'expected_tombstone', summary, dependencies);
}

async function verifyAndComplete(
  group: InventoryChangeFeedItemGroup,
  expectedOutcome: ChangeFeedHydrationOutcome,
  summary: InventoryGroupProcessingResult,
  dependencies: InventoryGroupProcessorDependencies
): Promise<void> {
  const receipts = await dependencies.critical(() =>
    dependencies.cache.getInventoryEventReceipts(
      dependencies.binding,
      group.events.map((event) => event.eventSeq)
    )
  );
  if (receipts.length !== group.events.length) {
    throw new Error('Inventory receipt readback is incomplete');
  }
  const bySeq = new Map(receipts.map((receipt) => [receipt.eventSeq, receipt]));
  for (const event of group.events) {
    const receipt = bySeq.get(event.eventSeq);
    if (!receipt || receipt.hydrationOutcome !== expectedOutcome) {
      throw new Error('Inventory receipt readback has an unexpected hydration outcome');
    }
    await dependencies.complete(
      event,
      verifyInventoryReceipt(receipt, event, dependencies.binding, dependencies.generation)
    );
    summary.completed++;
  }
  summary.highestAppliedEventSeq = maxEventSequence(
    summary.highestAppliedEventSeq,
    group.maxEventSeq
  );
  dependencies.onApplied(group.events.length);
}

async function failGroup(
  group: InventoryChangeFeedItemGroup,
  result: Extract<V3ExactItemHydrationResult, { status: 'local_failure' | 'missing_unproven' }>,
  summary: InventoryGroupProcessingResult,
  dependencies: InventoryGroupProcessorDependencies
): Promise<void> {
  const reason =
    result.status === 'local_failure'
      ? result.failure
      : { code: 'missing_unproven' as const, message: 'Item was omitted by exact V3 hydration' };
  let outcome: 'retry' | 'dead_letter' = 'retry';
  for (const event of group.events) {
    if ((await dependencies.fail(event, reason)) === 'dead_letter') outcome = 'dead_letter';
    summary.failed++;
  }
  summary.issues.push({
    itemId: group.objectId,
    eventSeq: group.maxEventSeq,
    code: reason.code,
    message: reason.message,
    outcome,
  });
}

function exactHydrationMap(
  results: V3ExactItemHydrationResult[],
  groups: InventoryChangeFeedItemGroup[]
): Map<string, V3ExactItemHydrationResult> {
  const expected = new Set(groups.map((group) => group.objectId));
  const mapped = new Map<string, V3ExactItemHydrationResult>();
  for (const result of results) {
    if (!expected.has(result.id) || mapped.has(result.id)) {
      throw new Error('Exact V3 hydration returned invalid identities');
    }
    mapped.set(result.id, result);
  }
  if (mapped.size !== groups.length) {
    throw new Error('Exact V3 hydration returned an incomplete item set');
  }
  return mapped;
}

function isHydrationOutcome(value: string): value is ChangeFeedHydrationOutcome {
  return value === 'found_current' || value === 'found_archived' || value === 'expected_tombstone';
}
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
