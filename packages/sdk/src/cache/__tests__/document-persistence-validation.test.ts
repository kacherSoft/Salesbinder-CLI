import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { CacheService } from '../cache.interface.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { normalizeDocumentCacheRows } from '../document-row-normalizer.js';
import { DocumentRecordError, validateDocumentContent } from '../document-source-validation.js';
import { DocumentContextId, type DocumentRow } from '../types.js';

describe('document persistence validation', () => {
  it.each([
    ['fractional document number', { document_number: 1.5 }],
    ['oversized document number', { document_number: 2_147_483_648 }],
    ['fractional status ID', { status_id: 1.5, status: { id: 1.5, name: 'Draft' } }],
    ['oversized status ID', { status_id: 2_147_483_648 }],
    ['fractional customer number', { customer: { customer_number: 1.5 } }],
    ['oversized customer number', { customer: { customer_number: 2_147_483_648 } }],
    ['hex document number', { document_number: '0x10' as unknown as number }],
    ['exponent status ID', { status_id: '1e0' as unknown as number }],
    [
      'hex nested status ID',
      { status_id: 16, status: { id: '0x10' as unknown as number, name: 'Draft' } },
    ],
    ['whitespace customer number', { customer: { customer_number: ' 1 ' as unknown as number } }],
  ])('rejects a %s before persistence', (_label, overrides) => {
    expect(() => validateDocumentContent(document('doc-1', overrides))).toThrow(
      DocumentRecordError
    );
  });

  it('accepts the PostgreSQL INTEGER boundaries and integer-like strings', () => {
    expect(() =>
      validateDocumentContent(
        document('doc-1', {
          document_number: '2147483647' as unknown as number,
          status_id: '0' as unknown as number,
          status: { id: '0' as unknown as number, name: 'Draft' },
          customer: { customer_number: '2147483647' as unknown as number },
        })
      )
    ).not.toThrow();
  });

  it.each(['', '\0', '03/04/2026', '2025-02-30', '2026-01-02T03:04:05'])(
    'rejects invalid date_sent %s',
    (dateSent) => {
      expect(() => validateDocumentContent(document('doc-1', { date_sent: dateSent }))).toThrow(
        DocumentRecordError
      );
    }
  );

  it.each([
    ['2026-07-18', '2026-07-18'],
    ['2026-07-18T23:42:19.123456-04:30', '2026-07-18'],
  ])('normalizes valid date_sent %s to a calendar date', (dateSent, expected) => {
    expect(
      normalizeDocumentCacheRows(document('doc-1', { date_sent: dateSent })).docRow.date_sent
    ).toBe(expected);
  });

  it('rejects a non-finite computed line total', () => {
    const source = document('doc-1');
    source.document_items![0] = {
      ...source.document_items![0],
      quantity: Number.MAX_VALUE,
      price: 2,
    };

    expect(() => normalizeDocumentCacheRows(source)).toThrow(DocumentRecordError);
  });

  it.each([
    ['hex total', { total_price: '0x10' as unknown as number }],
    ['exponent total', { total_cost: '1e2' as unknown as number }],
    ['whitespace paid total', { total_transactions: ' 1 ' as unknown as number }],
    ['hex shipped percent', { shipped_percent: '0x10' as unknown as number }],
  ])('rejects a non-contract %s', (_label, overrides) => {
    expect(() => normalizeDocumentCacheRows(document('doc-1', overrides))).toThrow(
      DocumentRecordError
    );
  });

  it.each([
    ['quantity', '0x10'],
    ['price', '1e2'],
    ['quantity_partially_received', ' 1 '],
    ['cost', '0b10'],
    ['discounted_price', '0o10'],
    ['discount_percent', '+1'],
  ] as const)('rejects a non-contract line %s', (field, value) => {
    const source = document('doc-1');
    source.document_items![0] = {
      ...source.document_items![0],
      [field]: value,
    } as unknown as NonNullable<Document['document_items']>[number];

    expect(() => normalizeDocumentCacheRows(source)).toThrow(DocumentRecordError);
  });

  it('normalizes ordinary decimal strings without reinterpretation', () => {
    const source = document('doc-1', {
      total_cost: '-1.25' as unknown as number,
      total_price: '12.50' as unknown as number,
      total_transactions: '0' as unknown as number,
      shipped_percent: '0.5' as unknown as number,
    });
    source.document_items![0] = {
      ...source.document_items![0],
      quantity: '2' as unknown as number,
      price: '3.50' as unknown as number,
      cost: '-0.50' as unknown as number,
    };

    const normalized = normalizeDocumentCacheRows(source);

    expect(normalized.docRow).toMatchObject({
      total_cost: -1.25,
      total_price: 12.5,
      shipped_percent: 0.5,
    });
    expect(normalized.itemRows[0]).toMatchObject({
      quantity: 2,
      price: 3.5,
      cost: -0.5,
      total_amount: 7,
    });
  });

  it('rejects a number-keyed bundle owned by another API document before payment validation', async () => {
    const incoming = document('doc-1', {
      context_id: DocumentContextId.Invoice,
      document_number: 7,
      total_transactions: 16,
      transactions: [
        {
          id: 'txn-1',
          document_id: 'doc-1',
          amount: '0x10',
          transaction_date: '2026-01-02',
        },
      ],
    });
    const cache = fakeCache(undefined, { status: 'complete' });
    jest.mocked(cache.getDocumentByNumber).mockImplementation(async (contextId, documentNumber) =>
      contextId === DocumentContextId.Invoice && documentNumber === 7
        ? ({
            doc_id: 'cached-other-invoice',
            api_doc_id: 'other-api-document',
            context_id: contextId,
            doc_number: documentNumber,
          } as DocumentRow)
        : undefined
    );
    const client = clientFor([incoming], new Map([[incoming.id, incoming]]));

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow(/cache document identity conflict/i);

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.getDocumentByApiId).toHaveBeenCalledWith(incoming.id);
    expect(cache.getDocumentByNumber).toHaveBeenCalledWith(DocumentContextId.Invoice, 7);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('adopts a legacy number-keyed bundle without an API document ID', async () => {
    const incoming = document('doc-1', { document_number: 7 });
    const cache = fakeCache();
    jest.mocked(cache.getDocumentByNumber).mockImplementation(async (contextId, documentNumber) =>
      contextId === DocumentContextId.Estimate && documentNumber === 7
        ? ({
            doc_id: 'legacy-estimate-7',
            api_doc_id: null,
            context_id: contextId,
            doc_number: documentNumber,
          } as DocumentRow)
        : undefined
    );
    const client = clientFor([incoming], new Map());

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(cache.replaceDocumentBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        doc_id: 'legacy-estimate-7',
        api_doc_id: incoming.id,
        doc_number: 7,
      }),
      expect.arrayContaining([expect.objectContaining({ doc_id: 'legacy-estimate-7' })]),
      undefined
    );
    expect(result.recordIssues).toEqual([]);
  });

  it('recovers a valid detail for a list row with an invalid document number', async () => {
    const listed = document('doc-1', { document_number: 1.5 });
    const recovered = document('doc-1', { document_number: 7 });
    const cache = fakeCache();
    const client = clientFor([listed], new Map([[listed.id, recovered]]));

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).toHaveBeenCalledWith(
      expect.objectContaining({ api_doc_id: listed.id, doc_number: 7 }),
      expect.any(Array),
      undefined
    );
    expect(result.recordIssues).toEqual([]);
  });

  it('uses a recovered document number to preserve a legacy bundle after later validation fails', async () => {
    const listed = document('doc-1', { document_number: 1.5 });
    const recovered = document('doc-1', {
      document_number: 7,
      total_price: '0x10' as unknown as number,
    });
    const cache = fakeCache();
    jest.mocked(cache.getDocumentByNumber).mockImplementation(async (contextId, documentNumber) =>
      contextId === DocumentContextId.Estimate && documentNumber === 7
        ? ({
            doc_id: 'legacy-estimate-7',
            api_doc_id: null,
            context_id: contextId,
            doc_number: documentNumber,
          } as DocumentRow)
        : undefined
    );
    const client = clientFor([listed], new Map([[listed.id, recovered]]));

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(cache.getDocumentByApiId).toHaveBeenCalledWith(listed.id);
    expect(cache.getDocumentByNumber).toHaveBeenCalledWith(DocumentContextId.Estimate, 7);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: listed.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
  });

  it('rejects a stale API identity found by number during LKG classification', async () => {
    const listed = document('doc-1', { document_number: 1.5 });
    const recovered = document('doc-1', {
      document_number: 7,
      total_price: '0x10' as unknown as number,
    });
    const cache = fakeCache();
    jest.mocked(cache.getDocumentByNumber).mockImplementation(async (contextId, documentNumber) =>
      contextId === DocumentContextId.Estimate && documentNumber === 7
        ? ({
            doc_id: 'cached-other-estimate',
            api_doc_id: 'other-api-document',
            context_id: contextId,
            doc_number: documentNumber,
          } as DocumentRow)
        : undefined
    );
    const client = clientFor([listed], new Map([[listed.id, recovered]]));

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow(/cache document identity conflict/i);

    expect(cache.getDocumentByApiId).toHaveBeenCalledWith(listed.id);
    expect(cache.getDocumentByNumber).toHaveBeenCalledWith(DocumentContextId.Estimate, 7);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('preserves or omits unresolved bad document numbers without a number lookup', async () => {
    const preserved = document('doc-1', { document_number: 1.5 });
    const omitted = document('doc-2', { document_number: 2_147_483_648 });
    const cache = fakeCache(preserved.id);
    const client = clientFor(
      [preserved, omitted],
      new Map([
        [preserved.id, preserved],
        [omitted.id, omitted],
      ])
    );

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(2);
    expect(cache.getDocumentByNumber).not.toHaveBeenCalled();
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: preserved.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
      expect.objectContaining({
        id: omitted.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
  });

  it('keeps a malformed recovery-detail document number record-local when the root number was valid', async () => {
    const listed = document('doc-1', { total_price: '0x10' as unknown as number });
    const recovered = document('doc-1', { document_number: 2_147_483_648 });
    const cache = fakeCache(listed.id);
    const client = clientFor([listed], new Map([[listed.id, recovered]]));

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: listed.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
  });

  it('preserves or omits unresolved non-contract document decimals', async () => {
    const preserved = document('doc-1', {
      total_price: '0x10' as unknown as number,
    });
    const omitted = document('doc-2');
    omitted.document_items![0] = {
      ...omitted.document_items![0],
      quantity: '1e2' as unknown as number,
    };
    const cache = fakeCache(preserved.id);
    const client = clientFor(
      [preserved, omitted],
      new Map([
        [preserved.id, preserved],
        [omitted.id, omitted],
      ])
    );

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(2);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: preserved.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
      expect.objectContaining({
        id: omitted.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
  });

  it.each([null, ' '])(
    'treats invalid root document number %p as a record-local warning',
    async (documentNumber) => {
      const malformed = document('doc-1', {
        document_number: documentNumber as unknown as number,
      });
      const cache = fakeCache();
      const client = clientFor([malformed], new Map([[malformed.id, malformed]]));

      const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

      expect(client.documents.get).toHaveBeenCalledTimes(1);
      expect(cache.getDocumentByNumber).not.toHaveBeenCalled();
      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: malformed.id,
          code: 'invalid_record',
          attempts: 2,
          outcome: 'omitted_new',
        }),
      ]);
    }
  );

  it('keeps a recovered business-key collision fatal before writing that detail', async () => {
    const invalidRoot = document('doc-1', { document_number: 1.5 });
    const validRoot = document('doc-2', { document_number: 7 });
    const recoveredCollision = document('doc-1', { document_number: 7 });
    const cache = fakeCache();
    const client = clientFor(
      [invalidRoot, validRoot],
      new Map([[invalidRoot.id, recoveredCollision]])
    );

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow(/business key/i);

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).toHaveBeenCalledWith(
      expect.objectContaining({ api_doc_id: validRoot.id }),
      expect.any(Array),
      undefined
    );
  });

  it.each([
    ['payment date', 1, '2026-01-02Tgarbage', 1],
    ['payment amount', '0x10', '2026-01-02', 16],
  ])(
    'retries a malformed %s and preserves the prior invoice bundle',
    async (_field, amount, transactionDate, declaredTotal) => {
      const malformed = document('doc-1', {
        context_id: DocumentContextId.Invoice,
        total_transactions: declaredTotal,
        transactions: [
          {
            id: 'txn-1',
            document_id: 'doc-1',
            amount,
            transaction_date: transactionDate,
          },
        ],
      });
      const priorPaymentStatus = {
        status: 'complete',
        mode: 'full',
        startedAt: 10,
        updatedAt: 20,
        finishedAt: 20,
        lastSuccessfulSync: 20,
        cursor: 'doc-1',
        processedDocuments: 1,
        totalDocuments: 1,
      } as const;
      const cache = fakeCache(malformed.id, priorPaymentStatus);
      const client = clientFor([malformed], new Map([[malformed.id, malformed]]));

      const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

      expect(client.documents.get).toHaveBeenCalledTimes(2);
      expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: malformed.id,
          code: 'invalid_record',
          attempts: 2,
          outcome: 'preserved_last_known_good',
        }),
      ]);
      expect(cache.setPaymentSyncStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'failed',
          lastSuccessfulSync: 20,
        })
      );
    }
  );
});

