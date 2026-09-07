import axios from 'axios';
import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import { DocumentRecordError } from './document-source-validation.js';

/** Only fixed codes cross the API boundary; never retain request/config payloads. */
export class DocumentOffsetSyncError extends Error {
  constructor(readonly code: string) {
    super(`Document offset sync failed: ${code}`);
    this.name = 'DocumentOffsetSyncError';
  }
}

export function localOffsetFailure(error: unknown): string | null {
  if (error instanceof ApiResponseValidationError) return 'invalid_record';
  if (error instanceof DocumentRecordError) return 'invalid_record';
  if (!axios.isAxiosError(error)) return null;
  const status = error.response?.status;
  if (status === 401 || status === 403 || status === 429 || error.code === 'ERR_CANCELED')
    return null;
  if (status === 404) return 'missing_unproven';
  if (status !== undefined && status >= 500) return 'source_unavailable';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_NETWORK'].includes(error.code ?? '')) {
    return 'source_unavailable';
  }
  return null;
}

export function fatalOffsetFailure(error: unknown): string {
  if (error instanceof DocumentOffsetSyncError) return error.code;
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401 || error.response?.status === 403)
      return 'authentication_failed';
    if (error.response?.status === 429) return 'rate_limit_failed';
    if (error.code === 'ERR_CANCELED') return 'aborted';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'operation_failed';
}
