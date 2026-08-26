import { DocumentContextId } from '../types.js';
import { AccountIndexerService } from '../account-indexer.service.js';
import { DocumentIndexerService } from '../document-indexer.service.js';
import { ItemIndexerService } from '../item-indexer.service.js';
import { ContextId } from '../../types/common.types.js';
import type { Customer } from '../../types/customers.types.js';
import type { Document } from '../../types/documents.types.js';
import type { Item } from '../../types/items.types.js';

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
      id: 'customer-1', context_id: ContextId.Customer, customer_number: 1, name: 'Customer',
      created: '2026-01-01', modified: '2026-01-02', archived,
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
      id: 'item-1', item_number: 1, name: 'Item', quantity: 1, threshold: 0,
      cost: 1, price: 2, created: '2026-01-01', modified: '2026-01-02', archived,
    };

    expect((indexer as any).toItemRow(item).archived).toBe(expected);
  });

  it.each([
    [true, 1],
    [false, 0],
    [undefined, null],
  ])('maps observed document archived=%s to %s', (archived, expected) => {
    const indexer = new DocumentIndexerService(client, cache, 'test');
    const document: Document = {
      id: 'doc-1', context_id: DocumentContextId.Invoice, document_number: 1,
      customer_id: 'customer-1', user_id: 'user-1', issue_date: '2026-01-01', status_id: 1,
      total_cost: 1, total_tax: 0, total_tax2: 0, total_price: 2, total_transactions: 0,
      created: '2026-01-01', modified: '2026-01-02', archived,
    };

    expect((indexer as any).processDocument(document).docRow.archived).toBe(expected);
  });
});
