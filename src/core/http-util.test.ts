// Unit tests for the pure half of the HTTP client: host policy, URL building,
// retry arithmetic and the per-host semaphore. Nothing here touches the
// network — `core/http.test.ts` owns the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JiraError } from './types.js';
import type { HostRef, Rng } from './types.js';
import {
  BACKOFF_CAP_MS,
  MAX_RETRY_AFTER_MS,
  RETRY_AFTER_JITTER,
  assertApiPath,
  assertHostAllowed,
  backoffMs,
  buildQueryString,
  buildRequestUrl,
  capRetryAfterMs,
  checkHost,
  createSemaphorePool,
  encodeSegment,
  hostFromOrigin,
  isAllowedHost,
  isBlockedHost,
  isRedirectStatus,
  isReplayable,
  jitterMs,
  normalizeHost,
  parseRetryAfterMs,
  shouldRetryStatus,
} from './http-util.js';

/** Rng that walks a fixed script, so every jitter assertion is exact. */
function scriptedRng(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const value = values[i % values.length] ?? 0;
    i += 1;
    return value;
  };
}

const zeroRng: Rng = () => 0;
const maxRng: Rng = () => 0.999999;

const SITE: HostRef = { origin: 'https://acme.atlassian.net', pathPrefix: '' };

/** The JiraError a call is expected to throw, or a failure if it didn't. */
function catchJiraError(fn: () => unknown): JiraError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to throw');
}

/* ------------------------------------------------------------------------- *
 * Host policy
 * ------------------------------------------------------------------------- */

test('normalizeHost lowercases and strips a trailing dot and IPv6 brackets', () => {
  assert.equal(normalizeHost('ACME.Atlassian.NET'), 'acme.atlassian.net');
  assert.equal(normalizeHost('acme.atlassian.net.'), 'acme.atlassian.net');
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('  acme.atlassian.net  '), 'acme.atlassian.net');
});

test('host matching is exact, not a suffix match (evil-atlassian.net is rejected)', () => {
  // The donor used `host.endsWith('.atlassian.net')`, which accepts anything
  // that merely ends with the string. These four are the bypasses that buys.
  assert.equal(checkHost('acme.atlassian.net'), 'canonical');
  assert.equal(checkHost('evil-atlassian.net'), 'not_allowed');
  assert.equal(checkHost('atlassian.net.evil.com'), 'not_allowed');
  assert.equal(checkHost('acme.atlassian.net.evil.com'), 'not_allowed');
  assert.equal(checkHost('notatlassian.net'), 'not_allowed');
  assert.equal(isAllowedHost('evil-atlassian.net'), false);
});

test('an allowlist entry matches exactly, and a trailing-dot variant still matches', () => {
  assert.equal(checkHost('jira.example.com', ['jira.example.com']), 'allowlisted');
  assert.equal(checkHost('jira.example.com.', ['jira.example.com']), 'allowlisted');
  assert.equal(checkHost('jira.example.com', ['JIRA.EXAMPLE.COM']), 'allowlisted');
  assert.equal(checkHost('evil.jira.example.com', ['jira.example.com']), 'not_allowed');
});

test('an allowlist regex must be anchored, and matches only the whole host', () => {
  assert.equal(
    checkHost('jira.example.com', ['/^jira\\.example\\.com$/']),
    'allowlisted',
  );
  assert.equal(
    checkHost('evil-jira.example.com', ['/^jira\\.example\\.com$/']),
    'not_allowed',
  );
  assert.equal(
    checkHost('jira.example.com', ['/^[a-z]+\\.example\\.com$/']),
    'allowlisted',
  );

  const err = catchJiraError(() =>
    checkHost('jira.example.com', ['/jira\\.example\\.com/']),
  );
  assert.equal(err.kind, 'config');
  assert.match(err.message, /not anchored/);
});

test('an unparseable allowlist regex is a config error, not a silent deny', () => {
  const err = catchJiraError(() =>
    checkHost('jira.example.com', ['/^jira(\\.example$/']),
  );
  assert.equal(err.kind, 'config');
  assert.match(err.message, /not a valid regular expression/);
});

