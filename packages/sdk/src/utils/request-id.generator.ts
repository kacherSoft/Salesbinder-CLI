/**
 * Request ID generator for tracing API calls
 */

/**
 * Generate a unique request ID for tracing
 * @returns UUID v4 string
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
