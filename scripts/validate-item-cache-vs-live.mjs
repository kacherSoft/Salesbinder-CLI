#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const cliDir = process.cwd();
const envPath = join(cliDir, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[t.slice(0, i).trim()] ||= v;
  }
}

const { SalesBinderClient } = await import('@salesbinder/sdk');
const pg = (await import('pg')).default;
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.SALESBINDER_DB_URL });
const client = new SalesBinderClient('default');

function norm(v) { return v == null ? null : String(v); }
function pickBrand(obj) {
  const candidates = ['brand', 'brand_name', 'brandName', 'manufacturer', 'manufacturer_name', 'vendor', 'make'];
  const found = {};
  for (const k of candidates) if (Object.prototype.hasOwnProperty.call(obj, k)) found[k] = obj[k];
  if (obj.custom_fields) found.custom_fields = obj.custom_fields;
  if (obj.fields) found.fields = obj.fields;
  return found;
}
function flattenItems(resp) {
  const items = resp.items ?? [];
  return Array.isArray(items[0]) ? items.flat() : items;
}

const sampleSql = `
WITH oldest AS (
  SELECT 'oldest_created' AS bucket, item_id, item_number, name, sku, barcode, category_id, category_name, quantity, cost, price, created, modified
  FROM items WHERE created IS NOT NULL ORDER BY created ASC NULLS LAST LIMIT 4
), newest AS (
  SELECT 'newest_modified' AS bucket, item_id, item_number, name, sku, barcode, category_id, category_name, quantity, cost, price, created, modified
  FROM items WHERE modified IS NOT NULL ORDER BY modified DESC NULLS LAST LIMIT 4
), randoms AS (
  SELECT 'random' AS bucket, item_id, item_number, name, sku, barcode, category_id, category_name, quantity, cost, price, created, modified
  FROM items TABLESAMPLE SYSTEM (0.5) LIMIT 4
)
SELECT * FROM oldest
UNION ALL SELECT * FROM newest
UNION ALL SELECT * FROM randoms;
`;
const { rows } = await pool.query(sampleSql);
const seen = new Set();
const samples = rows.filter(r => r.item_id && !seen.has(r.item_id) && seen.add(r.item_id));

const results = [];
let has429 = false;
for (const row of samples) {
  await new Promise(r => setTimeout(r, 900));
  try {
    const live = await client.items.get(row.item_id);
    const liveBrand = pickBrand(live);
    const compare = {
      bucket: row.bucket,
      item_id: row.item_id,
      item_number: row.item_number,
      name: row.name,
      live_name: live.name,
      cache_category_id: row.category_id,
      live_category_id: live.category_id ?? live.category?.id ?? null,
      cache_category_name: row.category_name,
      live_category_name: live.category?.name ?? null,
      cache_sku: row.sku,
      live_sku: live.sku ?? null,
      cache_barcode: row.barcode,
      live_barcode: live.barcode ?? null,
      cache_price: row.price == null ? null : Number(row.price),
      live_price: live.price ?? null,
      cache_cost: row.cost == null ? null : Number(row.cost),
      live_cost: live.cost ?? null,
      cache_quantity: row.quantity == null ? null : Number(row.quantity),
      live_quantity: live.quantity ?? null,
      cache_created: row.created,
      live_created: live.created,
      cache_modified: row.modified,
      live_modified_raw: live.modified,
      live_keys: Object.keys(live).sort(),
      live_brand_candidates: liveBrand,
    };
    compare.match_category_id = norm(compare.cache_category_id) === norm(compare.live_category_id);
    compare.match_category_name = norm(compare.cache_category_name) === norm(compare.live_category_name);
    compare.match_sku = norm(compare.cache_sku) === norm(compare.live_sku);
    compare.match_barcode = norm(compare.cache_barcode) === norm(compare.live_barcode);
    compare.match_price = Number(compare.cache_price ?? 0) === Number(compare.live_price ?? 0);
    compare.match_cost = Number(compare.cache_cost ?? 0) === Number(compare.live_cost ?? 0);
    compare.match_quantity = Number(compare.cache_quantity ?? 0) === Number(compare.live_quantity ?? 0);
    results.push(compare);
  } catch (e) {
    const msg = e?.response?.status ? `${e.response.status} ${e.message}` : (e?.message ?? String(e));
    if (String(msg).includes('429')) has429 = true;
    results.push({ bucket: row.bucket, item_id: row.item_id, item_number: row.item_number, name: row.name, error: msg });
  }
}

const summary = {
  checked: results.length,
  errors: results.filter(r => r.error).length,
  category_id_mismatches: results.filter(r => !r.error && !r.match_category_id).length,
  category_name_mismatches: results.filter(r => !r.error && !r.match_category_name).length,
  sku_mismatches: results.filter(r => !r.error && !r.match_sku).length,
  barcode_mismatches: results.filter(r => !r.error && !r.match_barcode).length,
  price_mismatches: results.filter(r => !r.error && !r.match_price).length,
  cost_mismatches: results.filter(r => !r.error && !r.match_cost).length,
  quantity_mismatches: results.filter(r => !r.error && !r.match_quantity).length,
  live_brand_candidate_keys_seen: [...new Set(results.flatMap(r => r.live_brand_candidates ? Object.keys(r.live_brand_candidates) : []))],
  saw_429: has429,
};

const out = { generated_at: new Date().toISOString(), summary, results };
const outPath = join(cliDir, 'tmp', `item-cache-live-validation-${Date.now()}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ outPath, ...summary }, null, 2));
await pool.end();
