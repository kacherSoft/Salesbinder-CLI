import type { GenericAbortSignal } from 'axios';
import {
  RateLimitWaitExceededError,
  SalesBinderRateLimiter,
  createV2RateLimitBucketKey,
  createV3RateLimitBucketKey,
  getDefaultRateLimiterRegistry,
  parseRateLimitHeaders,
  parseRetryAfterMs,
  type RateLimitObserverEvent,
} from '../salesbinder-rate-limiter.js';
import {
  createRateLimitBucketState,
  decideRateLimitGate,
  reserveRateLimitCapacity,
  updateAdaptiveQuota,
} from '../salesbinder-rate-limit-policy.js';

describe('SalesBinderRateLimiter', () => {
  it('provides one module-level registry for default client construction', () => {
    expect(getDefaultRateLimiterRegistry()).toBe(getDefaultRateLimiterRegistry());
  });

  it('prunes idle buckets and requires a fresh v3 bootstrap', async () => {
    let now = 0;
    const limiter = new SalesBinderRateLimiter({
      now: () => now,
      wallNow: () => now,
      idleBucketTtlMs: 100,
    });
    const firstKey = createV3RateLimitBucketKey('example', 'secret');
    await limiter.beforeRequest(firstKey);
    limiter.observeResponse(firstKey, { status: 200, headers: {}, receivedResponse: true });

    now = 101;
    const secondKey = createV3RateLimitBucketKey('example', 'secret');
    await limiter.beforeRequest(secondKey);
    const queued = limiter.beforeRequest(secondKey);
    let queuedReleased = false;
    void queued.then(() => {
      queuedReleased = true;
    });
    await flushPromises();

    expect(queuedReleased).toBe(false);
    limiter.observeResponse(secondKey, { status: 200, headers: {}, receivedResponse: true });
    await expect(queued).resolves.toBeUndefined();
  });

  it('enforces both v2 rolling windows with FIFO reservations', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey(' Example ', '2.0');

    for (let request = 0; request < 45; request++) await limiter.beforeRequest(key);
    expect(clock.nowMs).toBe(30_000);

    await limiter.beforeRequest(key);
    expect(clock.nowMs).toBe(60_000);
    expect(clock.sleeps).toEqual([10_000, 10_000, 10_000, 30_000]);
  });

  it('shares v2 capacity by normalized subdomain instead of credential', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const firstKey = createV2RateLimitBucketKey('Example', '2.0');
    const secondKey = createV2RateLimitBucketKey(' example ', '2.0');

    for (let request = 0; request < 12; request++) await limiter.beforeRequest(firstKey);
    await limiter.beforeRequest(secondKey);

    expect(clock.nowMs).toBe(10_000);
  });

  it('isolates v3 capacity by process-salted credential identity', async () => {
    const limiter = new SalesBinderRateLimiter();
    const firstKey = createV3RateLimitBucketKey('example', 'first-secret');
    const secondKey = createV3RateLimitBucketKey('example', 'second-secret');

    await limiter.beforeRequest(firstKey);
    const queued = limiter.beforeRequest(firstKey);
    let queuedReleased = false;
    void queued.then(() => {
      queuedReleased = true;
    });
    await flushPromises();
    expect(queuedReleased).toBe(false);

    await expect(limiter.beforeRequest(secondKey)).resolves.toBeUndefined();
    limiter.observeResponse(firstKey, { status: 200, headers: {}, receivedResponse: true });
    await expect(queued).resolves.toBeUndefined();
  });

  it('keeps v2 and v3 buckets separate on the same subdomain', async () => {
    const limiter = new SalesBinderRateLimiter();
    const v2Key = createV2RateLimitBucketKey('example', '2.0');
    const v3Key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(v2Key);
    await expect(limiter.beforeRequest(v3Key)).resolves.toBeUndefined();
  });

  it('uses the conservative v3 fallback only after one bootstrap response', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 200, headers: {}, receivedResponse: true });
    for (let request = 1; request < 100; request++) await limiter.beforeRequest(key);
    await limiter.beforeRequest(key);

    expect(clock.nowMs).toBe(60_000);
  });

  it('keeps v3 fallback reservations but discards them after adaptive headers arrive', () => {
    const bucket = createRateLimitBucketState('v3', 0);
    reserveRateLimitCapacity(bucket, 0);
    bucket.v3Initialized = true;

    for (let request = 1; request < 100; request++) reserveRateLimitCapacity(bucket, 0);
    expect(decideRateLimitGate(bucket, 0)).toEqual({ kind: 'wait', waitMs: 60_000 });

    updateAdaptiveQuota(bucket, { limit: 200, remaining: 199, resetSeconds: 60 }, 0);
    expect(bucket.timestamps).toEqual([]);

    reserveRateLimitCapacity(bucket, 60_000);

    expect(bucket.timestamps).toEqual([]);
  });

  it('keeps v3 adaptive timestamp history bounded across 10,000 observed responses', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');
    const headers = {
      'RateLimit-Limit': '200',
      'RateLimit-Remaining': '199',
      'RateLimit-Reset': '60',
    };

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 200, headers, receivedResponse: true });
    for (let request = 1; request <= 10_000; request++) {
      clock.nowMs = request * 60_000;
      await limiter.beforeRequest(key);
      limiter.observeResponse(key, { status: 200, headers, receivedResponse: true });
    }

    expect(clock.sleeps).toEqual([]);
  });

  it('reserves adaptive headroom for fallback requests that are still in flight', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 200, headers: {}, receivedResponse: true });
    for (let request = 0; request < 5; request++) await limiter.beforeRequest(key);

    limiter.observeResponse(key, {
      status: 200,
      headers: {
        'RateLimit-Limit': '10',
        'RateLimit-Remaining': '5',
        'RateLimit-Reset': '60',
      },
      receivedResponse: true,
    });
    await limiter.beforeRequest(key);

    expect(clock.sleeps).toEqual([60_250]);
  });

  it('reserves adaptive headroom again when a quota window rolls over', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');
    const headers = {
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '5',
      'RateLimit-Reset': '60',
    };

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 200,
      headers: { ...headers, 'RateLimit-Remaining': '9' },
      receivedResponse: true,
    });
    for (let request = 0; request < 4; request++) await limiter.beforeRequest(key);

    clock.nowMs = 60_000;
    limiter.observeResponse(key, { status: 200, headers, receivedResponse: true });
    await limiter.beforeRequest(key);
    await limiter.beforeRequest(key);

    expect(clock.sleeps).toEqual([60_250]);
  });

  it('keeps adaptive headroom when a local window resets with outstanding requests', async () => {
    const clock = new ManualClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');
    const events: RateLimitObserverEvent[] = [];

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 200,
      headers: {
        'RateLimit-Limit': '10',
        'RateLimit-Remaining': '10',
        'RateLimit-Reset': '60',
      },
      receivedResponse: true,
    });
    for (let request = 0; request < 9; request++) await limiter.beforeRequest(key);

    clock.nowMs = 60_000;
    const controller = new AbortController();
    const waiting = limiter.beforeRequest(key, controller.signal, (event) => events.push(event));
    await flushPromises();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'wait', apiVersion: 'v3', waitMs: 60_250 }),
      ])
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('adapts safe v3 quota headers and waits through reset plus bounded jitter', async () => {
    const events: RateLimitObserverEvent[] = [];
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(
      key,
      {
        status: 200,
        headers: {
          'RateLimit-Limit': '10',
          'RateLimit-Remaining': '1',
          'RateLimit-Reset': '5',
        },
        receivedResponse: true,
      },
      (event) => events.push(event)
    );
    await limiter.beforeRequest(key, undefined, (event) => events.push(event));

    expect(clock.sleeps).toEqual([5_250]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'headers', limit: 10, remaining: 1, resetSeconds: 5 }),
        expect.objectContaining({ type: 'wait', waitMs: 5_250, apiVersion: 'v3' }),
      ])
    );
  });

  it('does not let an out-of-order v3 response restore already reserved capacity', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');
    const quotaHeaders = {
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '5',
      'RateLimit-Reset': '60',
    };

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 200, headers: quotaHeaders, receivedResponse: true });
    await limiter.beforeRequest(key);
    await limiter.beforeRequest(key);
    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 200,
      headers: { ...quotaHeaders, 'RateLimit-Remaining': '4', 'RateLimit-Reset': '59' },
      receivedResponse: true,
    });

    await limiter.beforeRequest(key);
    await limiter.beforeRequest(key);

    expect(clock.sleeps).toEqual([60_250]);
  });

  it('applies one v2 429 cooldown with positive jitter and retry-after precedence', async () => {
    const events: RateLimitObserverEvent[] = [];
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey('example', '2.0');

    await limiter.beforeRequest(key);
    limiter.observeResponse(
      key,
      {
        status: 429,
        headers: { 'Retry-After': '3', 'RateLimit-Reset': '10' },
        receivedResponse: true,
      },
      (event) => events.push(event)
    );
    await limiter.beforeRequest(key, undefined, (event) => events.push(event));

    expect(clock.sleeps).toEqual([3_250]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'cooldown',
          apiVersion: 'v2',
          waitMs: 3_250,
          retryAfterSeconds: 3,
        }),
      ])
    );
  });

  it('uses 60 seconds plus jitter for a headerless v2 429', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey('example', '2.0');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 429, headers: {}, receivedResponse: true });
    await limiter.beforeRequest(key);

    expect(clock.sleeps).toEqual([60_250]);
  });

  it.each([
    [{ 'Retry-After': '2', 'RateLimit-Reset': '10' }, 2_250],
    [{ 'RateLimit-Reset': '3' }, 3_250],
    [{}, 60_250],
  ])('applies v3 429 precedence without double waiting for headers %p', async (headers, delay) => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, { status: 429, headers, receivedResponse: true });
    await limiter.beforeRequest(key);

    expect(clock.sleeps).toEqual([delay]);
  });

  it('uses retry-after as the sole v3 429 delay when complete quota headers are present', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 429,
      headers: {
        'Retry-After': '2',
        'RateLimit-Limit': '10',
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '1000',
      },
      receivedResponse: true,
    });

    await expect(limiter.beforeRequest(key)).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([2_250]);
  });

  it('fails clearly instead of shortening a server directive over 15 minutes', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey('example', '2.0');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 429,
      headers: { 'Retry-After': '901' },
      receivedResponse: true,
    });

    await expect(limiter.beforeRequest(key)).rejects.toBeInstanceOf(RateLimitWaitExceededError);
    expect(clock.sleeps).toEqual([]);
  });

  it('also rejects an oversized v3 reset directive when retry-after is absent', async () => {
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('example', 'secret');

    await limiter.beforeRequest(key);
    limiter.observeResponse(key, {
      status: 429,
      headers: { 'RateLimit-Reset': '901' },
      receivedResponse: true,
    });

    await expect(limiter.beforeRequest(key)).rejects.toBeInstanceOf(RateLimitWaitExceededError);
    expect(clock.sleeps).toEqual([]);
  });

  it('removes an aborted queued request without disturbing FIFO peers', async () => {
    const clock = new ManualClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey('example', '2.0');
    for (let request = 0; request < 12; request++) await limiter.beforeRequest(key);

    const order: string[] = [];
    const first = limiter.beforeRequest(key).then(() => order.push('first'));
    const controller = new AbortController();
    const aborted = limiter.beforeRequest(key, controller.signal);
    const abortedAssertion = expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    const third = limiter.beforeRequest(key).then(() => order.push('third'));
    controller.abort();
    await abortedAssertion;

    clock.advance(10_000);
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'third']);
  });

  it('advances the queue promptly when the waiting head is aborted', async () => {
    const clock = new ManualClock();
    const limiter = clock.createLimiter();
    const key = createV2RateLimitBucketKey('example', '2.0');
    for (let request = 0; request < 12; request++) await limiter.beforeRequest(key);

    const controller = new AbortController();
    const head = limiter.beforeRequest(key, controller.signal);
    const headAssertion = expect(head).rejects.toMatchObject({ name: 'AbortError' });
    const next = limiter.beforeRequest(key);
    controller.abort();
    await headAssertion;

    clock.advance(10_000);
    await expect(next).resolves.toBeUndefined();
  });

  it('does not expose credentials or fingerprints through observer events', async () => {
    const secret = 'never-observe-this-secret';
    const events: RateLimitObserverEvent[] = [];
    const clock = new AutoAdvanceClock();
    const limiter = clock.createLimiter();
    const key = createV3RateLimitBucketKey('sensitive-subdomain', secret);

    await limiter.beforeRequest(key);
    limiter.observeResponse(
      key,
      {
        status: 429,
        headers: {
          'Retry-After': '1',
          'RateLimit-Limit': '5',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': '2',
          Authorization: `Bearer ${secret}`,
        },
        receivedResponse: true,
      },
      (event) => events.push(event)
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('sensitive-subdomain');
    expect(serialized).not.toContain('Authorization');
    expect(Object.keys(events[0]).sort()).toEqual(
      ['apiVersion', 'limit', 'remaining', 'resetSeconds', 'type'].sort()
    );
  });
});

