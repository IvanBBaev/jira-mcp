// Wire-tier tests for the Jira HTTP client (TESTING.md suite 2).
//
// Everything is driven deterministically: the fake clock owns time (no test
// waits on a real backoff), a scripted rng owns jitter, and `withFetch` — or a
// purpose-built stub when a test needs to inspect `init` or hang forever — owns
// the network. Nothing here can reach a socket: the network fence is installed
// by the runner and `withFetch` restores it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

import { REMEDIATION } from './errors.js';
import { JiraError } from './types.js';
import type { HostRef, JiraRequestFn, JiraRequestSpec, LogEvent, Rng } from './types.js';
import { createFakeClock } from './fakes/fakeClock.js';
import type { FakeClock } from './fakes/fakeClock.js';
import { createFakeLogger } from './fakes/fakeLogger.js';
import type { FakeLogger } from './fakes/fakeLogger.js';
import { createFakeRedactor } from './fakes/fakeRedactor.js';
import { withFetch } from '../testing/with-fetch.js';
import type { FetchMock } from '../testing/with-fetch.js';
import { MAX_ATTACHMENT_BYTES } from './http-util.js';
import { createJiraRequest } from './http.js';
import type { JiraHttpOptions } from './http.js';
import { UNKNOWN_ERROR_KIND, createTelemetry } from './telemetry.js';

const SITE: HostRef = { origin: 'https://acme.atlassian.net', pathPrefix: '' };
const TOKEN = 'super-secret-token';

const CREDENTIALS = { host: SITE, email: 'me@example.com', apiToken: TOKEN };

interface Harness {
  readonly request: JiraRequestFn;
  readonly clock: FakeClock;
  readonly logger: FakeLogger;
}

/** Rng that walks a fixed script so every jitter value is predictable. */
function scriptedRng(values: readonly number[] = [0]): Rng {
  let i = 0;
  return () => {
    const value = values[i % values.length] ?? 0;
    i += 1;
    return value;
  };
}

function harness(overrides: Partial<JiraHttpOptions> = {}): Harness {
  const clock = createFakeClock(1_700_000_000_000);
  const logger = createFakeLogger({ clock });
  const request = createJiraRequest({
    credentials: CREDENTIALS,
    clock,
    rng: scriptedRng(),
    logger,
    ...overrides,
  });
  return { request, clock, logger };
}

/**
 * Await `promise` while ticking the fake clock, so a retry's `clock.sleep`
 * resolves without any real timer. Microtasks are flushed before each advance,
 * which keeps a response that is already in flight ahead of the timeout.
 */
async function settle<T>(
  clock: FakeClock,
  promise: Promise<T>,
  stepMs = 30_000,
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
    /* the assertion below owns this rejection */
  });

  for (let i = 0; i < 200 && !done; i += 1) {
    await tick();
    await tick();
    if (done) break;
    if (clock.pendingSleeps() > 0) clock.advance(stepMs);
  }
  return tracked;
}

/** The JiraError a request is expected to reject with. */
async function rejects(
  clock: FakeClock,
  promise: Promise<unknown>,
  stepMs?: number,
): Promise<JiraError> {
  try {
    await settle(clock, promise, stepMs);
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the request to reject');
}

function fieldsOf(event: LogEvent | undefined): Readonly<Record<string, unknown>> {
  return event?.fields ?? {};
}

const GET_ISSUE: JiraRequestSpec = { method: 'GET', path: '/issue/ABC-1' };

/* ------------------------------------------------------------------------- *
 * Request shaping
 * ------------------------------------------------------------------------- */

test('a GET is sent to the v3 root with Basic auth and no content-type', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { key: 'ABC-1' } });
    const { request, clock } = harness();

    const res = await settle(clock, request<{ key: string }>(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { key: 'ABC-1' });
    const sent = mock.lastRequest();
    assert.equal(sent?.method, 'GET');
    assert.equal(sent?.url, 'https://acme.atlassian.net/rest/api/3/issue/ABC-1');
    assert.equal(
      sent?.headers['authorization'],
      `Basic ${Buffer.from(`me@example.com:${TOKEN}`).toString('base64')}`,
    );
    assert.equal(sent?.headers['accept'], 'application/json');
    assert.equal(sent?.headers['content-type'], undefined);
    assert.equal(sent?.body, undefined);
  });
});

test('a POST body is JSON-serialized and carries content-type', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 201, json: { id: '1' } });
    const { request, clock } = harness();

    await settle(
      clock,
      request({ method: 'POST', path: '/issue', body: { fields: { summary: 'x' } } }),
    );

    const sent = mock.lastRequest();
    assert.equal(sent?.headers['content-type'], 'application/json');
    assert.equal(sent?.body, '{"fields":{"summary":"x"}}');
  });
});

test('the agile root and query parameters reach the wire encoded', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { values: [] } });
    const { request, clock } = harness();

    await settle(
      clock,
      request({
        method: 'GET',
        root: 'agile',
        path: '/board/1/sprint',
        query: { state: 'active future', maxResults: 50, startAt: undefined },
      }),
    );

    assert.equal(
      mock.lastRequest()?.url,
      'https://acme.atlassian.net/rest/agile/1.0/board/1/sprint?state=active+future&maxResults=50',
    );
  });
});

test('response headers are exposed lowercased, and 204 yields no data', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 204, headers: { 'X-AACCOUNTID': 'abc' } });
    const { request, clock } = harness();

    const res = await settle(clock, request({ method: 'DELETE', path: '/issue/ABC-1' }));

    assert.equal(res.status, 204);
    assert.equal(res.data, undefined);
    assert.equal(res.headers['x-aaccountid'], 'abc');
  });
});

test('an id that is a path-traversal attempt never reaches the wire', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ method: 'GET', path: '/issue/../../../admin' }),
    );
    assert.equal(err.kind, 'validation');
    assert.equal(mock.requests.length, 0, 'nothing may be sent');
  });
});

/* ------------------------------------------------------------------------- *
 * Host policy (CC-27/CC-28)
 * ------------------------------------------------------------------------- */

