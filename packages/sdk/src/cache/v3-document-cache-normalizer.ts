import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { NormalizedDocumentCacheRows } from './document-row-normalizer.js';
import { DocumentRecordError, safeDocumentNumber } from './document-source-validation.js';
import {
  isValidSalesBinderCalendarDateText,
  isValidSalesBinderTimestampText,
} from './salesbinder-source-date-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

const OBJECTS = { 4: 'estimate', 5: 'invoice', 11: 'purchase_order' } as const;
const RESOURCE_CONTEXTS = { estimate: 4, invoice: 5, purchase_order: 11 } as const;

export type V3DocumentSyncResource = keyof typeof RESOURCE_CONTEXTS;

export function normalizeOfficialV3DocumentCacheRows(
  payload: unknown,
  expected: { id: string; resource: V3DocumentSyncResource }
): NormalizedDocumentCacheRows {
  const contextId = RESOURCE_CONTEXTS[expected.resource];
  const object = OBJECTS[contextId];
  const recordPayload = record(payload);
  if (recordPayload.object !== object || recordPayload.id !== expected.id) {
    throw new ApiResponseValidationError('V3 document identity mismatch', 'identity');
  }
  const documentNumber = safeDocumentNumber(recordPayload[`${object}_number`]);
  if (documentNumber === undefined) throw invalid();
  return normalizeV3DocumentCacheRows(recordPayload, {
    id: expected.id,
    contextId,
    documentNumber,
  });
}