describe('rate-limit header parsing', () => {
  it('accepts only complete, safe, internally consistent integer quota headers', () => {
    expect(
      parseRateLimitHeaders({
        'ratelimit-limit': '120',
        'ratelimit-remaining': '119',
        'ratelimit-reset': '60',
      })
    ).toEqual({ limit: 120, remaining: 119, resetSeconds: 60 });
    expect(
      parseRateLimitHeaders({
        'ratelimit-limit': '10',
        'ratelimit-remaining': '11',
        'ratelimit-reset': '60',
      })
    ).toBeUndefined();
    expect(
      parseRateLimitHeaders({
        'ratelimit-limit': '1.5',
        'ratelimit-remaining': '1',
        'ratelimit-reset': '60',
      })
    ).toBeUndefined();
  });

  it('parses retry-after seconds and HTTP dates without truncating them', () => {
    const now = Date.UTC(2026, 8, 2, 0, 0, 0);
    expect(parseRetryAfterMs('120', now)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(now + 3_000).toUTCString(), now)).toBe(3_000);
    expect(parseRetryAfterMs('-1', now)).toBeUndefined();
  });
});

class AutoAdvanceClock {
  nowMs = 0;
  readonly sleeps: number[] = [];

  createLimiter(): SalesBinderRateLimiter {
    return new SalesBinderRateLimiter({
      now: () => this.nowMs,
      wallNow: () => this.nowMs,
      random: () => 0,
      sleep: async (delayMs, signal) => {
        if (signal?.aborted) throw abortError();
        this.sleeps.push(delayMs);
        this.nowMs += delayMs;
      },
    });
  }
}

class ManualClock {
  nowMs = 0;
  private readonly timers: Array<{
    deadline: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: GenericAbortSignal;
    onAbort: () => void;
  }> = [];

  createLimiter(): SalesBinderRateLimiter {
    return new SalesBinderRateLimiter({
      now: () => this.nowMs,
      wallNow: () => this.nowMs,
      random: () => 0,
      sleep: (delayMs, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = {
            deadline: this.nowMs + delayMs,
            resolve,
            reject,
            signal,
            onAbort: () => reject(abortError()),
          };
          signal?.addEventListener?.('abort', timer.onAbort, { once: true });
          this.timers.push(timer);
        }),
    });
  }

  advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (const timer of this.timers.splice(0)) {
      timer.signal?.removeEventListener?.('abort', timer.onAbort);
      if (timer.signal?.aborted) timer.reject(abortError());
      else if (timer.deadline <= this.nowMs) timer.resolve();
      else this.timers.push(timer);
    }
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