test('a host that merely ends with atlassian.net is refused before any request', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness({
      credentials: {
        ...CREDENTIALS,
        host: { origin: 'https://evil-atlassian.net', pathPrefix: '' },
      },
    });

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'config');
    assert.match(err.message, /not in the allowed-host list/);
    assert.equal(mock.requests.length, 0);
  });
});

test('an allowlisted private host is still blocked (allowlist never widens the blocklist)', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness({
      credentials: {
        ...CREDENTIALS,
        host: { origin: 'https://169.254.169.254', pathPrefix: '' },
      },
      allowedHosts: ['169.254.169.254'],
    });

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'config');
    assert.match(err.message, /never contacted/);
    assert.equal(mock.requests.length, 0);
  });
});

test('an allowlisted Server/DC host is accepted', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { ok: true } });
    const { request, clock } = harness({
      credentials: {
        ...CREDENTIALS,
        host: { origin: 'https://jira.example.com', pathPrefix: '' },
      },
      allowedHosts: ['/^jira\\.example\\.com$/'],
    });

    await settle(clock, request(GET_ISSUE));
    assert.equal(
      mock.lastRequest()?.url,
      'https://jira.example.com/rest/api/3/issue/ABC-1',
    );
  });
});

test('fetch is called with redirect: manual, so no redirect is ever followed', async () => {
  const previous = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push(init ?? {});
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      }),
    );
  };
  try {
    const { request, clock } = harness();
    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(seen.length, 1, 'the redirect must not produce a second request');
    assert.equal(seen[0]?.redirect, 'manual');
    assert.equal(err.kind, 'config');
    assert.match(err.message, /evil\.example\.com/);
    assert.match(err.message, /never followed/);
    assert.equal(err.retryable, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a same-host redirect is refused too, and the Authorization header is sent once', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 301,
      headers: { location: 'https://acme.atlassian.net/rest/api/3/issue/ABC-2' },
    });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'config');
    assert.equal(mock.requests.length, 1);
  });
});

/* ------------------------------------------------------------------------- *
 * Retry matrix (CC-11…CC-14)
 * ------------------------------------------------------------------------- */

test('a 503 on a GET is retried with the documented backoff sequence', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 503 })
      .enqueue({ status: 503 })
      .enqueue({ json: { key: 'ABC-1' } });
    const { request, clock, logger } = harness({ rng: scriptedRng([0]) });

    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 3);
    const delays = logger.eventsOf('http_retry').map((e) => fieldsOf(e)['delayMs']);
    assert.deepEqual(delays, [500, 1000]);
  });
});

test('a 503 on a POST is NOT retried and surfaces as an ambiguous write', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503 });
    const { request, clock, logger } = harness();

    const err = await rejects(
      clock,
      request({ method: 'POST', path: '/issue', body: { a: 1 } }),
    );

    assert.equal(mock.requests.length, 1, 'an unsafe write is never replayed');
    assert.equal(err.kind, 'ambiguous_write');
    assert.equal(err.retryable, false);
    assert.match(err.message, /NOT retried/);
    assert.equal(logger.has('ambiguous_write'), true);
  });
});

test('a POST marked safe (search/jql) IS retried on 503', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503 }).enqueue({ json: { issues: [] } });
    const { request, clock } = harness();

    const res = await settle(
      clock,
      request({ method: 'POST', path: '/search/jql', body: { jql: 'x' }, safe: true }),
    );

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
  });
});

test('429 is retried for every method, including an unsafe PUT', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    await withFetch(async (mock: FetchMock) => {
      mock
        .enqueue({ status: 429, headers: { 'retry-after': '2' } })
        .enqueue({ json: { ok: true } });
      const { request, clock } = harness();

      const res = await settle(clock, request({ method, path: '/issue/ABC-1' }));

      assert.equal(res.status, 200, method);
      assert.equal(mock.requests.length, 2, method);
    });
  }
});

test('Retry-After is honoured and capped at 60 s with injected jitter (CC-14)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 429, headers: { 'retry-after': '86400' } })
      .enqueue({ json: { ok: true } });
    // rng = 1 → the maximum jitter the policy allows on top of the cap.
    const { request, clock, logger } = harness({ rng: scriptedRng([1]) });

    await settle(clock, request(GET_ISSUE), 72_000);

    const waited = fieldsOf(logger.eventsOf('http_retry')[0])['delayMs'];
    assert.equal(typeof waited, 'number');
    assert.ok((waited as number) >= 60_000, 'the cap itself is respected');
    assert.ok(
      (waited as number) <= 72_000,
      'a day-long Retry-After is capped, not obeyed',
    );

    const limited = fieldsOf(logger.eventsOf('rate_limited')[0]);
    assert.equal(limited['retryAfterS'], 86_400);
    assert.equal(limited['waitS'], 72);
  });
});

test('a 429 with no Retry-After falls back to exponential backoff', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 429 }).enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness();

    await settle(clock, request(GET_ISSUE));

    assert.equal(fieldsOf(logger.eventsOf('http_retry')[0])['delayMs'], 500);
    assert.equal(fieldsOf(logger.eventsOf('rate_limited')[0])['retryAfterS'], undefined);
  });
});

test('a 429 that outlives the retry budget surfaces as rate_limited', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 4; i += 1)
      mock.enqueue({ status: 429, headers: { 'retry-after': '1' } });
    const { request, clock } = harness({ retryAttempts: 3 });

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(mock.requests.length, 4, '3 retries = 4 total tries');
    assert.equal(err.kind, 'rate_limited');
    assert.equal(err.httpStatus, 429);
    assert.equal(err.retryable, true);
  });
});

test('a transport failure is retried for a GET and not for a POST', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ error: new TypeError('fetch failed') })
      .enqueue({ json: { ok: true } });
    const { request, clock } = harness();
    const res = await settle(clock, request(GET_ISSUE));
    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
  });

  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ error: new TypeError('fetch failed') });
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ method: 'PUT', path: '/issue/ABC-1', body: { a: 1 } }),
    );
    assert.equal(err.kind, 'ambiguous_write');
    assert.equal(mock.requests.length, 1);
  });
});

