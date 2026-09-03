import type { ParsedRateLimitHeaders } from './salesbinder-rate-limit-types.js';

export function parseRetryAfterMs(value: unknown, wallNow = Date.now()): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds > Number.MAX_SAFE_INTEGER / 1000
    ) {
      return undefined;
    }
    return seconds * 1000;
  }
  const timestamp = Date.parse(text);
  const delayMs = timestamp - wallNow;
  return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : undefined;
}

export function parseRateLimitHeaders(headers: unknown): ParsedRateLimitHeaders | undefined {
  const limit = parseSafeInteger(readRateLimitHeader(headers, 'ratelimit-limit'), 1);
  const remaining = parseSafeInteger(readRateLimitHeader(headers, 'ratelimit-remaining'), 0);
  const resetSeconds = parseRateLimitResetSeconds(headers);
  if (
    limit === undefined ||
    remaining === undefined ||
    resetSeconds === undefined ||
    remaining > limit
  ) {
    return undefined;
  }
  return { limit, remaining, resetSeconds };
}

export function parseRateLimitResetSeconds(headers: unknown): number | undefined {
  const seconds = parseSafeInteger(readRateLimitHeader(headers, 'ratelimit-reset'), 0);
  return seconds !== undefined && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds : undefined;
}

export function readRateLimitHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    if (value !== undefined && value !== null) return value;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function parseSafeInteger(value: unknown, minimum: number): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}
