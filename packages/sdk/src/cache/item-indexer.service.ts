import { createHash } from 'crypto';
import type { SalesBinderClient } from '../resources/index.js';
import type { Item, ItemListResponse, ItemVariationLocation } from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState, CategorySnapshot, ItemRow, ItemStockLocationRow } from './types.js';
import { CACHE_SCHEMA_VERSION } from './types.js';

export interface ItemSyncResult {
  itemsProcessed: number;
  stockRowsProcessed: number;
}

export interface ItemSyncOptions {
  full?: boolean;
  resume?: {
    page?: number;
    itemIndex?: number;
    onItemCheckpoint?: (checkpoint: { page: number; itemIndex: number }) => void;
  };
}

const DEFAULT_ITEM_DETAIL_DELAY_MS = 0;

export class ItemIndexerService {
  private readonly itemDetailDelayMs: number;

  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    private readonly accountName: string,
    private readonly syncLookbackSeconds = 604800
  ) {
    const delayValue = process.env[['SALESBINDER', 'ITEM', 'DETAIL', 'DELAY', 'MS'].join('_')];
    this.itemDetailDelayMs = delayValue ? parseInt(delayValue, 10) : DEFAULT_ITEM_DETAIL_DELAY_MS;
  }

  async sync(fullOrOptions: boolean | ItemSyncOptions = false): Promise<ItemSyncResult> {
    const options: ItemSyncOptions = typeof fullOrOptions === 'boolean' ? { full: fullOrOptions } : fullOrOptions;
    const full = options.full ?? false;
    const state = await this.cache.getCacheState();
    const categoryNames = toCategoryNameIndex(await this.cache.getCategorySnapshot());
    const since = full ? 0 : Math.max(0, (state?.lastItemSync ?? state?.lastSync ?? 0) - this.syncLookbackSeconds);
    let page = Math.max(1, options.resume?.page ?? 1);
    let itemCount = 0;
    let stockCount = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.items.list({ modifiedSince: since, page, pageLimit: 100 });
      const items = this.flattenItems(response);
      if (items.length === 0) break;

      const startItemIndex = options.resume?.page === page ? Math.max(0, options.resume?.itemIndex ?? 0) : 0;
      for (let itemIndex = startItemIndex; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        options.resume?.onItemCheckpoint?.({ page, itemIndex });
        if (!item.id) {
          throw new Error('SalesBinder item list returned an item without id');
        }

        // The detail response is authoritative for per-location stock. The
        // client owns retries; after they are exhausted, abort before writes so
        // existing detailed stock remains intact and resume retries this item.
        const fullItem = await this.client.items.get(item.id);
        const stockRows = this.toStockRows(fullItem, categoryNames);
        await this.cache.insertItem(this.toItemRow(fullItem, categoryNames));
        await this.cache.replaceItemStockLocations(fullItem.id, stockRows);
        itemCount++;
        stockCount += stockRows.length;
        options.resume?.onItemCheckpoint?.({ page, itemIndex: itemIndex + 1 });

        if (this.itemDetailDelayMs > 0) {
          await delay(this.itemDetailDelayMs);
        }
      }

      hasMore = page < Number(response.pages ?? page);
      options.resume?.onItemCheckpoint?.({ page: page + 1, itemIndex: 0 });
      page++;
    }

    await this.cache.setCacheState(await this.mergeState(state, Math.floor(Date.now() / 1000)));
    return { itemsProcessed: itemCount, stockRowsProcessed: stockCount };
  }

  private flattenItems(response: ItemListResponse): Item[] {
    const items = response.items ?? [];
    return Array.isArray(items[0]) ? (items as unknown as Item[][]).flat() : items;
  }

  private toItemRow(item: Item, categoryNames: Map<string, string> | null = null): ItemRow {
    return {
      item_id: item.id,
      item_number: item.item_number,
      name: item.name,
      description: item.description ?? null,
      sku: item.sku ?? null,
      serial_number: item.serial_number ?? null,
      barcode: item.barcode ?? null,
      category_id: item.category_id ?? item.category?.id ?? null,
      category_name: categoryName(item, categoryNames),
      quantity: item.quantity,
      quantity_reserved: observedNumber(item.quantity_reserved),
      quantity_available: observedNumber(item.quantity_available),
      quantity_incoming: observedNumber(item.quantity_incoming),
      in_transit: observedNumber(item.in_transit),
      threshold: item.threshold,
      cost: item.cost,
      price: item.price,
      published: item.published == null ? null : item.published ? 1 : 0,
      archived: item.archived == null ? null : item.archived ? 1 : 0,
      created: item.created ?? (item as Item & { created_at?: string }).created_at ?? null,
      modified: toUnix(item.modified ?? (item as Item & { updated_at?: string }).updated_at),
      cache_source: 'api',
      source_api_version: '2.0',
    };
  }

  private toStockRows(item: Item, categoryNames: Map<string, string> | null = null): ItemStockLocationRow[] {
    const rows: ItemStockLocationRow[] = [];
    for (const variation of item.item_variations ?? []) {
      for (const location of variation.item_variations_locations ?? []) {
        rows.push(this.toStockRow(item, variation.id, location, categoryNames));
      }
    }

    if (rows.length === 0) {
      rows.push({
        stock_row_id: syntheticId('api-stock', item.id, item.location?.id ?? 'default'),
        item_id: item.id,
        item_number: item.item_number,
        location_id: item.location?.id ?? null,
        location_name: item.location?.name ?? null,
        category_name: categoryName(item, categoryNames),
        quantity_on_hand: requiredNumber(item.quantity, 'item.quantity'),
        quantity_reserved: observedNumber(item.quantity_reserved),
        quantity_available: observedNumber(item.quantity_available),
        quantity_incoming: observedNumber(item.quantity_incoming),
        in_transit: observedNumber(item.in_transit),
        price: item.price,
        cost: item.cost,
        barcode: item.barcode ?? null,
        cache_source: 'api',
        source_api_version: '2.0',
      });
    }

    return rows;
  }

  private toStockRow(
    item: Item,
    variationId: string,
    location: ItemVariationLocation,
    categoryNames: Map<string, string> | null,
  ): ItemStockLocationRow {
    const quantity = requiredNumber(location.quantity, 'variation location quantity');
    return {
      stock_row_id: String(location.id ?? syntheticId('api-stock', item.id, variationId, location.location_id ?? 'none')),
      item_id: item.id,
      item_number: item.item_number,
      variation_id: variationId,
      variation_location_id: location.id == null ? null : String(location.id),
      location_id: location.location_id ?? null,
      category_name: categoryName(item, categoryNames),
      quantity_on_hand: quantity,
      quantity_reserved: observedNumber(location.quantity_reserved),
      quantity_available: observedNumber(location.quantity_available),
      quantity_incoming: observedNumber(location.quantity_incoming),
      in_transit: observedNumber(location.in_transit),
      price: item.price,
      cost: item.cost,
      barcode: item.barcode ?? null,
      cache_source: 'api',
      source_api_version: '2.0',
    };
  }

  private async mergeState(state: CacheState | null, now: number): Promise<CacheState> {
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
      inventorySourceApiVersion: '2.0',
    };
  }
}

function toCategoryNameIndex(snapshot: CategorySnapshot | null): Map<string, string> | null {
  if (!snapshot) return null;
  return new Map(snapshot.rows.map((row) => [row.category_id, row.name]));
}

function categoryName(item: Item, categoryNames: Map<string, string> | null): string | null {
  if (!categoryNames) return item.category_name ?? item.category?.name ?? null;
  const categoryId = item.category_id ?? item.category?.id;
  return categoryId ? categoryNames.get(categoryId) ?? null : null;
}

function observedNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('SalesBinder returned a non-numeric stock balance');
  return parsed;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = observedNumber(value);
  if (parsed == null) throw new Error(`SalesBinder item detail is missing required ${field}`);
  return parsed;
}

function syntheticId(...parts: string[]): string {
  return `api:${parts[0]}:${createHash('sha1').update(parts.slice(1).join('|')).digest('hex').slice(0, 24)}`;
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
