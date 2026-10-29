import {
  createOcShippingPatch,
  createUnknownOCShippingPatch,
} from '../oc-shipping-matcher.js';
import type {
  OCShippingCanonicalEstimate,
  OCShippingCanonicalSourceDocument,
} from '../oc-shipping.types.js';

const estimateId = '10000000-0000-4000-8000-000000000001';
const invoiceId = '10000000-0000-4000-8000-000000000002';
const orderId = '10000000-0000-4000-8000-000000000003';
const customerId = '10000000-0000-4000-8000-000000000004';
const itemId = '10000000-0000-4000-8000-000000000005';

describe('createOcShippingPatch', () => {
  it('clears an observed, unconverted OC without inventing shipping zeroes', () => {
    const result = createOcShippingPatch(estimate({ convertedDocument: { observed: true, value: null } }));

    expect(result).toMatchObject({
      associatedDocumentId: null,
      sourceKind: 'none',
      shippedPercent: null,
      lines: [{ quantityShipped: null }],
    });
    expect(result).not.toHaveProperty('authorityId');
  });

  it('maps a direct authoritative invoice by complete scope and its matched quantities', () => {
    const result = createOcShippingPatch(estimate(), invoice({ shippedPercent: 0 }));

    expect(result).toMatchObject({
      associatedDocumentId: invoiceId,
      sourceKind: 'invoice',
      authorityId: invoiceId,
      shippedPercent: 50,
      lines: [{ documentItemId: lineId(1), quantityShipped: 1 }],
    });
  });

  it.each(['invoice', 'sales_order'] as const)('accepts a related %s with a different customer', (kind) => {
    const source = (kind === 'invoice' ? invoice : salesOrder)({ customerId: lineId(9), shippedPercent: 160 });
    const oc = estimate({ convertedDocument: {
      observed: true, value: { id: source.id, kind, number: source.number },
    } });
    expect(createOcShippingPatch(oc, source)).toMatchObject({
      customerId, associatedDocumentId: source.id, shippedPercent: 50,
      lines: [{ quantityShipped: 1 }],
    });
    expect(oc.customerId).toBe(customerId);
    expect(source.customerId).toBe(lineId(9));
  });

  it('keeps shipment unknown for omitted fields, duplicate scope, or a changed source quantity', () => {
    const source = invoice({
      lines: [
        line(2, { quantityShipped: 1 }),
        line(3, { quantity: 3, quantityShipped: 3 }),
      ],
    });
    const duplicateEstimate = estimate({
      lines: [line(1), line(4)],
    });
    const missingScopeLine = line(5);
    delete (missingScopeLine as { unitId?: unknown }).unitId;
    const missingScopeEstimate = estimate({ lines: [missingScopeLine] });

    expect(createOcShippingPatch(estimate(), source)).toMatchObject({ shippedPercent: null });
    expect(createOcShippingPatch(estimate(), source).lines[0]?.quantityShipped).toBeNull();
    expect(createOcShippingPatch(duplicateEstimate, invoice()).lines.map((line) => line.quantityShipped)).toEqual([
      null,
      null,
    ]);
    expect(createOcShippingPatch(missingScopeEstimate, invoice())).toMatchObject({ shippedPercent: null });
    expect(createOcShippingPatch(missingScopeEstimate, invoice()).lines[0]?.quantityShipped).toBeNull();
  });

  it('uses a linked sales order as invoice fulfillment authority, never a partial invoice', () => {
    const partialInvoice = invoice({
      customerId: lineId(8),
      fulfillmentAuthority: 'sales_order',
      fulfillmentSalesOrderId: orderId,
      shippedPercent: 25,
      lines: [line(2, { quantityShipped: 0.5 })],
    });
    const authority = salesOrder({ customerId: lineId(9), lines: [line(3, { quantityShipped: 1.5 })], shippedPercent: 160 });

    const result = createOcShippingPatch(estimate(), partialInvoice, authority);
    expect(result).toMatchObject({ customerId, authorityId: orderId, shippedPercent: 75 });
    expect(result.lines[0]?.quantityShipped).toBe(1.5);
    expect(partialInvoice.customerId).toBe(lineId(8));
    expect(authority.customerId).toBe(lineId(9));
    expect(() => createOcShippingPatch(estimate(), partialInvoice, { ...authority, customerId: 'invalid' }))
      .toThrow('Invalid authority identity');
  });

  it('weights matched inventory lines and keeps zero or unknown totals unknown', () => {
    const multiple = estimate({
      lines: [line(1, { quantity: 2 }), line(4, { itemId: '10000000-0000-4000-8000-000000000006', quantity: 8 })],
    });
    const source = invoice({
      shippedPercent: 0,
      lines: [
        line(2, { quantity: 2, quantityShipped: 2 }),
        line(5, { itemId: '10000000-0000-4000-8000-000000000006', quantity: 8, quantityShipped: 2 }),
      ],
    });
    expect(createOcShippingPatch(multiple, source).shippedPercent).toBe(40);

    expect(
      createOcShippingPatch(estimate({ lines: [line(1, { quantity: 0 })] }), invoice({ lines: [line(2, { quantity: 0, quantityShipped: 0 })] }))
        .shippedPercent
    ).toBeNull();
    expect(createOcShippingPatch(estimate(), invoice({ lines: [line(2, { quantityShipped: null })] })).shippedPercent).toBeNull();
    expect(createOcShippingPatch(estimate(), invoice({
      shippedPercent: 60, lines: [line(2, { quantityShipped: null })],
    }))).toMatchObject({ shippedPercent: null, lines: [{ quantityShipped: null }] });
  });

  it('still rejects incorrect document and reverse-relation identities', () => {
    expect(() => createOcShippingPatch(estimate(), invoice({ number: 201 }))).toThrow('conversion relation');
    expect(() => createOcShippingPatch(estimate(), invoice({
      sourceEstimate: { observed: true, value: { id: orderId, estimateNumber: 100 } },
    }))).toThrow('does not point to the OC');
  });

  it('can produce a reportable null-shipping clear only after the converted source is proven', () => {
    const result = createUnknownOCShippingPatch(estimate(), invoice());
    expect(result).toMatchObject({
      associatedDocumentId: invoiceId,
      sourceKind: 'invoice',
      shippedPercent: null,
      lines: [{ quantityShipped: null }],
    });
    expect(result).not.toHaveProperty('authorityId');
  });
});

