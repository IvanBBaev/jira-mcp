import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withFetch } from './with-fetch.js';

test('the scripted queue is consumed in order', async () => {
  await withFetch(async (mock) => {
    mock
      .enqueue({ status: 503 })
      .enqueue({ status: 503 })
      .enqueue({ status: 200, json: { ok: true } });

    const first = await fetch('https://a.test/1');
    const second = await fetch('https://a.test/2');
    const third = await fetch('https://a.test/3');

    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(third.status, 200);
    assert.deepEqual(await third.json(), { ok: true });
    assert.equal(mock.requests.length, 3);
    assert.equal(mock.lastRequest()?.url, 'https://a.test/3');
  });
});

test('rules match by substring, regex and predicate', async () => {
  await withFetch(async (mock) => {
    mock
      .on('/rest/api/3/myself', { json: { accountId: 'a1' } })
      .on(/\/rest\/agile\/1\.0\/board$/, { json: { values: [] } })
      .on((req) => req.method === 'POST', { status: 201, json: { id: '10000' } });

    const me = await fetch('https://a.test/rest/api/3/myself');
    assert.deepEqual(await me.json(), { accountId: 'a1' });

    const boards = await fetch('https://a.test/rest/agile/1.0/board');
    assert.deepEqual(await boards.json(), { values: [] });

    const created = await fetch('https://a.test/rest/api/3/issue', { method: 'POST' });
    assert.equal(created.status, 201);
    const methods = mock.requests.map((r) => r.method);
    assert.deepEqual(methods, ['GET', 'GET', 'POST']);
  });
});

test('a rule can be limited with times, then falls through', async () => {
  await withFetch(async (mock) => {
    mock.on('/x', { status: 429 }, 1).fallback({ status: 200 });

    assert.equal((await fetch('https://a.test/x')).status, 429);
    assert.equal((await fetch('https://a.test/x')).status, 200);
  });
});

test('an unmatched request throws and names itself', async () => {
  await withFetch(async () => {
    await assert.rejects(fetch('https://a.test/unprogrammed', { method: 'DELETE' }), {
      message: /withFetch: unexpected request DELETE https:\/\/a\.test\/unprogrammed/,
    });
  });
});

test('an error spec models a transport failure', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ error: new TypeError('fetch failed') });
    await assert.rejects(fetch('https://a.test/x'), TypeError);
  });
});

test('bodies get a default content-type; bodyless statuses stay empty', async () => {
  await withFetch(async (mock) => {
    mock
      .enqueue({ json: { a: 1 } })
      .enqueue({ text: 'plain' })
      .enqueue({ bytes: new TextEncoder().encode('raw') })
      .enqueue({ status: 204, json: { ignored: true } })
      .enqueue({
        json: { a: 1 },
        headers: { 'content-type': 'application/problem+json' },
      });

    const asJson = await fetch('https://a.test/1');
    assert.equal(asJson.headers.get('content-type'), 'application/json');

    const asText = await fetch('https://a.test/2');
    assert.equal(asText.headers.get('content-type'), 'text/plain');
    assert.equal(await asText.text(), 'plain');

    assert.equal(await (await fetch('https://a.test/3')).text(), 'raw');

    const empty = await fetch('https://a.test/4');
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');

    const problem = await fetch('https://a.test/5');
    assert.equal(problem.headers.get('content-type'), 'application/problem+json');
  });
});

test('requests are recorded with lowercased headers and a decoded body', async () => {
  await withFetch(async (mock) => {
    mock.fallback({ status: 200 });

    await fetch('https://a.test/rest/api/3/issue', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'cid-1' },
      body: JSON.stringify({ fields: {} }),
    });
    await fetch('https://a.test/form', {
      method: 'POST',
      body: new URLSearchParams({ a: 'b' }),
    });
    await fetch(
      new Request('https://a.test/req', { method: 'PUT', body: 'from-request' }),
    );

    const [first, second, third] = mock.requests;
    assert.equal(first?.method, 'POST');
    assert.equal(first?.headers['content-type'], 'application/json');
    assert.equal(first?.headers['x-trace'], 'cid-1');
    assert.equal(first?.body, '{"fields":{}}');
    assert.equal(second?.body, 'a=b');
    assert.equal(third?.method, 'PUT');
    assert.equal(third?.body, 'from-request');
  });
});

test('the previous global fetch is restored even when the callback throws', async () => {
  const before = globalThis.fetch;
  await assert.rejects(
    withFetch(() => {
      assert.notEqual(globalThis.fetch, before);
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  assert.equal(globalThis.fetch, before);
});

test('withFetch returns the callback value', async () => {
  const value = await withFetch(() => 42);
  assert.equal(value, 42);
});
