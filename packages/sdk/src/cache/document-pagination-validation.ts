import type { Document, DocumentListResponse } from '../types/documents.types.js';

const MAX_DOCUMENT_PAGES = 10_000;
const MAX_DOCUMENT_RECORDS = 1_000_000;
const DOCUMENT_PAGE_LIMIT = 50;

export interface DocumentPaginationState {
  count: number;
  pages: number;
}

/** Bound legacy responses even when SalesBinder omits pagination metadata. */
export function assertDocumentScanBounds(requestedPage: number, cumulativeRecords: number): void {
  if (
    !Number.isSafeInteger(requestedPage) ||
    requestedPage < 1 ||
    requestedPage > MAX_DOCUMENT_PAGES ||
    !Number.isSafeInteger(cumulativeRecords) ||
    cumulativeRecords < 0 ||
    cumulativeRecords > MAX_DOCUMENT_RECORDS
  ) {
    throw new Error('Document snapshot exceeds safety bounds');
  }
}

export function validateDocumentPagination(
  response: DocumentListResponse,
  requestedPage: number,
  rowCount: number,
  previous: DocumentPaginationState | null | undefined
): DocumentPaginationState | null {
  assertDocumentScanBounds(requestedPage, rowCount);
  const values = [response.count, response.page, response.pages];
  const present = values.filter((value) => value !== undefined).length;
  if (present === 0) {
    if (previous && requestedPage > 1) throw new Error('Document pagination metadata disappeared');
    return null;
  }
  if (present !== values.length) throw new Error('Incomplete document pagination metadata');
  const count = parsePaginationInteger(response.count, 0);
  const page = parsePaginationInteger(response.page, 1);
  const pages = parsePaginationInteger(response.pages, 0);
  if (page !== requestedPage) throw new Error(`Invalid document page ${requestedPage}`);
  if (pages > MAX_DOCUMENT_PAGES || count > MAX_DOCUMENT_RECORDS) {
    throw new Error('Document snapshot exceeds safety bounds');
  }
  if ((count > 0 && pages < 1) || (pages > 0 && page > pages)) {
    throw new Error('Invalid document pagination range');
  }
  const expectedPages = count === 0 ? pages : Math.ceil(count / DOCUMENT_PAGE_LIMIT);
  if ((count === 0 && pages !== 0 && pages !== 1) || (count > 0 && pages !== expectedPages)) {
    throw new Error('Invalid document total pages');
  }
  const expectedRows =
    count === 0
      ? 0
      : page < pages
        ? DOCUMENT_PAGE_LIMIT
        : count - (pages - 1) * DOCUMENT_PAGE_LIMIT;
  if (rowCount !== expectedRows) throw new Error(`Incomplete document page ${page}`);
  if (previous === null && requestedPage > 1) {
    throw new Error('Document pagination metadata appeared after page one');
  }
  if (previous && (previous.count !== count || previous.pages !== pages)) {
    throw new Error('Document pagination changed during snapshot');
  }
  return { count, pages };
}

export function flattenDocumentArray(documents?: Document[][]): Document[] {
  if (!documents) return [];
  return Array.isArray(documents[0]) ? documents.flat() : (documents as unknown as Document[]);
}

function parsePaginationInteger(value: unknown, minimum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error('Invalid document pagination metadata');
  }
  return parsed;
}