function estimate(
  patch: Partial<OCShippingCanonicalEstimate> = {}
): OCShippingCanonicalEstimate {
  return {
    id: estimateId,
    kind: 'estimate',
    number: 100,
    modified: 1789000000,
    customerId,
    lines: [line(1)],
    convertedDocument: { observed: true, value: { id: invoiceId, kind: 'invoice', number: 200 } },
    ...patch,
  };
}

function invoice(
  patch: Partial<OCShippingCanonicalSourceDocument> = {}
): OCShippingCanonicalSourceDocument {
  return {
    id: invoiceId,
    kind: 'invoice',
    number: 200,
    modified: 1789000001,
    customerId,
    lines: [line(2, { quantityShipped: 1 })],
    sourceEstimate: { observed: true, value: { id: estimateId, estimateNumber: 100 } },
    fulfillmentAuthority: 'invoice',
    fulfillmentSalesOrderId: null,
    ...patch,
  };
}

function salesOrder(
  patch: Partial<OCShippingCanonicalSourceDocument> = {}
): OCShippingCanonicalSourceDocument {
  return {
    id: orderId,
    kind: 'sales_order',
    number: 300,
    modified: 1789000002,
    customerId,
    lines: [line(3, { quantityShipped: 1 })],
    sourceEstimate: { observed: true, value: { id: estimateId, estimateNumber: 100 } },
    ...patch,
  };
}

function line(index: number, patch: Record<string, unknown> = {}) {
  return {
    documentItemId: lineId(index),
    itemId,
    quantity: 2,
    itemVariationLocationId: null,
    unitId: 1,
    ...patch,
  } as OCShippingCanonicalEstimate['lines'][number];
}

function lineId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}
