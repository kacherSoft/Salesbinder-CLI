/**
 * Cache types for SQLite document caching
 */

import { createHash } from 'node:crypto';
import type {
  CacheSyncPhase,
  CacheSyncProgress,
  CacheSyncProgressCallback,
} from './cache-sync-progress.types.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';

/** Database schema row for documents table */
export interface DocumentRow {
  doc_id: string;
  context_id: number; // 4=Estimate, 5=Invoice, 11=PO
  doc_number: number;
  issue_date: string; // YYYY-MM-DD
  customer_id: string;
  modified: number; // Unix timestamp
  api_doc_id?: string | null;
  cache_source?: 'api' | 'csv';
  document_name?: string | null;
  custom_doc_number?: string | null;
  account_id?: string | null;
  account_context_id?: number | null;
  account_name?: string | null;
  account_number?: number | null;
  user_id?: string | null;
  salesperson_name?: string | null;
  customer_name?: string | null;
  customer_number?: number | null;
  supplier_name?: string | null;
  supplier_number?: number | null;
  status_id?: number | null;
  status_name?: string | null;
  total_price?: number | null;
  total_cost?: number | null;
  subtotal?: number | null;
  associated_document_id?: string | null;
  external_po_number?: string | null;
  shipping_location?: string | null;
  date_sent?: string | null;
  shipped_percent?: number | null;
  is_cancelled?: number;
  /** 0=active, 1=archived, null=not observable from the source. */
  archived?: 0 | 1 | null;
  imported_at?: number | null;
}

/** Database schema row for item_documents table */
export interface ItemDocumentRow {
  id?: number; // Auto-generated
  item_id: string;
  doc_id: string;
  quantity: number;
  price: number;
  document_item_id?: string | null;
  item_name?: string | null;
  item_number?: number | null;
  item_sku?: string | null;
  item_location?: string | null;
  line_description?: string | null;
  quantity_received?: number | null;
  quantity_shipped?: number | null;
  cost?: number | null;
  total_amount?: number | null;
  discounted_price?: number | null;
  discount_percent?: number | null;
}

/** Database schema row for SalesBinder accounts (customers/suppliers) */
export interface AccountRow {
  account_id: string;
  context_id: number; // 2=Customer, 8=Prospect, 10=Supplier
  account_number?: number | null;
  name: string;
  office_email?: string | null;
  office_phone?: string | null;
  office_fax?: string | null;
  url?: string | null;
  billing_address_1?: string | null;
  billing_address_2?: string | null;
  billing_city?: string | null;
  billing_region?: string | null;
  billing_postal_code?: string | null;
  billing_country?: string | null;
  shipping_address_1?: string | null;
  shipping_address_2?: string | null;
  shipping_city?: string | null;
  shipping_region?: string | null;
  shipping_postal_code?: string | null;
  shipping_country?: string | null;
  vat_number?: string | null;
  account_manager?: string | null;
  label_name?: string | null;
  archived?: number;
  last_invoiced?: string | null;
  created?: string | null;
  modified?: number | null;
  cache_source?: 'api' | 'csv';
  imported_at?: number | null;
}

/** Database schema row for cached item master data */
export interface ItemRow {
  item_id: string;
  item_number?: number | null;
  name: string;
  description?: string | null;
  sku?: string | null;
  serial_number?: string | null;
  barcode?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  quantity?: number | null;
  quantity_reserved?: number | null;
  quantity_available?: number | null;
  quantity_incoming?: number | null;
  in_transit?: number | null;
  threshold?: number | null;
  cost?: number | null;
  price?: number | null;
  valuation?: number | null;
  published?: number | null;
  /** 0=active, 1=archived, null=not observable from the source. */
  archived?: 0 | 1 | null;
  created?: string | null;
  modified?: number | null;
  cache_source?: 'api' | 'csv';
  source_api_version?: ApiSourceVersion | null;
  imported_at?: number | null;
}

