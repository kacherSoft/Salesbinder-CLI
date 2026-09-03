---
phase: 1
title: 'Build API-Version-Aware Request Governor'
status: completed
priority: P1
effort: '1.5d'
dependencies: []
---

# Phase 1: Build API-Version-Aware Request Governor

## Context Links

- Plan index: [plan.md](./plan.md)
- Research: [researcher-rate-limiter.md](./research/researcher-rate-limiter.md)
- Official v2 rate limits: <https://www.salesbinder.com/api/v2/getting-started/rate-limiting/>
- Official v3 rate limits: <https://www.salesbinder.com/api/v3/rate-limits/>
- Existing transport: `packages/sdk/src/client/axios.factory.ts`, `packages/sdk/src/client/v3-axios.factory.ts`, `packages/sdk/src/client/retry.handler.ts`
- Existing tests: `packages/sdk/src/client/__tests__/axios.factory.test.ts`, `packages/sdk/src/client/__tests__/v3-axios.factory.test.ts`

## Overview

Add a process-local FIFO request governor in the SDK transport so all SalesBinder requests and retry attempts are paced before dispatch. V2 buckets share by normalized subdomain/API version; v3 buckets additionally use a process-salted, never-exposed credential fingerprint because v3 allowances are per API key.

## Key Insights

- `createAxiosClient` installs Basic auth and retry interceptors for v2; retries call `client.request(config)`, so retry attempts can pass through request interceptors.
- `createV3AxiosClient` duplicates retry logic with Bearer auth and `/api/v3`.
- Current retry fallback can exhaust retries before the v2 documented 1-minute block expires when 429 has no `Retry-After`.
- V3 limits are per API key and explicitly header-adaptive; current `120/60s` is a default, not a permanent client constant.
- Existing cache locks guard cache writers only; they do not pace general CLI list/get/create/update/delete commands.

## Requirements

- Functional: install limiter in v2 and v3 Axios factories; all normal and retry requests call limiter before dispatch through one package-level registry shared by every client instance.
- Functional: v2 policy uses rolling windows `45 requests/60s` and `12 requests/10s`; 429 with no usable retry/reset header applies at least `60s + jitter` cooldown.
- Functional: v3 releases only one bootstrap request before receiving its first allowance response, then learns `RateLimit-Limit`, `RateLimit-Remaining`, and relative-seconds `RateLimit-Reset`; missing headers use a conservative `100/60s` fallback. A 429 uses `Retry-After`, then reset, then `60s + jitter` fallback.
- Functional: one absolute limiter deadline owns 429 waiting. Retry code re-enters `client.request` immediately and waits at the request gate; it must not sleep for 429 a second time. Network/5xx keep exponential backoff.
- Functional: retry GET/HEAD transient failures. Do not retry v2 mutations automatically. For v3 mutations, retry 429 because SalesBinder documents pre-action rejection; retry network/5xx only when the original request already has an `Idempotency-Key`, preserved unchanged.
- Functional: parse only safe integer quota headers with `limit >= 1` and `0 <= remaining <= limit`. Wait at most 15 minutes; if a valid server directive exceeds that operational ceiling, fail clearly rather than shorten it and retry early.
- Functional: queued requests honor `AbortSignal`, leave the FIFO queue promptly on abort, and never dispatch after cancellation.
- Functional: retain `SALESBINDER_RETRY_INITIAL_DELAY_MS`; do not add MVP env knobs for rate-limit tuning.
- Functional: keep v3 cache resources requiring `v3ApiKey`; no v2 fallback.
- Non-functional: monotonic scheduling clock, fake-clock-friendly deterministic tests, FIFO fairness, bounded positive jitter, idle-bucket pruning, and no credential or Authorization data in logs/events/errors.

## Architecture

Create one SDK module with a module-level default registry plus injectable test registry. The factories install interceptors in an explicitly tested order: request metadata executes before the limiter gate; the limiter response observer sees success/429 before the retry handler consumes the response. On 429 the response observer records one absolute cooldown deadline without sleeping; the retry handler reissues through `client.request`, and the request gate performs the only wait. Other queued requests share that deadline.

