import axios from 'axios';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { Document } from '../types/documents.types.js';
import type { SyncRecordIssueCode } from './sync-record-issue.types.js';
import { isValidSalesBinderDateText } from './salesbinder-source-date-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';
import { DocumentContextId } from './types.js';

const MAX_SOURCE_ID_LENGTH = 256;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const NONNEGATIVE_DECIMAL_INTEGER_PATTERN = /^\d+$/;

export class DocumentRecordError extends Error {
  constructor(
    readonly code: Extract<SyncRecordIssueCode, 'not_found' | 'invalid_record'>,
    readonly safeMessage: string
  ) {
    super(safeMessage);
    this.name = 'DocumentRecordError';
  }
}

export function classifyDocumentRecordError(error: unknown): DocumentRecordError | null {
  if (error instanceof DocumentRecordError) return error;
  if (error instanceof ApiResponseValidationError) {
    if (error.sourceScope === 'identity') return null;
    return invalidDocumentRecord();
  }
  if (axios.isAxiosError(error) && error.response?.status === 404) {
    return new DocumentRecordError('not_found', 'Document unavailable during refresh');
  }
  return null;
}

export function assertDocumentRootIdentity(
  document: Document,
  expectedContext: DocumentContextId,
  seenIds: Set<string>,
  seenBusinessKeys: Map<string, string>
): void {
  if (!isRecord(document) || !isCanonicalSourceId(document.id)) {
    throw new Error('Invalid document list row identity');
  }
  if (document.context_id !== expectedContext) {
    throw new Error(`Document context mismatch for ${document.id}`);
  }
  if (seenIds.has(document.id)) throw new Error(`Duplicate document ID ${document.id}`);
  seenIds.add(document.id);

  const documentNumber = safeDocumentNumber(document.document_number);
  if (documentNumber === undefined) return;
  assertDocumentBusinessKey(document.id, expectedContext, documentNumber, seenBusinessKeys);
}

export function assertDocumentBusinessKey(
  documentId: string,
  contextId: DocumentContextId,
  documentNumber: number,
  seenBusinessKeys: Map<string, string>
): void {
  const key = `${contextId}:${documentNumber}`;
  const existingId = seenBusinessKeys.get(key);
  if (existingId && existingId !== documentId) {
    throw new Error(`Duplicate document business key ${key}`);
  }
  seenBusinessKeys.set(key, documentId);
}

export function assertFetchedDocumentIdentity(
  document: Document,
  expectedId: string,
  expectedContext: DocumentContextId,
  expectedDocumentNumber?: number
): void {
  if (!isRecord(document) || !isCanonicalSourceId(document.id) || document.id !== expectedId) {
    throw new Error(`Document detail identity mismatch for ${expectedId}`);
  }
  if (document.context_id !== expectedContext) {
    throw new Error(`Document detail context mismatch for ${expectedId}`);
  }
  const actualDocumentNumber = safeDocumentNumber(document.document_number);
  if (actualDocumentNumber === undefined) throw invalidDocumentRecord();
  if (expectedDocumentNumber !== undefined && actualDocumentNumber !== expectedDocumentNumber) {
    throw new Error('Document detail business key mismatch');
  }
}

