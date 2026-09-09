import { DocumentRecordError, safeDocumentNumber } from './document-source-validation.js';

export type ObservedV3DocumentRelation<T> =
  | { observed: false }
  | { observed: true; value: T | null };

export interface V3ConvertedDocumentRelation {
  id: string;
  kind: 'invoice' | 'sales_order';
  number: number;
}

export interface V3SourceEstimateRelation {
  id: string;
  estimate_number: number;
}

/**
 * Preserves whether v3 supplied the conversion relation so callers can distinguish
 * an unobserved field from an explicit clear.
 */
export function parseV3ConvertedDocumentRelation(
  payload: unknown,
  documentId: string
): ObservedV3DocumentRelation<V3ConvertedDocumentRelation> {
  return parseObservedRelation(payload, 'converted_document', documentId, (value) => {
    const relation = record(value);
    const id = uuid(relation.id);
    const kind = relation.kind;
    const number = safeDocumentNumber(relation.number);
    if ((kind !== 'invoice' && kind !== 'sales_order') || number === undefined) throw invalid();
    return { id, kind, number };
  });
}

/**
 * Preserves whether v3 supplied an invoice's source estimate so callers can
 * distinguish an unobserved field from an explicit clear.
 */
export function parseV3SourceEstimateRelation(
  payload: unknown,
  documentId: string
): ObservedV3DocumentRelation<V3SourceEstimateRelation> {
  return parseObservedRelation(payload, 'source_estimate', documentId, (value) => {
    const relation = record(value);
    const id = uuid(relation.id);
    const estimate_number = safeDocumentNumber(relation.estimate_number);
    if (estimate_number === undefined) throw invalid();
    return { id, estimate_number };
  });
}

function parseObservedRelation<T extends { id: string }>(
  payload: unknown,
  key: string,
  documentId: string,
  parse: (value: unknown) => T
): ObservedV3DocumentRelation<T> {
  const source = record(payload);
  if (!hasOwn(source, key)) return { observed: false };
  if (source[key] === null) return { observed: true, value: null };
  const value = parse(source[key]);
  if (value.id === documentId) throw invalid();
  return { observed: true, value };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw invalid();
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'V3 document relationship failed source validation');
}
