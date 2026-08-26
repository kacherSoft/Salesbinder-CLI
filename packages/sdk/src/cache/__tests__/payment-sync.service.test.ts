import type { SalesBinderClient } from '../../resources/index.js';
import type { Document, DocumentTransaction } from '../../types/documents.types.js';
import type { CacheService } from '../cache.interface.js';
import {
  hashPaymentInvoiceSnapshot,
  isPaymentSyncInitialized,
  normalizeDocumentPaymentTransactions,
  normalizePaymentTransactions,
  sortInvoicesForPaymentSync,
} from '../payment-sync.helpers.js';
import { PaymentSyncService } from '../payment-sync.service.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import type { PaymentSyncState, PaymentSyncStatus, PaymentTransactionRow } from '../payment-sync.types.js';
import { DocumentContextId, type DocumentRow } from '../types.js';

const invoice = (docId: string, issueDate: string, docNumber: number, apiDocId?: string): DocumentRow => ({
  doc_id: docId,
  api_doc_id: apiDocId,
  context_id: DocumentContextId.Invoice,
  doc_number: docNumber,
  issue_date: issueDate,
  customer_id: 'customer-1',
  modified: 1,
});

const apiDocument = (id: string, transactions?: DocumentTransaction[]): Document => (
  {
    id,
    transactions,
    total_transactions: transactions?.reduce((sum, transaction) => sum + Number(transaction.amount), 0) ?? 0,
  } as Document
);

function testHarness(documents: DocumentRow[], previousStatus: PaymentSyncStatus | null = null) {
  let status = previousStatus;
  const replacements: Array<[string, PaymentTransactionRow[]]> = [];
  const statusHistory: PaymentSyncStatus[] = [];
  const cache = {
    getPaymentSyncStatus: jest.fn(async () => status),
    getDocumentsByContext: jest.fn(async () => documents),
    replacePaymentTransactions: jest.fn(async (docId: string, rows: PaymentTransactionRow[]) => {
      replacements.push([docId, rows]);
    }),
    setPaymentSyncStatus: jest.fn(async (nextStatus: PaymentSyncStatus) => {
      status = nextStatus;
      statusHistory.push(nextStatus);
    }),
  } as unknown as CacheService;
  return { cache, replacements, statusHistory, getStatus: () => status };
}

const clientWith = (get: jest.Mock): SalesBinderClient => (
  { documents: { get } } as unknown as SalesBinderClient
);

