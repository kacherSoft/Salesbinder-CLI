import { AxiosError } from 'axios';
import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import { CACHE_SCHEMA_VERSION } from '../types.js';
import {
  V3InventoryIndexerService,
  type V3InventoryClient,
} from '../v3-inventory-indexer.service.js';

describe('V3InventoryIndexerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes archived-complete items and authoritative variation-location balances atomically', async () => {
    const item = v3Item({
      variation_count: 1,
      archived: true,
      category_id: 'category-1',
      category_name: 'Stale source name',
    });
    const variation = v3Variation();
    const list = jest.fn(async () => page([item]));
    const listVariations = jest.fn(async () => page([variation]));
    const get = jest.fn(async () => item);
    const published: any[] = [];
    const cache = fakeCache({
      getCategorySnapshot: jest.fn(async () => ({
        rows: [{ category_id: 'category-1', name: 'Canonical category' }],
      })),
      replaceInventorySnapshot: async (snapshot: unknown) => {
        published.push(snapshot);
      },
    });
    const service = new V3InventoryIndexerService(
      { items: { list, get, listVariations } },
      cache,
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(list).toHaveBeenCalledWith({
      page: 1,
      limit: 100,
      archived: 'all',
      include_sold: true,
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(listVariations).toHaveBeenCalledWith(item.id, {
      page: 1,
      limit: 100,
      include: 'locations',
    });
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ itemsProcessed: 1, stockRowsProcessed: 1, recordIssues: [] });
    expect(published).toHaveLength(1);
    expect(published[0].items[0]).toMatchObject({
      item_id: item.id,
      archived: 1,
      quantity_reserved: 3,
      quantity_available: null,
      quantity_incoming: 5,
      in_transit: 2,
      category_name: 'Canonical category',
      source_api_version: '3',
    });
    expect(published[0].stockRows[0]).toMatchObject({
      stock_row_id: '42',
      variation_location_id: '42',
      quantity_on_hand: 12,
      quantity_reserved: 3,
      quantity_available: null,
      quantity_incoming: 5,
      in_transit: 2,
      source_api_version: '3',
      category_name: 'Canonical category',
    });
    expect(published[0].meta).toMatchObject({
      accountIdentity: 'salesbinder:acme',
      sourceApiVersion: '3',
      version: 2,
      status: 'complete',
      itemCount: 1,
      stockRowCount: 1,
      freshItemCount: 1,
      preservedItemCount: 0,
      omittedItemCount: 0,
      warningCount: 0,
      lastCompleteAt: expect.any(Number),
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [1, 2],
    [0, 1],
  ])(
    'treats variation_count=%i as advisory when the endpoint returns %i rows',
    async (declaredCount, fetchedCount) => {
      const item = v3Item({ variation_count: declaredCount });
      const variations = Array.from({ length: fetchedCount }, (_, index) =>
        v3Variation({
          id: `variation-${index + 1}`,
          locations: [
            {
              ...v3Variation().locations![0],
              item_variation_location_id: 42 + index,
            },
          ],
        })
      );
      const replaceInventorySnapshot = jest.fn(async () => undefined);
      const listVariations = jest.fn(async () => page(variations));
      const service = new V3InventoryIndexerService(
        { items: { list: jest.fn(async () => page([item])), get: jest.fn(), listVariations } },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      await expect(service.sync()).resolves.toMatchObject({ stockRowsProcessed: fetchedCount });
      expect(listVariations).toHaveBeenCalledTimes(2);
      expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps archived legacy records with blank names and PostgreSQL-invalid optional NUL text', async () => {
    const item = v3Item({
      item_number: 22066,
      name: '\n',
      serial_number: 'Holex',
      description: 'Stereoscopic Zoom Microscope\0( Kính hiển vi soi nổi )',
      archived: true,
    });
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).resolves.toMatchObject({ itemsProcessed: 1 });
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            name: 'Holex',
            description: 'Stereoscopic Zoom Microscope( Kính hiển vi soi nổi )',
            archived: 1,
          }),
        ],
      })
    );
  });

  describe.each([
    ['sku', 'NUL', 'SKU\0-1'],
    ['sku', 'C0 U+0001', 'SKU\u0001-1'],
    ['sku', 'DEL U+007F', 'SKU\u007f-1'],
    ['serial_number', 'NUL', 'SERIAL\0-1'],
    ['serial_number', 'C0 U+0001', 'SERIAL\u0001-1'],
    ['serial_number', 'DEL U+007F', 'SERIAL\u007f-1'],
    ['barcode', 'NUL', 'BAR\0-1'],
    ['barcode', 'C0 U+0001', 'BAR\u0001-1'],
    ['barcode', 'DEL U+007F', 'BAR\u007f-1'],
  ] as const)('item %s %s validation', (field, _control, invalidValue) => {
    it('omits a new record when the invalid business identifier persists through recovery', async () => {
      const item = v3Item({ [field]: invalidValue });
      const listVariations = jest.fn(async () => page([]));
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([item])),
            get: jest.fn(async () => item),
            listVariations,
          },
        },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: item.id,
          code: 'invalid_record',
          attempts: 2,
          outcome: 'omitted_new',
        }),
      ]);
      expect(listVariations).toHaveBeenCalledTimes(3);
      expect(replaceInventorySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ items: [], stockRows: [] })
      );
    });

    it('recovers cleanly when the detail retry returns a valid business identifier', async () => {
      const invalid = v3Item({ [field]: invalidValue });
      const recovered = v3Item({ [field]: `${field}-recovered` });
      const get = jest.fn(async () => recovered);
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([invalid])),
            get,
            listVariations: jest.fn(async () => page([])),
          },
        },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(get).toHaveBeenCalledTimes(1);
      expect(result.recordIssues).toEqual([]);
      expect(replaceInventorySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [
            expect.objectContaining({ item_id: recovered.id, [field]: `${field}-recovered` }),
          ],
        })
      );
    });
  });

  it.each([
    ['sku', 'NUL', 'BAD\0SKU'],
    ['sku', 'C0 U+0001', 'BAD\u0001SKU'],
    ['sku', 'DEL U+007F', 'BAD\u007fSKU'],
    ['serial_number', 'NUL', 'BAD\0SERIAL'],
    ['serial_number', 'C0 U+0001', 'BAD\u0001SERIAL'],
    ['serial_number', 'DEL U+007F', 'BAD\u007fSERIAL'],
    ['barcode', 'NUL', 'BAD\0BAR'],
    ['barcode', 'C0 U+0001', 'BAD\u0001BAR'],
    ['barcode', 'DEL U+007F', 'BAD\u007fBAR'],
  ] as const)(
    'preserves the full last-known-good bundle when item %s %s persists',
    async (field, _control, invalidValue) => {
      const item = v3Item({ [field]: invalidValue });
      const priorItem = {
        item_id: item.id,
        item_number: item.item_number,
        name: 'Last known good',
        quantity: 9,
        quantity_reserved: 1,
        quantity_available: 8,
        quantity_incoming: 2,
        in_transit: null,
        threshold: 1,
        cost: 2,
        price: 3,
        published: 1,
        archived: 0,
        sku: 'OLD-SKU',
        serial_number: 'OLD-SERIAL',
        barcode: 'OLD-BAR',
        category_id: 'category-1',
        category_name: 'Old category',
        created: '2026-01-01T00:00:00Z',
        modified: 1767312000,
        cache_source: 'api',
        source_api_version: '3',
      };
      const priorStock = {
        stock_row_id: 'old-stock',
        item_id: item.id,
        item_number: item.item_number,
        location_id: 'location-1',
        location_name: 'Warehouse',
        quantity_on_hand: 9,
        quantity_reserved: 1,
        quantity_available: 8,
        quantity_incoming: 2,
        in_transit: 0,
        category_name: 'Old category',
        price: 3,
        cost: 2,
        barcode: 'OLD-BAR',
        cache_source: 'api',
        source_api_version: '3',
      };
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([item])),
            get: jest.fn(async () => item),
            listVariations: jest.fn(async () => page([])),
          },
        },
        fakeCache({
          getInventorySnapshot: jest.fn(async () => ({
            items: [priorItem],
            stockRows: [priorStock],
            meta: {
              version: 2,
              status: 'complete',
              accountIdentity: 'salesbinder:acme',
              startedAt: 10,
              completedAt: 20,
              itemCount: 1,
              stockRowCount: 1,
              freshItemCount: 1,
              preservedItemCount: 0,
              omittedItemCount: 0,
              warningCount: 0,
              lastCompleteAt: 20,
              schemaVersion: 7,
              sourceApiVersion: '3',
              generation: 'old',
              fingerprint: 'sha256:old',
            },
          })),
          replaceInventorySnapshot,
        }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: item.id,
          code: 'invalid_record',
          attempts: 2,
          outcome: 'preserved_last_known_good',
        }),
      ]);
      const snapshot = replaceInventorySnapshot.mock.calls[0][0];
      expect(snapshot.items).toEqual([{ ...priorItem, category_name: 'Old category' }]);
      expect(snapshot.stockRows).toEqual([{ ...priorStock, category_name: 'Old category' }]);
      expect(snapshot.meta).toMatchObject({
        status: 'complete_with_warnings',
        freshItemCount: 0,
        preservedItemCount: 1,
        omittedItemCount: 0,
        warningCount: 1,
        lastCompleteAt: 20,
      });
    }
  );

  it('keeps blank names invalid for active items', async () => {
    const item = v3Item({ name: '\n', archived: false });
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const get = jest.fn(async () => item);
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get,
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();
    expect(result.recordIssues).toEqual([
      expect.objectContaining({ id: item.id, code: 'invalid_record', outcome: 'omitted_new' }),
    ]);
  });

  it('completes after atomic snapshot replacement without post-commit cache state calls', async () => {
    const item = v3Item();
    const terminalOrder: string[] = [];
    const replaceInventorySnapshot = jest.fn(async () => {
      terminalOrder.push('replace');
    });
    const getItemCount = jest.fn(async () => {
      throw new Error('Post-commit item count read must not run');
    });
    const getStockLocationCount = jest.fn(async () => {
      throw new Error('Post-commit stock count read must not run');
    });
    const setCacheState = jest.fn(async () => {
      throw new Error('Post-commit cache state write must not run');
    });
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({
        replaceInventorySnapshot,
        getItemCount,
        getStockLocationCount,
        setCacheState,
      }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync({
      onProgressEvent: (event) => {
        events.push(event);
        if (event.event === 'phase_completed') terminalOrder.push('phase_completed');
      },
    });

    expect(result).toEqual({ itemsProcessed: 1, stockRowsProcessed: 1, recordIssues: [] });
    expect(terminalOrder).toEqual(['replace', 'phase_completed']);
    expect(getItemCount).not.toHaveBeenCalled();
    expect(getStockLocationCount).not.toHaveBeenCalled();
    expect(setCacheState).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ event: 'phase_completed' });
  });

  it('emits stable pass progress in exact chronological order while the root preflight stays silent', async () => {
    const item = v3Item();
    const list = jest.fn(async () => page([item]));
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      {
        items: {
          list,
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot: jest.fn(async () => undefined) }),
      'default',
      'salesbinder:acme'
    );

    await service.sync({ onProgressEvent: (event) => events.push(event) });

    expect(list).toHaveBeenCalledTimes(3);
    expect(
      events.map(({ event, pass, page: pageNumber }) => [event, pass ?? null, pageNumber ?? null])
    ).toEqual([
      ['phase_started', null, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 2, null],
      ['page_started', 2, 1],
      ['page_completed', 2, 1],
      ['record_processed', 2, null],
      ['pass_completed', 2, null],
      ['phase_completed', null, null],
    ]);
  });

  it('heartbeats during a delayed buffered root read without leaking tentative progress', async () => {
    jest.useFakeTimers();
    const item = v3Item();
    const delayedRoot = deferred<V3ListResponse<V3Item>>();
    const list = jest
      .fn(async () => page([item]))
      .mockResolvedValueOnce(page([item]))
      .mockReturnValueOnce(delayedRoot.promise);
    const heartbeat = jest.fn();
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      {
        items: {
          list,
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot: jest.fn(async () => undefined) }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({
      onProgressEvent: (event) => events.push(event),
      onProgressHeartbeat: heartbeat,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(list).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(44_999);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    delayedRoot.resolve(page([item]));
    await expect(sync).resolves.toEqual({
      itemsProcessed: 1,
      stockRowsProcessed: 1,
      recordIssues: [],
    });

    expect(
      events.map(({ event, pass, page: pageNumber }) => [event, pass ?? null, pageNumber ?? null])
    ).toEqual([
      ['phase_started', null, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 2, null],
      ['page_started', 2, 1],
      ['page_completed', 2, 1],
      ['record_processed', 2, null],
      ['pass_completed', 2, null],
      ['phase_completed', null, null],
    ]);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('keeps heartbeat cadence continuous across sub-interval root reads and snapshot retry backoff', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const before = v3Item({ id: 'item-before' });
    const after = v3Item({ id: 'item-after' });
    const stable = v3Item({ id: 'item-stable' });
    const roots = [before, after, stable, stable, stable];
    let rootIndex = 0;
    const list = jest.fn(
      () =>
        new Promise<V3ListResponse<V3Item>>((resolve) => {
          const root = roots[rootIndex++]!;
          setTimeout(() => resolve(page([root])), 40_000);
        })
    );
    const heartbeatTimes: number[] = [];
    const heartbeat = jest.fn(() => heartbeatTimes.push(Date.now()));
    const events: CacheSyncProgress[] = [];
    const listVariations = jest.fn(async () => page([]));
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({
      onProgressEvent: (event) => events.push(event),
      onProgressHeartbeat: heartbeat,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(list).toHaveBeenCalledTimes(1);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);
    expect(jest.getTimerCount()).toBe(2);

    await jest.advanceTimersByTimeAsync(40_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(heartbeatTimes).toEqual([]);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(heartbeatTimes).toEqual([45_000]);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(35_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(list).toHaveBeenCalledTimes(3);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(8_000);
    expect(heartbeatTimes).toEqual([45_000, 90_000]);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(32_000);
    expect(list).toHaveBeenCalledTimes(4);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(13_000);
    expect(heartbeatTimes).toEqual([45_000, 90_000, 135_000]);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(26_999);
    expect(Date.now()).toBe(161_999);
    expect(list).toHaveBeenCalledTimes(4);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    await jest.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(5);
    expect(events.filter(({ event }) => event === 'pass_started').map(({ pass }) => pass)).toEqual([
      1,
    ]);
    expect(
      events.filter(({ event }) => event === 'pass_completed').map(({ pass }) => pass)
    ).toEqual([1]);

    await jest.advanceTimersByTimeAsync(18_000);
    expect(heartbeatTimes).toEqual([45_000, 90_000, 135_000, 180_000]);
    expect(events.some(({ pass }) => pass === 2)).toBe(false);

    await jest.advanceTimersByTimeAsync(22_000);
    await expect(sync).resolves.toEqual({
      itemsProcessed: 1,
      stockRowsProcessed: 1,
      recordIssues: [],
    });

    expect(list).toHaveBeenCalledTimes(5);
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(heartbeatTimes).toEqual([45_000, 90_000, 135_000, 180_000]);
    expect(
      events.map(({ event, pass, page: pageNumber }) => [event, pass ?? null, pageNumber ?? null])
    ).toEqual([
      ['phase_started', null, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 2, null],
      ['page_started', 2, 1],
      ['page_completed', 2, 1],
      ['record_processed', 2, null],
      ['pass_completed', 2, null],
      ['phase_completed', null, null],
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('clears the heartbeat timer when a delayed buffered root read fails', async () => {
    jest.useFakeTimers();
    const item = v3Item();
    const failure = new Error('root unavailable');
    const delayedRoot = deferred<V3ListResponse<V3Item>>();
    const list = jest
      .fn(async () => page([item]))
      .mockResolvedValueOnce(page([item]))
      .mockReturnValueOnce(delayedRoot.promise);
    const heartbeat = jest.fn();
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      {
        items: {
          list,
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot: jest.fn() }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({
      onProgressEvent: (event) => events.push(event),
      onProgressHeartbeat: heartbeat,
    });
    const rejection = expect(sync).rejects.toBe(failure);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(45_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);

    delayedRoot.reject(failure);
    await rejection;

    expect(list).toHaveBeenCalledTimes(2);
    expect(events.map(({ event }) => event)).toEqual(['phase_started']);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('recovers equal-count item content drift with one canonical detail read', async () => {
    const before = v3Item({ name: 'Before', cost: '2.0000', quantity: 4, quantity_reserved: 1 });
    const after = v3Item({ name: 'After', cost: '3.0000', quantity: 9, quantity_reserved: 2 });
    const recovered = v3Item({ name: 'Recovered', cost: '4.0000', quantity: 7 });
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([before]))
      .mockResolvedValueOnce(page([before]))
      .mockResolvedValueOnce(page([after]));
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list,
          get: jest.fn(async () => recovered),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(list).toHaveBeenCalledTimes(3);
    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ item_id: recovered.id, name: 'Recovered', quantity: 7 })],
      })
    );
  });

  it('recovers a root change that lands after pass-one variations without publishing a temporal hybrid', async () => {
    const oldItem = v3Item({ name: 'Old root', quantity: 4, variation_count: 1 });
    const changedItem = v3Item({ name: 'Changed root', quantity: 12, variation_count: 1 });
    const changedVariation = v3Variation({
      item_id: changedItem.id,
      barcode: 'CHANGED-VARIATION',
      quantity: 12,
      locations: [
        {
          ...v3Variation().locations![0],
          quantity: 12,
        },
      ],
    });
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([oldItem]))
      .mockResolvedValueOnce(page([oldItem]))
      .mockResolvedValueOnce(page([changedItem]));
    const get = jest.fn(async () => changedItem);
    const listVariations = jest.fn(async (_itemId: string) => page([changedVariation]));
    const replaceInventorySnapshot = jest.fn(async (_snapshot: any) => undefined);
    const service = new V3InventoryIndexerService(
      { items: { list, get, listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).resolves.toEqual({
      itemsProcessed: 1,
      stockRowsProcessed: 1,
      recordIssues: [],
    });

    expect(list).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(1);
    expect(listVariations).toHaveBeenCalledTimes(3);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    const snapshot = replaceInventorySnapshot.mock.calls[0]![0];
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        item_id: changedItem.id,
        name: 'Changed root',
        quantity: 12,
      }),
    ]);
    expect(snapshot.stockRows).toEqual([
      expect.objectContaining({
        item_id: changedItem.id,
        barcode: 'CHANGED-VARIATION',
        quantity_on_hand: 12,
      }),
    ]);
    expect(snapshot.items).not.toEqual([
      expect.objectContaining({ item_id: oldItem.id, name: 'Old root' }),
    ]);
  });

  it('recovers nested variation-location content drift', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const listVariations = jest
      .fn()
      .mockResolvedValueOnce(page([v3Variation()]))
      .mockResolvedValueOnce(
        page([
          v3Variation({
            quantity: 13,
            locations: [
              {
                ...v3Variation().locations![0],
                quantity: 13,
              },
            ],
          }),
        ])
      )
      .mockResolvedValueOnce(page([v3Variation()]));
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(async () => item),
          listVariations,
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();
    expect(result.recordIssues).toEqual([]);
    expect(listVariations).toHaveBeenCalledTimes(3);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['quantity', 'quantity_reserved', 'quantity_incoming', 'in_transit'] as const)(
    'retries a stable variation %s aggregate mismatch once as invalid variations',
    async (field) => {
      const item = v3Item({ variation_count: 1 });
      const mismatch = {
        ...decimalLocationVariation(item),
        [field]: 0.4,
      } as V3ItemVariation;
      const get = jest.fn(async () => item);
      const listVariations = jest.fn(async () => page([mismatch]));
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([item])),
            get,
            listVariations,
          },
        },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(get).toHaveBeenCalledTimes(1);
      expect(listVariations).toHaveBeenCalledTimes(3);
      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: item.id,
          code: 'invalid_variations',
          attempts: 2,
          outcome: 'omitted_new',
        }),
      ]);
      expect(replaceInventorySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ items: [], stockRows: [] })
      );
    }
  );

  it('retries an overflowing variation in-transit total and preserves or omits per item', async () => {
    const preserved = v3Item({
      id: 'item-preserve',
      item_number: 1,
      variation_count: 2,
    });
    const omitted = v3Item({ id: 'item-omit', item_number: 2, variation_count: 2 });
    const valid = v3Item({ id: 'item-valid', item_number: 3 });
    const overflowVariations = (item: V3Item) => [
      v3Variation({
        id: `${item.id}-variation-a`,
        item_id: item.id,
        in_transit: Number.MAX_VALUE,
        location_count: 0,
        locations: undefined,
      }),
      v3Variation({
        id: `${item.id}-variation-b`,
        item_id: item.id,
        in_transit: Number.MAX_VALUE,
        location_count: 0,
        locations: undefined,
      }),
    ];
    const get = jest.fn(async (id: string) =>
      id === preserved.id ? preserved : id === omitted.id ? omitted : valid
    );
    const listVariations = jest.fn(async (id: string) =>
      page(id === valid.id ? [] : overflowVariations(id === preserved.id ? preserved : omitted))
    );
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: preserved.id,
      item_number: 1,
      name: 'Last known good',
      quantity: 9,
      archived: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const priorStock = {
      stock_row_id: 'old-stock',
      item_id: preserved.id,
      item_number: 1,
      quantity_on_hand: 9,
      quantity_reserved: 0,
      quantity_available: 9,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([preserved, omitted, valid])),
          get,
          listVariations,
        },
      },
      fakeCache({
        getInventorySnapshot: jest.fn(async () => ({
          items: [priorItem],
          stockRows: [priorStock],
          meta: {
            version: 1,
            status: 'complete',
            accountIdentity: 'salesbinder:acme',
            startedAt: 10,
            completedAt: 20,
            itemCount: 1,
            stockRowCount: 1,
            schemaVersion: 7,
            sourceApiVersion: '3',
            generation: 'old',
            fingerprint: 'sha256:old',
          },
        })),
        replaceInventorySnapshot,
      }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get.mock.calls.map(([id]) => id)).toEqual(['item-omit', 'item-preserve']);
    expect(listVariations).toHaveBeenCalledTimes(8);
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: omitted.id,
        code: 'invalid_variations',
        attempts: 2,
        outcome: 'omitted_new',
      }),
      expect.objectContaining({
        id: preserved.id,
        code: 'invalid_variations',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ item_id: preserved.id, name: 'Last known good' }),
          expect.objectContaining({ item_id: valid.id }),
        ]),
      })
    );
  });

  it('retries a null variation location once, omits it, and publishes a valid peer', async () => {
    const malformed = v3Item({ id: 'item-malformed', item_number: 1, variation_count: 1 });
    const valid = v3Item({ id: 'item-valid', item_number: 2 });
    const malformedVariation = v3Variation({
      id: 'variation-malformed',
      item_id: malformed.id,
      locations: [null] as unknown as V3ItemVariation['locations'],
    });
    const get = jest.fn(async (id: string) => (id === malformed.id ? malformed : valid));
    const listVariations = jest.fn(async (id: string) =>
      page(id === malformed.id ? [malformedVariation] : [])
    );
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([malformed, valid])),
          get,
          listVariations,
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(listVariations).toHaveBeenCalledTimes(5);
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: malformed.id,
        code: 'invalid_variations',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ item_id: valid.id })],
        stockRows: [expect.objectContaining({ item_id: valid.id })],
      })
    );
  });

  it('recovers a visible-location aggregate mismatch with decimal-safe totals', async () => {
    const item = v3Item({ variation_count: 1 });
    const mismatch = decimalLocationVariation(item, { quantity: 0.4 });
    const recovered = decimalLocationVariation(item);
    const get = jest.fn(async () => item);
    const listVariations = jest
      .fn()
      .mockResolvedValueOnce(page([mismatch]))
      .mockResolvedValueOnce(page([mismatch]))
      .mockResolvedValueOnce(page([recovered]));
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get,
          listVariations,
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(listVariations).toHaveBeenCalledTimes(3);
    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        stockRows: [
          expect.objectContaining({ quantity_on_hand: 0.1 }),
          expect.objectContaining({ quantity_on_hand: 0.2 }),
        ],
      })
    );
  });

  it('keeps aggregate fallback compatible when variation locations are absent', async () => {
    const item = v3Item({ variation_count: 1 });
    const variation = v3Variation({
      item_id: item.id,
      location_count: 0,
      locations: undefined,
    });
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([variation])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        stockRows: [
          expect.objectContaining({
            variation_location_id: null,
            quantity_on_hand: variation.quantity,
          }),
        ],
      })
    );
  });

  it.each([
    ['NUL', '\0'],
    ['C0 U+0001', '\u0001'],
    ['DEL U+007F', '\u007f'],
  ])(
    'marks persistent variation barcode %s text invalid without falling back to parent barcode',
    async (_control, invalidBarcode) => {
      const item = v3Item({ barcode: 'PARENT-BAR', variation_count: 1 });
      const variation = v3Variation({
        barcode: invalidBarcode,
        item_id: item.id,
        locations: undefined,
        location_count: 0,
      });
      const listVariations = jest.fn(async () => page([variation]));
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([item])),
            get: jest.fn(async () => item),
            listVariations,
          },
        },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(result.recordIssues).toEqual([
        expect.objectContaining({
          id: item.id,
          code: 'invalid_variations',
          attempts: 2,
          outcome: 'omitted_new',
        }),
      ]);
      expect(listVariations).toHaveBeenCalledTimes(3);
      expect(replaceInventorySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ items: [], stockRows: [] })
      );
      const snapshotText = JSON.stringify(replaceInventorySnapshot.mock.calls[0][0]);
      expect(snapshotText).not.toContain('PARENT-BAR');
    }
  );

  it.each([
    ['NUL', '\0'],
    ['C0 U+0001', '\u0001'],
    ['DEL U+007F', '\u007f'],
  ])(
    'recovers cleanly when variation barcode %s text is fixed by the detail retry',
    async (_control, invalidBarcode) => {
      const item = v3Item({ barcode: 'PARENT-BAR', variation_count: 1 });
      const invalidVariation = v3Variation({
        barcode: invalidBarcode,
        item_id: item.id,
        locations: undefined,
        location_count: 0,
      });
      const recoveredVariation = v3Variation({
        barcode: 'VAR-BAR',
        item_id: item.id,
        locations: undefined,
        location_count: 0,
      });
      const listVariations = jest
        .fn()
        .mockResolvedValueOnce(page([invalidVariation]))
        .mockResolvedValueOnce(page([invalidVariation]))
        .mockResolvedValueOnce(page([recoveredVariation]));
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        {
          items: {
            list: jest.fn(async () => page([item])),
            get: jest.fn(async () => item),
            listVariations,
          },
        },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const result = await service.sync();

      expect(result.recordIssues).toEqual([]);
      expect(listVariations).toHaveBeenCalledTimes(3);
      expect(replaceInventorySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          stockRows: [expect.objectContaining({ barcode: 'VAR-BAR' })],
        })
      );
    }
  );

  it('publishes an omitted warning when a variation snapshot remains incomplete after recovery', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const client: V3InventoryClient = {
      items: {
        list: jest.fn(async () => page([item])),
        get: jest.fn(async () => item),
        listVariations: jest.fn(async () => page([], { total_records: 1 })),
      },
    };
    const service = new V3InventoryIndexerService(
      client,
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();
    expect(result.recordIssues).toEqual([
      {
        resource: 'item',
        id: item.id,
        code: 'invalid_variations',
        message: 'Item variations failed source validation',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [],
        stockRows: [],
        meta: expect.objectContaining({ status: 'complete_with_warnings', omittedItemCount: 1 }),
      })
    );
  });

  it('retries stable duplicate variation-location rows once and publishes valid or preserved bundles', async () => {
    const valid = v3Item({ id: 'item-valid', item_number: 1, name: 'Valid' });
    const preserved = v3Item({ id: 'item-preserve', item_number: 2, variation_count: 1 });
    const omitted = v3Item({ id: 'item-omit', item_number: 3, variation_count: 1 });
    const duplicateRows = (item: V3Item) =>
      v3Variation({
        id: `${item.id}-variation`,
        item_id: item.id,
        location_count: 2,
        locations: [
          {
            ...v3Variation().locations![0],
            item_variation_location_id: 77,
            location_id: 'location-a',
          },
          {
            ...v3Variation().locations![0],
            item_variation_location_id: 77,
            location_id: 'location-b',
          },
        ],
      });
    const get = jest.fn(async (id: string) =>
      id === preserved.id ? preserved : id === omitted.id ? omitted : valid
    );
    const listVariations = jest.fn(async (itemId: string) => {
      if (itemId === valid.id) return page([]);
      const item = itemId === preserved.id ? preserved : omitted;
      return page([duplicateRows(item)]);
    });
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: preserved.id,
      item_number: preserved.item_number,
      name: 'Last known good',
      quantity: 9,
      archived: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const priorStock = {
      stock_row_id: 'old-stock',
      item_id: preserved.id,
      item_number: preserved.item_number,
      quantity_on_hand: 9,
      quantity_reserved: 0,
      quantity_available: 9,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([valid, preserved, omitted])),
          get,
          listVariations,
        },
      },
      fakeCache({
        getInventorySnapshot: jest.fn(async () => ({
          items: [priorItem],
          stockRows: [priorStock],
          meta: {
            version: 1,
            status: 'complete',
            accountIdentity: 'salesbinder:acme',
            startedAt: 10,
            completedAt: 20,
            itemCount: 1,
            stockRowCount: 1,
            schemaVersion: 7,
            sourceApiVersion: '3',
            generation: 'old',
            fingerprint: 'sha256:old',
          },
        })),
        replaceInventorySnapshot,
        getItemCount: jest.fn(async () => 2),
        getStockLocationCount: jest.fn(async () => 2),
      }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get.mock.calls.map(([id]) => id)).toEqual(['item-omit', 'item-preserve']);
    expect(listVariations).toHaveBeenCalledTimes(8);
    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: omitted.id,
        code: 'invalid_variations',
        attempts: 2,
        outcome: 'omitted_new',
      }),
      expect.objectContaining({
        id: preserved.id,
        code: 'invalid_variations',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      }),
    ]);
    const snapshot = replaceInventorySnapshot.mock.calls[0][0];
    expect(snapshot.items.map((row: { item_id: string }) => row.item_id)).toEqual([
      preserved.id,
      valid.id,
    ]);
    expect(snapshot.stockRows).toContainEqual({ ...priorStock, category_name: null });
    expect(snapshot.meta).toMatchObject({
      status: 'complete_with_warnings',
      freshItemCount: 1,
      preservedItemCount: 1,
      omittedItemCount: 1,
      warningCount: 2,
    });
  });

  it('rejects a warning composition that would preserve a prior item without stock rows', async () => {
    const item = v3Item({ variation_count: 1 });
    const get = jest.fn(async () => item);
    const listVariations = jest.fn(async () => page([], { total_records: 1 }));
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: item.id,
      item_number: item.item_number,
      name: 'Partial prior item',
      quantity: 9,
      archived: 0,
      cache_source: 'api' as const,
      source_api_version: '3' as const,
    };
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get,
          listVariations,
        },
      },
      fakeCache({
        getInventorySnapshot: jest.fn(async () => ({
          items: [priorItem],
          stockRows: [],
          meta: {
            version: 1,
            status: 'complete',
            accountIdentity: 'salesbinder:acme',
            startedAt: 10,
            completedAt: 20,
            itemCount: 1,
            stockRowCount: 0,
            schemaVersion: 7,
            sourceApiVersion: '3',
            generation: 'partial',
            fingerprint: 'sha256:partial',
          },
        })),
        replaceInventorySnapshot,
      }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toThrow(/item.*stock row/i);

    expect(get).toHaveBeenCalledTimes(1);
    expect(listVariations).toHaveBeenCalledTimes(3);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps duplicate variation-location rows across different items fatal', async () => {
    const first = v3Item({ id: 'item-first', item_number: 1, variation_count: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2, variation_count: 1 });
    const variationFor = (item: V3Item) =>
      v3Variation({
        id: `${item.id}-variation`,
        item_id: item.id,
        locations: [
          {
            ...v3Variation().locations![0],
            item_variation_location_id: 77,
          },
        ],
      });
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([first, second])),
          get: jest.fn(),
          listVariations: jest.fn(async (itemId: string) =>
            page([variationFor(itemId === first.id ? first : second)])
          ),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toThrow(/duplicate.*stock row/i);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps inconsistent root page totals fatal', async () => {
    const replaceInventorySnapshot = jest.fn();
    const incompleteService = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => ({
            ...page([v3Item()], {
              per_page: 100,
              total_pages: 2,
              total_records: 101,
            }),
            has_more: true,
          })),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(incompleteService.sync()).rejects.toThrow(/Incomplete v3 items page 1/);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when initial preflight membership drift exhausts all stability attempts', async () => {
    jest.useFakeTimers();
    const replaceInventorySnapshot = jest.fn();
    const listVariations = jest.fn(async (_itemId: string) => page([]));
    const heartbeat = jest.fn();
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([v3Item({ id: 'item-first-a' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-second-a' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-first-b' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-second-b' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-first-c' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-second-c' })]));
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({ onProgressHeartbeat: heartbeat });
    const rejection = expect(sync).rejects.toThrow(/stability verification/i);
    await jest.runAllTimersAsync();
    await rejection;

    expect(list).toHaveBeenCalledTimes(6);
    expect(listVariations).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('retries transient equal-count item membership drift before reading variations', async () => {
    jest.useFakeTimers();
    const stable = v3Item({ id: 'item-stable' });
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const listVariations = jest.fn(async () => page([]));
    const events: CacheSyncProgress[] = [];
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([v3Item({ id: 'item-before' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-after' })]))
      .mockResolvedValueOnce(page([stable]))
      .mockResolvedValueOnce(page([stable]))
      .mockResolvedValueOnce(page([stable]));
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({ onProgressEvent: (event) => events.push(event) });
    await jest.runAllTimersAsync();
    await expect(sync).resolves.toMatchObject({ itemsProcessed: 1, recordIssues: [] });

    expect(list).toHaveBeenCalledTimes(5);
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(Math.min(...listVariations.mock.invocationCallOrder)).toBeGreaterThan(
      list.mock.invocationCallOrder[3]
    );
    expect(list.mock.invocationCallOrder[4]).toBeGreaterThan(
      listVariations.mock.invocationCallOrder[0]
    );
    expect(listVariations.mock.invocationCallOrder[1]).toBeGreaterThan(
      list.mock.invocationCallOrder[4]
    );
    expect(
      events.map(({ event, pass, page: pageNumber }) => [event, pass ?? null, pageNumber ?? null])
    ).toEqual([
      ['phase_started', null, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 2, null],
      ['page_started', 2, 1],
      ['page_completed', 2, 1],
      ['record_processed', 2, null],
      ['pass_completed', 2, null],
      ['phase_completed', null, null],
    ]);
    expect(events.filter(({ event }) => event === 'pass_started').map(({ pass }) => pass)).toEqual([
      1, 2,
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('retries cross-pass membership drift after one pass-one variation scan', async () => {
    jest.useFakeTimers();
    const before = v3Item({ id: 'item-before' });
    const after = v3Item({ id: 'item-after' });
    const stable = v3Item({ id: 'item-stable' });
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([before]))
      .mockResolvedValueOnce(page([before]))
      .mockResolvedValueOnce(page([after]))
      .mockResolvedValueOnce(page([stable]))
      .mockResolvedValueOnce(page([stable]))
      .mockResolvedValueOnce(page([stable]));
    const listVariations = jest.fn(async (_itemId: string) => page([]));
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({ onProgressEvent: (event) => events.push(event) });
    await jest.runAllTimersAsync();
    await expect(sync).resolves.toMatchObject({ itemsProcessed: 1, recordIssues: [] });

    expect(list).toHaveBeenCalledTimes(6);
    expect(listVariations.mock.calls.map(([itemId]) => itemId)).toEqual([
      before.id,
      stable.id,
      stable.id,
    ]);
    expect(listVariations.mock.invocationCallOrder[0]).toBeGreaterThan(
      list.mock.invocationCallOrder[1]
    );
    expect(list.mock.invocationCallOrder[2]).toBeGreaterThan(
      listVariations.mock.invocationCallOrder[0]
    );
    expect(listVariations.mock.invocationCallOrder[1]).toBeGreaterThan(
      list.mock.invocationCallOrder[4]
    );
    expect(list.mock.invocationCallOrder[5]).toBeGreaterThan(
      listVariations.mock.invocationCallOrder[1]
    );
    expect(listVariations.mock.invocationCallOrder[2]).toBeGreaterThan(
      list.mock.invocationCallOrder[5]
    );
    expect(
      events.map(({ event, pass, page: pageNumber }) => [event, pass ?? null, pageNumber ?? null])
    ).toEqual([
      ['phase_started', null, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 1, null],
      ['page_started', 1, 1],
      ['page_completed', 1, 1],
      ['record_processed', 1, null],
      ['pass_completed', 1, null],
      ['pass_started', 2, null],
      ['page_started', 2, 1],
      ['page_completed', 2, 1],
      ['record_processed', 2, null],
      ['pass_completed', 2, null],
      ['phase_completed', null, null],
    ]);
    expect(events.filter(({ event }) => event === 'pass_started').map(({ pass }) => pass)).toEqual([
      1, 1, 2,
    ]);
    expect(
      events.filter(({ event }) => event === 'pass_completed').map(({ pass }) => pass)
    ).toEqual([1, 1, 2]);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('keeps preflight-to-pass-one root pagination layout drift fatal after bounded retries', async () => {
    jest.useFakeTimers();
    const first = v3Item({ id: 'item-first', item_number: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2 });
    const list = jest.fn(async ({ page: requestedPage }: { page: number }) => {
      const callInAttempt = (list.mock.calls.length - 1) % 3;
      if (callInAttempt === 0) {
        return page([first, second], { per_page: 2, total_pages: 1, total_records: 2 });
      }
      return requestedPage === 1
        ? {
            ...page([first], { page: 1, per_page: 1, total_pages: 2, total_records: 2 }),
            has_more: true,
          }
        : page([second], { page: 2, per_page: 1, total_pages: 2, total_records: 2 });
    });
    const listVariations = jest.fn(async () => page([]));
    const get = jest.fn();
    const replaceInventorySnapshot = jest.fn();
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      { items: { list, get, listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync({ onProgressEvent: (event) => events.push(event) });
    const rejection = expect(sync).rejects.toThrow(
      /root pagination changed during stability verification/i
    );
    await jest.runAllTimersAsync();
    await rejection;

    expect(list).toHaveBeenCalledTimes(9);
    expect(listVariations).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).not.toContain('retry_pass_started');
    expect(events.map(({ event }) => event)).not.toContain('record_failed_collected');
    jest.useRealTimers();
  });

  it('retries a transient root pagination layout drift and publishes only the stable attempt', async () => {
    jest.useFakeTimers();
    const first = v3Item({ id: 'item-first', item_number: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2 });
    const list = jest.fn(async ({ page: requestedPage }: { page: number }) => {
      const call = list.mock.calls.length;
      if (call === 1) {
        return page([first, second], { per_page: 2, total_pages: 1, total_records: 2 });
      }
      if (call === 2) {
        return {
          ...page([first], { page: 1, per_page: 1, total_pages: 2, total_records: 2 }),
          has_more: true,
        };
      }
      if (call === 3 && requestedPage === 2) {
        return page([second], { page: 2, per_page: 1, total_pages: 2, total_records: 2 });
      }
      return page([first, second], { per_page: 2, total_pages: 1, total_records: 2 });
    });
    const listVariations = jest.fn(async () => page([]));
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync();
    await jest.runAllTimersAsync();
    await expect(sync).resolves.toMatchObject({ itemsProcessed: 2 });

    expect(list).toHaveBeenCalledTimes(6);
    expect(listVariations).toHaveBeenCalledTimes(4);
    expect(Math.min(...listVariations.mock.invocationCallOrder)).toBeGreaterThan(
      list.mock.invocationCallOrder[4]
    );
    expect(list.mock.invocationCallOrder[5]).toBeGreaterThan(
      listVariations.mock.invocationCallOrder[1]
    );
    expect(listVariations.mock.invocationCallOrder[2]).toBeGreaterThan(
      list.mock.invocationCallOrder[5]
    );
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('recovers transient intra-pass root pagination metadata drift without reading variations early', async () => {
    jest.useFakeTimers();
    const first = v3Item({ id: 'item-first', item_number: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2 });
    const stable = v3Item({ id: 'item-stable', item_number: 3 });
    const list = jest.fn(async ({ page: requestedPage }: { page: number }) => {
      const call = list.mock.calls.length;
      if (call === 1) {
        return {
          ...page([first], { page: 1, per_page: 1, total_pages: 2, total_records: 2 }),
          has_more: true,
        };
      }
      if (call === 2 && requestedPage === 2) {
        return page([second], { page: 2, per_page: 2, total_pages: 2, total_records: 3 });
      }
      return page([stable]);
    });
    const listVariations = jest.fn(async () => page([]));
    const replaceInventorySnapshot = jest.fn(async () => undefined);
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync();
    await jest.runAllTimersAsync();
    await expect(sync).resolves.toMatchObject({ itemsProcessed: 1, recordIssues: [] });

    expect(list).toHaveBeenCalledTimes(5);
    expect(listVariations).toHaveBeenCalledTimes(2);
    expect(Math.min(...listVariations.mock.invocationCallOrder)).toBeGreaterThan(
      list.mock.invocationCallOrder[3]
    );
    expect(list.mock.invocationCallOrder[4]).toBeGreaterThan(
      listVariations.mock.invocationCallOrder[0]
    );
    expect(listVariations.mock.invocationCallOrder[1]).toBeGreaterThan(
      list.mock.invocationCallOrder[4]
    );
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('does not publish when intra-pass root pagination metadata drift exhausts retries', async () => {
    jest.useFakeTimers();
    const first = v3Item({ id: 'item-first', item_number: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2 });
    const list = jest.fn(async ({ page: requestedPage }: { page: number }) =>
      requestedPage === 1
        ? {
            ...page([first], { page: 1, per_page: 1, total_pages: 2, total_records: 2 }),
            has_more: true,
          }
        : page([second], { page: 2, per_page: 2, total_pages: 2, total_records: 3 })
    );
    const listVariations = jest.fn(async () => page([]));
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const sync = service.sync();
    const rejection = expect(sync).rejects.toThrow('V3 items pagination changed during snapshot');
    await jest.runAllTimersAsync();
    await rejection;

    expect(list).toHaveBeenCalledTimes(6);
    expect(listVariations).not.toHaveBeenCalled();
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('recovers when equal-count variation membership changes between stability passes', async () => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const listVariations = jest
      .fn()
      .mockResolvedValueOnce(page([v3Variation({ id: 'variation-first' })]))
      .mockResolvedValueOnce(page([v3Variation({ id: 'variation-second' })]))
      .mockResolvedValueOnce(page([v3Variation({ id: 'variation-recovered' })]));
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(async () => item),
          listVariations,
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();
    expect(result.recordIssues).toEqual([]);
    expect(listVariations).toHaveBeenCalledTimes(3);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('retries all collected IDs once, preserves only authoritative old bundles, and omits unresolved new items', async () => {
    const valid = v3Item({ id: 'item-valid', item_number: 1, name: 'Valid' });
    const malformed = (id: string, itemNumber: number) =>
      ({
        ...v3Item({ id, item_number: itemNumber, name: id }),
        archived: undefined,
      }) as unknown as V3Item;
    const listed = [
      valid,
      malformed('item-recover', 2),
      malformed('item-preserve', 3),
      malformed('item-omit', 4),
    ];
    const recovered = v3Item({ id: 'item-recover', item_number: 2, name: 'Recovered' });
    const get = jest.fn(async (id: string) => {
      if (id === 'item-omit') return malformed(id, 4);
      if (id === 'item-preserve') throw axiosNotFound();
      return recovered;
    });
    const events: CacheSyncProgress[] = [];
    const replaceInventorySnapshot = jest.fn();
    const priorItem = {
      item_id: 'item-preserve',
      item_number: 3,
      name: 'Old preserved',
      quantity: 9,
      archived: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const priorStock = {
      stock_row_id: 'old-stock',
      item_id: 'item-preserve',
      item_number: 3,
      quantity_on_hand: 9,
      quantity_reserved: 0,
      quantity_available: 9,
      quantity_incoming: 0,
      in_transit: 0,
      cache_source: 'api',
      source_api_version: '3',
    };
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page(listed)),
          get,
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({
        getInventorySnapshot: jest.fn(async () => ({
          items: [priorItem],
          stockRows: [priorStock],
          meta: {
            version: 1,
            status: 'complete',
            accountIdentity: 'salesbinder:acme',
            startedAt: 10,
            completedAt: 20,
            itemCount: 1,
            stockRowCount: 1,
            schemaVersion: 7,
            sourceApiVersion: '3',
            generation: 'old',
            fingerprint: 'sha256:old',
          },
        })),
        replaceInventorySnapshot,
        getItemCount: jest.fn(async () => 3),
        getStockLocationCount: jest.fn(async () => 3),
      }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync({ onProgressEvent: (event) => events.push(event) });

    expect(get.mock.calls.map(([id]) => id)).toEqual([
      'item-omit',
      'item-preserve',
      'item-recover',
    ]);
    expect(result.recordIssues).toEqual([
      {
        resource: 'item',
        id: 'item-omit',
        code: 'invalid_record',
        message: 'Item failed source validation',
        attempts: 2,
        outcome: 'omitted_new',
      },
      {
        resource: 'item',
        id: 'item-preserve',
        code: 'not_found',
        message: 'Item unavailable during refresh',
        attempts: 2,
        outcome: 'preserved_last_known_good',
      },
    ]);
    const snapshot = replaceInventorySnapshot.mock.calls[0][0];
    expect(snapshot.items.map((row: { item_id: string }) => row.item_id).sort()).toEqual([
      'item-preserve',
      'item-recover',
      'item-valid',
    ]);
    expect(
      snapshot.items.find((row: { item_id: string }) => row.item_id === 'item-preserve')
    ).toMatchObject({ name: 'Old preserved', quantity: 9 });
    expect(snapshot.stockRows).toContainEqual({ ...priorStock, category_name: null });
    expect(snapshot.meta).toMatchObject({
      version: 2,
      status: 'complete_with_warnings',
      freshItemCount: 2,
      preservedItemCount: 1,
      omittedItemCount: 1,
      warningCount: 2,
      lastCompleteAt: 20,
    });
    expect(events.filter(({ event }) => event === 'record_retry_failed')).toHaveLength(2);
    expect(events.filter(({ event }) => event === 'record_retry_succeeded')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/item-(?:omit|preserve|recover|valid)/);
  });

  it.each([
    ['response-less Axios failure', new AxiosError('network unavailable')],
    ['cancelled Axios failure', new AxiosError('cancelled', 'ERR_CANCELED')],
    ['plain exception', new Error('unexpected failure')],
  ])('keeps a %s fatal and retains the previous snapshot', async (_label, failure) => {
    const item = v3Item({ variation_count: 1 });
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(),
          listVariations: jest.fn(async () => {
            throw failure;
          }),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toBe(failure);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['membership', 'V3 item membership changed during stability verification'],
    ['pagination', 'V3 items pagination changed during snapshot'],
  ])(
    'keeps a variation client error fatal when its message matches root %s drift',
    async (_driftType, rootDriftMessage) => {
      jest.useFakeTimers();
      const failure = new AxiosError(rootDriftMessage, 'ERR_NETWORK');
      const item = v3Item({ variation_count: 1 });
      const list = jest.fn(async () => page([item]));
      const get = jest.fn();
      const listVariations = jest.fn(async () => {
        throw failure;
      });
      const replaceInventorySnapshot = jest.fn();
      const service = new V3InventoryIndexerService(
        { items: { list, get, listVariations } },
        fakeCache({ replaceInventorySnapshot }),
        'default',
        'salesbinder:acme'
      );

      const sync = service.sync();
      const rejection = expect(sync).rejects.toBe(failure);
      await jest.runAllTimersAsync();
      await rejection;

      expect(list).toHaveBeenCalledTimes(2);
      expect(listVariations).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
      expect(replaceInventorySnapshot).not.toHaveBeenCalled();
      jest.useRealTimers();
    }
  );

  it('recovers malformed item location inventory as a record-local source failure', async () => {
    const malformed = {
      ...v3Item(),
      location_inventory: 'invalid',
    } as unknown as V3Item;
    const recovered = v3Item({ quantity: 8 });
    const replaceInventorySnapshot = jest.fn();
    const get = jest.fn(async () => recovered);
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([malformed])),
          get,
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ item_id: recovered.id, quantity: 8 })],
      })
    );
  });

  it('recovers a mismatched nested location identity before publishing availability', async () => {
    const malformed = v3Item({
      location_id: 'location-a',
      location_inventory: {
        location_id: 'location-b',
        quantity: 12,
        quantity_reserved: 3,
        quantity_available: 9,
        quantity_incoming: 5,
        threshold: 1,
      },
    });
    const recovered = v3Item({
      location_id: 'location-a',
      location_inventory: {
        location_id: 'location-a',
        quantity: 12,
        quantity_reserved: 3,
        quantity_available: 9,
        quantity_incoming: 5,
        threshold: 1,
      },
    });
    const replaceInventorySnapshot = jest.fn();
    const get = jest.fn(async () => recovered);
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([malformed])),
          get,
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ quantity_available: 9 })],
        stockRows: [
          expect.objectContaining({
            location_id: 'location-a',
            quantity_available: 9,
          }),
        ],
      })
    );
  });

  it('omits a new item when nested location numerics remain malformed after recovery', async () => {
    const malformed = v3Item({
      location_id: 'location-a',
      location_inventory: {
        location_id: 'location-a',
        quantity: 12,
        quantity_reserved: 3,
        quantity_available: false as unknown as number,
        quantity_incoming: 5,
        threshold: 1,
      },
    });
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([malformed])),
          get: jest.fn(async () => malformed),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(result.recordIssues).toEqual([
      expect.objectContaining({
        id: malformed.id,
        code: 'invalid_record',
        attempts: 2,
        outcome: 'omitted_new',
      }),
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [],
        stockRows: [],
      })
    );
  });

  it.each([401, 403, 429, 503])('keeps per-item HTTP %s failures fatal', async (status) => {
    const item = v3Item({ variation_count: 1 });
    const failure = axiosFailure(status);
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([item])),
          get: jest.fn(),
          listVariations: jest.fn(async () => {
            throw failure;
          }),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toBe(failure);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps a wrong recovery detail identity fatal', async () => {
    const first = v3Item({ name: 'Before' });
    const second = v3Item({ name: 'After' });
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest
            .fn()
            .mockResolvedValueOnce(page([first]))
            .mockResolvedValueOnce(page([first]))
            .mockResolvedValueOnce(page([second])),
          get: jest.fn(async () => v3Item({ id: 'different-item' })),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toThrow(/identity/i);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps a missing recovery detail identity fatal', async () => {
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest
            .fn()
            .mockResolvedValueOnce(page([v3Item({ name: 'Before' })]))
            .mockResolvedValueOnce(page([v3Item({ name: 'Before' })]))
            .mockResolvedValueOnce(page([v3Item({ name: 'After' })])),
          get: jest.fn(async () => {
            throw new ApiResponseValidationError('Missing item identity', 'identity');
          }),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toBeInstanceOf(ApiResponseValidationError);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('uses the recovery failure reason instead of the primary drift reason', async () => {
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest
            .fn()
            .mockResolvedValueOnce(page([v3Item({ name: 'Before' })]))
            .mockResolvedValueOnce(page([v3Item({ name: 'Before' })]))
            .mockResolvedValueOnce(page([v3Item({ name: 'After' })])),
          get: jest.fn(async () => {
            throw axiosNotFound();
          }),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(result.recordIssues).toEqual([
      {
        resource: 'item',
        id: 'item-1',
        code: 'not_found',
        message: 'Item unavailable during refresh',
        attempts: 2,
        outcome: 'omitted_new',
      },
    ]);
    expect(replaceInventorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps atomic snapshot write failures fatal', async () => {
    const failure = new Error('storage unavailable');
    const replaceInventorySnapshot = jest.fn(async () => {
      throw failure;
    });
    const getItemCount = jest.fn(async () => 1);
    const getStockLocationCount = jest.fn(async () => 1);
    const setCacheState = jest.fn(async () => undefined);
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page([v3Item()])),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({
        replaceInventorySnapshot,
        getItemCount,
        getStockLocationCount,
        setCacheState,
      }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync({ onProgressEvent: (event) => events.push(event) })).rejects.toBe(
      failure
    );
    expect(getItemCount).not.toHaveBeenCalled();
    expect(getStockLocationCount).not.toHaveBeenCalled();
    expect(setCacheState).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).not.toContain('phase_completed');
  });

  it.each([
    [{ ...v3Item(), id: '' }, /identity/i],
    [[v3Item(), v3Item()], /duplicate/i],
  ])('keeps missing and duplicate root identities fatal', async (source, expected) => {
    const rows = Array.isArray(source) ? source : [source as V3Item];
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      {
        items: {
          list: jest.fn(async () => page(rows)),
          get: jest.fn(),
          listVariations: jest.fn(async () => page([])),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toThrow(expected);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeCache(overrides: Record<string, unknown>): CacheService {
  return {
    getCacheState: jest.fn(async () => ({
      lastSync: 0,
      lastFullSync: 0,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'default',
      schemaVersion: CACHE_SCHEMA_VERSION,
    })),
    getCategorySnapshot: jest.fn(async () => null),
    getInventorySnapshot: jest.fn(async () => null),
    replaceInventorySnapshot: jest.fn(async () => undefined),
    getItemCount: jest.fn(async () => 1),
    getStockLocationCount: jest.fn(async () => 1),
    setCacheState: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CacheService;
}

function page<T>(
  data: T[],
  pagination: Partial<V3ListResponse<T>['pagination']> = {}
): V3ListResponse<T> {
  const totalRecords = pagination.total_records ?? data.length;
  return {
    object: 'list',
    url: '/api/v3/test',
    has_more: false,
    data,
    pagination: {
      page: pagination.page ?? 1,
      per_page: pagination.per_page ?? 100,
      total_pages: pagination.total_pages ?? 1,
      total_records: totalRecords,
    },
  };
}

function v3Item(overrides: Partial<V3Item> = {}): V3Item {
  return {
    id: 'item-1',
    object: 'item',
    item_number: 1,
    name: 'Widget',
    description: null,
    sku: null,
    barcode: null,
    serial_number: null,
    inventory_type: 'quantity',
    category_id: null,
    category_name: null,
    status_id: 12,
    location_id: null,
    price: '3.0000',
    cost: '2.0000',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    threshold: 1,
    variation_count: 0,
    published: true,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function v3Variation(overrides: Partial<V3ItemVariation> = {}): V3ItemVariation {
  return {
    id: 'variation-1',
    object: 'item_variation',
    item_id: 'item-1',
    barcode: 'W-1',
    quantity: 12,
    quantity_reserved: 3,
    quantity_incoming: 5,
    in_transit: 2,
    location_count: 1,
    locations: [
      {
        object: 'item_variation_location',
        item_variation_location_id: 42,
        location_id: 'location-1',
        location_name: 'Main',
        quantity: 12,
        quantity_reserved: 3,
        quantity_incoming: 5,
        in_transit: 2,
        threshold: 1,
      },
    ],
    ...overrides,
  };
}

function decimalLocationVariation(
  item: V3Item,
  overrides: Partial<V3ItemVariation> = {}
): V3ItemVariation {
  const location = v3Variation().locations![0];
  return v3Variation({
    id: `${item.id}-variation`,
    item_id: item.id,
    quantity: 0.3,
    quantity_reserved: 0.3,
    quantity_incoming: 0.3,
    in_transit: 0.3,
    location_count: 2,
    locations: [
      {
        ...location,
        item_variation_location_id: 1,
        location_id: 'location-1',
        quantity: 0.1,
        quantity_reserved: 0.1,
        quantity_incoming: 0.1,
        in_transit: 0.1,
      },
      {
        ...location,
        item_variation_location_id: 2,
        location_id: 'location-2',
        quantity: 0.2,
        quantity_reserved: 0.2,
        quantity_incoming: 0.2,
        in_transit: 0.2,
      },
    ],
    ...overrides,
  });
}

function axiosNotFound(): AxiosError {
  return new AxiosError('Not found', undefined, undefined, undefined, { status: 404 } as any);
}

function axiosFailure(status?: number): AxiosError {
  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    status === undefined ? undefined : ({ status } as any)
  );
}
