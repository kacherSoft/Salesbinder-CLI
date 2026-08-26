import { createHash } from 'node:crypto';
import type { Document, DocumentTransaction } from '../types/documents.types.js';
import type { DocumentRow } from './types.js';
import type { PaymentSyncStatus, PaymentTransactionRow } from './payment-sync.types.js';

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPaymentSyncInitialized(status: PaymentSyncStatus | null): boolean {
  return status?.status === 'complete'
    || (typeof status?.lastSuccessfulSync === 'number' && Number.isFinite(status.lastSuccessfulSync));
}

export function sortInvoicesForPaymentSync(documents: DocumentRow[]): DocumentRow[] {
  return [...documents].sort((left, right) => left.doc_id.localeCompare(right.doc_id));
}

export function hashPaymentInvoiceSnapshot(documents: Array<{ doc_id: string }>): string {
  const hash = createHash('sha256');
  for (const document of documents) hash.update(document.doc_id).update('\0');
  return hash.digest('hex');
}

export function assertPaymentRowsMatchDocument(docId: string, rows: PaymentTransactionRow[]): void {
  if (rows.some((row) => row.doc_id !== docId)) {
    throw new Error(`Payment transaction replacement for ${docId} received rows for a different document.`);
  }
}

export function assertUniquePaymentTransactionIds(rows: PaymentTransactionRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.transaction_id)) {
      throw new Error(`Duplicate payment transaction ID ${row.transaction_id} in one write operation.`);
    }
    seen.add(row.transaction_id);
  }
}

export function normalizePaymentTransactions(
  apiDocumentId: string,
  cacheDocumentId: string,
  transactions: DocumentTransaction[],
  importedAt: number,
): PaymentTransactionRow[] {
  const rows = transactions
    .map((transaction) => normalizePaymentTransaction(apiDocumentId, cacheDocumentId, transaction, importedAt))
    .sort((left, right) => {
      const byDate = left.transaction_date.localeCompare(right.transaction_date);
      if (byDate !== 0) return byDate;
      return left.transaction_id.localeCompare(right.transaction_id);
    });
  assertUniquePaymentTransactionIds(rows);
  return rows;
}

export function normalizeDocumentPaymentTransactions(
  document: Document,
  cacheDocumentId: string,
  importedAt: number,
): PaymentTransactionRow[] {
  if (!Array.isArray(document.transactions)) {
    throw new Error(`Document ${document.id} did not return an authoritative payment transaction array.`);
  }
  const rows = normalizePaymentTransactions(document.id, cacheDocumentId, document.transactions, importedAt);
  const rawDeclaredTotal = document.total_transactions as unknown;
  const declaredTotal = typeof rawDeclaredTotal === 'number'
    || (typeof rawDeclaredTotal === 'string' && rawDeclaredTotal.trim())
    ? Number(rawDeclaredTotal)
    : Number.NaN;
  const transactionTotal = rows.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isFinite(declaredTotal) || Math.abs(declaredTotal - transactionTotal) > 0.005) {
    throw new Error(`Document ${document.id} returned inconsistent payment transaction totals.`);
  }
  return rows;
}

export function sanitizePaymentSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function normalizePaymentTransaction(
  apiDocumentId: string,
  cacheDocumentId: string,
  transaction: DocumentTransaction,
  importedAt: number,
): PaymentTransactionRow {
  if (!transaction.id) {
    throw new Error(`Document ${apiDocumentId} returned a payment transaction without id.`);
  }
  if (!transaction.document_id) {
    throw new Error(`Payment transaction ${transaction.id} is missing document_id.`);
  }
  if (transaction.document_id !== apiDocumentId) {
    throw new Error(
      `Payment transaction ${transaction.id} belongs to document ${transaction.document_id}, expected ${apiDocumentId}.`,
    );
  }
  const rawAmount = transaction.amount;
  const amount = typeof rawAmount === 'number' || (typeof rawAmount === 'string' && rawAmount.trim())
    ? Number(rawAmount)
    : Number.NaN;
  if (!Number.isFinite(amount)) {
    throw new Error(`Payment transaction ${transaction.id} has an invalid amount.`);
  }

  const transactionDate = normalizeDate(transaction.transaction_date, transaction.id);
  return {
    transaction_id: transaction.id,
    doc_id: cacheDocumentId,
    amount,
    transaction_date: transactionDate,
    reference: transaction.reference ?? null,
    imported_at: importedAt,
  };
}

function normalizeDate(value: string, transactionId: string): string {
  const date = value.split('T')[0];
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Payment transaction ${transactionId} has an invalid transaction_date.`);
  }
  return date;
}
