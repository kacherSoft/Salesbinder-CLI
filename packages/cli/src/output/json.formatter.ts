/**
 * JSON output formatter for CLI
 */

/**
 * Format data as JSON string
 * @param data - Data to format
 * @returns JSON string
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format error as JSON
 * @param error - Error object
 * @returns JSON string with error details
 */
export function formatError(error: Error | { message: string }): string {
  const output = {
    error: true,
    message: error.message,
    stack: process.env.DEBUG === 'true' && error instanceof Error ? error.stack : undefined,
  };
  return JSON.stringify(output, null, 2);
}
