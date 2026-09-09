import {
  parseV3ConvertedDocumentRelation,
  parseV3SourceEstimateRelation,
} from './v3-document-relationship-normalizer.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';
import {
  OCShippingContractError,
  type OCShippingCanonicalEstimate,
  type OCShippingCanonicalLine,
  type OCShippingCanonicalSourceDocument,
  type ObservedOCShippingValue,
} from './oc-shipping.types.js';

type SourceKind = 'invoice' | 'sales_order';

export function normalizeV3OCShippingEstimate(payload: unknown): OCShippingCanonicalEstimate {
  const record = sourceRecord(payload);
  const id = requiredUuid(record.id, 'estimate id');
  if (record.object !== 'estimate') throw invalid('Expected estimate payload');
  return {
    id,
    kind: 'estimate',
    number: requiredDocumentNumber(record.estimate_number, 'estimate number'),
    modified: requiredEpochSeconds(record.updated_at, 'estimate updated_at'),
    customerId: requiredUuid(record.customer_id, 'estimate customer_id'),
    lines: normalizeLines(record, 'estimate', id),
    convertedDocument: convertedDocument(record, id),
  };
}

export function normalizeV3OCShippingSourceDocument(
  payload: unknown,
  expected?: { id: string; kind: SourceKind }
): OCShippingCanonicalSourceDocument {
  const record = sourceRecord(payload);
  const kind = sourceKind(record.object);
  const id = requiredUuid(record.id, `${kind} id`);
  if (expected && (expected.id !== id || expected.kind !== kind)) throw invalid('V3 shipping source identity mismatch');
  const modified = optionalEpochSeconds(record.updated_at, `${kind} updated_at`);
  const source: OCShippingCanonicalSourceDocument = {
    id,
    kind,
    number: requiredDocumentNumber(record[`${kind}_number`], `${kind} number`),
    ...(modified === undefined ? {} : { modified }),
    customerId: requiredUuid(record.customer_id, `${kind} customer_id`),
    lines: normalizeLines(record, kind, id),
    sourceEstimate: sourceEstimate(record, id),
    shippedPercent: optionalPercent(record.shipped_percent),
  };
  if (kind === 'invoice') Object.assign(source, normalizeInvoiceAuthority(record));
  return source;
}

export function v3DocumentObjectKind(payload: unknown): 'estimate' | SourceKind {
  const object = sourceRecord(payload).object;
  if (object === 'estimate' || object === 'invoice' || object === 'sales_order') return object;
  throw invalid('Unsupported V3 OC shipping document kind');
}

function convertedDocument(
  payload: Record<string, unknown>,
  documentId: string
): ObservedOCShippingValue<{ id: string; kind: SourceKind; number: number }> {
  const relation = parseV3ConvertedDocumentRelation(payload, documentId);
  if (!relation.observed) return { observed: false };
  if (relation.value === null) return { observed: true, value: null };
  return {
    observed: true,
    value: { id: relation.value.id, kind: relation.value.kind, number: relation.value.number },
  };
}

function sourceEstimate(
  payload: Record<string, unknown>,
  documentId: string
): ObservedOCShippingValue<{ id: string; estimateNumber: number }> {
  const relation = parseV3SourceEstimateRelation(payload, documentId);
  if (!relation.observed) return { observed: false };
  if (relation.value === null) return { observed: true, value: null };
  return {
    observed: true,
    value: { id: relation.value.id, estimateNumber: relation.value.estimate_number },
  };
}

function normalizeInvoiceAuthority(
  payload: Record<string, unknown>
): Pick<OCShippingCanonicalSourceDocument, 'fulfillmentAuthority' | 'fulfillmentSalesOrderId'> {
  const directAuthority = observedFulfillmentSalesOrderId(payload);
  const sourceAuthority = observedSourceSalesOrderId(payload);
  const inferredSalesOrderId = resolveSalesOrderAuthority(directAuthority, sourceAuthority);
  if (!hasOwn(payload, 'fulfillment_authority')) {
    return inferredSalesOrderId === undefined
      ? {}
      : { fulfillmentAuthority: 'sales_order', fulfillmentSalesOrderId: inferredSalesOrderId };
  }
  const authority = payload.fulfillment_authority;
  if (authority !== 'invoice' && authority !== 'sales_order') throw invalid('Invalid invoice fulfillment authority');
  if (authority === 'invoice') {
    if (directAuthority !== undefined && directAuthority !== null) throw invalid('Standalone invoice has a fulfillment sales order');
    if (sourceAuthority !== undefined && sourceAuthority !== null) throw invalid('Standalone invoice has a source sales order');
    return { fulfillmentAuthority: 'invoice', fulfillmentSalesOrderId: null };
  }
  if (inferredSalesOrderId === undefined) throw invalid('Linked invoice has no fulfillment sales order');
  return {
    fulfillmentAuthority: 'sales_order',
    fulfillmentSalesOrderId: inferredSalesOrderId,
  };
}

