import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { loadConfig } from '../../config/config.loader.js';
import { SalesBinderV3Client } from '../../index.js';
import { createV3AxiosClient } from '../v3-axios.factory.js';
import {
  SalesBinderRateLimiter,
  type RateLimitObserverEvent,
} from '../salesbinder-rate-limiter.js';

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
    const { client } = createTestV3Client();
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
    const timeoutSpy = immediateTimeouts();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = createTestV3Client();
    let attempt = 0;
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
      if (attempt++ === 0) throwResponse(config, 522);
      return successfulResponse(config);
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

  it('retries HEAD transient failures through the shared policy', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '1';
    const timeoutSpy = immediateTimeouts();
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = createTestV3Client();
    let attempt = 0;
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
      if (attempt++ === 0) throwResponse(config, 503);
      return successfulResponse(config);
    });
    client.defaults.adapter = adapter;

    try {
      await client.head('/items');
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'retries a v3 %s mutation on 429 without requiring an idempotency key',
    async (method) => {
      const events: RateLimitObserverEvent[] = [];
      const { client, limiterDelays } = createTestV3Client(events);
      let attempt = 0;
      const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(
        async (config) => {
          if (attempt++ === 0) throwResponse(config, 429, { 'retry-after': '2' });
          return successfulResponse(config);
        }
      );
      client.defaults.adapter = adapter;

      await client.request({ method, url: '/items', data: { name: 'safe rejection retry' } });

      expect(adapter).toHaveBeenCalledTimes(2);
      expect(limiterDelays).toEqual([2250]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'cooldown', apiVersion: 'v3' }),
          expect.objectContaining({ type: 'retry', reason: 'rate_limit' }),
        ])
      );
    }
  );

  it.each([500, 503, 522])(
    'does not retry v3 mutation status %s without an existing idempotency key',
    async (status) => {
      const { client } = createTestV3Client();
      const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(
        async (config) => {
          throwResponse(config, status);
        }
      );
      client.defaults.adapter = adapter;

      const error = await client.post('/items', {}).then(
        () => undefined,
        (caught: AxiosError) => caught
      );

      expect(error?.response?.status).toBe(status);
      expect(adapter).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves an existing idempotency key while retrying a v3 mutation 5xx', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '1';
    const timeoutSpy = immediateTimeouts();
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = createTestV3Client();
    const keys: unknown[] = [];
    let attempt = 0;
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
      keys.push(config.headers.get('Idempotency-Key'));
      if (attempt++ === 0) throwResponse(config, 503);
      return successfulResponse(config);
    });
    client.defaults.adapter = adapter;

    try {
      await client.post('/items', {}, { headers: { 'Idempotency-Key': 'stable-key' } });
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(keys).toEqual(['stable-key', 'stable-key']);
    } finally {
      delete process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('requires an existing idempotency key for a v3 mutation network retry', async () => {
    const withoutKey = createTestV3Client();
    const noKeyAdapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(
      async (config) => {
        throw new AxiosError('network', AxiosError.ERR_NETWORK, config);
      }
    );
    withoutKey.client.defaults.adapter = noKeyAdapter;
    await withoutKey.client.post('/items', {}).catch(() => undefined);
    expect(noKeyAdapter).toHaveBeenCalledTimes(1);

    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '1';
    const timeoutSpy = immediateTimeouts();
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withKey = createTestV3Client();
    let attempt = 0;
    const keyedAdapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(
      async (config) => {
        if (attempt++ === 0) throw new AxiosError('network', AxiosError.ERR_NETWORK, config);
        return successfulResponse(config);
      }
    );
    withKey.client.defaults.adapter = keyedAdapter;
    try {
      await withKey.client.put('/items/id', {}, { headers: { 'Idempotency-Key': 'stable-key' } });
      expect(keyedAdapter).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
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

function createTestV3Client(events?: RateLimitObserverEvent[]) {
  let limiterNow = 0;
  const limiterDelays: number[] = [];
  const limiter = new SalesBinderRateLimiter({
    now: () => limiterNow,
    wallNow: () => limiterNow,
    random: () => 0,
    sleep: async (delayMs) => {
      limiterDelays.push(delayMs);
      limiterNow += delayMs;
    },
  });
  const client = createV3AxiosClient(account, {
    rateLimiterRegistry: limiter,
    rateLimitObserver: events ? (event) => events.push(event) : undefined,
  });
  return { client, limiter, limiterDelays };
}

function throwResponse(
  config: Parameters<AxiosAdapter>[0],
  status: number,
  headers: Record<string, string> = {}
): never {
  const response: AxiosResponse = {
    data: {},
    status,
    statusText: 'Transient Error',
    headers,
    config,
  };
  throw new AxiosError('Transient error', AxiosError.ERR_BAD_RESPONSE, config, undefined, response);
}

function successfulResponse(config: Parameters<AxiosAdapter>[0]): AxiosResponse {
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
}

function immediateTimeouts(): jest.SpyInstance {
  return jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
}