test('a GET that exhausts its retries fails as transport, not ambiguous_write', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 3; i += 1) mock.enqueue({ error: new TypeError('fetch failed') });
    const { request, clock } = harness({ retryAttempts: 2 });

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'transport');
    assert.equal(err.retryable, true);
    assert.equal(mock.requests.length, 3);
  });
});

test('retryAttempts: 0 sends exactly one request', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503 });
    const { request, clock } = harness({ retryAttempts: 0 });

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(mock.requests.length, 1);
    assert.equal(err.kind, 'transport');
    assert.equal(err.httpStatus, 503);
  });
});

test('three consecutive upstream failures emit upstream_degraded once', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 4; i += 1) mock.enqueue({ status: 503 });
    const { request, clock, logger } = harness({ retryAttempts: 3 });

    await rejects(clock, request(GET_ISSUE));

    const degraded = logger.eventsOf('upstream_degraded');
    assert.equal(degraded.length, 1);
    assert.equal(fieldsOf(degraded[0])['consecutiveFailures'], 3);
    assert.equal(fieldsOf(degraded[0])['host'], 'acme.atlassian.net');
  });
});

/* ------------------------------------------------------------------------- *
 * Timeout, abort and the call budget
 * ------------------------------------------------------------------------- */

/** Install a fetch that never settles; returns a restore function. */
function installHangingFetch(
  onCall?: (init: RequestInit | undefined) => void,
): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    onCall?.(init);
    return new Promise<Response>(() => {
      /* never settles: the client's own timeout must end this */
    });
  };
  return () => {
    globalThis.fetch = previous;
  };
}

test('a hung request times out on the injected clock, never on a real timer', async () => {
  const calls: RequestInit[] = [];
  const restore = installHangingFetch((init) => {
    if (init) calls.push(init);
  });
  try {
    const { request, clock } = harness({ requestTimeoutMs: 30_000, retryAttempts: 0 });

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /timed out after 30000 ms/);
    assert.equal(
      calls[0]?.signal?.aborted,
      true,
      'the fetch must be aborted, not abandoned',
    );
    assert.equal(clock.pendingSleeps(), 0, 'no timer may leak');
  } finally {
    restore();
  }
});

test('an unsafe write that times out is ambiguous and is never replayed', async () => {
  const restore = installHangingFetch();
  try {
    const { request, clock, logger } = harness({ requestTimeoutMs: 30_000 });

    const err = await rejects(
      clock,
      request({ method: 'POST', path: '/issue', body: { a: 1 } }),
    );

    assert.equal(err.kind, 'ambiguous_write');
    assert.match(err.message, /timed out after the request was sent/);
    assert.equal(logger.has('ambiguous_write'), true);
  } finally {
    restore();
  }
});

test('a timed-out GET is retried and can still succeed', async () => {
  const previous = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (): Promise<Response> => {
    call += 1;
    if (call === 1) {
      return new Promise<Response>(() => {
        /* first attempt hangs */
      });
    }
    return Promise.resolve(Response.json({ key: 'ABC-1' }));
  };
  try {
    const { request, clock } = harness({ requestTimeoutMs: 30_000 });
    const res = await settle(clock, request(GET_ISSUE));
    assert.equal(res.status, 200);
    assert.equal(call, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a caller abort is reported as a cancellation, not as a timeout', async () => {
  const restore = installHangingFetch();
  try {
    const controller = new AbortController();
    const { request, clock } = harness();
    const promise = request({ ...GET_ISSUE, signal: controller.signal });

    await tick();
    controller.abort();

    const err = await rejects(clock, promise);
    assert.equal(err.kind, 'transport');
    assert.equal(err.retryable, false);
    assert.match(err.message, /cancelled by the caller/);
  } finally {
    restore();
  }
});

test('an already-aborted caller signal prevents the request entirely', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness();
    const err = await rejects(
      clock,
      request({ ...GET_ISSUE, signal: AbortSignal.abort() }),
    );
    assert.equal(err.kind, 'transport');
    assert.equal(mock.requests.length, 0);
  });
});

test('the call budget aborts a retry loop with budget_exceeded', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 6; i += 1) mock.enqueue({ status: 503 });
    // Budget shorter than the second backoff, so the wait cannot be afforded.
    const { request, clock, logger } = harness({ callBudgetMs: 1_200, retryAttempts: 5 });

    const err = await rejects(clock, request(GET_ISSUE), 400);

    assert.equal(err.kind, 'budget_exceeded');
    assert.match(err.message, /call budget/);
    assert.equal(logger.has('budget_exceeded'), true);
    assert.equal(fieldsOf(logger.eventsOf('budget_exceeded')[0])['budgetMs'], 1_200);
    assert.ok(mock.requests.length < 6, 'the loop must stop before the retry count does');
  });
});

test('a caller-supplied deadlineAt is shared, so a second call inherits the budget', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.fallback({ json: { ok: true } });
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ ...GET_ISSUE, deadlineAt: clock.now() - 1 }),
    );
    assert.equal(err.kind, 'budget_exceeded');
    assert.equal(mock.requests.length, 0, 'an expired budget sends nothing');
  });
});

test('semaphore queueing counts against the budget', async () => {
  const restore = installHangingFetch();
  try {
    const { request, clock } = harness({ hostConcurrency: 1, callBudgetMs: 5_000 });

    // Occupy the single slot with a request that never completes.
    const blocking = request(GET_ISSUE);
    blocking.catch(() => {
      /* abandoned on purpose */
    });
    await tick();

    const queued = request(GET_ISSUE);
    await tick();
    const err = await rejects(clock, queued, 6_000);
    assert.equal(err.kind, 'budget_exceeded');
  } finally {
    restore();
  }
});

