import { createHash } from 'crypto';
import type { SalesBinderClient } from '../resources/index.js';
import type { Category, CategoryListResponse } from '../types/categories.types.js';
import type {
  Item,
  ItemListResponse,
  ItemVariation,
  ItemVariationLocation,
} from '../types/items.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheState, ItemRow, ItemStockLocationRow } from './types.js';
import {
  assertCacheMutationCompatible,
  CACHE_PENDING_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
} from './types.js';

export interface ItemSyncResult {
  itemsProcessed: number;
  stockRowsProcessed: number;
}

const DEFAULT_ITEM_DETAIL_DELAY_MS = 2000;

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

  async sync(full = false, preserveExistingEnrichment = true): Promise<ItemSyncResult> {
    const syncStartedAt = Math.floor(Date.now() / 1000);
    const state = await this.cache.getCacheState();
    await assertCacheMutationCompatible(this.cache, state, this.accountName);
    const lastItemSync = state?.lastItemSync;
    const effectiveFull = full
      || state === null
      || state.accountName !== this.accountName
      || state.schemaVersion !== CACHE_SCHEMA_VERSION
      || lastItemSync == null;
    const allowExistingEnrichment = preserveExistingEnrichment
      && state?.accountName === this.accountName;
    const since = effectiveFull || lastItemSync == null
      ? 0
      : Math.max(0, lastItemSync - this.syncLookbackSeconds);
    let page = 1;
    let itemCount = 0;
    let stockCount = 0;
    let hasMore = true;
    const categoryNames = await this.loadCategoryNames();
    if (allowExistingEnrichment) {
      await this.reconcileCachedCategoryNames(categoryNames);
    }

    while (hasMore) {
      const response = await this.client.items.list({ modifiedSince: since, page, pageLimit: 100 });
      const items = this.flattenItems(response);
      if (items.length === 0) break;

      for (const item of items) {
        if (!item.id) {
          throw new Error('SalesBinder item list returned an item without id');
        }

        const fullItem = await this.client.items.get(item.id);
        if (fullItem.id !== item.id) {
          throw new Error(`Item detail identity mismatch for ${item.id}: received ${fullItem.id}`);
        }
        const existingItem = allowExistingEnrichment
          ? await this.cache.getItem(fullItem.id)
          : undefined;
        const existingStockRows = allowExistingEnrichment
          ? await this.cache.getItemStockLocations(fullItem.id)
          : [];
        const itemRow = this.toItemRow(fullItem, item, existingItem, categoryNames);
        const stockRows = this.toStockRows(fullItem, item, itemRow, existingStockRows);
        await this.cache.insertItem(itemRow);
        await this.cache.replaceItemStockLocations(fullItem.id, stockRows);
        itemCount++;
        stockCount += stockRows.length;

        if (this.itemDetailDelayMs > 0) {
          await delay(this.itemDetailDelayMs);
        }
      }

      hasMore = page < Number(response.pages ?? page);
      page++;
    }

    await this.cache.setCacheState(await this.mergeState(state, syncStartedAt, effectiveFull));
    return { itemsProcessed: itemCount, stockRowsProcessed: stockCount };
  }

  private flattenItems(response: ItemListResponse): Item[] {
    const items = response.items ?? [];
    return Array.isArray(items[0]) ? (items as unknown as Item[][]).flat() : items;
  }

  private async loadCategoryNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const response: CategoryListResponse = await this.client.categories.list({ page, pageLimit: 100 });
      const categories = this.flattenCategories(response);
      for (const category of categories) {
        if (category.id && category.name) names.set(category.id, category.name);
      }
      hasMore = page < Number(response.pages ?? page);
      page++;
    }
    return names;
  }

  private flattenCategories(response: CategoryListResponse): Category[] {
    const categories = response.categories ?? [];
    return Array.isArray(categories[0])
      ? (categories as unknown as Category[][]).flat()
      : categories as unknown as Category[];
  }

  private async reconcileCachedCategoryNames(categoryNames: Map<string, string>): Promise<void> {
    const [cachedItems, allStockRows] = await Promise.all([
      this.cache.getAllItems(),
      this.cache.getAllItemStockLocations(),
    ]);
    const stockRowsByItem = new Map<string, ItemStockLocationRow[]>();
    for (const row of allStockRows) {
      const rows = stockRowsByItem.get(row.item_id) ?? [];
      rows.push(row);
      stockRowsByItem.set(row.item_id, rows);
    }

    for (const item of cachedItems) {
      const categoryName = item.category_id ? categoryNames.get(item.category_id) : undefined;
      if (!categoryName) continue;

      if (item.category_name !== categoryName) {
        await this.cache.insertItem({ ...item, category_name: categoryName });
      }
      const stockRows = stockRowsByItem.get(item.item_id) ?? [];
      if (stockRows.some((row) => row.category_name !== categoryName)) {
        await this.cache.replaceItemStockLocations(
          item.item_id,
          stockRows.map((row) => ({ ...row, category_name: categoryName }))
        );
      }
    }
  }

  private toItemRow(
    item: Item,
    listedItem: Item,
    existing: ItemRow | undefined,
    categoryNames: Map<string, string>
  ): ItemRow {
    const categoryId = this.resolveCategoryId(item, listedItem, existing);
    const categoryName = this.resolveCategoryName(
      item,
      listedItem,
      existing,
      categoryId,
      categoryNames
    );
    const modified = resolveDirect<string | null>(
      item,
      listedItem,
      'modified',
      undefined
    );
    const published = resolveDirect<boolean | null>(
      item,
      listedItem,
      'published',
      undefined
    );
    return {
      item_id: item.id,
      item_number: resolveDirect<number | null>(item, listedItem, 'item_number', existing?.item_number),
      name: resolveDirect<string>(item, listedItem, 'name', existing?.name) ?? 'Unknown',
      description: resolveDirect<string | null>(item, listedItem, 'description', existing?.description) ?? null,
      sku: resolveDirect<string | null>(item, listedItem, 'sku', existing?.sku) ?? null,
      serial_number: resolveDirect<string | null>(
        item,
        listedItem,
        'serial_number',
        existing?.serial_number
      ) ?? null,
      barcode: resolveDirect<string | null>(item, listedItem, 'barcode', existing?.barcode) ?? null,
      category_id: categoryId,
      category_name: categoryName,
      quantity: resolveDirect<number | null>(item, listedItem, 'quantity', existing?.quantity) ?? null,
      quantity_reserved: resolveDirect<number | null>(
        item,
        listedItem,
        'quantity_reserved',
        existing?.quantity_reserved
      ) ?? null,
      quantity_available: resolveDirect<number | null>(
        item,
        listedItem,
        'quantity_available',
        existing?.quantity_available
      ) ?? null,
      quantity_incoming: resolveDirect<number | null>(
        item,
        listedItem,
        'quantity_incoming',
        existing?.quantity_incoming
      ) ?? null,
      in_transit: resolveDirect<number | null>(
        item,
        listedItem,
        'in_transit',
        existing?.in_transit
      ) ?? null,
      threshold: resolveDirect<number | null>(item, listedItem, 'threshold', existing?.threshold) ?? null,
      cost: resolveDirect<number | null>(item, listedItem, 'cost', existing?.cost) ?? null,
      price: resolveDirect<number | null>(item, listedItem, 'price', existing?.price) ?? null,
      valuation: resolveDirect<number | null>(
        item,
        listedItem,
        'valuation',
        existing?.valuation
      ) ?? null,
      published: published === undefined
        ? existing?.published ?? null
        : published === null ? null : published ? 1 : 0,
      created: resolveDirect<string | null>(item, listedItem, 'created', existing?.created) ?? null,
      modified: modified === undefined ? existing?.modified ?? null : toUnix(modified ?? undefined),
      cache_source: 'api',
      imported_at: existing?.imported_at ?? null,
    };
  }

  private resolveCategoryId(
    item: Item,
    listedItem: Item,
    existing: ItemRow | undefined
  ): string | null {
    const resolved = firstPresence(
      directPresence<string | null>(item, 'category_id'),
      nestedPresence<string | null>(item, 'category', 'id'),
      directPresence<string | null>(listedItem, 'category_id'),
      nestedPresence<string | null>(listedItem, 'category', 'id')
    );
    return resolved.present ? resolved.value : existing?.category_id ?? null;
  }

  private resolveCategoryName(
    item: Item,
    listedItem: Item,
    existing: ItemRow | undefined,
    categoryId: string | null,
    categoryNames: Map<string, string>
  ): string | null {
    if (!categoryId) {
      const sourceIdentity = firstPresence(
        directPresence<string | null>(item, 'category_id'),
        nestedPresence<string | null>(item, 'category', 'id'),
        directPresence<string | null>(listedItem, 'category_id'),
        nestedPresence<string | null>(listedItem, 'category', 'id')
      );
      return sourceIdentity.present ? null : existing?.category_name ?? null;
    }
    const nestedName = firstPresence(
      compatibleCategoryNamePresence(item, categoryId),
      compatibleCategoryNamePresence(listedItem, categoryId)
    );
    const mapped = categoryNames.get(categoryId);
    if (mapped) return mapped;
    if (nestedName.present && nestedName.value) return nestedName.value;
    if (existing?.category_id === categoryId && existing.category_name) {
      return existing.category_name;
    }
    throw new Error(`Unable to resolve category ${categoryId} for item ${item.id}`);
  }

  private toStockRows(
    item: Item,
    listedItem: Item,
    itemRow: ItemRow,
    existingRows: ItemStockLocationRow[]
  ): ItemStockLocationRow[] {
    const rows: ItemStockLocationRow[] = [];
    const usedExistingIds = new Set<string>();
    const variationPresence = firstPresence(
      directPresence<ItemVariation[] | null>(item, 'item_variations'),
      directPresence<ItemVariation[] | null>(listedItem, 'item_variations')
    );
    const variations = variationPresence.present ? variationPresence.value ?? [] : [];

    const hasUniqueTopLevelRow = existingRows.length === 1
      && existingRows[0].variation_id == null;
    if (!variationPresence.present && existingRows.length > 0 && !hasUniqueTopLevelRow) {
      return existingRows.map((row) => (
        refreshRetainedStockRow(row, itemRow, item, listedItem)
      ));
    }

    for (const variation of variations) {
      const variationItemId = directPresence<string | null>(variation, 'item_id');
      if (variationItemId.present && variationItemId.value !== item.id) {
        throw new Error(
          `Variation ${variation.id} belongs to item ${String(variationItemId.value)}, not ${item.id}`
        );
      }
      const locationsPresence = directPresence<ItemVariationLocation[] | null>(
        variation,
        'item_variations_locations'
      );
      if (!locationsPresence.present) {
        for (const existing of existingRows.filter((row) => row.variation_id === variation.id)) {
          usedExistingIds.add(existing.stock_row_id);
          rows.push(refreshRetainedStockRow(existing, itemRow, item, listedItem));
        }
        continue;
      }
      for (const location of locationsPresence.value ?? []) {
        const locationVariationId = directPresence<string | null>(
          location,
          'item_variation_id'
        );
        if (locationVariationId.present && locationVariationId.value !== variation.id) {
          throw new Error(
            `Variation location ${String(location.id ?? '<unknown>')} belongs to variation `
            + `${String(locationVariationId.value)}, not ${variation.id}`
          );
        }
        const sourceRowId = directPresence<number | string | null>(location, 'id');
        const locationIdentity = coherentLocationIdentity(location);
        const candidateStockRowId = sourceRowId.present && sourceRowId.value != null
          ? String(sourceRowId.value)
          : syntheticId(
              'api-stock',
              item.id,
              variation.id,
              locationIdentity.identity.present
                ? locationIdentity.identity.value ?? 'none'
                : 'none'
            );
        const existing = findCompatibleStockRow(
          existingRows,
          usedExistingIds,
          candidateStockRowId,
          variation.id,
          location
        );
        if (existing) usedExistingIds.add(existing.stock_row_id);
        const stockRowId = !sourceRowId.present && existing
          ? existing.stock_row_id
          : candidateStockRowId;
        rows.push(this.toStockRow(
          itemRow,
          item,
          listedItem,
          variation.id,
          location,
          stockRowId,
          existing
        ));
      }
    }

    if (rows.length === 0) {
      const locationId = firstPresence(
        nestedNullablePresence<string | null>(item, 'location', 'id'),
        nestedNullablePresence<string | null>(listedItem, 'location', 'id')
      );
      const locationName = firstPresence(
        nestedNullablePresence<string | null>(item, 'location', 'name'),
        nestedNullablePresence<string | null>(listedItem, 'location', 'name')
      );
      const existing = findCompatibleTopLevelStockRow(
        existingRows,
        usedExistingIds,
        locationId
      );
      const resolvedLocationId = resolveSingle(locationId, existing?.location_id);
      const stockRowId = existing?.stock_row_id
        ?? syntheticId('api-stock', item.id, resolvedLocationId ?? 'default');
      const quantityOnHand = resolveItemStockField(
        item,
        listedItem,
        'quantity',
        itemRow.quantity,
        existing?.quantity_on_hand
      ) ?? 0;
      rows.push({
        stock_row_id: stockRowId,
        item_id: item.id,
        item_number: itemRow.item_number,
        variation_id: existing?.variation_id ?? null,
        variation_location_id: existing?.variation_location_id ?? null,
        location_id: resolvedLocationId ?? null,
        location_name: resolveSingle(locationName, existing?.location_name) ?? null,
        category_name: itemRow.category_name,
        quantity_on_hand: quantityOnHand,
        quantity_reserved: resolveItemStockField(
          item,
          listedItem,
          'quantity_reserved',
          itemRow.quantity_reserved,
          existing?.quantity_reserved
        ) ?? 0,
        quantity_available: resolveItemStockField(
          item,
          listedItem,
          'quantity_available',
          itemRow.quantity_available,
          existing?.quantity_available
        ) ?? quantityOnHand,
        quantity_incoming: resolveItemStockField(
          item,
          listedItem,
          'quantity_incoming',
          itemRow.quantity_incoming,
          existing?.quantity_incoming
        ) ?? 0,
        in_transit: resolveItemStockField(
          item,
          listedItem,
          'in_transit',
          itemRow.in_transit,
          existing?.in_transit
        ) ?? 0,
        price: resolveItemStockField(item, listedItem, 'price', itemRow.price, existing?.price),
        cost: resolveItemStockField(item, listedItem, 'cost', itemRow.cost, existing?.cost),
        valuation: resolveItemStockField(
          item,
          listedItem,
          'valuation',
          itemRow.valuation,
          existing?.valuation
        ),
        barcode: resolveItemStockField(
          item,
          listedItem,
          'barcode',
          itemRow.barcode,
          existing?.barcode
        ) ?? null,
        cache_source: 'api',
        imported_at: existing?.imported_at ?? null,
      });
    }

    return rows;
  }

  private toStockRow(
    item: ItemRow,
    sourceItem: Item,
    listedItem: Item,
    variationId: string,
    location: ItemVariationLocation,
    stockRowId: string,
    existing?: ItemStockLocationRow
  ): ItemStockLocationRow {
    const quantity = resolveSingle<number | null>(
      directPresence<number | null>(location, 'quantity'),
      existing?.quantity_on_hand
    ) ?? 0;
    const locationIdentity = coherentLocationIdentity(location);
    const locationId = resolveSingle(
      locationIdentity.identity,
      existing?.location_id
    );
    const locationName = resolveSingle(
      locationIdentity.coherent
        ? nestedNullablePresence<string | null>(location, 'location', 'name')
        : { present: false },
      existing?.location_name
    );
    const variationLocationId = directPresence<number | string | null>(location, 'id');
    return {
      stock_row_id: stockRowId,
      item_id: item.item_id,
      item_number: item.item_number,
      variation_id: variationId,
      variation_location_id: variationLocationId.present
        ? variationLocationId.value == null ? null : String(variationLocationId.value)
        : existing?.variation_location_id ?? null,
      location_id: locationId ?? null,
      location_name: locationName ?? null,
      category_name: item.category_name,
      quantity_on_hand: quantity,
      quantity_reserved: resolveSingle(
        directPresence<number | null>(location, 'quantity_reserved'),
        existing?.quantity_reserved
      ) ?? 0,
      quantity_available: resolveSingle(
        directPresence<number | null>(location, 'quantity_available'),
        existing?.quantity_available
      ) ?? quantity,
      quantity_incoming: resolveSingle(
        directPresence<number | null>(location, 'quantity_incoming'),
        existing?.quantity_incoming
      ) ?? 0,
      in_transit: resolveSingle(
        directPresence<number | null>(location, 'in_transit'),
        existing?.in_transit
      ) ?? 0,
      price: resolveItemStockField(
        sourceItem,
        listedItem,
        'price',
        item.price,
        existing?.price
      ),
      cost: resolveItemStockField(
        sourceItem,
        listedItem,
        'cost',
        item.cost,
        existing?.cost
      ),
      valuation: resolveSingle(
        directPresence<number | null>(location, 'valuation'),
        existing?.valuation
      ) ?? null,
      barcode: resolveItemStockField(
        sourceItem,
        listedItem,
        'barcode',
        item.barcode,
        existing?.barcode
      ) ?? null,
      cache_source: 'api',
      imported_at: existing?.imported_at ?? null,
    };
  }

  private async mergeState(
    state: CacheState | null,
    syncStartedAt: number,
    full: boolean
  ): Promise<CacheState> {
    return {
      ...state,
      lastSync: state?.lastSync ?? syncStartedAt,
      lastFullSync: state?.lastFullSync ?? syncStartedAt,
      documentCount: state?.documentCount ?? 0,
      itemDocumentCount: state?.itemDocumentCount ?? 0,
      accountName: this.accountName,
      schemaVersion: state?.schemaVersion ?? CACHE_PENDING_SCHEMA_VERSION,
      itemCount: await this.cache.getItemCount(),
      stockLocationCount: await this.cache.getStockLocationCount(),
      lastItemSync: syncStartedAt,
      ...(full ? { lastFullItemSync: syncStartedAt } : {}),
    };
  }
}

