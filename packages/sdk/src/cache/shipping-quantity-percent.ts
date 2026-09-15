export interface ShippingQuantity {
  quantity: number;
  quantityShipped?: number | null;
}

/**
 * Returns a quantity-weighted shipping percentage only when every relevant
 * inventory line has an observable, valid shipped quantity.
 */
export function shippingPercentFromQuantities(lines: readonly ShippingQuantity[]): number | null {
  let totalQuantity = 0;
  let totalShipped = 0;

  for (const line of lines) {
    if (!finiteQuantity(line.quantity)) return null;
    const shipped = line.quantityShipped;
    if (shipped == null || !finiteQuantity(shipped) || shipped > line.quantity) return null;

    totalQuantity += line.quantity;
    totalShipped += shipped;
    if (!Number.isFinite(totalQuantity) || !Number.isFinite(totalShipped)) return null;
  }

  if (totalQuantity <= 0) return null;
  const percent = (totalShipped / totalQuantity) * 100;
  return Number.isFinite(percent) ? percent : null;
}

function finiteQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