test('the per-host semaphore limits how many requests are in flight at once', async () => {
  const previous = globalThis.fetch;
  let inFlight = 0;
  let peak = 0;
  const gate: Array<() => void> = [];
  globalThis.fetch = (): Promise<Response> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<Response>((resolve) => {
      gate.push(() => {
        inFlight -= 1;
        resolve(Response.json({ ok: true }));
      });
    });
  };
  try {
    const { request, clock } = harness({ hostConcurrency: 2 });
    const all = Promise.all([request(GET_ISSUE), request(GET_ISSUE), request(GET_ISSUE)]);

    await tick();
    await tick();
    assert.equal(peak, 2, 'only two may be on the wire');
    assert.equal(gate.length, 2);

    while (gate.length > 0) {
      gate.shift()?.();
      await tick();
      await tick();
    }
    const results = await settle(clock, all);
    assert.equal(results.length, 3);
    assert.equal(peak, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

/* ------------------------------------------------------------------------- *
 * The body is part of the attempt
 *
 * Headers arriving is not the call finishing. Everything below drives a
 * response whose HEADERS land instantly and whose BODY never does — the case
 * that used to slip past the attempt timeout, the call budget and the host
 * slot all three, because each of them ended when `fetch` resolved.
 * ------------------------------------------------------------------------- */

/** A body whose stream is opened and then never yields a byte. */
function stallingBody(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {
        /* no chunk, ever: only an abort can end a read of this */
      });
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A body that stays open until the returned release function is called. */
function gatedBody(): { stream: ReadableStream<Uint8Array>; release: () => void } {
  let release = (): void => {
    /* replaced by `start` before any consumer can run */
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      release = () => {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      };
    },
  });
  return { stream, release };
}

test('a stalled body times out: the attempt timeout covers the read, not just the headers', async () => {
  const err = await withRawFetch(
    () => Promise.resolve(new Response(stallingBody(), { status: 200 })),
    async (calls) => {
      const { request, clock } = harness({ requestTimeoutMs: 30_000, retryAttempts: 0 });

      const failure = await rejects(clock, request(GET_ISSUE));

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.signal?.aborted, true, 'the fetch must be aborted');
      assert.equal(clock.pendingSleeps(), 0, 'no timer may leak');
      return failure;
    },
  );

  assert.equal(err.kind, 'timeout');
  assert.match(err.message, /timed out after 30000 ms/);
});

test('a stalled body is charged to the call budget, not just to the attempt', async () => {
  // The budget is far shorter than the per-request timeout, so the number in
  // the message says which of the two ended the read.
  const err = await withRawFetch(
    () => Promise.resolve(new Response(stallingBody(), { status: 200 })),
    async () => {
      const { request, clock } = harness({
        requestTimeoutMs: 30_000,
        callBudgetMs: 5_000,
        retryAttempts: 0,
      });
      return await rejects(clock, request(GET_ISSUE), 1_000);
    },
  );

  assert.equal(err.kind, 'timeout');
  assert.match(err.message, /timed out after 5000 ms/);
});

test('an unsafe write whose body stalls is ambiguous and is sent exactly once', async () => {
  const err = await withRawFetch(
    () => Promise.resolve(new Response(stallingBody(), { status: 200 })),
    async (calls) => {
      const { request, clock, logger } = harness({ requestTimeoutMs: 30_000 });

      const failure = await rejects(
        clock,
        request({ method: 'POST', path: '/issue', body: { summary: 'x' } }),
      );

      assert.equal(calls.length, 1, 'a write is never replayed on an unknown outcome');
      assert.equal(logger.has('ambiguous_write'), true);
      return failure;
    },
  );

  assert.equal(err.kind, 'ambiguous_write');
  assert.match(err.message, /timed out after the request was sent/);
});

test('the host slot is held until the body settles, not until the headers arrive', async () => {
  const gate = gatedBody();
  let call = 0;
  await withRawFetch(
    () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response(gate.stream, { status: 200 })
          : Response.json({ second: true }),
      );
    },
    async (calls) => {
      const { request } = harness({ hostConcurrency: 1 });

      const first = request<{ ok: boolean }>(GET_ISSUE);
      await tick();
      await tick();
      assert.equal(calls.length, 1, 'the first request is on the wire');

      const second = request<{ second: boolean }>(GET_ISSUE);
      await tick();
      await tick();
      await tick();
      assert.equal(
        calls.length,
        1,
        'the second request must wait: the first still owns the slot while its body streams',
      );

      gate.release();
      // No clock advance: nothing here is waiting on time, so the guard timers
      // stay armed and cannot end the wait for us.
      const [a, b] = await Promise.all([first, second]);
      assert.equal(calls.length, 2);
      assert.deepEqual(a.data, { ok: true });
      assert.deepEqual(b.data, { second: true });
    },
  );
});

test('a body that fails mid-read is a transport failure, not an empty success', async () => {
  const err = await withRawFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('connection reset while reading the body'));
            },
          }),
          { status: 200 },
        ),
      ),
    async () => {
      const { request, clock } = harness({ retryAttempts: 0 });
      return await rejects(clock, request(GET_ISSUE));
    },
  );

  // Before the body was part of the attempt this resolved `ok` with no data.
  assert.equal(err.kind, 'transport');
  assert.match(err.message, /Could not reach Jira/);
});

/* ------------------------------------------------------------------------- *
 * Status mapping (CC-15/CC-16/CC-18)
 * ------------------------------------------------------------------------- */

test('a 400 carries Jira errorMessages and flattened field errors', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        errorMessages: ['Field is required.'],
        errors: { summary: 'Summary is required.' },
      },
    });
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ method: 'POST', path: '/issue', body: {} }),
    );

    assert.equal(err.kind, 'validation');
    assert.equal(err.httpStatus, 400);
    assert.deepEqual(err.jiraMessages, [
      'Field is required.',
      'summary: Summary is required.',
    ]);
    assert.equal(err.retryable, false);
  });
});

test('401 maps to auth and emits auth_failure', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 401, json: { message: 'Client must be authenticated' } });
    const { request, clock, logger } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'auth');
    assert.match(err.remediation ?? '', /JIRA_API_TOKEN/);
    assert.equal(logger.has('auth_failure'), true);
  });
});

test('403 is a permission error unless a login-denied header says otherwise (CC-18)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 403, json: { errorMessages: ['No permission'] } });
    const { request, clock } = harness();
    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'permission');
  });

  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 403,
      headers: { 'x-seraph-loginreason': 'AUTHENTICATION_DENIED' },
    });
    const { request, clock, logger } = harness();
    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'auth');
    assert.equal(logger.has('auth_failure'), true);
  });

  // A successful Seraph pass-through on a plain permission 403 must NOT flip
  // the kind to auth — the header is present but its value clears the account.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 403,
      headers: { 'x-seraph-loginreason': 'OK' },
      json: { errorMessages: ['No permission'] },
    });
    const { request, clock, logger } = harness();
    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'permission');
    assert.equal(logger.has('auth_failure'), false);
  });
});