function syntheticId(...parts: string[]): string {
  return `api:${parts[0]}:${createHash('sha1').update(parts.slice(1).join('|')).digest('hex').slice(0, 24)}`;
}

type Presence<T> = { present: true; value: T } | { present: false };

function directPresence<T>(source: unknown, key: string): Presence<T> {
  if (!source || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, key)) {
    return { present: false };
  }
  return { present: true, value: (source as Record<string, unknown>)[key] as T };
}

function nestedPresence<T>(source: unknown, parentKey: string, key: string): Presence<T> {
  const parent = directPresence<unknown>(source, parentKey);
  if (!parent.present || !parent.value || typeof parent.value !== 'object') {
    return { present: false };
  }
  return directPresence<T>(parent.value, key);
}

function nestedNullablePresence<T>(source: unknown, parentKey: string, key: string): Presence<T> {
  const parent = directPresence<unknown>(source, parentKey);
  if (!parent.present) return { present: false };
  if (parent.value === null) return { present: true, value: null as T };
  if (typeof parent.value !== 'object') return { present: false };
  return directPresence<T>(parent.value, key);
}

function compatibleCategoryNamePresence(
  source: unknown,
  expectedCategoryId: string
): Presence<string | null> {
  const name = nestedPresence<string | null>(source, 'category', 'name');
  if (!name.present) return name;
  const identities = [
    directPresence<string | null>(source, 'category_id'),
    nestedPresence<string | null>(source, 'category', 'id'),
  ].filter((identity) => identity.present);
  if (
    identities.length === 0
    || identities.some((identity) => identity.present && identity.value !== expectedCategoryId)
  ) {
    return { present: false };
  }
  return name;
}

