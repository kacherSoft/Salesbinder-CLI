import type { AxiosInstance } from 'axios';
import { ApiResponseValidationError } from './api-response-validation.error.js';

const SUPPORTED_RESOURCES = ['item', 'invoice', 'estimate', 'purchase_order'] as const;
const MAX_CURSOR_LENGTH = 8_192;
const MAX_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type V3SyncResourceName = (typeof SUPPORTED_RESOURCES)[number];

export type V3SyncReadParams =
  | { start: 'now'; resources: readonly V3SyncResourceName[]; limit?: number }
  | { since: string | number; resources: readonly V3SyncResourceName[]; limit?: number }
  | { cursor: string; limit?: number };

export interface V3SyncChange {
  resource: V3SyncResourceName;
  id: string;
  operation: 'upsert' | 'delete';
}

export interface V3SyncStartEnvelope {
  object: 'sync_start';
  resources: V3SyncResourceName[];
  retention_days: number;
  cursor: string;
}

export interface V3SyncPageEnvelope {
  object: 'sync_page';
  resources: V3SyncResourceName[];
  changes: V3SyncChange[];
  has_more: boolean;
  next_cursor: string;
}

export type V3SyncEnvelope = V3SyncStartEnvelope | V3SyncPageEnvelope;

/** Strict V3 incremental-sync transport; this is not a list-pagination adapter. */
export class V3SyncResource {
  constructor(private readonly client: AxiosInstance) {}

  async read(params: V3SyncReadParams): Promise<V3SyncEnvelope> {
    const request = validateRequest(params);
    const response = await this.client.get<unknown>('/sync', { params: request.params });
    return validateEnvelope(
      response.data,
      request.resources,
      request.expectStart,
      request.maxChanges
    );
  }
}

function validateRequest(input: unknown): {
  params: Record<string, string | number>;
  resources?: readonly V3SyncResourceName[];
  expectStart: boolean;
  maxChanges: number;
} {
  if (!isRecord(input)) throw new TypeError('V3 sync requires exactly one start, since, or cursor');
  const anchors = ['start', 'since', 'cursor'].filter((key) => hasOwn(input, key));
  if (anchors.length !== 1)
    throw new TypeError('V3 sync requires exactly one start, since, or cursor');
  const limit = validateLimit(input.limit);
  if (hasOwn(input, 'start')) {
    assertAllowedKeys(input, ['start', 'resources', 'limit']);
    if (input.start !== 'now') throw new TypeError('V3 sync start must be now');
    const resources = validateResources(input.resources);
    return {
      params: withLimit({ start: 'now', resources: resources.join(',') }, limit),
      resources,
      expectStart: true,
      maxChanges: limit ?? 100,
    };
  }
  if (hasOwn(input, 'since')) {
    assertAllowedKeys(input, ['since', 'resources', 'limit']);
    const resources = validateResources(input.resources);
    return {
      params: withLimit(
        { since: validateSince(input.since), resources: resources.join(',') },
        limit
      ),
      resources,
      expectStart: false,
      maxChanges: limit ?? 100,
    };
  }
  if (hasOwn(input, 'resources')) {
    throw new TypeError('V3 sync cursor requests must not include resources');
  }
  assertAllowedKeys(input, ['cursor', 'limit']);
  return {
    params: withLimit({ cursor: validateOpaqueCursor(input.cursor) }, limit),
    expectStart: false,
    maxChanges: limit ?? 100,
  };
}

