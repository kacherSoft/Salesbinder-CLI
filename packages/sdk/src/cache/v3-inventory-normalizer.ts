import { createHash } from 'node:crypto';
import type { V3Item, V3ItemVariation } from '../types/items.types.js';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { ItemRow, ItemStockLocationRow } from './types.js';
import { isValidSalesBinderTimestampText } from './salesbinder-source-date-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface NormalizedV3InventoryItem {
  item: ItemRow;
  stockRows: ItemStockLocationRow[];
}

export function normalizeV3InventoryItem(
  item: V3Item,
  variations: V3ItemVariation[],
  categoryNames: Map<string, string> | null
): NormalizedV3InventoryItem {
  if (item.object !== 'item') throw invalidRecord('Invalid v3 item object');
  if (item.inventory_type !== 'quantity' && item.inventory_type !== 'unique') {
    throw invalidRecord('Invalid v3 item inventory_type');
  }
  const itemNumber = requiredJsonInteger(
    item.item_number,
    'item number',
    'record',
    POSTGRES_INTEGER_MAX
  );
  requiredJsonInteger(item.status_id, 'item status id');
  requiredJsonInteger(item.variation_count, 'item variation_count');
  const locationId = nullableCanonicalText(item.location_id, 'item location_id');
  const quantityAvailable = validateLocationInventory(item.location_inventory, locationId);
  const categoryId = nullableCanonicalText(item.category_id, 'item category_id');
  const quantity = requiredJsonNumber(item.quantity, 'item quantity');
  const reserved = requiredJsonNumber(item.quantity_reserved, 'item reserved quantity');
  const incoming = requiredJsonNumber(item.quantity_incoming, 'item incoming quantity');
  const price = optionalDecimalNumber(item.price, 'item price');
  const cost = optionalDecimalNumber(item.cost, 'item cost');
  const categoryName = canonicalCategoryName(item, categoryId, categoryNames);
  const archived = requiredBoolean(item.archived, 'item archived');
  const sku = nullableIdentifierText(item.sku, 'item sku');
  const serialNumber = nullableIdentifierText(item.serial_number, 'item serial_number');
  const barcode = nullableIdentifierText(item.barcode, 'item barcode');
  const inTransit = variations.length === 0 ? null : sumVariationInTransit(variations);
  const stockRows =
    variations.length === 0
      ? [
          parentStockRow(
            item,
            itemNumber,
            locationId,
            quantity,
            reserved,
            quantityAvailable,
            incoming,
            categoryName,
            price,
            cost,
            barcode
          ),
        ]
      : variations.flatMap((variation) =>
          variationStockRows(item, itemNumber, variation, categoryName, price, cost, barcode)
        );
  if (variations.length > 0) assertUniqueVariationStockRowIds(stockRows);

  return {
    item: {
      item_id: requiredText(item.id, 'item id'),
      item_number: itemNumber,
      name: itemDisplayName(item, itemNumber, archived),
      description: nullableDisplayText(item.description),
      sku,
      serial_number: serialNumber,
      barcode,
      category_id: categoryId,
      category_name: categoryName,
      quantity,
      quantity_reserved: reserved,
      quantity_available: quantityAvailable,
      quantity_incoming: incoming,
      in_transit: inTransit,
      threshold: requiredJsonNumber(item.threshold, 'item threshold'),
      cost,
      price,
      published: requiredBoolean(item.published, 'item published') ? 1 : 0,
      archived: archived ? 1 : 0,
      created: requiredSalesBinderTimestamp(item.created_at, 'created_at'),
      modified: toUnix(item.updated_at),
      cache_source: 'api',
      source_api_version: '3',
    },
    stockRows,
  };
}

function assertUniqueVariationStockRowIds(stockRows: ItemStockLocationRow[]): void {
  const stockRowIds = new Set<string>();
  for (const row of stockRows) {
    if (!row.stock_row_id || stockRowIds.has(row.stock_row_id)) {
      throw invalidVariations('Duplicate or missing v3 variation stock row ID');
    }
    stockRowIds.add(row.stock_row_id);
  }
}

function sumVariationInTransit(variations: V3ItemVariation[]): number {
  let total = 0;
  for (const variation of variations) {
    total += requiredJsonNumber(
      variation.in_transit,
      'variation in-transit quantity',
      'variations'
    );
    if (!Number.isFinite(total)) {
      throw invalidVariations('Invalid v3 aggregate in-transit quantity');
    }
  }
  return total;
}