function firstPresence<T>(...values: Presence<T>[]): Presence<T> {
  return values.find((value) => value.present) ?? { present: false };
}

function resolvePresence<T>(
  detail: Presence<T>,
  listed: Presence<T>,
  existing: T | undefined
): T | undefined {
  if (detail.present) return detail.value;
  if (listed.present) return listed.value;
  return existing;
}

function resolveSingle<T>(source: Presence<T>, existing: T | undefined): T | undefined {
  return source.present ? source.value : existing;
}

function resolveDirect<T>(
  detail: unknown,
  listed: unknown,
  key: string,
  existing: T | undefined
): T | undefined {
  return resolvePresence(directPresence<T>(detail, key), directPresence<T>(listed, key), existing);
}

function resolveItemStockField<T>(
  detail: unknown,
  listed: unknown,
  key: string,
  resolvedItemValue: T | undefined,
  existingStockValue: T | undefined
): T | undefined {
  const source = firstPresence(
    directPresence<T>(detail, key),
    directPresence<T>(listed, key)
  );
  return source.present
    ? resolvedItemValue
    : resolvedItemValue ?? existingStockValue;
}

function refreshRetainedStockRow(
  row: ItemStockLocationRow,
  item: ItemRow,
  sourceItem: Item,
  listedItem: Item
): ItemStockLocationRow {
  return {
    ...row,
    item_number: item.item_number,
    category_name: item.category_name,
    price: resolveItemStockField(sourceItem, listedItem, 'price', item.price, row.price),
    cost: resolveItemStockField(sourceItem, listedItem, 'cost', item.cost, row.cost),
    barcode: resolveItemStockField(
      sourceItem,
      listedItem,
      'barcode',
      item.barcode,
      row.barcode
    ) ?? null,
  };
}

