#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const cliDir = process.cwd();
const envPath = join(cliDir, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ||= value;
  }
}

if (!process.env.SALESBINDER_DB_URL) {
  throw new Error('SALESBINDER_DB_URL is required; category cache writes to PostgreSQL only.');
}

const { SalesBinderClient } = await import('@salesbinder/sdk');
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: process.env.SALESBINDER_DB_URL });
const sb = new SalesBinderClient(process.env.SALESBINDER_ACCOUNT || 'default');
const accountName = process.env.SALESBINDER_ACCOUNT || 'default';
const lockKey = `salesbinder-category-cache:${accountName}`;

function flattenCategories(resp) {
  const cats = resp.categories ?? [];
  return Array.isArray(cats[0]) ? cats.flat() : cats;
}
function toUnix(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const client = await pool.connect();
let acquired = false;
const startedAt = Math.floor(Date.now() / 1000);
try {
  const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
  acquired = lock.rows[0]?.acquired === true;
  if (!acquired) throw new Error('Another SalesBinder category cache sync is already running.');

  await client.query(`
    CREATE TABLE IF NOT EXISTS categories (
      category_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      item_count INTEGER NULL,
      parent_id TEXT NULL,
      parent_name TEXT NULL,
      created TEXT NULL,
      modified BIGINT NULL,
      cache_source TEXT NOT NULL DEFAULT 'api',
      imported_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
    CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS category_cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const pageLimit = Number(process.env.SALESBINDER_CATEGORY_PAGE_LIMIT || 100);
  const delayMs = Number(process.env.SALESBINDER_CATEGORY_DELAY_MS || 300);
  let page = 1;
  let pages = 1;
  const categories = [];

  do {
    const resp = await sb.categories.list({ page, pageLimit });
    pages = Number(resp.pages ?? page);
    categories.push(...flattenCategories(resp));
    page++;
    if (delayMs > 0) await delay(delayMs);
  } while (page <= pages);

  const now = Math.floor(Date.now() / 1000);
  await client.query('BEGIN');
  for (const cat of categories) {
    await client.query(`
      INSERT INTO categories (
        category_id, name, item_count, parent_id, created, modified, cache_source, imported_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'api',$7)
      ON CONFLICT (category_id) DO UPDATE SET
        name = EXCLUDED.name,
        item_count = EXCLUDED.item_count,
        parent_id = EXCLUDED.parent_id,
        created = EXCLUDED.created,
        modified = EXCLUDED.modified,
        cache_source = 'api',
        imported_at = EXCLUDED.imported_at
    `, [cat.id, cat.name, cat.item_count ?? null, cat.parent_id ?? null, cat.created ?? null, toUnix(cat.modified), now]);
  }
  await client.query(`
    UPDATE categories c
    SET parent_name = p.name
    FROM categories p
    WHERE c.parent_id = p.category_id
  `);
  await client.query(`UPDATE categories SET parent_name = NULL WHERE parent_id IS NULL`);

  const backfill = await client.query(`
    UPDATE items i
    SET category_name = c.name
    FROM categories c
    WHERE i.category_id = c.category_id
      AND (i.category_name IS DISTINCT FROM c.name)
  `);

  await client.query(`
    INSERT INTO category_cache_meta (key, value) VALUES ('last_sync', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [JSON.stringify({ accountName, startedAt, finishedAt: now, pages, categoriesProcessed: categories.length, itemsBackfilled: backfill.rowCount })]);

  await client.query('COMMIT');

  const totals = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM categories) AS category_count,
      (SELECT COUNT(*)::int FROM items WHERE category_id IS NOT NULL) AS items_with_category_id,
      (SELECT COUNT(*)::int FROM items WHERE category_id IS NOT NULL AND category_name IS NOT NULL) AS items_with_category_name,
      (SELECT COUNT(*)::int FROM items i WHERE i.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.category_id = i.category_id)) AS items_missing_category_cache
  `);
  console.log(JSON.stringify({
    status: 'success',
    accountName,
    pages,
    categoriesProcessed: categories.length,
    itemsBackfilled: backfill.rowCount,
    ...totals.rows[0],
    saw429: false,
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  const status = error?.response?.status;
  console.error(JSON.stringify({ status: 'failed', httpStatus: status ?? null, saw429: status === 429, message: error?.message ?? String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (acquired) {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch {}
  }
  client.release();
  await pool.end();
}
