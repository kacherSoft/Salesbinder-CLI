import { ApiResponseValidationError } from '../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../types/items.types.js';
import {
  normalizeV3InventoryItem,
  type NormalizedV3InventoryItem,
} from './v3-inventory-normalizer.js';
import { fetchAllV3Pages } from './v3-inventory-pagination.js';
import {
  classifyInventoryLocalFailure,
  invalidRecordReason,
  type LocalIssueReason,
} from './v3-inventory-recovery.js';
import { createV3ItemSourceFingerprint } from './v3-inventory-source-validation.js';

const EXACT_ITEM_BATCH_LIMIT = 50;
const VARIATION_PAGE_LIMIT = 100;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface V3ExactItemHydratorClient {
  items: {
    getMany(ids: readonly string[]): Promise<{ items: V3Item[]; omittedIds: string[] }>;
    listVariations(
      itemId: string,
      params: { page: number; limit: number; include: 'locations' }
    ): Promise<V3ListResponse<V3ItemVariation>>;
  };
}

export interface V3ExactItemHydrationProgress {
  recordsProcessed: number;
  recordsTotal: number;
  foundCount: number;
  missingCount: number;
  failureCount: number;
}

export type V3ExactItemHydrationProgressCallback = (
  progress: V3ExactItemHydrationProgress
) => void;

export interface V3ExactItemHydrationOptions {
  categoryNames?: Map<string, string> | null;
  onProgress?: V3ExactItemHydrationProgressCallback;
}

export interface V3FoundExactItemHydration {
  id: string;
  status: 'found_current' | 'found_archived';
  bundle: NormalizedV3InventoryItem;
  fingerprint: string;
}

export interface V3MissingExactItemHydration {
  id: string;
  status: 'missing_unproven';
}

export interface V3FailedExactItemHydration {
  id: string;
  status: 'local_failure';
  failure: LocalIssueReason;
}

export type V3ExactItemHydrationResult =
  | V3FoundExactItemHydration
  | V3MissingExactItemHydration
  | V3FailedExactItemHydration;

interface V3VariationHydrationClient {
  items: Pick<V3ExactItemHydratorClient['items'], 'listVariations'>;
}

export interface V3ItemHydrationObservation {
  normalized?: NormalizedV3InventoryItem;
  fingerprint?: string;
  failure?: LocalIssueReason;
}

export class V3ExactItemHydratorService {
  constructor(private readonly client: V3ExactItemHydratorClient) {}

  async hydrate(
    ids: readonly string[],
    options: V3ExactItemHydrationOptions = {}
  ): Promise<V3ExactItemHydrationResult[]> {
    validateHydrationIds(ids);
    const results: V3ExactItemHydrationResult[] = [];
    const counts = { foundCount: 0, missingCount: 0, failureCount: 0 };

    for (let offset = 0; offset < ids.length; offset += EXACT_ITEM_BATCH_LIMIT) {
      const batch = ids.slice(offset, offset + EXACT_ITEM_BATCH_LIMIT);
      const response = await this.client.items.getMany(batch);
      const items = validateExactResponse(batch, response.items, response.omittedIds);

      for (const id of batch) {
        const item = items.get(id);
        let result: V3ExactItemHydrationResult;
        if (!item) {
          result = { id, status: 'missing_unproven' };
          counts.missingCount++;
        } else {
          const observation = await hydrateV3InventoryItem(
            this.client,
            item,
            options.categoryNames ?? null
          );
          if (observation.normalized && observation.fingerprint) {
            result = {
              id,
              status: item.archived ? 'found_archived' : 'found_current',
              bundle: observation.normalized,
              fingerprint: observation.fingerprint,
            };
            counts.foundCount++;
          } else if (observation.failure) {
            result = { id, status: 'local_failure', failure: observation.failure };
            counts.failureCount++;
          } else {
            throw new Error('V3 exact item hydration returned an incomplete result');
          }
        }
        results.push(result);
        options.onProgress?.({
          recordsProcessed: results.length,
          recordsTotal: ids.length,
          ...counts,
        });
      }
    }
    return results;
  }
}

export async function hydrateV3InventoryItem(
  client: V3VariationHydrationClient,
  item: V3Item,
  categoryNames: Map<string, string> | null
): Promise<V3ItemHydrationObservation> {
  let variations: V3ItemVariation[];
  try {
    variations = await fetchAllV3Pages(
      (page) =>
        client.items.listVariations(item.id, {
          page,
          limit: VARIATION_PAGE_LIMIT,
          include: 'locations',
        }),
      `variations for item ${item.id}`,
      (message) => new ApiResponseValidationError(message, 'variations')
    );
  } catch (error) {
    const failure = classifyInventoryLocalFailure(error, 'variations');
    if (failure) return { failure };
    throw error;
  }

  try {
    return {
      normalized: normalizeV3InventoryItem(item, variations, categoryNames),
      fingerprint: createV3ItemSourceFingerprint(item, variations),
    };
  } catch (error) {
    const failure = classifyInventoryLocalFailure(error, 'record');
    if (failure) return { failure };
    throw error;
  }
}

export function observeV3InventorySnapshotItem(
  client: V3VariationHydrationClient,
  item: V3Item,
  categoryNames: Map<string, string> | null
): Promise<V3ItemHydrationObservation> {
  if (!Number.isSafeInteger(item.variation_count) || item.variation_count < 0) {
    return Promise.resolve({ failure: invalidRecordReason() });
  }
  return hydrateV3InventoryItem(client, item, categoryNames);
}

function validateHydrationIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new TypeError('Exact item hydration requires unique IDs');
  if (!ids.every((id) => CANONICAL_UUID.test(id))) {
    throw new TypeError('Exact item hydration requires canonical UUIDs');
  }
}

function validateExactResponse(
  requestedIds: readonly string[],
  returnedItems: readonly V3Item[],
  omittedIds: readonly string[]
): Map<string, V3Item> {
  const requested = new Set(requestedIds);
  const items = new Map<string, V3Item>();
  const omitted = new Set<string>();
  for (const item of returnedItems) {
    if (!requested.has(item.id) || items.has(item.id)) throw invalidExactResponse();
    items.set(item.id, item);
  }
  for (const id of omittedIds) {
    if (!requested.has(id) || items.has(id) || omitted.has(id)) throw invalidExactResponse();
    omitted.add(id);
  }
  if (items.size + omitted.size !== requestedIds.length) throw invalidExactResponse();
  return items;
}

function invalidExactResponse(): ApiResponseValidationError {
  return new ApiResponseValidationError('Invalid API v3 exact item hydration response', 'identity');
}
