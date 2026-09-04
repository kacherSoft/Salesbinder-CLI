import { invalidInput, invalidResponse } from './change-feed.errors.js';

const MAX_BIGINT = '9223372036854775807';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isCanonicalBigint(value: string, allowZero: boolean): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  if (!allowZero && value === '0') return false;
  return value.length < MAX_BIGINT.length ||
    (value.length === MAX_BIGINT.length && value <= MAX_BIGINT);
}

export function assertInputText(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw invalidInput(`${label} must be a non-empty sanitized string`);
  }
  return value;
}

export function assertInputRecord(
  value: unknown,
  label: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidInput(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function assertResponseText(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value;
}

export function assertInputUuid(value: unknown, label: string): string {
  const text = assertInputText(value, label, 36);
  if (!UUID_PATTERN.test(text)) throw invalidInput(`${label} must be a canonical UUID`);
  return text;
}

export function assertResponseUuid(value: unknown, label: string): string {
  const text = assertResponseText(value, label, 36);
  if (!UUID_PATTERN.test(text)) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return text;
}

export function assertInputEventSequence(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isCanonicalBigint(value, false)) {
    throw invalidInput(`${label} must be a canonical positive decimal string`);
  }
  return value;
}

export function assertResponseEventSequence(value: unknown, label: string, nullable: false): string;
export function assertResponseEventSequence(
  value: unknown,
  label: string,
  nullable: true
): string | null;
export function assertResponseEventSequence(
  value: unknown,
  label: string,
  nullable: boolean
): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !isCanonicalBigint(value, false)) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value;
}

export function assertResponseCount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isCanonicalBigint(value, true)) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value;
}

export function assertInputInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

export function assertResponseInteger(
  value: unknown,
  label: string,
  minimum = 0
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value as number;
}

export function assertResponseDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value;
}

export function assertInputDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalidInput(`${label} must be a valid Date`);
  }
  return value;
}

export function assertFailureCode(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FAILURE_CODE_PATTERN.test(value)) {
    throw invalidInput(`${label} must be a sanitized machine-readable code`);
  }
  return value;
}

export function assertSafeErrorMessage(value: unknown, label: string): string {
  const message = assertInputText(value, label, 1_000);
  if (
    /(?:postgres(?:ql)?:\/\/|password\s*[=:]|api[_ -]?key\s*[=:]|authorization\s*[=:]|(?:bearer|basic)\s+[a-z0-9._~+/=-]+)/i.test(
      message
    )
  ) {
    throw invalidInput(`${label} contains sensitive connection or credential material`);
  }
  return message;
}

export function assertRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse(`Change-feed response contains an invalid ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function compareEventSequences(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
