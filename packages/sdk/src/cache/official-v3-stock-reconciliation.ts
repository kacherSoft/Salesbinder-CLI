import type { DocumentRow } from './types.js';

export interface OfficialV3StockLineSignature {
  itemId: string;
  quantity: number | null;
  quantityReceived: number | null;
  quantityShipped: number | null;
  itemLocation: string | null;
  locationId: string | null;
  variationLocationId: string | null;
}

export interface OfficialV3DocumentStockSignature {
  version: 1;
  contextId: 4 | 5 | 11;
  cancelled: boolean | null;
  stockState: 'none' | 'active';
  dateSent: string | null;
  lines: OfficialV3StockLineSignature[];
}

interface LineInput {
  item_id: string;
  quantity?: unknown;
  quantity_received?: unknown;
  quantity_shipped?: unknown;
  item_location?: string | null;
  location_id?: string | number | null;
  item_variation_location_id?: number | string | null;
}

export function createOfficialV3DocumentStockSignature(
  document: Pick<DocumentRow, 'context_id' | 'is_cancelled' | 'status_name' | 'status_id' | 'date_sent'>,
  lines: readonly LineInput[]
): OfficialV3DocumentStockSignature {
  const contextId = document.context_id as 4 | 5 | 11;
  const stockLines = lines.map(stockLine).sort(compareLines);
  const cancelled = document.is_cancelled == null
    ? (contextId === 5 && document.status_id === 15 ? true : null)
    : Boolean(document.is_cancelled) || (contextId === 5 && document.status_id === 15);
  return {
    version: 1,
    contextId,
    cancelled,
    stockState: stockState(contextId, document.status_name, cancelled ? 1 : 0, stockLines, document.date_sent),
    dateSent: text(document.date_sent),
    lines: stockLines,
  };
}

export function createOfficialV3DocumentStockSignatureFromPayload(
  payload: unknown,
  contextId: 4 | 5 | 11
): OfficialV3DocumentStockSignature | null {
  if (!isRecord(payload) || !Array.isArray(payload.lines)) return null;
  const cancelled = contextId === 5 && payload.status_id === 15 || /cancelled|canceled/i.test(String(payload.status ?? ''));
  return createOfficialV3DocumentStockSignature(
    {
      context_id: contextId,
      is_cancelled: cancelled ? 1 : 0,
      status_name: optionalText(payload.status, 'status'),
      status_id: payload.status_id === 15 ? 15 : null,
      date_sent: optionalText(payload.date_sent, 'date_sent'),
    },
    payload.lines.filter(isRecord).flatMap((line) => {
      const itemId = exactTargetId(line.item_id, 'item_id');
      if (!itemId) return [];
      return [{
        item_id: itemId,
        quantity: finiteOrNullValue(line.quantity),
        quantity_received: finiteOrNullValue(line.quantity_received),
        quantity_shipped: finiteOrNullValue(line.quantity_shipped),
        item_location: optionalText(line.location_name, 'location_name'),
        location_id: exactTargetId(line.location_id, 'location_id') ?? exactTargetId(payload.location_id, 'location_id'),
        item_variation_location_id: exactTargetId(line.item_variation_location_id, 'item_variation_location_id'),
      }];
    })
  );
}

export function stockReconciliationItemIds(
  before: OfficialV3DocumentStockSignature | null,
  after: OfficialV3DocumentStockSignature | null
): string[] {
  const contextId = after?.contextId ?? before?.contextId;
  if (contextId !== 5 && contextId !== 11) return [];
  if (!before && !after) return [];
  if (!before) return after?.stockState === 'active' ? uniqueItemIds(after.lines) : [];
  if (!after) return before.stockState === 'active' ? uniqueItemIds(before.lines) : [];
  if (before.stockState === 'none' && after.stockState === 'none') return [];
  if (before.stockState !== after.stockState || before.cancelled !== after.cancelled) {
    return uniqueItemIds([...before.lines, ...after.lines]);
  }
  const beforeByItem = linesByItem(before.lines);
  const afterByItem = linesByItem(after.lines);
  const changed = new Set<string>();
  for (const id of new Set([...beforeByItem.keys(), ...afterByItem.keys()])) {
    if (lineSetKey(beforeByItem.get(id) ?? []) !== lineSetKey(afterByItem.get(id) ?? [])) {
      changed.add(id);
    }
  }
  return [...changed].sort();
}

