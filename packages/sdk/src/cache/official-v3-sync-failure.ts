import axios from 'axios';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import { DocumentRecordError } from './document-source-validation.js';

export class OfficialV3SyncError extends Error {
  constructor(readonly code: string) {
    super(`Official V3 sync failed: ${code}`);
    this.name = 'OfficialV3SyncError';
  }
}

export function officialV3LocalFailure(error: unknown): string | null {
  if (error instanceof ApiResponseValidationError) return 'invalid_record';
  if (error instanceof DocumentRecordError) return 'invalid_record';
  if (!axios.isAxiosError(error)) return null;
  const status = error.response?.status;
  if (status === 401 || status === 403 || status === 429 || status === 400) return null;
  if (status === 404) return 'missing_unproven';
  if (status !== undefined && status >= 500) return 'source_unavailable';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_NETWORK'].includes(error.code ?? '')) {
    return 'source_unavailable';
  }
  return null;
}

export function fatalOfficialV3Failure(error: unknown): string {
  if (error instanceof OfficialV3SyncError) return error.code;
  if (error instanceof ApiResponseValidationError) return 'invalid_envelope';
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return 'authentication_failed';
    }
    if (error.response?.status === 400) return 'invalid_cursor';
    if (error.response?.status === 409) return 'rebuild_required';
    if (error.response?.status === 429) return 'rate_limit_failed';
    if (error.code === 'ERR_CANCELED') return 'aborted';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'operation_failed';
}
