import fs from 'fs';
import { SalesBinderClient, DocumentContextId } from '../packages/sdk/dist/resources/index.js';
import { createPostgresCacheService } from '../packages/sdk/dist/cache/cache.factory.js';
if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const delay = ms => new Promise(r=>setTimeout(r,ms));
const clean = v => v == null ? null : String(v).replace(/\u0000/g,'');
const flat = x => Array.isArray(x?.[0]) ? x.flat() : (x || []);
function rowsFor(doc, existing) {
  const statusName = doc.status?.name ?? existing?.status_name ?? null;
  const name = doc.customer?.name ?? existing?.account_name ?? null;
  const sales = doc.user?.name ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ') ?? existing?.salesperson_name ?? null;
  const docId = existing?.doc_id ?? doc.id;
  const docRow = {
    ...existing,
    doc_id: docId,
    context_id: doc.context_id,
    doc_number: doc.document_number,
    issue_date: doc.issue_date ? doc.issue_date.split('T')[0] : existing?.issue_date,
    customer_id: doc.customer_id ?? existing?.customer_id ?? 'unknown',
    modified: doc.modified ? Math.floor(new Date(doc.modified).getTime()/1000) : existing?.modified ?? 0,
    api_doc_id: doc.id,
    cache_source: 'api',
    document_name: clean(doc.name ?? existing?.document_name),
    custom_doc_number: doc.custom_doc_number ?? existing?.custom_doc_number ?? null,
    account_id: doc.customer_id ?? existing?.account_id ?? null,
    account_context_id: 2,
    account_name: clean(name),
    account_number: doc.customer?.customer_number ?? existing?.account_number ?? null,
    user_id: doc.user_id ?? existing?.user_id ?? null,
    salesperson_name: clean(sales || null),
    customer_name: clean(name),
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
  };
  const itemRows = (doc.document_items || []).filter(i=>i.item_id).map(i=>({
    item_id: i.item_id, doc_id: docId, document_item_id: i.id,
    quantity: i.quantity, price: i.price,
    item_name: clean(i.name ?? i.description ?? i.item?.name ?? null),
    item_number: null, item_sku: null, item_location: null,
    line_description: clean(i.description),
    quantity_received: i.quantity_partially_received ?? null,
    quantity_shipped: i.quantity_partially_shipped ?? null,
    cost: i.cost ?? null,
    total_amount: i.quantity * i.price,
    discounted_price: i.discounted_price ?? null,
    discount_percent: i.discount_percent ?? null,
  }));
  return { docRow, itemRows };
}
const cache = await createPostgresCacheService();
const client = new SalesBinderClient('default');
const open = (await cache.getDocumentsByContext(DocumentContextId.Invoice))
  .filter(d => !['paid in full','cancelled'].includes((d.status_name||'').toLowerCase()))
  .filter(d => d.is_cancelled !== 1)
  .filter(d => d.shipped_percent != null);
const target = new Map(open.map(d => [d.doc_number, d]));
let found=0, updated=0, withLineShip=0, page=1, empty=0;
const maxPages = Number(process.argv.find(a=>a.startsWith('--max-pages='))?.split('=')[1] || 220);
console.error(`Scanning invoice list pages for ${target.size} target open invoices, maxPages=${maxPages}`);
while (page <= maxPages && target.size > 0 && empty < 3) {
  try {
    const res = await client.documents.list({ contextId: DocumentContextId.Invoice, page, pageLimit: 50 });
    const docs = flat(res.documents);
    if (!docs.length) { empty++; page++; continue; }
    for (const doc of docs) {
      const existing = target.get(doc.document_number);
      if (!existing) continue;
      const { docRow, itemRows } = rowsFor(doc, existing);
      await cache.deleteItemDocuments(docRow.doc_id);
      await cache.insertDocument(docRow);
      await cache.batchInsertItemDocuments(itemRows);
      found++; updated++;
      if (itemRows.some(i=>i.quantity_shipped != null)) withLineShip++;
      target.delete(doc.document_number);
    }
    if (page % 10 === 0) console.error(`page=${page} found=${found} remaining=${target.size} withLineShip=${withLineShip}`);
    page++;
    await delay(500);
  } catch(e) {
    if (e?.response?.status === 404) break;
    console.error(`page ${page} failed: ${e?.message || e}`);
    if (e?.response?.status === 429) await delay(60000); else await delay(2000);
  }
}
console.log(JSON.stringify({found, updated, withLineShip, remaining: target.size, pagesScanned: page-1}, null, 2));
await cache.close?.();