function document(id: string, overrides: Partial<Document> = {}): Document {
  return {
    id,
    context_id: DocumentContextId.Estimate,
    document_number: Number(id.slice(-1)),
    customer_id: 'customer-1',
    user_id: 'user-1',
    issue_date: '2026-01-01',
    status_id: 1,
    total_cost: 1,
    total_tax: 0,
    total_tax2: 0,
    total_price: 2,
    total_transactions: 0,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-02T00:00:00Z',
    document_items: [
      {
        id: `line-${id}`,
        document_id: id,
        item_id: 'item-1',
        quantity: 1,
        quantity_partially_received: 0,
        tax: 0,
        tax2: 0,
        discount_percent: 0,
        cost: 1,
        price: 2,
        discounted_price: 2,
        weight: 0,
        created: '2026-01-01T00:00:00Z',
        modified: '2026-01-02T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

function clientFor(listed: Document[], details: Map<string, Document>): SalesBinderClient {
  return {
    documents: {
      list: jest.fn(async ({ contextId, page }) => {
        const documents = listed.filter((entry) => entry.context_id === contextId);
        return { documents: page === 1 && documents.length > 0 ? [documents] : [] };
      }),
      get: jest.fn(async (id: string) => details.get(id)!),
    },
  } as unknown as SalesBinderClient;
}

function fakeCache(existingId?: string, paymentStatus: object | null = null): CacheService {
  return {
    getCacheState: jest.fn(async () => null),
    getPaymentSyncStatus: jest.fn(async () => paymentStatus),
    getDocumentByApiId: jest.fn(async (id: string) =>
      id === existingId
        ? {
            doc_id: `cached-${id}`,
            api_doc_id: id,
            context_id: DocumentContextId.Estimate,
            doc_number: 1,
          }
        : undefined
    ),
    getDocumentByNumber: jest.fn(async () => undefined),
    replaceDocumentBundle: jest.fn(),
    getDocumentCount: jest.fn(async () => (existingId ? 1 : 0)),
    getItemDocumentCount: jest.fn(async () => (existingId ? 1 : 0)),
    setCacheState: jest.fn(),
    setPaymentSyncStatus: jest.fn(),
  } as unknown as CacheService;
}
