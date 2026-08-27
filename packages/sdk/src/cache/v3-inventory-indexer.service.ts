import { createHash, randomUUID } from 'node:crypto';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState, InventorySnapshot, ItemRow, ItemStockLocationRow } from './types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';
import { normalizeV3InventoryItem } from './v3-inventory-normalizer.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;
const MAX_RECORDS = 1_000_000;

export interface V3InventoryClient {
  items: {
    list(params: { page: number; limit: number; archived: 'all' }): Promise<V3ListResponse<V3Item>>;
    listVariations(
      itemId: string,
      params: { page: number; limit: number; include: 'locations' },
    ): Promise<V3ListResponse<V3ItemVariation>>;
  };
}

interface V3InventorySourceRead {
  items: V3Item[];
  variationsByItemId: Map<string, V3ItemVariation[]>;
}

export class V3InventoryIndexerService {
  constructor(
    private readonly client: V3InventoryClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly accountIdentity: string,
  ) {}

  async sync(): Promise<{ itemsProcessed: number; stockRowsProcessed: number }> {
    const state = await this.cache.getCacheState();
    if (state?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(`V3 inventory sync requires cache state schema version ${CACHE_SCHEMA_VERSION}`);
    }
    const startedAt = nowSeconds();
    const firstFingerprint = createSourceStabilityFingerprint(await this.readCompleteSource());
    const secondRead = await this.readCompleteSource();
    if (firstFingerprint !== createSourceStabilityFingerprint(secondRead)) {
      throw new Error('V3 inventory source changed during stability verification');
    }
    const categorySnapshot = await this.cache.getCategorySnapshot();
    const categoryNames = categorySnapshot
      ? new Map(categorySnapshot.rows.map((row) => [row.category_id, row.name]))
      : null;
    const items: ItemRow[] = [];
    const stockRows: ItemStockLocationRow[] = [];

    for (const sourceItem of secondRead.items) {
      const variations = secondRead.variationsByItemId.get(sourceItem.id) ?? [];
      const normalized = normalizeV3InventoryItem(sourceItem, variations, categoryNames);
      items.push(normalized.item);
      stockRows.push(...normalized.stockRows);
    }

    const completedAt = nowSeconds();
    const snapshot = createSnapshot(this.accountIdentity, startedAt, completedAt, items, stockRows);
    await this.cache.replaceInventorySnapshot(snapshot);
    await this.cache.setCacheState(await this.mergeState(state, completedAt));
    return { itemsProcessed: items.length, stockRowsProcessed: stockRows.length };
  }

  private async readCompleteSource(): Promise<V3InventorySourceRead> {
    const items = await this.fetchAllItems();
    const variationsByItemId = new Map<string, V3ItemVariation[]>();
    for (const item of items) {
      if (!Number.isSafeInteger(item.variation_count) || item.variation_count < 0) {
        throw new Error(`Invalid v3 variation count for item ${item.id}`);
      }
      const variations = item.variation_count > 0 ? await this.fetchAllVariations(item) : [];
      if (variations.length !== item.variation_count) {
        throw new Error(`Incomplete v3 variations for item ${item.id}`);
      }
      variationsByItemId.set(item.id, variations);
    }
    return { items, variationsByItemId };
  }

  private fetchAllItems(): Promise<V3Item[]> {
    return fetchAllPages(
      (page) => this.client.items.list({ page, limit: PAGE_LIMIT, archived: 'all' }),
      'items',
    );
  }

  private fetchAllVariations(item: V3Item): Promise<V3ItemVariation[]> {
    return fetchAllPages(
      (page) => this.client.items.listVariations(item.id, { page, limit: PAGE_LIMIT, include: 'locations' }),
      `variations for item ${item.id}`,
    );
  }

  private async mergeState(
    state: CacheState | null,
    now: number,
  ): Promise<CacheState> {
    return {
      ...state,
      lastSync: state?.lastSync ?? 0,
      lastFullSync: state?.lastFullSync ?? 0,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: CACHE_SCHEMA_VERSION,
      itemCount: await this.cache.getItemCount(),
      stockLocationCount: await this.cache.getStockLocationCount(),
      lastItemSync: now,
      lastFullItemSync: now,
      inventorySourceApiVersion: '3',
    };
  }
}

function createSourceStabilityFingerprint(source: V3InventorySourceRead): string {
  const canonical = [...source.items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      item,
      variations: [...(source.variationsByItemId.get(item.id) ?? [])]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((variation) => ({
          ...variation,
          locations: variation.locations == null
            ? variation.locations
            : [...variation.locations].sort((left, right) =>
              left.item_variation_location_id - right.item_variation_location_id
              || left.location_id.localeCompare(right.location_id)),
        })),
    }));
  return createHash('sha256').update(stableSerialize(canonical)).digest('hex');
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
      return nestedValue;
    }
    const record = nestedValue as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

