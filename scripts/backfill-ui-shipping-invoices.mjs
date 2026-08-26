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
const clean = (v) => v == null ? null : String(v).replace(/\u0000/g, '');
const flat = (x) => Array.isArray(x?.[0]) ? x.flat() : (x || []);

function docToRows(doc, existing) {
  const statusName = doc.status?.name ?? existing?.status_name ?? null;
  const accountName = doc.customer?.name ?? existing?.account_name ?? null;
  const salespersonName = doc.user?.name
    ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ')
    ?? existing?.salesperson_name
    ?? null;
  const docId = existing?.doc_id ?? doc.id;
  const docRow = {
    doc_id: docId,
    context_id: doc.context_id,
    doc_number: doc.document_number,
    issue_date: doc.issue_date ? doc.issue_date.split('T')[0] : (existing?.issue_date ?? ''),
    customer_id: doc.customer_id ?? existing?.customer_id ?? 'unknown',
    modified: doc.modified ? Math.floor(new Date(doc.modified).getTime() / 1000) : (existing?.modified ?? 0),
    api_doc_id: doc.id,
    cache_source: 'api',
    document_name: clean(doc.name ?? existing?.document_name ?? null),
    custom_doc_number: doc.custom_doc_number ?? existing?.custom_doc_number ?? null,
    account_id: doc.customer_id ?? existing?.account_id ?? null,
    account_context_id: 2,
    account_name: clean(accountName),
    account_number: doc.customer?.customer_number ?? existing?.account_number ?? null,
    user_id: doc.user_id ?? existing?.user_id ?? null,
    salesperson_name: clean(salespersonName || null),
    customer_name: clean(accountName),
    customer_number: doc.customer?.customer_number ?? existing?.customer_number ?? null,
    supplier_name: null,
    supplier_number: null,
    status_id: doc.status_id ?? existing?.status_id ?? null,
    status_name: clean(statusName),
    total_price: doc.total_price ?? existing?.total_price ?? null,
    total_cost: doc.total_cost ?? existing?.total_cost ?? null,
    subtotal: doc.total_price ?? existing?.subtotal ?? null,
    associated_document_id: doc.associated_document_id ?? existing?.associated_document_id ?? null,
    external_po_number: doc.external_po_number ?? existing?.external_po_number ?? null,
    shipping_location: doc.shipping_location ?? existing?.shipping_location ?? null,
    date_sent: doc.date_sent ?? existing?.date_sent ?? null,
    shipped_percent: doc.shipped_percent ?? existing?.shipped_percent ?? null,
    is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
    imported_at: existing?.imported_at ?? null,
  };
  const itemRows = (doc.document_items || [])
    .filter((item) => item.item_id)
    .map((item) => ({
      item_id: item.item_id,
      doc_id: docId,
      document_item_id: item.id,
      quantity: item.quantity,
      price: item.price,
      item_name: clean(item.name ?? item.description ?? item.item?.name ?? null),
      item_number: null,
      item_sku: null,
      item_location: null,
      line_description: clean(item.description),
      quantity_received: item.quantity_partially_received ?? null,
      quantity_shipped: item.quantity_partially_shipped ?? null,
      cost: item.cost ?? null,
      total_amount: item.quantity * item.price,
      discounted_price: item.discounted_price ?? null,
      discount_percent: item.discount_percent ?? null,
    }));
  return { docRow, itemRows };
}

const maxPages = Number(process.argv.find((a) => a.startsWith('--max-pages='))?.split('=')[1] || 700);
const dryRun = process.argv.includes('--dry-run');
const client = new SalesBinderClient('default');
const cache = await createPostgresCacheService();
if (!cache) throw new Error('SALESBINDER_DB_URL is required');
await cache.ensureSchema();

let page = 1;
let total = 0;
let foundNot = 0;
let foundPartial = 0;
let updated = 0;
let skippedShipped = 0;
let errors = 0;
const byStatus = {};

console.error(`Scanning live invoice pages for UI shipping backfill, maxPages=${maxPages}${dryRun ? ' dry-run' : ''}`);
while (page <= maxPages) {
  try {
    const res = await client.documents.list({ contextId: DocumentContextId.Invoice, page, pageLimit: 50 });
    const docs = flat(res.documents);
    if (!docs.length) break;

    for (const doc of docs) {
      total++;
      const pct = Number(doc.shipped_percent ?? 0);
      const status = doc.status?.name ?? String(doc.status_id ?? 'unknown');
      byStatus[status] ||= { not: 0, partial: 0, updated: 0 };

      // Match SalesBinder UI Order Status filter targets.
      if (pct >= 100) {
        skippedShipped++;
        continue;
      }
      if (pct <= 0) {
        foundNot++;
        byStatus[status].not++;
      } else {
        foundPartial++;
        byStatus[status].partial++;
      }

      if (!dryRun) {
        const existing = (await cache.getDocumentByApiId(doc.id))
          ?? (await cache.getDocumentByNumber(DocumentContextId.Invoice, doc.document_number));
        const { docRow, itemRows } = docToRows(doc, existing);
        await cache.deleteItemDocuments(docRow.doc_id);
        await cache.insertDocument(docRow);
        await cache.batchInsertItemDocuments(itemRows);
        updated++;
        byStatus[status].updated++;
      }
    }

    if (page % 20 === 0) {
      console.error(`page=${page} total=${total} not=${foundNot} partial=${foundPartial} updated=${updated}`);
    }
    page++;
    await delay(350);
  } catch (error) {
    if (error?.response?.status === 404) break;
    errors++;
    console.error(`page=${page} failed: ${error?.message || error}`);
    if (error?.response?.status === 429) await delay(60000);
    else await delay(2000);
  }
}

console.log(JSON.stringify({ pagesScanned: page - 1, total, foundNot, foundPartial, skippedShipped, updated, errors, byStatus }, null, 2));
await cache.close?.();
