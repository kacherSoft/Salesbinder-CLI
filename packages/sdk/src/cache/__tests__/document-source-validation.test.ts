import type { SalesBinderClient } from '../../resources/index.js';
import type { Document } from '../../types/documents.types.js';
import type { CacheService } from '../cache.interface.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { sortRecordIssues } from '../document-recovery.helpers.js';
import { DocumentRecordError, validateDocumentContent } from '../document-source-validation.js';
import type { SyncRecordIssue } from '../sync-record-issue.types.js';
import { DocumentContextId } from '../types.js';

const document = (id: string): Document => ({
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
  created: '2026-01-01',
  modified: '2026-01-02',
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
      created: '2026-01-01',
      modified: '2026-01-02',
    },
  ],
});

const duplicateLineIds = (id: string): Document => {
  const source = document(id);
  return {
    ...source,
    document_items: [source.document_items![0], { ...source.document_items![0] }],
  };
};

describe('document source validation', () => {
  it('rejects duplicate document-item IDs as a nominal invalid record', () => {
    expect(() => validateDocumentContent(duplicateLineIds('doc-1'))).toThrow(DocumentRecordError);
    try {
      validateDocumentContent(duplicateLineIds('doc-1'));
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_record',
        safeMessage: 'Document failed source validation',
      });
    }
  });

  it.each([
    ['customer', { customer: { id: 'customer-2', name: 'Wrong customer' } }],
    ['user', { user: { id: 'user-2', name: 'Wrong user' } }],
    ['status', { status: { id: 2, name: 'Wrong status' } }],
    ['context', { context: { id: DocumentContextId.Invoice, name: 'Wrong document context' } }],
  ])('rejects a nested %s identity that does not match its root identity', (_label, nested) => {
    expect(() => validateDocumentContent({ ...document('doc-1'), ...nested })).toThrow(
      DocumentRecordError
    );
    try {
      validateDocumentContent({ ...document('doc-1'), ...nested });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_record',
        safeMessage: 'Document failed source validation',
      });
    }
  });

  it('accepts nested labels when their optional IDs are absent', () => {
    expect(() =>
      validateDocumentContent({
        ...document('doc-1'),
        customer: { name: 'Customer One', customer_number: 1 },
        user: { name: 'User One' },
        status: { name: 'Draft' } as Document['status'],
        context: { name: 'Estimate' } as Document['context'],
      })
    ).not.toThrow();
  });

  it('accepts nested identities that match their normalized root identities', () => {
    expect(() =>
      validateDocumentContent({
        ...document('doc-1'),
        customer: { id: 'customer-1', name: 'Customer One' },
        user: { id: 'user-1', name: 'User One' },
        status: { id: 1, name: 'Draft' },
        context: { id: DocumentContextId.Estimate, name: 'Estimate' },
      })
    ).not.toThrow();
  });

  it.each([
    ['customer ID with a lone high surrogate', { customer_id: 'customer-\ud800' }],
    ['user ID with a lone low surrogate', { user_id: 'user-\udc00' }],
    ['document name with a lone high surrogate', { name: 'Quote \ud800' }],
  ])('rejects a %s as a nominal invalid record', (_label, overrides) => {
    expect(() => validateDocumentContent({ ...document('doc-1'), ...overrides })).toThrow(
      DocumentRecordError
    );
  });

  it('accepts valid non-BMP source IDs and text', () => {
    const source = document('doc-😀');
    source.document_number = 1;
    source.customer_id = 'customer-😀';
    source.user_id = 'user-😀';
    source.name = 'Quote 😀';

    expect(() => validateDocumentContent(source)).not.toThrow();
  });

  it('retries malformed duplicate-line documents once and preserves or omits them by cache state', async () => {
    const listed = [duplicateLineIds('ä-1'), duplicateLineIds('z-2'), duplicateLineIds('Å-3')];
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async (id: string) =>
        id === 'ä-1'
          ? {
              doc_id: 'cached-ä-1',
              api_doc_id: id,
              context_id: DocumentContextId.Estimate,
              doc_number: 1,
            }
          : undefined
      ),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const get = jest.fn(async (id: string) => duplicateLineIds(id));
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [listed] : [],
        })),
        get,
      },
    } as unknown as SalesBinderClient;
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Document recovery ordering must not depend on locale collation');
    });
    let recordIssues: SyncRecordIssue[] = [];

    try {
      recordIssues =
        (await new DocumentIndexerService(client, cache, 'test').sync({ full: true }))
          .recordIssues ?? [];
    } finally {
      localeCompare.mockRestore();
    }

    expect(get.mock.calls.map(([id]) => id)).toEqual(['z-2', 'Å-3', 'ä-1']);
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(recordIssues).toEqual([
      {
        resource: 'document',
        id: 'z-2',
        context_id: DocumentContextId.Estimate,
        code: 'invalid_record',
        message: 'Document failed source validation',
        attempts: 2,
        outcome: 'omitted_new',
      },
      {
        resource: 'document',
        id: 'Å-3',
        context_id: DocumentContextId.Estimate,
        code: 'invalid_record',
        message: 'Document failed source validation',
        attempts: 2,
        outcome: 'omitted_new',
      },
      {
        resource: 'document',
        id: 'ä-1',
        context_id: DocumentContextId.Estimate,
        code: 'invalid_record',
        message: 'Document failed source validation',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ]);
  });

  it('keeps a detail document-number mismatch fatal before cache identity lookup or mutation', async () => {
    const rootA = {
      ...document('doc-a'),
      document_number: 1,
      document_items: undefined,
    };
    const rootB = { ...document('doc-b'), document_number: 2 };
    const detailA = { ...document('doc-a'), document_number: 2 };
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 2),
      getItemDocumentCount: jest.fn(async () => 2),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [[rootA, rootB]] : [],
        })),
        get: jest.fn(async () => detailA),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow('Document detail business key mismatch');

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.getDocumentByApiId).not.toHaveBeenCalled();
    expect(cache.getDocumentByNumber).not.toHaveBeenCalled();
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('keeps a recovered detail document-number mismatch fatal before cache mutation', async () => {
    const root = {
      ...duplicateLineIds('doc-a'),
      document_number: 1,
    };
    const detail = { ...document('doc-a'), document_number: 2 };
    const cache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 0),
      getItemDocumentCount: jest.fn(async () => 0),
      setCacheState: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const client = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Estimate && page === 1 ? [[root]] : [],
        })),
        get: jest.fn(async () => detail),
      },
    } as unknown as SalesBinderClient;

    await expect(
      new DocumentIndexerService(client, cache, 'test').sync({ full: true })
    ).rejects.toThrow('Document detail business key mismatch');

    expect(client.documents.get).toHaveBeenCalledTimes(1);
    expect(cache.getDocumentByApiId).not.toHaveBeenCalled();
    expect(cache.getDocumentByNumber).not.toHaveBeenCalled();
    expect(cache.replaceDocumentBundle).not.toHaveBeenCalled();
    expect(cache.setCacheState).not.toHaveBeenCalled();
  });

  it('sorts record issues by UTF-16 code units without locale collation', () => {
    const issue = (id: string): SyncRecordIssue => ({
      resource: 'document',
      id,
      context_id: DocumentContextId.Estimate,
      code: 'invalid_record',
      message: 'Document failed source validation',
      attempts: 2,
      outcome: 'omitted_new',
    });
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Record issue ordering must not depend on locale collation');
    });
    let sorted: SyncRecordIssue[] = [];

    try {
      sorted = sortRecordIssues([issue('ä'), issue('z'), issue('Å')]);
    } finally {
      localeCompare.mockRestore();
    }

    expect(sorted.map(({ id }) => id)).toEqual(['z', 'Å', 'ä']);
  });
});
