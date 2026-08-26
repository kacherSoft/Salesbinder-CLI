import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { createAxiosClient } from '../axios.factory.js';

const account = {
  subdomain: 'example',
  apiKey: 'test-key',
  apiVersion: '2.0',
};

describe('createAxiosClient retry behavior', () => {
  const originalInitialDelay = process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS;
  let timeoutSpy: jest.SpyInstance;
  let randomSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let dateNowSpy: jest.SpyInstance | undefined;
  let recordedDelays: number[];

  beforeEach(() => {
    recordedDelays = [];
    timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
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

    expect(recordedDelays).toEqual([3000]);
  });

  it('supports an HTTP-date retry-after value', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const retryAt = new Date(now + 3000).toUTCString();
    const { client } = createClientThatFailsOnce(429, { 'retry-after': retryAt });

    await client.get('/items.json');

    expect(recordedDelays).toEqual([3000]);
  });

  it('caps an oversized retry-after delay at 60000ms', async () => {
    process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
    const { client } = createClientThatFailsOnce(429, { 'retry-after': '120' });

    await client.get('/items.json');

    expect(recordedDelays).toEqual([60000]);
  });

  it.each(['-5', '0', 'invalid'])(
    'falls back to exponential backoff for invalid retry-after value %s',
    async (value) => {
      process.env.SALESBINDER_RETRY_INITIAL_DELAY_MS = '25';
      const { client } = createClientThatFailsOnce(429, { 'retry-after': value });

      await client.get('/items.json');

      expect(recordedDelays).toEqual([25]);
    }
  );
});

function createClientThatFailsOnce(status: number, headers: Record<string, string> = {}) {
  return createClientThatFails(status, 1, headers);
}

function createClientThatFails(status: number, failures: number, headers: Record<string, string> = {}) {
  const client = createAxiosClient(account);
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
      throw new AxiosError('Transient error', AxiosError.ERR_BAD_RESPONSE, config, undefined, response);
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
  return { client, adapter };
}
