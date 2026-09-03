import { AxiosError } from 'axios';
import { ApiResponseValidationError } from '../../resources/api-response-validation.error.js';
import type { V3Item, V3ItemVariation, V3ListResponse } from '../../types/items.types.js';
import type { CacheService } from '../cache.interface.js';
import type { CacheSyncProgress } from '../cache-sync-progress.types.js';
import {
  V3InventoryIndexerService,
  type V3InventoryClient,
} from '../v3-inventory-indexer.service.js';

describe('V3InventoryIndexerService', () => {
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

    expect(list).toHaveBeenCalledWith({ page: 1, limit: 100, archived: 'all' });
    expect(list).toHaveBeenCalledTimes(2);
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
      schemaVersion: 7,
    });
    expect(get).not.toHaveBeenCalled();
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
          listVariations: jest.fn(),
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

  it('recovers equal-count item content drift with one canonical detail read', async () => {
    const recovered = v3Item({ name: 'Recovered', cost: '4.0000', quantity: 7 });
    const list = jest
      .fn()
      .mockResolvedValueOnce(
        page([v3Item({ name: 'Before', cost: '2.0000', quantity: 4, quantity_reserved: 1 })])
      )
      .mockResolvedValueOnce(
        page([v3Item({ name: 'After', cost: '3.0000', quantity: 9, quantity_reserved: 2 })])
      );
    const replaceInventorySnapshot = jest.fn();
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(async () => recovered), listVariations: jest.fn() } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    const result = await service.sync();

    expect(list).toHaveBeenCalledTimes(2);
    expect(result.recordIssues).toEqual([]);
    expect(replaceInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ item_id: recovered.id, name: 'Recovered', quantity: 7 })],
      })
    );
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
    const get = jest.fn(async (id: string) => (id === preserved.id ? preserved : omitted));
    const listVariations = jest.fn(async (id: string) =>
      page(overflowVariations(id === preserved.id ? preserved : omitted))
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
    expect(listVariations).toHaveBeenCalledTimes(6);
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
    const get = jest.fn(async () => malformed);
    const listVariations = jest.fn(async () => page([malformedVariation]));
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
    expect(listVariations).toHaveBeenCalledTimes(3);
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
    const get = jest.fn(async (id: string) => (id === preserved.id ? preserved : omitted));
    const listVariations = jest.fn(async (itemId: string) => {
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
    expect(listVariations).toHaveBeenCalledTimes(6);
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
          listVariations: jest.fn(),
        },
      },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(incompleteService.sync()).rejects.toThrow(/Incomplete v3 items page 1/);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when equal-count item membership changes between stability passes', async () => {
    const replaceInventorySnapshot = jest.fn();
    const list = jest
      .fn()
      .mockResolvedValueOnce(page([v3Item({ id: 'item-first' })]))
      .mockResolvedValueOnce(page([v3Item({ id: 'item-second' })]));
    const service = new V3InventoryIndexerService(
      { items: { list, get: jest.fn(), listVariations: jest.fn() } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync()).rejects.toThrow(/stability verification/i);
    expect(list).toHaveBeenCalledTimes(2);
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps cross-pass root pagination layout changes fatal when item IDs and content match', async () => {
    const first = v3Item({ id: 'item-first', item_number: 1 });
    const second = v3Item({ id: 'item-second', item_number: 2 });
    const list = jest
      .fn()
      .mockResolvedValueOnce(
        page([first, second], { per_page: 2, total_pages: 1, total_records: 2 })
      )
      .mockResolvedValueOnce({
        ...page([first], { page: 1, per_page: 1, total_pages: 2, total_records: 2 }),
        has_more: true,
      })
      .mockResolvedValueOnce(
        page([second], { page: 2, per_page: 1, total_pages: 2, total_records: 2 })
      );
    const get = jest.fn();
    const replaceInventorySnapshot = jest.fn();
    const events: CacheSyncProgress[] = [];
    const service = new V3InventoryIndexerService(
      { items: { list, get, listVariations: jest.fn() } },
      fakeCache({ replaceInventorySnapshot }),
      'default',
      'salesbinder:acme'
    );

    await expect(service.sync({ onProgressEvent: (event) => events.push(event) })).rejects.toThrow(
      /root pagination changed during stability verification/i
    );

    expect(list).toHaveBeenCalledTimes(3);
    expect(get).not.toHaveBeenCalled();
    expect(replaceInventorySnapshot).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).not.toContain('retry_pass_started');
    expect(events.map(({ event }) => event)).not.toContain('record_failed_collected');
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
      { items: { list: jest.fn(async () => page(listed)), get, listVariations: jest.fn() } },
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

  it('recovers malformed item location inventory as a record-local source failure', async () => {
    const malformed = {
      ...v3Item(),
      location_inventory: 'invalid',
    } as unknown as V3Item;
    const recovered = v3Item({ quantity: 8 });
    const replaceInventorySnapshot = jest.fn();
    const get = jest.fn(async () => recovered);
    const service = new V3InventoryIndexerService(
      { items: { list: jest.fn(async () => page([malformed])), get, listVariations: jest.fn() } },
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
      { items: { list: jest.fn(async () => page([malformed])), get, listVariations: jest.fn() } },
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
          listVariations: jest.fn(),
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
            .mockResolvedValueOnce(page([second])),
          get: jest.fn(async () => v3Item({ id: 'different-item' })),
          listVariations: jest.fn(),
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
            .mockResolvedValueOnce(page([v3Item({ name: 'After' })])),
          get: jest.fn(async () => {
            throw new ApiResponseValidationError('Missing item identity', 'identity');
          }),
          listVariations: jest.fn(),
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
            .mockResolvedValueOnce(page([v3Item({ name: 'After' })])),
          get: jest.fn(async () => {
            throw axiosNotFound();
          }),
          listVariations: jest.fn(),
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
          listVariations: jest.fn(),
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
          listVariations: jest.fn(),
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

function fakeCache(overrides: Record<string, unknown>): CacheService {
  return {
    getCacheState: jest.fn(async () => ({
      lastSync: 0,
      lastFullSync: 0,
      documentCount: 0,
      itemDocumentCount: 0,
      accountName: 'default',
      schemaVersion: 7,
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
