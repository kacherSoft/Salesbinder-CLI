import type { AxiosRequestConfig } from 'axios';
import { createAxiosClient } from '../../client/axios.factory.js';

describe('authoritative detail request limiter', () => {
  it('runs the request-start gate for the initial request and every retry', async () => {
    const client = createAxiosClient({
      subdomain: 'example',
      apiKey: 'test-key',
      apiVersion: '2.0',
    });
    const beforeRequestStart = jest.fn().mockResolvedValue(undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    client.defaults.adapter = jest.fn(async (config) => {
      attempts++;
      if (attempts === 1) {
        throw {
          config,
          response: { status: 429, headers: { 'retry-after': '0' } },
        };
      }
      return {
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    });
    const config: AxiosRequestConfig & {
      salesBinderBeforeRequestStart: () => Promise<void>;
    } = { salesBinderBeforeRequestStart: beforeRequestStart };

    try {
      await client.get('/documents/doc-1.json', config);
    } finally {
      warn.mockRestore();
    }
    expect(attempts).toBe(2);
    expect(beforeRequestStart).toHaveBeenCalledTimes(2);
  });
});
