import type { SalespersonDirectoryInput } from './salesperson-directory.js';
import type { CategoryListResponse } from '../types/categories.types.js';

export const REFERENCE_REFRESH_META_KEY = 'reference_refresh.v1';

export type ReferenceRefreshResource =
  | 'categories'
  | 'accounts'
  | 'users'
  | 'payments';

export type ReferenceRefreshOutcome = 'success' | 'warning' | 'failed' | 'skipped';

export interface ReferenceRefreshResourceStatus {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  outcome?: ReferenceRefreshOutcome;
  code?: string;
  safeMessage?: string;
  recordCount?: number;
}

export interface ReferenceRefreshRunStatus {
  runId: string;
  status: 'running' | 'success' | 'success_with_warnings' | 'failed' | 'skipped';
  startedAt: number;
  finishedAt?: number;
}

export interface ReferenceRefreshStatus {
  version: 1;
  accountIdentity: string;
  updatedAt: number;
  run?: ReferenceRefreshRunStatus;
  resources: Record<ReferenceRefreshResource, ReferenceRefreshResourceStatus>;
}

export interface ReferenceRefreshResourceResult extends ReferenceRefreshResourceStatus {
  resource: ReferenceRefreshResource;
  outcome: ReferenceRefreshOutcome;
  lastAttemptAt: number;
}

export interface ReferenceRefreshResult {
  status: ReferenceRefreshStatus;
  resources: ReferenceRefreshResourceResult[];
  skipped: boolean;
  coverage: 'references_only';
}

export interface ReferenceRefreshSyncOptions {
  accountIdentity: string;
  ifStaleSeconds?: number;
}

export interface ReferenceRefreshStore {
  getStatus(accountIdentity: string): Promise<ReferenceRefreshStatus | null>;
  beginRun(
    accountIdentity: string,
    resources: readonly ReferenceRefreshResource[],
    ifStaleSeconds: number | undefined,
    now: number
  ): Promise<{ runId: string; skipped: boolean; status: ReferenceRefreshStatus }>;
  finishRun(
    accountIdentity: string,
    runId: string,
    resources: readonly ReferenceRefreshResourceResult[],
    now: number
  ): Promise<ReferenceRefreshStatus>;
}

export interface ReferenceCategoryRefreshClient {
  categories: { list(params?: { page?: number; pageLimit?: number }): Promise<CategoryListResponse> };
}

export interface ReferenceUsersRefreshClient {
  listDirectoryUsers(): Promise<SalespersonDirectoryInput['users']>;
}
