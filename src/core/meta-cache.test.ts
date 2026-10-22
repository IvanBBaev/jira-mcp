import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeClock } from './fakes/fakeClock.js';
import { createFakeJiraRequest, jiraErr, jiraOk } from './fakes/fakeJiraRequest.js';
import {
  DEFAULT_META_CACHE_ENTRIES,
  META_CACHE_ROUTES,
  createMetaCache,
  isMetaCacheable,
  metaCacheKey,
} from './meta-cache.js';
import { JiraError } from './types.js';
import type { JiraRequestFn, JiraRequestSpec } from './types.js';

const TTL_MS = 5_000;

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const clock = createFakeClock(1_000);
  const fake = createFakeJiraRequest();
  const cache = createMetaCache({
    clock,
    ttlMs: options.ttlMs ?? TTL_MS,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  const jira = cache.wrap(fake.fn);
  return { clock, fake, cache, jira };
}

const FIELDS: JiraRequestSpec = { method: 'GET', path: '/field' };

describe('createMetaCache — hits and misses', () => {
  it('answers a repeat catalogue GET from memory within the TTL', async () => {
    const { fake, jira, cache } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([{ id: 'summary' }]));

    const first = await jira(FIELDS);
    const second = await jira(FIELDS);

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(second.data, first.data);
    assert.equal(second.status, 200);
    assert.equal(cache.size(), 1);
  });

  it('[CC-1405] expires at exactly TTL after the fetch STARTED, not after it answered', async () => {
    const { clock, fake, cache } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([]));
    // The upstream takes 3 s to answer: the entry still dies 5 s after t=1000.
    const slow: JiraRequestFn = async (req) => {
      clock.advance(3_000);
      return fake.fn(req);
    };
    const jira = cache.wrap(slow);

    await jira(FIELDS); // started 1000, answered 4000, expires 6000
    clock.set(5_999);
    await jira(FIELDS);
    assert.equal(fake.calls.length, 1, 'one tick before expiry is a hit');

    clock.set(6_000);
    await jira(FIELDS);
    assert.equal(fake.calls.length, 2, 'the expiry instant itself is a miss');
    assert.equal(cache.size(), 1, 'the refreshed entry replaces the stale one');
  });

  it('[CC-1406] never stores a failed fetch, so the next ask reaches the host', async () => {
    const { fake, jira, cache } = setup();
    fake.on(
      'GET /rest/api/3/field',
      jiraErr(
        new JiraError({ kind: 'transport', message: 'boom', remediation: 'retry' }),
      ),
      1,
    );
    fake.on('GET /rest/api/3/field', jiraOk([{ id: 'ok' }]));

    await assert.rejects(jira(FIELDS), (error: unknown) => error instanceof JiraError);
    assert.equal(cache.size(), 0);

    const res = await jira<unknown[]>(FIELDS);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(res.data, [{ id: 'ok' }]);
  });

  it('[CC-1407] hands out a deep copy, so a caller mutating a hit cannot poison the next one', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([{ id: 'summary', name: 'Summary' }]));

    const first = await jira<{ id: string; name: string }[]>(FIELDS);
    first.data.splice(0, 1); // what a paging loop does to `values`

    const second = await jira<{ id: string; name: string }[]>(FIELDS);
    assert.deepEqual(second.data, [{ id: 'summary', name: 'Summary' }]);
    second.data[0]!.name = 'Renamed';
    const third = await jira<{ id: string; name: string }[]>(FIELDS);
    assert.equal(third.data[0]!.name, 'Summary');
    assert.notEqual(second.data, third.data, 'each hit is its own object');
    assert.notEqual(second.headers, third.headers, 'headers are copied too');
    assert.equal(fake.calls.length, 1);
  });

  it('keeps status and headers of the original answer on a hit', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([], { headers: { 'x-arequestid': 'abc' } }));

    await jira(FIELDS);
    const hit = await jira(FIELDS);

    assert.equal(hit.status, 200);
    assert.equal(hit.headers['x-arequestid'], 'abc');
  });

  it('[CC-1409] with a TTL of 0 returns the seam itself — no wrapper, no store', async () => {
    const { fake, cache } = setup({ ttlMs: 0 });
    const jira = cache.wrap(fake.fn);
    fake.on('GET /rest/api/3/field', jiraOk([]));

    assert.equal(jira, fake.fn);
    await jira(FIELDS);
    await jira(FIELDS);
    assert.equal(fake.calls.length, 2);
    assert.equal(cache.size(), 0);
  });

  it('clear() forgets everything', async () => {
    const { fake, jira, cache } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([]));

    await jira(FIELDS);
    cache.clear();
    await jira(FIELDS);

    assert.equal(fake.calls.length, 2);
  });
});