function parentStockRow(
  item: V3Item,
  itemNumber: number,
  locationId: string | null,
  quantity: number,
  reserved: number,
  quantityAvailable: number | null,
  incoming: number,
  categoryName: string | null,
  price: number | null,
  cost: number | null,
  barcode: string | null
): ItemStockLocationRow {
  return {
    stock_row_id: syntheticId('v3-parent-stock', item.id, locationId ?? 'default'),
    location_id: locationId,
    location_name: null,
    quantity_on_hand: quantity,
    quantity_reserved: reserved,
    quantity_available: quantityAvailable,
    quantity_incoming: incoming,
    in_transit: null,
    ...commonStockRowFields(item, itemNumber, categoryName, price, cost, barcode),
  };
}

function variationStockRows(
  item: V3Item,
  itemNumber: number,
  variation: V3ItemVariation,
  categoryName: string | null,
  price: number | null,
  cost: number | null,
  itemBarcode: string | null
): ItemStockLocationRow[] {
  if (variation.object !== 'item_variation' || variation.item_id !== item.id) {
    throw invalidVariations(`Invalid v3 variation identity for item ${item.id}`);
  }
  if (variation.locations != null && !Array.isArray(variation.locations)) {
    throw invalidVariations(`Invalid v3 variation locations for item ${item.id}`);
  }
  const locations = variation.locations ?? [];
  if (
    requiredJsonInteger(variation.location_count, 'variation location_count', 'variations') !==
    locations.length
  ) {
    throw invalidVariations(
      `Incomplete v3 variation locations for item ${item.id}, variation ${variation.id}`
    );
  }
  if (Array.isArray(variation.locations)) {
    assertVisibleLocationTotals(variation, locations);
  }
  const barcode =
    nullableIdentifierText(variation.barcode, 'variation barcode', 'variations') ?? itemBarcode;
  if (locations.length === 0) {
    return [
      {
        stock_row_id: syntheticId('v3-variation-stock', item.id, variation.id, 'aggregate'),
        variation_id: variation.id,
        variation_location_id: null,
        location_id: null,
        location_name: null,
        quantity_on_hand: requiredJsonNumber(
          variation.quantity,
          'variation quantity',
          'variations'
        ),
        quantity_reserved: requiredJsonNumber(
          variation.quantity_reserved,
          'variation reserved quantity',
          'variations'
        ),
        quantity_available: null,
        quantity_incoming: requiredJsonNumber(
          variation.quantity_incoming,
          'variation incoming quantity',
          'variations'
        ),
        in_transit: requiredJsonNumber(
          variation.in_transit,
          'variation in-transit quantity',
          'variations'
        ),
        ...commonStockRowFields(item, itemNumber, categoryName, price, cost, barcode),
      },
    ];
  }
  return locations.map((location) => {
    if (!isRecord(location) || location.object !== 'item_variation_location') {
      throw invalidVariations(`Invalid v3 variation-location object for item ${item.id}`);
    }
    const variationLocationId = requiredJsonInteger(
      location.item_variation_location_id,
      'variation-location id',
      'variations'
    );
    optionalJsonNumber(location.threshold, 'variation-location threshold', 'variations');
    return {
      stock_row_id: String(variationLocationId),
      variation_id: variation.id,
      variation_location_id: String(variationLocationId),
      location_id: requiredCanonicalText(
        location.location_id,
        'variation location id',
        'variations'
      ),
      location_name: nullableDisplayText(location.location_name, 'variations'),
      quantity_on_hand: requiredJsonNumber(
        location.quantity,
        'variation-location quantity',
        'variations'
      ),
      quantity_reserved: requiredJsonNumber(
        location.quantity_reserved,
        'variation-location reserved quantity',
        'variations'
      ),
      quantity_available: null,
      quantity_incoming: requiredJsonNumber(
        location.quantity_incoming,
        'variation-location incoming quantity',
        'variations'
      ),
      in_transit: requiredJsonNumber(
        location.in_transit,
        'variation-location in-transit quantity',
        'variations'
      ),
      ...commonStockRowFields(item, itemNumber, categoryName, price, cost, barcode),
    };
  });
}

interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

interface VariationTotals {
  quantity: DecimalValue;
  reserved: DecimalValue;
  incoming: DecimalValue;
  inTransit: DecimalValue;
}

function assertVisibleLocationTotals(
  variation: V3ItemVariation,
  locations: NonNullable<V3ItemVariation['locations']>
): void {
  const variationTotals: VariationTotals = {
    quantity: requiredDecimal(variation.quantity, 'variation quantity'),
    reserved: requiredDecimal(variation.quantity_reserved, 'variation reserved quantity'),
    incoming: requiredDecimal(variation.quantity_incoming, 'variation incoming quantity'),
    inTransit: requiredDecimal(variation.in_transit, 'variation in-transit quantity'),
  };
  const locationTotals = locations.reduce<VariationTotals>((totals, location) => {
    if (!isRecord(location) || location.object !== 'item_variation_location') {
      throw invalidVariations('Invalid v3 variation-location object');
    }
    return {
      quantity: addDecimal(
        totals.quantity,
        requiredDecimal(location.quantity, 'variation-location quantity')
      ),
      reserved: addDecimal(
        totals.reserved,
        requiredDecimal(location.quantity_reserved, 'variation-location reserved quantity')
      ),
      incoming: addDecimal(
        totals.incoming,
        requiredDecimal(location.quantity_incoming, 'variation-location incoming quantity')
      ),
      inTransit: addDecimal(
        totals.inTransit,
        requiredDecimal(location.in_transit, 'variation-location in-transit quantity')
      ),
    };
  }, zeroVariationTotals());
  if (
    !sameDecimal(variationTotals.quantity, locationTotals.quantity) ||
    !sameDecimal(variationTotals.reserved, locationTotals.reserved) ||
    !sameDecimal(variationTotals.incoming, locationTotals.incoming) ||
    !sameDecimal(variationTotals.inTransit, locationTotals.inTransit)
  ) {
    throw invalidVariations('V3 variation totals do not match visible location totals');
  }
}

function zeroVariationTotals(): VariationTotals {
  return {
    quantity: zeroDecimal(),
    reserved: zeroDecimal(),
    incoming: zeroDecimal(),
    inTransit: zeroDecimal(),
  };
}

function requiredDecimal(value: unknown, field: string): DecimalValue {
  return decimalFromNumber(requiredJsonNumber(value, field, 'variations'));
}

function decimalFromNumber(value: number): DecimalValue {
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const negative = mantissa.startsWith('-');
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [integer = '0', fraction = ''] = unsignedMantissa.split('.');
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  return {
    coefficient: BigInt(`${negative ? '-' : ''}${digits}`),
    scale: fraction.length - exponent,
  };
}

function addDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * powerOfTen(scale - left.scale) +
      right.coefficient * powerOfTen(scale - right.scale),
    scale,
  };
}

function sameDecimal(left: DecimalValue, right: DecimalValue): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.coefficient * powerOfTen(scale - left.scale) ===
    right.coefficient * powerOfTen(scale - right.scale)
  );
}

function zeroDecimal(): DecimalValue {
  return { coefficient: 0n, scale: 0 };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function commonStockRowFields(
  item: V3Item,
  itemNumber: number,
  categoryName: string | null,
  price: number | null,
  cost: number | null,
  barcode: string | null
): Pick<
  ItemStockLocationRow,
  | 'item_id'
  | 'item_number'
  | 'category_name'
  | 'price'
  | 'cost'
  | 'barcode'
  | 'cache_source'
  | 'source_api_version'
> {
  return {
    item_id: item.id,
    item_number: itemNumber,
    category_name: categoryName,
    price,
    cost,
    barcode,
    cache_source: 'api',
    source_api_version: '3',
  };
}

function canonicalCategoryName(
  item: V3Item,
  categoryId: string | null,
  names: Map<string, string> | null
): string | null {
  if (!names) return nullableDisplayText(item.category_name);
  return categoryId ? (names.get(categoryId) ?? null) : null;
}

function validateLocationInventory(value: unknown, itemLocationId: string | null): number | null {
  if (value == null) return null;
  if (!isRecord(value)) throw invalidRecord('Invalid v3 item location_inventory');
  const inventoryLocationId = requiredCanonicalText(
    value.location_id,
    'location_inventory location_id'
  );
  if (!itemLocationId || inventoryLocationId !== itemLocationId) {
    throw invalidRecord('Mismatched v3 item location_inventory identity');
  }
  requiredJsonNumber(value.quantity, 'location_inventory quantity');
  requiredJsonNumber(value.quantity_reserved, 'location_inventory reserved quantity');
  const quantityAvailable = requiredJsonNumber(
    value.quantity_available,
    'location_inventory available quantity'
  );
  requiredJsonNumber(value.quantity_incoming, 'location_inventory incoming quantity');
  requiredJsonNumber(value.threshold, 'location_inventory threshold');
  return quantityAvailable;
}

function requiredText(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record'
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new ApiResponseValidationError(`Invalid v3 ${field}`, scope);
  }
  return value.trim();
}