test('the blocklist wins even when an allowlist entry matches it', () => {
  // The donor checked the allowlist first, so `JIRA_ALLOWED_HOSTS=127.0.0.1`
  // turned the server into an SSRF gadget. Order is the security property.
  for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '10.0.0.5']) {
    assert.equal(checkHost(host, [host, '/^.*$/']), 'blocked', host);
    assert.equal(isAllowedHost(host, [host]), false, host);
  }
});

test('isBlockedHost covers loopback, private, link-local, CGNAT and metadata', () => {
  for (const host of [
    'localhost',
    'foo.localhost',
    'db.internal',
    'printer.local',
    'x.home.arpa',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '999.1.1.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fec0::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isBlockedHost(host), true, `${host} must be blocked`);
  }
  for (const host of [
    'acme.atlassian.net',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '2001:db8::1',
  ]) {
    assert.equal(isBlockedHost(host), false, `${host} must not be blocked`);
  }
});

test('assertHostAllowed distinguishes blocked from not-allowed and names the context', () => {
  assert.equal(assertHostAllowed('acme.atlassian.net'), undefined);

  const blocked = catchJiraError(() => {
    assertHostAllowed('169.254.169.254', ['169.254.169.254'], 'redirect target');
  });
  assert.equal(blocked.kind, 'config');
  assert.match(blocked.message, /redirect target/);
  assert.match(blocked.message, /never contacted/);

  const denied = catchJiraError(() => {
    assertHostAllowed('evil.example.com', [], 'redirect target');
  });
  assert.equal(denied.kind, 'config');
  assert.match(denied.message, /not in the allowed-host list/);
});

test('hostFromOrigin rejects http, embedded credentials and garbage', () => {
  assert.equal(hostFromOrigin('https://ACME.atlassian.net'), 'acme.atlassian.net');

  assert.match(
    catchJiraError(() => hostFromOrigin('http://acme.atlassian.net')).message,
    /not https/,
  );
  assert.match(
    catchJiraError(() => hostFromOrigin('https://user:pw@acme.atlassian.net')).message,
    /must not embed credentials/,
  );
  assert.equal(catchJiraError(() => hostFromOrigin('acme.atlassian.net')).kind, 'config');
});

/* ------------------------------------------------------------------------- *
 * URL building
 * ------------------------------------------------------------------------- */

test('encodeSegment percent-encodes one segment and rejects traversal before the wire', () => {
  assert.equal(encodeSegment('ABC-1'), 'ABC-1');
  assert.equal(encodeSegment('a b'.replace(' ', '+')), 'a%2Bb');
  assert.equal(encodeSegment('5b10a2:844c'), '5b10a2%3A844c');

  for (const bad of [
    '..',
    '.',
    '../..',
    'a/b',
    'a\\b',
    'a?b',
    'a#b',
    '%2e%2e',
    'a b',
    '',
    ' x',
  ]) {
    const err = catchJiraError(() => encodeSegment(bad, 'issue key'));
    assert.equal(err.kind, 'validation', bad);
    assert.match(err.message, /issue key/, bad);
  }
});

test('encodeSegment rejects CR/LF (header injection), never encodes it away', () => {
  const err = catchJiraError(() => encodeSegment('ABC-1\r\nX-Evil: 1'));
  assert.equal(err.kind, 'validation');
});

test('assertApiPath rejects absolute URLs, query strings and dot segments', () => {
  assert.equal(assertApiPath('/issue/ABC-1'), undefined);
  assert.equal(assertApiPath('/search/jql'), undefined);

  for (const bad of [
    'issue/ABC-1',
    '//evil.com/x',
    'https://evil.com/x',
    '/issue?expand=all',
    '/issue#frag',
    '/issue/../../admin',
    '/../admin',
    '/issue/%2e%2e/admin',
    '/issue/ ABC',
  ]) {
    assert.equal(catchJiraError(() => assertApiPath(bad)).kind, 'validation', bad);
  }
});

test('buildRequestUrl composes origin + prefix + root + path + query', () => {
  assert.equal(
    buildRequestUrl(SITE, 'v3', '/issue/ABC-1'),
    'https://acme.atlassian.net/rest/api/3/issue/ABC-1',
  );
  assert.equal(
    buildRequestUrl(SITE, 'agile', '/board/1/sprint'),
    'https://acme.atlassian.net/rest/agile/1.0/board/1/sprint',
  );
  assert.equal(
    buildRequestUrl(
      { origin: 'https://api.atlassian.com', pathPrefix: '/ex/jira/cid' },
      'v3',
      '/myself',
    ),
    'https://api.atlassian.com/ex/jira/cid/rest/api/3/myself',
  );
});

test('buildRequestUrl cannot be walked off the configured host', () => {
  assert.equal(
    catchJiraError(() => buildRequestUrl(SITE, 'v3', '/../../../evil')).kind,
    'validation',
  );
  assert.equal(
    catchJiraError(() => buildRequestUrl(SITE, 'v3', '//evil.example.com/rest')).kind,
    'validation',
  );
  assert.equal(
    catchJiraError(() =>
      buildRequestUrl(
        { origin: 'https://acme.atlassian.net/x', pathPrefix: '' },
        'v3',
        '/myself',
      ),
    ).kind,
    'config',
  );
  assert.equal(
    catchJiraError(() =>
      buildRequestUrl(
        { origin: 'https://acme.atlassian.net', pathPrefix: '/ex/' },
        'v3',
        '/myself',
      ),
    ).kind,
    'config',
  );
});

test('buildQueryString encodes values and drops undefined', () => {
  assert.equal(buildQueryString(), '');
  assert.equal(buildQueryString({ a: undefined }), '');
  assert.equal(buildQueryString({ jql: 'project = "A B"' }), 'jql=project+%3D+%22A+B%22');
  assert.equal(
    buildQueryString({ maxResults: 50, expand: true }),
    'maxResults=50&expand=true',
  );
  assert.equal(
    buildRequestUrl(SITE, 'v3', '/search/jql', { maxResults: 50, startAt: undefined }),
    'https://acme.atlassian.net/rest/api/3/search/jql?maxResults=50',
  );
});

/* ------------------------------------------------------------------------- *
 * Retry arithmetic
 * ------------------------------------------------------------------------- */

test('replayability: GET always, other methods only with an explicit safe flag', () => {
  assert.equal(isReplayable('GET'), true);
  assert.equal(isReplayable('POST'), false);
  assert.equal(isReplayable('PUT'), false);
  assert.equal(isReplayable('DELETE'), false);
  assert.equal(isReplayable('POST', true), true); // /search/jql
  assert.equal(isReplayable('PUT', true), true); // caller's explicit promise
});

test('429 is retryable for every method; 5xx only for replayable requests', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    assert.equal(shouldRetryStatus(429, method), true, method);
  }
  assert.equal(shouldRetryStatus(503, 'GET'), true);
  assert.equal(shouldRetryStatus(502, 'POST'), false);
  assert.equal(shouldRetryStatus(504, 'POST'), false);
  assert.equal(shouldRetryStatus(503, 'POST', true), true);
  assert.equal(shouldRetryStatus(500, 'GET'), false); // 500 is not transient
  assert.equal(shouldRetryStatus(400, 'GET'), false);
  assert.equal(shouldRetryStatus(404, 'GET'), false);
});

