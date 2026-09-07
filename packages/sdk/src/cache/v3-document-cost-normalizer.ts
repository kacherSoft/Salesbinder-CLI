import { DocumentRecordError } from './document-source-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';

export type OfficialV3DocumentLineKind = 'inventory' | 'service' | 'discount';
export type OfficialV3CostResource = 'invoice' | 'estimate' | 'purchase_order';

export interface OfficialV3LineCost {
  unitCost: number | null;
  aggregateCostUnits: bigint;
}

export function normalizeOfficialV3LineCost(
  line: Record<string, unknown>,
  resource: OfficialV3CostResource,
  kind: OfficialV3DocumentLineKind
): OfficialV3LineCost {
  if (resource === 'purchase_order') {
    const aggregateCost = requiredLineMoney(line, 'subtotal');
    return {
      unitCost: kind === 'discount' ? null : requiredLineMoney(line, 'unit_cost').value,
      aggregateCostUnits: aggregateCost.units,
    };
  }
  if (!hasOwn(line, 'unit_cost') || !hasOwn(line, 'total_cost')) throw invalid();
  if (kind === 'discount') {
    if (line.unit_cost != null || line.total_cost != null) throw invalid();
    return { unitCost: null, aggregateCostUnits: 0n };
  }
  const aggregateCost = requiredLineMoney(line, 'total_cost');
  return {
    unitCost: requiredLineMoney(line, 'unit_cost').value,
    aggregateCostUnits: aggregateCost.units,
  };
}

export function documentCostFromUnits(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw invalid();
  }
  return Number(value) / 10_000;
}

function requiredLineNumber(line: Record<string, unknown>, key: string): number {
  if (!hasOwn(line, key) || line[key] == null) throw invalid();
  const parsed = parseSalesBinderFiniteDecimal(line[key]);
  if (parsed === undefined) throw invalid();
  return parsed;
}

function requiredLineMoney(
  line: Record<string, unknown>,
  key: string
): { value: number; units: bigint } {
  const value = requiredLineNumber(line, key);
  return { value, units: parseFourDecimalUnits(line[key]) };
}

function parseFourDecimalUnits(value: unknown): bigint {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw invalid();
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return sign === '-' ? -units : units;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'V3 document failed source validation');
}
