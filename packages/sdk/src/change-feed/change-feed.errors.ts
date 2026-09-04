export type ChangeFeedRepositoryErrorCode =
  | 'closed'
  | 'invalid_input'
  | 'invalid_response'
  | 'binding_mismatch'
  | 'permission_denied'
  | 'lease_lost'
  | 'contract_state_conflict'
  | 'timeout'
  | 'connection_failed'
  | 'database_error';

export class ChangeFeedRepositoryError extends Error {
  constructor(
    readonly code: ChangeFeedRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ChangeFeedRepositoryError';
  }
}

type DatabaseErrorLike = Error & { code?: string };

const BINDING_ERRORS = new Set([
  'account_binding_mismatch',
  'change_feed_consumer_not_registered',
  'change_feed_preflight_mismatch',
  'consumer_account_mismatch',
  'consumer_subscription_mismatch',
]);
const LEASE_ERRORS = new Set(['active_matching_lease_required']);
const STATE_ERRORS = new Set([
  'active_sync_run_required',
  'active_sync_run_scope_required',
  'baseline_range_has_processing_events',
  'cache_receipt_verification_mismatch',
  'cutover_target_blocked',
  'replaying_sync_run_required',
  'sync_run_changed_during_target_capture',
  'sync_run_not_baseline_succeeded',
  'sync_run_not_awaiting_baseline',
  'sync_run_not_replaying',
  'sync_run_start_has_processing_events',
  'verified_sync_run_required',
]);
const CONNECTION_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export function translateChangeFeedError(error: unknown): ChangeFeedRepositoryError {
  if (error instanceof ChangeFeedRepositoryError) return error;
  const databaseError = error instanceof Error ? (error as DatabaseErrorLike) : undefined;
  const code = databaseError?.code;
  const identifier = databaseError?.message;

  if (identifier && BINDING_ERRORS.has(identifier)) {
    return new ChangeFeedRepositoryError(
      'binding_mismatch',
      'Change-feed ledger binding does not match the configured cache account',
      { cause: error }
    );
  }
  if (identifier && LEASE_ERRORS.has(identifier)) {
    return new ChangeFeedRepositoryError(
      'lease_lost',
      'Change-feed lease is no longer active for this worker',
      { cause: error }
    );
  }
  if (identifier && STATE_ERRORS.has(identifier)) {
    return new ChangeFeedRepositoryError(
      'contract_state_conflict',
      'Change-feed ledger state does not allow this operation',
      { cause: error }
    );
  }
  if (code === '42501') {
    return new ChangeFeedRepositoryError(
      'permission_denied',
      'Change-feed database login lacks required worker permissions',
      { cause: error }
    );
  }
  if (code === '55P03' || code === '57014') {
    return new ChangeFeedRepositoryError('timeout', 'Change-feed ledger operation timed out', {
      cause: error,
    });
  }
  if (code && (code.startsWith('08') || CONNECTION_CODES.has(code))) {
    return new ChangeFeedRepositoryError(
      'connection_failed',
      'Change-feed ledger connection failed',
      { cause: error }
    );
  }
  if (code === '22023') {
    return new ChangeFeedRepositoryError(
      'invalid_input',
      'Change-feed ledger rejected invalid operation input',
      { cause: error }
    );
  }
  return new ChangeFeedRepositoryError('database_error', 'Change-feed ledger operation failed', {
    cause: error,
  });
}

export function invalidInput(message: string): ChangeFeedRepositoryError {
  return new ChangeFeedRepositoryError('invalid_input', message);
}

export function invalidResponse(message: string): ChangeFeedRepositoryError {
  return new ChangeFeedRepositoryError('invalid_response', message);
}