function itemDisplayName(item: V3Item, itemNumber: number, archived: boolean): string {
  try {
    return requiredText(item.name, 'item name');
  } catch (error) {
    if (!archived || !(error instanceof ApiResponseValidationError)) throw error;
    for (const candidate of [item.sku, item.barcode, item.serial_number]) {
      if (typeof candidate === 'string' && candidate.trim() && !candidate.includes('\0')) {
        return requiredText(candidate, 'archived item fallback name');
      }
    }
    return `Unnamed archived item ${itemNumber || item.id}`;
  }
}

function requiredCanonicalText(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record'
): string {
  const text = requiredText(value, field, scope);
  if (text !== value || text.length > 256 || hasControlCharacter(text)) {
    throw new ApiResponseValidationError(`Invalid v3 ${field}`, scope);
  }
  return text;
}

function nullableCanonicalText(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  return requiredCanonicalText(value, field);
}

function nullableDisplayText(
  value: unknown,
  scope: 'record' | 'variations' = 'record'
): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || hasUnpairedUtf16Surrogate(value)) {
    throw new ApiResponseValidationError('Invalid v3 text value', scope);
  }
  // PostgreSQL text cannot contain U+0000. The legacy API has returned it in
  // optional display/free-text fields, so remove only that code point here;
  // canonical IDs still go through strict validation above.
  const sanitized = value.replace(/\0/g, '');
  return sanitized === '' ? null : sanitized;
}

function nullableIdentifierText(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record'
): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || hasControlCharacter(value) || hasUnpairedUtf16Surrogate(value)) {
    throw new ApiResponseValidationError(`Invalid v3 ${field}`, scope);
  }
  return value;
}

function requiredJsonNumber(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record'
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiResponseValidationError(`Invalid or missing v3 ${field}`, scope);
  }
  return value;
}

function optionalJsonNumber(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record'
): number | null {
  if (value == null) return null;
  return requiredJsonNumber(value, field, scope);
}

function optionalDecimalNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalidRecord(`Invalid v3 ${field}`);
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (parsed === undefined) throw invalidRecord(`Invalid v3 ${field}`);
  return parsed;
}

function requiredJsonInteger(
  value: unknown,
  field: string,
  scope: 'record' | 'variations' = 'record',
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const parsed = requiredJsonNumber(value, field, scope);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new ApiResponseValidationError(`Invalid v3 ${field}`, scope);
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidRecord(`Invalid v3 ${field}`);
  return value;
}

function requiredSalesBinderTimestamp(value: unknown, field: string): string {
  if (!isValidSalesBinderTimestampText(value)) throw invalidRecord(`Invalid v3 ${field}`);
  return value;
}

function toUnix(value: unknown): number {
  const timestamp = requiredSalesBinderTimestamp(value, 'updated_at');
  const milliseconds = new Date(timestamp).getTime();
  if (!Number.isFinite(milliseconds)) throw invalidRecord('Invalid v3 updated_at');
  return Math.floor(milliseconds / 1000);
}

function syntheticId(...parts: string[]): string {
  return `api:${parts[0]}:${createHash('sha1').update(parts.slice(1).join('|')).digest('hex').slice(0, 24)}`;
}

function invalidRecord(message: string): ApiResponseValidationError {
  return new ApiResponseValidationError(message, 'record');
}

function invalidVariations(message: string): ApiResponseValidationError {
  return new ApiResponseValidationError(message, 'variations');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
