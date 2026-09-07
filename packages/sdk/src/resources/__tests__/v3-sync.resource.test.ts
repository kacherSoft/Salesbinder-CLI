import type { AxiosInstance } from 'axios';
import { ApiResponseValidationError } from '../api-response-validation.error.js';
import { V3SyncResource } from '../v3-sync.resource.js';

const id = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const resources = ['item', 'invoice', 'estimate', 'purchase_order'] as const;

describe('V3SyncResource', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T00:00:00Z')));
  afterEach(() => jest.restoreAllMocks());

  it('starts a full download with the requested resource set and an opaque checkpoint', async () => {
    const get = jest.fn().mockResolvedValue({ data: startEnvelope() });
    const resource = createResource(get);

    await expect(resource.read({ start: 'now', resources, limit: 100 })).resolves.toEqual(
      startEnvelope()
    );
    expect(get).toHaveBeenCalledWith('/sync', {
      params: { start: 'now', resources: resources.join(','), limit: 100 },
    });
  });

  it.each([
    ['ISO timestamp', '2026-09-01T00:00:00+07:00'],
    ['Unix seconds', 1788220800],
    ['Unix seconds string', '1788220800'],
  ])('reads a page from a %s entry point', async (_label, since) => {
    const get = jest.fn().mockResolvedValue({ data: pageEnvelope() });
    const resource = createResource(get);

    await expect(resource.read({ since, resources })).resolves.toEqual(pageEnvelope());
    expect(get).toHaveBeenCalledWith('/sync', {
      params: { since, resources: resources.join(',') },
    });
  });

  it('continues from an opaque cursor without resending resources', async () => {
    const cursor = 'eyJhbGciOiJIUzI1NiJ9.signature';
    const get = jest.fn().mockResolvedValue({ data: pageEnvelope() });

    await expect(createResource(get).read({ cursor, limit: 1 })).resolves.toEqual(pageEnvelope());
    expect(get).toHaveBeenCalledWith('/sync', { params: { cursor, limit: 1 } });
  });

  it.each([
    {
      label: 'multiple anchors',
      params: { start: 'now', since: '2026-09-01T00:00:00Z', resources },
    },
    {
      label: 'unknown legacy parameter',
      params: { since: '2026-09-01T00:00:00Z', resources, modifiedSince: 1 },
    },
    { label: 'cursor resources', params: { cursor: 'safe-cursor', resources } },
    { label: 'unsupported resource', params: { start: 'now', resources: ['customer'] } },
    { label: 'duplicate resources', params: { start: 'now', resources: ['item', 'item'] } },
    { label: 'invalid start', params: { start: 'later', resources } },
    { label: 'limit below range', params: { cursor: 'safe-cursor', limit: 0 } },
    { label: 'limit above range', params: { cursor: 'safe-cursor', limit: 501 } },
    { label: 'future since', params: { since: '2026-09-08T00:00:00Z', resources } },
    { label: 'expired since', params: { since: '2026-06-08T00:00:00Z', resources } },
    { label: 'timezone-less since', params: { since: '2026-09-01T00:00:00', resources } },
    { label: 'millisecond since', params: { since: '1788220800000', resources } },
  ])('rejects $label before transport', async ({ params }) => {
    const get = jest.fn();

    await expect(createResource(get).read(params as never)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('never includes a rejected cursor in errors', async () => {
    const get = jest.fn();
    const cursor = 'secret-cursor-value';

    await expect(createResource(get).read({ cursor: `${cursor}\n` })).rejects.not.toThrow(cursor);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'inconsistent initial resources', data: { ...pageEnvelope(), resources: ['item'] } },
    { label: 'unknown response resource', data: { ...pageEnvelope(), resources: ['customer'] } },
    {
      label: 'marker outside the response resource set',
      data: {
        ...pageEnvelope(),
        resources: ['item'],
        changes: [{ ...change(), resource: 'invoice' }],
      },
    },
    {
      label: 'invalid marker id',
      data: { ...pageEnvelope(), changes: [{ ...change(), id: 'bad-id' }] },
    },
    {
      label: 'invalid marker operation',
      data: { ...pageEnvelope(), changes: [{ ...change(), operation: 'replace' }] },
    },
    { label: 'missing next cursor', data: { ...pageEnvelope(), next_cursor: '' } },
    {
      label: 'more markers than the requested limit',
      data: { ...pageEnvelope(), changes: [change(), change()] },
      params: { cursor: 'safe-cursor', limit: 1 },
    },
    { label: 'malformed envelope', data: { object: 'list', data: [] } },
  ])('fails closed on $label', async ({ data, params }) => {
    const get = jest.fn().mockResolvedValue({ data });

    await expect(
      createResource(get).read(params ?? { since: '2026-09-01T00:00:00Z', resources })
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('accepts delete markers and empty continuation pages', async () => {
    const data = {
      ...pageEnvelope(),
      changes: [{ ...change(), operation: 'delete' }],
      has_more: true,
    };
    await expect(
      createResource(jest.fn().mockResolvedValue({ data })).read({ cursor: 'safe-cursor' })
    ).resolves.toEqual(data);
  });
});

function createResource(get: jest.Mock): V3SyncResource {
  return new V3SyncResource({ get } as unknown as AxiosInstance);
}

function startEnvelope() {
  return {
    object: 'sync_start',
    resources: [...resources],
    retention_days: 90,
    cursor: 'opaque-start',
  };
}

function pageEnvelope() {
  return {
    object: 'sync_page',
    resources: [...resources],
    changes: [change()],
    has_more: false,
    next_cursor: 'opaque-next',
  };
}

function change() {
  return { resource: 'invoice', id, operation: 'upsert' } as const;
}
