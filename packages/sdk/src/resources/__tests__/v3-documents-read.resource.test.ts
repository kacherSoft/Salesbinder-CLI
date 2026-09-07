import axios from 'axios';
import { ApiResponseValidationError } from '../api-response-validation.error.js';
import { V3DocumentsReadResource } from '../v3-documents-read.resource.js';

describe('V3DocumentsReadResource', () => {
  const id = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
  it.each([
    [4, 'estimates'],
    [5, 'invoices'],
    [11, 'purchase-orders'],
  ] as const)('reads context %s through its exact route', async (context, route) => {
    const client = axios.create();
    const payload = { id, object: 'detail' };
    const get = jest.spyOn(client, 'get').mockResolvedValue({ data: payload });
    const resource = new V3DocumentsReadResource(client);
    expect(await resource.get(context, id)).toBe(payload);
    expect(get).toHaveBeenCalledWith(`/${route}/${id}`);
    expect(Object.getOwnPropertyNames(V3DocumentsReadResource.prototype)).toEqual([
      'constructor',
      'get',
      'getMany',
    ]);
  });

  it.each(['../invoices', '', 'bad-id', `${id}\n`])(
    'rejects malformed IDs before transport',
    async (invalidId) => {
      const client = axios.create();
      const get = jest.spyOn(client, 'get');
      await expect(new V3DocumentsReadResource(client).get(5, invalidId)).rejects.toThrow(
        TypeError
      );
      expect(get).not.toHaveBeenCalled();
    }
  );

  it.each([
    [4, 'estimates'],
    [5, 'invoices'],
    [11, 'purchase-orders'],
  ] as const)('gets exact %s document batches in caller order', async (context, route) => {
    const ids = [id, 'c40e5d25-c573-48ec-aa46-9737eddf2514'];
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      data: envelope([record(context, ids[1]), record(context, ids[0])], ids.length),
    });
    const resource = new V3DocumentsReadResource(client);

    await expect(resource.getMany(context, ids)).resolves.toEqual({
      records: [record(context, ids[0]), record(context, ids[1])],
      omittedIds: [],
    });
    expect(get).toHaveBeenCalledWith(`/${route}`, {
      params: { page: 1, limit: 2, ids: ids.join(',') },
    });
  });

  it('reports exact document omissions without a single-record fallback', async () => {
    const missing = 'c40e5d25-c573-48ec-aa46-9737eddf2514';
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      data: envelope([record(5, id)], 2),
    });

    await expect(new V3DocumentsReadResource(client).getMany(5, [id, missing])).resolves.toEqual({
      records: [record(5, id)],
      omittedIds: [missing],
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'empty ids', ids: [] },
    { label: '51 ids', ids: Array.from({ length: 51 }, (_, index) => documentId(index + 1)) },
    { label: 'duplicate ids', ids: [id, id] },
    { label: 'bad id', ids: ['not-a-uuid'] },
  ])('rejects $label before the batch transport', async ({ ids }) => {
    const client = axios.create();
    const get = jest.spyOn(client, 'get');

    await expect(new V3DocumentsReadResource(client).getMany(5, ids)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'an unexpected identity', data: [record(5, documentId(9))] },
    { label: 'a duplicate identity', data: [record(5, id), record(5, id)] },
    { label: 'a malformed identity', data: [{ ...record(5, id), id: 'invalid' }] },
    { label: 'a wrong document object', data: [{ ...record(5, id), object: 'estimate' }] },
    { label: 'a mismatched context id', data: [{ ...record(5, id), context_id: 4 }] },
  ])('fails closed on $label in an exact batch response', async ({ data }) => {
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({ data: envelope(data, 1) });

    await expect(new V3DocumentsReadResource(client).getMany(5, [id])).rejects.toBeInstanceOf(
      ApiResponseValidationError
    );
  });

  it.each([
    { label: 'a continuation', patch: { has_more: true } },
    {
      label: 'a later page',
      patch: { pagination: { page: 2, per_page: 1, total_pages: 1, total_records: 1 } },
    },
    {
      label: 'a second page',
      patch: { pagination: { page: 1, per_page: 1, total_pages: 2, total_records: 1 } },
    },
    {
      label: 'an inconsistent total',
      patch: { pagination: { page: 1, per_page: 1, total_pages: 1, total_records: 2 } },
    },
  ])('fails closed on $label from a document exact lookup', async ({ patch }) => {
    const client = axios.create();
    jest
      .spyOn(client, 'get')
      .mockResolvedValue({ data: { ...envelope([record(5, id)], 1), ...patch } });

    await expect(new V3DocumentsReadResource(client).getMany(5, [id])).rejects.toThrow(
      'expected one complete result page'
    );
  });
});

function envelope(data: unknown[], perPage: number) {
  return {
    object: 'list',
    url: '/api/v3/invoices',
    has_more: false,
    data,
    pagination: { page: 1, per_page: perPage, total_pages: 1, total_records: data.length },
  };
}

function documentId(index: number): string {
  return `c40e5d25-c573-48ec-aa46-${index.toString(16).padStart(12, '0')}`;
}

function record(contextId: 4 | 5 | 11, documentId: string) {
  return {
    id: documentId,
    object: { 4: 'estimate', 5: 'invoice', 11: 'purchase_order' }[contextId],
    context_id: contextId,
  };
}
