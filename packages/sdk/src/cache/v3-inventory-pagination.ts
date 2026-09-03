import type { V3ListResponse } from '../types/items.types.js';
import { assertCanonicalV3SourceId } from './v3-inventory-source-validation.js';

const MAX_PAGES = 10_000;
const MAX_RECORDS = 1_000_000;

export interface V3PageProgressHooks {
  onPageStarted(
    page: number,
    pagesTotal: number | null,
    recordsProcessed: number,
    recordsTotal: number | null
  ): void;
  onPageCompleted(
    page: number,
    pagesTotal: number,
    recordsProcessed: number,
    recordsTotal: number
  ): void;
}

/** Canonical pagination layout observed after a complete, validated source pass. */
export interface V3PaginationSignature {
  per_page: number;
  total_pages: number;
  total_records: number;
  page_sizes: readonly number[];
}

export interface V3PageSnapshot<T> {
  rows: T[];
  signature: V3PaginationSignature;
}

export async function fetchAllV3Pages<T extends { id: string }>(
  fetchPage: (page: number) => Promise<V3ListResponse<T>>,
  label: string,
  invalid: (message: string) => Error,
  hooks?: V3PageProgressHooks
): Promise<T[]> {
  return (await fetchAllV3PageSnapshot(fetchPage, label, invalid, hooks)).rows;
}

export async function fetchAllV3PageSnapshot<T extends { id: string }>(
  fetchPage: (page: number) => Promise<V3ListResponse<T>>,
  label: string,
  invalid: (message: string) => Error,
  hooks?: V3PageProgressHooks
): Promise<V3PageSnapshot<T>> {
  const rows: T[] = [];
  const pageSizes: number[] = [];
  const ids = new Set<string>();
  let expectedTotal: number | null = null;
  let expectedPages: number | null = null;
  let expectedPageSize: number | null = null;
  for (let page = 1; page <= (expectedPages ?? 1); page++) {
    hooks?.onPageStarted(page, expectedPages, rows.length, expectedTotal);
    const response = await fetchPage(page);
    validatePage(response, page, label, invalid);
    const { total_pages: pages, total_records: total } = response.pagination;
    if (pages > MAX_PAGES || total > MAX_RECORDS) {
      throw invalid(`V3 ${label} snapshot exceeds safety bounds`);
    }
    if (expectedTotal == null) {
      expectedTotal = total;
      expectedPages = pages;
      expectedPageSize = response.pagination.per_page;
    } else if (
      expectedTotal !== total ||
      expectedPages !== pages ||
      expectedPageSize !== response.pagination.per_page
    ) {
      throw invalid(`V3 ${label} pagination changed during snapshot`);
    }
    pageSizes.push(response.data.length);
    for (const row of response.data) {
      assertCanonicalV3SourceId(row?.id, `${label} row`, invalid);
      if (ids.has(row.id)) throw invalid(`Duplicate v3 ${label} ID`);
      ids.add(row.id);
      rows.push(row);
    }
    hooks?.onPageCompleted(page, pages, rows.length, total);
  }
  if (rows.length !== (expectedTotal ?? 0)) {
    throw invalid(
      `Incomplete v3 ${label} snapshot: expected ${expectedTotal ?? 0}, received ${rows.length}`
    );
  }
  if (expectedTotal == null || expectedPages == null || expectedPageSize == null) {
    throw invalid(`V3 ${label} pagination was not observed`);
  }
  return {
    rows,
    signature: {
      per_page: expectedPageSize,
      total_pages: expectedPages,
      total_records: expectedTotal,
      page_sizes: pageSizes,
    },
  };
}

export function sameV3PaginationSignature(
  left: V3PaginationSignature,
  right: V3PaginationSignature
): boolean {
  return (
    left.per_page === right.per_page &&
    left.total_pages === right.total_pages &&
    left.total_records === right.total_records &&
    left.page_sizes.length === right.page_sizes.length &&
    left.page_sizes.every((size, index) => size === right.page_sizes[index])
  );
}

function validatePage<T>(
  response: V3ListResponse<T>,
  page: number,
  label: string,
  invalid: (message: string) => Error
): void {
  if (!isRecord(response) || response.object !== 'list' || !Array.isArray(response.data)) {
    throw invalid(`Invalid v3 ${label} list envelope`);
  }
  const pagination = response.pagination;
  if (!isRecord(pagination) || pagination.page !== page) {
    throw invalid(`Invalid v3 ${label} page ${page}`);
  }
  for (const value of [
    pagination.page,
    pagination.per_page,
    pagination.total_pages,
    pagination.total_records,
  ]) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw invalid(`Invalid v3 ${label} pagination`);
    }
  }
  if (pagination.page < 1 || pagination.per_page < 1) {
    throw invalid(`Invalid v3 ${label} page size`);
  }
  const shouldHaveMore = page < pagination.total_pages;
  if (response.has_more !== shouldHaveMore) {
    throw invalid(`Invalid v3 ${label} has_more on page ${page}`);
  }
  if (pagination.total_records > 0 && pagination.total_pages < 1) {
    throw invalid(`Invalid v3 ${label} non-empty pagination`);
  }
  if (response.data.length > pagination.per_page) {
    throw invalid(`Invalid v3 ${label} page size`);
  }
  if (pagination.total_pages > 0 && page > pagination.total_pages) {
    throw invalid(`Invalid v3 ${label} page range`);
  }
  if (response.has_more && response.data.length === 0) {
    throw invalid(`Invalid v3 ${label} empty intermediate page`);
  }
  const expectedPages =
    pagination.total_records === 0
      ? pagination.total_pages
      : Math.ceil(pagination.total_records / pagination.per_page);
  if (
    (pagination.total_records === 0 &&
      pagination.total_pages !== 0 &&
      pagination.total_pages !== 1) ||
    (pagination.total_records > 0 && pagination.total_pages !== expectedPages)
  ) {
    throw invalid(`Invalid v3 ${label} total pages`);
  }
  const expectedRows =
    pagination.total_records === 0
      ? 0
      : page < pagination.total_pages
        ? pagination.per_page
        : pagination.total_records - (pagination.total_pages - 1) * pagination.per_page;
  if (response.data.length !== expectedRows) {
    throw invalid(`Incomplete v3 ${label} page ${page}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