/** Map canonical v3 detail directly, without inventing legacy document fields. */
export function normalizeV3DocumentCacheRows(
  payload: unknown,
  expected: { id: string; contextId: 4 | 5 | 11; documentNumber: number }
): NormalizedDocumentCacheRows {
  const object = OBJECTS[expected.contextId];
  if (
    !object ||
    !isUuid(expected.id) ||
    !isRecord(payload) ||
    payload.object !== object ||
    !isUuid(payload.id) ||
    payload.id !== expected.id ||
    (payload.context_id != null && payload.context_id !== expected.contextId)
  ) {
    throw new ApiResponseValidationError('V3 document identity mismatch', 'identity');
  }
  const number = safeDocumentNumber(payload[`${object}_number`]);
  if (number === undefined || safeDocumentNumber(expected.documentNumber) === undefined)
    throw invalid();
  if (number !== expected.documentNumber) {
    throw new ApiResponseValidationError('V3 document business identity mismatch', 'identity');
  }
  const po = expected.contextId === 11;
  const assignmentKey = po ? 'assigned_user_id' : 'salesperson_id';
  if (!Object.prototype.hasOwnProperty.call(payload, assignmentKey)) throw invalid();
  const userId = optionalUuid(payload[assignmentKey]);
  const accountId = uuid(payload[po ? 'supplier_id' : 'customer_id']);
  const accountName = text(payload[po ? 'supplier_name' : 'customer_name']);
  const status = text(payload.status);
  const party = payload.party == null ? null : record(payload.party);
  const accountNumberText = text(party?.account_number);
  // Display account numbers may contain prefixes that cannot fit the integer cache column.
  const accountNumber = safeDocumentNumber(accountNumberText) ?? null;
  const customerKind = text(payload.customer_kind);
  if (customerKind != null && !['customer', 'prospect'].includes(customerKind)) throw invalid();
  if (!isValidSalesBinderTimestampText(payload.updated_at) || !Array.isArray(payload.lines))
    throw invalid();
  const seen = new Set<string>();
  const itemRows = payload.lines.flatMap((value: unknown) => {
    const line = record(value);
    const lineId = uuid(line.id);
    if (line.object !== `${object}_line` || seen.has(lineId)) throw invalid();
    seen.add(lineId);
    if (line.document_id != null && line.document_id !== payload.id) throw invalid();
    const parentId = line[`${object}_id`];
    if (parentId != null && parentId !== payload.id) throw invalid();
    const kind = text(line.line_type);
    if (kind == null || !['inventory', 'service', 'discount'].includes(kind)) throw invalid();
    const itemId = line.item_id == null ? null : uuid(line.item_id);
    if (
      (kind === 'inventory' && !itemId) ||
      (itemId && (kind === 'service' || kind === 'discount'))
    )
      throw invalid();
    const quantity = requiredNumber(line.quantity);
    const price = optionalNumber(line[po ? 'unit_cost' : 'unit_price']);
    const cost = optionalNumber(line.unit_cost);
    const discounted = optionalNumber(line[po ? 'discounted_unit_cost' : 'discounted_unit_price']);
    const total = optionalNumber(line.subtotal);
    const name = text(line.name);
    const description = text(line.description);
    const sku = text(line.sku);
    const location = text(line.location_name);
    const received = optionalNumber(line.quantity_received);
    const shipped = optionalNumber(line.quantity_shipped);
    const discount = optionalNumber(line.discount_percent);
    for (const key of [
      'total_cost',
      'total',
      'tax',
      'tax_2',
      'tax_rate',
      'tax_2_rate',
      'quantity_packed',
    ])
      optionalNumber(line[key]);
    for (const key of ['position', 'unit_id', 'variation_number', 'item_variation_location_id'])
      integer(line[key]);
    if (!itemId) return [];
    if (price == null || !Number.isFinite(quantity * price)) throw invalid();
    return [
      {
        item_id: itemId,
        doc_id: expected.id,
        document_item_id: lineId,
        quantity,
        price,
        cost,
        total_amount: total,
        discounted_price: discounted,
        discount_percent: discount,
        quantity_received: received,
        quantity_shipped: shipped,
        item_name: name ?? description,
        line_description: description,
        item_sku: sku,
        item_location: location,
      },
    ];
  });
  return {
    docRow: {
      doc_id: payload.id,
      api_doc_id: payload.id,
      cache_source: 'api',
      context_id: expected.contextId,
      doc_number: number,
      issue_date: date(payload.issue_date),
      modified: Math.floor(Date.parse(payload.updated_at) / 1000),
      customer_id: accountId,
      account_id: accountId,
      account_context_id: po
        ? 10
        : expected.contextId === 5
          ? 2
          : customerKind === 'prospect'
            ? 8
            : customerKind === 'customer'
              ? 2
              : null,
      account_name: accountName,
      account_number: accountNumber,
      customer_name: po ? null : accountName,
      customer_number: po ? null : accountNumber,
      supplier_name: po ? accountName : null,
      supplier_number: po ? accountNumber : null,
      user_id: userId,
      document_name: text(payload.name),
      custom_doc_number: text(payload[`custom_${object}_number`]),
      status_id: integer(payload.status_id),
      status_name: status,
      total_price: optionalNumber(payload.total),
      subtotal: optionalNumber(payload.subtotal),
      // V3 does not provide an authoritative document aggregate of internal line costs.
      total_cost: null,
      archived: null,
      external_po_number: po ? null : text(payload.purchase_order_number),
      date_sent: payload.date_sent == null ? null : date(payload.date_sent),
      shipped_percent: optionalNumber(payload.shipped_percent),
      is_cancelled: status && /cancelled|canceled/i.test(status) ? 1 : 0,
    },
    itemRows,
  };
}

function invalid(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'V3 document failed source validation');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}
function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
function uuid(value: unknown): string {
  if (!isUuid(value)) throw invalid();
  return value;
}
function optionalUuid(value: unknown): string | null {
  return value == null ? null : uuid(value);
}
function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || hasUnpairedUtf16Surrogate(value)) throw invalid();
  return value.replaceAll(String.fromCharCode(0), '');
}
function requiredNumber(value: unknown): number {
  const result = parseSalesBinderFiniteDecimal(value);
  if (result === undefined) throw invalid();
  return result;
}
function optionalNumber(value: unknown): number | null {
  return value == null ? null : requiredNumber(value);
}
function integer(value: unknown): number | null {
  if (value == null) return null;
  const result = safeDocumentNumber(value);
  if (result === undefined) throw invalid();
  return result;
}
function date(value: unknown): string {
  if (!isValidSalesBinderCalendarDateText(value)) throw invalid();
  return value;
}
