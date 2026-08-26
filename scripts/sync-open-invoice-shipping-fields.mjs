import fs from 'fs';
import { SalesBinderClient, DocumentContextId } from '../packages/sdk/dist/resources/index.js';
import { createPostgresCacheService } from '../packages/sdk/dist/cache/cache.factory.js';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitizeText = (value) => value == null ? null : String(value).replace(/\u0000/g, '');

function processDocument(doc) {
  const issueDate = doc.issue_date ? doc.issue_date.split('T')[0] : doc.issue_date;
  const accountContextId = doc.context_id === DocumentContextId.PurchaseOrder ? 10 : 2;
  const accountName = doc.customer?.name ?? null;
  const salespersonName = doc.user?.name ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ') ?? null;
  const statusName = doc.status?.name ?? null;
  const docRow = {
    doc_id: doc.id,
    context_id: doc.context_id,
    doc_number: doc.document_number,
    issue_date: issueDate,
    customer_id: doc.customer_id,
    api_doc_id: doc.id,
    cache_source: 'api',
    document_name: sanitizeText(doc.name),
    custom_doc_number: doc.custom_doc_number ?? null,
    account_id: doc.customer_id,
    account_context_id: accountContextId,
    account_name: sanitizeText(accountName),
    account_number: doc.customer?.customer_number ?? null,
    user_id: doc.user_id,
    salesperson_name: sanitizeText(salespersonName || null),
    customer_name: doc.context_id === DocumentContextId.PurchaseOrder ? null : sanitizeText(accountName),
    customer_number: doc.context_id === DocumentContextId.PurchaseOrder ? null : doc.customer?.customer_number ?? null,
    supplier_name: doc.context_id === DocumentContextId.PurchaseOrder ? sanitizeText(accountName) : null,
    supplier_number: doc.context_id === DocumentContextId.PurchaseOrder ? doc.customer?.customer_number ?? null : null,
    status_id: doc.status_id,
    status_name: sanitizeText(statusName),
    total_price: doc.total_price,
    total_cost: doc.total_cost,
    subtotal: doc.total_price,
    associated_document_id: doc.associated_document_id ?? null,
    external_po_number: doc.external_po_number ?? null,
    shipping_location: doc.shipping_location ?? null,
    date_sent: doc.date_sent ?? null,
    shipped_percent: doc.shipped_percent ?? null,
    is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
    modified: Math.floor(new Date(doc.modified).getTime() / 1000),
  };
  const itemRows = (doc.document_items || [])
    .filter((item) => item.item_id)
    .map((item) => ({
      item_id: item.item_id,
      doc_id: doc.id,
      document_item_id: item.id,
      quantity: item.quantity,
      price: item.price,
      item_name: sanitizeText(item.name ?? item.description ?? null),
      line_description: sanitizeText(item.description),
      quantity_received: item.quantity_partially_received ?? null,
      quantity_shipped: item.quantity_partially_shipped ?? null,
      cost: item.cost ?? null,
      total_amount: item.quantity * item.price,
      discounted_price: item.discounted_price ?? null,
      discount_percent: item.discount_percent ?? null,
    }));
  return { docRow, itemRows };
}

const dryRun = process.argv.includes('--dry-run');
const missingOnly = process.argv.includes('--missing-only');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const client = new SalesBinderClient('default');
const cache = await createPostgresCacheService();
if (!cache) throw new Error('SALESBINDER_DB_URL is required');
await cache.ensureSchema();
const allInvoices = await cache.getDocumentsByContext(DocumentContextId.Invoice);
const candidates = allInvoices
  .filter((d) => (d.status_name || '').toLowerCase() !== 'paid in full')
  .filter((d) => (d.status_name || '').toLowerCase() !== 'cancelled')
  .filter((d) => d.is_cancelled !== 1)
  .filter((d) => !missingOnly || d.shipped_percent == null)
  .sort((a, b) => (b.doc_number || 0) - (a.doc_number || 0))
  .slice(0, Number.isFinite(limit) ? limit : undefined);

let fetched = 0;
let updated = 0;
let unshipped = 0;
let partiallyShipped = 0;
let fullyShipped = 0;
let errors = 0;
console.error(`Target invoices: ${candidates.length}${missingOnly ? ' (missing only)' : ''}${dryRun ? ' (dry run)' : ''}`);
for (const row of candidates) {
  try {
    const id = row.api_doc_id || row.doc_id;
    const doc = await client.documents.get(id);
    fetched++;
    const pct = Number(doc.shipped_percent ?? 0);
    if (pct <= 0) unshipped++;
    else if (pct < 100) partiallyShipped++;
    else fullyShipped++;
    if (!dryRun) {
      const { docRow, itemRows } = processDocument(doc);
      const existing = (await cache.getDocumentByApiId(docRow.api_doc_id))
        ?? (await cache.getDocumentByNumber(docRow.context_id, docRow.doc_number));
      const resolvedDocId = existing?.doc_id ?? docRow.doc_id;
      const resolvedDocRow = { ...docRow, doc_id: resolvedDocId };
      const resolvedItemRows = itemRows.map((item) => ({ ...item, doc_id: resolvedDocId }));
      await cache.deleteItemDocuments(resolvedDocId);
      await cache.insertDocument(resolvedDocRow);
      await cache.batchInsertItemDocuments(resolvedItemRows);
      updated++;
    }
    if (fetched % 25 === 0) {
      console.error(`progress fetched=${fetched} updated=${updated} unshipped=${unshipped} partial=${partiallyShipped} shipped=${fullyShipped}`);
    }
    await delay(120);
  } catch (error) {
    errors++;
    console.error(`failed invoice ${row.doc_number}/${row.api_doc_id || row.doc_id}: ${error?.message || error}`);
    const status = error?.response?.status;
    if (status === 429) await delay(3000);
  }
}
console.log(JSON.stringify({ candidates: candidates.length, fetched, updated, unshipped, partiallyShipped, fullyShipped, errors }, null, 2));
await cache.close?.();
