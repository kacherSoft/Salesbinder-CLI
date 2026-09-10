import type { Document } from '../../types/documents.types.js';
import { DocumentRecordError } from '../document-source-validation.js';
import { normalizeDocumentCacheRows } from '../document-row-normalizer.js';
import { normalizeV3DocumentCacheRows } from '../v3-document-cache-normalizer.js';
import {
  parseV3ConvertedDocumentRelation,
  parseV3SourceEstimateRelation,
} from '../v3-document-relationship-normalizer.js';
import { DocumentContextId } from '../types.js';

const estimateId = '58137131-57a1-48d7-9fe6-bf610e1c22ec';
const invoiceId = '4b150cc3-4b82-4f03-9e00-14ccbbcfe301';
const salesOrderId = 'a0f9cf7f-7ba9-44c6-94fe-740e4e09d3a0';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';

function estimate(): Record<string, unknown> {
  return {
    id: estimateId,
    object: 'estimate',
    estimate_number: 91,
    customer_id: '709d2a43-12a9-4d85-a9d9-cb16e66cef53',
    customer_name: 'Example Customer',
    salesperson_id: null,
    issue_date: '2026-09-05',
    updated_at: '2026-09-06T04:00:49+00:00',
    status_id: 9,
    status: 'Sent',
    subtotal: '90.0000',
    total: '90.0000',
    lines: [
      {
        id: 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58',
        object: 'estimate_line',
        item_id: itemId,
        line_type: 'inventory',
        name: 'Widget',
        quantity: 2,
        unit_price: '45.0000',
        subtotal: '90.0000',
        unit_cost: '25.0000',
        total_cost: '50.0000',
      },
    ],
  };
}

function invoice(): Record<string, unknown> {
  const source = estimate();
  return {
    ...source,
    id: invoiceId,
    object: 'invoice',
    invoice_number: 101,
    lines: (source.lines as Record<string, unknown>[]).map((line) => ({
      ...line,
      object: 'invoice_line',
    })),
  };
}

function legacyDocument(): Document {
  return {
    id: 'invoice-1',
    context_id: DocumentContextId.Invoice,
    document_number: 101,
    customer_id: 'customer-1',
    user_id: 'user-1',
    issue_date: '2026-09-05',
    status_id: 9,
    total_cost: 50,
    total_tax: 0,
    total_tax2: 0,
    total_price: 90,
    total_transactions: 0,
    created: '2026-09-05',
    modified: '2026-09-06',
  };
}

