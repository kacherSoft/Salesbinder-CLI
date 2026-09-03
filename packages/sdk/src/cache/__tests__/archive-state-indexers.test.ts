import { CACHE_SCHEMA_VERSION, DocumentContextId } from '../types.js';
import { AccountIndexerService } from '../account-indexer.service.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { normalizeDocumentCacheRows } from '../document-row-normalizer.js';
import { ItemIndexerService } from '../item-indexer.service.js';
import { ContextId } from '../../types/common.types.js';
import type { Customer } from '../../types/customers.types.js';
import type { Document } from '../../types/documents.types.js';
import type { Item } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';

describe('cache archive-state indexers', () => {
  const cache = {} as never;
  const client = {} as never;

  it.each([
    [true, 1],
    [false, 0],
    [undefined, 0],
  ])('retains account archived=%s compatibility as %s', (archived, expected) => {
    const indexer = new AccountIndexerService(client, cache, 'test');
    const account: Customer = {
      id: 'customer-1',
      context_id: ContextId.Customer,
      customer_number: 1,
      name: 'Customer',
      created: '2026-01-01',
      modified: '2026-01-02',
      archived,
    };

    expect((indexer as any).toAccountRow(account, ContextId.Customer).archived).toBe(expected);
  });

  it.each([
    [true, 1],
    [false, 0],
    [undefined, null],
  ])('maps item archived=%s to %s', (archived, expected) => {
    const indexer = new ItemIndexerService(client, cache, 'test');
    const item: Item = {
      id: 'item-1',
      item_number: 1,
      name: 'Item',
      quantity: 1,
      threshold: 0,
      cost: 1,
      price: 2,
      created: '2026-01-01',
      modified: '2026-01-02',
      archived,
    };

    expect((indexer as any).toItemRow(item).archived).toBe(expected);
  });

  it.each([
    [true, 1],
    [false, 0],
    [undefined, null],
  ])('maps observed document archived=%s to %s', (archived, expected) => {
    const document: Document = {
      id: 'doc-1',
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
      modified: '2026-01-02',
      archived,
    };

    expect(normalizeDocumentCacheRows(document).docRow.archived).toBe(expected);
  });

  it('keeps shipping mappings while removing NUL bytes from cached document text', () => {
    const nul = String.fromCharCode(0);
    const document = {
      id: 'doc-shipping',
      context_id: DocumentContextId.Invoice,
      document_number: 2,
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
      archived: false,
      name: `Order${nul}name`,
      date_sent: '2026-01-03',
      shipped_percent: 40,
      customer: { name: `Customer${nul}One` },
      document_items: [
        {
          id: 'line-1',
          document_id: 'doc-shipping',
          item_id: 'item-1',
          name: `Item${nul}One`,
          description: `Line${nul}description`,
          quantity: 5,
          quantity_partially_received: 1,
          quantity_partially_shipped: 2,
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
    } as Document;

    const { docRow, itemRows } = normalizeDocumentCacheRows(document);

    expect(docRow).toMatchObject({
      document_name: 'Ordername',
      account_name: 'CustomerOne',
      date_sent: '2026-01-03',
      shipped_percent: 40,
      archived: 0,
    });
    expect(itemRows[0]).toMatchObject({
      item_name: 'ItemOne',
      line_description: 'Linedescription',
      quantity_shipped: 2,
    });
  });

  it('refreshes invoice payments without dropping shipping or archive fields', async () => {
    const invoice = {
      id: 'invoice-1',
      context_id: DocumentContextId.Invoice,
      document_number: 3,
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
      archived: true,
      date_sent: '2026-01-03',
      shipped_percent: 50,
      transactions: [],
      document_items: [
        {
          id: 'line-1',
          document_id: 'invoice-1',
          item_id: 'item-1',
          quantity: 5,
          quantity_partially_received: 1,
          quantity_partially_shipped: 3,
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
    } as Document;
    const replacedBundles: any[] = [];
    const cacheWithPayments = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => ({
        status: 'complete',
        startedAt: 1,
        updatedAt: 1,
        finishedAt: 1,
        lastSuccessfulSync: 1,
        cursor: 'old',
        processedDocuments: 1,
        totalDocuments: 1,
      })),
      getDocumentByApiId: jest.fn(async () => undefined),
      getDocumentByNumber: jest.fn(async () => undefined),
      replaceDocumentBundle: jest.fn(async (document, itemDocuments, paymentTransactions) => {
        replacedBundles.push({ document, itemDocuments, paymentTransactions });
      }),
      getDocumentCount: jest.fn(async () => 1),
      getItemDocumentCount: jest.fn(async () => 1),
      setCacheState: jest.fn(async () => undefined),
      setPaymentSyncStatus: jest.fn(async () => undefined),
    } as unknown as CacheService;
    const paymentClient = {
      documents: {
        list: jest.fn(async ({ contextId, page }) => ({
          documents: contextId === DocumentContextId.Invoice && page === 1 ? [[invoice]] : [],
        })),
        get: jest.fn(async () => invoice),
      },
    } as any;

    await new DocumentIndexerService(paymentClient, cacheWithPayments, 'test').sync({ full: true });

    expect(replacedBundles[0].document).toMatchObject({
      date_sent: '2026-01-03',
      shipped_percent: 50,
      archived: 1,
    });
    expect(replacedBundles[0].itemDocuments[0]).toMatchObject({ quantity_shipped: 3 });
    expect(replacedBundles[0].paymentTransactions).toEqual([]);
    expect(cacheWithPayments.setPaymentSyncStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'complete', mode: 'full', processedDocuments: 1 })
    );
  });

  it('leaves global watermarks for the CLI while using the shared schema version', async () => {
    const states: any[] = [];
    const stateCache = {
      getCacheState: jest.fn(async () => null),
      getCategorySnapshot: jest.fn(async () => null),
      setCacheState: jest.fn(async (state) => {
        states.push(state);
      }),
      getItemCount: jest.fn(async () => 0),
      getStockLocationCount: jest.fn(async () => 0),
    } as any;
    const emptyClient = {
      customers: { list: jest.fn(async () => ({ customers: [] })) },
      items: { list: jest.fn(async () => ({ items: [] })) },
    } as any;

    await new AccountIndexerService(emptyClient, stateCache, 'test').sync(true);
    await new ItemIndexerService(emptyClient, stateCache, 'test').sync(true);

    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state).toMatchObject({
        lastSync: 0,
        lastFullSync: 0,
        schemaVersion: CACHE_SCHEMA_VERSION,
      });
    }
  });

  it('advances direct document watermarks but lets the cache pipeline defer them', async () => {
    const states: any[] = [];
    const stateCache = {
      getCacheState: jest.fn(async () => null),
      getPaymentSyncStatus: jest.fn(async () => null),
      replaceDocumentBundle: jest.fn(async () => undefined),
      getDocumentCount: jest.fn(async () => 7),
      getItemDocumentCount: jest.fn(async () => 8),
      setCacheState: jest.fn(async (state) => {
        states.push(state);
      }),
    } as any;
    const emptyClient = {
      documents: { list: jest.fn(async () => ({ documents: [] })) },
    } as any;

    await new DocumentIndexerService(emptyClient, stateCache, 'test').sync({ full: true });
    await new DocumentIndexerService(emptyClient, stateCache, 'test', undefined, undefined, {
      deferGlobalWatermark: true,
    }).sync({ full: true });

    expect(states[0]).toMatchObject({
      lastSync: expect.any(Number),
      lastFullSync: expect.any(Number),
      documentCount: 7,
      itemDocumentCount: 8,
    });
    expect(states[0].lastSync).toBeGreaterThan(0);
    expect(states[0].lastFullSync).toBeGreaterThan(0);
    expect(states[1]).toMatchObject({
      lastSync: 0,
      lastFullSync: 0,
      documentCount: 7,
      itemDocumentCount: 8,
    });
  });
});
