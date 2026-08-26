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
function flatten(arr) { return Array.isArray(arr?.[0]) ? arr.flat() : (arr || []); }
function processDocument(doc, existing) {
  const issueDate = doc.issue_date ? doc.issue_date.split('T')[0] : doc.issue_date;
  const accountName = doc.customer?.name ?? existing?.account_name ?? null;
  const salespersonName = doc.user?.name ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ') ?? existing?.salesperson_name ?? null;
  const statusName = doc.status?.name ?? existing?.status_name ?? null;
  const resolvedDocId = existing?.doc_id ?? doc.id;
  const docRow = {
    doc_id: resolvedDocId,
    context_id: doc.context_id,
    doc_number: doc.document_number,
    issue_date: issueDate,
    customer_id: doc.customer_id ?? existing?.customer_id ?? 'unknown',
    api_doc_id: doc.id,
    cache_source: 'api',
    document_name: sanitizeText(doc.name ?? existing?.document_name ?? null),
    custom_doc_number: doc.custom_doc_number ?? existing?.custom_doc_number ?? null,
    account_id: doc.customer_id ?? existing?.account_id ?? null,
    account_context_id: 2,
    account_name: sanitizeText(accountName),
    account_number: doc.customer?.customer_number ?? existing?.account_number ?? null,
    user_id: doc.user_id ?? existing?.user_id ?? null,
    salesperson_name: sanitizeText(salespersonName || null),
    customer_name: sanitizeText(accountName),
    customer_number: doc.customer?.customer_number ?? existing?.customer_number ?? null,
    supplier_name: null,
    supplier_number: null,
    status_id: doc.status_id ?? existing?.status_id ?? null,
    status_name: sanitizeText(statusName),
    total_price: doc.total_price ?? existing?.total_price ?? null,
    total_cost: doc.total_cost ?? existing?.total_cost ?? null,
    subtotal: doc.total_price ?? existing?.subtotal ?? null,
    associated_document_id: doc.associated_document_id ?? existing?.associated_document_id ?? null,
    external_po_number: doc.external_po_number ?? existing?.external_po_number ?? null,
    shipping_location: doc.shipping_location ?? existing?.shipping_location ?? null,
    date_sent: doc.date_sent ?? existing?.date_sent ?? null,
    shipped_percent: doc.shipped_percent ?? existing?.shipped_percent ?? null,
    is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
    modified: doc.modified ? Math.floor(new Date(doc.modified).getTime() / 1000) : existing?.modified ?? 0,
  };
  const itemRows = (doc.document_items || []).filter((item) => item.item_id).map((item) => ({
    item_id: item.item_id,
    doc_id: resolvedDocId,
    document_item_id: item.id,
    quantity: item.quantity,
    price: item.price,
    item_name: sanitizeText(item.name ?? item.description ?? item.item?.name ?? null),
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
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const client = new SalesBinderClient('default');
const cache = await createPostgresCacheService();
if (!cache) throw new Error('SALESBINDER_DB_URL is required');
await cache.ensureSchema();
const rows = (await cache.getDocumentsByContext(DocumentContextId.Invoice))
  .filter((d) => (d.status_name || '').toLowerCase() !== 'paid in full')
  .filter((d) => (d.status_name || '').toLowerCase() !== 'cancelled')
  .filter((d) => d.is_cancelled !== 1)
  .sort((a,b) => (b.doc_number||0)-(a.doc_number||0))
  .slice(0, Number.isFinite(limit) ? limit : undefined);
let fetched=0, updated=0, errors=0, withLineShip=0;
console.error(`Target invoices via list: ${rows.length}`);
for (const row of rows) {
  try {
    const response = await client.documents.list({ contextId: DocumentContextId.Invoice, documentNumber: row.doc_number, exact: true, pageLimit: 10 });
    const doc = flatten(response.documents).find((d) => d.document_number === row.doc_number) ?? flatten(response.documents)[0];
    if (!doc) throw new Error('not found in list response');
    fetched++;
    const existing = (await cache.getDocumentByApiId(doc.id)) ?? (await cache.getDocumentByNumber(DocumentContextId.Invoice, row.doc_number));
    const { docRow, itemRows } = processDocument(doc, existing);
    if (itemRows.some((i) => i.quantity_shipped != null)) withLineShip++;
    await cache.deleteItemDocuments(docRow.doc_id);
    await cache.insertDocument(docRow);
    await cache.batchInsertItemDocuments(itemRows);
    updated++;
    if (fetched % 50 === 0) console.error(`progress fetched=${fetched} updated=${updated} withLineShip=${withLineShip}`);
    await delay(150);
  } catch (e) {
    errors++;
    console.error(`failed invoice ${row.doc_number}: ${e?.message || e}`);
    if (e?.response?.status === 429) await delay(3000);
  }
}
console.log(JSON.stringify({ candidates: rows.length, fetched, updated, withLineShip, errors }, null, 2));
await cache.close?.();