function validateEnvelope(
  value: unknown,
  expectedResources: readonly V3SyncResourceName[] | undefined,
  expectStart: boolean,
  maxChanges: number
): V3SyncEnvelope {
  if (!isRecord(value)) throw invalidEnvelope('expected an object');
  const resources = validateResponseResources(value.resources, expectedResources);
  if (expectStart && value.object === 'sync_start') {
    if (!isPositiveInteger(value.retention_days) || !isOpaqueCursor(value.cursor)) {
      throw invalidEnvelope('invalid start checkpoint');
    }
    return {
      object: 'sync_start',
      resources,
      retention_days: value.retention_days,
      cursor: value.cursor,
    };
  }
  if (!expectStart && value.object !== 'sync_page') {
    throw invalidEnvelope('expected a sync page');
  }
  if (expectStart || !Array.isArray(value.changes) || typeof value.has_more !== 'boolean') {
    throw invalidEnvelope('expected a sync page');
  }
  if (!isOpaqueCursor(value.next_cursor)) throw invalidEnvelope('invalid continuation checkpoint');
  if (value.changes.length > maxChanges) throw invalidEnvelope('page exceeds requested limit');
  return {
    object: 'sync_page',
    resources,
    changes: value.changes.map((change) => validateChange(change, resources)),
    has_more: value.has_more,
    next_cursor: value.next_cursor,
  };
}

function validateChange(value: unknown, resources: readonly V3SyncResourceName[]): V3SyncChange {
  if (
    !isRecord(value) ||
    !isResource(value.resource) ||
    !resources.includes(value.resource) ||
    !isCanonicalUuid(value.id) ||
    (value.operation !== 'upsert' && value.operation !== 'delete')
  ) {
    throw invalidEnvelope('invalid change marker');
  }
  return { resource: value.resource, id: value.id, operation: value.operation };
}

function validateResources(value: unknown): V3SyncResourceName[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((resource) => !isResource(resource))
  ) {
    throw new TypeError('V3 sync requires one or more supported resources');
  }
  if (new Set(value).size !== value.length) throw new TypeError('V3 sync resources must be unique');
  return [...value];
}

function validateResponseResources(
  value: unknown,
  expected?: readonly V3SyncResourceName[]
): V3SyncResourceName[] {
  let resources: V3SyncResourceName[];
  try {
    resources = validateResources(value);
  } catch {
    throw invalidEnvelope('invalid resources');
  }
  if (
    expected &&
    (resources.length !== expected.length || resources.some((item) => !expected.includes(item)))
  ) {
    throw invalidEnvelope('inconsistent resources');
  }
  return resources;
}

function validateLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 500) {
    throw new RangeError('V3 sync limit must be an integer between 1 and 500');
  }
  return value as number;
}

function validateSince(value: unknown): string | number {
  const now = Date.now() / 1000;
  const seconds =
    typeof value === 'number'
      ? value
      : isUnixSeconds(value)
        ? Number(value)
        : isIsoWithTimezone(value)
          ? Date.parse(value) / 1000
          : Number.NaN;
  if (!isValidSince(value, seconds) || seconds > now || seconds < now - MAX_RETENTION_SECONDS) {
    throw new RangeError('V3 sync since must be a non-future timestamp within the last 90 days');
  }
  return value as string | number;
}

function isValidSince(value: unknown, seconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value <= 9_999_999_999;
  if (isUnixSeconds(value)) return true;
  return isIsoWithTimezone(value) && isValidIsoCalendarTimestamp(value);
}

function isValidIsoCalendarTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function withLimit(params: Record<string, string | number>, limit: number | undefined) {
  return limit === undefined ? params : { ...params, limit };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('V3 sync request contains unsupported parameters');
  }
}

function validateOpaqueCursor(value: unknown): string {
  if (!isOpaqueCursor(value)) throw new TypeError('V3 sync cursor is invalid');
  return value;
}

function isOpaqueCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

function isIsoWithTimezone(value: unknown): value is string {
  return typeof value === 'string' && ISO_WITH_TIMEZONE.test(value);
}

function isUnixSeconds(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,10}$/.test(value);
}

function isResource(value: unknown): value is V3SyncResourceName {
  return typeof value === 'string' && (SUPPORTED_RESOURCES as readonly string[]).includes(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidEnvelope(detail: string): ApiResponseValidationError {
  return new ApiResponseValidationError(`Invalid API v3 sync response: ${detail}`);
}
