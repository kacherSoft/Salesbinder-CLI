import type { AxiosInstance } from 'axios';

const mockCreateAxiosClient = jest.fn();
const mockCreateV3AxiosClient = jest.fn();
const mockDocumentOffsetSyncServiceConstructor = jest.fn();

const mockDocumentOffsetSyncServiceClass = class {
  constructor(public readonly deps: Record<string, unknown>) {
    mockDocumentOffsetSyncServiceConstructor(deps);
  }
};

jest.mock('../../client/axios.factory.js', () => ({
  createAxiosClient: mockCreateAxiosClient,
}));

jest.mock('../../client/v3-axios.factory.js', () => ({
  createV3AxiosClient: mockCreateV3AxiosClient,
}));

jest.mock('../document-offset-sync.service.js', () => ({
  DocumentOffsetSyncService: mockDocumentOffsetSyncServiceClass,
}));

type OffsetDeps = {
  cache: unknown;
  store: unknown;
  documentsV2: { list(params?: unknown): Promise<unknown> };
  documentsV3: { get(contextId: 4 | 5 | 11, id: string): Promise<unknown> };
  hydrator: unknown;
  guard?: () => void;
};

const account = {
  subdomain: 'example',
  apiKey: 'v2-key',
  v3ApiKey: 'v3-key',
  apiVersion: '1.0',
};
const documentId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';

let v2Client: { get: jest.Mock };
let v3Client: { get: jest.Mock };

async function createFactoryService(runtimeOptions: Record<string, unknown> = {}) {
  const { createDocumentOffsetSyncService } = await import('../document-offset-client.factory.js');
  const cache = { marker: 'cache-store' };
  const guard = jest.fn();
  const service = createDocumentOffsetSyncService(
    account,
    cache as never,
    runtimeOptions,
    guard
  ) as unknown as { deps: OffsetDeps };
  return { service, cache, guard };
}

describe('createDocumentOffsetSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    v2Client = {
      get: jest.fn(async () => ({
        data: { count: '0', page: '1', pages: '0', documents: [] },
      })),
    };
    v3Client = {
      get: jest.fn(async () => ({ data: {} })),
    };
    mockCreateAxiosClient.mockReturnValue(v2Client as unknown as AxiosInstance);
    mockCreateV3AxiosClient.mockReturnValue(v3Client as unknown as AxiosInstance);
  });

  it('forces V2 document selection to API 2.0 and creates a separate V3 client', async () => {
    const controller = new AbortController();
    const rateLimitObserver = jest.fn();
    const runtimeOptions = { signal: controller.signal, rateLimitObserver };
    const { service, cache, guard } = await createFactoryService(runtimeOptions);

    expect(mockCreateAxiosClient).toHaveBeenCalledWith(
      { ...account, apiVersion: '2.0' },
      runtimeOptions
    );
    expect(mockCreateV3AxiosClient).toHaveBeenCalledWith(account, runtimeOptions);
    expect(mockCreateAxiosClient.mock.calls[0][1].signal).toBe(controller.signal);
    expect(mockCreateV3AxiosClient.mock.calls[0][1].signal).toBe(controller.signal);
    expect(mockDocumentOffsetSyncServiceConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        cache,
        store: cache,
        guard,
        documentsV2: expect.any(Object),
        documentsV3: expect.any(Object),
        hydrator: expect.any(Object),
      })
    );
    expect(service.deps.cache).toBe(cache);
    expect(service.deps.store).toBe(cache);
  });

  it('does not fall back to V2 when a V3 document detail read fails', async () => {
    const { service } = await createFactoryService();
    v3Client.get.mockRejectedValueOnce(new Error('v3 unavailable'));

    await expect(service.deps.documentsV3.get(5, documentId)).rejects.toThrow('v3 unavailable');

    expect(v3Client.get).toHaveBeenCalledWith(`/invoices/${documentId}`);
    expect(v2Client.get).not.toHaveBeenCalled();

    await service.deps.documentsV2.list({ contextId: 5, modifiedSince: 1_800_000_000 });

    expect(v2Client.get).toHaveBeenCalledWith('/documents.json', {
      params: { contextId: 5, modifiedSince: 1_800_000_000 },
    });
  });
});
