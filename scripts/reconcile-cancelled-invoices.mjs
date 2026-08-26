import fs from 'fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const { SalesBinderClient } = await import('../packages/sdk/dist/index.js');
const contextId = 5;
const cancelledStatusId = 15;
const pageLimit = 100;
const pageDelayMs = Number(process.env.SALESBINDER_CANCELLED_RECONCILE_DELAY_MS || 700);
const maxPages = Number(process.env.SALESBINDER_CANCELLED_RECONCILE_MAX_PAGES || 20);
const expectedCountFloor = Number(process.env.SALESBINDER_CANCELLED_RECONCILE_MIN_COUNT || 1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = new SalesBinderClient('default');
const apiRows = [];
let pageCount = 0;
let advertisedCount = null;
let advertisedPages = null;

for (let page = 1; page <= maxPages; page += 1) {
  const response = await client.documents.list({
    contextId,
    field: 'status_id',
    exact: true,
    s: cancelledStatusId,
    page,
    pageLimit,
  });
  const rows = (response.documents ?? []).flat();
  pageCount = page;
  advertisedCount = Number(response.count ?? 0);
  advertisedPages = Number(response.pages ?? 0);

  if (!Number.isFinite(advertisedPages) || advertisedPages < 1 || advertisedPages > maxPages) {
    throw new Error(`unsafe pagination metadata: count=${response.count} pages=${response.pages}`);
  }
  if (advertisedCount < expectedCountFloor || rows.length > pageLimit) {
    throw new Error(`unsafe cancelled response: count=${response.count} rows=${rows.length}`);
  }
  for (const row of rows) {
    if (Number(row.status_id) !== cancelledStatusId || Number(row.context_id) !== contextId) {
      throw new Error(`status filter returned unexpected row ${row.document_number}`);
    }
    apiRows.push(row);
  }
  if (page >= advertisedPages) break;
  if (rows.length === 0) throw new Error(`empty page ${page} before advertised last page ${advertisedPages}`);
  await sleep(pageDelayMs);
}

if (pageCount !== advertisedPages || apiRows.length !== advertisedCount) {
  throw new Error(`incomplete cancelled scan: scanned=${apiRows.length}/${advertisedCount} pages=${pageCount}/${advertisedPages}`);
}

const db = new pg.Client({ connectionString: process.env.SALESBINDER_DB_URL });
await db.connect();
let changed = 0;
const changedNumbers = [];
try {
  await db.query('BEGIN');
  for (const row of apiRows) {
    const existing = (await db.query(
      `SELECT doc_id, status_id, status_name, is_cancelled
       FROM documents
       WHERE context_id = $1 AND (api_doc_id = $2 OR doc_number = $3)
       ORDER BY CASE WHEN api_doc_id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [contextId, row.id, Number(row.document_number)],
    )).rows[0];
    if (!existing) continue;
    if (Number(existing.status_id) === cancelledStatusId && existing.status_name === 'cancelled' && Number(existing.is_cancelled) === 1) continue;
    await db.query(
      `UPDATE documents
       SET status_id = $1, status_name = $2, is_cancelled = 1
       WHERE doc_id = $3`,
      [cancelledStatusId, row.status?.name ?? 'cancelled', existing.doc_id],
    );
    changed += 1;
    changedNumbers.push(Number(row.document_number));
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}

console.log(JSON.stringify({
  status: 'success',
  contextId,
  filter: { field: 'status_id', exact: true, value: cancelledStatusId },
  apiCancelledCount: apiRows.length,
  apiAdvertisedCount: advertisedCount,
  pages: pageCount,
  changedCount: changed,
  changedNumbers,
  archivedCacheRowsUntouched: true,
  delayMs: pageDelayMs,
}));
