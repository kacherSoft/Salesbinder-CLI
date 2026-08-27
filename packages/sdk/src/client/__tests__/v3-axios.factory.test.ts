import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { loadConfig } from '../../config/config.loader.js';
import { SalesBinderV3Client } from '../../index.js';
import { createV3AxiosClient } from '../v3-axios.factory.js';

jest.mock('../../config/config.loader.js', () => ({
  loadConfig: jest.fn(),
}));

const mockedLoadConfig = jest.mocked(loadConfig);

const account = {
  subdomain: 'example',
  apiKey: 'v2-key',
  v3ApiKey: 'v3-key',
  apiVersion: '2.0',
};

describe('createV3AxiosClient', () => {
  it('uses the v3 base URL and Bearer authorization', async () => {
    const client = createV3AxiosClient(account);
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    client.defaults.adapter = adapter;

    await client.get('/items');

    const request = adapter.mock.calls[0][0];
    expect(request.baseURL).toBe('https://example.salesbinder.com/api/v3');
    expect(request.url).toBe('/items');
    expect(request.headers.get('Authorization')).toBe('Bearer v3-key');
    expect(request.headers.get('Content-Type')).toBe('application/json');
  });

  it('throws a clear error when the v3 key is missing', () => {
    expect(() => createV3AxiosClient({ ...account, v3ApiKey: undefined })).toThrow(
      'SalesBinder API v3 key is not configured for this account'
    );
  });

  it('retries the same transient statuses as the v2 client', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '1';
    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void
    ) => {
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createV3AxiosClient(account);
    let attempt = 0;
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
      if (attempt++ === 0) {
        const response: AxiosResponse = {
          data: {},
          status: 522,
          statusText: 'Transient Error',
          headers: {},
          config,
        };
        throw new AxiosError(
          'Transient error',
          AxiosError.ERR_BAD_RESPONSE,
          config,
          undefined,
          response
        );
      }
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    });
    client.defaults.adapter = adapter;

    try {
      await client.get('/items');
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
      timeoutSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('SalesBinderV3Client', () => {
  beforeEach(() => mockedLoadConfig.mockReset());

  it('is exported by the SDK and creates its snapshot resources', () => {
    mockedLoadConfig.mockReturnValue(account);

    const client = new SalesBinderV3Client('default');

    expect(mockedLoadConfig).toHaveBeenCalledWith('default');
    expect(client.items).toBeDefined();
    expect(client.categories).toBeDefined();
  });

  it('throws a clear account-level error when the v3 key is missing', () => {
    mockedLoadConfig.mockReturnValue({ ...account, v3ApiKey: undefined });

    expect(() => new SalesBinderV3Client('default')).toThrow(
      'SalesBinder API v3 key is not configured for this account'
    );
  });
});
