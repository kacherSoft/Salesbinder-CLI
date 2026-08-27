import { createHash, randomUUID } from 'node:crypto';
import type { SalesBinderClient } from '../resources/index.js';
import type { CategoryListResponse, CategoryPaginationValue } from '../types/categories.types.js';
import type { CacheService } from './cache.interface.js';
import type { CategoryCacheMeta, CategoryCacheRow, CategorySnapshot } from './types.js';
import { CACHE_SCHEMA_VERSION, MAX_CATEGORY_COUNT, MAX_CATEGORY_PAGES } from './types.js';

export interface CategorySyncResult {
  categoriesProcessed: number;
  snapshot: CategorySnapshot;
}

type FingerprintMeta = Omit<CategoryCacheMeta, 'fingerprint'>;

export class CategoryIndexerService {
  private readonly accountIdentity: string;

  constructor(
    private readonly client: SalesBinderClient,
    private readonly cache: CacheService,
    accountIdentity: string,
  ) {
    if (!accountIdentity.trim()) throw new Error('Category sync requires a non-empty account identity');
    if (accountIdentity !== accountIdentity.trim()) throw new Error('Category sync requires a normalized account identity');
    this.accountIdentity = accountIdentity;
  }

  async sync(): Promise<CategorySyncResult> {
    const cacheState = await this.cache.getCacheState();
    if (cacheState?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(`Category sync requires cache state schema version ${CACHE_SCHEMA_VERSION}`);
    }
    const startedAt = nowSeconds();
    const first = await this.fetchPage(1);
    const count = parsePagination(first.count, 'count', 1, MAX_CATEGORY_COUNT);
    const page = parsePagination(first.page, 'page', 1, MAX_CATEGORY_PAGES);
    const pages = parsePagination(first.pages, 'pages', 1, MAX_CATEGORY_PAGES);
    if (page !== 1) throw new Error(`Invalid category page 1: response page was ${page}`);

    const rawRows = [...readPageRows(first, 1)];
    validatePageShape(count, pages, rawRows.length, 1);
    for (let requestedPage = 2; requestedPage <= pages; requestedPage++) {
      const response = await this.fetchPage(requestedPage);
      const responseCount = parsePagination(response.count, 'count', requestedPage, MAX_CATEGORY_COUNT);
      const responsePage = parsePagination(response.page, 'page', requestedPage, MAX_CATEGORY_PAGES);
      const responsePages = parsePagination(response.pages, 'pages', requestedPage, MAX_CATEGORY_PAGES);
      if (responsePage !== requestedPage) {
        throw new Error(`Invalid category page ${requestedPage}: response page was ${responsePage}`);
      }
      if (responseCount !== count || responsePages !== pages) {
        throw new Error(`Invalid category page ${requestedPage}: count/pages changed during pagination`);
      }
      const pageRows = readPageRows(response, requestedPage);
      validatePageShape(count, pages, pageRows.length, requestedPage);
      rawRows.push(...pageRows);
    }
    if (rawRows.length !== count) {
      throw new Error(`Invalid category snapshot: expected ${count} rows but fetched ${rawRows.length}`);
    }

    const completedAt = nowSeconds();
    const rows = normalizeRows(rawRows, completedAt);
    const generation = randomUUID();
    const metaWithoutFingerprint: FingerprintMeta = {
      version: 1,
      status: 'complete',
      accountIdentity: this.accountIdentity,
      startedAt,
      completedAt,
      count,
      page: count === 0 ? 1 : pages,
      pages,
      sourceRowCount: rawRows.length,
      storedRowCount: rows.length,
      schemaVersion: CACHE_SCHEMA_VERSION,
      generation,
    };
    const snapshot: CategorySnapshot = {
      rows,
      meta: {
        ...metaWithoutFingerprint,
        fingerprint: createCategoryFingerprint(metaWithoutFingerprint, rows, cacheState.schemaVersion),
      },
    };
    await this.cache.replaceCategorySnapshot(snapshot);
    return { categoriesProcessed: rows.length, snapshot };
  }

  private fetchPage(page: number): Promise<CategoryListResponse> {
    return this.client.categories.list({ page });
  }
}

