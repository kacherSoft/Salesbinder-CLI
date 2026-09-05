import { createPostgresFullAttemptStore } from './postgres-full-attempt-store.js';

function fakeDatabase(initialValue?: string) {
  const state = { value: initialValue };
  const query = jest.fn(async (_sql: string, values: string[]) => {
    const previous = state.value ?? null;
    const parsed = previous === null || /^\d+$/.test(previous) ? Number(previous ?? 0) : NaN;
    const claimed = previous === null || (Number.isFinite(parsed) && parsed <= Number(values[2]));
    if (claimed) state.value = values[1];
    return { rows: [{ claimed, previous_value: previous }] };
  });
  const end = jest.fn(async () => undefined);
  const pool = { query, end };
  return { pool, query, end, state };
}

test('claims a durable full attempt with one atomic metadata upsert', async () => {
  const database = fakeDatabase('0');
  const store = createPostgresFullAttemptStore('configured cache connection', {
    pool: database.pool,
  });
  const timestamp = Date.parse('2030-01-08T00:00:00.000Z');
  await expect(store.claim(timestamp, 86_400_000)).resolves.toBe(true);
  expect(database.query).toHaveBeenCalledTimes(1);
  expect(database.query.mock.calls[0]?.[0]).toContain('ON CONFLICT (key) DO UPDATE');
  expect(database.query.mock.calls[0]?.[1]).toEqual([
    'cache_sync_runner.last_full_sync_attempt',
    String(Math.floor(timestamp / 1000)),
    String(Math.floor((timestamp - 86_400_000) / 1000)),
  ]);
});

test('does not claim while the durable retry interval is active', async () => {
  const now = Date.parse('2030-01-08T00:00:00.000Z');
  const database = fakeDatabase(String(now / 1000 - 60));
  const store = createPostgresFullAttemptStore('configured cache connection', {
    pool: database.pool,
  });
  await expect(store.claim(now, 86_400_000)).resolves.toBe(false);
  expect(database.state.value).toBe(String(now / 1000 - 60));
});

test.each(['malformed', '-1', '999999999999999999999'])(
  'fails closed with a sanitized error for invalid durable state %s',
  async (value) => {
    const database = fakeDatabase(value);
    const store = createPostgresFullAttemptStore('configured cache connection', {
      pool: database.pool,
    });
    await expect(store.claim(Date.now(), 86_400_000)).rejects.toThrow(
      'PostgreSQL full-sync throttle operation failed.'
    );
    expect(database.state.value).toBe(value);
  }
);

test('two runner instances share the durable retry throttle across redeploys', async () => {
  const database = fakeDatabase();
  const first = createPostgresFullAttemptStore('first configured connection', {
    pool: database.pool,
  });
  const replacement = createPostgresFullAttemptStore('replacement configured connection', {
    pool: database.pool,
  });
  const now = Date.parse('2030-01-08T00:00:00.000Z');
  const concurrentClaims = await Promise.all([
    first.claim(now, 86_400_000),
    replacement.claim(now, 86_400_000),
  ]);
  expect(concurrentClaims.sort()).toEqual([false, true]);
  await expect(replacement.claim(now + 60_000, 86_400_000)).resolves.toBe(false);
});

test('database failures use a sanitized constant error', async () => {
  const database = fakeDatabase();
  database.query.mockRejectedValueOnce(new Error('private database failure detail'));
  const store = createPostgresFullAttemptStore('configured cache connection', {
    pool: database.pool,
  });
  await expect(store.claim(Date.now(), 86_400_000)).rejects.toThrow(
    'PostgreSQL full-sync throttle operation failed.'
  );
});

test('closes the PostgreSQL pool', async () => {
  const database = fakeDatabase();
  const store = createPostgresFullAttemptStore('configured cache connection', {
    pool: database.pool,
  });
  await store.close();
  expect(database.end).toHaveBeenCalled();
});
