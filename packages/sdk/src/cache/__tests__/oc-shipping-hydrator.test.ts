import {
  hydrateOcShippingFromSalesOrder,
  hydrateOcShippingPatch,
  hydrateOcShippingPatchSafely,
} from '../oc-shipping-hydrator.js';
import type { OCShippingDocumentsReadPort } from '../oc-shipping.types.js';

const estimateId = '20000000-0000-4000-8000-000000000001';
const invoiceId = '20000000-0000-4000-8000-000000000002';
const orderId = '20000000-0000-4000-8000-000000000003';
const otherOrderId = '20000000-0000-4000-8000-000000000006';
const customerId = '20000000-0000-4000-8000-000000000004';
const itemId = '20000000-0000-4000-8000-000000000005';
const otherCustomerId = '20000000-0000-4000-8000-000000000007';

describe('OC shipping hydration', () => {
  it('hydrates a converted estimate from its authoritative invoice', async () => {
    const port = readPort({ invoice: invoice() });
    const result = await hydrateOcShippingPatch(port, estimate());

    expect(result).toMatchObject({
      issues: [],
      patch: {
        associatedDocumentId: invoiceId,
        authorityId: invoiceId,
        shippedPercent: 50,
        lines: [{ documentItemId: lineId(1), quantityShipped: 1 }],
      },
    });
  });

  it('accepts canonical decimal text while rejecting non-finite shipping values', async () => {
    const result = await hydrateOcShippingPatch(
      readPort({
        invoice: invoice({ shipped_percent: '50', lines: [line('invoice', 2, { quantity: '2.0', quantity_shipped: '1.0' })] }),
      }),
      estimate({ lines: [line('estimate', 1, { quantity: '2.0' })] })
    );
    expect(result.patch?.shippedPercent).toBe(50);
    expect(result.patch?.lines[0]?.quantityShipped).toBe(1);

    await expect(
      hydrateOcShippingPatch(readPort({ invoice: invoice({ shipped_percent: 'NaN' }) }), estimate())
    ).rejects.toThrow('Invalid shipped_percent');
  });

  it('does not infer standalone status from an omitted invoice relation', async () => {
    const standalone = invoice();
    delete (standalone as { source_estimate?: unknown }).source_estimate;
    await expect(hydrateOcShippingPatch(readPort(), standalone)).resolves.toEqual({
      patch: null,
      issues: [{ code: 'source_estimate_unobserved', documentId: invoiceId }],
    });
  });

  it('preserves an explicit standalone invoice relation as no OC patch', async () => {
    await expect(
      hydrateOcShippingPatch(readPort(), invoice({ source_estimate: null }))
    ).resolves.toEqual({ patch: null, issues: [] });
  });

  it('follows an observed source sales order when fulfillment_authority is omitted', async () => {
    const linkedInvoice = invoice({
      source_estimate: null,
      source_sales_order: { id: orderId, sales_order_number: 300 },
    });
    delete (linkedInvoice as { fulfillment_authority?: unknown }).fulfillment_authority;
    delete (linkedInvoice as { fulfillment_sales_order_id?: unknown }).fulfillment_sales_order_id;
    const result = await hydrateOcShippingPatch(
      readPort({
        estimate: estimate({ converted_document: { id: orderId, kind: 'sales_order', number: 300 } }),
        salesOrder: salesOrder(),
      }),
      linkedInvoice
    );
    expect(result.patch).toMatchObject({ associatedDocumentId: orderId, authorityId: orderId });
    expect(result.issues).toEqual([]);
  });

  it('reports an invoice with no authority hints instead of treating it as standalone', async () => {
    const unknown = invoice({ source_estimate: null, source_sales_order: null });
    delete (unknown as { fulfillment_authority?: unknown }).fulfillment_authority;
    delete (unknown as { fulfillment_sales_order_id?: unknown }).fulfillment_sales_order_id;
    await expect(hydrateOcShippingPatch(readPort(), unknown)).resolves.toEqual({
      patch: null,
      issues: [{ code: 'fulfillment_authority_unobserved', documentId: invoiceId }],
    });
  });

  it('rejects contradictory observed invoice sales-order references', async () => {
    const contradictory = invoice({
      source_estimate: null,
      fulfillment_sales_order_id: orderId,
      source_sales_order: { id: otherOrderId, sales_order_number: 301 },
    });
    delete (contradictory as { fulfillment_authority?: unknown }).fulfillment_authority;
    await expect(hydrateOcShippingPatch(readPort(), contradictory)).rejects.toThrow(
      'Linked invoice authorities disagree'
    );
  });

  it('converts a related customer conflict into a reportable shipping warning only', async () => {
    await expect(
      hydrateOcShippingPatchSafely(readPort({ invoice: invoice({ customer_id: otherCustomerId }) }), estimate())
    ).resolves.toEqual({
      patch: null,
      issues: [{ code: 'shipping_contract_invalid', documentId: estimateId }],
    });
  });

  it('keeps authentication failures from a related read fatal', async () => {
    const authenticationFailure = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    await expect(
      hydrateOcShippingPatchSafely(readPort({ invoice: authenticationFailure }), estimate())
    ).rejects.toBe(authenticationFailure);
  });

  it('keeps a malformed initiating payload fatal', async () => {
    await expect(
      hydrateOcShippingPatchSafely(readPort(), estimate({ customer_id: 'not-a-uuid' }))
    ).rejects.toThrow('Invalid estimate customer_id');
  });

  it('clears derived shipping when the OC proves its converted source but that source returns 404', async () => {
    const result = await hydrateOcShippingPatch(readPort({ invoice: notFound() }), estimate());
    expect(result.patch).toMatchObject({
      associatedDocumentId: invoiceId,
      sourceKind: 'invoice',
      shippedPercent: null,
      lines: [{ quantityShipped: null }],
    });
    expect(result.issues).toEqual([{ code: 'source_document_not_found', documentId: invoiceId }]);
  });

  it('clears derived shipping when a proven linked invoice loses its sales-order authority', async () => {
    const linked = invoice({
      fulfillment_authority: 'sales_order',
      fulfillment_sales_order_id: orderId,
    });
    const result = await hydrateOcShippingPatch(readPort({ invoice: linked, salesOrder: notFound() }), estimate());

    expect(result.patch).toMatchObject({
      associatedDocumentId: invoiceId,
      shippedPercent: null,
      lines: [{ quantityShipped: null }],
    });
    expect(result.patch).not.toHaveProperty('authorityId');
    expect(result.issues).toEqual([{ code: 'authority_not_found', documentId: orderId }]);
  });

  it('reconciles a sales order only after proving its estimate conversion', async () => {
    const result = await hydrateOcShippingFromSalesOrder(readPort({ estimate: estimate({
      converted_document: { id: orderId, kind: 'sales_order', number: 300 },
    }) }), salesOrder());
    expect(result.patch).toMatchObject({ associatedDocumentId: orderId, authorityId: orderId });
    expect(result.issues).toEqual([]);
  });
});

