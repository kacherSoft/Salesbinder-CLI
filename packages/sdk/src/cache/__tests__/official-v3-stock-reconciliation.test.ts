import {
  createOfficialV3DocumentStockSignature,
  createOfficialV3DocumentStockSignatureFromPayload,
  stockReconciliationItemIds,
} from '../official-v3-stock-reconciliation.js';

const itemA = '05c86ce5-c234-438b-9908-f518e42d42e4';
const itemB = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';

function doc(contextId: 4 | 5 | 11, statusName = 'Sent') {
  return { context_id: contextId, is_cancelled: 0, status_name: statusName };
}

function line(itemId = itemA, quantity = 1, target = 'vl-1') {
  return {
    item_id: itemId,
    quantity,
    quantity_received: null,
    quantity_shipped: null,
    item_location: 'Main',
    item_variation_location_id: target,
  };
}

describe('official V3 stock reconciliation signatures', () => {
  it('ignores quote changes', () => {
    const before = createOfficialV3DocumentStockSignature(doc(4), [line(itemA, 1)]);
    const after = createOfficialV3DocumentStockSignature(doc(4), [line(itemA, 2)]);
    expect(stockReconciliationItemIds(before, after)).toEqual([]);
  });

  it('queues only the invoice item whose billed quantity changed', () => {
    const before = createOfficialV3DocumentStockSignature(doc(5), [line(itemA, 1), line(itemB, 1)]);
    const after = createOfficialV3DocumentStockSignature(doc(5), [line(itemA, 3), line(itemB, 1)]);
    expect(stockReconciliationItemIds(before, after)).toEqual([itemA]);
  });

  it('treats Not Sent purchase orders as zero stock effect', () => {
    const before = createOfficialV3DocumentStockSignature(doc(11, 'Not Sent'), [line(itemA, 1)]);
    const after = createOfficialV3DocumentStockSignature(doc(11, 'Not Sent'), [line(itemA, 10)]);
    expect(before.stockState).toBe('none');
    expect(after.stockState).toBe('none');
    expect(stockReconciliationItemIds(before, after)).toEqual([]);
  });

  it('queues sent purchase order target changes using raw document location fallback', () => {
    const before = createOfficialV3DocumentStockSignatureFromPayload(poPayload('Sent', 'location-a'), 11)!;
    const after = createOfficialV3DocumentStockSignatureFromPayload(poPayload('Sent', 'location-b'), 11)!;
    expect(stockReconciliationItemIds(before, after)).toEqual([itemA]);
  });

  it('activates a purchase order when date_sent is the only send evidence', () => {
    const before = createOfficialV3DocumentStockSignatureFromPayload(poPayload('Not Sent', 'location-a'), 11)!;
    const after = createOfficialV3DocumentStockSignatureFromPayload({
      ...poPayload('Not Sent', 'location-a'),
      date_sent: '2026-09-18T12:00:00Z',
    }, 11)!;
    expect(stockReconciliationItemIds(before, after)).toEqual([itemA]);
  });

  it('rejects a malformed raw stock target instead of collapsing it to an unknown target', () => {
    expect(() => createOfficialV3DocumentStockSignatureFromPayload({
      ...poPayload('Sent', 'location-a'),
      lines: [{ item_id: itemA, location_id: { unexpected: true } }],
    }, 11)).toThrow('exact identifier');
  });

  it('queues all active items on invoice cancellation', () => {
    const before = createOfficialV3DocumentStockSignature(doc(5), [line(itemA, 1), line(itemB, 1)]);
    const after = createOfficialV3DocumentStockSignature({ ...doc(5), is_cancelled: 1 }, [line(itemA, 1), line(itemB, 1)]);
    expect(stockReconciliationItemIds(before, after)).toEqual([itemA, itemB]);
  });

  it('treats invoice status_id 15 as cancelled when the status name is absent', () => {
    const before = createOfficialV3DocumentStockSignatureFromPayload({
      object: 'invoice', status: 'Sent', status_id: 9, lines: [{ item_id: itemA, quantity: 1 }],
    }, 5)!;
    const after = createOfficialV3DocumentStockSignatureFromPayload({
      object: 'invoice', status: null, status_id: 15, lines: [{ item_id: itemA, quantity: 1 }],
    }, 5)!;
    expect(after.cancelled).toBe(true);
    expect(stockReconciliationItemIds(before, after)).toEqual([itemA]);
  });
});

function poPayload(status: string, locationId: string) {
  return {
    object: 'purchase_order',
    status,
    location_id: locationId,
    lines: [
      {
        object: 'purchase_order_line',
        item_id: itemA,
        quantity: '1',
        quantity_received: '0',
      },
    ],
  };
}