function findCompatibleTopLevelStockRow(
  existingRows: ItemStockLocationRow[],
  usedIds: Set<string>,
  locationId: Presence<string | null>
): ItemStockLocationRow | undefined {
  const unused = existingRows.filter((row) => (
    !usedIds.has(row.stock_row_id)
    && row.variation_id == null
  ));
  if (!locationId.present) return unused.length === 1 ? unused[0] : undefined;
  const matches = unused.filter((row) => (row.location_id ?? null) === locationId.value);
  if (matches.length === 1) return matches[0];
  return locationId.value === null && unused.length === 1 ? unused[0] : undefined;
}

function findCompatibleStockRow(
  existingRows: ItemStockLocationRow[],
  usedIds: Set<string>,
  stockRowId: string,
  variationId: string,
  location: ItemVariationLocation
): ItemStockLocationRow | undefined {
  const unused = existingRows.filter((row) => !usedIds.has(row.stock_row_id));
  const locationIdentity = coherentLocationIdentity(location);
  if (!locationIdentity.coherent) return undefined;
  const exact = unused.find((row) => row.stock_row_id === stockRowId);
  if (exact && isCompatibleStockIdentity(exact, variationId, location)) return exact;

  const variationLocationId = location.id == null ? null : String(location.id);
  if (variationLocationId) {
    const matches = unused.filter((row) => (
      row.variation_location_id === variationLocationId
      && isCompatibleStockIdentity(row, variationId, location)
    ));
    if (matches.length === 1) return matches[0];
  }

  const composite = unused.filter((row) => (
    row.variation_id === variationId
    && (row.location_id ?? null) === (
      locationIdentity.identity.present ? locationIdentity.identity.value : null
    )
  ));
  if (composite.length === 1) return composite[0];

  const rowIdentity = directPresence<number | string | null>(location, 'id');
  if (
    !rowIdentity.present
    && (!locationIdentity.identity.present || locationIdentity.identity.value === null)
  ) {
    const variationMatches = unused.filter((row) => (
      row.variation_id === variationId
      && isCompatibleStockIdentity(row, variationId, location)
    ));
    if (variationMatches.length === 1) return variationMatches[0];
  }
  return undefined;
}

function isCompatibleStockIdentity(
  existing: ItemStockLocationRow,
  variationId: string,
  location: ItemVariationLocation
): boolean {
  const locationIdentity = coherentLocationIdentity(location);
  if (!locationIdentity.coherent) return false;
  const locationId = locationIdentity.identity.present ? locationIdentity.identity.value : null;
  return (
    (existing.variation_id == null || existing.variation_id === variationId)
    && (
      existing.variation_location_id == null
      || location.id == null
      || existing.variation_location_id === String(location.id)
    )
    && (existing.location_id == null || locationId == null || existing.location_id === locationId)
  );
}

function coherentLocationIdentity(location: ItemVariationLocation): {
  identity: Presence<string | null>;
  coherent: boolean;
} {
  const direct = directPresence<string | null>(location, 'location_id');
  const nested = nestedNullablePresence<string | null>(location, 'location', 'id');
  return {
    identity: direct.present ? direct : nested,
    coherent: !direct.present || !nested.present || direct.value === nested.value,
  };
}

function toUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
