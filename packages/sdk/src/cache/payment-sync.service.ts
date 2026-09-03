import type { SalesBinderClient } from '../resources/index.js';
import { DocumentContextId } from './types.js';
import type { CacheService } from './cache.interface.js';
import { PAYMENT_DETAIL_DELAY_MS } from './payment-cache.constants.js';
import type { PaymentSyncResult, PaymentSyncStatus } from './payment-sync.types.js';
import {
  delay,
  hashPaymentInvoiceSnapshot,
  normalizeDocumentPaymentTransactions,
  nowInSeconds,
  paymentInvoiceApiDocumentId,
  sanitizePaymentSyncError,
  sortInvoicesForPaymentSync,
} from './payment-sync.helpers.js';

export interface PaymentSyncOptions {
  onProgress?: (current: number, total: number, transactionsProcessed: number) => void;
  /** @internal Test-only. Production callers are clamped to the supported API pace. */
  detailDelayMs?: number;
}

export class PaymentSyncService {
  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService
  ) {}

  async syncHistoricalPayments(options: PaymentSyncOptions = {}): Promise<PaymentSyncResult> {
    const runStartedAt = nowInSeconds();
    const startedAtMs = Date.now();
    const previousStatus = await this.cache.getPaymentSyncStatus();
    const invoices = sortInvoicesForPaymentSync(
      await this.cache.getDocumentsByContext(DocumentContextId.Invoice)
    );
    const snapshotHash = hashPaymentInvoiceSnapshot(invoices);
    const resume = resolveResume(previousStatus, invoices, snapshotHash);
    const detailDelayMs =
      process.env.NODE_ENV === 'test' && options.detailDelayMs !== undefined
        ? Math.max(0, options.detailDelayMs)
        : PAYMENT_DETAIL_DELAY_MS;

    let processedDocuments = resume.startIndex;
    let transactionsProcessed = 0;
    let cursor = resume.cursor;
    const totalDocuments = invoices.length;

    const buildStatus = (
      status: PaymentSyncStatus['status'],
      overrides: Partial<PaymentSyncStatus> = {}
    ): PaymentSyncStatus => ({
      status,
      mode: 'full',
      startedAt: runStartedAt,
      updatedAt: nowInSeconds(),
      lastSuccessfulSync: previousStatus?.lastSuccessfulSync,
      cursor,
      snapshotHash,
      processedDocuments,
      totalDocuments,
      ...overrides,
    });

    await this.cache.setPaymentSyncStatus(buildStatus('backfilling', { updatedAt: runStartedAt }));

    try {
      for (let index = resume.startIndex; index < invoices.length; index++) {
        const invoice = invoices[index];
        if (invoice.cache_source === 'csv' && !invoice.api_doc_id) {
          throw new Error(
            `Invoice ${invoice.doc_number} must be reconciled from SalesBinder before payment backfill.`
          );
        }
        const apiDocumentId = paymentInvoiceApiDocumentId(invoice);

        const document = await this.client.documents.get(apiDocumentId);
        if (document.id !== apiDocumentId) {
          throw new Error(
            `Requested document ${apiDocumentId} but SalesBinder returned ${document.id}.`
          );
        }
        if (document.context_id !== DocumentContextId.Invoice) {
          throw new Error('SalesBinder returned a non-invoice document.');
        }
        const importedAt = nowInSeconds();
        const rows = normalizeDocumentPaymentTransactions(document, invoice.doc_id, importedAt);
        await this.cache.replacePaymentTransactions(invoice.doc_id, rows);
        transactionsProcessed += rows.length;

        processedDocuments = index + 1;
        cursor = invoice.doc_id;
        await this.cache.setPaymentSyncStatus(buildStatus('backfilling'));

        options.onProgress?.(processedDocuments, totalDocuments, transactionsProcessed);
        if (index < invoices.length - 1) {
          await delay(detailDelayMs);
        }
      }

      const finalInvoices = sortInvoicesForPaymentSync(
        await this.cache.getDocumentsByContext(DocumentContextId.Invoice)
      );
      if (!sameInvoiceSourceSnapshot(invoices, finalInvoices)) {
        throw new Error('Invoice cache changed during payment backfill; rerun to resume safely.');
      }

      const finishedAt = nowInSeconds();
      await this.cache.setPaymentSyncStatus(
        buildStatus('complete', {
          updatedAt: finishedAt,
          finishedAt,
          lastSuccessfulSync: finishedAt,
        })
      );

      return {
        success: true,
        mode: 'full',
        resumed: resume.resumed,
        documentsProcessed: processedDocuments,
        totalDocuments,
        transactionsProcessed,
        duration: `${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`,
        cursor,
      };
    } catch (error) {
      const failedAt = nowInSeconds();
      try {
        await this.cache.setPaymentSyncStatus(
          buildStatus('failed', {
            updatedAt: failedAt,
            finishedAt: failedAt,
            error: sanitizePaymentSyncError(error),
          })
        );
      } catch {
        // Failed-status persistence is best-effort; preserve the original sync error.
      }
      throw error;
    }
  }
}

function resolveResume(
  previousStatus: PaymentSyncStatus | null,
  invoiceIds: Array<{ doc_id: string; api_doc_id?: string | null }>,
  snapshotHash: string
) {
  if (previousStatus?.status !== 'backfilling' && previousStatus?.status !== 'failed') {
    return { startIndex: 0, resumed: false, cursor: null as string | null };
  }
  const cursor = previousStatus.cursor;
  if (
    !cursor ||
    previousStatus.totalDocuments !== invoiceIds.length ||
    previousStatus.snapshotHash !== snapshotHash
  ) {
    return { startIndex: 0, resumed: false, cursor: null as string | null };
  }
  const cursorIndex = invoiceIds.findIndex((invoice) => invoice.doc_id === cursor);
  if (cursorIndex === -1 || cursorIndex + 1 !== previousStatus.processedDocuments) {
    return { startIndex: 0, resumed: false, cursor: null as string | null };
  }
  return { startIndex: cursorIndex + 1, resumed: true, cursor };
}

function sameInvoiceSourceSnapshot(
  left: Array<{ doc_id: string; api_doc_id?: string | null }>,
  right: Array<{ doc_id: string; api_doc_id?: string | null }>
): boolean {
  return (
    left.length === right.length &&
    left.every((invoice, index) => {
      const other = right[index];
      if (!other) return false;
      return (
        invoice.doc_id === other.doc_id &&
        paymentInvoiceApiDocumentId(invoice) === paymentInvoiceApiDocumentId(other)
      );
    })
  );
}