/** Database schema row for item variation/location stock data */
export interface ItemStockLocationRow {
  stock_row_id: string;
  item_id: string;
  item_number?: number | null;
  variation_id?: string | null;
  variation_location_id?: string | null;
  location_id?: string | null;
  location_name?: string | null;
  category_name?: string | null;
  quantity_on_hand: number;
  quantity_reserved: number | null;
  quantity_available: number | null;
  quantity_incoming: number | null;
  in_transit: number | null;
  price?: number | null;
  cost?: number | null;
  valuation?: number | null;
  barcode?: string | null;
  cache_source?: 'api' | 'csv';
  source_api_version?: ApiSourceVersion | null;
  imported_at?: number | null;
}

export type ApiSourceVersion = '2.0' | '3';

/** Database schema row for cache_meta table */
export interface CacheMetaRow {
  key: string;
  value: string;
}

/** Authoritative snapshot metadata keys shared by both cache backends. */
export const CATEGORY_SNAPSHOT_META_KEY = 'category_cache.v7.snapshot';
export const CATEGORY_GENERATION_META_KEY = 'category_cache.v7.generation';
export const INVENTORY_SNAPSHOT_META_KEY = 'inventory_cache.v7.snapshot';
export const INVENTORY_ACCOUNT_META_KEY = 'inventory_cache.v7.account_identity';

/** Conservative API bounds used before category pagination allocates or loops. */
export const MAX_CATEGORY_PAGES = 10_000;
export const MAX_CATEGORY_COUNT = 1_000_000;

/** Database schema row for cached category master data. */
export interface CategoryCacheRow {
  category_id: string;
  name: string;
  item_count: number | null;
  parent_id: string | null;
  parent_name: string | null;
  inventory_type: 'quantity' | 'unique' | null;
  custom_fields_json: string | null;
  created: string | null;
  modified: number | null;
  cache_source: 'api';
  source_api_version: ApiSourceVersion;
  imported_at: number;
}

/** Sole typed value stored at CATEGORY_SNAPSHOT_META_KEY. */
export interface CategoryCacheMeta {
  version: 1;
  status: 'complete';
  accountIdentity: string;
  startedAt: number;
  completedAt: number;
  count: number;
  page: number;
  pages: number;
  sourceRowCount: number;
  storedRowCount: number;
  schemaVersion: number;
  sourceApiVersion: ApiSourceVersion;
  generation: string;
  fingerprint: string;
}

/** Validated category rows and their complete snapshot metadata. */
export interface CategorySnapshot {
  rows: CategoryCacheRow[];
  meta: CategoryCacheMeta;
}

/** Complete validated v3 inventory snapshot published in one cache transaction. */
export interface InventorySnapshot {
  items: ItemRow[];
  stockRows: ItemStockLocationRow[];
  meta: InventoryCacheMeta;
}

/** Deterministic fingerprint for the exact authoritative inventory rows. */
export function createInventorySnapshotFingerprint(
  accountIdentity: string,
  generation: string,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[]
): string {
  const canonical = {
    accountIdentity,
    generation,
    items: [...items]
      .sort((left, right) => compareCodeUnitStrings(left.item_id, right.item_id))
      .map(canonicalInventoryItem),
    stockRows: [...stockRows]
      .sort((left, right) => compareCodeUnitStrings(left.stock_row_id, right.stock_row_id))
      .map(canonicalInventoryStockRow),
  };
  return hashInventorySnapshot(canonical);
}

/** Deterministic proof for one canonical item and its complete stock subtree. */
export function createInventoryItemBundleFingerprint(
  accountIdentity: string,
  item: ItemRow,
  stockRows: ItemStockLocationRow[]
): string {
  return hashInventorySnapshot({
    accountIdentity,
    item: canonicalInventoryItem(item),
    stockRows: [...stockRows]
      .sort((left, right) => compareCodeUnitStrings(left.stock_row_id, right.stock_row_id))
      .map(canonicalInventoryStockRow),
  });
}

interface InventoryCacheMetaBase {
  accountIdentity: string;
  startedAt: number;
  completedAt: number;
  itemCount: number;
  stockRowCount: number;
  schemaVersion: number;
  sourceApiVersion: '3';
  generation: string;
  fingerprint: string;
}