function resolveSalesOrderAuthority(
  directAuthority: string | null | undefined,
  sourceAuthority: string | null | undefined
): string | undefined {
  if (directAuthority === undefined && sourceAuthority === undefined) return undefined;
  if (directAuthority === null && sourceAuthority === null) return undefined;
  if (directAuthority === null || sourceAuthority === null) {
    const nonNull = directAuthority ?? sourceAuthority;
    if (typeof nonNull === 'string') throw invalid('Invoice fulfillment authority references conflict');
    return undefined;
  }
  if (
    directAuthority !== undefined &&
    sourceAuthority !== undefined &&
    directAuthority !== sourceAuthority
  ) {
    throw invalid('Linked invoice authorities disagree');
  }
  return directAuthority ?? sourceAuthority;
}

function observedFulfillmentSalesOrderId(payload: Record<string, unknown>): string | null | undefined {
  if (!hasOwn(payload, 'fulfillment_sales_order_id')) return undefined;
  if (payload.fulfillment_sales_order_id === null) return null;
  return requiredUuid(payload.fulfillment_sales_order_id, 'invoice fulfillment sales order id');
}

function observedSourceSalesOrderId(payload: Record<string, unknown>): string | null | undefined {
  if (!hasOwn(payload, 'source_sales_order')) return undefined;
  if (payload.source_sales_order === null) return null;
  const relation = sourceRecord(payload.source_sales_order);
  const id = requiredUuid(relation.id, 'invoice source sales order id');
  if (hasOwn(relation, 'sales_order_number')) requiredDocumentNumber(relation.sales_order_number, 'invoice source sales order number');
  return id;
}

function normalizeLines(
  payload: Record<string, unknown>,
  kind: 'estimate' | SourceKind,
  documentId: string
): readonly OCShippingCanonicalLine[] {
  if (!Array.isArray(payload.lines)) throw invalid(`Missing ${kind} lines`);
  const ids = new Set<string>();
  return payload.lines.flatMap((value) => {
    const line = sourceRecord(value);
    const lineId = requiredUuid(line.id, `${kind} line id`);
    if (line.object !== `${kind}_line` || ids.has(lineId)) throw invalid(`Invalid ${kind} line identity`);
    ids.add(lineId);
    if (line.document_id !== undefined && line.document_id !== documentId) throw invalid('Line document identity mismatch');
    if (line[`${kind}_id`] !== undefined && line[`${kind}_id`] !== documentId) {
      throw invalid('Line parent identity mismatch');
    }
    if (line.line_type !== 'inventory') return [];
    const itemId = requiredUuid(line.item_id, `${kind} line item_id`);
    const quantity = requiredQuantity(line.quantity, `${kind} line quantity`);
    const itemVariationLocationId = observedNullableInteger(
      line,
      'item_variation_location_id',
      `${kind} line variation location`
    );
    const unitId = observedNullableInteger(line, 'unit_id', `${kind} line unit`);
    const shipped = optionalQuantity(line.quantity_shipped, `${kind} line quantity_shipped`, quantity);
    return [
      {
        documentItemId: lineId,
        itemId,
        quantity,
        ...(itemVariationLocationId.observed
          ? { itemVariationLocationId: itemVariationLocationId.value }
          : {}),
        ...(unitId.observed ? { unitId: unitId.value } : {}),
        ...(shipped === undefined ? {} : { quantityShipped: shipped }),
      },
    ];
  });
}

function sourceKind(value: unknown): SourceKind {
  if (value === 'invoice' || value === 'sales_order') return value;
  throw invalid('Expected invoice or sales order payload');
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('Expected V3 document object');
  return value as Record<string, unknown>;
}

function requiredUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw invalid(`Invalid ${field}`);
  return value;
}

function requiredDocumentNumber(value: unknown, field: string): number {
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalid(`Invalid ${field}`);
  }
  return parsed;
}

function requiredEpochSeconds(value: unknown, field: string): number {
  const result = optionalEpochSeconds(value, field);
  if (result === undefined) throw invalid(`Missing ${field}`);
  return result;
}

function optionalEpochSeconds(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(`Invalid ${field}`);
  return Math.floor(Date.parse(value) / 1000);
}

function optionalPercent(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (!quantity(parsed) || parsed > 100) throw invalid('Invalid shipped_percent');
  return parsed;
}

function optionalQuantity(value: unknown, field: string, maximum: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (!quantity(parsed) || parsed > maximum) throw invalid(`Invalid ${field}`);
  return parsed;
}

function requiredQuantity(value: unknown, field: string): number {
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (!quantity(parsed)) throw invalid(`Invalid ${field}`);
  return parsed;
}

function observedNullableInteger(
  record: Record<string, unknown>,
  key: string,
  field: string
): ObservedOCShippingValue<number> {
  if (!hasOwn(record, key)) return { observed: false };
  if (record[key] === null) return { observed: true, value: null };
  const parsed = parseSalesBinderFiniteDecimal(record[key]);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalid(`Invalid ${field}`);
  }
  return { observed: true, value: parsed };
}

function quantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(message: string): OCShippingContractError {
  return new OCShippingContractError(message);
}
