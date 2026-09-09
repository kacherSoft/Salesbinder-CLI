import type { OCShippingPatch } from '../oc-shipping.types.js';
import type {
  OCShippingProvenance,
  OCShippingReconciliationStatus,
} from '../postgres-oc-shipping.store.js';
import type { OCShippingWarning } from '../postgres-oc-shipping-warning.store.js';
import { OCShippingContractError } from '../oc-shipping.types.js';
import { SalesOrderShippingReconciliationService } from '../sales-order-shipping-reconciliation.service.js';

const orderA = '11111111-1111-4111-8111-111111111111';
const orderB = '22222222-2222-4222-8222-222222222222';
const estimateId = '33333333-3333-4333-8333-333333333333';
const lineId = '44444444-4444-4444-8444-444444444444';
const itemId = '55555555-5555-4555-8555-555555555555';
const invoiceId = '77777777-7777-4777-8777-777777777777';

function summary(id: string): Record<string, unknown> {
  return { id, object: 'sales_order' };
}

function patch(authorityId: string): OCShippingPatch {
  return {
    estimateId,
    estimateNumber: 12,
    estimateModified: 20,
    customerId: '66666666-6666-4666-8666-666666666666',
    associatedDocumentId: authorityId,
    sourceKind: 'sales_order',
    authorityId,
    authorityModified: 21,
    shippedPercent: 50,
    lines: [
      { documentItemId: lineId, itemId, quantity: 2, quantityShipped: 1 },
    ],
  };
}

function page(
  number: number,
  pages: number,
  records: number,
  data: Record<string, unknown>[]
) {
  return {
    object: 'list' as const,
    data,
    has_more: number < pages,
    pagination: {
      page: number,
      per_page: 1,
      total_pages: pages,
      total_records: records,
    },
    url: '/sales-orders',
  };
}

function harness(options?: {
  known?: readonly OCShippingProvenance[];
  prior?: OCShippingReconciliationStatus | null;
  warnings?: readonly OCShippingWarning[];
}) {
  const statuses: OCShippingReconciliationStatus[] = [];
  const applied: OCShippingPatch[] = [];
  const cleared: string[] = [];
  const clearedWarnings: Array<[4 | 5, string]> = [];
  const touchedWarnings: OCShippingWarning[] = [];
  const cache = {
    applyOCShippingPatch: jest.fn(async (value: OCShippingPatch) => {
      applied.push(value);
      return 'applied' as const;
    }),
    clearOCShippingAuthority: jest.fn(async (id: string) => void cleared.push(id)),
    getOCShippingPendingWarnings: jest.fn(async () => options?.warnings ?? []),
    setOCShippingWarning: jest.fn(async (value: OCShippingWarning) => {
      touchedWarnings.push(value);
    }),
    clearOCShippingWarning: jest.fn(async (contextId: 4 | 5, documentId: string) => {
      clearedWarnings.push([contextId, documentId]);
    }),
    getOCShippingKnownLinks: jest.fn(async () => options?.known ?? []),
    getOCShippingReconciliationStatus: jest.fn(async () => options?.prior ?? null),
    setOCShippingReconciliationStatus: jest.fn(
      async (value: OCShippingReconciliationStatus) => void statuses.push(value)
    ),
  };
  return { cache, statuses, applied, cleared, clearedWarnings, touchedWarnings };
}

function warning(contextId: 4 | 5, documentId: string, updatedAt = 10): OCShippingWarning {
  return { contextId, documentId, code: 'shipping_unknown', updatedAt };
}