test('404 keeps its "may not exist, may be invisible" remediation (CC-16)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 404, json: { errorMessages: ['Issue does not exist'] } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'not_found');
    assert.match(err.remediation ?? '', /Browse Projects/);
  });
});

test('410 on the removed legacy search endpoint maps to unsupported', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 410, text: 'Gone' });
    const { request, clock } = harness();

    const err = await rejects(clock, request({ method: 'GET', path: '/search' }));
    assert.equal(err.kind, 'unsupported');
    assert.match(err.remediation ?? '', /search\/jql/);
  });
});

test('a non-JSON error body survives as a bounded detail snippet (CC-15)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, text: `<html>${'x'.repeat(500)}</html>` });
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ method: 'POST', path: '/issue', body: {} }),
    );
    assert.equal(err.kind, 'validation');
    assert.ok(err.detail !== undefined);
    assert.equal(err.detail?.length, 200);
  });
});

test('a 200 with a non-JSON body is unexpected_shape, not a crash', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, text: '<html>login page</html>' });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));
    assert.equal(err.kind, 'unexpected_shape');
    assert.match(err.detail ?? '', /login page/);
  });
});

test('a 200 with an empty body yields undefined data', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, text: '' });
    const { request, clock } = harness();

    const res = await settle(clock, request(GET_ISSUE));
    assert.equal(res.data, undefined);
  });
});

/* ------------------------------------------------------------------------- *
 * Logging and redaction
 * ------------------------------------------------------------------------- */

test('http_request/http_response log the path template, never the URL or query', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { ok: true } });
    const { request, clock, logger } = harness();

    await settle(
      clock,
      request({
        method: 'GET',
        path: '/issue/ABC-1',
        pathTemplate: '/issue/{issueIdOrKey}',
        query: { jql: 'project = SECRET' },
      }),
    );

    const req = fieldsOf(logger.eventsOf('http_request')[0]);
    assert.equal(req['pathTemplate'], '/rest/api/3/issue/{issueIdOrKey}');
    const res = fieldsOf(logger.eventsOf('http_response')[0]);
    assert.equal(res['status'], 200);
    assert.equal(res['attempt'], 1);
    assert.equal(typeof res['durationMs'], 'number');

    const serialized = JSON.stringify(logger.events);
    assert.equal(serialized.includes('SECRET'), false, 'query values are never logged');
    assert.equal(serialized.includes('ABC-1'), false, 'concrete ids are never logged');
    assert.equal(serialized.includes(TOKEN), false);
  });
});

test('the injected redactor scrubs the token out of error text', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, text: `token ${TOKEN} rejected` });
    const redactor = createFakeRedactor([TOKEN]);
    const { request, clock } = harness({ redactor });

    const err = await rejects(
      clock,
      request({ method: 'POST', path: '/issue', body: {} }),
    );

    assert.equal(err.detail?.includes(TOKEN), false);
    assert.match(err.detail ?? '', /\[REDACTED\]/);
  });
});

/* ------------------------------------------------------------------------- *
 * Wiring seams
 * ------------------------------------------------------------------------- */

test('fetch is read off globalThis at call time, not captured at module load', async () => {
  const { request, clock } = harness();
  // The client was created while the network fence was installed; swapping the
  // global afterwards must still be seen by this same instance.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { ok: true } });
    const res = await settle(clock, request(GET_ISSUE));
    assert.equal(res.status, 200);
  });
});

test('credentials are resolved per call, so a profile switch changes the host', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.fallback({ json: { ok: true } });
    const { request, clock } = harness({
      credentials: (profile?: string) =>
        profile === 'other'
          ? {
              host: { origin: 'https://other.atlassian.net', pathPrefix: '' },
              email: 'b@x.io',
              apiToken: 'b',
            }
          : CREDENTIALS,
    });

    await settle(clock, request(GET_ISSUE));
    await settle(clock, request({ ...GET_ISSUE, profile: 'other' }));

    assert.equal(mock.requests[0]?.url.startsWith('https://acme.atlassian.net/'), true);
    assert.equal(mock.requests[1]?.url.startsWith('https://other.atlassian.net/'), true);
    assert.notEqual(
      mock.requests[0]?.headers['authorization'],
      mock.requests[1]?.headers['authorization'],
    );
  });
});

test('a per-request timeoutMs overrides the client default', async () => {
  const restore = installHangingFetch();
  try {
    const { request, clock } = harness({ requestTimeoutMs: 30_000, retryAttempts: 0 });
    const err = await rejects(clock, request({ ...GET_ISSUE, timeoutMs: 5_000 }), 5_000);
    assert.match(err.message, /timed out after 5000 ms/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------------- *
 * Counters (D12, OBSERVABILITY.md §Counters)
 * ------------------------------------------------------------------------- */

test('a logical request counts once, whatever it costs in attempts', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 503 })
      .enqueue({ status: 503 })
      .enqueue({ json: { key: 'ABC-1' } });
    const telemetry = createTelemetry();
    const { request, clock } = harness({ telemetry });

    await settle(clock, request(GET_ISSUE));

    assert.equal(mock.requests.length, 3);
    assert.deepEqual(telemetry.snapshot(), {
      requests: 1,
      retries: 2,
      rateLimitWaits: 0,
      errors: {},
    });
  });
});

test('a 429 wait counts as both a retry and a rate-limit wait', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 429, headers: { 'retry-after': '2' } })
      .enqueue({ status: 503 })
      .enqueue({ json: { ok: true } });
    const telemetry = createTelemetry();
    const { request, clock } = harness({ telemetry });

    await settle(clock, request(GET_ISSUE));

    const counters = telemetry.snapshot();
    assert.equal(counters.retries, 2);
    assert.equal(counters.rateLimitWaits, 1);
  });
});