/** Legacy clean-snapshot metadata; kept readable across the metadata-format upgrade. */
export interface InventoryCacheMetaV1 extends InventoryCacheMetaBase {
  version: 1;
  status: 'complete';
}

/** Snapshot metadata with explicit recovery and last-known-good outcomes. */
export interface InventoryCacheMetaV2 extends InventoryCacheMetaBase {
  version: 2;
  status: 'complete' | 'complete_with_warnings';
  freshItemCount: number;
  preservedItemCount: number;
  omittedItemCount: number;
  warningCount: number;
  /** Most recent clean completion, or null if no clean inventory has completed. */
  lastCompleteAt: number | null;
}

export type InventoryCacheMeta = InventoryCacheMetaV1 | InventoryCacheMetaV2;

/** Verify metadata against its rows while retaining compatibility with legacy v1 fingerprints. */
export function inventorySnapshotFingerprintMatches(
  meta: InventoryCacheMeta,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[]
): boolean {
  const current = createInventorySnapshotFingerprint(
    meta.accountIdentity,
    meta.generation,
    items,
    stockRows
  );
  if (meta.fingerprint === current) return true;
  if (meta.version !== 1 || !hasLegacyInventoryDefaults(items, stockRows)) return false;
  return legacyInventorySnapshotFingerprintMatches(
    meta.fingerprint,
    meta.accountIdentity,
    meta.generation,
    items,
    stockRows
  );
}

const INVENTORY_META_COMMON_KEYS = [
  'accountIdentity',
  'completedAt',
  'fingerprint',
  'generation',
  'itemCount',
  'schemaVersion',
  'sourceApiVersion',
  'startedAt',
  'status',
  'stockRowCount',
  'version',
];

const INVENTORY_META_V2_KEYS = [
  ...INVENTORY_META_COMMON_KEYS,
  'freshItemCount',
  'lastCompleteAt',
  'omittedItemCount',
  'preservedItemCount',
  'warningCount',
];

/** Parse only supported authoritative inventory metadata formats. */
export function parseInventoryCacheMeta(value: unknown): InventoryCacheMeta | null {
  if (!isRecord(value)) return null;
  const {
    accountIdentity,
    completedAt,
    fingerprint,
    freshItemCount,
    generation,
    itemCount,
    lastCompleteAt,
    omittedItemCount,
    preservedItemCount,
    schemaVersion,
    sourceApiVersion,
    startedAt,
    status,
    stockRowCount,
    version,
    warningCount,
  } = value;

  const commonIsValid =
    isNonEmptyString(accountIdentity) &&
    isNonNegativeInteger(startedAt) &&
    isNonNegativeInteger(completedAt) &&
    completedAt >= startedAt &&
    isNonNegativeInteger(itemCount) &&
    isNonNegativeInteger(stockRowCount) &&
    isSupportedSnapshotSchemaVersion(schemaVersion) &&
    sourceApiVersion === '3' &&
    isNonEmptyString(generation) &&
    isNonEmptyString(fingerprint);
  if (!commonIsValid) return null;

  if (version === 1) {
    return hasExactKeys(value, INVENTORY_META_COMMON_KEYS) && status === 'complete'
      ? (value as unknown as InventoryCacheMetaV1)
      : null;
  }
  if (version !== 2) return null;

  if (
    !hasExactKeys(value, INVENTORY_META_V2_KEYS) ||
    (status !== 'complete' && status !== 'complete_with_warnings') ||
    !isNonNegativeInteger(freshItemCount) ||
    !isNonNegativeInteger(preservedItemCount) ||
    !isNonNegativeInteger(omittedItemCount) ||
    !isNonNegativeInteger(warningCount) ||
    (lastCompleteAt !== null && !isNonNegativeInteger(lastCompleteAt)) ||
    (typeof lastCompleteAt === 'number' && lastCompleteAt > completedAt) ||
    freshItemCount + preservedItemCount !== itemCount ||
    warningCount !== preservedItemCount + omittedItemCount
  ) {
    return null;
  }

  return status === 'complete'
    ? warningCount === 0 &&
      preservedItemCount === 0 &&
      omittedItemCount === 0 &&
      lastCompleteAt === completedAt
      ? (value as unknown as InventoryCacheMetaV2)
      : null
    : warningCount > 0
      ? (value as unknown as InventoryCacheMetaV2)
      : null;
}