describe('SalesOrderShippingReconciliationService', () => {
  it('validates complete pagination, applies every patch, and records clean status', async () => {
    const ctx = harness();
    const listSalesOrders = jest
      .fn()
      .mockResolvedValueOnce(page(1, 2, 2, [summary(orderA)]))
      .mockResolvedValueOnce(page(2, 2, 2, [summary(orderB)]));
    const hydrate = jest
      .fn()
      .mockResolvedValueOnce({ patch: patch(orderA), issues: [] })
      .mockResolvedValueOnce({ patch: patch(orderB), issues: [] });
    let now = 100;
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders,
        getSalesOrder: jest.fn(async (id) => summary(id)),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate,
      pageLimit: 1,
      now: () => now++,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(listSalesOrders).toHaveBeenNthCalledWith(1, { page: 1, limit: 1 });
    expect(listSalesOrders).toHaveBeenNthCalledWith(2, { page: 2, limit: 1 });
    expect(ctx.applied.map((value) => value.authorityId)).toEqual([orderA, orderB]);
    expect(result.status).toMatchObject({ status: 'success', scanned: 2, applied: 2, failed: 0 });
    expect(ctx.statuses.map((value) => value.status)).toEqual(['running', 'success']);
  });

  it('keeps authoritative patches while reporting hydration issues as warnings', async () => {
    const ctx = harness({
      prior: {
        version: 1,
        accountIdentity: 'salesbinder:example',
        status: 'success',
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 2,
        lastSuccessAt: 2,
        scanned: 1,
        applied: 1,
        failed: 0,
      },
    });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderA)])),
        getSalesOrder: jest.fn(async () => summary(orderA)),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate: jest.fn(async () => ({
        patch: patch(orderA),
        issues: [{ code: 'converted_document_unobserved' as const, documentId: estimateId }],
      })),
      now: () => 10,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(ctx.applied).toHaveLength(1);
    expect(result.status).toMatchObject({
      status: 'success_with_warnings',
      failed: 1,
      lastSuccessAt: 2,
    });
  });

  it('clears an unavailable indirect sales-order authority after a nonempty complete scan', async () => {
    const ctx = harness({
      known: [
        {
          version: 1,
          estimateId,
          estimateModified: 20,
          sourceDocumentId: '77777777-7777-4777-8777-777777777777',
          authorityId: orderA,
          authorityModified: 21,
          sourceKind: 'invoice',
        },
      ],
    });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderB)])),
        getSalesOrder: jest.fn(async () => summary(orderB)),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate: jest.fn(async () => ({ patch: null, issues: [] })),
      now: () => 10,
    });

    await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(ctx.cleared).toEqual([orderA]);
    expect(ctx.touchedWarnings).toContainEqual({
      contextId: 4,
      documentId: estimateId,
      code: 'shipping_unknown',
      updatedAt: 10,
    });
    expect(ctx.statuses.at(-1)).toMatchObject({ status: 'success_with_warnings', failed: 1 });
  });

  it('fails closed on pagination drift and does not infer removals', async () => {
    const ctx = harness({
      known: [
        {
          version: 1,
          estimateId,
          estimateModified: 20,
          sourceDocumentId: orderA,
          authorityId: orderA,
          authorityModified: 21,
          sourceKind: 'sales_order',
        },
      ],
    });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => ({
          ...page(1, 2, 1, [summary(orderA)]),
          has_more: false,
        })),
        getSalesOrder: jest.fn(),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate: jest.fn(),
      now: () => 10,
    });

    await expect(service.sync({ accountIdentity: 'salesbinder:example' })).rejects.toThrow(
      'stable complete pagination'
    );
    expect(ctx.cleared).toEqual([]);
    expect(ctx.statuses.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_source_page',
    });
  });

  it('turns a disappeared detail into a warning without clearing current membership', async () => {
    const ctx = harness();
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderA)])),
        getSalesOrder: jest.fn(async () => {
          throw { response: { status: 404 } };
        }),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate: jest.fn(),
      now: () => 10,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(result.status).toMatchObject({ status: 'success_with_warnings', failed: 1 });
    expect(result.failures).toEqual([
      { code: 'source_document_not_found', documentId: orderA },
    ]);
    expect(ctx.cleared).toEqual([]);
  });

  it('rejects a mismatched detail identity before hydration or cache writes', async () => {
    const ctx = harness();
    const hydrate = jest.fn();
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderA)])),
        getSalesOrder: jest.fn(async () => summary(orderB)),
        get: jest.fn(),
      },
      cache: ctx.cache,
      hydrate,
      now: () => 10,
    });

    await expect(service.sync({ accountIdentity: 'salesbinder:example' })).rejects.toThrow(
      'requested identity'
    );
    expect(hydrate).not.toHaveBeenCalled();
    expect(ctx.applied).toEqual([]);
    expect(ctx.statuses.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('retries and clears a resolved invoice shipping warning', async () => {
    const ctx = harness({ warnings: [warning(5, invoiceId)] });
    const get = jest.fn(async () => ({ id: invoiceId, object: 'invoice' }));
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 0, [])),
        getSalesOrder: jest.fn(),
        get,
      },
      cache: ctx.cache,
      hydrate: jest.fn(),
      hydrateWarning: jest.fn(async () => ({ patch: patch(orderA), issues: [] })),
      now: () => 10,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(get).toHaveBeenCalledWith(5, invoiceId);
    expect(ctx.clearedWarnings).toEqual([[5, invoiceId]]);
    expect(result).toMatchObject({ pendingWarnings: 0, status: { status: 'success', applied: 1, failed: 0 } });
  });

  it('keeps a persistent customer conflict pending without aborting the sales-order pass', async () => {
    const ctx = harness({ warnings: [warning(4, estimateId)] });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderA)])),
        getSalesOrder: jest.fn(async () => summary(orderA)),
        get: jest.fn(async () => ({ id: estimateId, object: 'estimate' })),
      },
      cache: ctx.cache,
      hydrate: jest.fn(async () => ({ patch: patch(orderA), issues: [] })),
      hydrateWarning: jest.fn(async () => ({
        patch: null,
        issues: [{ code: 'shipping_contract_invalid' as const, documentId: estimateId }],
      })),
      now: () => 10,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(ctx.applied).toHaveLength(1);
    expect(ctx.clearedWarnings).toEqual([]);
    expect(ctx.touchedWarnings).toEqual([
      { contextId: 4, documentId: estimateId, code: 'shipping_unknown', updatedAt: 10 },
    ]);
    expect(result).toMatchObject({
      pendingWarnings: 1,
      status: { status: 'success_with_warnings', scanned: 2, applied: 1, failed: 1 },
    });
  });

  it('continues to warning retries after one sales order has a deterministic contract conflict', async () => {
    const ctx = harness({ warnings: [warning(5, invoiceId)] });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderA)])),
        getSalesOrder: jest.fn(async () => summary(orderA)),
        get: jest.fn(async () => ({ id: invoiceId, object: 'invoice' })),
      },
      cache: ctx.cache,
      hydrate: jest.fn(async () => {
        throw new OCShippingContractError('customers disagree');
      }),
      hydrateWarning: jest.fn(async () => ({ patch: patch(orderB), issues: [] })),
      now: () => 10,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(ctx.applied.map((value) => value.authorityId)).toEqual([orderB]);
    expect(ctx.clearedWarnings).toEqual([[5, invoiceId]]);
    expect(result).toMatchObject({
      pendingWarnings: 0,
      status: { status: 'success_with_warnings', scanned: 2, applied: 1, failed: 1 },
    });
    expect(result.failures).toContainEqual({ code: 'shipping_contract_invalid', documentId: orderA });
  });

  it('fails on warning retry authentication without clearing the durable warning', async () => {
    const ctx = harness({ warnings: [warning(4, estimateId)] });
    const authorizationFailure = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 0, [])),
        getSalesOrder: jest.fn(),
        get: jest.fn(async () => { throw authorizationFailure; }),
      },
      cache: ctx.cache,
      hydrate: jest.fn(),
      now: () => 10,
    });

    await expect(service.sync({ accountIdentity: 'salesbinder:example' })).rejects.toBe(authorizationFailure);
    expect(ctx.clearedWarnings).toEqual([]);
    expect(ctx.statuses.at(-1)).toMatchObject({ status: 'failed', errorCode: 'authorization_failed', failed: 1 });
  });

  it('caps warning retries and rotates unresolved records behind older work', async () => {
    const ctx = harness({
      warnings: [
        warning(4, estimateId, 30),
        warning(5, invoiceId, 10),
        warning(4, orderB, 20),
      ],
    });
    let clock = 100;
    const hydrateWarning = jest.fn(async (_documents, payload: unknown) => ({
      patch: null,
      issues: [
        {
          code: 'shipping_contract_invalid' as const,
          documentId: (payload as { id: string }).id,
        },
      ],
    }));
    const get = jest.fn(async (contextId: 4 | 5, id: string) => ({
      id,
      object: contextId === 4 ? 'estimate' : 'invoice',
    }));
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 0, [])),
        getSalesOrder: jest.fn(),
        get,
      },
      cache: ctx.cache,
      hydrate: jest.fn(),
      hydrateWarning,
      warningLimit: 2,
      now: () => clock++,
    });

    const result = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(hydrateWarning).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map(([, id]) => id)).toEqual([invoiceId, orderB]);
    expect(ctx.touchedWarnings.map(({ documentId }) => documentId)).toEqual([invoiceId, orderB]);
    expect(ctx.touchedWarnings.every(({ updatedAt }) => updatedAt > 30)).toBe(true);
    expect(result).toMatchObject({
      pendingWarnings: 3,
      status: { status: 'success_with_warnings', scanned: 2, failed: 3 },
    });
  });

  it('keeps a missing sales-order authority pending after its provenance is cleared', async () => {
    const link: OCShippingProvenance = {
      version: 1,
      estimateId,
      estimateModified: 20,
      sourceDocumentId: orderA,
      authorityId: orderA,
      authorityModified: 21,
      sourceKind: 'sales_order',
    };
    const ctx = harness();
    ctx.cache.getOCShippingKnownLinks
      .mockResolvedValueOnce([link])
      .mockResolvedValueOnce([]);
    ctx.cache.getOCShippingPendingWarnings
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([warning(4, estimateId)]);
    const service = new SalesOrderShippingReconciliationService({
      documents: {
        listSalesOrders: jest.fn(async () => page(1, 1, 1, [summary(orderB)])),
        getSalesOrder: jest.fn(async () => summary(orderB)),
        get: jest.fn(async () => ({ id: estimateId, object: 'estimate' })),
      },
      cache: ctx.cache,
      hydrate: jest.fn(async () => ({ patch: null, issues: [] })),
      hydrateWarning: jest.fn(async () => ({
        patch: patch(orderA),
        issues: [{ code: 'authority_not_found' as const, documentId: orderA }],
      })),
      now: () => 10,
    });

    await service.sync({ accountIdentity: 'salesbinder:example' });
    const second = await service.sync({ accountIdentity: 'salesbinder:example' });

    expect(ctx.cleared).toEqual([orderA]);
    expect(ctx.cache.setOCShippingWarning).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 4, documentId: estimateId })
    );
    expect(ctx.clearedWarnings).toEqual([]);
    expect(second).toMatchObject({
      pendingWarnings: 1,
      status: { status: 'success_with_warnings', failed: 1 },
    });
  });
});