describe('createMetaCache — what is cacheable', () => {
  it('[CC-1408] answers only the catalogue routes; transitions, projects, identity and permissions always go to the host', async () => {
    const { fake, jira } = setup();
    const never: JiraRequestSpec[] = [
      { method: 'GET', path: '/issue/ABC-1/transitions' },
      { method: 'GET', path: '/project/ABC' },
      { method: 'GET', path: '/project/search' },
      { method: 'GET', path: '/myself' },
      {
        method: 'GET',
        path: '/mypermissions',
        query: { permissions: 'BROWSE_PROJECTS' },
      },
      { method: 'GET', path: '/issue/ABC-1' },
      { method: 'GET', path: '/field/customfield_10014/context' },
    ];
    for (const req of never) {
      assert.equal(isMetaCacheable(req), false, req.path);
      fake.on(`GET /rest/api/3${req.path}`, jiraOk({}));
      await jira(req);
      await jira(req);
    }
    assert.equal(fake.calls.length, never.length * 2);

    for (const path of ['/field', '/issueLinkType', '/statuses/search', '/status']) {
      assert.equal(isMetaCacheable({ method: 'GET', path }), true, path);
    }
    assert.deepEqual([...META_CACHE_ROUTES].sort(), [
      '/field',
      '/issue/createmeta/{projectIdOrKey}/issuetypes',
      '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
      '/issueLinkType',
      '/status',
      '/statuses/search',
    ]);
  });

  it('[CC-1408] matches create meta by its path TEMPLATE, so two projects are two entries', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/3/issue/createmeta/ABC/issuetypes', jiraOk({ values: ['a'] }));
    fake.on('GET /rest/api/3/issue/createmeta/XYZ/issuetypes', jiraOk({ values: ['x'] }));
    const abc: JiraRequestSpec = {
      method: 'GET',
      path: '/issue/createmeta/ABC/issuetypes',
      pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes',
    };
    const xyz: JiraRequestSpec = { ...abc, path: '/issue/createmeta/XYZ/issuetypes' };

    assert.equal(isMetaCacheable(abc), true);
    // Without the template the literal path is not on the list — the api ring
    // always sets it for these routes, so this is the belt to that brace.
    assert.equal(isMetaCacheable({ method: 'GET', path: abc.path }), false);

    const a1 = await jira<{ values: string[] }>(abc);
    const x1 = await jira<{ values: string[] }>(xyz);
    const a2 = await jira<{ values: string[] }>(abc);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(a1.data, { values: ['a'] });
    assert.deepEqual(x1.data, { values: ['x'] });
    assert.deepEqual(a2.data, { values: ['a'] });
  });

  it('[CC-1412] never caches a POST — `POST /field` creates a custom field', async () => {
    const { fake, jira } = setup();
    fake.on('POST /rest/api/3/field', jiraOk({ id: 'customfield_1' }));
    fake.on('GET /rest/api/3/field', jiraOk([]));
    const post: JiraRequestSpec = { method: 'POST', path: '/field', body: { name: 'x' } };

    assert.equal(isMetaCacheable(post), false);
    await jira(post);
    await jira(post);
    assert.equal(fake.calls.length, 2);

    // Nor a GET that carries a body, multipart or asks for bytes.
    assert.equal(isMetaCacheable({ method: 'GET', path: '/field', body: {} }), false);
    assert.equal(
      isMetaCacheable({ method: 'GET', path: '/field', multipart: [] }),
      false,
    );
    assert.equal(
      isMetaCacheable({ method: 'GET', path: '/field', accept: 'binary' }),
      false,
    );
    // And the POST left nothing behind for the GET to find.
    await jira(FIELDS);
    assert.equal(fake.calls.length, 3);
  });

  it('[CC-1413] forwards a request whose signal is already aborted, so the caller gets its own error', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/3/field', jiraOk([]));
    await jira(FIELDS);

    const controller = new AbortController();
    controller.abort();
    await jira({ ...FIELDS, signal: controller.signal });

    assert.equal(fake.calls.length, 2, 'the seam saw the aborted request');
    assert.equal(fake.lastRequest()?.signal?.aborted, true);
  });
});

