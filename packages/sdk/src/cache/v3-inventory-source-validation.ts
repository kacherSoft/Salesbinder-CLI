import { createHash } from 'node:crypto';
import type { V3Item, V3ItemVariation } from '../types/items.types.js';
import { hasUnpairedUtf16Surrogate } from './salesbinder-source-text-validation.js';

const MAX_SOURCE_ID_LENGTH = 256;

export function createV3ItemSourceFingerprint(item: V3Item, variations: V3ItemVariation[]): string {
  const canonicalVariations = [...variations]
    .sort((left, right) => compareSourceIds(left.id, right.id))
    .map((variation) => ({
      ...variation,
      locations:
        variation.locations == null
          ? variation.locations
          : [...variation.locations].sort(
              (left, right) =>
                left.item_variation_location_id - right.item_variation_location_id ||
                compareSourceIds(left.location_id, right.location_id)
            ),
    }));
  return createHash('sha256')
    .update(stableSerialize({ item, variations: canonicalVariations }))
    .digest('hex');
}

export function assertCanonicalV3SourceId(
  value: unknown,
  label: string,
  invalid: (message: string) => Error = (message) => new Error(message)
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > MAX_SOURCE_ID_LENGTH ||
    hasControlCharacter(value) ||
    hasUnpairedUtf16Surrogate(value)
  ) {
    throw invalid(`Invalid v3 ${label} identity`);
  }
}

export function sameSourceIdArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareSourceIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
      return nestedValue;
    }
    const record = nestedValue as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]])
    );
  });
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
