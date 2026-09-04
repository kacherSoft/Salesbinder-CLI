import pg, { type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { ChangeFeedRepositoryError, translateChangeFeedError } from './change-feed.errors.js';
import type { PostgresChangeFeedRepositoryOptions } from './change-feed.types.js';

const { Pool: PostgresPool } = pg;

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code?.startsWith('08') === true ||
    [
      '57P01',
      '57P02',
      '57P03',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
    ].includes(code ?? '');
}

export class PostgresChangeFeedQueryRunner {
  readonly #pool: Pool;
  readonly #closePool: boolean;
  readonly #active = new Set<Promise<unknown>>();
  readonly #onIdleClientError: () => void;
  #state: 'open' | 'closing' | 'closed' = 'open';
  #closePromise?: Promise<void>;

  constructor(options: PostgresChangeFeedRepositoryOptions) {
    if ('pool' in options && options.pool !== undefined) {
      this.#pool = options.pool;
      this.#closePool = options.closeInjectedPoolOnClose === true;
    } else {
      this.#pool = new PostgresPool({
        connectionString: options.databaseUrl,
        application_name: 'salesbinder-cli-change-feed',
        max: options.maxConnections ?? 4,
        connectionTimeoutMillis: options.connectionTimeoutMs ?? 3_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: options.statementTimeoutMs ?? 8_000,
        ssl: options.ssl ?? false,
      });
      this.#closePool = true;
    }
    this.#onIdleClientError = () => {
      try {
        options.onIdleClientError?.();
      } catch {
        // Observability callbacks must not turn an idle socket failure into an uncaught error.
      }
    };
    this.#pool.on('error', this.#onIdleClientError);
  }

  query<Row extends QueryResultRow>(
    sql: string,
    values: readonly unknown[],
    operationSignal?: AbortSignal
  ): Promise<Row[]> {
    if (this.#state !== 'open') {
      return Promise.reject(
        new ChangeFeedRepositoryError('closed', 'Change-feed repository is closed')
      );
    }
    const operation = this.#queryWithCheckedOutClient<Row>(sql, values, operationSignal);
    this.#active.add(operation);
    void operation.finally(() => this.#active.delete(operation)).catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#active]);
      if (this.#closePool) {
        try {
          await this.#pool.end();
        } catch (error) {
          throw translateChangeFeedError(error);
        } finally {
          this.#pool.removeListener('error', this.#onIdleClientError);
          this.#state = 'closed';
        }
      } else {
        this.#pool.removeListener('error', this.#onIdleClientError);
        this.#state = 'closed';
      }
    })();
    return this.#closePromise;
  }

  async #queryWithCheckedOutClient<Row extends QueryResultRow>(
    sql: string,
    values: readonly unknown[],
    operationSignal?: AbortSignal
  ): Promise<Row[]> {
    if (operationSignal?.aborted) throw translateChangeFeedError(abortSignalReason(operationSignal));
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw translateChangeFeedError(error);
    }

    let connectionFailed = false;
    let clientReleased = false;
    let operationError: unknown;
    const onClientError = (error: unknown): void => {
      connectionFailed = true;
      operationError ??= error;
    };
    client.on('error', onClientError);
    const cancelOperation = (): void => {
      connectionFailed = true;
      operationError ??= abortSignalReason(operationSignal);
      if (clientReleased) return;
      clientReleased = true;
      try {
        // Destroying the checked-out connection makes PostgreSQL abort the active
        // statement/transaction; rejecting a JavaScript race alone does not.
        client.release(true);
      } catch {
        // The original fence-loss error remains authoritative.
      }
    };
    operationSignal?.addEventListener('abort', cancelOperation, { once: true });
    if (operationSignal?.aborted) cancelOperation();
    let rows: Row[] | undefined;
    try {
      const result = await client.query<Row>(sql, [...values]);
      rows = result.rows;
      if (connectionFailed) {
        operationError ??= new Error('checked_out_connection_lost');
      }
    } catch (error) {
      operationError = error;
      connectionFailed ||= isConnectionFailure(error);
    } finally {
      operationSignal?.removeEventListener('abort', cancelOperation);
      client.removeListener('error', onClientError);
      if (!clientReleased) {
        try {
          client.release(connectionFailed);
          clientReleased = true;
        } catch (releaseError) {
          operationError ??= releaseError;
        }
      }
    }

    if (operationError !== undefined) throw translateChangeFeedError(operationError);
    if (rows === undefined) {
      throw new ChangeFeedRepositoryError(
        'invalid_response',
        'Change-feed database returned no query result'
      );
    }
    return rows;
  }
}

function abortSignalReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Change-feed database operation was aborted');
  error.name = 'AbortError';
  return error;
}