async function fetchAllPages<T extends { id: string }>(
  fetchPage: (page: number) => Promise<V3ListResponse<T>>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  const ids = new Set<string>();
  let expectedTotal: number | null = null;
  let expectedPages: number | null = null;
  let expectedPageSize: number | null = null;
  for (let page = 1; page <= (expectedPages ?? 1); page++) {
    const response = await fetchPage(page);
    validatePage(response, page, label);
    const { total_pages: pages, total_records: total } = response.pagination;
    if (pages > MAX_PAGES || total > MAX_RECORDS) throw new Error(`V3 ${label} snapshot exceeds safety bounds`);
    if (expectedTotal == null) {
      expectedTotal = total;
      expectedPages = pages;
      expectedPageSize = response.pagination.per_page;
    } else if (
      expectedTotal !== total
      || expectedPages !== pages
      || expectedPageSize !== response.pagination.per_page
    ) {
      throw new Error(`V3 ${label} pagination changed during snapshot`);
    }
    for (const row of response.data) {
      if (!row || typeof row.id !== 'string' || !row.id.trim()) {
        throw new Error(`Invalid v3 ${label} row identity`);
      }
      if (ids.has(row.id)) throw new Error(`Duplicate v3 ${label} ID ${row.id}`);
      ids.add(row.id);
      rows.push(row);
    }
  }
  if (rows.length !== (expectedTotal ?? 0)) {
    throw new Error(`Incomplete v3 ${label} snapshot: expected ${expectedTotal ?? 0}, received ${rows.length}`);
  }
  return rows;
}

function validatePage<T>(response: V3ListResponse<T>, page: number, label: string): void {
  if (response.object !== 'list' || !Array.isArray(response.data)) throw new Error(`Invalid v3 ${label} list envelope`);
  const pagination = response.pagination;
  if (!pagination || pagination.page !== page) throw new Error(`Invalid v3 ${label} page ${page}`);
  for (const value of [pagination.page, pagination.per_page, pagination.total_pages, pagination.total_records]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid v3 ${label} pagination`);
  }
  const shouldHaveMore = page < pagination.total_pages;
  if (response.has_more !== shouldHaveMore) throw new Error(`Invalid v3 ${label} has_more on page ${page}`);
  if (pagination.total_records > 0 && pagination.total_pages < 1) {
    throw new Error(`Invalid v3 ${label} non-empty pagination`);
  }
  if (pagination.per_page < 1 || response.data.length > pagination.per_page) {
    throw new Error(`Invalid v3 ${label} page size`);
  }
  if (pagination.total_pages > 0 && page > pagination.total_pages) {
    throw new Error(`Invalid v3 ${label} page range`);
  }
  if (response.has_more && response.data.length === 0) {
    throw new Error(`Invalid v3 ${label} empty intermediate page`);
  }
  const expectedPages = pagination.total_records === 0
    ? pagination.total_pages
    : Math.ceil(pagination.total_records / pagination.per_page);
  if (
    (pagination.total_records === 0 && pagination.total_pages !== 0 && pagination.total_pages !== 1)
    || (pagination.total_records > 0 && pagination.total_pages !== expectedPages)
  ) {
    throw new Error(`Invalid v3 ${label} total pages`);
  }
  const expectedRows = pagination.total_records === 0
    ? 0
    : page < pagination.total_pages
      ? pagination.per_page
      : pagination.total_records - (pagination.total_pages - 1) * pagination.per_page;
  if (response.data.length !== expectedRows) {
    throw new Error(`Incomplete v3 ${label} page ${page}`);
  }
}

function createSnapshot(
  accountIdentity: string,
  startedAt: number,
  completedAt: number,
  items: ItemRow[],
  stockRows: ItemStockLocationRow[],
): InventorySnapshot {
  const generation = randomUUID();
  const canonical = {
    accountIdentity, generation,
    items: [...items].sort((a, b) => a.item_id.localeCompare(b.item_id)),
    stockRows: [...stockRows].sort((a, b) => a.stock_row_id.localeCompare(b.stock_row_id)),
  };
  return {
    items,
    stockRows,
    meta: {
      version: 1,
      status: 'complete',
      accountIdentity,
      startedAt,
      completedAt,
      itemCount: items.length,
      stockRowCount: stockRows.length,
      schemaVersion: 7,
      sourceApiVersion: '3',
      generation,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
    },
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