export function validateDocumentContent(document: Document): void {
  if (
    !isCanonicalSourceId(document.id) ||
    !isDocumentContext(document.context_id) ||
    safeDocumentNumber(document.document_number) === undefined ||
    !isCanonicalSourceId(document.customer_id) ||
    !isCanonicalSourceId(document.user_id) ||
    !isValidSalesBinderDateText(document.issue_date) ||
    !isValidSalesBinderDateText(document.modified) ||
    !isOptionalText(document.name) ||
    !isOptionalSalesBinderDateText(document.date_sent) ||
    !isOptionalFiniteNumber(document.shipped_percent) ||
    (document.archived != null && typeof document.archived !== 'boolean')
  ) {
    throw invalidDocumentRecord();
  }
  if (
    !isOptionalNestedText(document.customer, ['name']) ||
    !isOptionalNestedText(document.user, ['name', 'first_name', 'last_name']) ||
    !isOptionalNestedText(document.status, ['name']) ||
    !isOptionalNestedPostgresInteger(document.customer, ['customer_number']) ||
    !hasMatchingOptionalNestedSourceId(document.customer, document.customer_id) ||
    !hasMatchingOptionalNestedSourceId(document.user, document.user_id) ||
    !hasMatchingOptionalNestedNumericId(document.status, document.status_id) ||
    !hasMatchingOptionalNestedNumericId(document.context, document.context_id)
  ) {
    throw invalidDocumentRecord();
  }
  for (const value of [document.total_cost, document.total_price, document.total_transactions]) {
    if (!isFiniteNumeric(value)) throw invalidDocumentRecord();
  }
  if (!isNonnegativePostgresInteger(document.status_id)) throw invalidDocumentRecord();
  const lineIds = new Set<string>();
  for (const item of document.document_items ?? []) {
    if (!isValidDocumentItem(item, document.id) || lineIds.has(item.id)) {
      throw invalidDocumentRecord();
    }
    lineIds.add(item.id);
  }
}

function isValidDocumentItem(item: unknown, documentId: string): boolean {
  if (!isRecord(item)) return false;
  const quantity = parseSalesBinderFiniteDecimal(item.quantity);
  const price = parseSalesBinderFiniteDecimal(item.price);
  if (
    !isCanonicalSourceId(item.id) ||
    item.document_id !== documentId ||
    quantity === undefined ||
    price === undefined ||
    !isOptionalText(item.name) ||
    !isOptionalText(item.description)
  ) {
    return false;
  }
  if (!Number.isFinite(quantity * price)) return false;
  if (
    ![
      item.quantity_partially_received,
      item.quantity_partially_shipped,
      item.cost,
      item.discounted_price,
      item.discount_percent,
    ].every(isOptionalFiniteNumber)
  ) {
    return false;
  }
  return item.item_id == null || item.item_id === '' || isCanonicalSourceId(item.item_id);
}

function isOptionalNestedText(value: unknown, fields: string[]): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return fields.every((field) => isOptionalText(value[field]));
}

function isOptionalNestedPostgresInteger(value: unknown, fields: string[]): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return fields.every(
    (field) => value[field] == null || isNonnegativePostgresInteger(value[field])
  );
}

function hasMatchingOptionalNestedSourceId(value: unknown, expectedId: string): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  const nestedId = value.id;
  return nestedId == null || (isCanonicalSourceId(nestedId) && nestedId === expectedId);
}

function hasMatchingOptionalNestedNumericId(value: unknown, expectedId: unknown): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  const nestedId = value.id;
  if (nestedId == null) return true;
  return (
    isNonnegativePostgresInteger(nestedId) &&
    isNonnegativePostgresInteger(expectedId) &&
    Number(nestedId) === Number(expectedId)
  );
}

function isOptionalText(value: unknown): boolean {
  return value == null || (typeof value === 'string' && !hasUnpairedUtf16Surrogate(value));
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value == null || isFiniteNumeric(value);
}

export function safeDocumentNumber(value: unknown): number | undefined {
  return isNonnegativePostgresInteger(value) ? Number(value) : undefined;
}

function isNonnegativePostgresInteger(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !NONNEGATIVE_DECIMAL_INTEGER_PATTERN.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= POSTGRES_INTEGER_MAX;
}

function isFiniteNumeric(value: unknown): boolean {
  return parseSalesBinderFiniteDecimal(value) !== undefined;
}

function invalidDocumentRecord(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'Document failed source validation');
}

function isDocumentContext(value: unknown): value is DocumentContextId {
  return (
    value === DocumentContextId.Estimate ||
    value === DocumentContextId.Invoice ||
    value === DocumentContextId.PurchaseOrder
  );
}

function isCanonicalSourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SOURCE_ID_LENGTH &&
    value === value.trim() &&
    !hasControlCharacter(value) &&
    !hasUnpairedUtf16Surrogate(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isOptionalSalesBinderDateText(value: unknown): boolean {
  return value == null || isValidSalesBinderDateText(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
