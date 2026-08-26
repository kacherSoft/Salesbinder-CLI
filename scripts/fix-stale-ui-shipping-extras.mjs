import fs from 'fs';
import pg from 'pg';
import { SalesBinderClient, DocumentContextId } from '../packages/sdk/dist/resources/index.js';
import { createPostgresCacheService } from '../packages/sdk/dist/cache/cache.factory.js';
for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const clean=v=>v==null?null:String(v).replace(/\u0000/g,'');
const live=JSON.parse(fs.readFileSync('/home/kacher/.openclaw/workspace/tmp/live-ui-shipping-targets.json','utf8'));
const liveSet=new Set(live.targets.map(t=>Number(t.doc_number)));
const pgClient=new pg.Client({connectionString:process.env.SALESBINDER_DB_URL});
await pgClient.connect();
const extras=(await pgClient.query(`SELECT * FROM documents WHERE context_id=5 AND shipped_percent >= 0 AND shipped_percent < 100 ORDER BY doc_number DESC`)).rows.filter(r=>!liveSet.has(Number(r.doc_number)));
await pgClient.end();
const api=new SalesBinderClient('default');
const cache=await createPostgresCacheService();
let updated=0, errors=0;
const results=[];
for(const existing of extras){
  try{
    const doc=await api.documents.get(existing.api_doc_id || existing.doc_id);
    const statusName=doc.status?.name ?? existing.status_name ?? null;
    const accountName=doc.customer?.name ?? existing.account_name ?? null;
    const salespersonName=doc.user?.name ?? [doc.user?.first_name, doc.user?.last_name].filter(Boolean).join(' ') ?? existing.salesperson_name ?? null;
    const docRow={
      ...existing,
      doc_id: existing.doc_id,
      context_id: doc.context_id ?? DocumentContextId.Invoice,
      doc_number: doc.document_number ?? existing.doc_number,
      issue_date: doc.issue_date ? doc.issue_date.split('T')[0] : existing.issue_date,
      customer_id: doc.customer_id ?? existing.customer_id ?? 'unknown',
      modified: doc.modified ? Math.floor(new Date(doc.modified).getTime()/1000) : existing.modified,
      api_doc_id: doc.id ?? existing.api_doc_id,
      cache_source:'api',
      document_name: clean(doc.name ?? existing.document_name),
      custom_doc_number: doc.custom_doc_number ?? existing.custom_doc_number ?? null,
      account_id: doc.customer_id ?? existing.account_id ?? null,
      account_context_id: 2,
      account_name: clean(accountName),
      account_number: doc.customer?.customer_number ?? existing.account_number ?? null,
      user_id: doc.user_id ?? existing.user_id ?? null,
      salesperson_name: clean(salespersonName || null),
      customer_name: clean(accountName),
      customer_number: doc.customer?.customer_number ?? existing.customer_number ?? null,
      supplier_name:null,
      supplier_number:null,
      status_id: doc.status_id ?? existing.status_id ?? null,
      status_name: clean(statusName),
      total_price: doc.total_price ?? existing.total_price ?? null,
      total_cost: doc.total_cost ?? existing.total_cost ?? null,
      subtotal: doc.total_price ?? existing.subtotal ?? null,
      associated_document_id: doc.associated_document_id ?? existing.associated_document_id ?? null,
      external_po_number: doc.external_po_number ?? existing.external_po_number ?? null,
      shipping_location: doc.shipping_location ?? existing.shipping_location ?? null,
      date_sent: doc.date_sent ?? existing.date_sent ?? null,
      shipped_percent: doc.shipped_percent ?? existing.shipped_percent ?? null,
      is_cancelled: statusName && /cancelled|canceled/i.test(statusName) ? 1 : 0,
    };
    const itemRows=(doc.document_items||[]).filter(i=>i.item_id).map(i=>({
      item_id:i.item_id, doc_id:existing.doc_id, document_item_id:i.id,
      quantity:i.quantity, price:i.price,
      item_name: clean(i.name ?? i.description ?? i.item?.name ?? null),
      item_number:null, item_sku:null, item_location:null,
      line_description: clean(i.description),
      quantity_received:i.quantity_partially_received ?? null,
      quantity_shipped:i.quantity_partially_shipped ?? null,
      cost:i.cost ?? null,
      total_amount:i.quantity*i.price,
      discounted_price:i.discounted_price ?? null,
      discount_percent:i.discount_percent ?? null,
    }));
    await cache.deleteItemDocuments(existing.doc_id);
    await cache.insertDocument(docRow);
    await cache.batchInsertItemDocuments(itemRows);
    updated++;
    results.push({doc_number: existing.doc_number, old: existing.shipped_percent, now: docRow.shipped_percent, status: docRow.status_name});
  }catch(e){ errors++; results.push({doc_number: existing.doc_number, error:e?.message||String(e)}); }
}
console.log(JSON.stringify({extras:extras.length, updated, errors, results},null,2));
await cache.close?.();
