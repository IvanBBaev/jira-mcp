import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeRequest,
  fenceFetch,
  installNetworkFence,
  isLiveTestRun,
  NetworkFenceError,
  realFetch,
  stripJiraEnv,
  uninstallNetworkFence,
} from './network-fence.js';
import { withEnv } from './with-env.js';

test('the fenced fetch throws synchronously rather than rejecting', () => {
  // A rejected promise would be swallowed by the retry loop's catch and the
  // suite would pass while hitting the internet.
  assert.throws(
    () => fenceFetch('https://example.invalid/rest/api/3/myself'),
    NetworkFenceError,
  );
});

test('the refusal names the offending URL and method', () => {
  try {
    fenceFetch('https://acme.atlassian.net/rest/api/3/issue', { method: 'post' });
    assert.fail('expected the fence to throw');
  } catch (err) {
    assert.ok(err instanceof NetworkFenceError);
    assert.equal(err.target, 'POST https://acme.atlassian.net/rest/api/3/issue');
    assert.match(err.message, /https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue/);
    assert.equal(err.name, 'NetworkFenceError');
  }
});

test('describeRequest handles string, URL and Request inputs', () => {
  assert.equal(describeRequest('https://a.test/x'), 'GET https://a.test/x');
  assert.equal(describeRequest(new URL('https://a.test/x')), 'GET https://a.test/x');
  assert.equal(
    describeRequest(new Request('https://a.test/x', { method: 'DELETE' })),
    'DELETE https://a.test/x',
  );
  // An explicit init method wins over the Request's own.
  assert.equal(
    describeRequest(new Request('https://a.test/x'), { method: 'put' }),
    'PUT https://a.test/x',
  );
});

test('the harness installs the fence on import', { skip: isLiveTestRun() }, () => {
  assert.equal(globalThis.fetch, fenceFetch);
});

test('install and uninstall swap the global fetch', () => {
  const before = globalThis.fetch;
  try {
    uninstallNetworkFence();
    assert.equal(globalThis.fetch, realFetch);
    installNetworkFence();
    assert.equal(globalThis.fetch, fenceFetch);
    installNetworkFence(); // idempotent
    assert.equal(globalThis.fetch, fenceFetch);
  } finally {
    globalThis.fetch = before;
  }
});

test('stripJiraEnv removes JIRA_* but keeps the live-test switch', async () => {
  await withEnv(
    {
      JIRA_SITE: 'https://acme.atlassian.net',
      JIRA_API_TOKEN: 'secret',
      JIRA_LIVE_TEST: '1',
      NOT_JIRA_SITE: 'kept',
    },
    () => {
      const removed = stripJiraEnv();
      assert.ok(removed.includes('JIRA_SITE'));
      assert.ok(removed.includes('JIRA_API_TOKEN'));
      assert.ok(!removed.includes('JIRA_LIVE_TEST'));
      assert.equal(process.env['JIRA_SITE'], undefined);
      assert.equal(process.env['JIRA_API_TOKEN'], undefined);
      assert.equal(process.env['JIRA_LIVE_TEST'], '1');
      assert.equal(process.env['NOT_JIRA_SITE'], 'kept');
    },
  );
});

test('isLiveTestRun is true only for the exact value 1', async () => {
  await withEnv({ JIRA_LIVE_TEST: '1' }, () => {
    assert.equal(isLiveTestRun(), true);
  });
  await withEnv({ JIRA_LIVE_TEST: 'true' }, () => {
    assert.equal(isLiveTestRun(), false);
  });
  await withEnv({ JIRA_LIVE_TEST: undefined }, () => {
    assert.equal(isLiveTestRun(), false);
  });
});
