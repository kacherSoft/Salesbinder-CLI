/** Nominal error for malformed successful API responses with safe diagnostics. */
export class ApiResponseValidationError extends Error {
  readonly code = 'invalid_api_response';

  constructor(
    message: string,
    readonly sourceScope?: 'record' | 'variations' | 'identity'
  ) {
    super(message);
    this.name = 'ApiResponseValidationError';
  }
}
