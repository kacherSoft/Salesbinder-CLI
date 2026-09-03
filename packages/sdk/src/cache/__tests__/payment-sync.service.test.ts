import { createHash } from 'node:crypto';
import { AxiosError } from 'axios';
import type { SalesBinderClient } from '../../resources/index.js';
import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
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
import type {
  PaymentSyncState,
  PaymentSyncStatus,
  PaymentTransactionRow,
} from '../payment-sync.types.js';
import { DocumentContextId, type DocumentRow } from '../types.js';

const invoice = (
  docId: string,
  issueDate: string,
  docNumber: number,
  apiDocId?: string
): DocumentRow => ({
  doc_id: docId,
  api_doc_id: apiDocId,
  context_id: DocumentContextId.Invoice,
  doc_number: docNumber,
  issue_date: issueDate,
  customer_id: 'customer-1',
  modified: 1,
});

const apiDocument = (
  id: string,
  transactions?: DocumentTransaction[],
  contextId: DocumentContextId = DocumentContextId.Invoice
): Document =>
  ({
    id,
    context_id: contextId,
    transactions,
    total_transactions:
      transactions?.reduce((sum, transaction) => sum + Number(transaction.amount), 0) ?? 0,
  }) as Document;

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

const clientWith = (get: jest.Mock): SalesBinderClient =>
  ({ documents: { get } }) as unknown as SalesBinderClient;

function legacyPaymentInvoiceSnapshotHash(documents: Array<{ doc_id: string }>): string {
  const hash = createHash('sha256');
  for (const document of documents) hash.update(document.doc_id).update('\0');
  return hash.digest('hex');
}