describe('payment sync helpers', () => {
  it('normalizes numeric strings and deterministically sorts transactions', () => {
    const rows = normalizePaymentTransactions('api-1', 'cache-1', [
      { id: 'txn-b', document_id: 'api-1', amount: '12.50', transaction_date: '2026-02-01T10:30:00Z' },
      { id: 'txn-a', document_id: 'api-1', amount: '0', transaction_date: '2026-02-01', reference: 'bank' },
    ], 123);

    expect(rows).toEqual([
      { transaction_id: 'txn-a', doc_id: 'cache-1', amount: 0, transaction_date: '2026-02-01', reference: 'bank', imported_at: 123 },
      { transaction_id: 'txn-b', doc_id: 'cache-1', amount: 12.5, transaction_date: '2026-02-01', reference: null, imported_at: 123 },
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'NaN', 'Infinity', '-Infinity', '', '   ', undefined])
  ('rejects non-finite amount %s', (amount) => {
    expect(() => normalizePaymentTransactions('api-1', 'cache-1', [
      { id: 'txn-1', document_id: 'api-1', amount, transaction_date: '2026-02-01' } as unknown as DocumentTransaction,
    ], 123)).toThrow('Payment transaction txn-1 has an invalid amount.');
  });

  it('rejects transactions belonging to another API document', () => {
    expect(() => normalizePaymentTransactions('api-1', 'cache-1', [
      { id: 'txn-1', document_id: 'api-2', amount: 10, transaction_date: '2026-02-01' },
    ], 123)).toThrow('belongs to document api-2, expected api-1');
  });

  it('rejects duplicate transaction IDs during normalization', () => {
    expect(() => normalizePaymentTransactions('api-1', 'cache-1', [
      { id: 'txn-duplicate', document_id: 'api-1', amount: 10, transaction_date: '2026-02-01' },
      { id: 'txn-duplicate', document_id: 'api-1', amount: 15, transaction_date: '2026-02-02' },
    ], 123)).toThrow('Duplicate payment transaction ID txn-duplicate in one write operation.');
  });

  it.each(['2026-02-30', '2026-13-01', 'not-a-date'])('rejects impossible transaction date %s', (transactionDate) => {
    expect(() => normalizePaymentTransactions('api-1', 'cache-1', [
      { id: 'txn-1', document_id: 'api-1', amount: 10, transaction_date: transactionDate },
    ], 123)).toThrow('Payment transaction txn-1 has an invalid transaction_date.');
  });

  it('requires an authoritative array and validates total_transactions as paid amount', () => {
    expect(() => normalizeDocumentPaymentTransactions(
      { id: 'api-1', total_transactions: 0 } as Document,
      'cache-1',
      123,
    )).toThrow('did not return an authoritative payment transaction array');

    expect(() => normalizeDocumentPaymentTransactions(
      { id: 'api-1', total_transactions: 2, transactions: [] } as unknown as Document,
      'cache-1',
      123,
    )).toThrow('returned inconsistent payment transaction totals');

    expect(normalizeDocumentPaymentTransactions({
      id: 'api-1',
      total_transactions: 1_000_000,
      transactions: [{
        id: 'txn-1', document_id: 'api-1', amount: 1_000_000, transaction_date: '2026-08-03',
      }],
    } as unknown as Document, 'cache-1', 123)).toHaveLength(1);
  });

  it.each([null, false, true, '', '   ', undefined])(
    'rejects malformed declared paid total %s',
    (total) => {
      expect(() => normalizeDocumentPaymentTransactions({
        id: 'api-1', total_transactions: total, transactions: [],
      } as unknown as Document, 'cache-1', 123)).toThrow(
        'returned inconsistent payment transaction totals',
      );
    },
  );

  it('sorts invoices by immutable cache ID without mutating input', () => {
    const documents = [
      invoice('z', '2026-02-02', 1), invoice('c', '2026-02-01', 2),
      invoice('b', '2026-02-01', 1), invoice('a', '2026-02-01', 1),
    ];

    expect(sortInvoicesForPaymentSync(documents).map((row) => row.doc_id)).toEqual(['a', 'b', 'c', 'z']);
    expect(documents.map((row) => row.doc_id)).toEqual(['z', 'c', 'b', 'a']);
  });

  it('treats a prior successful refresh as initialized after a later failure', () => {
    expect(isPaymentSyncInitialized(null)).toBe(false);
    expect(isPaymentSyncInitialized({ status: 'failed' } as PaymentSyncStatus)).toBe(false);
    expect(isPaymentSyncInitialized({
      status: 'failed', lastSuccessfulSync: 123,
    } as PaymentSyncStatus)).toBe(true);
  });
});

describe('PaymentSyncService', () => {
  it('backfills invoices in deterministic order and completes with persisted progress', async () => {
    const harness = testHarness([
      invoice('late', '2026-02-02', 2), invoice('early', '2026-02-01', 1, 'api-early'),
    ]);
    const get = jest.fn(async (id: string) => apiDocument(id, [
      { id: `txn-${id}`, document_id: id, amount: '4.25', transaction_date: '2026-03-01' },
    ]));
    const onProgress = jest.fn();

    const result = await new PaymentSyncService(clientWith(get), harness.cache)
      .syncHistoricalPayments({ onProgress, detailDelayMs: 0 });

    expect(get.mock.calls.map(([id]) => id)).toEqual(['api-early', 'late']);
    expect(harness.cache.getDocumentsByContext).toHaveBeenCalledWith(DocumentContextId.Invoice);
    expect(harness.replacements.map(([docId]) => docId)).toEqual(['early', 'late']);
    expect(harness.replacements[0][1][0]).toMatchObject({ doc_id: 'early', amount: 4.25 });
    expect(onProgress.mock.calls).toEqual([[1, 2, 1], [2, 2, 2]]);
    expect(result).toMatchObject({ success: true, resumed: false, documentsProcessed: 2, totalDocuments: 2, transactionsProcessed: 2, cursor: 'late' });
    expect(harness.statusHistory[0]).toMatchObject({ status: 'backfilling', processedDocuments: 0, totalDocuments: 2 });
    expect(harness.getStatus()).toMatchObject({ status: 'complete', processedDocuments: 2, cursor: 'late' });
  });

  it.each(['failed', 'backfilling'] as PaymentSyncState[])('resumes after a %s cursor', async (state) => {
    const documents = [
      invoice('done', '2026-01-01', 1), invoice('remaining', '2026-01-02', 2),
    ];
    const previous: PaymentSyncStatus = {
      status: state, mode: 'full', startedAt: 10, updatedAt: 11,
      cursor: 'done', processedDocuments: 1, totalDocuments: 2,
      snapshotHash: hashPaymentInvoiceSnapshot(documents),
    };
    const harness = testHarness(documents, previous);
    const get = jest.fn(async (id: string) => apiDocument(id, []));

    const result = await new PaymentSyncService(clientWith(get), harness.cache)
      .syncHistoricalPayments({ detailDelayMs: 0 });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('remaining');
    expect(result).toMatchObject({ resumed: true, documentsProcessed: 2, totalDocuments: 2, cursor: 'remaining' });
  });

  it('restarts instead of skipping a new invoice when an equal-size snapshot changes', async () => {
    const oldDocuments = [invoice('a', '2026-01-01', 1), invoice('b', '2026-01-02', 2)];
    const currentDocuments = [invoice('aa', '2026-01-01', 3), invoice('b', '2026-01-02', 2)];
    const previous: PaymentSyncStatus = {
      status: 'failed', mode: 'full', startedAt: 10, updatedAt: 11,
      cursor: 'b', processedDocuments: 2, totalDocuments: 2,
      snapshotHash: hashPaymentInvoiceSnapshot(oldDocuments),
    };
    const harness = testHarness(currentDocuments, previous);
    const get = jest.fn(async (id: string) => apiDocument(id, []));

    const result = await new PaymentSyncService(clientWith(get), harness.cache)
      .syncHistoricalPayments({ detailDelayMs: 0 });

    expect(result.resumed).toBe(false);
    expect(get.mock.calls.map(([id]) => id)).toEqual(['aa', 'b']);
  });

  it('persists sanitized failure metadata before rethrowing', async () => {
    const harness = testHarness([
      invoice('a-processed', '2026-01-01', 1), invoice('z-fails', '2026-01-02', 2),
    ]);
    const failure = new Error(' upstream\n  unavailable ');
    const get = jest.fn()
      .mockResolvedValueOnce(apiDocument('a-processed', []))
      .mockRejectedValueOnce(failure);
    const service = new PaymentSyncService(clientWith(get), harness.cache);

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(failure);
    expect(harness.getStatus()).toMatchObject({
      status: 'failed', cursor: 'a-processed', processedDocuments: 1, totalDocuments: 2,
      error: 'upstream unavailable',
    });
  });

  it('rethrows the original sync error when failed-status persistence also fails', async () => {
    const originalFailure = new Error('upstream unavailable');
    const statusWriteFailure = new Error('metadata unavailable');
    const harness = testHarness([invoice('z-fails', '2026-01-02', 2)]);
    (harness.cache.setPaymentSyncStatus as jest.Mock).mockImplementation(async (nextStatus: PaymentSyncStatus) => {
      if (nextStatus.status === 'failed') throw statusWriteFailure;
    });

    const service = new PaymentSyncService(
      clientWith(jest.fn().mockRejectedValue(originalFailure)),
      harness.cache,
    );

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(originalFailure);
    expect(harness.cache.setPaymentSyncStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'backfilling' }));
    expect(harness.cache.setPaymentSyncStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('fails closed when the detail response omits its payment list', async () => {
    const harness = testHarness([invoice('invoice-1', '2026-01-01', 1)]);
    const service = new PaymentSyncService(
      clientWith(jest.fn().mockResolvedValue(apiDocument('invoice-1'))), harness.cache,
    );

    await expect(service.syncHistoricalPayments()).rejects.toThrow(
      'did not return an authoritative payment transaction array',
    );
    expect(harness.replacements).toEqual([]);
    expect(harness.getStatus()).toMatchObject({ status: 'failed', processedDocuments: 0 });
  });

  it('fails before fetching a CSV-only invoice that has no SalesBinder ID', async () => {
    const harness = testHarness([
      { ...invoice('csv-1', '2026-01-01', 1), cache_source: 'csv' },
    ]);
    const get = jest.fn();

    await expect(new PaymentSyncService(clientWith(get), harness.cache).syncHistoricalPayments())
      .rejects.toThrow('must be reconciled from SalesBinder before payment backfill');
    expect(get).not.toHaveBeenCalled();
    expect(harness.getStatus()).toMatchObject({ status: 'failed', processedDocuments: 0 });
  });

  it('does not mark the run complete if the invoice set changes during backfill', async () => {
    const initial = [invoice('invoice-1', '2026-01-01', 1)];
    const harness = testHarness(initial);
    (harness.cache.getDocumentsByContext as jest.Mock)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce([...initial, invoice('invoice-2', '2026-01-02', 2)]);

    await expect(new PaymentSyncService(
      clientWith(jest.fn().mockResolvedValue(apiDocument('invoice-1', []))),
      harness.cache,
    ).syncHistoricalPayments()).rejects.toThrow('Invoice cache changed during payment backfill');
    expect(harness.getStatus()).toMatchObject({ status: 'failed' });
  });

  it('preserves cached payments and fails when a detail response is 404', async () => {
    const harness = testHarness([invoice('missing', '2026-01-01', 1)]);
    const notFound = { response: { status: 404 } };
    const service = new PaymentSyncService(clientWith(jest.fn().mockRejectedValue(notFound)), harness.cache);

    await expect(service.syncHistoricalPayments()).rejects.toBe(notFound);
    expect(harness.replacements).toEqual([]);
    expect(harness.getStatus()).toMatchObject({ status: 'failed', cursor: null, processedDocuments: 0 });
  });
});

describe('DocumentIndexerService payment freshness', () => {
  it('advances a completed payment sync after a successful no-change delta', async () => {
    const priorStatus: PaymentSyncStatus = {
      status: 'failed', mode: 'delta', startedAt: 10, updatedAt: 20,
      finishedAt: 20, lastSuccessfulSync: 20, cursor: 'invoice-1',
      processedDocuments: 1, totalDocuments: 1,
    };
    let nextStatus: PaymentSyncStatus | null = null;
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 100, lastFullSync: 100, documentCount: 1, itemDocumentCount: 0,
        accountName: 'test-account', schemaVersion: 3,
      })),
      getPaymentSyncStatus: jest.fn(async () => priorStatus),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async (status: PaymentSyncStatus) => { nextStatus = status; }),
    } as unknown as CacheService;
    const client = clientWith(jest.fn()) as SalesBinderClient & {
      documents: { list: jest.Mock; get: jest.Mock };
    };
    client.documents.list = jest.fn(async () => ({ documents: [] }));

    await new DocumentIndexerService(client, cache, 'test-account').sync();

    expect(nextStatus).toMatchObject({
      status: 'complete', mode: 'delta', processedDocuments: 0, totalDocuments: 0,
    });
    expect((nextStatus as PaymentSyncStatus | null)?.lastSuccessfulSync).toBeGreaterThan(20);
  });
});
