import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  REFERENCE_REFRESH_META_KEY,
  type ReferenceRefreshResource,
  type ReferenceRefreshResourceResult,
  type ReferenceRefreshStatus,
  type ReferenceRefreshStore,
} from './reference-refresh.types.js';

type QueryExecutor = Pick<PoolClient, 'query'>;

export interface PostgresReferenceRefreshStoreOptions {
  withVerifiedWrite<T>(run: (client: PoolClient) => Promise<T>): Promise<T>;
  withReadOnlyTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T>;
  accountIdentity(): string;
}

const ALL_RESOURCES: readonly ReferenceRefreshResource[] = [
  'categories',
  'accounts',
  'users',
  'payments',
] as const;

export class PostgresReferenceRefreshStore implements ReferenceRefreshStore {
  constructor(private readonly options: PostgresReferenceRefreshStoreOptions) {}

  async getStatus(accountIdentity: string): Promise<ReferenceRefreshStatus | null> {
    this.assertAccount(accountIdentity);
    return this.options.withReadOnlyTransaction((client) => this.readStatus(client));
  }

  async beginRun(
    accountIdentity: string,
    resources: readonly ReferenceRefreshResource[],
    ifStaleSeconds: number | undefined,
    now: number
  ): Promise<{ runId: string; skipped: boolean; status: ReferenceRefreshStatus }> {
    this.assertAccount(accountIdentity);
    validateResources(resources);
    return this.options.withVerifiedWrite(async (client) => {
      const current = await this.readStatus(client, true);
      if (ifStaleSeconds !== undefined && isFresh(current, resources, ifStaleSeconds, now)) {
        const skipped = mergeStatus(current, accountIdentity, now);
        skipped.run = {
          runId: randomUUID(),
          status: 'skipped',
          startedAt: now,
          finishedAt: now,
        };
        await writeStatus(client, skipped);
        return { runId: skipped.run.runId, skipped: true, status: skipped };
      }
      const runId = randomUUID();
      const next = mergeStatus(current, accountIdentity, now);
      next.run = { runId, status: 'running', startedAt: now };
      for (const resource of resources) {
        next.resources[resource] = {
          ...next.resources[resource],
          lastAttemptAt: now,
          outcome: 'failed',
          code: 'running',
          safeMessage: 'Reference refresh is running.',
        };
      }
      await writeStatus(client, next);
      return { runId, skipped: false, status: next };
    });
  }

  async finishRun(
    accountIdentity: string,
    runId: string,
    resources: readonly ReferenceRefreshResourceResult[],
    now: number
  ): Promise<ReferenceRefreshStatus> {
    this.assertAccount(accountIdentity);
    return this.options.withVerifiedWrite(async (client) => {
      const current = mergeStatus(await this.readStatus(client, true), accountIdentity, now);
      if (current.run?.runId !== runId) {
        throw new Error('Reference refresh status belongs to another run.');
      }
      for (const result of resources) {
        current.resources[result.resource] = {
          lastAttemptAt: result.lastAttemptAt,
          lastSuccessAt:
            result.outcome === 'success'
              ? (result.lastSuccessAt ?? result.lastAttemptAt)
              : current.resources[result.resource]?.lastSuccessAt,
          outcome: result.outcome,
          code: result.code,
          safeMessage: result.safeMessage,
          recordCount: result.recordCount,
        };
      }
      const failed = resources.some((result) => result.outcome === 'failed');
      const warnings = resources.some(
        (result) => result.outcome === 'warning' || result.outcome === 'skipped'
      );
      current.run = {
        ...current.run,
        status: failed ? 'failed' : warnings ? 'success_with_warnings' : 'success',
        finishedAt: now,
      };
      current.updatedAt = now;
      await writeStatus(client, current);
      return current;
    });
  }

  private assertAccount(accountIdentity: string): void {
    if (accountIdentity !== this.options.accountIdentity()) {
      throw new Error('Reference refresh account does not match the PostgreSQL cache binding.');
    }
  }

  private async readStatus(
    executor: QueryExecutor,
    forUpdate = false
  ): Promise<ReferenceRefreshStatus | null> {
    const row = (
      await executor.query<{ value: string }>(
        `SELECT value FROM cache_meta WHERE key = $1${forUpdate ? ' FOR UPDATE' : ''}`,
        [REFERENCE_REFRESH_META_KEY]
      )
    ).rows[0];
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      throw new Error('Reference refresh status is invalid.');
    }
    assertReferenceRefreshStatus(parsed);
    this.assertAccount(parsed.accountIdentity);
    return parsed;
  }
}

function mergeStatus(
  current: ReferenceRefreshStatus | null,
  accountIdentity: string,
  now: number
): ReferenceRefreshStatus {
  return {
    version: 1,
    accountIdentity,
    updatedAt: now,
    resources: Object.fromEntries(
      ALL_RESOURCES.map((resource) => [resource, current?.resources[resource] ?? {}])
    ) as ReferenceRefreshStatus['resources'],
    ...(current?.run ? { run: current.run } : {}),
  };
}

async function writeStatus(executor: QueryExecutor, status: ReferenceRefreshStatus): Promise<void> {
  await executor.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [REFERENCE_REFRESH_META_KEY, JSON.stringify(status)]
  );
}

function isFresh(
  status: ReferenceRefreshStatus | null,
  resources: readonly ReferenceRefreshResource[],
  ifStaleSeconds: number,
  now: number
): boolean {
  if (!status?.run || status.run.status === 'running' || status.run.status === 'failed') {
    return false;
  }
  const cutoff = now - ifStaleSeconds;
  return resources.every((resource) => {
    const state = status.resources[resource];
    const lastAttemptAt = state?.lastAttemptAt;
    return (
      Number.isSafeInteger(lastAttemptAt) &&
      Number(lastAttemptAt) >= cutoff &&
      (state.outcome === 'success' || state.outcome === 'skipped' || state.outcome === 'warning')
    );
  });
}

function validateResources(resources: readonly ReferenceRefreshResource[]): void {
  if (resources.length === 0) throw new Error('Reference refresh requires at least one resource.');
  const allowed = new Set(ALL_RESOURCES);
  if (!resources.every((resource) => allowed.has(resource))) {
    throw new Error('Reference refresh resource is invalid.');
  }
}

function assertReferenceRefreshStatus(value: unknown): asserts value is ReferenceRefreshStatus {
  if (!isRecord(value) || value.version !== 1) throw invalid();
  if (typeof value.accountIdentity !== 'string' || !value.accountIdentity.startsWith('salesbinder:')) {
    throw invalid();
  }
  if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) throw invalid();
  if (!isRecord(value.resources)) throw invalid();
  for (const resource of ALL_RESOURCES) assertResourceStatus(value.resources[resource]);
  if (value.run !== undefined) {
    if (!isRecord(value.run) || typeof value.run.runId !== 'string') throw invalid();
    if (!['running', 'success', 'success_with_warnings', 'failed', 'skipped'].includes(String(value.run.status))) {
      throw invalid();
    }
    if (!Number.isSafeInteger(value.run.startedAt) || Number(value.run.startedAt) < 0) {
      throw invalid();
    }
  }
}

function assertResourceStatus(value: unknown): void {
  if (!isRecord(value)) throw invalid();
  const status = value as Record<string, unknown>;
  if (
    status.outcome !== undefined &&
    !['success', 'warning', 'failed', 'skipped'].includes(String(status.outcome))
  ) {
    throw invalid();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): Error {
  return new Error('Reference refresh status is invalid.');
}