describe('document relationship normalization', () => {
  it('preserves omitted and explicit-null conversion fields while mapping a validated conversion', () => {
    const omitted = estimate();
    expect(parseV3ConvertedDocumentRelation(omitted, estimateId)).toEqual({ observed: false });
    expect(
      normalizeV3DocumentCacheRows(omitted, {
        id: estimateId,
        contextId: 4,
        documentNumber: 91,
      }).docRow
    ).not.toHaveProperty('associated_document_id');

    const cleared = estimate();
    cleared.converted_document = null;
    expect(parseV3ConvertedDocumentRelation(cleared, estimateId)).toEqual({
      observed: true,
      value: null,
    });
    expect(
      normalizeV3DocumentCacheRows(cleared, {
        id: estimateId,
        contextId: 4,
        documentNumber: 91,
      }).docRow.associated_document_id
    ).toBeNull();

    const converted = estimate();
    converted.converted_document = { id: invoiceId, kind: 'invoice', number: 101 };
    expect(parseV3ConvertedDocumentRelation(converted, estimateId)).toEqual({
      observed: true,
      value: { id: invoiceId, kind: 'invoice', number: 101 },
    });
    expect(
      normalizeV3DocumentCacheRows(converted, {
        id: estimateId,
        contextId: 4,
        documentNumber: 91,
      }).docRow.associated_document_id
    ).toBe(invoiceId);

    const convertedSalesOrder = estimate();
    convertedSalesOrder.converted_document = {
      id: salesOrderId,
      kind: 'sales_order',
      number: 102,
    };
    expect(
      normalizeV3DocumentCacheRows(convertedSalesOrder, {
        id: estimateId,
        contextId: 4,
        documentNumber: 91,
      }).docRow.associated_document_id
    ).toBe(salesOrderId);
  });

  it('maps a validated invoice source estimate without treating an omitted source as a clear', () => {
    const omitted = invoice();
    expect(parseV3SourceEstimateRelation(omitted, invoiceId)).toEqual({ observed: false });
    expect(
      normalizeV3DocumentCacheRows(omitted, {
        id: invoiceId,
        contextId: 5,
        documentNumber: 101,
      }).docRow
    ).not.toHaveProperty('associated_document_id');

    const cleared = invoice();
    cleared.source_estimate = null;
    expect(parseV3SourceEstimateRelation(cleared, invoiceId)).toEqual({
      observed: true,
      value: null,
    });
    expect(
      normalizeV3DocumentCacheRows(cleared, {
        id: invoiceId,
        contextId: 5,
        documentNumber: 101,
      }).docRow.associated_document_id
    ).toBeNull();

    const sourced = invoice();
    sourced.source_estimate = { id: estimateId, estimate_number: 91 };
    expect(parseV3SourceEstimateRelation(sourced, invoiceId)).toEqual({
      observed: true,
      value: { id: estimateId, estimate_number: 91 },
    });
    expect(
      normalizeV3DocumentCacheRows(sourced, {
        id: invoiceId,
        contextId: 5,
        documentNumber: 101,
      }).docRow.associated_document_id
    ).toBe(estimateId);
  });

  it.each([
    { converted_document: undefined },
    { converted_document: {} },
    { converted_document: { id: invoiceId, kind: 'purchase_order', number: 101 } },
    { converted_document: { id: estimateId, kind: 'invoice', number: 101 } },
    { converted_document: { id: 'not-a-uuid', kind: 'invoice', number: 101 } },
    { converted_document: { id: invoiceId, kind: 'sales_order', number: 1.5 } },
  ])('rejects malformed or self-referential converted documents %j', (patch) => {
    expect(() => parseV3ConvertedDocumentRelation({ ...estimate(), ...patch }, estimateId)).toThrow(
      DocumentRecordError
    );
  });

  it.each([
    { source_estimate: undefined },
    { source_estimate: {} },
    { source_estimate: { id: invoiceId, estimate_number: 91 } },
    { source_estimate: { id: 'not-a-uuid', estimate_number: 91 } },
    { source_estimate: { id: estimateId, estimate_number: -1 } },
  ])('rejects malformed or self-referential source estimates %j', (patch) => {
    expect(() => parseV3SourceEstimateRelation({ ...invoice(), ...patch }, invoiceId)).toThrow(
      DocumentRecordError
    );
  });

  it('maps an observed legacy associated_document_id without changing its public type contract', () => {
    const omitted = legacyDocument();
    expect(normalizeDocumentCacheRows(omitted).docRow).not.toHaveProperty('associated_document_id');

    const cleared = legacyDocument() as Document & { associated_document_id?: unknown };
    cleared.associated_document_id = null;
    expect(normalizeDocumentCacheRows(cleared).docRow.associated_document_id).toBeNull();

    const unconverted = legacyDocument() as Document & { associated_document_id?: unknown };
    unconverted.associated_document_id = '';
    expect(normalizeDocumentCacheRows(unconverted).docRow.associated_document_id).toBeNull();

    const associated = legacyDocument() as Document & { associated_document_id?: unknown };
    associated.associated_document_id = 'estimate-91';
    expect(normalizeDocumentCacheRows(associated).docRow.associated_document_id).toBe('estimate-91');

    associated.associated_document_id = ' invoice-1 ';
    expect(() => normalizeDocumentCacheRows(associated)).toThrow(DocumentRecordError);
    associated.associated_document_id = 'invoice-1';
    expect(() => normalizeDocumentCacheRows(associated)).toThrow(DocumentRecordError);
  });
});
