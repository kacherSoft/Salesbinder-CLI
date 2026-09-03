const DECIMAL_TEXT_PATTERN = /^-?\d+(?:\.\d+)?$/;

export function parseSalesBinderFiniteDecimal(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !DECIMAL_TEXT_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
