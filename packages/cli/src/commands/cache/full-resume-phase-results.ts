export type FullResumePhase = 'accounts' | 'categories' | 'documents' | 'items' | 'deleted-log';

type FullResumeRecordIssueCode =
  | 'not_found'
  | 'invalid_record'
  | 'invalid_variations'
  | 'content_changed';
type FullResumeDocumentRecordIssueCode = Extract<
  FullResumeRecordIssueCode,
  'not_found' | 'invalid_record'
>;

interface FullResumeRecordIssueBase {
  id: string;
  message: string;
  attempts: 2;
  outcome: 'preserved_last_known_good' | 'omitted_new';
}

interface FullResumeDocumentRecordIssue extends FullResumeRecordIssueBase {
  resource: 'document';
  context_id?: number;
  code: FullResumeDocumentRecordIssueCode;
}

interface FullResumeItemRecordIssue extends FullResumeRecordIssueBase {
  resource: 'item';
  context_id?: never;
  code: FullResumeRecordIssueCode;
}

export type FullResumeRecordIssue = FullResumeDocumentRecordIssue | FullResumeItemRecordIssue;

export interface FullResumeDocumentTombstone {
  contextId: 4 | 5 | 11;
  apiDocumentId: string;
}

export const MAX_SYNC_RECORD_ISSUE_ID_LENGTH = 256;

const RECORD_ISSUE_MESSAGES = {
  document: {
    not_found: 'Document unavailable during refresh',
    invalid_record: 'Document failed source validation',
  },
  item: {
    not_found: 'Item unavailable during refresh',
    invalid_record: 'Item failed source validation',
    invalid_variations: 'Item variations failed source validation',
    content_changed: 'Item changed during snapshot verification',
  },
} as const satisfies {
  document: Record<FullResumeDocumentRecordIssueCode, string>;
  item: Record<FullResumeRecordIssueCode, string>;
};

export interface FullResumePhaseResultMap {
  accounts: {
    accountsProcessed: number;
    customersProcessed: number;
    suppliersProcessed: number;
  };
  categories: {
    categoriesProcessed: number;
    snapshot: null;
  };
  documents: {
    success: true;
    type: 'full' | 'delta';
    documentsProcessed: number;
    documentsDeleted: number;
    lineItemsProcessed: number;
    duration: string;
    syncLookbackSeconds?: number;
    recordIssues: FullResumeRecordIssue[];
  };
  items: {
    itemsProcessed: number;
    stockRowsProcessed: number;
    recordIssues: FullResumeRecordIssue[];
  };
  'deleted-log': {
    deletedRecordsProcessed: number;
    documentTombstones: FullResumeDocumentTombstone[];
  };
}

export function sanitizeFullResumePhaseResult<Phase extends FullResumePhase>(
  phase: Phase,
  result: object
): FullResumePhaseResultMap[Phase] {
  if (!isRecord(result)) throw new Error(`${phase} phase result is not an object`);
  switch (phase) {
    case 'accounts':
      return {
        accountsProcessed: requireCount(result.accountsProcessed, 'accountsProcessed'),
        customersProcessed: requireCount(result.customersProcessed, 'customersProcessed'),
        suppliersProcessed: requireCount(result.suppliersProcessed, 'suppliersProcessed'),
      } as FullResumePhaseResultMap[Phase];
    case 'categories':
      return {
        categoriesProcessed: requireCount(result.categoriesProcessed, 'categoriesProcessed'),
        snapshot: null,
      } as FullResumePhaseResultMap[Phase];
    case 'documents':
      if (result.success !== true) throw new Error('documents phase did not succeed');
      return {
        success: true,
        type: requireSyncType(result.type),
        documentsProcessed: requireCount(result.documentsProcessed, 'documentsProcessed'),
        documentsDeleted: optionalCount(result.documentsDeleted) ?? 0,
        lineItemsProcessed: requireCount(result.lineItemsProcessed, 'lineItemsProcessed'),
        duration: requireSafeText(result.duration, 'duration', 64),
        ...(result.syncLookbackSeconds === undefined
          ? {}
          : {
              syncLookbackSeconds: requireCount(result.syncLookbackSeconds, 'syncLookbackSeconds'),
            }),
        recordIssues: sanitizeRecordIssues(result.recordIssues, 'document'),
      } as FullResumePhaseResultMap[Phase];
    case 'items':
      return {
        itemsProcessed: requireCount(result.itemsProcessed, 'itemsProcessed'),
        stockRowsProcessed: requireCount(result.stockRowsProcessed, 'stockRowsProcessed'),
        recordIssues: sanitizeRecordIssues(result.recordIssues, 'item'),
      } as FullResumePhaseResultMap[Phase];
    case 'deleted-log':
      return {
        deletedRecordsProcessed: requireCount(
          result.deletedRecordsProcessed,
          'deletedRecordsProcessed'
        ),
        documentTombstones: sanitizeDocumentTombstones(result.documentTombstones),
      } as FullResumePhaseResultMap[Phase];
  }
}

export function cloneFullResumePhaseResult<Phase extends FullResumePhase>(
  result: FullResumePhaseResultMap[Phase]
): FullResumePhaseResultMap[Phase] {
  return JSON.parse(JSON.stringify(result)) as FullResumePhaseResultMap[Phase];
}

