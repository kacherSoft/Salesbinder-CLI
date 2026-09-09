import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAvailability, countSql, parseArguments, updateSql } from './backfill-cache-availability.mjs';

test('defaults to dry-run and bounds batches', () => {
  assert.deepEqual(parseArguments([]), { apply: false, batchSize: 500 });
  assert.deepEqual(parseArguments(['--apply', '--batch-size', '7']), { apply: true, batchSize: 7 });
  assert.throws(() => parseArguments(['--batch-size', '1001']), /1 to 1000/);
  assert.throws(() => parseArguments(['--unknown']), /Usage/);
});

test('SQL scopes updates to API rows with finite operands and current values', () => {
  const sql = updateSql('items', 'item_id', 'quantity', 10);
  assert.match(sql, /cache_source = 'api'/);
  assert.match(sql, /quantity_available IS NULL/);
  assert.match(sql, /target\."quantity" - target\.quantity_reserved/);
  assert.match(sql, /quantity_available_source = 'computed'/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /NOT IN \('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric\)/);
  assert.match(countSql('item_stock_locations', 'stock_row_id', 'quantity_on_hand'), /quantity_on_hand/);
});

test('rejects tables or unsafe batch sizes outside the cache contract', () => {
  assert.throws(() => updateSql('documents', 'doc_id', 'quantity'), /Unsupported/);
  assert.throws(() => updateSql('items', 'item_id', 'quantity', 0), /1 to 1000/);
});

test('computes ordinary arithmetic and leaves non-finite operands unknown', () => {
  assert.equal(computeAvailability(10, 3), 7);
  assert.equal(computeAvailability('10.5', '2.25'), 8.25);
  assert.equal(computeAvailability(null, 1), null);
  assert.equal(computeAvailability('Infinity', 1), null);
  assert.equal(computeAvailability('', 1), null);
});