export function parseOfficialV3DocumentStockSignature(
  value: unknown
): OfficialV3DocumentStockSignature | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<OfficialV3DocumentStockSignature>;
  if (
    candidate.version !== 1 ||
    ![4, 5, 11].includes(candidate.contextId as number) ||
    !['none', 'active'].includes(String(candidate.stockState)) ||
    !Array.isArray(candidate.lines)
  ) return null;
  const lines = candidate.lines.map((line) => isRecord(line) ? stockLine({
    item_id: String(line.itemId ?? ''),
    quantity: finiteOrNullValue(line.quantity),
    quantity_received: finiteOrNullValue(line.quantityReceived),
    quantity_shipped: finiteOrNullValue(line.quantityShipped),
    item_location: text(line.itemLocation),
    location_id: text(line.locationId),
    item_variation_location_id: text(line.variationLocationId),
  }) : null);
  if (lines.some((line) => line == null || !line.itemId)) return null;
  return {
    version: 1,
    contextId: candidate.contextId as 4 | 5 | 11,
    cancelled: typeof candidate.cancelled === 'boolean' ? candidate.cancelled : null,
    stockState: candidate.stockState as 'none' | 'active',
    dateSent: text(candidate.dateSent),
    lines: (lines as OfficialV3StockLineSignature[]).sort(compareLines),
  };
}

function stockState(
  contextId: 4 | 5 | 11,
  statusName: string | null | undefined,
  cancelled: number | null | undefined,
  lines: readonly OfficialV3StockLineSignature[],
  dateSent?: string | null
): 'none' | 'active' {
  if (contextId === 4 || lines.length === 0 || cancelled) return 'none';
  if (contextId === 5) return 'active';
  if (text(dateSent)) return 'active';
  if (lines.some((line) => (line.quantityReceived ?? 0) !== 0)) return 'active';
  const status = String(statusName ?? '').trim().toLowerCase();
  if (status === 'not sent' || /cancel|draft|open/.test(status)) return 'none';
  if (status === 'sent' || status === 'issued' || status === 'received' || status === 'partially received') return 'active';
  return 'none';
}

function stockLine(line: LineInput): OfficialV3StockLineSignature {
  return {
    itemId: line.item_id,
    quantity: finiteOrNullValue(line.quantity),
    quantityReceived: finiteOrNullValue(line.quantity_received),
    quantityShipped: finiteOrNullValue(line.quantity_shipped),
    itemLocation: line.item_location ?? null,
    locationId: exactTargetId(line.location_id, 'location_id'),
    variationLocationId: line.item_variation_location_id == null ? null : String(line.item_variation_location_id),
  };
}

function linesByItem(lines: readonly OfficialV3StockLineSignature[]): Map<string, OfficialV3StockLineSignature[]> {
  const result = new Map<string, OfficialV3StockLineSignature[]>();
  for (const line of lines) result.set(line.itemId, [...(result.get(line.itemId) ?? []), line]);
  return result;
}

function lineSetKey(lines: readonly OfficialV3StockLineSignature[]): string {
  const aggregates = new Map<string, { quantity: number; quantityReceived: number }>();
  for (const line of lines) {
    const key = [line.itemId, line.variationLocationId ?? '', line.locationId ?? '', line.itemLocation ?? ''].join('|');
    const current = aggregates.get(key) ?? { quantity: 0, quantityReceived: 0 };
    current.quantity += line.quantity ?? 0;
    current.quantityReceived += line.quantityReceived ?? 0;
    aggregates.set(key, current);
  }
  return JSON.stringify([...aggregates]
    .map(([target, values]) => ({ target, ...values }))
    .sort((left, right) => left.target.localeCompare(right.target)));
}

function uniqueItemIds(lines: readonly OfficialV3StockLineSignature[]): string[] {
  return [...new Set(lines.map((line) => line.itemId))].sort();
}

function finiteOrNullValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareLines(left: OfficialV3StockLineSignature, right: OfficialV3StockLineSignature): number {
  return (
    left.itemId.localeCompare(right.itemId) ||
    String(left.variationLocationId ?? '').localeCompare(String(right.variationLocationId ?? '')) ||
    String(left.locationId ?? '').localeCompare(String(right.locationId ?? '')) ||
    String(left.itemLocation ?? '').localeCompare(String(right.itemLocation ?? '')) ||
    Number(left.quantity ?? 0) - Number(right.quantity ?? 0) ||
    Number(left.quantityReceived ?? 0) - Number(right.quantityReceived ?? 0) ||
    Number(left.quantityShipped ?? 0) - Number(right.quantityShipped ?? 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  throw new Error(`Official V3 document ${field} must be text.`);
}

function exactTargetId(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error(`Official V3 document ${field} must be an exact identifier.`);
}
