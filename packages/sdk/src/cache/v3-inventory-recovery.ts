import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { SyncRecordIssue, SyncRecordIssueCode } from './sync-record-issue.types.js';
import type { InventorySnapshot, ItemRow, ItemStockLocationRow } from './types.js';
import { CACHE_SCHEMA_VERSION, createInventorySnapshotFingerprint } from './types.js';
import { assertCanonicalV3SourceId, compareSourceIds } from './v3-inventory-source-validation.js';

export interface LocalIssueReason {
  code: SyncRecordIssueCode;
  message: string;
}

export function classifyInventoryLocalFailure(
  error: unknown,
  defaultScope: 'record' | 'variations'
): LocalIssueReason | null {
  if (axios.isAxiosError(error) && error.response?.status === 404) return notFoundReason();
  if (!(error instanceof ApiResponseValidationError)) return null;
  if (error.sourceScope === 'identity') return null;
  return (error.sourceScope ?? defaultScope) === 'variations'
    ? invalidVariationsReason()
    : invalidRecordReason();
}

export function invalidRecordReason(): LocalIssueReason {
  return { code: 'invalid_record', message: 'Item failed source validation' };
}

export function invalidVariationsReason(): LocalIssueReason {
  return { code: 'invalid_variations', message: 'Item variations failed source validation' };
}

export function contentChangedReason(): LocalIssueReason {
  return { code: 'content_changed', message: 'Item changed during snapshot verification' };
}

export function buildInventoryWarningResults(
  unresolved: Map<string, LocalIssueReason>,
  priorSnapshot: InventorySnapshot | null,
  categoryNames: Map<string, string> | null
): {
  preserved: { items: ItemRow[]; stockRows: ItemStockLocationRow[] };
  issues: SyncRecordIssue[];
  omittedCount: number;
} {
  const priorItems = new Map<string, ItemRow>();
  const priorStockRows = new Map<string, ItemStockLocationRow[]>();
  if (priorSnapshot) {
    for (const item of priorSnapshot.items) {
      if (priorItems.has(item.item_id))
        throw new Error('Authoritative inventory snapshot has duplicate item IDs');
      priorItems.set(item.item_id, item);
    }
    for (const row of priorSnapshot.stockRows) {
      const group = priorStockRows.get(row.item_id) ?? [];
      group.push(row);
      priorStockRows.set(row.item_id, group);
    }
  }

  const preservedItems: ItemRow[] = [];
  const preservedStockRows: ItemStockLocationRow[] = [];
  const issues: SyncRecordIssue[] = [];
  let omittedCount = 0;
  for (const id of [...unresolved.keys()].sort(compareSourceIds)) {
    const reason = unresolved.get(id);
    if (!reason) throw new Error('Inventory recovery result was incomplete');
    const priorItem = priorItems.get(id);
    const outcome = priorItem ? 'preserved_last_known_good' : 'omitted_new';
    if (priorItem) {
      const categoryName = categoryNames
        ? priorItem.category_id
          ? (categoryNames.get(priorItem.category_id) ?? null)
          : null
        : (priorItem.category_name ?? null);
      preservedItems.push({ ...priorItem, category_name: categoryName });
      preservedStockRows.push(
        ...(priorStockRows.get(id) ?? []).map((row) => ({
          ...row,
          category_name: categoryName,
        }))
      );
    } else {
      omittedCount++;
    }
    issues.push({
      resource: 'item',
      id,
      code: reason.code,
      message: reason.message,
      attempts: 2,
      outcome,
    });
  }
  return {
    preserved: { items: preservedItems, stockRows: preservedStockRows },
    issues,
    omittedCount,
  };
}

export function assertInventoryCandidateIntegrity(
  items: ItemRow[],
  stockRows: ItemStockLocationRow[]
): void {
  const itemIds = new Set<string>();
  for (const item of items) {
    assertCanonicalV3SourceId(item.item_id, 'candidate item');
    if (itemIds.has(item.item_id)) throw new Error('Inventory candidate has duplicate item IDs');
    itemIds.add(item.item_id);
  }
  const stockIds = new Set<string>();
  const stockItemIds = new Set<string>();
  for (const row of stockRows) {
    if (!itemIds.has(row.item_id))
      throw new Error('Inventory candidate stock row has no parent item');
    if (!row.stock_row_id || stockIds.has(row.stock_row_id)) {
      throw new Error('Inventory candidate has duplicate or missing stock row IDs');
    }
    stockIds.add(row.stock_row_id);
    stockItemIds.add(row.item_id);
  }
  for (const itemId of itemIds) {
    if (!stockItemIds.has(itemId)) {
      throw new Error('Inventory candidate item has no stock rows');
    }
  }
}

export function createInventorySnapshot(
  accountIdentity: string,
  startedAt: number,
  completedAt: number,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[],
  freshItemCount: number,
  preservedItemCount: number,
  omittedItemCount: number,
  issues: SyncRecordIssue[],
  priorSnapshot: InventorySnapshot | null
): InventorySnapshot {
  const generation = randomUUID();
  const clean = issues.length === 0;
  const lastCompleteAt = clean
    ? completedAt
    : priorSnapshot?.meta.version === 2
      ? priorSnapshot.meta.lastCompleteAt
      : (priorSnapshot?.meta.completedAt ?? null);
  return {
    items,
    stockRows,
    meta: {
      version: 2,
      status: clean ? 'complete' : 'complete_with_warnings',
      accountIdentity,
      startedAt,
      completedAt,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      freshItemCount,
      preservedItemCount,
      omittedItemCount,
      warningCount: issues.length,
      lastCompleteAt,
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceApiVersion: '3',
      generation,
      fingerprint: createInventorySnapshotFingerprint(
        accountIdentity,
        generation,
        items,
        stockRows
      ),
    },
  };
}

function notFoundReason(): LocalIssueReason {
  return { code: 'not_found', message: 'Item unavailable during refresh' };
}