export function isInventoryCacheMeta(value: unknown): value is InventoryCacheMeta {
  return parseInventoryCacheMeta(value) !== null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalInventoryItem(item: ItemRow): Record<string, unknown> {
  return {
    item_id: item.item_id,
    item_number: finiteInventoryNumber(item.item_number, 'item_number'),
    name: item.name,
    description: item.description ?? null,
    sku: item.sku ?? null,
    serial_number: item.serial_number ?? null,
    barcode: item.barcode ?? null,
    category_id: item.category_id ?? null,
    category_name: item.category_name ?? null,
    quantity: finiteInventoryNumber(item.quantity, 'quantity'),
    quantity_reserved: finiteInventoryNumber(item.quantity_reserved, 'quantity_reserved'),
    quantity_available: finiteInventoryNumber(item.quantity_available, 'quantity_available'),
    quantity_incoming: finiteInventoryNumber(item.quantity_incoming, 'quantity_incoming'),
    in_transit: finiteInventoryNumber(item.in_transit, 'in_transit'),
    threshold: finiteInventoryNumber(item.threshold, 'threshold'),
    cost: finiteInventoryNumber(item.cost, 'cost'),
    price: finiteInventoryNumber(item.price, 'price'),
    valuation: finiteInventoryNumber(item.valuation, 'valuation'),
    published: finiteInventoryNumber(item.published, 'published'),
    archived: finiteInventoryNumber(item.archived, 'archived'),
    created: item.created ?? null,
    modified: finiteInventoryNumber(item.modified, 'modified'),
    cache_source: item.cache_source ?? null,
    source_api_version: item.source_api_version ?? null,
    imported_at: finiteInventoryNumber(item.imported_at, 'imported_at'),
  };
}

function canonicalInventoryStockRow(row: ItemStockLocationRow): Record<string, unknown> {
  return {
    stock_row_id: row.stock_row_id,
    item_id: row.item_id,
    item_number: finiteInventoryNumber(row.item_number, 'item_number'),
    variation_id: row.variation_id ?? null,
    variation_location_id: row.variation_location_id ?? null,
    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
    category_name: row.category_name ?? null,
    quantity_on_hand: requiredFiniteInventoryNumber(row.quantity_on_hand, 'quantity_on_hand'),
    quantity_reserved: finiteInventoryNumber(row.quantity_reserved, 'quantity_reserved'),
    quantity_available: finiteInventoryNumber(row.quantity_available, 'quantity_available'),
    quantity_incoming: finiteInventoryNumber(row.quantity_incoming, 'quantity_incoming'),
    in_transit: finiteInventoryNumber(row.in_transit, 'in_transit'),
    price: finiteInventoryNumber(row.price, 'price'),
    cost: finiteInventoryNumber(row.cost, 'cost'),
    valuation: finiteInventoryNumber(row.valuation, 'valuation'),
    barcode: row.barcode ?? null,
    cache_source: row.cache_source ?? null,
    source_api_version: row.source_api_version ?? null,
    imported_at: finiteInventoryNumber(row.imported_at, 'imported_at'),
  };
}

function finiteInventoryNumber(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredFiniteInventoryNumber(value, field);
}

function requiredFiniteInventoryNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid inventory fingerprint field ${field}: value must be finite.`);
  }
  return value;
}

function legacyInventorySnapshotFingerprintMatches(
  expected: string,
  accountIdentity: string,
  generation: string,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[]
): boolean {
  const seenOrders = new Set<string>();
  const seenFingerprints = new Set<string>();
  // V1 did not persist its host locale. Cover known deployment families; unknown collations fail closed.
  const comparators = [
    (left: string, right: string) => left.localeCompare(right),
    ...['en-US', 'sv-SE', 'da-DK'].map(
      (locale) => new Intl.Collator(locale).compare as (left: string, right: string) => number
    ),
    compareCodeUnitStrings,
  ];

  for (const compare of comparators) {
    const sortedItems = [...items].sort((left, right) => compare(left.item_id, right.item_id));
    const sortedStockRows = [...stockRows].sort((left, right) =>
      compare(left.stock_row_id, right.stock_row_id)
    );
    const order = JSON.stringify([
      sortedItems.map((item) => item.item_id),
      sortedStockRows.map((row) => row.stock_row_id),
    ]);
    if (seenOrders.has(order)) continue;
    seenOrders.add(order);

    for (const omitNullParentLocationId of [false, true]) {
      const fingerprint = hashInventorySnapshot({
        accountIdentity,
        generation,
        items: sortedItems.map(legacyInventoryItem),
        stockRows: sortedStockRows.map((row) =>
          legacyInventoryStockRow(row, omitNullParentLocationId)
        ),
      });
      if (seenFingerprints.has(fingerprint)) continue;
      if (fingerprint === expected) return true;
      seenFingerprints.add(fingerprint);
    }
  }
  return false;
}

function hasLegacyInventoryDefaults(items: ItemRow[], stockRows: ItemStockLocationRow[]): boolean {
  return (
    items.every((item) => isNullish(item.valuation) && isNullish(item.imported_at)) &&
    stockRows.every(
      (row) =>
        isNullish(row.valuation) &&
        isNullish(row.imported_at) &&
        (!isNullish(row.variation_id) || isNullish(row.variation_location_id))
    )
  );
}

const isNullish = (value: unknown): boolean => value === null || value === undefined;

function legacyInventoryItem(item: ItemRow): Record<string, unknown> {
  const canonical = canonicalInventoryItem(item);
  return {
    item_id: canonical.item_id,
    item_number: canonical.item_number,
    name: canonical.name,
    description: canonical.description,
    sku: canonical.sku,
    serial_number: canonical.serial_number,
    barcode: canonical.barcode,
    category_id: canonical.category_id,
    category_name: canonical.category_name,
    quantity: canonical.quantity,
    quantity_reserved: canonical.quantity_reserved,
    quantity_available: canonical.quantity_available,
    quantity_incoming: canonical.quantity_incoming,
    in_transit: canonical.in_transit,
    threshold: canonical.threshold,
    cost: canonical.cost,
    price: canonical.price,
    published: canonical.published,
    archived: canonical.archived,
    created: canonical.created,
    modified: canonical.modified,
    cache_source: canonical.cache_source,
    source_api_version: canonical.source_api_version,
  };
}

function legacyInventoryStockRow(
  row: ItemStockLocationRow,
  omitNullParentLocationId: boolean
): Record<string, unknown> {
  const canonical = canonicalInventoryStockRow(row);
  const identity = {
    stock_row_id: canonical.stock_row_id,
    item_id: canonical.item_id,
    item_number: canonical.item_number,
  };
  const values = {
    ...(omitNullParentLocationId &&
    canonical.variation_id === null &&
    canonical.location_id === null
      ? {}
      : { location_id: canonical.location_id }),
    location_name: canonical.location_name,
    category_name: canonical.category_name,
    quantity_on_hand: canonical.quantity_on_hand,
    quantity_reserved: canonical.quantity_reserved,
    quantity_available: canonical.quantity_available,
    quantity_incoming: canonical.quantity_incoming,
    in_transit: canonical.in_transit,
    price: canonical.price,
    cost: canonical.cost,
    barcode: canonical.barcode,
    cache_source: canonical.cache_source,
    source_api_version: canonical.source_api_version,
  };
  return canonical.variation_id === null
    ? { ...identity, ...values }
    : {
        ...identity,
        variation_id: canonical.variation_id,
        variation_location_id: canonical.variation_location_id,
        ...values,
      };
}

function hashInventorySnapshot(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Immutable identity assigned to a one-account PostgreSQL cache database. */
export interface CacheAccountBinding {
  accountIdentity: string;
  accountSubdomain: string;
  createdAt?: number;
}

/** Normalize the configured SalesBinder subdomain into a stable cache owner identity. */
export function createSalesBinderAccountBinding(subdomain: string): CacheAccountBinding {
  const normalized = subdomain
    .trim()
    .toLowerCase()
    .replace(/\.salesbinder\.com\.?$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      'SalesBinder subdomain is invalid and cannot identify a cache database safely.'
    );
  }
  return {
    accountIdentity: `salesbinder:${normalized}`,
    accountSubdomain: normalized,
  };
}

/** Current physical and logical cache schema. */
export const CACHE_SCHEMA_VERSION = 8;
/** Named PostgreSQL alias used by change-feed schema checks. */
export const POSTGRES_CACHE_SCHEMA_VERSION = CACHE_SCHEMA_VERSION;
/** Snapshot metadata v7 remains readable during the v8 feed cutover. */
export type SupportedSnapshotSchemaVersion = 7 | typeof CACHE_SCHEMA_VERSION;

export function isSupportedSnapshotSchemaVersion(
  value: unknown
): value is SupportedSnapshotSchemaVersion {
  return value === 7 || value === CACHE_SCHEMA_VERSION;
}

/** PostgreSQL BIGINT sequence transported without JavaScript number coercion. */
export type InventoryEventSequence = string;

export interface InventoryChangeFeedBinding {
  accountIdentity: string;
  ledgerDatabaseId: string;
  consumerName: string;
}

export interface InventoryChangeFeedState extends InventoryChangeFeedBinding {
  baselineGeneration: string | null;
  observedThroughEventSeq: InventoryEventSequence | null;
  appliedThroughEventSeq: InventoryEventSequence | null;
  highestAppliedEventSeq: InventoryEventSequence | null;
  blockedByEventSeq: InventoryEventSequence | null;
  updatedAt: number;
}

export interface InventoryChangeFeedStateUpdate extends InventoryChangeFeedBinding {
  baselineGeneration?: string | null;
  observedThroughEventSeq?: InventoryEventSequence | null;
  appliedThroughEventSeq?: InventoryEventSequence | null;
  highestAppliedEventSeq?: InventoryEventSequence | null;
  blockedByEventSeq?: InventoryEventSequence | null;
  updatedAt: number;
  /** Cancels the PostgreSQL transaction if this sync operation loses its fence. */
  operationSignal?: AbortSignal;
}

export type InventoryReceiptAppliedAction = 'upsert' | 'tombstone' | 'fenced_noop';
export type InventoryHydrationOutcome = 'found_current' | 'found_archived' | 'expected_tombstone';
export type InventoryMaterializationOutcome = 'upserted' | 'tombstoned' | 'superseded';

export interface InventoryEventReceipt extends InventoryChangeFeedBinding {
  receiptId: string;
  eventSeq: InventoryEventSequence;
  eventType: InventoryChangeFeedEventType;
  objectId: string;
  appliedAction: InventoryReceiptAppliedAction;
  hydrationOutcome: InventoryHydrationOutcome;
  materializationOutcome: InventoryMaterializationOutcome;
  cacheGeneration: string;
  sourceFingerprint: string | null;
  committedAt: number;
}

export type InventoryChangeFeedEventType =
  | 'inventory.item_created'
  | 'inventory.item_updated'
  | 'inventory.low_stock'
  | 'inventory.item_deleted';

export interface InventoryEventReceiptInput {
  eventSeq: InventoryEventSequence;
  eventType: InventoryChangeFeedEventType;
  objectId: string;
}

export interface InventoryItemBundleApplication extends InventoryChangeFeedBinding {
  cacheGeneration: string;
  item: ItemRow;
  stockRows: ItemStockLocationRow[];
  events: InventoryEventReceiptInput[];
  hydrationOutcome: 'found_current' | 'found_archived';
  sourceFingerprint?: string;
  expectedHighestAppliedEventSeq: InventoryEventSequence | null;
  observedThroughEventSeq?: InventoryEventSequence | null;
  appliedThroughEventSeq?: InventoryEventSequence | null;
  blockedByEventSeq?: InventoryEventSequence | null;
  committedAt: number;
  /** Cancels the PostgreSQL transaction if this sync operation loses its fence. */
  operationSignal?: AbortSignal;
}

export interface InventoryTombstoneProof {
  deleteEventSeq: InventoryEventSequence;
  confirmation: 'v3_exact_404';
  confirmedMissingAt: number;
}

export interface InventoryTombstoneApplication extends InventoryChangeFeedBinding {
  cacheGeneration: string;
  objectId: string;
  events: InventoryEventReceiptInput[];
  proof: InventoryTombstoneProof;
  expectedHighestAppliedEventSeq: InventoryEventSequence | null;
  observedThroughEventSeq?: InventoryEventSequence | null;
  appliedThroughEventSeq?: InventoryEventSequence | null;
  blockedByEventSeq?: InventoryEventSequence | null;
  committedAt: number;
  /** Cancels the PostgreSQL transaction if this sync operation loses its fence. */
  operationSignal?: AbortSignal;
}

export interface InventoryReceiptApplicationResult {
  duplicate: boolean;
  materialized: boolean;
  receipts: InventoryEventReceipt[];
}

export type InventoryBaselineRunStatus = 'active' | 'promoted' | 'failed';

export interface InventoryBaselineRun extends InventoryChangeFeedBinding {
  runId: string;
  generation: string;
  startEventSeq: InventoryEventSequence;
  rootFingerprint: string;
  rootItemIds: string[];
  expectedItemCount: number;
  status: InventoryBaselineRunStatus;
  startedAt: number;
  updatedAt: number;
  promotedAt: number | null;
  failureCode: string | null;
}

export interface InventoryStagedItemBundle extends InventoryChangeFeedBinding {
  runId: string;
  item: ItemRow;
  stockRows: ItemStockLocationRow[];
  stagedAt: number;
}

export interface InventoryStagingFailure extends InventoryChangeFeedBinding {
  runId: string;
  itemId: string;
  attemptCount: number;
  errorCode: string;
  errorMessage: string;
  updatedAt: number;
}

export interface InventoryStagingProgress extends InventoryChangeFeedBinding {
  runId: string;
  expectedItemCount: number;
  stagedItemCount: number;
  failedItemCount: number;
  completedItemIds: string[];
  pendingItemIds: string[];
  failures: Array<{
    itemId: string;
    attemptCount: number;
    errorCode: string;
    errorMessage: string;
    updatedAt: number;
  }>;
}

export interface InventoryBaselinePromotion extends InventoryChangeFeedBinding {
  runId: string;
  promotedAt: number;
}

export interface InventoryBaselinePromotionResult {
  run: InventoryBaselineRun;
  meta: InventoryCacheMeta;
}

export interface InventoryBaselineFailure extends InventoryChangeFeedBinding {
  runId: string;
  failureCode: string;
  failedAt: number;
}

/** Validate the canonical unsigned decimal representation accepted by PostgreSQL BIGINT. */
export function isInventoryEventSequence(value: unknown): value is InventoryEventSequence {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

/** Stable ledger-verification identifier for one immutable cache receipt. */
export function createInventoryEventReceiptId(
  binding: InventoryChangeFeedBinding,
  eventSeq: InventoryEventSequence
): string {
  if (!isInventoryEventSequence(eventSeq) || eventSeq === '0') {
    throw new Error('Inventory receipt event sequence is invalid.');
  }
  const canonical = [
    binding.accountIdentity,
    binding.ledgerDatabaseId.toLowerCase(),
    binding.consumerName,
    eventSeq,
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/** Canonical membership proof stored with a resumable inventory baseline. */
export function createInventoryBaselineRootFingerprint(
  accountIdentity: string,
  rootItemIds: string[]
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([accountIdentity, [...rootItemIds].sort(compareCodeUnitStrings)]))
    .digest('hex')}`;
}

