import type { Document } from '../types/documents.types.js';
import type { DocumentRow, ItemDocumentRow } from './types.js';
import { DocumentContextId } from './types.js';
import { DocumentRecordError, validateDocumentContent } from './document-source-validation.js';
import { toSalesBinderCalendarDateText } from './salesbinder-source-date-validation.js';
import { parseSalesBinderFiniteDecimal } from './salesbinder-source-number-validation.js';

export interface NormalizedDocumentCacheRows {
  docRow: DocumentRow;
  itemRows: Omit<ItemDocumentRow, 'id'>[];
}

export function normalizeDocumentCacheRows(doc: Document): NormalizedDocumentCacheRows {
  validateDocumentContent(doc);
  const issueDate = toSalesBinderCalendarDateText(doc.issue_date);
  const isPurchaseOrder = doc.context_id === DocumentContextId.PurchaseOrder;
  const accountContextId = isPurchaseOrder ? 10 : 2;
  const accountName = sanitizeCacheText(doc.customer?.name ?? null);
  const accountNumber = normalizeOptionalNumber(doc.customer?.customer_number);
  const salespersonName = sanitizeCacheText(resolveSalespersonName(doc.user));
  const statusName = sanitizeCacheText(doc.status?.name ?? null);

  const docRow: DocumentRow = {
    doc_id: doc.id,
    context_id: doc.context_id,
    doc_number: requiredSourceNumber(doc.document_number),
    issue_date: issueDate,
    customer_id: doc.customer_id,
    api_doc_id: doc.id,
    cache_source: 'api',
    document_name: sanitizeCacheText(doc.name),
    account_id: doc.customer_id,
    account_context_id: accountContextId,
    account_name: accountName,
    account_number: accountNumber,
    user_id: doc.user_id,
    salesperson_name: salespersonName,
    customer_name: isPurchaseOrder ? null : accountName,
    customer_number: isPurchaseOrder ? null : accountNumber,
    supplier_name: isPurchaseOrder ? accountName : null,
    supplier_number: isPurchaseOrder ? accountNumber : null,
    status_id: requiredSourceNumber(doc.status_id),
    status_name: statusName,
    total_price: requiredSourceNumber(doc.total_price),
    total_cost: requiredSourceNumber(doc.total_cost),
    subtotal: requiredSourceNumber(doc.total_price),
    date_sent: doc.date_sent == null ? null : toSalesBinderCalendarDateText(doc.date_sent),
    shipped_percent: normalizeOptionalNumber(doc.shipped_percent),
    is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
    archived: doc.archived == null ? null : doc.archived ? 1 : 0,
    modified: Math.floor(new Date(doc.modified).getTime() / 1000),
  };

  const itemRows = (doc.document_items ?? []).flatMap((item) => normalizeItemRow(doc.id, item));

  return { docRow, itemRows };
}

function normalizeItemRow(
  documentId: string,
  item: NonNullable<Document['document_items']>[number]
): Omit<ItemDocumentRow, 'id'>[] {
  if (!item.item_id) return [];
  const quantity = requiredSourceNumber(item.quantity);
  const price = requiredSourceNumber(item.price);
  const totalAmount = quantity * price;
  if (!Number.isFinite(totalAmount)) throw invalidDocumentRecord();
  return [
    {
      item_id: item.item_id,
      doc_id: documentId,
      document_item_id: item.id,
      quantity,
      price,
      item_name: sanitizeCacheText(item.name ?? item.description ?? null),
      line_description: sanitizeCacheText(item.description),
      quantity_received: normalizeOptionalNumber(item.quantity_partially_received),
      quantity_shipped: normalizeOptionalNumber(item.quantity_partially_shipped),
      cost: normalizeOptionalNumber(item.cost),
      total_amount: totalAmount,
      discounted_price: normalizeOptionalNumber(item.discounted_price),
      discount_percent: normalizeOptionalNumber(item.discount_percent),
    },
  ];
}

function resolveSalespersonName(user: Document['user']): string | null {
  if (user?.name) return user.name;
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
  return fullName || null;
}

/** Remove literal NUL bytes that PostgreSQL text columns reject. */
function sanitizeCacheText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replaceAll(String.fromCharCode(0), '');
}

function normalizeOptionalNumber(value: unknown): number | null {
  return value == null ? null : requiredSourceNumber(value);
}

function requiredSourceNumber(value: unknown): number {
  const parsed = parseSalesBinderFiniteDecimal(value);
  if (parsed === undefined) throw invalidDocumentRecord();
  return parsed;
}

function invalidDocumentRecord(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'Document failed source validation');
}
