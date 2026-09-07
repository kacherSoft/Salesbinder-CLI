import { normalizeV3DocumentCacheRows } from '../v3-document-cache-normalizer.js';
import { DocumentRecordError } from '../document-source-validation.js';
import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';

const id = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const expected = { id, contextId: 5 as const, documentNumber: 1002 };

// Detail-shaped fixture following the official v3 invoice object, including discount and fulfillment.
function invoice(): Record<string, unknown> {
  return {
    id,
    object: 'invoice',
    invoice_number: 1002,
    custom_invoice_number: 'INV-1002',
    customer_id: '709d2a43-12a9-4d85-a9d9-cb16e66cef53',
    customer_name: 'Example Customer',
    salesperson_id: 'b16f844f-4b40-4f05-a468-407106563e03',
    issue_date: '2026-09-05',
    updated_at: '2026-09-06T04:00:49+00:00',
    status_id: 9,
    status: 'Sent',
    date_sent: '2026-09-05',
    shipped_percent: 50,
    party: {
      account_number: '002',
      phone: null,
      email: null,
      billing_address: [],
      shipping_address: [],
    },
    subtotal: '90.0000',
    shipping_fee: '10.0000',
    tax: '4.5000',
    tax_2: '0.0000',
    total: '104.5000',
    amount_paid: '25.0000',
    amount_due: '79.5000',
    lines: [
      {
        id: 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58',
        object: 'invoice_line',
        item_id: itemId,
        line_type: 'inventory',
        name: 'Widget',
        description: 'Blue widget',
        quantity: 2,
        quantity_packed: 2,
        quantity_shipped: 1,
        unit_price: '50.0000',
        discount_percent: '10.000',
        discounted_unit_price: '45.0000',
        subtotal: '90.0000',
        sku: 'BLUE',
        location_name: 'Main Warehouse',
        tax_rate: '5.000',
        tax_2_rate: '0.000',
        unit_id: null,
        variation_number: 42,
      },
    ],
  };
}

function firstLine(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc.lines as Record<string, unknown>[])[0]!;
}