describe('payment sync helpers', () => {
  it('normalizes numeric strings and deterministically sorts transactions', () => {
    const rows = normalizePaymentTransactions(
      'api-1',
      'cache-1',
      [
        {
          id: 'txn-b',
          document_id: 'api-1',
          amount: '12.50',
          transaction_date: '2026-02-01T10:30:00.123456+07:00',
        },
        {
          id: 'txn-a',
          document_id: 'api-1',
          amount: '0',
          transaction_date: '2026-02-01',
          reference: 'bank',
        },
      ],
      123
    );

    expect(rows).toEqual([
      {
        transaction_id: 'txn-a',
        doc_id: 'cache-1',
        amount: 0,
        transaction_date: '2026-02-01',
        reference: 'bank',
        imported_at: 123,
      },
      {
        transaction_id: 'txn-b',
        doc_id: 'cache-1',
        amount: 12.5,
        transaction_date: '2026-02-01',
        reference: null,
        imported_at: 123,
      },
    ]);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'NaN',
    'Infinity',
    '-Infinity',
    '0x10',
    '0b10',
    '0o10',
    '1e2',
    ' 1 ',
    '',
    '   ',
    undefined,
  ])('rejects non-finite amount %s', (amount) => {
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          {
            id: 'txn-1',
            document_id: 'api-1',
            amount,
            transaction_date: '2026-02-01',
          } as unknown as DocumentTransaction,
        ],
        123
      )
    ).toThrow('Payment transaction txn-1 has an invalid amount.');
  });

  it('rejects transactions belonging to another API document', () => {
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [{ id: 'txn-1', document_id: 'api-2', amount: 10, transaction_date: '2026-02-01' }],
        123
      )
    ).toThrow('belongs to document api-2, expected api-1');
  });

  it('rejects duplicate transaction IDs during normalization', () => {
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          { id: 'txn-duplicate', document_id: 'api-1', amount: 10, transaction_date: '2026-02-01' },
          { id: 'txn-duplicate', document_id: 'api-1', amount: 15, transaction_date: '2026-02-02' },
        ],
        123
      )
    ).toThrow('Duplicate payment transaction ID txn-duplicate in one write operation.');
  });

  it.each([
    ['transaction ID', 'api-1', { id: 'x'.repeat(257), document_id: 'api-1' }],
    ['transaction ID', 'api-1', { id: 'txn\u0001', document_id: 'api-1' }],
    ['transaction ID', 'api-1', { id: 'txn-\ud800', document_id: 'api-1' }],
    ['document ID', 'api-1\u007f', { id: 'txn-1', document_id: 'api-1\u007f' }],
    ['document ID', 'api-1\udc00', { id: 'txn-1', document_id: 'api-1\udc00' }],
  ])('rejects a non-canonical %s', (_, apiDocumentId, transaction) => {
    expect(() =>
      normalizePaymentTransactions(
        apiDocumentId,
        'cache-1',
        [
          {
            ...transaction,
            amount: 10,
            transaction_date: '2026-02-01',
          },
        ] as DocumentTransaction[],
        123
      )
    ).toThrow(ApiResponseValidationError);
  });

  it('accepts valid non-BMP payment IDs and reference text', () => {
    expect(
      normalizePaymentTransactions(
        'api-😀',
        'cache-1',
        [
          {
            id: 'txn-😀',
            document_id: 'api-😀',
            amount: 10,
            transaction_date: '2026-02-01',
            reference: 'Paid 😀',
          },
        ],
        123
      )
    ).toEqual([
      expect.objectContaining({
        transaction_id: 'txn-😀',
        reference: 'Paid 😀',
      }),
    ]);
  });

  it('rejects PostgreSQL-invalid NUL bytes in payment references as a record error', () => {
    try {
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          {
            id: 'txn-1',
            document_id: 'api-1',
            amount: 10,
            transaction_date: '2026-02-01',
            reference: 'bank\0transfer',
          },
        ],
        123
      );
      throw new Error('Expected payment reference validation to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_api_response',
        sourceScope: 'record',
      });
    }
  });

  it.each(['reference \ud800', 'reference \udc00'])(
    'rejects an unpaired surrogate in payment reference %j as a record error',
    (reference) => {
      expect(() =>
        normalizePaymentTransactions(
          'api-1',
          'cache-1',
          [
            {
              id: 'txn-1',
              document_id: 'api-1',
              amount: 10,
              transaction_date: '2026-02-01',
              reference,
            },
          ],
          123
        )
      ).toThrow(ApiResponseValidationError);
    }
  );

  it.each(['x'.repeat(257), 'api-1\u0001'])(
    'rejects a non-canonical top-level document ID with no transactions',
    (id) => {
      expect(() =>
        normalizeDocumentPaymentTransactions(
          { id, total_transactions: 0, transactions: [] } as unknown as Document,
          'cache-1',
          123
        )
      ).toThrow(ApiResponseValidationError);
    }
  );

  it('uses nominal validation errors for malformed transaction entries', () => {
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [null as unknown as DocumentTransaction],
        123
      )
    ).toThrow(ApiResponseValidationError);
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          {
            id: 'txn-1',
            document_id: 'api-1',
            amount: 1,
            transaction_date: undefined,
          } as unknown as DocumentTransaction,
        ],
        123
      )
    ).toThrow(ApiResponseValidationError);
  });

  it.each([
    '2026-02-30',
    '2026-13-01',
    'not-a-date',
    '03/04/2026',
    '0000-01-01',
    '0000-01-01T00:00:00Z',
    '1',
    '2026-02-01T',
    '2026-02-01Tgarbage',
    '2026-02-01T99:99:99Z',
  ])('rejects impossible transaction date %s', (transactionDate) => {
    expect(() =>
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [{ id: 'txn-1', document_id: 'api-1', amount: 10, transaction_date: transactionDate }],
        123
      )
    ).toThrow('Payment transaction txn-1 has an invalid transaction_date.');
  });

  it('classifies a year-zero payment timestamp as a record-local source error', () => {
    try {
      normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          {
            id: 'txn-1',
            document_id: 'api-1',
            amount: 10,
            transaction_date: '0000-01-01T00:00:00Z',
          },
        ],
        123
      );
      throw new Error('Expected source validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiResponseValidationError);
      expect(error).toMatchObject({ sourceScope: 'record' });
    }
  });

  it('requires an authoritative array and validates total_transactions as paid amount', () => {
    try {
      normalizeDocumentPaymentTransactions(
        { id: 'api-1', total_transactions: 0 } as Document,
        'cache-1',
        123
      );
      throw new Error('Expected source validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiResponseValidationError);
      expect(error).toHaveProperty(
        'message',
        'Document api-1 did not return an authoritative payment transaction array.'
      );
    }

    expect(() =>
      normalizeDocumentPaymentTransactions(
        { id: 'api-1', total_transactions: 2, transactions: [] } as unknown as Document,
        'cache-1',
        123
      )
    ).toThrow('returned inconsistent payment transaction totals');

    expect(
      normalizeDocumentPaymentTransactions(
        {
          id: 'api-1',
          total_transactions: 1_000_000,
          transactions: [
            {
              id: 'txn-1',
              document_id: 'api-1',
              amount: 1_000_000,
              transaction_date: '2026-08-03',
            },
          ],
        } as unknown as Document,
        'cache-1',
        123
      )
    ).toHaveLength(1);
  });

  it.each([null, false, true, '', '   ', undefined])(
    'rejects malformed declared paid total %s',
    (total) => {
      expect(() =>
        normalizeDocumentPaymentTransactions(
          {
            id: 'api-1',
            total_transactions: total,
            transactions: [],
          } as unknown as Document,
          'cache-1',
          123
        )
      ).toThrow('returned inconsistent payment transaction totals');
    }
  );

  it('sorts invoices by immutable cache ID without mutating input', () => {
    const documents = [
      invoice('z', '2026-02-02', 1),
      invoice('c', '2026-02-01', 2),
      invoice('b', '2026-02-01', 1),
      invoice('a', '2026-02-01', 1),
    ];

    expect(sortInvoicesForPaymentSync(documents).map((row) => row.doc_id)).toEqual([
      'a',
      'b',
      'c',
      'z',
    ]);
    expect(documents.map((row) => row.doc_id)).toEqual(['z', 'c', 'b', 'a']);
  });

  it('sorts payment snapshot invoice IDs by UTF-16 code units without locale collation', () => {
    const documents = [
      invoice('ä', '2026-02-01', 1),
      invoice('z', '2026-02-01', 2),
      invoice('Å', '2026-02-01', 3),
    ];
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Payment snapshot ordering must not depend on locale collation');
    });
    let sorted: DocumentRow[] = [];
    let reversed: DocumentRow[] = [];

    try {
      sorted = sortInvoicesForPaymentSync(documents);
      reversed = sortInvoicesForPaymentSync([...documents].reverse());
    } finally {
      localeCompare.mockRestore();
    }

    expect(sorted.map((row) => row.doc_id)).toEqual(['z', 'Å', 'ä']);
    expect(hashPaymentInvoiceSnapshot(reversed)).toBe(hashPaymentInvoiceSnapshot(sorted));
  });

  it('includes the canonical API identity and a new format version in snapshot hashes', () => {
    const original = [invoice('cache-invoice', '2026-02-01', 1, 'api-old')];
    const remapped = [invoice('cache-invoice', '2026-02-01', 1, 'api-new')];
    const fallback = [invoice('cache-invoice', '2026-02-01', 1)];
    const explicitFallback = [invoice('cache-invoice', '2026-02-01', 1, 'cache-invoice')];

    expect(hashPaymentInvoiceSnapshot(original)).not.toBe(hashPaymentInvoiceSnapshot(remapped));
    expect(hashPaymentInvoiceSnapshot(fallback)).toBe(hashPaymentInvoiceSnapshot(explicitFallback));
    expect(hashPaymentInvoiceSnapshot(original)).not.toBe(
      legacyPaymentInvoiceSnapshotHash(original)
    );
  });

  it('sorts same-date payment transaction IDs by UTF-16 code units without locale collation', () => {
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Payment transaction ordering must not depend on locale collation');
    });
    let rows: PaymentTransactionRow[] = [];

    try {
      rows = normalizePaymentTransactions(
        'api-1',
        'cache-1',
        [
          { id: 'ä', document_id: 'api-1', amount: 1, transaction_date: '2026-02-01' },
          { id: 'z', document_id: 'api-1', amount: 1, transaction_date: '2026-02-01' },
          { id: 'Å', document_id: 'api-1', amount: 1, transaction_date: '2026-02-01' },
        ],
        123
      );
    } finally {
      localeCompare.mockRestore();
    }

    expect(rows.map((row) => row.transaction_id)).toEqual(['z', 'Å', 'ä']);
  });

  it('treats a prior successful refresh as initialized after a later failure', () => {
    expect(isPaymentSyncInitialized(null)).toBe(false);
    expect(isPaymentSyncInitialized({ status: 'failed' } as PaymentSyncStatus)).toBe(false);
    expect(
      isPaymentSyncInitialized({
        status: 'failed',
        lastSuccessfulSync: 123,
      } as PaymentSyncStatus)
    ).toBe(true);
  });
});

