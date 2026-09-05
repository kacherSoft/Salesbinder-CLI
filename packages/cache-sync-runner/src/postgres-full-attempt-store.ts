import pg from 'pg';

const { Pool: PostgresPool } = pg;
const META_KEY = 'cache_sync_runner.last_full_sync_attempt';
const THROTTLE_ERROR = 'PostgreSQL full-sync throttle operation failed.';

interface DatabasePool {
  query(
    sql: string,
    values: string[]
  ): Promise<{ rows: Array<{ claimed: boolean; previous_value: string | null }> }>;
  end(): Promise<void>;
  on?(event: 'error', listener: () => void): void;
}

export interface FullAttemptStore {
  claim(timestampMs: number, retryMilliseconds: number): Promise<boolean>;
  close(): Promise<void>;
}

interface StoreDependencies {
  pool?: DatabasePool;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(THROTTLE_ERROR);
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(THROTTLE_ERROR);
  return seconds * 1000;
}

export function createPostgresFullAttemptStore(
  connectionString: string,
  dependencies: StoreDependencies = {}
): FullAttemptStore {
  const pool =
    dependencies.pool ??
    (new PostgresPool({
      connectionString,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 1,
      query_timeout: 10_000,
      statement_timeout: 10_000,
    }) as unknown as DatabasePool);
  pool.on?.('error', () => {
    console.error('PostgreSQL full-sync throttle idle client error.');
  });
  return {
    async claim(timestampMs, retryMilliseconds): Promise<boolean> {
      try {
        const nextAttempt = Math.floor(timestampMs / 1000);
        const oldestThrottledAttempt = Math.floor((timestampMs - retryMilliseconds) / 1000);
        if (!Number.isSafeInteger(nextAttempt) || !Number.isSafeInteger(oldestThrottledAttempt)) {
          throw new Error(THROTTLE_ERROR);
        }
        const result = await pool.query(
          `WITH previous AS (
             SELECT value FROM cache_meta WHERE key = $1
           ), claim AS (
             INSERT INTO cache_meta AS current (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
             WHERE CASE WHEN current.value ~ '^[0-9]+$'
               THEN current.value::numeric <= $3::numeric ELSE FALSE END
             RETURNING TRUE AS claimed
           )
           SELECT EXISTS (SELECT 1 FROM claim) AS claimed,
             (SELECT value FROM previous) AS previous_value`,
          [META_KEY, String(nextAttempt), String(oldestThrottledAttempt)]
        );
        const row = result.rows[0];
        if (!row) throw new Error(THROTTLE_ERROR);
        if (row.previous_value !== null) parseTimestamp(row.previous_value);
        return row.claimed === true;
      } catch {
        throw new Error(THROTTLE_ERROR);
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
