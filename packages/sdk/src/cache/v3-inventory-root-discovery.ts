import type { V3Item, V3ListResponse } from '../types/items.types.js';
import { createInventoryBaselineRootFingerprint } from './types.js';
import {
  fetchAllV3PageSnapshot,
  sameV3PaginationSignature,
  type V3PageSnapshot,
  type V3PaginationSignature,
} from './v3-inventory-pagination.js';
import { compareSourceIds, sameSourceIdArray } from './v3-inventory-source-validation.js';

const ROOT_PAGE_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const ROOT_MEMBERSHIP_DRIFT = 'V3 item membership changed during root discovery';
const ROOT_PAGINATION_DRIFT = 'V3 item pagination changed during root discovery';
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface V3InventoryRootClient {
  items: {
    list(params: { page: number; limit: number; archived: 'all' }): Promise<V3ListResponse<V3Item>>;
  };
}

export interface V3InventoryRootDiscoveryOptions {
  accountIdentity: string;
  signal: AbortSignal;
  assertWriterLockHeld: () => void | Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface V3InventoryRootManifest {
  itemIds: string[];
  fingerprint: string;
  paginationSignature: V3PaginationSignature;
}

export interface V3InventoryRootDiscoveryPort {
  discover(options: V3InventoryRootDiscoveryOptions): Promise<V3InventoryRootManifest>;
}

interface RootPass {
  itemIds: string[];
  paginationSignature: V3PaginationSignature;
}

class V3InventoryRootDriftError extends Error {}

export class V3InventoryRootDiscovery implements V3InventoryRootDiscoveryPort {
  constructor(private readonly client: V3InventoryRootClient) {}

  async discover(options: V3InventoryRootDiscoveryOptions): Promise<V3InventoryRootManifest> {
    const attempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new TypeError('V3 inventory root discovery attempts must be a positive integer');
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError('V3 inventory root discovery delay must be a non-negative integer');
    }

    let lastDrift: V3InventoryRootDriftError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const first = await this.readPass(options);
        const second = await this.readPass(options);
        assertSameRoot(first, second);
        assertExactHydrationIds(first.itemIds);
        return {
          itemIds: first.itemIds,
          fingerprint: createInventoryBaselineRootFingerprint(
            options.accountIdentity,
            first.itemIds
          ),
          paginationSignature: first.paginationSignature,
        };
      } catch (error) {
        if (!(error instanceof V3InventoryRootDriftError) || attempt === attempts) throw error;
        lastDrift = error;
        await abortableDelay(retryDelayMs * attempt, options.signal);
      }
    }
    throw lastDrift ?? new Error('Unable to discover a stable V3 inventory root');
  }

  private async readPass(options: V3InventoryRootDiscoveryOptions): Promise<RootPass> {
    let source: V3PageSnapshot<V3Item>;
    try {
      source = await fetchAllV3PageSnapshot(
        (page) =>
          checkedRead(
            () => this.client.items.list({ page, limit: ROOT_PAGE_LIMIT, archived: 'all' }),
            options
          ),
        'items',
        (message) =>
          isRetryableRootDriftMessage(message)
            ? new V3InventoryRootDriftError(message)
            : new Error(message)
      );
    } catch (error) {
      if (error instanceof Error && isRetryableRootDriftMessage(error.message)) {
        throw new V3InventoryRootDriftError(error.message);
      }
      throw error;
    }
    return {
      itemIds: source.rows.map((item) => item.id).sort(compareSourceIds),
      paginationSignature: source.signature,
    };
  }
}

function assertExactHydrationIds(itemIds: readonly string[]): void {
  if (!itemIds.every((itemId) => CANONICAL_UUID.test(itemId))) {
    throw new Error('V3 inventory root contains an identity unsupported by exact hydration');
  }
}

function isRetryableRootDriftMessage(message: string): boolean {
  return (
    message === 'V3 items pagination changed during snapshot' ||
    message === 'Duplicate v3 items ID' ||
    message.startsWith('Incomplete v3 items page ') ||
    message.startsWith('Incomplete v3 items snapshot:')
  );
}

function assertSameRoot(left: RootPass, right: RootPass): void {
  if (!sameSourceIdArray(left.itemIds, right.itemIds)) {
    throw new V3InventoryRootDriftError(ROOT_MEMBERSHIP_DRIFT);
  }
  if (!sameV3PaginationSignature(left.paginationSignature, right.paginationSignature)) {
    throw new V3InventoryRootDriftError(ROOT_PAGINATION_DRIFT);
  }
}

async function checkedRead<T>(
  operation: () => Promise<T>,
  options: Pick<V3InventoryRootDiscoveryOptions, 'signal' | 'assertWriterLockHeld'>
): Promise<T> {
  throwIfAborted(options.signal);
  await options.assertWriterLockHeld();
  throwIfAborted(options.signal);
  const result = await operation();
  throwIfAborted(options.signal);
  await options.assertWriterLockHeld();
  throwIfAborted(options.signal);
  return result;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => finish(abortError(signal), true);
    function finish(error?: Error, rejected = false): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (rejected) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('V3 inventory baseline was aborted');
  error.name = 'AbortError';
  return error;
}
