/**
 * Shared input utilities for CLI commands
 */

import fs from 'node:fs';

/**
 * Read and parse JSON input from file or stdin
 * @param file - File path to read, undefined for stdin
 * @param key - Optional key to extract from parsed JSON
 * @returns Parsed data
 * @throws Error if file not found or JSON is invalid
 */
export async function readJsonInput(
  file: string | undefined,
  key?: string
): Promise<Record<string, unknown>> {
  let content: string;

  if (file) {
    // Read from file
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file: ${file}`);
    }
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks).toString('utf-8');
  }

  if (!content.trim()) {
    throw new Error('No input provided');
  }

  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    if (key) {
      return (data[key] || data) as Record<string, unknown>;
    }
    return data;
  } catch (error) {
    throw new Error(`Invalid JSON input: ${(error as Error).message}`);
  }
}

/**
 * Validate numeric flag value
 * @param value - String value from CLI flag
 * @param name - Flag name for error messages
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Parsed number
 * @throws Error if validation fails
 */
export function validateNumberFlag(
  value: string,
  name: string,
  min?: number,
  max?: number
): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`Invalid ${name}: "${value}" is not a number`);
  }
  if (min !== undefined && num < min) {
    throw new Error(`Invalid ${name}: must be at least ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new Error(`Invalid ${name}: must be at most ${max}`);
  }
  return num;
}

/**
 * Validate context ID for customers/documents
 * @param value - Context ID string
 * @param type - 'customer' or 'document'
 * @returns Valid context ID
 * @throws Error if validation fails
 */
export function validateContextId(value: string, type: 'customer' | 'document'): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`Invalid context_id: "${value}" is not a number`);
  }

  const customerContexts = [2, 8, 10]; // Customer, Prospect, Supplier
  const documentContexts = [4, 5, 11]; // Estimate, Invoice, PO

  const valid = type === 'customer' ? customerContexts : documentContexts;

  if (!valid.includes(num)) {
    const names =
      type === 'customer'
        ? '2=Customer, 8=Prospect, 10=Supplier'
        : '4=Estimate, 5=Invoice, 11=Purchase Order';
    throw new Error(`Invalid context_id: ${num}. Valid values: ${names}`);
  }

  return num;
}
