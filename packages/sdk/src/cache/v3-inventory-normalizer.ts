import { createHash } from 'node:crypto';
import type { V3Item, V3ItemVariation } from '../types/items.types.js';
import type { ItemRow, ItemStockLocationRow } from './types.js';

export interface NormalizedV3InventoryItem {
  item: ItemRow;
  stockRows: ItemStockLocationRow[];
}

export function normalizeV3InventoryItem(
  item: V3Item,
  variations: V3ItemVariation[],
  categoryNames: Map<string, string> | null,
): NormalizedV3InventoryItem {
  if (item.object !== 'item') throw new Error('Invalid v3 item object');
  if (item.inventory_type !== 'quantity' && item.inventory_type !== 'unique') {
    throw new Error('Invalid v3 item inventory_type');
  }
  const quantity = requiredNumber(item.quantity, 'item quantity');
  const reserved = requiredNumber(item.quantity_reserved, 'item reserved quantity');
  const incoming = requiredNumber(item.quantity_incoming, 'item incoming quantity');
  const categoryName = canonicalCategoryName(item, categoryNames);
  const stockRows = variations.length === 0
    ? [parentStockRow(item, quantity, reserved, incoming, categoryName)]
    : variations.flatMap((variation) => variationStockRows(item, variation, categoryName));

  return {
    item: {
      item_id: requiredText(item.id, 'item id'),
      item_number: requiredInteger(item.item_number, 'item number'),
      name: requiredText(item.name, 'item name'),
      description: nullableText(item.description),
      sku: nullableText(item.sku),
      serial_number: nullableText(item.serial_number),
      barcode: nullableText(item.barcode),
      category_id: nullableText(item.category_id),
      category_name: categoryName,
      quantity,
      quantity_reserved: reserved,
      quantity_available: optionalNumber(item.location_inventory?.quantity_available),
      quantity_incoming: incoming,
      in_transit: variations.length === 0
        ? null
        : variations.reduce((total, variation) => total + requiredNumber(variation.in_transit, 'variation in-transit quantity'), 0),
      threshold: requiredNumber(item.threshold, 'item threshold'),
      cost: optionalNumber(item.cost),
      price: optionalNumber(item.price),
      published: requiredBoolean(item.published, 'item published') ? 1 : 0,
      archived: requiredBoolean(item.archived, 'item archived') ? 1 : 0,
      created: requiredText(item.created_at, 'item created_at'),
      modified: toUnix(item.updated_at),
      cache_source: 'api',
      source_api_version: '3',
    },
    stockRows,
  };
}

function parentStockRow(
  item: V3Item,
  quantity: number,
  reserved: number,
  incoming: number,
  categoryName: string | null,
): ItemStockLocationRow {
  return {
    stock_row_id: syntheticId('v3-parent-stock', item.id, item.location_id ?? 'default'),
    item_id: item.id,
    item_number: item.item_number,
    location_id: item.location_id,
    location_name: null,
    category_name: categoryName,
    quantity_on_hand: quantity,
    quantity_reserved: reserved,
    quantity_available: optionalNumber(item.location_inventory?.quantity_available),
    quantity_incoming: incoming,
    in_transit: null,
    price: optionalNumber(item.price),
    cost: optionalNumber(item.cost),
    barcode: nullableText(item.barcode),
    cache_source: 'api',
    source_api_version: '3',
  };
}

function variationStockRows(
  item: V3Item,
  variation: V3ItemVariation,
  categoryName: string | null,
): ItemStockLocationRow[] {
  if (variation.object !== 'item_variation' || variation.item_id !== item.id) {
    throw new Error(`Invalid v3 variation identity for item ${item.id}`);
  }
  const locations = variation.locations ?? [];
  if (requiredInteger(variation.location_count, 'variation location_count') !== locations.length) {
    throw new Error(`Incomplete v3 variation locations for item ${item.id}, variation ${variation.id}`);
  }
  if (locations.length === 0) {
    return [{
      stock_row_id: syntheticId('v3-variation-stock', item.id, variation.id, 'aggregate'),
      item_id: item.id,
      item_number: item.item_number,
      variation_id: variation.id,
      variation_location_id: null,
      location_id: null,
      location_name: null,
      category_name: categoryName,
      quantity_on_hand: requiredNumber(variation.quantity, 'variation quantity'),
      quantity_reserved: requiredNumber(variation.quantity_reserved, 'variation reserved quantity'),
      quantity_available: null,
      quantity_incoming: requiredNumber(variation.quantity_incoming, 'variation incoming quantity'),
      in_transit: requiredNumber(variation.in_transit, 'variation in-transit quantity'),
      price: optionalNumber(item.price),
      cost: optionalNumber(item.cost),
      barcode: nullableText(variation.barcode) ?? nullableText(item.barcode),
      cache_source: 'api',
      source_api_version: '3',
    }];
  }
  return locations.map((location) => {
    if (location.object !== 'item_variation_location') {
      throw new Error(`Invalid v3 variation-location object for item ${item.id}`);
    }
    return {
      stock_row_id: String(requiredInteger(location.item_variation_location_id, 'variation-location id')),
      item_id: item.id,
      item_number: item.item_number,
      variation_id: variation.id,
      variation_location_id: String(location.item_variation_location_id),
      location_id: requiredText(location.location_id, 'variation location id'),
      location_name: nullableText(location.location_name),
      category_name: categoryName,
      quantity_on_hand: requiredNumber(location.quantity, 'variation-location quantity'),
      quantity_reserved: requiredNumber(location.quantity_reserved, 'variation-location reserved quantity'),
      quantity_available: null,
      quantity_incoming: requiredNumber(location.quantity_incoming, 'variation-location incoming quantity'),
      in_transit: requiredNumber(location.in_transit, 'variation-location in-transit quantity'),
      price: optionalNumber(item.price),
      cost: optionalNumber(item.cost),
      barcode: nullableText(variation.barcode) ?? nullableText(item.barcode),
      cache_source: 'api',
      source_api_version: '3',
    };
  });
}

function canonicalCategoryName(item: V3Item, names: Map<string, string> | null): string | null {
  if (!names) return nullableText(item.category_name);
  return item.category_id ? names.get(item.category_id) ?? null : null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid v3 ${field}`);
  }
  return value.trim();
}

function nullableText(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid v3 text value');
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = optionalNumber(value);
  if (parsed == null) throw new Error(`Invalid or missing v3 ${field}`);
  return parsed;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Invalid v3 numeric value');
  return parsed;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = requiredNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid v3 ${field}`);
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid v3 ${field}`);
  return value;
}

function toUnix(value: unknown): number {
  const date = new Date(requiredText(value, 'updated_at'));
  if (Number.isNaN(date.getTime())) throw new Error('Invalid v3 updated_at');
  return Math.floor(date.getTime() / 1000);
}

function syntheticId(...parts: string[]): string {
  return `api:${parts[0]}:${createHash('sha1').update(parts.slice(1).join('|')).digest('hex').slice(0, 24)}`;
}
