import { UsersResource } from '../resources/users.resource.js';
import type { SalesBinderUser, SalesBinderUsersListResponse } from '../types/users.types.js';
import type { SalespersonDirectoryInput } from './salesperson-directory.js';

const MAX_USER_PAGES = 1_000;
const MAX_USER_COUNT = 100_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ReferenceUsersResource {
  constructor(private readonly users: UsersResource) {}

  async listDirectoryUsers(): Promise<SalespersonDirectoryInput['users']> {
    const first = await this.readPage(1);
    const state = parsePagination(first, 1);
    const rows = readUsers(first, 1);
    validatePageShape(state.count, state.pages, rows.length, 1);
    for (let page = 2; page <= state.pages; page++) {
      const response = await this.readPage(page);
      const next = parsePagination(response, page);
      if (next.count !== state.count || next.pages !== state.pages || next.page !== page) {
        throw new Error('SalesBinder users pagination changed during traversal.');
      }
      const pageRows = readUsers(response, page);
      validatePageShape(state.count, state.pages, pageRows.length, page);
      rows.push(...pageRows);
    }
    if (rows.length !== state.count) {
      throw new Error('SalesBinder users pagination ended before its declared count.');
    }
    return normalizeUsers(rows);
  }

  private readPage(page: number): Promise<SalesBinderUsersListResponse> {
    return this.users.list({ page, limit: 100 });
  }
}

function parsePagination(response: SalesBinderUsersListResponse, expectedPage: number) {
  const pagination = response.pagination ?? response;
  const page = parseInteger(pagination.page, 'page', expectedPage, MAX_USER_PAGES);
  const pages = parseInteger(pagination.pages, 'pages', expectedPage, MAX_USER_PAGES);
  const count = parseInteger(pagination.count, 'count', expectedPage, MAX_USER_COUNT);
  if (page !== expectedPage) throw new Error('SalesBinder users response returned wrong page.');
  return { page, pages, count };
}

function parseInteger(
  value: unknown,
  field: string,
  page: number,
  max: number
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid SalesBinder users page ${page}: ${field} is invalid.`);
  }
  return parsed;
}

function readUsers(response: SalesBinderUsersListResponse, page: number): SalesBinderUser[] {
  if (!Array.isArray(response.users)) {
    throw new Error(`Invalid SalesBinder users page ${page}: users must be an array.`);
  }
  const rows = response.users.some(Array.isArray)
    ? (response.users as SalesBinderUser[][]).flat()
    : (response.users as SalesBinderUser[]);
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error(`Invalid SalesBinder users page ${page}: user rows must be objects.`);
  }
  return rows;
}

function validatePageShape(count: number, pages: number, rowCount: number, page: number): void {
  if (count === 0) {
    if (page !== 1 || rowCount !== 0 || (pages !== 0 && pages !== 1)) {
      throw new Error('Invalid SalesBinder users pagination.');
    }
    return;
  }
  if (pages < 1 || rowCount === 0) throw new Error('Invalid SalesBinder users pagination.');
}

function normalizeUsers(rows: SalesBinderUser[]): SalespersonDirectoryInput['users'] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (!UUID.test(String(row.id))) throw new Error(`Invalid SalesBinder user row ${index + 1}.`);
    if (seen.has(row.id)) throw new Error('SalesBinder users response contains a duplicate id.');
    seen.add(row.id);
    const displayName = displayNameFor(row);
    if (!displayName) throw new Error(`Invalid SalesBinder user row ${index + 1}.`);
    return { userId: row.id, displayName };
  });
}

function displayNameFor(user: SalesBinderUser): string | null {
  for (const value of [user.display_name, user.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const parts = [user.first_name ?? user.firstname, user.last_name ?? user.lastname]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return parts.length > 0 ? parts.join(' ') : null;
}