describe('createMetaCache — keys', () => {
  it('[CC-1404] keys on the profile, so one tenant never answers for another', async () => {
    const { fake, jira } = setup();
    fake.on((req) => req.profile === 'prod', jiraOk([{ id: 'prod-field' }]));
    fake.on((req) => req.profile === 'staging', jiraOk([{ id: 'staging-field' }]));
    fake.on((req) => req.profile === undefined, jiraOk([{ id: 'default-field' }]));

    const prod = await jira<{ id: string }[]>({ ...FIELDS, profile: 'prod' });
    const staging = await jira<{ id: string }[]>({ ...FIELDS, profile: 'staging' });
    const plain = await jira<{ id: string }[]>(FIELDS);
    const prodAgain = await jira<{ id: string }[]>({ ...FIELDS, profile: 'prod' });

    assert.equal(fake.calls.length, 3);
    assert.equal(prod.data[0]!.id, 'prod-field');
    assert.equal(staging.data[0]!.id, 'staging-field');
    assert.equal(plain.data[0]!.id, 'default-field');
    assert.equal(prodAgain.data[0]!.id, 'prod-field');
  });

  it('[CC-1411] canonicalises the query: key order and undefined do not matter, values do', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/3/statuses/search', jiraOk({ values: [] }));

    await jira({
      method: 'GET',
      path: '/statuses/search',
      query: { maxResults: 200, startAt: 0, projectId: undefined },
    });
    await jira({
      method: 'GET',
      path: '/statuses/search',
      query: { startAt: 0, maxResults: 200 },
    });
    assert.equal(fake.calls.length, 1, 'same parameters, different spelling');

    await jira({
      method: 'GET',
      path: '/statuses/search',
      query: { startAt: 200, maxResults: 200 },
    });
    assert.equal(fake.calls.length, 2, 'the next page is a different entry');

    assert.equal(
      metaCacheKey({ method: 'GET', path: '/field', query: { b: '1', a: true } }),
      metaCacheKey({
        method: 'GET',
        path: '/field',
        query: { a: true, b: 1, c: undefined },
      }),
    );
  });

  it('[CC-1415] keys on the API root, so the Data Center v2 catalogue never aliases v3', async () => {
    const { fake, jira } = setup();
    fake.on('GET /rest/api/2/status', jiraOk([{ id: '1', name: 'Open' }]));
    fake.on('GET /rest/api/3/status', jiraOk([{ id: '1', name: 'To Do' }]));

    const v2 = await jira<{ name: string }[]>({
      method: 'GET',
      path: '/status',
      root: 'v2',
    });
    const v3 = await jira<{ name: string }[]>({ method: 'GET', path: '/status' });
    await jira({ method: 'GET', path: '/status', root: 'v3' });

    assert.equal(fake.calls.length, 2);
    assert.equal(v2.data[0]!.name, 'Open');
    assert.equal(v3.data[0]!.name, 'To Do');
    assert.notEqual(
      metaCacheKey({ method: 'GET', path: '/status', root: 'v2' }),
      metaCacheKey({ method: 'GET', path: '/status' }),
    );
  });
});

describe('createMetaCache — bounds', () => {
  it('[CC-1410] evicts the oldest entry once the store is full', async () => {
    const { fake, jira, cache } = setup({ maxEntries: 2 });
    fake.on('GET /rest/api/3/field', jiraOk(['f']));
    fake.on('GET /rest/api/3/issueLinkType', jiraOk(['l']));
    fake.on('GET /rest/api/3/status', jiraOk(['s']));

    await jira({ method: 'GET', path: '/field' });
    await jira({ method: 'GET', path: '/issueLinkType' });
    assert.equal(cache.size(), 2);

    await jira({ method: 'GET', path: '/status' }); // evicts /field
    assert.equal(cache.size(), 2);
    await jira({ method: 'GET', path: '/issueLinkType' }); // still a hit
    assert.equal(fake.calls.length, 3);

    await jira({ method: 'GET', path: '/field' }); // a miss again, evicts /issueLinkType
    assert.equal(fake.calls.length, 4);
    assert.equal(cache.size(), 2);
    await jira({ method: 'GET', path: '/issueLinkType' });
    assert.equal(fake.calls.length, 5);
  });

  it('treats a non-positive maxEntries as 1 and keeps the default sane', async () => {
    assert.equal(DEFAULT_META_CACHE_ENTRIES, 64);
    const { fake, jira, cache } = setup({ maxEntries: 0 });
    fake.on('GET /rest/api/3/field', jiraOk([]));
    fake.on('GET /rest/api/3/status', jiraOk([]));

    await jira({ method: 'GET', path: '/field' });
    await jira({ method: 'GET', path: '/status' });
    assert.equal(cache.size(), 1);
    await jira({ method: 'GET', path: '/status' });
    assert.equal(fake.calls.length, 2, 'the newest entry survives');
  });
});
