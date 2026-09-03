import { createHash } from 'node:crypto';
import type { Document, DocumentTransaction } from '../types/documents.types.js';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { DocumentRow } from './types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from './payment-sync.types.js';
import {
  isValidSalesBinderDateText,
  toSalesBinderCalendarDateText,
} from './salesbinder-source-date-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

const MAX_SOURCE_ID_LENGTH = 256;

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPaymentSyncInitialized(status: PaymentSyncStatus | null): boolean {
  return (
    status?.status === 'complete' ||
    (typeof status?.lastSuccessfulSync === 'number' && Number.isFinite(status.lastSuccessfulSync))
  );
}

export function sortInvoicesForPaymentSync(documents: DocumentRow[]): DocumentRow[] {
  return [...documents].sort((left, right) => {
    const byCacheId = compareCodeUnitStrings(left.doc_id, right.doc_id);
    if (byCacheId !== 0) return byCacheId;
    return compareCodeUnitStrings(
      paymentInvoiceApiDocumentId(left),
      paymentInvoiceApiDocumentId(right)
    );
  });
}

export function paymentInvoiceApiDocumentId(document: {
  doc_id: string;
  api_doc_id?: string | null;
}): string {
  return document.api_doc_id ?? document.doc_id;
}

export function hashPaymentInvoiceSnapshot(
  documents: Array<{ doc_id: string; api_doc_id?: string | null }>
): string {
  const hash = createHash('sha256');
  hash.update('payment-invoice-snapshot-v2\0');
  for (const document of documents) {
    hash
      .update(JSON.stringify([document.doc_id, paymentInvoiceApiDocumentId(document)]))
      .update('\0');
  }
  return hash.digest('hex');
}

export function assertPaymentRowsMatchDocument(docId: string, rows: PaymentTransactionRow[]): void {
  if (rows.some((row) => row.doc_id !== docId)) {
    throw new Error(
      `Payment transaction replacement for ${docId} received rows for a different document.`
    );
  }
}

export function assertUniquePaymentTransactionIds(rows: PaymentTransactionRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.transaction_id)) {
      throw new Error(
        `Duplicate payment transaction ID ${row.transaction_id} in one write operation.`
      );
    }
    seen.add(row.transaction_id);
  }
}

export function normalizePaymentTransactions(
  apiDocumentId: string,
  cacheDocumentId: string,
  transactions: DocumentTransaction[],
  importedAt: number
): PaymentTransactionRow[] {
  const sourceDocumentId = requireSafeIdentifier(
    apiDocumentId,
    'Document returned an invalid payment identifier.'
  );
  const rows = transactions
    .map((transaction) =>
      normalizePaymentTransaction(sourceDocumentId, cacheDocumentId, transaction, importedAt)
    )
    .sort((left, right) => {
      const byDate = compareCodeUnitStrings(left.transaction_date, right.transaction_date);
      if (byDate !== 0) return byDate;
      return compareCodeUnitStrings(left.transaction_id, right.transaction_id);
    });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.transaction_id)) {
      throw new ApiResponseValidationError(
        `Duplicate payment transaction ID ${row.transaction_id} in one write operation.`
      );
    }
    seen.add(row.transaction_id);
  }
  return rows;
}

export function normalizeDocumentPaymentTransactions(
  document: Document,
  cacheDocumentId: string,
  importedAt: number
): PaymentTransactionRow[] {
  if (!Array.isArray(document.transactions)) {
    throw paymentValidationError(
      `Document ${document.id} did not return an authoritative payment transaction array.`
    );
  }
  const rows = normalizePaymentTransactions(
    document.id,
    cacheDocumentId,
    document.transactions,
    importedAt
  );
  const declaredTotal = coerceFiniteNumber(document.total_transactions);
  const transactionTotal = rows.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isFinite(declaredTotal) || Math.abs(declaredTotal - transactionTotal) > 0.005) {
    throw paymentValidationError(
      `Document ${document.id} returned inconsistent payment transaction totals.`
    );
  }
  return rows;
}

export function sanitizePaymentSyncError(error: unknown): string {
  void error;
  return 'Payment sync failed';
}

function normalizePaymentTransaction(
  apiDocumentId: string,
  cacheDocumentId: string,
  transaction: DocumentTransaction,
  importedAt: number
): PaymentTransactionRow {
  if (!isRecord(transaction)) {
    throw paymentValidationError(
      `Document ${apiDocumentId} returned an invalid payment transaction.`
    );
  }
  const transactionId = requireSafeIdentifier(
    transaction.id,
    `Document ${apiDocumentId} returned a payment transaction without id.`
  );
  const transactionDocumentId = requireSafeIdentifier(
    transaction.document_id,
    `Payment transaction ${transactionId} is missing document_id.`
  );
  if (transactionDocumentId !== apiDocumentId) {
    throw paymentValidationError(
      `Payment transaction ${transactionId} belongs to document ${transactionDocumentId}, expected ${apiDocumentId}.`
    );
  }
  const amount = requireFiniteNumber(
    transaction.amount,
    `Payment transaction ${transactionId} has an invalid amount.`
  );
  const reference = normalizeReference(transaction.reference, transactionId);
  const transactionDate = normalizeDate(transaction.transaction_date, transactionId);
  return {
    transaction_id: transactionId,
    doc_id: cacheDocumentId,
    amount,
    transaction_date: transactionDate,
    reference,
    imported_at: importedAt,
  };
}

function normalizeDate(value: unknown, transactionId: string): string {
  if (!isValidSalesBinderDateText(value)) {
    throw paymentValidationError(
      `Payment transaction ${transactionId} has an invalid transaction_date.`
    );
  }
  return toSalesBinderCalendarDateText(value);
}

function requireSafeIdentifier(value: unknown, message: string): string {
  if (!isSafeIdentifier(value)) throw paymentValidationError(message);
  return value;
}

function requireFiniteNumber(value: unknown, message: string): number {
  const parsed = coerceFiniteNumber(value);
  if (!Number.isFinite(parsed)) throw paymentValidationError(message);
  return parsed;
}

function normalizeReference(value: unknown, transactionId: string): string | null {
  if (value == null) return null;
  if (
    typeof value !== 'string' ||
    value.includes(String.fromCharCode(0)) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw paymentValidationError(`Payment transaction ${transactionId} has an invalid reference.`);
  }
  return value;
}

function coerceFiniteNumber(value: unknown): number {
  return parseSalesBinderFiniteDecimal(value) ?? Number.NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isSafeIdentifier(value: unknown): value is string {
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

function paymentValidationError(message: string): ApiResponseValidationError {
  return new ApiResponseValidationError(message, 'record');
}