test('a failure is counted under its error kind', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 404, json: { errorMessages: ['Issue does not exist'] } });
    const telemetry = createTelemetry();
    const { request, clock } = harness({ telemetry });

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'not_found');
    assert.deepEqual(telemetry.snapshot(), {
      requests: 1,
      retries: 0,
      rateLimitWaits: 0,
      errors: { not_found: 1 },
    });
  });
});

test('a refusal raised before the wire is still counted', async () => {
  await withFetch(async (mock: FetchMock) => {
    const telemetry = createTelemetry();
    const { request, clock } = harness({
      telemetry,
      credentials: {
        ...CREDENTIALS,
        host: { origin: 'https://evil-atlassian.net', pathPrefix: '' },
      },
    });

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'config');
    assert.equal(mock.requests.length, 0);
    // Nothing was sent, so `requests` stays 0 — but the operator still needs to
    // see that this server is failing, and why.
    assert.deepEqual(telemetry.snapshot(), {
      requests: 0,
      retries: 0,
      rateLimitWaits: 0,
      errors: { config: 1 },
    });
  });
});

test('counters accumulate across calls and instances stay independent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.fallback({ json: { ok: true } });
    const telemetry = createTelemetry();
    const other = createTelemetry();
    const { request, clock } = harness({ telemetry });

    await settle(clock, request(GET_ISSUE));
    await settle(clock, request(GET_ISSUE));

    assert.equal(telemetry.snapshot().requests, 2);
    assert.equal(other.snapshot().requests, 0);
  });
});

/* ------------------------------------------------------------------------- *
 * Attachments: binary responses and multipart uploads (WP-70)
 * ------------------------------------------------------------------------- */

const GET_CONTENT: JiraRequestSpec = {
  method: 'GET',
  path: '/attachment/content/10000',
  pathTemplate: '/attachment/content/{id}',
  accept: 'binary',
};

/**
 * A raw `fetch` swap for the two cases the recording mock cannot express: an
 * `init.body` that is a `FormData` (the mock stringifies it to a marker) and a
 * response whose body is a live stream (the cap must trip mid-transfer).
 */
async function withRawFetch<T>(
  impl: (input: Parameters<typeof fetch>[0], init: RequestInit) => Promise<Response>,
  fn: (calls: RequestInit[]) => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push(init ?? {});
    return impl(input, init ?? {});
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

test('accept: binary returns the bytes untouched and asks for anything', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    const { request, clock } = harness();

    const res = await settle(clock, request<Uint8Array>(GET_CONTENT));

    assert.ok(res.data instanceof Uint8Array, 'a binary read must not be parsed');
    assert.deepEqual([...res.data], [0x25, 0x50, 0x44, 0x46]);
    assert.equal(mock.lastRequest()?.headers['accept'], '*/*');
  });
});

test('CC-53: a binary GET follows the media 303 exactly once, and anonymously', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({
        status: 303,
        headers: { location: 'https://media.atlassian.com/file/abc?token=signed' },
      })
      .enqueue({ bytes: new Uint8Array([1, 2, 3]) });
    const { request, clock, logger } = harness();

    const res = await settle(clock, request<Uint8Array>(GET_CONTENT));

    assert.deepEqual([...res.data], [1, 2, 3]);
    assert.equal(mock.requests.length, 2);
    assert.equal(
      mock.requests[1]?.url,
      'https://media.atlassian.com/file/abc?token=signed',
    );
    // The whole point of the hand-built hop: undici would strip this crossing
    // origins anyway, and a media host must never be handed the site token.
    assert.equal(mock.requests[1]?.headers['authorization'], undefined);
    assert.equal(mock.requests[0]?.headers['authorization'] !== undefined, true);
    // Both hops are visible in the log, and neither event carries the URL.
    const responses = logger.eventsOf('http_response');
    assert.deepEqual(
      responses.map((e) => fieldsOf(e)['status']),
      [303, 200],
    );
    assert.equal(
      fieldsOf(responses[0])['pathTemplate'],
      '/rest/api/3/attachment/content/{id}',
    );
  });
});

test('the media hop refuses a non-https location and sends nothing to it', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 303, headers: { location: 'http://media.example.com/f' } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_CONTENT));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /non-https/);
    assert.equal(mock.requests.length, 1);
  });
});

test('the media hop refuses a link-local target (the SSRF blocklist still applies)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 303,
      headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_CONTENT));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /never contacted/);
    assert.equal(mock.requests.length, 1);
  });
});

test('a 303 with no Location is a refusal, not a second blind request', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 303 });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_CONTENT));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /no Location header/);
    assert.equal(mock.requests.length, 1);
  });
});

test('the hop is taken once: a redirect from the media host is refused', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ status: 303, headers: { location: 'https://media.atlassian.com/a' } })
      .enqueue({ status: 303, headers: { location: 'https://media.atlassian.com/b' } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_CONTENT));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /never followed/);
    assert.equal(mock.requests.length, 2);
  });
});

test('a JSON GET still refuses the same 303 — only a binary read may hop', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 303,
      headers: { location: 'https://media.atlassian.com/file/abc' },
    });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'config');
    assert.equal(mock.requests.length, 1);
  });
});

test('CC-93: a media 303 to a Location that is not a URL is refused, not guessed', async () => {
  await withFetch(async (mock: FetchMock) => {
    // A proxy that rewrites the signed media URL can emit something no parser
    // accepts; the hop must end here rather than fall back to the site origin,
    // which is where the Authorization header lives.
    mock.enqueue({ status: 303, headers: { location: 'http://[' } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_CONTENT));

    assert.equal(err.kind, 'config');
    assert.equal(err.retryable, false);
    assert.match(err.message, /unparseable location/);
    assert.equal(mock.requests.length, 1, 'nothing is sent to a location we cannot read');
  });
});

test('a 3xx with no Location at all is refused as a same-host redirect', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 302 });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'config');
    assert.equal(err.httpStatus, 302);
    assert.match(err.message, /302 redirect; redirects are never followed/);
    assert.equal(mock.requests.length, 1);
  });
});