describe('normalizeV3DocumentCacheRows', () => {
  it('maps invoice identity, true subtotal, current shipping, and unknown costs', () => {
    const result = normalizeV3DocumentCacheRows(invoice(), expected);
    expect(result.docRow).toMatchObject({
      doc_id: id,
      doc_number: 1002,
      context_id: 5,
      account_context_id: 2,
      account_number: 2,
      total_price: 104.5,
      subtotal: 90,
      total_cost: null,
      archived: null,
      shipped_percent: 50,
      custom_doc_number: 'INV-1002',
      user_id: 'b16f844f-4b40-4f05-a468-407106563e03',
    });
    expect(result.docRow).not.toHaveProperty('salesperson_name');
    expect(result.itemRows).toEqual([
      expect.objectContaining({
        item_id: itemId,
        quantity: 2,
        price: 50,
        discounted_price: 45,
        total_amount: 90,
        quantity_shipped: 1,
        quantity_received: null,
        cost: null,
      }),
    ]);
    expect(Object.keys(result)).toEqual(['docRow', 'itemRows']);
  });

  it('uses permitted unit cost without fabricating a document total cost', () => {
    const doc = invoice();
    Object.assign(firstLine(doc), { unit_cost: '25.0000', total_cost: '50.0000' });
    const result = normalizeV3DocumentCacheRows(doc, expected);
    expect(result.itemRows[0]?.cost).toBe(25);
    expect(result.docRow.total_cost).toBeNull();
  });

  it('maps purchase-order costs and receiving instead of invoice selling fields', () => {
    const doc = invoice();
    Object.assign(doc, {
      object: 'purchase_order',
      purchase_order_number: 1002,
      supplier_id: doc.customer_id,
      supplier_name: 'Example Supplier',
      assigned_user_id: doc.salesperson_id,
    });
    Object.assign(firstLine(doc), {
      object: 'purchase_order_line',
      unit_cost: '12.0000',
      discounted_unit_cost: '10.0000',
      quantity_received: 0.5,
      quantity_shipped: undefined,
      subtotal: '20.0000',
    });
    const result = normalizeV3DocumentCacheRows(doc, { ...expected, contextId: 11 });
    expect(result.docRow).toMatchObject({
      account_context_id: 10,
      supplier_name: 'Example Supplier',
      customer_name: null,
    });
    expect(result.itemRows[0]).toMatchObject({
      price: 12,
      cost: 12,
      discounted_price: 10,
      quantity_received: 0.5,
      quantity_shipped: null,
    });
  });

  it('maps prospect estimates and leaves nonnumeric displayed account numbers unknown', () => {
    const doc = invoice();
    Object.assign(doc, {
      object: 'estimate',
      estimate_number: 1002,
      customer_kind: 'prospect',
      party: { account_number: 'AC-002' },
    });
    firstLine(doc).object = 'estimate_line';
    const result = normalizeV3DocumentCacheRows(doc, { ...expected, contextId: 4 });
    expect(result.docRow.account_context_id).toBe(8);
    expect(result.docRow.account_number).toBeNull();
  });

  it('skips service and discount rows after validation, and allows repeated inventory across unique lines', () => {
    const doc = invoice();
    const line = firstLine(doc);
    doc.lines = [
      line,
      { ...line, id: '2cbe61a2-8f87-4f47-a6ae-238e89aa9d16' },
      { ...line, id: '394e9262-b64f-4e14-87b4-6b115ac339df', item_id: null, line_type: 'service' },
      { ...line, id: '7f3398c4-54f2-4648-9365-789a7c757182', item_id: null, line_type: 'discount' },
    ];
    expect(normalizeV3DocumentCacheRows(doc, expected).itemRows).toHaveLength(2);
  });

  it.each([{ id: itemId }, { object: 'estimate' }, { invoice_number: 99 }, { context_id: 4 }])(
    'rejects root identity mismatch %j',
    (patch) => {
      expect(() => normalizeV3DocumentCacheRows({ ...invoice(), ...patch }, expected)).toThrow(
        ApiResponseValidationError
      );
    }
  );

  it.each([
    { quantity: Infinity },
    { quantity: '1e500' },
    { unit_price: '' },
    { unit_price: true },
    { unit_cost: 'NaN' },
    { name: '\ud800' },
    { description: 123 },
    { quantity_shipped: {} },
    { item_id: '' },
    { item_id: null },
    { id: 'bad-id' },
    { line_type: 'service' },
    { object: 'purchase_order_line' },
    { document_id: itemId },
    { quantity: 1e308, unit_price: 1e308 },
    { variation_number: 2147483648 },
    { total_cost: '-Infinity' },
  ])('rejects malformed inventory rows %j', (patch) => {
    const doc = invoice();
    Object.assign(firstLine(doc), patch);
    expect(() => normalizeV3DocumentCacheRows(doc, expected)).toThrow(DocumentRecordError);
  });

  it('rejects duplicate line IDs and incomplete detail arrays', () => {
    const doc = invoice();
    doc.lines = [firstLine(doc), firstLine(doc)];
    expect(() => normalizeV3DocumentCacheRows(doc, expected)).toThrow(DocumentRecordError);
    expect(() =>
      normalizeV3DocumentCacheRows({ ...invoice(), lines: undefined }, expected)
    ).toThrow(DocumentRecordError);
  });

  it.each([itemId, null])('rejects absent line discriminators with item ID %s', (item) => {
    const doc = invoice();
    Object.assign(firstLine(doc), { line_type: undefined, item_id: item });
    expect(() => normalizeV3DocumentCacheRows(doc, expected)).toThrow(DocumentRecordError);
  });

  it('accepts documented integer unit identifiers', () => {
    const doc = invoice();
    firstLine(doc).unit_id = 12;
    expect(normalizeV3DocumentCacheRows(doc, expected).itemRows).toHaveLength(1);
  });

  it.each([
    { issue_date: null },
    { issue_date: '2026-02-30' },
    { updated_at: null },
    { subtotal: 'NaN' },
    { status_id: -1 },
    { customer_id: 'bad-id' },
    { customer_name: '\udfff' },
  ])('rejects malformed document content %j', (patch) => {
    expect(() => normalizeV3DocumentCacheRows({ ...invoice(), ...patch }, expected)).toThrow(
      DocumentRecordError
    );
  });

  it('removes PostgreSQL-incompatible NUL bytes without damaging valid Unicode', () => {
    const doc = invoice();
    firstLine(doc).name = 'M\u0000áy 🔧';
    expect(normalizeV3DocumentCacheRows(doc, expected).itemRows[0]?.item_name).toBe('Máy 🔧');
  });

  it('keeps missing document money and line subtotal unknown', () => {
    const doc = invoice();
    delete doc.total;
    delete doc.subtotal;
    delete firstLine(doc).subtotal;
    const result = normalizeV3DocumentCacheRows(doc, expected);
    expect(result.docRow.total_price).toBeNull();
    expect(result.docRow.subtotal).toBeNull();
    expect(result.itemRows[0]?.total_amount).toBeNull();
  });

  it('keeps V3 salesperson names unobserved while explicit unassignment clears the ID', () => {
    const assigned = normalizeV3DocumentCacheRows(invoice(), expected);
    expect(assigned.docRow.user_id).toBe('b16f844f-4b40-4f05-a468-407106563e03');
    expect(assigned.docRow).not.toHaveProperty('salesperson_name');

    const unassigned = invoice();
    unassigned.salesperson_id = null;
    const result = normalizeV3DocumentCacheRows(unassigned, expected);
    expect(result.docRow.user_id).toBeNull();
    expect(result.docRow).not.toHaveProperty('salesperson_name');
  });

  it.each([
    { contextId: 5 as const, object: 'invoice', numberKey: 'invoice_number', assignmentKey: 'salesperson_id' },
    { contextId: 4 as const, object: 'estimate', numberKey: 'estimate_number', assignmentKey: 'salesperson_id' },
    { contextId: 11 as const, object: 'purchase_order', numberKey: 'purchase_order_number', assignmentKey: 'assigned_user_id' },
  ])('rejects missing assignment key for $object but accepts explicit null', (shape) => {
    const doc = invoice();
    Object.assign(doc, {
      object: shape.object,
      [shape.numberKey]: expected.documentNumber,
    });
    Object.assign(firstLine(doc), { object: `${shape.object}_line` });
    if (shape.contextId === 11) {
      Object.assign(doc, {
        supplier_id: doc.customer_id,
        supplier_name: doc.customer_name,
      });
      Object.assign(firstLine(doc), { unit_cost: firstLine(doc).unit_price });
    }
    delete doc.salesperson_id;
    delete doc.assigned_user_id;
    expect(() =>
      normalizeV3DocumentCacheRows(doc, { ...expected, contextId: shape.contextId })
    ).toThrow(DocumentRecordError);

    doc[shape.assignmentKey] = null;
    const result = normalizeV3DocumentCacheRows(doc, { ...expected, contextId: shape.contextId });
    expect(result.docRow.user_id).toBeNull();
  });
});