export interface CacheState {
  lastSync: number; // Unix timestamp
  lastFullSync: number; // Unix timestamp
  documentCount: number;
  itemDocumentCount: number;
  accountName: string;
  schemaVersion: number;
  accountCount?: number;
  customerCount?: number;
  supplierCount?: number;
  itemCount?: number;
  categoryCount?: number;
  stockLocationCount?: number;
  lastAccountSync?: number;
  lastCategorySync?: number;
  lastItemSync?: number;
  lastFullItemSync?: number;
  inventorySourceApiVersion?: ApiSourceVersion;
  lastDeletedSync?: number;
  /** Timestamp of the latest attempted global sync, including warning completion. */
  lastSyncAttempt?: number;
}

/** Writer sync status stored in cache_meta. */
export interface CacheSyncStatus {
  status: 'running' | 'success' | 'success_with_warnings' | 'failed';
  runId: string;
  accountName: string;
  syncTarget: 'sqlite' | 'postgresql';
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  message?: string;
  syncType?: 'full' | 'delta';
  documentsProcessed?: number;
  lineItemsProcessed?: number;
  itemsProcessed?: number;
  categoriesProcessed?: number;
  stockRowsProcessed?: number;
  deletedRecordsProcessed?: number;
  phase?: CacheSyncPhase;
  progress?: CacheSyncProgress;
  progressUpdatedAt?: number;
  recordIssues?: SyncRecordIssue[];
  error?: string;
}

