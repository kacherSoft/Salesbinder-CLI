import { createHash, randomUUID } from 'node:crypto';
import type {
  CategoryCustomField,
  CategoryListResponse,
  CategoryPaginationValue,
} from '../types/categories.types.js';
import type { CacheService } from './cache.interface.js';
import type { CacheSyncProgress, CacheSyncProgressCallback } from './cache-sync-progress.types.js';
import type { CategoryCacheMeta, CategoryCacheRow, CategorySnapshot } from './types.js';
import { CACHE_SCHEMA_VERSION, MAX_CATEGORY_COUNT, MAX_CATEGORY_PAGES } from './types.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

const MAX_SOURCE_ID_LENGTH = 256;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface CategorySyncResult {
  categoriesProcessed: number;
  snapshot: CategorySnapshot;
}

export interface CategorySyncOptions {
  onProgressEvent?: CacheSyncProgressCallback;
}

interface CategoryListClient {
  categories: { list(params?: { page?: number }): Promise<CategoryListResponse> };
}

type FingerprintMeta = Omit<CategoryCacheMeta, 'fingerprint'>;

interface FetchedCategorySnapshot {
  count: number;
  pages: number;
  rawRows: unknown[];
}

type CategoryProgress = Omit<CacheSyncProgress, 'phase' | 'apiVersion'>;

export class CategoryIndexerService {
  private readonly accountIdentity: string;

  constructor(
    private readonly client: CategoryListClient,
    private readonly cache: CacheService,
    accountIdentity: string,
    private readonly sourceApiVersion: '2.0' | '3' = '2.0'
  ) {
    if (!accountIdentity.trim())
      throw new Error('Category sync requires a non-empty account identity');
    if (accountIdentity !== accountIdentity.trim())
      throw new Error('Category sync requires a normalized account identity');
    if (hasUnpairedUtf16Surrogate(accountIdentity))
      throw new Error('Category sync requires a well-formed account identity');
    this.accountIdentity = accountIdentity;
  }