function sanitizeRecordIssues(
  value: unknown,
  resource: FullResumeRecordIssue['resource']
): FullResumeRecordIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('recordIssues must be an array');
  const unique = new Map<string, FullResumeRecordIssue>();
  for (const entry of value) {
    const issue = sanitizeRecordIssue(entry, resource);
    const key = `${issue.resource}:${issue.id}`;
    const previous = unique.get(key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(issue)) {
        throw new Error(`conflicting record issue for ${key}`);
      }
      throw new Error(`duplicate record issue for ${key}`);
    }
    unique.set(key, issue);
  }
  return [...unique.values()].sort(
    (left, right) =>
      (left.context_id ?? -1) - (right.context_id ?? -1) || compareUtf16CodeUnits(left.id, right.id)
  );
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sanitizeRecordIssue(
  value: unknown,
  resource: FullResumeRecordIssue['resource']
): FullResumeRecordIssue {
  if (!isRecord(value) || value.resource !== resource)
    throw new Error(`record issue must describe a ${resource}`);
  if (value.outcome !== 'preserved_last_known_good' && value.outcome !== 'omitted_new') {
    throw new Error('record issue outcome is invalid');
  }
  const contextId = optionalCount(value.context_id);
  if (contextId !== undefined && (resource !== 'document' || ![4, 5, 11].includes(contextId))) {
    throw new Error('record issue context_id is invalid');
  }
  const outcome: FullResumeRecordIssue['outcome'] = value.outcome;
  const base = {
    id: requireCanonicalSyncRecordIssueId(value.id),
    attempts: requireExactRecoveryAttempts(value.attempts),
    outcome,
  };
  if (resource === 'document') {
    const code = requireIssueCode('document', value.code);
    return {
      ...base,
      resource,
      ...(contextId === undefined ? {} : { context_id: contextId }),
      code,
      message: canonicalSyncRecordIssueMessage('document', code),
    };
  }
  const code = requireIssueCode('item', value.code);
  return {
    ...base,
    resource,
    code,
    message: canonicalSyncRecordIssueMessage('item', code),
  };
}

function sanitizeDocumentTombstones(value: unknown): FullResumeDocumentTombstone[] {
  if (!Array.isArray(value)) throw new Error('documentTombstones must be an array');
  const tombstones: FullResumeDocumentTombstone[] = [];
  const identities = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !isDocumentContextId(entry.contextId)) {
      throw new Error('deleted-log document tombstone is invalid');
    }
    const tombstone = {
      contextId: entry.contextId,
      apiDocumentId: requireCanonicalSourceId(
        entry.apiDocumentId,
        'deleted-log document tombstone API ID is invalid'
      ),
    };
    const identity = JSON.stringify([tombstone.contextId, tombstone.apiDocumentId]);
    if (identities.has(identity)) {
      throw new Error('duplicate deleted-log document tombstone');
    }
    identities.add(identity);
    tombstones.push(tombstone);
  }
  return tombstones.sort(
    (left, right) =>
      left.contextId - right.contextId ||
      compareUtf16CodeUnits(left.apiDocumentId, right.apiDocumentId)
  );
}

export function requireCanonicalSyncRecordIssueId(value: unknown): string {
  return requireCanonicalSourceId(value, 'record issue id is invalid');
}

function requireCanonicalSourceId(value: unknown, errorMessage: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SYNC_RECORD_ISSUE_ID_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw new Error(errorMessage);
  }
  return value;
}

export function canonicalSyncRecordIssueMessage(
  resource: 'document',
  code: FullResumeDocumentRecordIssueCode
): string;
export function canonicalSyncRecordIssueMessage(
  resource: 'item',
  code: FullResumeRecordIssueCode
): string;
export function canonicalSyncRecordIssueMessage(
  resource: FullResumeRecordIssue['resource'],
  code: FullResumeRecordIssueCode
): string {
  if (resource === 'document') {
    if (!isDocumentIssueCode(code)) throw new Error('record issue code is invalid');
    return RECORD_ISSUE_MESSAGES.document[code];
  }
  return RECORD_ISSUE_MESSAGES.item[code];
}

function requireSyncType(value: unknown): 'full' | 'delta' {
  if (value !== 'full' && value !== 'delta') throw new Error('sync type is invalid');
  return value;
}

function requireIssueCode(resource: 'document', value: unknown): FullResumeDocumentRecordIssueCode;
function requireIssueCode(resource: 'item', value: unknown): FullResumeRecordIssueCode;
function requireIssueCode(
  resource: FullResumeRecordIssue['resource'],
  value: unknown
): FullResumeRecordIssueCode {
  if (resource === 'document' && isDocumentIssueCode(value)) return value;
  if (resource === 'item' && isItemIssueCode(value)) return value;
  throw new Error('record issue code is invalid');
}

function isDocumentIssueCode(value: unknown): value is FullResumeDocumentRecordIssueCode {
  return value === 'not_found' || value === 'invalid_record';
}

function isItemIssueCode(value: unknown): value is FullResumeRecordIssueCode {
  return (
    isDocumentIssueCode(value) || value === 'invalid_variations' || value === 'content_changed'
  );
}

function requireCount(value: unknown, field: string): number {
  if (!validCount(value)) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function requireExactRecoveryAttempts(value: unknown): 2 {
  if (value !== 2) throw new Error('record issue attempts must equal 2');
  return 2;
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!validCount(value)) throw new Error('count must be a non-negative integer');
  return value;
}

function requireSafeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const sanitized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, maxLength);
  if (!sanitized) throw new Error(`${field} must not be empty`);
  return sanitized;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isDocumentContextId(value: unknown): value is FullResumeDocumentTombstone['contextId'] {
  return value === 4 || value === 5 || value === 11;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
