import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { CacheService } from '../cache.interface.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { DocumentRecordError, validateDocumentContent } from '../document-source-validation.js';
import { DocumentContextId } from '../types.js';

const document = (id: string, overrides: Partial<Document> = {}): Document => ({
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
  created: '2026-01-01T00:00:00+00:00',
  modified: '2026-01-02T00:00:00+00:00',
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
      created: '2026-01-01T00:00:00+00:00',
      modified: '2026-01-02T00:00:00+00:00',
    },
  ],
  ...overrides,
});

function cacheFor(state: object | null, existingId?: string): CacheService {
  return {
    getCacheState: jest.fn(async () => state),
    getPaymentSyncStatus: jest.fn(async () => null),
    getDocumentByApiId: jest.fn(async (id: string) =>
      id === existingId
        ? {
            doc_id: `cached-${id}`,
            api_doc_id: id,
            context_id: DocumentContextId.Estimate,
            doc_number: Number(id.slice(-1)),
          }
        : undefined
    ),
    getDocumentByNumber: jest.fn(async () => undefined),
    replaceDocumentBundle: jest.fn(async () => undefined),
    getDocumentCount: jest.fn(async () => (existingId ? 1 : 0)),
    getItemDocumentCount: jest.fn(async () => (existingId ? 1 : 0)),
    setCacheState: jest.fn(async () => undefined),
  } as unknown as CacheService;
}

function clientFor(listed: Document[], recovered: Map<string, Document>): SalesBinderClient {
  return {
    documents: {
      list: jest.fn(async ({ contextId, page }) => ({
        documents: contextId === DocumentContextId.Estimate && page === 1 ? [listed] : [],
      })),
      get: jest.fn(async (id: string) => recovered.get(id)!),
    },
  } as unknown as SalesBinderClient;
}

describe('document date source validation', () => {
  it.each(['03/04/2026', '2025-02-30', '0000-01-01', '1'])(
    'rejects malformed issue_date %s as a record-local failure',
    (issueDate) => {
      expect(() => validateDocumentContent(document('doc-1', { issue_date: issueDate }))).toThrow(
        DocumentRecordError
      );
    }
  );

  it.each([
    '03/04/2026',
    '0000-01-01T01:02:03+00:00',
    '2025-02-30T01:02:03+00:00',
    '2026-01-02T01:02:03',
    '1',
  ])('rejects malformed modified timestamp %s as a record-local failure', (modified) => {
    expect(() => validateDocumentContent(document('doc-1', { modified }))).toThrow(
      DocumentRecordError
    );
  });

  it.each(['0000-01-01', '0000-01-01T01:02:03Z'])(
    'rejects PostgreSQL-incompatible date_sent %s as a record-local failure',
    (dateSent) => {
      expect(() => validateDocumentContent(document('doc-1', { date_sent: dateSent }))).toThrow(
        DocumentRecordError
      );
    }
  );

  it.each([
    ['2024-02-29', '2026-01-02'],
    ['2016-11-04T00:00:00+00:00', '2016-11-05T01:39:21+00:00'],
  ])('accepts documented date and timestamp forms', (issueDate, modified) => {
    expect(() =>
      validateDocumentContent(document('doc-1', { issue_date: issueDate, modified }))
    ).not.toThrow();
  });

  it('retries malformed issue dates once, preserving an existing row and omitting a new row', async () => {
    const existing = document('doc-1', { issue_date: '2025-02-30' });
    const newDocument = document('doc-2', { issue_date: '03/04/2026' });
    const cache = cacheFor(null, existing.id);
    const client = clientFor(
      [existing, newDocument],
      new Map([
        [existing.id, existing],
        [newDocument.id, newDocument],
      ])
    );

    const result = await new DocumentIndexerService(client, cache, 'test').sync({ full: true });

    expect(client.documents.get).toHaveBeenCalledTimes(2);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: existing.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
      expect.objectContaining({
        id: newDocument.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
  });

  it('keeps a malformed modified timestamp out of delta writes and preserves the watermark', async () => {
    const priorState = {
      lastSync: 100,
      lastFullSync: 90,
      lastDocumentSync: 95,
      documentCount: 1,
      itemDocumentCount: 1,
      accountName: 'test',
      schemaVersion: 7,
    };
    const malformed = document('doc-1', { modified: '03/04/2026' });
    const cache = cacheFor(priorState, malformed.id);
    const client = clientFor([malformed], new Map([[malformed.id, malformed]]));

    const result = await new DocumentIndexerService(client, cache, 'test', undefined, 10).sync();

    expect(client.documents.list).toHaveBeenCalledWith(
      expect.objectContaining({ modifiedSince: 85 })
    );
    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSync: priorState.lastSync,
        lastDocumentSync: priorState.lastDocumentSync,
        lastSyncAttempt: expect.any(Number),
      })
    );
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: malformed.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
  });
});