test('isRedirectStatus covers every 3xx that carries a Location', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(isRedirectStatus(status), true, String(status));
  }
  assert.equal(isRedirectStatus(304), false);
  assert.equal(isRedirectStatus(200), false);
});

test('backoff doubles to an 8 s cap and adds injected jitter only', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, zeroRng)),
    [500, 1000, 2000, 4000, 8000, 8000],
  );
  assert.equal(backoffMs(1, maxRng), 500 + 249);
  assert.equal(backoffMs(9, maxRng), BACKOFF_CAP_MS + 249);
  // Jitter is a function of the injected Rng, so the sequence is reproducible.
  const rng = scriptedRng([0, 0.5, 1]);
  assert.deepEqual(
    [backoffMs(1, rng), backoffMs(2, rng), backoffMs(3, rng)],
    [500, 1125, 2249],
  );
});

test('parseRetryAfterMs accepts delta-seconds and HTTP-dates against the injected clock', () => {
  assert.equal(parseRetryAfterMs('30', 0), 30_000);
  assert.equal(parseRetryAfterMs(' 0 ', 0), 0);
  assert.equal(parseRetryAfterMs('-5', 0), 0);
  assert.equal(parseRetryAfterMs(undefined, 0), undefined);
  assert.equal(parseRetryAfterMs(null, 0), undefined);
  assert.equal(parseRetryAfterMs('', 0), undefined);
  assert.equal(parseRetryAfterMs('soon', 0), undefined);

  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:45 GMT', now), 45_000);
  // A date already in the past means "now", never a negative wait.
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT', now + 5_000), 0);
});

