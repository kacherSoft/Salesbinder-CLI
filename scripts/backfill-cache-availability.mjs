#!/usr/bin/env node
/** Backfill only NULL API-cache availability values from current PostgreSQL operands. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PostgresCacheService,
  createSalesBinderAccountBinding,
  loadConfig,
} from '../packages/sdk/dist/index.js';

export const ACCOUNT = 'phuthaitech';
export const DEFAULT_BATCH_SIZE = 500;
const TABLES = [
  { table: 'items', key: 'item_id', base: 'quantity' },
  { table: 'item_stock_locations', key: 'stock_row_id', base: 'quantity_on_hand' },
];
const NUMERIC = (column) =>
  `"${column}" IS NOT NULL AND "${column}" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;

export function availabilityExpression(base = 'quantity') {
  if (!['quantity', 'quantity_on_hand'].includes(base)) throw new Error('Unsupported availability operand.');
  return `"${base}" - "quantity_reserved"`;
}

export function computeAvailability(quantity, reserved) {
  const left = typeof quantity === 'number' || typeof quantity === 'string' ? Number(quantity) : NaN;
  const right = typeof reserved === 'number' || typeof reserved === 'string' ? Number(reserved) : NaN;
  return quantity !== '' && reserved !== '' && Number.isFinite(left) && Number.isFinite(right) && Number.isFinite(left - right) ? left - right : null;
}

export function eligibilityPredicate() {
  return `cache_source = 'api' AND quantity_available IS NULL AND ${NUMERIC('quantity_reserved')}`;
}

export function updateSql(table, key, base, limit = DEFAULT_BATCH_SIZE) {
  if (!TABLES.some((entry) => entry.table === table && entry.key === key && entry.base === base)) {
    throw new Error('Unsupported availability table.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Batch size must be an integer from 1 to 1000.');
  return `UPDATE "${table}" AS target
SET quantity_available = target."${base}" - target.quantity_reserved,
    quantity_available_source = 'computed'
  WHERE target."${key}" IN (
  SELECT candidate."${key}"
  FROM "${table}" AS candidate
  WHERE ${eligibilityPredicate()}
    AND ${NUMERIC(base)}
    AND ($2::text IS NULL OR candidate."${key}" COLLATE "C" > $2::text COLLATE "C")
  ORDER BY candidate."${key}" COLLATE "C"
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
  AND ${eligibilityPredicate()}
  AND ${NUMERIC(base)}
  AND ($2::text IS NULL OR target."${key}" COLLATE "C" > $2::text COLLATE "C")
RETURNING target."${key}"`;
}

export function countSql(table, key, base) {
  if (!TABLES.some((entry) => entry.table === table && entry.key === key && entry.base === base)) {
    throw new Error('Unsupported availability table.');
  }
  return `SELECT COUNT(*)::int AS count FROM "${table}"
WHERE ${eligibilityPredicate()} AND ${NUMERIC(base)}`;
}

export function parseArguments(argv) {
  let apply = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') apply = true;
    else if (argument === '--batch-size') {
      const value = argv[++index];
      if (!/^(?:[1-9]\d?|[1-9]\d\d|1000)$/.test(value ?? '')) throw new Error('Usage: --batch-size must be an integer from 1 to 1000.');
      batchSize = Number(value);
    } else throw new Error('Usage: node --env-file=.env scripts/backfill-cache-availability.mjs [--apply] [--batch-size N]');
  }
  return { apply, batchSize };
}

const report = (event, detail = {}) => console.error(JSON.stringify({ event, ...detail }));

async function assertSchema(client) {
  const result = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND ((table_name IN ('items', 'item_stock_locations') AND column_name IN ('quantity', 'quantity_on_hand', 'quantity_available', 'quantity_available_source', 'quantity_reserved')))
  `);
  const found = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const table of TABLES) {
    for (const column of ['quantity_available', 'quantity_available_source', 'quantity_reserved', table.base]) {
      if (!found.has(`${table.table}.${column}`)) throw new Error(`Availability schema is missing ${table.table}.${column}; run the SDK schema migration first.`);
    }
  }
}

async function run() {
  const { apply, batchSize } = parseArguments(process.argv.slice(2));
  if (!process.execArgv.includes('--env-file=.env') || !process.env.SALESBINDER_DB_URL) {
    throw new Error('Native .env loader and SALESBINDER_DB_URL are required.');
  }
  const account = loadConfig(ACCOUNT);
  const binding = createSalesBinderAccountBinding(account.subdomain);
  if (binding.accountIdentity !== 'salesbinder:phuthaitech' || binding.accountSubdomain !== ACCOUNT) throw new Error('Configured account is not the phuthaitech cache binding.');
  const service = new PostgresCacheService(process.env.SALESBINDER_DB_URL);
  let held = false;
  let lockLost = false;
  const assertHeld = () => { if (lockLost) throw new Error('PostgreSQL writer lock lost.'); };
  try {
    await service.verifyAccountBinding(binding);
    const probe = await service.pool.connect();
    try { await assertSchema(probe); } finally { probe.release(); }
    if (apply) {
      held = await service.tryAcquireSyncLock(`salesbinder-cache-sync:${binding.accountIdentity}`, { onLost: () => { lockLost = true; } });
      if (!held) throw new Error('Another cache writer is active.');
    }
    const summary = { mode: apply ? 'apply' : 'dry-run', batchSize, items: 0, stockRows: 0 };
    if (!apply) {
      const client = await service.pool.connect();
      try {
        for (const entry of TABLES) summary[entry.table === 'items' ? 'items' : 'stockRows'] = (await client.query(countSql(entry.table, entry.key, entry.base))).rows[0].count;
      } finally { client.release(); }
      report('dry-run', summary);
      return;
    }
    let remaining = true;
    const cursors = new Map(TABLES.map((entry) => [entry.table, null]));
    while (remaining) {
      remaining = false;
      assertHeld();
      const client = await service.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5000ms'");
        await client.query("SET LOCAL statement_timeout = '60000ms'");
        const bound = await client.query('SELECT account_identity, account_subdomain FROM cache_account_binding WHERE id = 1 FOR SHARE');
        if (bound.rows.length !== 1 || bound.rows[0].account_identity !== binding.accountIdentity || bound.rows[0].account_subdomain !== binding.accountSubdomain) throw new Error('Cache account binding changed.');
        for (const entry of TABLES) {
          assertHeld();
          const result = await client.query(updateSql(entry.table, entry.key, entry.base, batchSize), [batchSize, cursors.get(entry.table)]);
          const count = result.rowCount ?? result.rows.length;
          summary[entry.table === 'items' ? 'items' : 'stockRows'] += count;
          if (count > 0) {
            cursors.set(entry.table, result.rows.map((row) => row[entry.key]).sort().at(-1));
            remaining = true;
          }
        }
        assertHeld();
        await client.query('COMMIT');
        assertHeld();
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    }
    assertHeld();
    const final = await service.pool.connect();
    try {
      summary.remaining = {};
      for (const entry of TABLES) summary.remaining[entry.table === 'items' ? 'items' : 'stockRows'] = (await final.query(countSql(entry.table, entry.key, entry.base))).rows[0].count;
    } finally { final.release(); }
    assertHeld();
    if (summary.remaining.items > 0 || summary.remaining.stockRows > 0) {
      report('incomplete', summary);
      throw new Error('Backfill incomplete; rerun to process remaining rows.');
    }
    assertHeld();
    report('complete', summary);
  } finally {
    if (held) await service.releaseSyncLock(`salesbinder-cache-sync:${binding.accountIdentity}`).catch(() => undefined);
    await service.close().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    const message = String(error?.message ?? '');
    const reason = message.includes('Usage:') ? 'invalid_arguments' : message.includes('required') ? 'configuration_missing' : message.includes('schema') ? 'schema_missing' : message.includes('binding') || message.includes('account') ? 'account_binding_invalid' : message.includes('writer lock') || message.includes('cache writer') ? 'writer_lock_unavailable' : message.includes('incomplete') ? 'rows_remaining_rerun_required' : 'database_operation_failed';
    report('failed', { reason });
    process.exitCode = 1;
  });
}
