#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) for (const line of readFileSync(envPath,'utf8').split(/\r?\n/)) { const t=line.trim(); if(!t||t.startsWith('#')||!t.includes('=')) continue; const i=t.indexOf('='); let v=t.slice(i+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); process.env[t.slice(0,i).trim()] ||= v; }
const { SalesBinderClient } = await import('@salesbinder/sdk');
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: process.env.SALESBINDER_DB_URL });
const client = new SalesBinderClient('default');
const ids = ['5aa9da70-594a-4cd6-9150-7cda4776b4dc','5a2ca45c-afe8-4f2d-b516-5aa80a8e0002','cd5ca7a9-8465-45ed-a8c5-913d3d2adb0e','5a30ef31-7e70-46e7-9182-5fc60a8e0002','6da16dd7-a893-4875-9080-0dd7903e6cb8'];
const out=[];
for (const id of ids) {
  await new Promise(r=>setTimeout(r,700));
  const cat = await client.categories.get(id);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cached_items, COUNT(*) FILTER (WHERE category_name IS NOT NULL)::int AS with_cached_name FROM items WHERE category_id=$1',[id]);
  out.push({ id, live_category: cat, cached_items: rows[0].cached_items, cached_items_with_category_name: rows[0].with_cached_name });
}
const rawItem = await client.items.get('dad620d1-f8c5-423e-a4c0-6ddc63919623');
const result = { categories: out, sample_item_brand_related: { keys: Object.keys(rawItem).sort(), suppliers: rawItem.suppliers, item_details: rawItem.item_details, pricing_details: rawItem.pricing_details } };
const outPath=join(process.cwd(),'tmp',`item-category-live-validation-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(result,null,2));
console.log(JSON.stringify({outPath, categories: out.map(x=>({id:x.id,name:x.live_category?.name,parent_id:x.live_category?.parent_id,cached_items:x.cached_items,cached_items_with_category_name:x.cached_items_with_category_name})), sample_has_suppliers: Array.isArray(rawItem.suppliers)?rawItem.suppliers.length:null, sample_item_detail_keys: rawItem.item_details?Object.keys(rawItem.item_details):null}, null, 2));
await pool.end();
