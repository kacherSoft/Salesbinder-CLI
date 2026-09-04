import type {
  ChangeFeedRepository,
  ClaimedChangeFeedEvent,
} from '../change-feed/change-feed.types.js';

export interface InventoryLeaseRenewalDependencies {
  ledger: Pick<ChangeFeedRepository, 'renewLease'>;
  leaseOwner: string;
  leaseSeconds: number;
  signal: AbortSignal;
  assertWriterLockHeld: () => void | Promise<void>;
  onRenewed?: (eventCount: number, leasedUntil: Date) => void;
  now?: () => number;
}

interface ActiveLease {
  eventSeq: string;
  leaseToken: string;
  leasedUntil: Date;
}

/** Keeps fenced ledger claims live while V3 requests wait or hydrate variation subtrees. */
export class InventoryChangeFeedLeaseRenewal {
  private readonly active = new Map<string, ActiveLease>();
  private readonly transitioning = new Set<string>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private renewal?: Promise<void>;
  private fatalError?: Error;
  private readonly unsafe: Promise<Error>;
  private signalUnsafe!: (error: Error) => void;
  private stopped = false;

  constructor(private readonly dependencies: InventoryLeaseRenewalDependencies) {
    if (!Number.isSafeInteger(dependencies.leaseSeconds) || dependencies.leaseSeconds < 1) {
      throw new RangeError('Inventory lease duration must be a positive integer');
    }
    this.now = dependencies.now ?? Date.now;
    this.unsafe = new Promise((resolve) => {
      this.signalUnsafe = resolve;
    });
    dependencies.signal.addEventListener('abort', this.abort, { once: true });
  }

  add(events: readonly ClaimedChangeFeedEvent[]): void {
    for (const event of events) {
      this.active.set(event.eventSeq, {
        eventSeq: event.eventSeq,
        leaseToken: event.leaseToken,
        leasedUntil: event.leasedUntil,
      });
    }
    if (this.active.size > 0 && !this.stopped) {
      if (!this.timer) this.schedule();
      this.scheduleExpiryCheck();
    }
  }

  async beginTransition(eventSeq: string): Promise<void> {
    await this.checkpoint();
    if (!this.active.has(eventSeq)) throw new Error('Inventory change-feed lease is not active');
    this.transitioning.add(eventSeq);
  }

  finishTransition(eventSeq: string): void {
    this.transitioning.delete(eventSeq);
    this.active.delete(eventSeq);
    this.scheduleExpiryCheck();
    if (this.active.size === 0) this.clearTimers();
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.unsafe.then((error) => Promise.reject(error))]);
  }

  async checkpoint(): Promise<void> {
    if (this.renewal) await this.renewal;
    this.throwIfUnsafe();
  }

  stop = (): void => {
    this.stopped = true;
    this.clearTimers();
    this.dependencies.signal.removeEventListener('abort', this.abort);
  };

  private abort = (): void => {
    this.fail(abortError(this.dependencies.signal.reason));
    this.stop();
  };

  private schedule(): void {
    const intervalMs = Math.max(250, Math.floor((this.dependencies.leaseSeconds * 1_000) / 3));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.renewal = this.renewAll().catch((error: unknown) => {
        this.fail(toError(error, 'Inventory change-feed lease renewal failed'));
      });
      void this.renewal.finally(() => {
        this.renewal = undefined;
        if (!this.stopped && this.active.size > 0 && !this.fatalError) this.schedule();
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  private async renewAll(): Promise<void> {
    this.throwIfUnsafe();
    let latestExpiry: Date | undefined;
    let renewedCount = 0;
    for (const lease of [...this.active.values()]) {
      if (this.transitioning.has(lease.eventSeq)) continue;
      this.throwIfAborted();
      await this.dependencies.assertWriterLockHeld();
      this.throwIfAborted();
      if (!this.active.has(lease.eventSeq)) continue;
      const leasedUntil = await this.dependencies.ledger.renewLease({
        eventSeq: lease.eventSeq,
        leaseOwner: this.dependencies.leaseOwner,
        leaseToken: lease.leaseToken,
        leaseSeconds: this.dependencies.leaseSeconds,
      });
      if (!Number.isFinite(leasedUntil.getTime()) || leasedUntil.getTime() <= this.now()) {
        throw new Error('Inventory change-feed lease renewal returned an uncertain expiry');
      }
      const current = this.active.get(lease.eventSeq);
      if (current) current.leasedUntil = leasedUntil;
      renewedCount++;
      if (!latestExpiry || leasedUntil > latestExpiry) latestExpiry = leasedUntil;
    }
    if (renewedCount > 0 && latestExpiry) {
      this.dependencies.onRenewed?.(renewedCount, latestExpiry);
      this.scheduleExpiryCheck();
    }
  }

  private scheduleExpiryCheck(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.stopped || this.active.size === 0 || this.fatalError) return;
    const earliest = Math.min(
      ...[...this.active.values()].map((lease) => lease.leasedUntil.getTime())
    );
    const delay = Math.max(0, earliest - this.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      try {
        this.throwIfUnsafe();
        this.scheduleExpiryCheck();
      } catch (error) {
        this.fail(toError(error, 'Inventory change-feed lease expiry is uncertain'));
      }
    }, delay);
    this.expiryTimer.unref?.();
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.signalUnsafe(error);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = undefined;
    this.expiryTimer = undefined;
  }

  private throwIfUnsafe(): void {
    this.throwIfAborted();
    if (this.fatalError) throw this.fatalError;
    for (const lease of this.active.values()) {
      if (
        !Number.isFinite(lease.leasedUntil.getTime()) ||
        lease.leasedUntil.getTime() <= this.now()
      ) {
        throw new Error('Inventory change-feed lease expiry is uncertain');
      }
    }
  }

  private throwIfAborted(): void {
    if (!this.dependencies.signal.aborted) return;
    throw abortError(this.dependencies.signal.reason);
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Inventory change-feed sync was aborted');
  error.name = 'AbortError';
  return error;
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