Add optional backward-compatible runtime options to both SDK clients/factories, including a redacted rate-limit observer and injected registry for tests. Retry logging routes through this observer when provided; cache sync can render one coherent progress stream instead of competing `console.warn` output.

Process-local registry is MVP. Distributed coordination is deferred because it needs durable bucket storage, crash recovery, TTLs, and clock-skew handling. Existing SQLite sidecar and PostgreSQL advisory locks remain unchanged as cache-writer collision protection only.

## Related Code Files

- Create: `packages/sdk/src/client/salesbinder-rate-limiter.ts`
- Create: `packages/sdk/src/client/__tests__/salesbinder-rate-limiter.test.ts`
- Modify: `packages/sdk/src/client/axios.factory.ts`
- Modify: `packages/sdk/src/client/v3-axios.factory.ts`
- Modify: `packages/sdk/src/client/retry.handler.ts` if shared retry parsing belongs there after tests prove duplication risk
- Modify: `packages/sdk/src/client/__tests__/axios.factory.test.ts`
- Modify: `packages/sdk/src/client/__tests__/v3-axios.factory.test.ts`
- Modify: `packages/sdk/src/resources/index.ts` only if factory constructor parameters must pass account identity data already unavailable
- Delete: none

## Tests Before

1. Add failing unit tests for `SalesBinderRateLimiter` with fake clock: v2 12/10s, v2 45/60s, 13th/46th delayed until window clears, FIFO ordering, and two client instances sharing the same default bucket.
2. Add failing cooldown tests: v2 429 without headers waits at least 60s plus bounded jitter; valid `Retry-After` wins and adds jitter.
3. Add failing identity/adaptation tests: two v2 keys on one normalized subdomain share a bucket; v2/v3 split; two v3 keys remain independent; v3 bootstrap permits one request before header learning; invalid headers ignored; 429 precedence `Retry-After` > reset > fallback.
4. Add failing factory/interceptor-order test proving the original 429 is observed, both dispatch attempts hit the limiter, no double-wait occurs, and request ID/idempotency key remain stable.
5. Add failing safety tests: aborted queued request is removed and never dispatched; huge/contradictory headers fail or fall back predictably; GET retries, v2 mutations do not, and v3 mutation network/5xx retries require an existing idempotency key.
6. Add failing redaction test: observer/log data exposes API version and numeric quota timing only, no credentials, fingerprints, Authorization header, or full secret-bearing URL.

## Refactor

1. Extract duplicated retry-after parsing into a shared helper only after failing tests exist.
2. Keep limiter independent of Axios core where possible: pure bucket scheduling and header parsing first, Axios install wrapper second.
3. Keep `retry.handler.ts` either updated as a real shared helper or leave it untouched; do not broaden public SDK surface unless tests need exports.

## Implementation Steps

1. Implement `RateLimitBucketKey`, `RateLimitPolicy`, `SalesBinderRateLimiter`, package-level default registry, `parseRetryAfterMs`, bounded `parseRateLimitHeaders`, and redacted observer event types. Use a random process salt for v3 key fingerprinting and prune idle buckets after bounded inactivity.
2. Implement v2 dual rolling-window scheduler with immediate reservation before dispatch and FIFO queue resolution.
3. Implement v3 one-request bootstrap, adaptive header state, reserve/headroom, and cooldown deadline handling.
4. Add exact interceptor installation helper. In v2, derive bucket from normalized subdomain + API version. In v3, add the process-salted v3-key fingerprint.
5. Add optional `ClientRuntimeOptions` to `createAxiosClient`, `createV3AxiosClient`, `SalesBinderClient`, and `SalesBinderV3Client`; keep all existing one-argument callers valid.
6. Split retry policy by method/idempotency and by 429 versus network/5xx. Remove the 60-second truncation for valid server waits; reject directives above 15 minutes instead of retrying early. Keep the existing delay env for non-429 backoff.
7. Route retry/rate observability through the optional observer. Preserve current console warning behavior only for callers that provide no observer.
8. Make waits abort-aware and prove queue advancement after cancellation.
9. Do not remove `PAYMENT_DETAIL_DELAY_MS` yet; cleanup waits for real sync evidence after limiter ships.