function readPort(payloads: { estimate?: unknown; invoice?: unknown; salesOrder?: unknown } = {}): OCShippingDocumentsReadPort {
  return {
    get: jest.fn(async (contextId: 4 | 5) => {
      const result = contextId === 4 ? payloads.estimate : payloads.invoice;
      if (result instanceof Error) throw result;
      if (result === undefined) throw notFound();
      return result;
    }),
    getSalesOrder: jest.fn(async () => {
      if (payloads.salesOrder instanceof Error) throw payloads.salesOrder;
      if (payloads.salesOrder === undefined) throw notFound();
      return payloads.salesOrder;
    }),
  };
}

function estimate(patch: Record<string, unknown> = {}) {
  return {
    id: estimateId,
    object: 'estimate',
    estimate_number: 100,
    updated_at: '2026-09-09T00:00:00Z',
    customer_id: customerId,
    converted_document: { id: invoiceId, kind: 'invoice', number: 200 },
    lines: [line('estimate', 1)],
    ...patch,
  };
}

function invoice(patch: Record<string, unknown> = {}) {
  return {
    id: invoiceId,
    object: 'invoice',
    invoice_number: 200,
    updated_at: '2026-09-09T00:00:01Z',
    customer_id: customerId,
    source_estimate: { id: estimateId, estimate_number: 100 },
    fulfillment_authority: 'invoice',
    fulfillment_sales_order_id: null,
    shipped_percent: 50,
    lines: [line('invoice', 2, { quantity_shipped: 1 })],
    ...patch,
  };
}

function salesOrder(patch: Record<string, unknown> = {}) {
  return {
    id: orderId,
    object: 'sales_order',
    sales_order_number: 300,
    updated_at: '2026-09-09T00:00:02Z',
    customer_id: customerId,
    source_estimate: { id: estimateId, estimate_number: 100 },
    shipped_percent: 50,
    lines: [line('sales_order', 3, { quantity_shipped: 1 })],
    ...patch,
  };
}

function line(kind: 'estimate' | 'invoice' | 'sales_order', index: number, patch: Record<string, unknown> = {}) {
  return {
    id: lineId(index),
    object: `${kind}_line`,
    item_id: itemId,
    line_type: 'inventory',
    quantity: 2,
    quantity_shipped: null,
    item_variation_location_id: null,
    unit_id: 1,
    ...patch,
  };
}

function lineId(index: number): string {
  return `20000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function notFound(): Error & { response: { status: number } } {
  return Object.assign(new Error('missing'), { response: { status: 404 } });
}