test('a hostile Retry-After is capped at 60 s, and jitter is added after the cap', () => {
  // CC-14: "Retry-After: 86400" must not park a tool call for a day.
  assert.equal(capRetryAfterMs(86_400_000), MAX_RETRY_AFTER_MS);
  assert.equal(capRetryAfterMs(-1), 0);
  assert.equal(capRetryAfterMs(Number.POSITIVE_INFINITY), 0);
  assert.equal(capRetryAfterMs(1_500), 1_500);

  const capped = capRetryAfterMs(parseRetryAfterMs('86400', 0) ?? 0);
  assert.equal(jitterMs(capped, RETRY_AFTER_JITTER, zeroRng), MAX_RETRY_AFTER_MS);
  assert.equal(jitterMs(capped, RETRY_AFTER_JITTER, maxRng), 71_999);
  assert.equal(jitterMs(0, RETRY_AFTER_JITTER, maxRng), 0);
});

/* ------------------------------------------------------------------------- *
 * Per-host semaphore
 * ------------------------------------------------------------------------- */

test('the semaphore admits `limit` holders per host and queues the rest', async () => {
  const pool = createSemaphorePool(2);
  const a = await pool.acquire('acme.atlassian.net');
  const b = await pool.acquire('acme.atlassian.net');
  assert.equal(pool.active('acme.atlassian.net'), 2);

  let granted = false;
  const third = pool.acquire('acme.atlassian.net').then((release) => {
    granted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(granted, false, 'the third caller must wait');
  assert.equal(pool.queued('acme.atlassian.net'), 1);

  a();
  const release = await third;
  assert.equal(granted, true);
  assert.equal(pool.active('acme.atlassian.net'), 2);
  b();
  release();
  assert.equal(pool.active('acme.atlassian.net'), 0);
});

test('the semaphore is per host: a busy host never blocks another', async () => {
  const pool = createSemaphorePool(1);
  const first = await pool.acquire('a.atlassian.net');
  const second = await pool.acquire('b.atlassian.net'); // must not block
  assert.equal(pool.active('a.atlassian.net'), 1);
  assert.equal(pool.active('b.atlassian.net'), 1);
  first();
  second();
});

test('releasing a slot twice does not over-credit the host', async () => {
  const pool = createSemaphorePool(1);
  const release = await pool.acquire('acme.atlassian.net');
  release();
  release();
  assert.equal(pool.active('acme.atlassian.net'), 0);
  const again = await pool.acquire('acme.atlassian.net');
  assert.equal(pool.active('acme.atlassian.net'), 1);
  again();
});

test('an aborted waiter leaves the queue and never holds a slot afterwards', async () => {
  const pool = createSemaphorePool(1);
  const held = await pool.acquire('acme.atlassian.net');
  const giveUp = new AbortController();

  const queued = pool.acquire('acme.atlassian.net', giveUp.signal);
  await Promise.resolve();
  assert.equal(pool.queued('acme.atlassian.net'), 1);

  giveUp.abort();
  await assert.rejects(queued, (error: Error) => error.name === 'AbortError');
  assert.equal(pool.queued('acme.atlassian.net'), 0);

  // The abandoned waiter must not be handed the slot the holder releases.
  held();
  assert.equal(pool.active('acme.atlassian.net'), 0);
});

test('acquiring with an already-aborted signal rejects instead of taking a slot', async () => {
  const pool = createSemaphorePool(1);
  await assert.rejects(
    pool.acquire('acme.atlassian.net', AbortSignal.abort()),
    (error: Error) => error.name === 'AbortError',
  );
  assert.equal(pool.active('acme.atlassian.net'), 0);
});