## Todo List

- [x] Write failing limiter policy and parsing tests.
- [x] Implement fake-clock-friendly limiter core.
- [x] Wire limiter into v2/v3 factories.
- [x] Prove retries go through limiter.
- [x] Prove v2 subdomain sharing, v3 credential isolation, cross-client registry sharing, cancellation, and redaction.
- [x] Prove safe-method/idempotency retry policy and one-owner cooldown.
- [x] Keep existing retry tests green.

## Tests After

1. Run `pnpm --filter @salesbinder/sdk exec jest --runInBand src/client`.
2. Run focused cache payment/document tests that depend on retry/pacing: `pnpm --filter @salesbinder/sdk exec jest --runInBand src/cache/__tests__/payment-sync.service.test.ts src/cache/__tests__/sync-resume-indexers.test.ts`.
3. Run `pnpm --filter @salesbinder/sdk build`.

## Regression Gate

- No request path bypasses limiter, including retry attempts.
- V3 cache sync still fails before cache mutation when `v3ApiKey` missing.
- Existing safe-read retry behavior remains compatible for 522, network errors, `Retry-After`, and `SALESBINDER_RETRY_INITIAL_DELAY_MS`; unsafe automatic write replay is intentionally removed.
- No printed/persisted value contains raw credentials, Authorization headers, full fingerprints, payloads, or record/customer names.

## Success Criteria

- [x] Limiter is process-local, FIFO, v2-subdomain/v3-credential scoped, shared across client instances, and enabled by default.
- [x] V2 and v3 official rate contracts are reflected by tests.
- [x] Retry attempts are governed before dispatch.
- [x] Existing cache writer locks and payment delay remain in place.
- [x] No public behavior change except safer pacing and redacted optional observer data.

## Risk Assessment

- Risk: limiter delays make tests slow. Mitigation: injectable clock/sleeper and jitter source.
- Risk: v3 header interpretation wrong under clock drift. Mitigation: treat `RateLimit-Reset` as seconds from response, add jitter, ignore invalid headers.
- Risk: process-local registry misses multi-process bursts. Mitigation: document residual limitation; defer durable coordination until observed need.
- Risk: queued work survives caller cancellation. Mitigation: AbortSignal-aware queue removal and dispatch tests.
- Risk: status and retry layers both wait. Mitigation: one absolute limiter deadline; fake-clock elapsed-time test.
- Risk: retry helper refactor expands blast radius. Mitigation: tests first; avoid refactor if install helper can stay small.

## Security Considerations

- Fingerprint v3 credentials with a random process salt only for in-memory bucket separation. Never log raw key, Authorization header, Basic/Bearer value, or any fingerprint.
- Observer events can include API version, wait duration, reset seconds, remaining, and limit only.
- Do not persist limiter registry state in MVP.

## Rollback / Next

- Rollback: remove factory limiter installation and new limiter module/tests; retry-only behavior returns.
- Next: Phase 2 consumes optional limiter observer events as `waiting_rate_limit` progress without per-request metadata churn.

## Validation Log

- Verified `createAxiosClient` lines 47-135, Basic auth lines 58-63, retry statuses lines 89-95, retry path lines 123-131.
- Verified `createV3AxiosClient` lines 35-94, v3 key requirement lines 36-38, Bearer header line 44, retry path lines 72-89.
- Verified stale `retry.handler.ts` is imported for `RetryConfig` by both factories.
- Verified `PAYMENT_DETAIL_DELAY_MS` at `packages/sdk/src/cache/payment-cache.constants.ts:10-13`.
- Red-team decisions applied: v2 subdomain scope, singleton registry, exact interceptor order, single cooldown owner, abort-aware FIFO, bounded headers, method-aware retry safety, and injectable observer.
- Focused request-governor validation passed: 67/67 tests; final serialized SDK validation passed: 32/32 suites, 743/743 tests.

## Unresolved Questions

None.
