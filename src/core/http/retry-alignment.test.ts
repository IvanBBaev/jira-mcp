// Retry alignment with Atlassian's rate-limiting guidance (D534, V3-51):
// a 503's `Retry-After` is honoured, a spent quota holds the host until its
// reset instant, and a 429 on an unsafe write is still replayed.
//
// Driven like the wire tier in `../http.test.ts`: the fake clock owns time, a
// scripted rng owns jitter, `withFetch` owns the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

import { JiraError } from '../types.js';
import type { HostRef, JiraRequestSpec, LogEvent, Rng } from '../types.js';
import { createFakeClock } from '../fakes/fakeClock.js';
import type { FakeClock } from '../fakes/fakeClock.js';
import { createFakeLogger } from '../fakes/fakeLogger.js';
import type { FakeLogger } from '../fakes/fakeLogger.js';
import { withFetch } from '../../testing/with-fetch.js';
import type { FetchMock } from '../../testing/with-fetch.js';
import { MAX_QUOTA_HOLD_MS } from '../http-util.js';
import { createJiraRequest } from './jira-request.js';
import type { JiraHttpOptions } from './jira-request.js';
import type { BasicCredentials } from './credentials.js';

const START_MS = 1_700_000_000_000;
const SITE: HostRef = { origin: 'https://acme.atlassian.net', pathPrefix: '' };
const OTHER_SITE: HostRef = { origin: 'https://other.atlassian.net', pathPrefix: '' };

function credentialsFor(host: HostRef): BasicCredentials {
  return { kind: 'basic', host, email: 'me@example.com', apiToken: 'token-value' };
}

const GET_ISSUE: JiraRequestSpec = { method: 'GET', path: '/issue/ABC-1' };
const CREATE_ISSUE: JiraRequestSpec = {
  method: 'POST',
  path: '/issue',
  body: { fields: { summary: 'x' } },
};
const QUOTA_429 = {
  status: 429,
  headers: { 'retry-after': '1800', 'ratelimit-reason': 'jira-quota-tenant-based' },
} as const;

function scriptedRng(values: readonly number[] = [0]): Rng {
  let i = 0;
  return () => {
    const value = values[i % values.length] ?? 0;
    i += 1;
    return value;
  };
}

function harness(overrides: Partial<JiraHttpOptions> = {}): {
  readonly request: ReturnType<typeof createJiraRequest>;
  readonly clock: FakeClock;
  readonly logger: FakeLogger;
} {
  const clock = createFakeClock(START_MS);
  const logger = createFakeLogger({ clock });
  const request = createJiraRequest({
    credentials: credentialsFor(SITE),
    clock,
    rng: scriptedRng(),
    logger,
    ...overrides,
  });
  return { request, clock, logger };
}

/** Await `promise` while ticking the fake clock past every pending sleep. */
async function settle<T>(
  clock: FakeClock,
  promise: Promise<T>,
  stepMs = 1_000,
): Promise<T> {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      throw error;
    },
  );
  tracked.catch(() => {
    /* the assertion owns this rejection */
  });
  for (let i = 0; i < 500 && !done; i += 1) {
    await tick();
    await tick();
    if (done) break;
    if (clock.pendingSleeps() > 0) clock.advance(stepMs);
  }
  return tracked;
}

async function rejects(clock: FakeClock, promise: Promise<unknown>): Promise<JiraError> {
  try {
    await settle(clock, promise);
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the request to reject');
}

function fieldsOf(event: LogEvent | undefined): Readonly<Record<string, unknown>> {
  return event?.fields ?? {};
}

function retryDelay(logger: FakeLogger, index = 0): unknown {
  return fieldsOf(logger.eventsOf('http_retry')[index])['delayMs'];
}

/* ------------------------------------------------------------------------- *
 * 503 Retry-After
 * ------------------------------------------------------------------------- */

test('[CC-5290] a 503 with Retry-After: 3 waits 3 s before the retry', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 503, headers: { 'retry-after': '3' } })
      .enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness();

    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
    assert.equal(retryDelay(logger), 3_000);
    assert.equal(fieldsOf(logger.eventsOf('http_retry')[0])['reason'], '5xx');
    assert.equal(clock.now() - START_MS >= 3_000, true, 'the wait really happened');
    assert.equal(logger.eventsOf('rate_limited').length, 0, 'a 503 is not a 429');
  });
});

