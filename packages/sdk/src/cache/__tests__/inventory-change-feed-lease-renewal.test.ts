import type { ChangeFeedRepository, ClaimedChangeFeedEvent } from '../../change-feed/change-feed.types.js';
import { InventoryChangeFeedLeaseRenewal } from '../inventory-change-feed-lease-renewal.js';

describe('InventoryChangeFeedLeaseRenewal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renews active leases with the original fenced token and count-only progress', async () => {
    const renewLease = jest.fn(async () => new Date(Date.now() + 60_000));
    const assertWriterLockHeld = jest.fn(async () => undefined);
    const onRenewed = jest.fn();
    const renewal = new InventoryChangeFeedLeaseRenewal({
      ledger: { renewLease } as unknown as Pick<ChangeFeedRepository, 'renewLease'>,
      leaseOwner: 'worker-1',
      leaseSeconds: 30,
      signal: new AbortController().signal,
      assertWriterLockHeld,
      onRenewed,
    });

    renewal.add([event('10'), event('11')]);
    jest.advanceTimersByTime(10_000);
    await renewal.checkpoint();

    expect(assertWriterLockHeld).toHaveBeenCalledTimes(2);
    expect(renewLease).toHaveBeenCalledWith({
      eventSeq: '10',
      leaseOwner: 'worker-1',
      leaseToken: 'token-10',
      leaseSeconds: 30,
    });
    expect(renewLease).toHaveBeenCalledWith({
      eventSeq: '11',
      leaseOwner: 'worker-1',
      leaseToken: 'token-11',
      leaseSeconds: 30,
    });
    expect(onRenewed).toHaveBeenCalledWith(2, new Date(Date.now() + 60_000));
    expect(JSON.stringify(onRenewed.mock.calls)).not.toContain('token-10');
    renewal.stop();
  });

  it('removes leases before transition so completed events are no longer renewed', async () => {
    const renewLease = jest.fn(async () => new Date(Date.now() + 60_000));
    const renewal = new InventoryChangeFeedLeaseRenewal({
      ledger: { renewLease } as unknown as Pick<ChangeFeedRepository, 'renewLease'>,
      leaseOwner: 'worker-1',
      leaseSeconds: 30,
      signal: new AbortController().signal,
      assertWriterLockHeld: jest.fn(async () => undefined),
    });

    renewal.add([event('20'), event('21')]);
    await renewal.beginTransition('20');
    jest.advanceTimersByTime(10_000);
    await renewal.checkpoint();
    renewal.finishTransition('20');

    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(renewLease).toHaveBeenCalledWith(expect.objectContaining({ eventSeq: '21' }));
    renewal.stop();
  });

  it('fails closed when renewal returns an uncertain expiry', async () => {
    const renewal = new InventoryChangeFeedLeaseRenewal({
      ledger: {
        renewLease: jest.fn(async () => new Date(Date.now() - 1)),
      } as unknown as Pick<ChangeFeedRepository, 'renewLease'>,
      leaseOwner: 'worker-1',
      leaseSeconds: 30,
      signal: new AbortController().signal,
      assertWriterLockHeld: jest.fn(async () => undefined),
    });

    renewal.add([event('30')]);
    jest.advanceTimersByTime(10_000);

    await expect(renewal.checkpoint()).rejects.toThrow('uncertain expiry');
    renewal.stop();
  });

  it('aborts pending work when the sync signal is cancelled', async () => {
    const controller = new AbortController();
    const renewal = new InventoryChangeFeedLeaseRenewal({
      ledger: {
        renewLease: jest.fn(async () => new Date(Date.now() + 60_000)),
      } as unknown as Pick<ChangeFeedRepository, 'renewLease'>,
      leaseOwner: 'worker-1',
      leaseSeconds: 30,
      signal: controller.signal,
      assertWriterLockHeld: jest.fn(async () => undefined),
    });

    renewal.add([event('40')]);
    controller.abort(new Error('cancelled by caller'));

    await expect(renewal.checkpoint()).rejects.toThrow('cancelled by caller');
  });
});

function event(eventSeq: string): ClaimedChangeFeedEvent {
  return {
    eventSeq,
    providerEventId: `evt-${eventSeq}`,
    eventType: 'inventory.item_updated',
    apiVersion: 'v3',
    objectType: 'inventory',
    objectId: `00000000-0000-4000-8000-${eventSeq.padStart(12, '0')}`,
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    receivedAt: new Date('2026-01-01T00:00:01Z'),
    rawBody: Buffer.from('{}'),
    parsedPayload: {},
    attemptCount: 1,
    leasedUntil: new Date(Date.now() + 30_000),
    leaseToken: `token-${eventSeq}`,
  };
}
