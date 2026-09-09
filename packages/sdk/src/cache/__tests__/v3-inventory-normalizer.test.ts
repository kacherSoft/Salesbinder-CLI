import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation } from '../../types/items.types.js';
import { normalizeV3InventoryItem } from '../v3-inventory-normalizer.js';
import { resolveAvailableQuantity } from '../inventory-available-quantity.js';

describe('v3 inventory normalizer field continuity', () => {
  it('inherits explicit null variation overrides from the observed parent values', () => {
    const normalized = normalizeV3InventoryItem(item(), [variation()], null);
    expect(normalized.item).toMatchObject({ price: 10, cost: 5 });
    expect(normalized.stockRows[0]).toMatchObject({ price: 10, cost: 5 });
  });

  it('uses authoritative variation overrides, including zero', () => {
    const normalized = normalizeV3InventoryItem(
      item(),
      [variation({ unit_price_override: '0.0000', unit_cost_override: '0.0000' })],
      null
    );
    expect(normalized.stockRows[0]).toMatchObject({ price: 0, cost: 0 });
  });

  it('applies one variation override to each visible variation location', () => {
    const source = variation({ unit_price_override: '7.5000', unit_cost_override: '2.5000' });
    source.location_count = 2;
    source.locations = [location(42, 1), location(43, 2)];
    const normalized = normalizeV3InventoryItem(item(), [source], null);
    expect(normalized.stockRows).toHaveLength(2);
    expect(normalized.stockRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variation_location_id: '42', price: 7.5, cost: 2.5 }),
        expect.objectContaining({ variation_location_id: '43', price: 7.5, cost: 2.5 }),
      ])
    );
  });

  it('accepts explicitly null observed parent price and cost', () => {
    const normalized = normalizeV3InventoryItem(
      { ...item(), price: null, cost: null, variation_count: 0 },
      [],
      null
    );
    expect(normalized.item).toMatchObject({ price: null, cost: null });
    expect(normalized.stockRows[0]).toMatchObject({ price: null, cost: null });
  });

  it('keeps item and direct-location availability at their own scopes', () => {
    const source = item() as V3Item & { quantity_available?: number };
    source.variation_count = 0;
    source.quantity = 10;
    source.quantity_reserved = 2;
    source.location_id = 'location-1';
    source.location_inventory = {
      location_id: 'location-1',
      quantity: 10,
      quantity_reserved: 2,
      quantity_available: 6,
      quantity_incoming: 0,
      threshold: 0,
    };

    const normalized = normalizeV3InventoryItem(source, [], null);

    expect(normalized.item).toMatchObject({
      quantity_available: 8,
      quantity_available_source: 'computed',
    });
    expect(normalized.stockRows[0]).toMatchObject({
      quantity_available: 6,
      quantity_available_source: 'api',
    });
  });

  it('prefers observed same-scope variation availability and computes signed peers', () => {
    const observed = variation({ quantity_available: 99 });
    observed.quantity = 5;
    observed.quantity_reserved = 2;
    const computed = variation({ id: 'variation-2', quantity: 5, quantity_reserved: -2 });
    const normalized = normalizeV3InventoryItem(item(), [observed, computed], null);

    expect(normalized.stockRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variation_id: 'variation-1',
          quantity_available: 99,
          quantity_available_source: 'api',
        }),
        expect.objectContaining({
          variation_id: 'variation-2',
          quantity_available: 7,
          quantity_available_source: 'computed',
        }),
      ])
    );
  });

  it('leaves availability unknown when either computation operand is missing', () => {
    expect(resolveAvailableQuantity(null, 5, null)).toEqual({
      quantityAvailable: null,
      quantityAvailableSource: null,
    });
    expect(resolveAvailableQuantity(null, null, -2)).toEqual({
      quantityAvailable: null,
      quantityAvailableSource: null,
    });
  });

  it('rejects absent parent cost or price before a replacement can publish', () => {
    for (const field of ['cost', 'price'] as const) {
      const source = item() as unknown as Record<string, unknown>;
      delete source[field];
      expectValidationError(
        () => normalizeV3InventoryItem(source as unknown as V3Item, [], null),
        'record'
      );
    }
  });

  it('rejects absent or malformed variation overrides before a replacement can publish', () => {
    const missingPrice = variation() as unknown as Record<string, unknown>;
    delete missingPrice.unit_price_override;
    expectValidationError(
      () => normalizeV3InventoryItem(item(), [missingPrice as unknown as V3ItemVariation], null),
      'variations'
    );
    const missingCost = variation() as unknown as Record<string, unknown>;
    delete missingCost.unit_cost_override;
    expectValidationError(
      () => normalizeV3InventoryItem(item(), [missingCost as unknown as V3ItemVariation], null),
      'variations'
    );
    expectValidationError(
      () => normalizeV3InventoryItem(item(), [variation({ unit_price_override: 'bad' })], null),
      'variations'
    );
  });
});

function expectValidationError(action: () => void, sourceScope: 'record' | 'variations'): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiResponseValidationError);
  expect(thrown).toMatchObject({ sourceScope });
}

function item(): V3Item {
  return {
    id: 'item-1',
    object: 'item',
    item_number: 1,
    name: 'Widget',
    description: null,
    sku: null,
    barcode: null,
    serial_number: null,
    inventory_type: 'quantity',
    category_id: null,
    category_name: null,
    status_id: 12,
    location_id: null,
    price: '10.0000',
    cost: '5.0000',
    quantity: 3,
    quantity_reserved: 0,
    quantity_incoming: 0,
    threshold: 0,
    variation_count: 1,
    published: true,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function variation(
  overrides: Partial<V3ItemVariation> = {}
): V3ItemVariation {
  return {
    id: 'variation-1',
    object: 'item_variation',
    item_id: 'item-1',
    barcode: 'W-1',
    quantity: 3,
    quantity_reserved: 0,
    quantity_incoming: 0,
    in_transit: 0,
    location_count: 0,
    unit_price_override: null,
    unit_cost_override: null,
    ...overrides,
  };
}

function location(id: number, quantity: number) {
  return {
    object: 'item_variation_location' as const,
    item_variation_location_id: id,
    location_id: `location-${id}`,
    location_name: `Location ${id}`,
    quantity,
    quantity_reserved: 0,
    quantity_incoming: 0,
    in_transit: 0,
    threshold: null,
  };
}
