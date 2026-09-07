import { DocumentRecordError } from './document-source-validation.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';
import type { DocumentRow } from './types.js';

export const SALESPERSON_DIRECTORY_META_KEY = 'salesperson_directory.v1';
export const SALESPERSON_DIRECTORY_SOURCE = 'salesbinder_v2_users';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_IDENTITY = /^salesbinder:[a-z0-9-]+$/;

export interface SalespersonDirectoryUser {
  userId: string;
  displayName: string;
}

export interface SalespersonDirectorySnapshot {
  version: 1;
  accountIdentity: string;
  source: typeof SALESPERSON_DIRECTORY_SOURCE;
  fetchedAt: number;
  users: SalespersonDirectoryUser[];
}

export interface SalespersonDirectoryInput {
  accountIdentity: string;
  source: typeof SALESPERSON_DIRECTORY_SOURCE;
  fetchedAt: number;
  users: SalespersonDirectoryUser[];
}

export interface SalespersonRepairResult {
  updatedCount: number;
  unresolvedUserCounts: Record<string, number>;
}

export interface ExistingSalespersonDocumentIdentity {
  user_id?: string | null;
  salesperson_name?: string | null;
}

export interface SalespersonAssignmentResolution {
  user_id: string | null;
  salesperson_name: string | null;
}

export function normalizeSalespersonDirectory(
  input: SalespersonDirectoryInput
): SalespersonDirectorySnapshot {
  const snapshot = { version: 1 as const, ...input };
  assertSalespersonDirectorySnapshot(snapshot);
  return snapshot;
}

export function assertSalespersonDirectorySnapshot(
  value: unknown
): asserts value is SalespersonDirectorySnapshot {
  if (!isRecord(value) || value.version !== 1) throw invalidDirectory();
  if (!ACCOUNT_IDENTITY.test(String(value.accountIdentity))) throw invalidDirectory();
  if (value.source !== SALESPERSON_DIRECTORY_SOURCE) throw invalidDirectory();
  if (!Number.isSafeInteger(value.fetchedAt) || Number(value.fetchedAt) <= 0) throw invalidDirectory();
  if (!Array.isArray(value.users)) throw invalidDirectory();
  const seen = new Set<string>();
  for (const user of value.users) {
    if (!isRecord(user) || !UUID.test(String(user.userId))) throw invalidDirectory();
    if (seen.has(String(user.userId))) throw invalidDirectory();
    seen.add(String(user.userId));
    if (!isValidDisplayName(user.displayName)) throw invalidDirectory();
  }
}

export function salespersonDirectoryMap(
  snapshot: SalespersonDirectorySnapshot | null
): Map<string, string> {
  return new Map(snapshot?.users.map((user) => [user.userId, user.displayName]) ?? []);
}

export function resolveSalespersonNameForWrite(
  doc: DocumentRow,
  existing: ExistingSalespersonDocumentIdentity | undefined,
  directory: SalespersonDirectorySnapshot | null
): string | null {
  return resolveSalespersonAssignmentForWrite(doc, existing, directory).salesperson_name;
}

export function resolveSalespersonAssignmentForWrite(
  doc: DocumentRow,
  existing: ExistingSalespersonDocumentIdentity | undefined,
  directory: SalespersonDirectorySnapshot | null
): SalespersonAssignmentResolution {
  const observedName = observedSalespersonName(doc);
  if (doc.user_id === null) return { user_id: null, salesperson_name: null };
  if (doc.user_id === undefined) {
    const existingUserId = existing?.user_id ?? null;
    if (existingUserId === null) {
      return { user_id: null, salesperson_name: observedName ?? null };
    }
    const name = observedName ?? resolveKnownAssignedName(existingUserId, existing, directory);
    return { user_id: existingUserId, salesperson_name: name };
  }
  const userId = doc.user_id;
  if (observedName !== undefined) {
    return { user_id: userId, salesperson_name: observedName };
  }
  return { user_id: userId, salesperson_name: resolveKnownAssignedName(userId, existing, directory) };
}

function observedSalespersonName(doc: DocumentRow): string | undefined {
  if (hasObservedSalespersonName(doc)) {
    if (doc.salesperson_name != null && typeof doc.salesperson_name !== 'string') {
      throw invalidSalespersonName();
    }
    if (hasDisplayName(doc.salesperson_name)) {
      if (!isValidDisplayName(doc.salesperson_name)) throw invalidSalespersonName();
      return doc.salesperson_name;
    }
  }
  return undefined;
}

export function hasObservedSalespersonName(doc: DocumentRow): boolean {
  if (!hasOwn(doc, 'salesperson_name')) return false;
  const value = doc.salesperson_name;
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0);
}

export function unresolvedSalespersonName(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'V3 document salesperson name is unresolved');
}

function resolveKnownAssignedName(
  userId: string,
  existing: ExistingSalespersonDocumentIdentity | undefined,
  directory: SalespersonDirectorySnapshot | null
): string {
  const directoryName = salespersonDirectoryMap(directory).get(userId);
  if (directoryName) return directoryName;
  if (existing?.user_id === userId && hasDisplayName(existing.salesperson_name)) {
    if (!isValidDisplayName(existing.salesperson_name)) throw invalidSalespersonName();
    return existing.salesperson_name;
  }
  throw unresolvedSalespersonName();
}

function hasDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDisplayName(value: unknown): value is string {
  return hasDisplayName(value) && !value.includes('\u0000') && !hasUnpairedUtf16Surrogate(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDirectory(): Error {
  return new Error('Salesperson directory is invalid.');
}

function invalidSalespersonName(): DocumentRecordError {
  return new DocumentRecordError('invalid_record', 'Document salesperson name is invalid');
}