export function createCategoryFingerprint(
  meta: FingerprintMeta,
  rows: CategoryCacheRow[],
  cacheStateSchemaVersion: number,
): string {
  const sortedRows = [...rows].sort((left, right) => left.category_id < right.category_id ? -1 : left.category_id > right.category_id ? 1 : 0);
  const input = [
    meta.accountIdentity, meta.schemaVersion, cacheStateSchemaVersion, meta.generation,
    meta.count, meta.page, meta.pages, meta.sourceRowCount, meta.storedRowCount,
    ...sortedRows.map((row) => [
      row.category_id, row.name, row.item_count, row.parent_id, row.parent_name,
      row.created, row.modified, row.cache_source, row.imported_at,
    ]),
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function parsePagination(value: CategoryPaginationValue | undefined, field: string, page: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid category page ${page}: ${field} must be a non-negative safe integer`);
  }
  if (parsed > max) throw new Error(`Invalid category page ${page}: ${field} exceeds maximum ${max}`);
  return parsed;
}

function readPageRows(response: CategoryListResponse, page: number): unknown[] {
  if (!Array.isArray(response.categories)) {
    throw new Error(`Invalid category page ${page}: categories must be an array`);
  }
  if (response.categories.some(Array.isArray)) {
    if (!response.categories.every(Array.isArray)) {
      throw new Error(`Invalid category page ${page}: mixed nested category array shape`);
    }
    return (response.categories as unknown as unknown[][]).flat();
  }
  return response.categories;
}

function validatePageShape(count: number, pages: number, rowCount: number, page: number): void {
  if (count === 0) {
    if (page !== 1 || rowCount !== 0 || (pages !== 0 && pages !== 1)) {
      throw new Error('Invalid category snapshot: incoherent zero pagination');
    }
    return;
  }
  if (pages < 1) throw new Error('Invalid category snapshot: non-zero count requires at least one page');
  if (rowCount === 0) throw new Error(`Invalid category page ${page}: non-zero snapshot page cannot be empty`);
}

function normalizeRows(rawRows: unknown[], importedAt: number): CategoryCacheRow[] {
  const seen = new Set<string>();
  const rows = rawRows.map((raw, index) => normalizeRow(raw, importedAt, index));
  for (const row of rows) {
    if (seen.has(row.category_id)) throw new Error(`Invalid category snapshot: duplicate id ${row.category_id}`);
    seen.add(row.category_id);
  }
  const names = new Map(rows.map((row) => [row.category_id, row.name]));
  return rows.map((row) => ({ ...row, parent_name: row.parent_id ? names.get(row.parent_id) ?? null : null }));
}

function normalizeRow(raw: unknown, importedAt: number, index: number): CategoryCacheRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid category row ${index + 1}: expected an object`);
  }
  const value = raw as Record<string, unknown>;
  const categoryId = requiredText(value.id, 'id', index);
  const name = requiredText(value.name, 'name', index);
  const parentId = nullableText(value.parent_id, 'parent_id', index);
  return {
    category_id: categoryId,
    name,
    item_count: nullableSafeInteger(value.item_count, 'item_count', index),
    parent_id: parentId,
    parent_name: null,
    created: nullableText(value.created, 'created', index),
    modified: nullableTimestamp(value.modified, index),
    cache_source: 'api',
    imported_at: importedAt,
  };
}

function requiredText(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid category row ${index + 1}: ${field} must be non-empty text without NUL bytes`);
  }
  return value.trim();
}

function nullableText(value: unknown, field: string, index: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid category row ${index + 1}: ${field} must be text without NUL bytes or null`);
  }
  return value.trim();
}

function nullableSafeInteger(value: unknown, field: string, index: number): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid category row ${index + 1}: ${field} must be a non-negative safe integer or null`);
  return parsed;
}

function nullableTimestamp(value: unknown, index: number): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error(`Invalid category row ${index + 1}: modified must be a timestamp or null`);
  if (/^\d+$/.test(value.trim())) return nullableSafeInteger(value, 'modified', index);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid category row ${index + 1}: modified must be a timestamp or null`);
  return Math.floor(timestamp / 1000);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