test('[CC-5291] a 503 Retry-After below the backoff still waits the backoff', async () => {
  for (const header of ['0', 'not-a-number']) {
    await withFetch(async (mock: FetchMock) => {
      mock
        .enqueue({ status: 503, headers: { 'retry-after': header } })
        .enqueue({ json: { ok: true } });
      const { request, clock, logger } = harness();

      await settle(clock, request(GET_ISSUE));

      assert.equal(retryDelay(logger), 500, header);
    });
  }
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 503 })
      .enqueue({ status: 503 })
      .enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness();

    await settle(clock, request(GET_ISSUE));

    assert.equal(retryDelay(logger, 0), 500, 'no header: the plain backoff');
    assert.equal(retryDelay(logger, 1), 1_000);
  });
});

test('[CC-5292] a day-long 503 Retry-After is capped at 60 s plus at most 20 % jitter', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 503, headers: { 'retry-after': '86400' } })
      .enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness({ rng: scriptedRng([1]) });

    await settle(clock, request(GET_ISSUE), 10_000);

    const waited = retryDelay(logger) as number;
    assert.ok(waited >= 60_000 && waited <= 72_000, String(waited));
  });
});

test('[CC-5293] a 503 Retry-After in HTTP-date form is honoured', async () => {
  await withFetch(async (mock: FetchMock) => {
    const at = new Date(START_MS + 5_000).toUTCString();
    mock
      .enqueue({ status: 503, headers: { 'retry-after': at } })
      .enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness();

    await settle(clock, request(GET_ISSUE));

    // START_MS is a whole second, so the date form loses nothing.
    assert.equal(retryDelay(logger), 5_000);
  });
});

test('[CC-5294] Retry-After on a 502 or 504 is not read: the backoff applies', async () => {
  for (const status of [502, 504]) {
    await withFetch(async (mock: FetchMock) => {
      mock
        .enqueue({ status, headers: { 'retry-after': '10' } })
        .enqueue({ json: { ok: true } });
      const { request, clock, logger } = harness();

      await settle(clock, request(GET_ISSUE));

      assert.equal(retryDelay(logger), 500, String(status));
    });
  }
});

test('[CC-5295] an unsafe POST answered 503 with Retry-After is still never replayed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.fallback({ status: 503, headers: { 'retry-after': '1' } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(CREATE_ISSUE));

    assert.equal(err.kind, 'ambiguous_write');
    assert.equal(mock.requests.length, 1);
  });
});

/* ------------------------------------------------------------------------- *
 * Quota hold
 * ------------------------------------------------------------------------- */

test('[CC-5296] after a quota 429 the next call to the host is refused before the wire', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue(QUOTA_429).fallback({ json: { ok: true } });
    const { request, clock, logger } = harness();

    const first = await rejects(clock, request(GET_ISSUE));
    assert.equal(first.kind, 'rate_limited');
    assert.equal(mock.requests.length, 1);

    const second = await rejects(clock, request(GET_ISSUE));

    assert.equal(mock.requests.length, 1, 'the second call sent nothing');
    assert.equal(second.kind, 'rate_limited');
    assert.equal(second.httpStatus, undefined, 'nothing answered this call');
    const resetAt = new Date(START_MS + 1_800_000).toISOString();
    assert.match(
      second.message,
      /was not sent: the jira-quota-tenant-based rate-limit quota/,
    );
    assert.ok(second.message.includes(resetAt), second.message);
    assert.match(second.remediation ?? '', /Do not retry before/);
    const events = logger.eventsOf('rate_limited');
    assert.equal(events.length, 2);
    assert.equal(fieldsOf(events[1])['retryAfterS'], 1_800);
    assert.equal(fieldsOf(events[1])['waitS'], 0);
    assert.equal(fieldsOf(events[1])['reason'], 'jira-quota-tenant-based');
  });
});

test('[CC-5297] the hold closes at the reset instant: that call is sent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue(QUOTA_429).fallback({ json: { ok: true } });
    const { request, clock } = harness();
    await rejects(clock, request(GET_ISSUE));

    clock.advance(1_800_000 - 1);
    await rejects(clock, request(GET_ISSUE));
    assert.equal(mock.requests.length, 1, 'one millisecond early is still held');

    clock.advance(1);
    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
  });
});

test('[CC-5298] the hold is per host', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue(QUOTA_429).fallback({ json: { ok: true } });
    const { request, clock } = harness({
      credentials: (profile?: string) =>
        credentialsFor(profile === 'other' ? OTHER_SITE : SITE),
    });
    await rejects(clock, request(GET_ISSUE));

    const res = await settle(clock, request({ ...GET_ISSUE, profile: 'other' }));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests[1]?.url.startsWith(OTHER_SITE.origin));
  });
});

test('[CC-5299] a quota 429 with no reset instant opens no hold', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({
        status: 429,
        headers: { 'ratelimit-reason': 'jira-quota-global-based' },
      })
      .fallback({ json: { ok: true } });
    const { request, clock } = harness();
    await rejects(clock, request(GET_ISSUE));

    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
  });
});