/** Options for cache sync operations */
export interface SyncOptions {
  full?: boolean; // Force full sync
  onProgress?: (current: number, total: number) => void; // Progress callback
  onProgressEvent?: CacheSyncProgressCallback;
  resume?: {
    documents?: { contextId?: number; page?: number; docIndex?: number };
    onDocumentCheckpoint?: (checkpoint: {
      contextId: number;
      page: number;
      docIndex: number;
    }) => void;
  };
}

/** Sync result interface */
export interface SyncResult {
  success: boolean;
  type: 'full' | 'delta';
  documentsProcessed: number;
  documentsDeleted?: number;
  lineItemsProcessed: number;
  duration: string;
  accountsProcessed?: number;
  customersProcessed?: number;
  suppliersProcessed?: number;
  itemsProcessed?: number;
  categoriesProcessed?: number;
  stockRowsProcessed?: number;
  deletedRecordsProcessed?: number;
  syncLookbackSeconds?: number;
  recordIssues?: SyncRecordIssue[];
}

/** Sales analytics result for a single item */
export interface ItemSalesAnalytics {
  item_id: string;
  item_name?: string;
  current_stock: number;
  latest_oc_date?: string; // YYYY-MM-DD
  latest_po_date?: string; // YYYY-MM-DD
  sales_periods: {
    [months: string]: {
      sold: number;
      revenue: number;
    };
  };
  cache_freshness: {
    last_sync: string; // ISO 8601
    stale: boolean;
  };
}

/** Item sales grouped by period for analytics */
export interface ItemSalesByPeriodRow {
  issue_date: string;
  quantity: number;
  price: number;
}

/** Price distribution for analytics */
export interface PriceDistributionRow {
  price: number;
  total_quantity: number;
  total_revenue: number;
}

/** Customer sales data for analytics */
export interface CustomerSalesData {
  customer_id: string;
  customer_name?: string | null;
  quantity: number;
  revenue: number;
  order_count: number;
}

/** Order pattern row for cycle time and win rate analysis */
export interface OrderPatternRow {
  doc_id: string;
  quantity: number;
  price: number;
  issue_date: string;
  customer_id: string;
  context_id: number;
  doc_number: number;
}

export type {
  PaymentSyncMode,
  PaymentSyncResult,
  PaymentSyncState,
  PaymentSyncStatus,
  PaymentTransactionRow,
} from './payment-sync.types.js';

// Re-export DocumentContextId from common types for convenience
export { DocumentContextId } from '../types/common.types.js';
