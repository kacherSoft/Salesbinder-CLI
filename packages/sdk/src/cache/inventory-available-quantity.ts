import type { QuantityAvailableSource } from './types.js';

export interface AvailableQuantity {
  quantityAvailable: number | null;
  quantityAvailableSource: QuantityAvailableSource;
}
/** Prefer an observed same-scope balance, otherwise derive it from same-row operands. */
export function resolveAvailableQuantity(
  observed: number | null | undefined,
  quantity: number | null | undefined,
  reserved: number | null | undefined
): AvailableQuantity {
  if (observed != null) {
    return { quantityAvailable: observed, quantityAvailableSource: 'api' };
  }
  if (quantity == null || reserved == null) {
    return { quantityAvailable: null, quantityAvailableSource: null };
  }
  const computed = quantity - reserved;
  return Number.isFinite(computed)
    ? { quantityAvailable: computed, quantityAvailableSource: 'computed' }
    : { quantityAvailable: null, quantityAvailableSource: null };
}