describe('PaymentSyncService', () => {
  it('backfills invoices in deterministic order and completes with persisted progress', async () => {
    const harness = testHarness([
      invoice('late', '2026-02-02', 2),
      invoice('early', '2026-02-01', 1, 'api-early'),
    ]);
    const get = jest.fn(async (id: string) =>
      apiDocument(id, [
        { id: `txn-${id}`, document_id: id, amount: '4.25', transaction_date: '2026-03-01' },
      ])
    );
    const onProgress = jest.fn();

    const result = await new PaymentSyncService(
      clientWith(get),
      harness.cache
    ).syncHistoricalPayments({ onProgress, detailDelayMs: 0 });

    expect(get.mock.calls.map(([id]) => id)).toEqual(['api-early', 'late']);
    expect(harness.cache.getDocumentsByContext).toHaveBeenCalledWith(DocumentContextId.Invoice);
    expect(harness.replacements.map(([docId]) => docId)).toEqual(['early', 'late']);
    expect(harness.replacements[0][1][0]).toMatchObject({ doc_id: 'early', amount: 4.25 });
    expect(onProgress.mock.calls).toEqual([
      [1, 2, 1],
      [2, 2, 2],
    ]);
    expect(result).toMatchObject({
      success: true,
      resumed: false,
      documentsProcessed: 2,
      totalDocuments: 2,
      transactionsProcessed: 2,
      cursor: 'late',
    });
    expect(harness.statusHistory[0]).toMatchObject({
      status: 'backfilling',
      processedDocuments: 0,
      totalDocuments: 2,
    });
    expect(harness.getStatus()).toMatchObject({
      status: 'complete',
      processedDocuments: 2,
      cursor: 'late',
    });
  });

  it.each(['failed', 'backfilling'] as PaymentSyncState[])(
    'resumes after a %s cursor',
    async (state) => {
      const documents = [invoice('done', '2026-01-01', 1), invoice('remaining', '2026-01-02', 2)];
      const previous: PaymentSyncStatus = {
        status: state,
        mode: 'full',
        startedAt: 10,
        updatedAt: 11,
        cursor: 'done',
        processedDocuments: 1,
        totalDocuments: 2,
        snapshotHash: hashPaymentInvoiceSnapshot(documents),
      };
      const harness = testHarness(documents, previous);
      const get = jest.fn(async (id: string) => apiDocument(id, []));

      const result = await new PaymentSyncService(
        clientWith(get),
        harness.cache
      ).syncHistoricalPayments({ detailDelayMs: 0 });

      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('remaining');
      expect(result).toMatchObject({
        resumed: true,
        documentsProcessed: 2,
        totalDocuments: 2,
        cursor: 'remaining',
      });
    }
  );

  it('restarts and refreshes a processed invoice when reconciliation remaps its API identity', async () => {
    const documents = [
      invoice('cache-invoice', '2026-01-01', 1, 'api-old'),
      invoice('remaining', '2026-01-02', 2),
    ];
    const harness = testHarness(documents);
    const firstFailure = new Error('temporary detail failure');
    let failRemaining = true;
    const get = jest.fn(async (id: string) => {
      if (id === 'remaining' && failRemaining) {
        failRemaining = false;
        throw firstFailure;
      }
      return apiDocument(id, [
        { id: `txn-${id}`, document_id: id, amount: 1, transaction_date: '2026-01-03' },
      ]);
    });
    const service = new PaymentSyncService(clientWith(get), harness.cache);

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(firstFailure);
    expect(harness.getStatus()).toMatchObject({
      status: 'failed',
      cursor: 'cache-invoice',
      processedDocuments: 1,
    });

    documents[0].api_doc_id = 'api-new';
    const result = await service.syncHistoricalPayments({ detailDelayMs: 0 });

    expect(result.resumed).toBe(false);
    expect(get.mock.calls.map(([id]) => id)).toEqual([
      'api-old',
      'remaining',
      'api-new',
      'remaining',
    ]);
    expect(harness.replacements.filter(([docId]) => docId === 'cache-invoice').at(-1)?.[1]).toEqual(
      [expect.objectContaining({ transaction_id: 'txn-api-new', doc_id: 'cache-invoice' })]
    );
    expect(harness.getStatus()).toMatchObject({ status: 'complete' });
  });

  it.each(['failed', 'backfilling'] as PaymentSyncState[])(
    'safely restarts a legacy doc-id-only %s checkpoint',
    async (state) => {
      const documents = [
        invoice('done', '2026-01-01', 1, 'api-done'),
        invoice('remaining', '2026-01-02', 2),
      ];
      const previous: PaymentSyncStatus = {
        status: state,
        mode: 'full',
        startedAt: 10,
        updatedAt: 11,
        cursor: 'done',
        processedDocuments: 1,
        totalDocuments: 2,
        snapshotHash: legacyPaymentInvoiceSnapshotHash(documents),
      };
      const harness = testHarness(documents, previous);
      const get = jest.fn(async (id: string) => apiDocument(id, []));

      const result = await new PaymentSyncService(
        clientWith(get),
        harness.cache
      ).syncHistoricalPayments({ detailDelayMs: 0 });

      expect(result.resumed).toBe(false);
      expect(get.mock.calls.map(([id]) => id)).toEqual(['api-done', 'remaining']);
      expect(harness.getStatus()).toMatchObject({
        status: 'complete',
        snapshotHash: hashPaymentInvoiceSnapshot(documents),
      });
    }
  );

  it('restarts instead of skipping a new invoice when an equal-size snapshot changes', async () => {
    const oldDocuments = [invoice('a', '2026-01-01', 1), invoice('b', '2026-01-02', 2)];
    const currentDocuments = [invoice('aa', '2026-01-01', 3), invoice('b', '2026-01-02', 2)];
    const previous: PaymentSyncStatus = {
      status: 'failed',
      mode: 'full',
      startedAt: 10,
      updatedAt: 11,
      cursor: 'b',
      processedDocuments: 2,
      totalDocuments: 2,
      snapshotHash: hashPaymentInvoiceSnapshot(oldDocuments),
    };
    const harness = testHarness(currentDocuments, previous);
    const get = jest.fn(async (id: string) => apiDocument(id, []));

    const result = await new PaymentSyncService(
      clientWith(get),
      harness.cache
    ).syncHistoricalPayments({ detailDelayMs: 0 });

    expect(result.resumed).toBe(false);
    expect(get.mock.calls.map(([id]) => id)).toEqual(['aa', 'b']);
  });

  it('persists allowlisted failure metadata before rethrowing', async () => {
    const harness = testHarness([
      invoice('a-processed', '2026-01-01', 1),
      invoice('z-fails', '2026-01-02', 2),
    ]);
    const failure = new Error(' upstream\n  unavailable ');
    const get = jest
      .fn()
      .mockResolvedValueOnce(apiDocument('a-processed', []))
      .mockRejectedValueOnce(failure);
    const service = new PaymentSyncService(clientWith(get), harness.cache);

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(failure);
    expect(harness.getStatus()).toMatchObject({
      status: 'failed',
      cursor: 'a-processed',
      processedDocuments: 1,
      totalDocuments: 2,
      error: 'Payment sync failed',
    });
  });

  it('never persists request URLs, credentials, headers, or payload text from failures', async () => {
    const harness = testHarness([invoice('z-fails', '2026-01-02', 2)]);
    const failure = new Error(
      'request to https://private.invalid/path failed Authorization: Bearer secret-value payload=private-body'
    );
    const service = new PaymentSyncService(
      clientWith(jest.fn().mockRejectedValue(failure)),
      harness.cache
    );

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(failure);
    const status = harness.getStatus();
    expect(status).toMatchObject({ status: 'failed', error: 'Payment sync failed' });
    expect(JSON.stringify(status)).not.toMatch(
      /private\.invalid|secret-value|private-body|Authorization/i
    );
  });

  it('rethrows the original sync error when failed-status persistence also fails', async () => {
    const originalFailure = new Error('upstream unavailable');
    const statusWriteFailure = new Error('metadata unavailable');
    const harness = testHarness([invoice('z-fails', '2026-01-02', 2)]);
    (harness.cache.setPaymentSyncStatus as jest.Mock).mockImplementation(
      async (nextStatus: PaymentSyncStatus) => {
        if (nextStatus.status === 'failed') throw statusWriteFailure;
      }
    );

    const service = new PaymentSyncService(
      clientWith(jest.fn().mockRejectedValue(originalFailure)),
      harness.cache
    );

    await expect(service.syncHistoricalPayments({ detailDelayMs: 0 })).rejects.toBe(
      originalFailure
    );
    expect(harness.cache.setPaymentSyncStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'backfilling' })
    );
    expect(harness.cache.setPaymentSyncStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('fails closed when the detail response omits its payment list', async () => {
    const harness = testHarness([invoice('invoice-1', '2026-01-01', 1)]);
    const service = new PaymentSyncService(
      clientWith(jest.fn().mockResolvedValue(apiDocument('invoice-1'))),
      harness.cache
    );

    await expect(service.syncHistoricalPayments()).rejects.toThrow(
      'did not return an authoritative payment transaction array'
    );
    expect(harness.replacements).toEqual([]);
    expect(harness.getStatus()).toMatchObject({ status: 'failed', processedDocuments: 0 });
  });

  it.each([
    ['transaction_date', 1, '2026-01-02Tgarbage'],
    ['amount', '0x10', '2026-01-02'],
  ])(
    'preserves cached payments and prior success when %s is malformed',
    async (_field, amount, transactionDate) => {
      const previous: PaymentSyncStatus = {
        status: 'complete',
        mode: 'full',
        startedAt: 10,
        updatedAt: 20,
        finishedAt: 20,
        lastSuccessfulSync: 20,
        cursor: 'invoice-1',
        processedDocuments: 1,
        totalDocuments: 1,
      };
      const harness = testHarness([invoice('invoice-1', '2026-01-01', 1)], previous);
      const malformed = apiDocument('invoice-1', [
        {
          id: 'txn-1',
          document_id: 'invoice-1',
          amount,
          transaction_date: transactionDate,
        },
      ]);

      await expect(
        new PaymentSyncService(
          clientWith(jest.fn(async () => malformed)),
          harness.cache
        ).syncHistoricalPayments({ detailDelayMs: 0 })
      ).rejects.toThrow(ApiResponseValidationError);

      expect(harness.replacements).toEqual([]);
      expect(harness.getStatus()).toMatchObject({
        status: 'failed',
        lastSuccessfulSync: 20,
        processedDocuments: 0,
        error: 'Payment sync failed',
      });
    }
  );

  it('fails before fetching a CSV-only invoice that has no SalesBinder ID', async () => {
    const harness = testHarness([{ ...invoice('csv-1', '2026-01-01', 1), cache_source: 'csv' }]);
    const get = jest.fn();

    await expect(
      new PaymentSyncService(clientWith(get), harness.cache).syncHistoricalPayments()
    ).rejects.toThrow('must be reconciled from SalesBinder before payment backfill');
    expect(get).not.toHaveBeenCalled();
    expect(harness.getStatus()).toMatchObject({ status: 'failed', processedDocuments: 0 });
  });

  it('does not mark the run complete if the invoice set changes during backfill', async () => {
    const initial = [invoice('invoice-1', '2026-01-01', 1)];
    const harness = testHarness(initial);
    (harness.cache.getDocumentsByContext as jest.Mock)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce([...initial, invoice('invoice-2', '2026-01-02', 2)]);

    await expect(
      new PaymentSyncService(
        clientWith(jest.fn().mockResolvedValue(apiDocument('invoice-1', []))),
        harness.cache
      ).syncHistoricalPayments()
    ).rejects.toThrow('Invoice cache changed during payment backfill');
    expect(harness.getStatus()).toMatchObject({ status: 'failed' });
  });

  it('does not mark the run complete if an invoice API identity changes during backfill', async () => {
    const initial = [invoice('cache-invoice', '2026-01-01', 1, 'api-old')];
    const remapped = [invoice('cache-invoice', '2026-01-01', 1, 'api-new')];
    const harness = testHarness(initial);
    (harness.cache.getDocumentsByContext as jest.Mock)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(remapped);

    await expect(
      new PaymentSyncService(
        clientWith(jest.fn().mockResolvedValue(apiDocument('api-old', []))),
        harness.cache
      ).syncHistoricalPayments()
    ).rejects.toThrow('Invoice cache changed during payment backfill');

    expect(harness.statusHistory.map(({ status }) => status).at(-1)).toBe('failed');
    expect(harness.statusHistory).not.toContainEqual(
      expect.objectContaining({ status: 'complete' })
    );
  });

  it('preserves cached payments and fails when a detail response is 404', async () => {
    const harness = testHarness([invoice('missing', '2026-01-01', 1)]);
    const notFound = { response: { status: 404 } };
    const service = new PaymentSyncService(
      clientWith(jest.fn().mockRejectedValue(notFound)),
      harness.cache
    );

    await expect(service.syncHistoricalPayments()).rejects.toBe(notFound);
    expect(harness.replacements).toEqual([]);
    expect(harness.getStatus()).toMatchObject({
      status: 'failed',
      cursor: null,
      processedDocuments: 0,
    });
  });

  it('preserves cached payments when a detail response is not an invoice', async () => {
    const harness = testHarness([invoice('invoice-1', '2026-01-01', 1)]);
    const service = new PaymentSyncService(
      clientWith(
        jest.fn().mockResolvedValue(apiDocument('invoice-1', [], DocumentContextId.Estimate))
      ),
      harness.cache
    );

    await expect(service.syncHistoricalPayments()).rejects.toThrow(
      'SalesBinder returned a non-invoice document.'
    );
    expect(harness.replacements).toEqual([]);
    expect(harness.getStatus()).toMatchObject({
      status: 'failed',
      cursor: null,
      processedDocuments: 0,
      error: 'Payment sync failed',
    });
  });
});

describe('DocumentIndexerService payment freshness', () => {
  it('advances a completed payment sync after a successful no-change delta', async () => {
    const priorStatus: PaymentSyncStatus = {
      status: 'failed',
      mode: 'delta',
      startedAt: 10,
      updatedAt: 20,
      finishedAt: 20,
      lastSuccessfulSync: 20,
      cursor: 'invoice-1',
      processedDocuments: 1,
      totalDocuments: 1,
    };
    let nextStatus: PaymentSyncStatus | null = null;
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 100,
        lastFullSync: 100,
        documentCount: 1,
        itemDocumentCount: 0,
        accountName: 'test-account',
        schemaVersion: 3,
      })),
      getPaymentSyncStatus: jest.fn(async () => priorStatus),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 0),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setCacheState: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async (status: PaymentSyncStatus) => {
        nextStatus = status;
      }),
    } as unknown as CacheService;
    const client = clientWith(jest.fn()) as SalesBinderClient & {
      documents: { list: jest.Mock; get: jest.Mock };
    };
    client.documents.list = jest.fn(async () => ({ documents: [] }));

    await new DocumentIndexerService(client, cache, 'test-account').sync();

    expect(nextStatus).toMatchObject({
      status: 'complete',
      mode: 'delta',
      processedDocuments: 0,
      totalDocuments: 0,
    });
    expect((nextStatus as PaymentSyncStatus | null)?.lastSuccessfulSync).toBeGreaterThan(20);
  });

  it('does not mark payment refresh complete when an invoice remains unresolved', async () => {
    const priorStatus: PaymentSyncStatus = {
      status: 'complete',
      mode: 'delta',
      startedAt: 10,
      updatedAt: 20,
      finishedAt: 20,
      lastSuccessfulSync: 20,
      cursor: 'invoice-old',
      processedDocuments: 1,
      totalDocuments: 1,
    };
    const statusHistory: PaymentSyncStatus[] = [];
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 100,
        lastFullSync: 100,
        documentCount: 1,
        itemDocumentCount: 0,
        accountName: 'test-account',
        schemaVersion: 7,
      })),
      getPaymentSyncStatus: jest.fn(async () => priorStatus),
      getDocumentByApiId: jest.fn(async () =>
        invoice('cached-invoice', '2026-01-01', 1, 'invoice-1')
      ),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async (status: PaymentSyncStatus) => {
        statusHistory.push(status);
      }),
    } as unknown as CacheService;
    const malformed = {
      id: 'invoice-1',
      context_id: DocumentContextId.Invoice,
      document_number: 1,
      customer_id: 'customer-1',
      user_id: 'user-1',
      issue_date: '2026-01-01',
      status_id: 1,
      total_cost: 1,
      total_tax: 0,
      total_tax2: 0,
      total_price: 2,
      total_transactions: 0,
      created: '2026-01-01',
      modified: 'invalid',
      document_items: [],
      transactions: [],
    } as Document;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Invoice && page === 1 ? [[malformed]] : [],
        })),
        get: jest.fn(async () => {
          throw axiosNotFound();
        }),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test-account').sync();

    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: 'invoice-1',
        context_id: DocumentContextId.Invoice,
        outcome: 'preserved_last_known_good',
      }),
    ]);
    expect(statusHistory.at(-1)).toMatchObject({
      status: 'failed',
      lastSuccessfulSync: 20,
      processedDocuments: 0,
      error: 'Invoice document refresh completed with unresolved records.',
    });
    expect(statusHistory).not.toContainEqual(expect.objectContaining({ status: 'complete' }));
  });

  it('recovers malformed payment references without reaching either cache backend', async () => {
    const statusHistory: PaymentSyncStatus[] = [];
    const malformed = {
      id: 'invoice-1',
      context_id: DocumentContextId.Invoice,
      document_number: 1,
      customer_id: 'customer-1',
      user_id: 'user-1',
      issue_date: '2026-01-01',
      status_id: 1,
      total_cost: 1,
      total_tax: 0,
      total_tax2: 0,
      total_price: 1,
      total_transactions: 1,
      created: '2026-01-01',
      modified: '2026-01-02',
      document_items: [
        {
          id: 'line-1',
          document_id: 'invoice-1',
          item_id: 'item-1',
          quantity: 1,
          quantity_partially_received: 0,
          tax: 0,
          tax2: 0,
          discount_percent: 0,
          cost: 1,
          price: 1,
          discounted_price: 1,
          weight: 0,
          created: '2026-01-01',
          modified: '2026-01-02',
        },
      ],
      transactions: [
        {
          id: 'txn-1',
          document_id: 'invoice-1',
          amount: 1,
          transaction_date: '2026-01-02',
          reference: 'bank\0transfer',
        },
      ],
    } as Document;
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 100,
        lastFullSync: 100,
        documentCount: 1,
        itemDocumentCount: 1,
        accountName: 'test-account',
        schemaVersion: 7,
      })),
      getPaymentSyncStatus: jest.fn(async () => ({
        status: 'complete',
        mode: 'full',
        startedAt: 10,
        updatedAt: 20,
        finishedAt: 20,
        lastSuccessfulSync: 20,
        cursor: 'invoice-1',
        processedDocuments: 1,
        totalDocuments: 1,
      })),
      getDocumentByApiId: jest.fn(async () =>
        invoice('cached-invoice', '2026-01-01', 1, 'invoice-1')
      ),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async (status: PaymentSyncStatus) => {
        statusHistory.push(status);
      }),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Invoice && page === 1 ? [[malformed]] : [],
        })),
        get: jest.fn(async () => malformed),
      },
    } as unknown as SalesBinderClient;

    const result = await new DocumentIndexerService(client, cache, 'test-account').sync({
      full: true,
    });

    expect(client.documents.get).toHaveBeenCalledTimes(2);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: 'invoice-1',
        context_id: DocumentContextId.Invoice,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
    expect(statusHistory.at(-1)).toMatchObject({
      status: 'failed',
      error: 'Invoice document refresh completed with unresolved records.',
    });
  });

  it('stores and logs a fixed message for arbitrary document-sync failures', async () => {
    const privateMarker = 'private-request-marker';
    const failure = new Error(`Request failed at https://example.invalid?token=${privateMarker}`);
    const statusHistory: PaymentSyncStatus[] = [];
    const cache = {
      getCacheState: jest.fn(async () => ({
        lastSync: 100,
        lastFullSync: 100,
        documentCount: 1,
        itemDocumentCount: 0,
        accountName: 'test-account',
        schemaVersion: 7,
      })),
      getPaymentSyncStatus: jest.fn(
        async () =>
          ({
            status: 'complete',
            mode: 'delta',
            startedAt: 10,
            updatedAt: 20,
            finishedAt: 20,
            lastSuccessfulSync: 20,
            cursor: null,
            processedDocuments: 1,
            totalDocuments: 1,
          }) as PaymentSyncStatus
      ),
      replaceDocumentBundle: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async (status: PaymentSyncStatus) => {
        statusHistory.push(status);
      }),
      setCacheState: jest.fn(),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async () => {
          throw failure;
        }),
        get: jest.fn(),
      },
    } as unknown as SalesBinderClient;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(new DocumentIndexerService(client, cache, 'test-account').sync()).rejects.toBe(
        failure
      );
      expect(statusHistory.at(-1)).toMatchObject({
        status: 'failed',
        error: 'Document refresh failed',
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateMarker);
      expect(JSON.stringify(statusHistory)).not.toContain(privateMarker);
    } finally {
      consoleError.mockRestore();
    }
  });
});

function axiosNotFound(): AxiosError {
  return new AxiosError('Not found', undefined, undefined, undefined, { status: 404 } as any);
}
