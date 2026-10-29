import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDeletedLog, DELETED_LOG_CONTEXTS } from './read-deleted-log.mjs';

const empty = () => ({ page: '1', pages: '0', count: '0', deletedlog: [] });
const entry = (id, contextId = 5, recordId = 'record') => ({
  id, context_id: contextId, record_id: recordId, created: '2026-10-01 12:34:56',
});
const response = (page, pages, total, entries) => ({ page, pages, count: total, deleted_log: [entries] });
const opts = { since: 1_790_000_000, now: 1_800_000_000 };
const makeClient = (list) => ({ deletedLog: { list } });
const first = (result) => result.contexts[0];

test('scans all requested contexts with the V2 GET parameters and accepts empty responses', async () => {
  const calls = [];
  const result = await collectDeletedLog(makeClient(async (params) => { calls.push(params); return empty(); }), opts);
  assert.deepEqual(calls.map(({ contextId }) => contextId), [5, 4, 11, 6, 2, 8, 10]);
  assert.ok(calls.every(({ deletedSince, page, pageLimit }) => deletedSince === opts.since && page === 1 && pageLimit === 200));
  assert.equal(result.scanStartedAt, opts.now);
  assert.equal(result.contexts.length, DELETED_LOG_CONTEXTS.length);
  assert.ok(result.contexts.every(({ status, events }) => status === 'complete' && events.length === 0));
});

test('preserves distinct source events for repeated deletion of one resource', async () => {
  const result = await collectDeletedLog(makeClient(async ({ contextId, page }) => contextId !== 5 ? empty() :
    response(page, 2, 2, [entry(page, 5, 'same-resource')])), opts);
  assert.equal(first(result).status, 'complete');
  assert.deepEqual(first(result).events, [1, 2].map((id) => ({
    id: String(id), contextId: 5, recordId: 'same-resource', created: '2026-10-01 12:34:56',
  })));
});

test('isolates source failures and never exposes exception text or partial results', async () => {
  const result = await collectDeletedLog(makeClient(async ({ contextId, page }) => {
    if (contextId !== 5) return empty();
    if (page === 1) return response(1, 2, 2, [entry(1)]);
    throw new Error('secret credential');
  }), opts);
  assert.equal(first(result).status, 'unavailable');
  assert.deepEqual(first(result).events, []);
  assert.equal(result.contexts[1].status, 'complete');
  assert.doesNotMatch(JSON.stringify(result), /secret credential/);
});

test('rejects changing pagination, missing rows, and duplicate source IDs', async () => {
  for (const second of [
    response(2, 3, 2, [entry(2)]),
    response(2, 2, 2, []),
    response(2, 2, 2, [entry(1)]),
  ]) {
    const result = await collectDeletedLog(makeClient(async ({ contextId, page }) => contextId !== 5 ? empty() :
      page === 1 ? response(1, 2, 2, [entry(1)]) : second), opts);
    assert.equal(first(result).status, 'incomplete');
    assert.deepEqual(first(result).events, []);
  }
});

test('rejects duplicate source IDs across contexts', async () => {
  const result = await collectDeletedLog(makeClient(async ({ contextId }) =>
    contextId === 5 || contextId === 4 ? response(1, 1, 1, [entry(1, contextId)]) : empty()), opts);
  assert.equal(result.contexts[0].status, 'incomplete');
  assert.equal(result.contexts[1].status, 'incomplete');
  assert.deepEqual(result.contexts[0].events, []);
  assert.deepEqual(result.contexts[1].events, []);
});

test('rejects malformed envelopes, identities, context and source timestamps', async () => {
  const bad = [
    { ...empty(), deleted_log: [] },
    { ...empty(), deletedlog: {} },
    response(1, 1, 1, [{ ...entry(1), created: '2026-02-30 12:00:00' }]),
    response(1, 1, 1, [{ ...entry(1), created: 'not-a-date' }]),
    response(1, 1, 1, [{ ...entry(1), created: '2026-01-01 25:00:00' }]),
    response(1, 1, 1, [entry(1, 4)]),
    response(1, 1, 1, [entry(0)]),
    response(1, 1, 1, [entry(1, 5, ' bad ')]),
    response(1, 10_001, 1, [entry(1)]),
  ];
  for (const value of bad) {
    const result = await collectDeletedLog(makeClient(async ({ contextId }) => contextId === 5 ? value : empty()), opts);
    assert.equal(first(result).status, 'incomplete');
    assert.deepEqual(first(result).events, []);
  }
});

test('invalid scan bounds fail closed without contacting the source', async () => {
  let calls = 0;
  const result = await collectDeletedLog(makeClient(async () => { calls++; return empty(); }), { since: 2, now: 1 });
  assert.equal(calls, 0);
  assert.ok(result.contexts.every(({ status }) => status === 'unavailable'));
});
