import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNKNOWN_ERROR_KIND, createTelemetry, zeroCounters } from './telemetry.js';

describe('zeroCounters', () => {
  it('is what a server that never called Jira reports', () => {
    assert.deepEqual(zeroCounters(), {
      requests: 0,
      retries: 0,
      rateLimitWaits: 0,
      errors: {},
    });
  });

  it('returns a fresh object each call', () => {
    const first = zeroCounters();
    const second = zeroCounters();
    assert.notEqual(first, second);
    assert.notEqual(first.errors, second.errors);
  });
});

describe('createTelemetry', () => {
  it('starts at zero', () => {
    assert.deepEqual(createTelemetry().snapshot(), zeroCounters());
  });

  it('counts requests, retries and rate-limit waits independently', () => {
    const telemetry = createTelemetry();
    telemetry.recordRequest();
    telemetry.recordRequest();
    telemetry.recordRetry();
    telemetry.recordRetry();
    telemetry.recordRetry();
    telemetry.recordRateLimitWait();

    const counters = telemetry.snapshot();
    assert.equal(counters.requests, 2);
    assert.equal(counters.retries, 3);
    assert.equal(counters.rateLimitWaits, 1);
  });

  it('buckets errors by kind and omits kinds that never failed', () => {
    const telemetry = createTelemetry();
    telemetry.recordError('rate_limited');
    telemetry.recordError('auth');
    telemetry.recordError('rate_limited');

    assert.deepEqual(telemetry.snapshot().errors, { auth: 1, rate_limited: 2 });
  });

  it('renders error kinds in a stable (sorted) order', () => {
    const telemetry = createTelemetry();
    telemetry.recordError('transport');
    telemetry.recordError('auth');
    telemetry.recordError('not_found');

    assert.deepEqual(Object.keys(telemetry.snapshot().errors), [
      'auth',
      'not_found',
      'transport',
    ]);
  });

  it('files an empty kind under the unknown bucket', () => {
    const telemetry = createTelemetry();
    telemetry.recordError('');

    assert.deepEqual(telemetry.snapshot().errors, { [UNKNOWN_ERROR_KIND]: 1 });
  });

  it('snapshots are detached from later increments', () => {
    const telemetry = createTelemetry();
    telemetry.recordRequest();
    telemetry.recordError('timeout');
    const before = telemetry.snapshot();

    telemetry.recordRequest();
    telemetry.recordError('timeout');

    assert.equal(before.requests, 1);
    assert.deepEqual(before.errors, { timeout: 1 });
    assert.equal(telemetry.snapshot().requests, 2);
    assert.deepEqual(telemetry.snapshot().errors, { timeout: 2 });
  });

  it('instances never share state', () => {
    const first = createTelemetry();
    const second = createTelemetry();
    first.recordRequest();
    first.recordError('auth');

    assert.deepEqual(second.snapshot(), zeroCounters());
  });
});

describe('rate-limit headroom (D128)', () => {
  const T0 = Date.parse('2026-10-24T10:00:00.000Z');

  it('CC-1450: stays absent while Jira never pushed back', () => {
    const telemetry = createTelemetry();
    telemetry.recordRateLimit({ atMs: T0, limited: false, nearLimit: false });

    assert.equal(telemetry.snapshot().rateLimit, undefined);
  });

  it('CC-1451: NearLimit follows the latest response, a 429 sticks until the next one', () => {
    const telemetry = createTelemetry();
    telemetry.recordRateLimit({ atMs: T0, limited: false, nearLimit: true });
    assert.deepEqual(telemetry.snapshot().rateLimit, { nearLimit: true });

    telemetry.recordRateLimit({
      atMs: T0 + 1000,
      limited: true,
      nearLimit: true,
      reason: 'jira-burst-based',
      resetAtMs: T0 + 3000,
    });
    telemetry.recordRateLimit({ atMs: T0 + 4000, limited: false, nearLimit: false });

    assert.deepEqual(telemetry.snapshot().rateLimit, {
      nearLimit: false,
      lastLimitedAt: '2026-10-24T10:00:01.000Z',
      lastReason: 'jira-burst-based',
      resetAt: '2026-10-24T10:00:03.000Z',
    });

    // A later 429 without a reason or reset replaces the earlier details whole.
    telemetry.recordRateLimit({ atMs: T0 + 5000, limited: true, nearLimit: false });
    assert.deepEqual(telemetry.snapshot().rateLimit, {
      nearLimit: false,
      lastLimitedAt: '2026-10-24T10:00:05.000Z',
    });
  });
});
