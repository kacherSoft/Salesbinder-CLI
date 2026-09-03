export type SyncRecordIssueResource = 'document' | 'item';

export type SyncRecordIssueCode =
  | 'not_found'
  | 'invalid_record'
  | 'invalid_variations'
  | 'content_changed';

export type SyncRecordIssueOutcome = 'preserved_last_known_good' | 'omitted_new';

interface SyncRecordIssueBase {
  id: string;
  message: string;
  /** One primary attempt plus exactly one application-level recovery attempt. */
  attempts: 2;
  outcome: SyncRecordIssueOutcome;
}

export interface DocumentSyncRecordIssue extends SyncRecordIssueBase {
  resource: 'document';
  context_id?: number;
  code: Extract<SyncRecordIssueCode, 'not_found' | 'invalid_record'>;
}

export interface ItemSyncRecordIssue extends SyncRecordIssueBase {
  resource: 'item';
  context_id?: never;
  code: SyncRecordIssueCode;
}

/** Sanitized terminal issue retained for owner remediation. */
export type SyncRecordIssue = DocumentSyncRecordIssue | ItemSyncRecordIssue;
