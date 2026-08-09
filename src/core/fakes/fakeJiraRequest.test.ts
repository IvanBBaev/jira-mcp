import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JiraError } from '../types.js';
import type { JiraRequestSpec } from '../types.js';
import { createFakeJiraRequest, jiraErr, jiraOk, routeOf } from './fakeJiraRequest.js';

const GET_MYSELF: JiraRequestSpec = { method: 'GET', path: '/myself' };

test('routeOf prefixes the path with the API root', () => {
  assert.equal(routeOf(GET_MYSELF), 'GET /rest/api/3/myself');
  assert.equal(
    routeOf({ method: 'GET', path: '/board', root: 'agile' }),
    'GET /rest/agile/1.0/board',
  );
  // Same tail, different root — the roots must stay distinguishable.
  assert.notEqual(
    routeOf({ method: 'GET', path: '/x', root: 'v3' }),
    routeOf({ method: 'GET', path: '/x', root: 'agile' }),
  );
});

test('a programmed route answers with the canned response', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/myself', jiraOk({ accountId: 'a1' }));

  const res = await fake.fn<{ accountId: string }>(GET_MYSELF);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { accountId: 'a1' });
  assert.deepEqual(res.headers, {});
});

test('status and headers are honoured, header names lowercased', async () => {
  const fake = createFakeJiraRequest();
  fake.on(
    'POST /rest/api/3/issue',
    jiraOk({ id: '1' }, { status: 201, headers: { Location: '/x' } }),
  );

  const res = await fake.fn({ method: 'POST', path: '/issue' });
  assert.equal(res.status, 201);
  assert.equal(res.headers['location'], '/x');
});

test('the queue is consumed before any rule', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/myself', jiraOk({ from: 'rule' }));
  fake.enqueue(jiraOk({ from: 'queue' }));

  assert.deepEqual((await fake.fn(GET_MYSELF)).data, { from: 'queue' });
  assert.deepEqual((await fake.fn(GET_MYSELF)).data, { from: 'rule' });
});

test('regex and predicate matchers see the route and the whole spec', async () => {
  const fake = createFakeJiraRequest();
  fake.on(/\/rest\/agile\/1\.0\/board\/\d+$/, jiraOk({ id: 7 }));
  fake.on((req) => req.query?.['jql'] === 'project = ABC', jiraOk({ issues: [] }));

  const board = await fake.fn({ method: 'GET', path: '/board/7', root: 'agile' });
  assert.deepEqual(board.data, { id: 7 });
  const searched = await fake.fn({
    method: 'GET',
    path: '/search/jql',
    query: { jql: 'project = ABC' },
  });
  assert.deepEqual(searched.data, { issues: [] });
});

test('a rule can be limited with times', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/myself', jiraOk({ n: 1 }), 1);

  assert.deepEqual((await fake.fn(GET_MYSELF)).data, { n: 1 });
  assert.throws(
    () => fake.fn(GET_MYSELF),
    /unexpected request GET \/rest\/api\/3\/myself/,
  );
});

test('an unmatched route throws synchronously, it never returns {}', () => {
  const fake = createFakeJiraRequest();
  // Synchronous on purpose: a rejection would look like a modelled upstream
  // failure to the code under test, and the retry loop would swallow it.
  assert.throws(
    () => fake.fn({ method: 'DELETE', path: '/issue/ABC-1' }),
    /createFakeJiraRequest: unexpected request DELETE \/rest\/api\/3\/issue\/ABC-1/,
  );
});

test('jiraErr rejects with the programmed error', async () => {
  const fake = createFakeJiraRequest();
  const error = new JiraError({ kind: 'rate_limited', message: 'too many requests' });
  fake.enqueue(jiraErr(error));

  await assert.rejects(fake.fn(GET_MYSELF), (thrown: unknown) => {
    assert.ok(thrown instanceof JiraError);
    assert.equal(thrown.kind, 'rate_limited');
    assert.equal(thrown.retryable, true);
    return true;
  });
});

test('every request is recorded, and reset clears the fake', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET', jiraOk({}));

  await fake.fn(GET_MYSELF);
  await fake.fn({ method: 'GET', path: '/board', root: 'agile' });

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.routes(), [
    'GET /rest/api/3/myself',
    'GET /rest/agile/1.0/board',
  ]);
  assert.equal(fake.lastRequest()?.path, '/board');

  fake.reset();
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.lastRequest(), undefined);
  assert.throws(() => fake.fn(GET_MYSELF), /unexpected request/);
});

test('fixture() fails loudly until a loader is injected', () => {
  const bare = createFakeJiraRequest();
  assert.throws(() => bare.fixture('search/jql-page-1'), /no fixture loader configured/);

  const bodies: Record<string, unknown> = { 'search/jql-page-1': { issues: [] } };
  const loaded = createFakeJiraRequest({ loadFixture: (name) => bodies[name] });
  assert.deepEqual(loaded.fixture('search/jql-page-1'), { issues: [] });
  assert.throws(() => loaded.fixture('missing'), /fixture "missing" not found/);
});

test('the chainable setters return the fake', () => {
  const fake = createFakeJiraRequest();
  assert.equal(fake.on('GET', jiraOk({})), fake);
  assert.equal(fake.enqueue(jiraOk({})), fake);
});
