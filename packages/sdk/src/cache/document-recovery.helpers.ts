import type { CacheService } from './cache.interface.js';
import type { SyncRecordIssue } from './sync-record-issue.types.js';
import type { DocumentRow } from './types.js';
import { DocumentContextId } from './types.js';

export interface DocumentRecoveryEntry {
  id: string;
  contextId: DocumentContextId;
  documentNumber?: number;
}

export function assertDocumentNumberLookupIdentity(
  document: DocumentRow | undefined,
  expectedApiDocumentId: string | null | undefined
): void {
  if (document?.api_doc_id != null && document.api_doc_id !== expectedApiDocumentId) {
    throw new Error(`Cache document identity conflict for ${expectedApiDocumentId ?? 'document'}`);
  }
}

export async function findExistingDocument(
  cache: CacheService,
  entry: DocumentRecoveryEntry
): Promise<DocumentRow | undefined> {
  const byApiId = await cache.getDocumentByApiId(entry.id);
  const byNumber =
    entry.documentNumber === undefined
      ? undefined
      : await cache.getDocumentByNumber(entry.contextId, entry.documentNumber);
  if (byApiId && byNumber && byApiId.doc_id !== byNumber.doc_id) {
    throw new Error(`Cache document identity conflict for ${entry.id}`);
  }
  assertDocumentNumberLookupIdentity(byNumber, entry.id);
  return byApiId ?? byNumber;
}

export function sortRecordIssues(issues: SyncRecordIssue[]): SyncRecordIssue[] {
  return [...issues].sort(
    (left, right) =>
      compareCodeUnitStrings(left.resource, right.resource) ||
      (left.context_id ?? -1) - (right.context_id ?? -1) ||
      compareCodeUnitStrings(left.id, right.id)
  );
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