test('a 3xx whose Location is unparseable is refused without naming a host', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 302, headers: { location: 'http://[' } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /302 redirect; redirects are never followed/);
    assert.doesNotMatch(
      err.message,
      /redirect to "/,
      'a host that could not be parsed must not be quoted back at the operator',
    );
  });
});

test('CC-91: a binary GET answered 204 yields zero bytes, not a stream error', async () => {
  await withFetch(async (mock: FetchMock) => {
    // A 204 carries no body stream at all (`Response.body` is null), which is
    // the one shape the byte-metering reader cannot meter.
    mock.enqueue({ status: 204 });
    const { request, clock } = harness();

    const res = await settle(clock, request<Uint8Array>(GET_CONTENT));

    assert.equal(res.status, 204);
    assert.ok(res.data instanceof Uint8Array, 'a binary read always answers in bytes');
    assert.equal(res.data.byteLength, 0);
  });
});

test('CC-54: a download over the cap is aborted mid-stream, not buffered and rejected', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  // Ten chunks more than the cap allows: the source is still open when the
  // limit trips, so a reader that did NOT stop would go on pulling.
  const chunks = Math.ceil(MAX_ATTACHMENT_BYTES / chunk.byteLength) + 10;
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });

  const err = await withRawFetch(
    () => Promise.resolve(new Response(stream, { status: 200 })),
    async () => {
      const { request, clock } = harness();
      return await rejects(clock, request(GET_CONTENT));
    },
  );

  assert.equal(err.kind, 'validation');
  assert.match(err.message, /attachment limit/);
  assert.equal(cancelled, true, 'the transfer must be cancelled, not drained');
  // The source can still hand out a chunk or two while the cancellation
  // propagates; what matters is that it never reached its end.
  assert.ok(sent < chunks, 'the reader must stop near the cap, not drain the body');
});

test('a download that stalls mid-transfer times out and the stream is cancelled', async () => {
  let cancelled = false;
  const err = await withRawFetch(
    () =>
      Promise.resolve(
        new Response(
          stallingBody(() => {
            cancelled = true;
          }),
          { status: 200 },
        ),
      ),
    async () => {
      const { request, clock } = harness({ requestTimeoutMs: 30_000, retryAttempts: 0 });
      return await rejects(clock, request(GET_CONTENT));
    },
  );

  assert.equal(err.kind, 'timeout');
  assert.match(err.message, /timed out after 30000 ms/);
  assert.equal(cancelled, true, 'a transfer we stop waiting for must not be left open');
});

test('multipart sends FormData with the XSRF opt-out and no hand-made content-type', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  await withRawFetch(
    () => Promise.resolve(new Response('[]', { status: 200 })),
    async (calls) => {
      const { request, clock } = harness();

      await settle(
        clock,
        request({
          method: 'POST',
          path: '/issue/ABC-1/attachments',
          pathTemplate: '/issue/{issueIdOrKey}/attachments',
          multipart: [
            {
              field: 'file',
              filename: 'notes.txt',
              contentType: 'text/plain',
              bytes,
            },
          ],
        }),
      );

      const init = calls[0];
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['x-atlassian-token'], 'no-check');
      // Only `fetch` knows the boundary it generated; a hand-set content-type
      // would produce a body Jira cannot parse.
      assert.equal(headers?.['content-type'], undefined);
      assert.ok(init?.body instanceof FormData, 'the body must be a FormData');
      const part = init.body.get('file');
      assert.ok(part instanceof Blob, 'the file part must be a Blob');
      assert.equal((part as File).name, 'notes.txt');
      assert.equal(part.type, 'text/plain');
      assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [9, 8, 7]);
    },
  );
});

test('multipart is refused on a non-POST, alongside a body, and when empty', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness();
    const part = { field: 'file', filename: 'a.txt', bytes: new Uint8Array([1]) };

    const onGet = await rejects(
      clock,
      request({ method: 'GET', path: '/issue/ABC-1/attachments', multipart: [part] }),
    );
    const withBody = await rejects(
      clock,
      request({
        method: 'POST',
        path: '/issue/ABC-1/attachments',
        body: { a: 1 },
        multipart: [part],
      }),
    );
    const empty = await rejects(
      clock,
      request({ method: 'POST', path: '/issue/ABC-1/attachments', multipart: [] }),
    );

    assert.equal(onGet.kind, 'config');
    assert.equal(withBody.kind, 'config');
    assert.equal(empty.kind, 'config');
    assert.equal(mock.requests.length, 0, 'a caller bug never reaches the wire');
  });
});

test('an upload over the cap is refused before a single byte is copied', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({
        method: 'POST',
        path: '/issue/ABC-1/attachments',
        multipart: [
          {
            field: 'file',
            filename: 'huge.bin',
            bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
          },
        ],
      }),
    );

    assert.equal(err.kind, 'validation');
    assert.match(err.message, /upload/);
    assert.equal(mock.requests.length, 0);
  });
});

test('CC-59: a multipart upload that times out is ambiguous and is NEVER replayed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      error: Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
    });
    const { request, clock, logger } = harness();

    const err = await rejects(
      clock,
      request({
        method: 'POST',
        path: '/issue/ABC-1/attachments',
        multipart: [{ field: 'file', filename: 'a.txt', bytes: new Uint8Array([1]) }],
      }),
    );

    assert.equal(err.kind, 'ambiguous_write');
    assert.equal(mock.requests.length, 1, 'an upload is sent at most once');
    assert.equal(logger.eventsOf('ambiguous_write').length, 1);
  });
});

/* ------------------------------------------------------------------------- *
 * Status mapping, degenerate bodies and the counter boundary
 * ------------------------------------------------------------------------- */

test('a 409 is a validation error that tells the caller to re-read first', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 409, json: { errorMessages: ['Version mismatch'] } });
    const { request, clock } = harness();

    const err = await rejects(
      clock,
      request({ method: 'PUT', path: '/issue/ABC-1', body: { fields: {} } }),
    );

    assert.equal(err.kind, 'validation');
    assert.equal(err.httpStatus, 409);
    assert.deepEqual(err.jiraMessages, ['Version mismatch']);
    assert.match(err.remediation ?? '', /changed underneath this call/);
    assert.equal(mock.requests.length, 1, 'a conflict is not a retryable condition');
  });
});

