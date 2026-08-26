import { createHash } from 'crypto';
import type { SalesBinderClient } from '../resources/index.js';
import type { Item, ItemListResponse, ItemVariationLocation } from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState, ItemRow, ItemStockLocationRow } from './types.js';

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

        let fullItem: Item;
        try {
          fullItem = await this.client.items.get(item.id);
        } catch (error) {
          // One malformed/transient item response must not abort the entire
          // incremental batch. Keep the list representation as a safe fallback;
          // it still refreshes core item fields, while stock detail is preserved
          // from the list shape when available.
          console.warn(`Item detail unavailable for ${item.id}; using list payload: ${(error as Error)?.message ?? error}`);
          fullItem = item;
        }
        const stockRows = this.toStockRows(fullItem);
        await this.cache.insertItem(this.toItemRow(fullItem));
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

  private toItemRow(item: Item): ItemRow {
    return {
      item_id: item.id,
      item_number: item.item_number,
      name: item.name,
      description: item.description ?? null,
      sku: item.sku ?? null,
      serial_number: item.serial_number ?? null,
      barcode: item.barcode ?? null,
      category_id: item.category_id ?? item.category?.id ?? null,
      category_name: item.category?.name ?? null,
      quantity: item.quantity,
      threshold: item.threshold,
      cost: item.cost,
      price: item.price,
      published: item.published == null ? null : item.published ? 1 : 0,
      created: item.created,
      modified: toUnix(item.modified),
      cache_source: 'api',
    };
  }

  private toStockRows(item: Item): ItemStockLocationRow[] {
    const rows: ItemStockLocationRow[] = [];
    for (const variation of item.item_variations ?? []) {
      for (const location of variation.item_variations_locations ?? []) {
        rows.push(this.toStockRow(item, variation.id, location));
      }
    }

    if (rows.length === 0) {
      rows.push({
        stock_row_id: syntheticId('api-stock', item.id, item.location?.id ?? 'default'),
        item_id: item.id,
        item_number: item.item_number,
        location_id: item.location?.id ?? null,
        location_name: item.location?.name ?? null,
        category_name: item.category?.name ?? null,
        quantity_on_hand: item.quantity ?? 0,
        quantity_reserved: 0,
        quantity_available: item.quantity ?? 0,
        quantity_incoming: 0,
        in_transit: 0,
        price: item.price,
        cost: item.cost,
        barcode: item.barcode ?? null,
        cache_source: 'api',
      });
    }

    return rows;
  }

  private toStockRow(item: Item, variationId: string, location: ItemVariationLocation): ItemStockLocationRow {
    const quantity = location.quantity ?? 0;
    return {
      stock_row_id: String(location.id ?? syntheticId('api-stock', item.id, variationId, location.location_id ?? 'none')),
      item_id: item.id,
      item_number: item.item_number,
      variation_id: variationId,
      variation_location_id: location.id == null ? null : String(location.id),
      location_id: location.location_id ?? null,
      category_name: item.category?.name ?? null,
      quantity_on_hand: quantity,
      quantity_reserved: 0,
      quantity_available: quantity,
      quantity_incoming: 0,
      in_transit: 0,
      price: item.price,
      cost: item.cost,
      barcode: item.barcode ?? null,
      cache_source: 'api',
    };
  }

  private async mergeState(state: CacheState | null, now: number): Promise<CacheState> {
    return {
      ...state,
      lastSync: state?.lastSync ?? now,
      lastFullSync: state?.lastFullSync ?? now,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: state?.accountName ?? this.accountName,
      schemaVersion: 2,
      itemCount: await this.cache.getItemCount(),
      stockLocationCount: await this.cache.getStockLocationCount(),
      lastItemSync: now,
    };
  }
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