test('[CC-5300] a hold never outlasts one quota window, whatever the header says', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({
        status: 429,
        headers: {
          'retry-after': '864000',
          'ratelimit-reason': 'jira-quota-tenant-based',
        },
      })
      .fallback({ json: { ok: true } });
    const { request, clock } = harness();
    await rejects(clock, request(GET_ISSUE));

    clock.advance(MAX_QUOTA_HOLD_MS);
    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(MAX_QUOTA_HOLD_MS, 3_600_000);
  });
});

test('[CC-5301] a burst or per-issue 429 opens no hold', async () => {
  for (const reason of ['jira-burst-based', 'jira-per-issue-on-write']) {
    await withFetch(async (mock: FetchMock) => {
      mock.fallback({
        status: 429,
        headers: { 'retry-after': '1', 'ratelimit-reason': reason },
      });
      const { request, clock } = harness({ retryAttempts: 0 });
      await rejects(clock, request(GET_ISSUE));
      await rejects(clock, request(GET_ISSUE));

      assert.equal(mock.requests.length, 2, reason);
    });
  }
});

test('[CC-5302] the hold takes its instant from X-RateLimit-Reset when Retry-After is absent', async () => {
  await withFetch(async (mock: FetchMock) => {
    const resetAt = new Date(START_MS + 600_000).toISOString();
    mock
      .enqueue({
        status: 429,
        headers: {
          'x-ratelimit-reset': resetAt,
          'ratelimit-reason': 'jira-quota-tenant-based',
        },
      })
      .fallback({ json: { ok: true } });
    const { request, clock } = harness();
    await rejects(clock, request(GET_ISSUE));

    const held = await rejects(clock, request(GET_ISSUE));
    assert.ok(held.message.includes(resetAt), held.message);

    clock.advance(600_000);
    await settle(clock, request(GET_ISSUE));
    assert.equal(mock.requests.length, 2);
  });
});

test('[CC-5303] an unsafe write during a hold is refused with nothing sent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue(QUOTA_429).fallback({ status: 201, json: { key: 'ABC-2' } });
    const { request, clock } = harness();
    await rejects(clock, request(GET_ISSUE));

    const err = await rejects(clock, request(CREATE_ISSUE));

    assert.equal(err.kind, 'rate_limited');
    assert.equal(mock.requests.length, 1);
  });
});

test('[CC-5304] a later quota 429 extends the hold; a shorter one does not shrink it', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue(QUOTA_429)
      .enqueue({
        status: 429,
        headers: { 'retry-after': '60', 'ratelimit-reason': 'jira-quota-tenant-based' },
      })
      .fallback({ json: { ok: true } });
    const clock = createFakeClock(START_MS);
    const logger = createFakeLogger({ clock });
    // Two in flight before either 429 lands: both reach the wire.
    const request = createJiraRequest({
      credentials: credentialsFor(SITE),
      clock,
      rng: scriptedRng(),
      logger,
    });
    const both = Promise.allSettled([request(GET_ISSUE), request(GET_ISSUE)]);
    await settle(clock, both);
    assert.equal(mock.requests.length, 2);

    clock.advance(60_000);
    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(
      err.kind,
      'rate_limited',
      'the 60 s answer did not shrink the 30 min hold',
    );
    assert.equal(mock.requests.length, 2);
  });
});

/* ------------------------------------------------------------------------- *
 * 429 on an unsafe write (JIR-05)
 * ------------------------------------------------------------------------- */

test('[CC-5305] a POST answered 429 without Retry-After is replayed after the backoff', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 429 }).enqueue({ status: 201, json: { key: 'ABC-2' } });
    const { request, clock, logger } = harness();

    const res = await settle(clock, request(CREATE_ISSUE));

    assert.equal(res.status, 201);
    assert.equal(mock.requests.length, 2, 'the 429 applied nothing, so it is resent');
    assert.equal(mock.requests[1]?.body, mock.requests[0]?.body);
    assert.equal(fieldsOf(logger.eventsOf('http_retry')[0])['reason'], '429');
    assert.equal(retryDelay(logger), 500);
  });
});

test('[CC-5306] a POST answered with a per-issue 429 is replayed after its Retry-After', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({
        status: 429,
        headers: { 'retry-after': '2', 'ratelimit-reason': 'jira-per-issue-on-write' },
      })
      .enqueue({ status: 201, json: { key: 'ABC-2' } });
    const { request, clock, logger } = harness();

    await settle(clock, request(CREATE_ISSUE));

    assert.equal(mock.requests.length, 2);
    assert.equal(retryDelay(logger), 2_000);
  });
});
