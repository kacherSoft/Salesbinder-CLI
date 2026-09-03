import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { createAxiosClient } from '../axios.factory.js';
import {
  SalesBinderRateLimiter,
  type RateLimitObserverEvent,
} from '../salesbinder-rate-limiter.js';

const account = {
  subdomain: 'example',
  apiKey: 'test-key',
  apiVersion: '2.0',
};
let recordedDelays: number[];

describe('createAxiosClient retry behavior', () => {
  const originalInitialDelay = process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
  let timeoutSpy: jest.SpyInstance;
  let randomSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let dateNowSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    recordedDelays = [];
    timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number
    ) => {
      recordedDelays.push(delay ?? 0);
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    dateNowSpy = undefined;
  });

  afterEach(() => {
    if (originalInitialDelay === undefined) {
      delete process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
    } else {
      process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = originalInitialDelay;
    }
    timeoutSpy.mockRestore();
    randomSpy.mockRestore();
    warnSpy.mockRestore();
    dateNowSpy?.mockRestore();
  });

  it('retries HTTP 522 responses', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const { client, adapter } = createClientThatFailsOnce(522);

    await client.get('/items.json');

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(recordedDelays).toEqual([25]);
  });

  it.each(['invalid', '-5', '0', '1.5', 'Infinity'])(
    'falls back to 1000ms for invalid initial delay %s',
    async (value) => {
      process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = value;
      const { client } = createClientThatFailsOnce(522);

      await client.get('/items.json');

      expect(recordedDelays).toEqual([1000]);
    }
  );

  it('caps an oversized initial delay at 60000ms', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '999999999';
    const { client } = createClientThatFailsOnce(522);

    await client.get('/items.json');

    expect(recordedDelays).toEqual([60000]);
  });

  it('preserves exponential backoff and additive jitter', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '20';
    randomSpy.mockReturnValue(0.5);
    const { client } = createClientThatFails(522, 2);

    await client.get('/items.json');

    expect(recordedDelays).toEqual([25, 50]);
  });

  it('keeps retry-after precedence over the configured initial delay', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const { client } = createClientThatFailsOnce(429, { 'retry-after': '3' });

    await client.get('/items.json');

    expect(recordedDelays).toEqual([3250]);
  });

  it('supports an HTTP-date retry-after value', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const retryAt = new Date(now + 3000).toUTCString();
    const { client } = createClientThatFailsOnce(429, { 'retry-after': retryAt });

    await client.get('/items.json');

    expect(recordedDelays).toEqual([3250]);
  });

  it('honors retry-after values above the legacy 60-second retry cap', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const { client } = createClientThatFailsOnce(429, { 'retry-after': '120' });

    await client.get('/items.json');

    expect(recordedDelays).toEqual([120250]);
  });

  it.each(['-5', '0', 'invalid'])(
    'uses the conservative cooldown for invalid retry-after value %s',
    async (value) => {
      process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
      const { client } = createClientThatFailsOnce(429, { 'retry-after': value });

      await client.get('/items.json');

      expect(recordedDelays).toEqual([60250]);
    }
  );

  it('uses one rate-limit cooldown owner and gates the retry attempt', async () => {
    const { client, limiter } = createClientThatFailsOnce(429, { 'retry-after': '2' });
    const gateSpy = jest.spyOn(limiter, 'beforeRequest');

    await client.get('/items.json');

    expect(gateSpy).toHaveBeenCalledTimes(2);
    expect(recordedDelays).toEqual([2250]);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'does not retry v2 %s mutations automatically',
    async (method) => {
      const { client, adapter } = createClientThatFailsOnce(503);
      randomSpy.mockRestore();

      const error = await client.request({ method, url: '/items.json', data: {} }).then(
        () => undefined,
        (caught: AxiosError) => caught
      );

      expect(error?.response?.status).toBe(503);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(recordedDelays).toEqual([]);
    }
  );

  it('does not retry a v2 mutation rejected with 429', async () => {
    const { client, adapter } = createClientThatFailsOnce(429, { 'retry-after': '1' });
    randomSpy.mockRestore();

    const error = await client.post('/items.json', {}).then(
      () => undefined,
      (caught: AxiosError) => caught
    );

    expect(error?.response?.status).toBe(429);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(recordedDelays).toEqual([]);
  });

  it('retries HEAD transient failures', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const { client, adapter } = createClientThatFailsOnce(503);

    await client.head('/items.json');

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(recordedDelays).toEqual([25]);
  });

  it('stops after five retries', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '1';
    randomSpy.mockRestore();
    const { client, adapter } = createClientThatFails(503, 99);

    const error = await client.get('/items.json').then(
      () => undefined,
      (caught: AxiosError) => caught
    );

    expect(error?.response?.status).toBe(503);
    expect(adapter).toHaveBeenCalledTimes(6);
    expect(recordedDelays).toHaveLength(5);
    recordedDelays.forEach((delay, attempt) => {
      const base = Math.pow(2, attempt);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.5);
    });
  });

  it('fails a server wait above 15 minutes without another adapter dispatch', async () => {
    const { client, adapter } = createClientThatFailsOnce(429, { 'retry-after': '901' });
    randomSpy.mockRestore();

    const error = await client.get('/items.json').then(
      () => undefined,
      (caught: Error) => caught
    );

    expect(error?.name).toBe('RateLimitWaitExceededError');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(recordedDelays).toEqual([]);
  });

  it('never dispatches an aborted request that is waiting in the FIFO gate', async () => {
    randomSpy.mockRestore();
    const limiterNow = 0;
    const limiter = new SalesBinderRateLimiter({
      now: () => limiterNow,
      wallNow: () => limiterNow,
      random: () => 0,
      sleep: (_delayMs, signal) =>
        new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener?.('abort', onAbort);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          signal?.addEventListener?.('abort', onAbort, { once: true });
        }),
    });
    const client = createAxiosClient(account, { rateLimiterRegistry: limiter });
    const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    client.defaults.adapter = adapter;
    for (let request = 0; request < 12; request++) await client.get(`/items/${request}.json`);

    const controller = new AbortController();
    const queued = client.get('/items/queued.json', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const error = await queued.then(
      () => undefined,
      (caught: Error) => caught
    );

    expect(error?.name).toBe('AbortError');
    expect(adapter).toHaveBeenCalledTimes(12);
  });

  it('routes retry telemetry through the redacted observer without console output', async () => {
    const events: RateLimitObserverEvent[] = [];
    const secret = 'observer-must-not-see-this';
    const localAccount = { ...account, apiKey: secret, subdomain: 'private-account' };
    const { client, adapter } = createClientThatFails(
      429,
      1,
      { 'retry-after': '1' },
      localAccount,
      events
    );

    await client.get('/items.json?token=also-secret');

    expect(warnSpy).not.toHaveBeenCalled();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('private-account');
    expect(serialized).not.toContain('also-secret');
    expect(events.slice(0, 3).map((event) => event.type)).toEqual(['cooldown', 'retry', 'wait']);
    const requestIds = adapter.mock.calls.map(
      ([config]) => (config as typeof config & { _retry?: { requestId: string } })._retry?.requestId
    );
    expect(requestIds[0]).toEqual(expect.any(String));
    expect(new Set(requestIds).size).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'cooldown', apiVersion: 'v2' }),
        expect.objectContaining({ type: 'retry', reason: 'rate_limit' }),
      ])
    );
  });
});

function createClientThatFailsOnce(status: number, headers: Record<string, string> = {}) {
  return createClientThatFails(status, 1, headers);
}

function createClientThatFails(
  status: number,
  failures: number,
  headers: Record<string, string> = {},
  clientAccount = account,
  events?: RateLimitObserverEvent[]
) {
  let limiterNow = 0;
  const limiter = new SalesBinderRateLimiter({
    now: () => limiterNow,
    wallNow: () => Date.now(),
    random: () => 0,
    sleep: async (delayMs) => {
      recordedDelays.push(delayMs);
      limiterNow += delayMs;
    },
  });
  const client = createAxiosClient(clientAccount, {
    rateLimiterRegistry: limiter,
    rateLimitObserver: events ? (event) => events.push(event) : undefined,
  });
  let attempt = 0;
  const adapter = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
    attempt++;
    if (attempt <= failures) {
      const response: AxiosResponse = {
        data: {},
        status,
        statusText: 'Transient Error',
        headers,
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
    return {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  });
  client.defaults.adapter = adapter;
  return { client, adapter, limiter };
}