test('413 and 414 both come back as "the request was too large"', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 413 }).enqueue({ status: 414 });
    const { request, clock } = harness();

    const tooBigBody = await rejects(
      clock,
      request({ method: 'POST', path: '/search/jql', body: { jql: 'x' } }),
    );
    const tooLongUrl = await rejects(clock, request(GET_ISSUE));

    assert.equal(tooBigBody.kind, 'validation');
    assert.equal(tooBigBody.httpStatus, 413);
    assert.match(tooBigBody.remediation ?? '', /too large/);
    // 414 is not in the status table at all, so it also proves the >= 400
    // fallback keeps a sane kind.
    assert.equal(tooLongUrl.kind, 'validation');
    assert.match(tooLongUrl.remediation ?? '', /smaller page size/);
  });
});

test("a status with no bespoke text falls back to the kind's remediation", async () => {
  await withFetch(async (mock: FetchMock) => {
    // 422 maps to `validation` and has nothing status-specific to say, which is
    // the arm that hands the caller the shared table entry instead.
    mock.enqueue({ status: 422, json: { errorMessages: ['Field is required'] } });
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'validation');
    assert.equal(err.httpStatus, 422);
    assert.equal(err.remediation, REMEDIATION.validation);
  });
});

test('a fetch that rejects with something other than an Error still fails as transport', async () => {
  // Not undici's doing — a proxy agent or an injected fetch can reject with a
  // bare value, and the classifier must not assume `error.name` exists.
  const notAnError: unknown = 'connection refused';
  const err = await withRawFetch(
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is the entire subject of this test.
    () => Promise.reject(notAnError),
    async () => {
      const { request, clock } = harness({ retryAttempts: 0 });
      return await rejects(clock, request(GET_ISSUE));
    },
  );

  assert.equal(err.kind, 'transport');
  assert.match(err.message, /Could not reach Jira/);
  assert.equal(err.cause, notAnError, 'the rejected value is kept as the cause');
});

/** A body that dies mid-read: the headers arrived, the bytes never will. */
function failingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset while reading the body'));
    },
  });
}

test('CC-92: an error body that cannot be read costs the snippet, not the verdict', async () => {
  const err = await withRawFetch(
    () => Promise.resolve(new Response(failingBody(), { status: 503 })),
    async () => {
      const { request, clock } = harness({ retryAttempts: 0 });
      return await rejects(clock, request(GET_ISSUE));
    },
  );

  // The status had already decided the outcome; a body that never arrived only
  // costs the messages, and must not turn into a different failure.
  assert.equal(err.kind, 'transport');
  assert.equal(err.httpStatus, 503);
  assert.deepEqual(err.jiraMessages, [], 'no messages survived the unreadable body');
  assert.match(err.message, /Jira rejected GET .* with HTTP 503\./);
});

test('a runtime without a global fetch fails as config, before anything is sent', async () => {
  const previous = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    const { request, clock } = harness();

    const err = await rejects(clock, request(GET_ISSUE));

    assert.equal(err.kind, 'config');
    assert.match(err.message, /no global fetch/);
    assert.match(err.remediation ?? '', /Node 22/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('CC-94: aborting an unsafe write warns that the change may already have landed', async () => {
  const restore = installHangingFetch();
  try {
    const controller = new AbortController();
    const { request, clock } = harness();
    const promise = request({
      method: 'POST',
      path: '/issue',
      body: { fields: { summary: 'x' } },
      signal: controller.signal,
    });

    await tick();
    controller.abort();

    const err = await rejects(clock, promise);
    assert.equal(err.kind, 'transport');
    assert.equal(err.retryable, false);
    assert.match(err.message, /cancelled by the caller/);
    // The cancellation says nothing about what Jira did with the bytes already
    // on the wire — the caller must verify, not re-send.
    assert.match(err.remediation ?? '', /may or may not have been applied/);
    assert.doesNotMatch(err.remediation ?? '', /Call again/);
  } finally {
    restore();
  }
});

test('a transport failure is retried the same way without a telemetry set', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ error: Object.assign(new Error('socket hang up'), { name: 'Error' }) })
      .enqueue({ json: { key: 'ABC-1' } });
    // No `telemetry` — counting is optional (D12) and the retry must not depend
    // on someone being there to count it.
    const { request, clock, logger } = harness();

    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
    assert.equal(fieldsOf(logger.eventsOf('http_retry')[0])['reason'], 'transport');
  });
});

test('a retry after a transport failure is counted, like every other retry', async () => {
  // The counterpart of the test above: the same socket failure, this time with
  // someone counting. A retry costs the caller a request either way, and the
  // three retry paths — 429, 5xx, transport — must all be visible in the same
  // number, or the metric answers "how often do we retry?" with a figure that
  // silently omits the network dropping out from under us.
  await withFetch(async (mock: FetchMock) => {
    mock
      .enqueue({ error: Object.assign(new Error('socket hang up'), { name: 'Error' }) })
      .enqueue({ json: { key: 'ABC-1' } });
    const telemetry = createTelemetry();
    const { request, clock } = harness({ telemetry });

    const res = await settle(clock, request(GET_ISSUE));

    assert.equal(res.status, 200);
    assert.deepEqual(telemetry.snapshot(), {
      requests: 1,
      retries: 1,
      // A dead socket is not a rate limit — it must not inflate the wait count.
      rateLimitWaits: 0,
      errors: {},
    });
  });
});

test('a failure that is not a JiraError is still counted, under "unknown"', async () => {
  await withFetch(async (mock: FetchMock) => {
    const telemetry = createTelemetry();
    const { request, clock } = harness({
      telemetry,
      credentials: () => {
        throw new Error('the credential store is unreachable');
      },
    });

    await assert.rejects(
      () => settle(clock, request(GET_ISSUE)),
      /credential store is unreachable/,
    );

    assert.deepEqual(telemetry.snapshot(), {
      requests: 0,
      retries: 0,
      rateLimitWaits: 0,
      errors: { [UNKNOWN_ERROR_KIND]: 1 },
    });
    assert.equal(mock.requests.length, 0);
  });
});