  async sync(options: CategorySyncOptions = {}): Promise<CategorySyncResult> {
    const cacheState = await this.cache.getCacheState();
    if (cacheState?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error(`Category sync requires cache state schema version ${CACHE_SCHEMA_VERSION}`);
    }
    this.emit(options.onProgressEvent, {
      event: 'phase_started',
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    const startedAt = nowSeconds();
    let sourceSnapshot = await this.fetchPass(1, options.onProgressEvent);
    if (this.sourceApiVersion === '3') {
      const firstFingerprint = createSourceStabilityFingerprint(
        sourceSnapshot,
        this.sourceApiVersion
      );
      this.emitPassCompleted(options.onProgressEvent, 1, sourceSnapshot);
      sourceSnapshot = await this.fetchPass(2, options.onProgressEvent);
      const secondFingerprint = createSourceStabilityFingerprint(
        sourceSnapshot,
        this.sourceApiVersion
      );
      this.emitPassCompleted(options.onProgressEvent, 2, sourceSnapshot);
      if (firstFingerprint !== secondFingerprint) {
        throw new Error('V3 category source changed during stability verification');
      }
    } else {
      createSourceStabilityFingerprint(sourceSnapshot, this.sourceApiVersion);
      this.emitPassCompleted(options.onProgressEvent, 1, sourceSnapshot);
    }
    const completedAt = nowSeconds();
    const rows = normalizeRows(sourceSnapshot.rawRows, completedAt, this.sourceApiVersion);
    const generation = randomUUID();
    const metaWithoutFingerprint: FingerprintMeta = {
      version: 1,
      status: 'complete',
      accountIdentity: this.accountIdentity,
      startedAt,
      completedAt,
      count: sourceSnapshot.count,
      page: sourceSnapshot.count === 0 ? 1 : sourceSnapshot.pages,
      pages: sourceSnapshot.pages,
      sourceRowCount: sourceSnapshot.rawRows.length,
      storedRowCount: rows.length,
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceApiVersion: this.sourceApiVersion,
      generation,
    };
    const snapshot: CategorySnapshot = {
      rows,
      meta: {
        ...metaWithoutFingerprint,
        fingerprint: createCategoryFingerprint(
          metaWithoutFingerprint,
          rows,
          cacheState.schemaVersion
        ),
      },
    };
    await this.cache.replaceCategorySnapshot(snapshot);
    this.emit(options.onProgressEvent, {
      event: 'phase_completed',
      recordsProcessed: rows.length,
      recordsTotal: sourceSnapshot.count,
      indeterminate: false,
    });
    return { categoriesProcessed: rows.length, snapshot };
  }

  private async fetchPass(
    pass: number,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<FetchedCategorySnapshot> {
    this.emit(onProgressEvent, {
      event: 'pass_started',
      pass,
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    return this.fetchCompleteSnapshot(pass, onProgressEvent);
  }

  private async fetchCompleteSnapshot(
    pass: number,
    onProgressEvent?: CacheSyncProgressCallback
  ): Promise<FetchedCategorySnapshot> {
    this.emit(onProgressEvent, {
      event: 'page_started',
      pass,
      page: 1,
      pagesTotal: null,
      recordsProcessed: 0,
      recordsTotal: null,
      indeterminate: true,
    });
    const first = await this.fetchPage(1);
    const count = parsePagination(first.count, 'count', 1, MAX_CATEGORY_COUNT);
    const page = parsePagination(first.page, 'page', 1, MAX_CATEGORY_PAGES);
    const pages = parsePagination(first.pages, 'pages', 1, MAX_CATEGORY_PAGES);
    if (page !== 1) throw new Error(`Invalid category page 1: response page was ${page}`);

    const rawRows = [...readPageRows(first, 1)];
    validatePageShape(count, pages, rawRows.length, 1);
    this.emitProcessedRows(onProgressEvent, pass, 1, pages, count, 0, rawRows.length);
    this.emit(onProgressEvent, {
      event: 'page_completed',
      pass,
      page: 1,
      pagesTotal: pages,
      recordsProcessed: rawRows.length,
      recordsTotal: count,
      indeterminate: false,
    });
    for (let requestedPage = 2; requestedPage <= pages; requestedPage++) {
      this.emit(onProgressEvent, {
        event: 'page_started',
        pass,
        page: requestedPage,
        pagesTotal: pages,
        recordsProcessed: rawRows.length,
        recordsTotal: count,
        indeterminate: false,
      });
      const response = await this.fetchPage(requestedPage);
      const responseCount = parsePagination(
        response.count,
        'count',
        requestedPage,
        MAX_CATEGORY_COUNT
      );
      const responsePage = parsePagination(
        response.page,
        'page',
        requestedPage,
        MAX_CATEGORY_PAGES
      );
      const responsePages = parsePagination(
        response.pages,
        'pages',
        requestedPage,
        MAX_CATEGORY_PAGES
      );
      if (responsePage !== requestedPage) {
        throw new Error(
          `Invalid category page ${requestedPage}: response page was ${responsePage}`
        );
      }
      if (responseCount !== count || responsePages !== pages) {
        throw new Error(
          `Invalid category page ${requestedPage}: count/pages changed during pagination`
        );
      }
      const pageRows = readPageRows(response, requestedPage);
      validatePageShape(count, pages, pageRows.length, requestedPage);
      const processedBeforePage = rawRows.length;
      rawRows.push(...pageRows);
      this.emitProcessedRows(
        onProgressEvent,
        pass,
        requestedPage,
        pages,
        count,
        processedBeforePage,
        pageRows.length
      );
      this.emit(onProgressEvent, {
        event: 'page_completed',
        pass,
        page: requestedPage,
        pagesTotal: pages,
        recordsProcessed: rawRows.length,
        recordsTotal: count,
        indeterminate: false,
      });
    }
    if (rawRows.length !== count) {
      throw new Error(
        `Invalid category snapshot: expected ${count} rows but fetched ${rawRows.length}`
      );
    }
    return { count, pages, rawRows };
  }

  private emitProcessedRows(
    callback: CacheSyncProgressCallback | undefined,
    pass: number,
    page: number,
    pagesTotal: number,
    recordsTotal: number,
    processedBeforePage: number,
    pageCount: number
  ): void {
    for (let index = 1; index <= pageCount; index++) {
      this.emit(callback, {
        event: 'record_processed',
        pass,
        page,
        pagesTotal,
        recordsProcessed: processedBeforePage + index,
        recordsTotal,
        indeterminate: false,
      });
    }
  }

  private emitPassCompleted(
    callback: CacheSyncProgressCallback | undefined,
    pass: number,
    snapshot: FetchedCategorySnapshot
  ): void {
    this.emit(callback, {
      event: 'pass_completed',
      pass,
      pagesTotal: snapshot.pages,
      recordsProcessed: snapshot.rawRows.length,
      recordsTotal: snapshot.count,
      indeterminate: false,
    });
  }

  private emit(callback: CacheSyncProgressCallback | undefined, progress: CategoryProgress): void {
    callback?.({ phase: 'categories', apiVersion: this.sourceApiVersion, ...progress });
  }

  private fetchPage(page: number): Promise<CategoryListResponse> {
    return this.client.categories.list({ page });
  }
}

function createSourceStabilityFingerprint(
  snapshot: FetchedCategorySnapshot,
  sourceApiVersion: '2.0' | '3'
): string {
  const rows = normalizeRows(snapshot.rawRows, 0, sourceApiVersion)
    .sort((left, right) => compareCodeUnitStrings(left.category_id, right.category_id))
    .map((row) => [
      row.category_id,
      row.name,
      row.item_count,
      row.parent_id,
      row.parent_name,
      row.inventory_type,
      row.custom_fields_json,
      row.created,
      row.modified,
    ]);
  return createHash('sha256')
    .update(JSON.stringify([snapshot.count, snapshot.pages, rows]))
    .digest('hex');
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function createCategoryFingerprint(
  meta: FingerprintMeta,
  rows: CategoryCacheRow[],
  cacheStateSchemaVersion: number
): string {
  const sortedRows = [...rows].sort((left, right) =>
    compareCodeUnitStrings(left.category_id, right.category_id)
  );
  const input = [
    meta.accountIdentity,
    meta.schemaVersion,
    cacheStateSchemaVersion,
    meta.sourceApiVersion,
    meta.generation,
    meta.count,
    meta.page,
    meta.pages,
    meta.sourceRowCount,
    meta.storedRowCount,
    ...sortedRows.map((row) => [
      row.category_id,
      row.name,
      row.item_count,
      row.parent_id,
      row.parent_name,
      row.inventory_type,
      row.custom_fields_json,
      row.created,
      row.modified,
      row.cache_source,
      row.source_api_version,
      row.imported_at,
    ]),
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function parsePagination(
  value: CategoryPaginationValue | undefined,
  field: string,
  page: number,
  max: number
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid category page ${page}: ${field} must be a non-negative safe integer`);
  }
  if (parsed > max)
    throw new Error(`Invalid category page ${page}: ${field} exceeds maximum ${max}`);
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
  if (pages < 1)
    throw new Error('Invalid category snapshot: non-zero count requires at least one page');
  if (rowCount === 0)
    throw new Error(`Invalid category page ${page}: non-zero snapshot page cannot be empty`);
}

function normalizeRows(
  rawRows: unknown[],
  importedAt: number,
  sourceApiVersion: '2.0' | '3'
): CategoryCacheRow[] {
  const seen = new Set<string>();
  const rows = rawRows.map((raw, index) => normalizeRow(raw, importedAt, index, sourceApiVersion));
  for (const row of rows) {
    if (seen.has(row.category_id))
      throw new Error(`Invalid category snapshot: duplicate id ${row.category_id}`);
    seen.add(row.category_id);
  }
  const names = new Map(rows.map((row) => [row.category_id, row.name]));
  return rows.map((row) => ({
    ...row,
    parent_name: row.parent_id ? (names.get(row.parent_id) ?? null) : null,
  }));
}

function normalizeRow(
  raw: unknown,
  importedAt: number,
  index: number,
  sourceApiVersion: '2.0' | '3'
): CategoryCacheRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid category row ${index + 1}: expected an object`);
  }
  const value = raw as Record<string, unknown>;
  if (sourceApiVersion === '3' && value.object !== 'item_category') {
    throw new Error(`Invalid category row ${index + 1}: object must be item_category`);
  }
  const categoryId =
    sourceApiVersion === '3'
      ? requiredCanonicalSourceId(value.id, 'id', index)
      : requiredText(value.id, 'id', index);
  const name = requiredText(value.name, 'name', index);
  const parentId =
    sourceApiVersion === '3'
      ? nullableCanonicalSourceId(value.parent_id, 'parent_id', index)
      : nullableText(value.parent_id, 'parent_id', index);
  const inventoryType = nullableInventoryType(value.inventory_type, index);
  const customFields = normalizeCustomFields(value.custom_fields, index, sourceApiVersion);
  return {
    category_id: categoryId,
    name,
    item_count: nullablePostgresInteger(value.item_count, 'item_count', index),
    parent_id: parentId,
    parent_name: null,
    inventory_type: inventoryType,
    custom_fields_json: customFields == null ? null : JSON.stringify(customFields),
    created: nullableText(value.created, 'created', index),
    modified: nullableTimestamp(value.modified, index),
    cache_source: 'api',
    source_api_version: sourceApiVersion,
    imported_at: importedAt,
  };
}

function nullableInventoryType(value: unknown, index: number): 'quantity' | 'unique' | null {
  if (value == null || value === '') return null;
  if (value !== 'quantity' && value !== 'unique') {
    throw new Error(
      `Invalid category row ${index + 1}: inventory_type must be quantity, unique, or null`
    );
  }
  return value;
}

function normalizeCustomFields(
  value: unknown,
  index: number,
  sourceApiVersion: '2.0' | '3'
): CategoryCustomField[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid category row ${index + 1}: custom_fields must be an array or null`);
  }
  return value.map((raw, fieldIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `Invalid category row ${index + 1}: custom field ${fieldIndex + 1} must be an object`
      );
    }
    const field = raw as Record<string, unknown>;
    const displayOrder = field.display_order;
    if (!Number.isSafeInteger(displayOrder) || (displayOrder as number) < 0) {
      throw new Error(
        `Invalid category row ${index + 1}: custom field display_order must be a non-negative integer`
      );
    }
    if (
      typeof field.display_on_inventory_list !== 'boolean' ||
      typeof field.publish_on_documents !== 'boolean'
    ) {
      throw new Error(`Invalid category row ${index + 1}: custom field flags must be boolean`);
    }
    return {
      id:
        sourceApiVersion === '3'
          ? requiredCanonicalSourceId(field.id, 'custom_field.id', index)
          : requiredText(field.id, 'custom_field.id', index),
      name: requiredText(field.name, 'custom_field.name', index),
      display_order: displayOrder as number,
      display_on_inventory_list: field.display_on_inventory_list,
      publish_on_documents: field.publish_on_documents,
    };
  });
}

function requiredText(value: unknown, field: string, index: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error(
      `Invalid category row ${index + 1}: ${field} must be non-empty text without NUL bytes`
    );
  }
  return value.trim();
}

function requiredCanonicalSourceId(value: unknown, field: string, index: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > MAX_SOURCE_ID_LENGTH ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error(`Invalid category row ${index + 1}: ${field} must be a canonical source ID`);
  }
  return value;
}

function nullableCanonicalSourceId(value: unknown, field: string, index: number): string | null {
  if (value === null) return null;
  return requiredCanonicalSourceId(value, field, index);
}

function nullableText(value: unknown, field: string, index: number): string | null {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error(
      `Invalid category row ${index + 1}: ${field} must be text without NUL bytes or null`
    );
  }
  return value.trim();
}

function nullableSafeInteger(value: unknown, field: string, index: number): number | null {
  if (value == null || value === '') return null;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(
      `Invalid category row ${index + 1}: ${field} must be a non-negative safe integer or null`
    );
  return parsed;
}

function nullablePostgresInteger(value: unknown, field: string, index: number): number | null {
  const parsed = nullableSafeInteger(value, field, index);
  if (parsed !== null && parsed > POSTGRES_INTEGER_MAX) {
    throw new Error(
      `Invalid category row ${index + 1}: ${field} must fit a non-negative PostgreSQL INTEGER or be null`
    );
  }
  return parsed;
}

function nullableTimestamp(value: unknown, index: number): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string')
    throw new Error(`Invalid category row ${index + 1}: modified must be a timestamp or null`);
  if (/^\d+$/.test(value.trim())) return nullableSafeInteger(value, 'modified', index);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid category row ${index + 1}: modified must be a timestamp or null`);
  return Math.floor(timestamp / 1000);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
