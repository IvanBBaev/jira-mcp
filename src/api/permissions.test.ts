// Tests for `api/permissions.ts` (D122) — contract tier (TESTING.md §Mocking
// tiers). Bodies are inline plain objects shaped after the real
// `/rest/api/3/mypermissions` payload and marked `// synthetic`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock, createFakeJiraRequest, jiraOk } from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import {
  MAX_PERMISSION_KEYS,
  MY_PERMISSIONS_PATH,
  getMyPermissions,
} from './permissions.js';

const ROUTE = `GET /rest/api/3${MY_PERMISSIONS_PATH}`;

/** One entry of the `permissions` record as Jira writes it. // synthetic */
function answer(
  key: string,
  havePermission: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '10',
    key,
    name: key
      .toLowerCase()
      .split('_')
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(' '),
    type: key === 'ADMINISTER' || key === 'BULK_CHANGE' ? 'GLOBAL' : 'PROJECT',
    description: `Ability to ${key.toLowerCase().replace('_', ' ')}.`,
    havePermission,
    ...extra,
  };
}

function body(...entries: Record<string, unknown>[]): Record<string, unknown> {
  const permissions: Record<string, unknown> = {};
  for (const entry of entries) permissions[String(entry['key'])] = entry;
  return { permissions };
}

function isJiraErrorOfKind(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('getMyPermissions asks site-wide when no scope is given and answers in request order', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(
      body(answer('ADMINISTER', false), answer('BROWSE_PROJECTS', true)), // synthetic
    ),
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['BROWSE_PROJECTS', 'ADMINISTER'],
  });

  assert.deepEqual(jira.routes(), [ROUTE]);
  assert.deepEqual(jira.calls[0]?.query, { permissions: 'BROWSE_PROJECTS,ADMINISTER' });
  assert.deepEqual(result, {
    context: 'global',
    permissions: [
      { key: 'BROWSE_PROJECTS', granted: true, name: 'Browse Projects', type: 'PROJECT' },
      { key: 'ADMINISTER', granted: false, name: 'Administer', type: 'GLOBAL' },
    ],
    unanswered: [],
  });
});

test('a project key goes on the wire as projectKey and the result says so', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(body(answer('CREATE_ISSUES', true))), // synthetic
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['CREATE_ISSUES'],
    projectKey: ' ABC ',
  });

  assert.deepEqual(jira.calls[0]?.query, {
    permissions: 'CREATE_ISSUES',
    projectKey: 'ABC',
  });
  assert.equal(result.context, 'project');
  assert.equal(result.projectKey, 'ABC');
  assert.equal(result.issueKey, undefined);
});

test('an all-digit project reference is sent as projectId, an all-digit issue as issueId', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(body(answer('CREATE_ISSUES', true)))) // synthetic
    .enqueue(jiraOk(body(answer('EDIT_ISSUES', true)))); // synthetic

  await getMyPermissions({
    jira: jira.fn,
    permissions: ['CREATE_ISSUES'],
    projectKey: '10000',
  });
  await getMyPermissions({
    jira: jira.fn,
    permissions: ['EDIT_ISSUES'],
    issueKey: '10042',
  });

  assert.deepEqual(jira.calls[0]?.query, {
    permissions: 'CREATE_ISSUES',
    projectId: '10000',
  });
  assert.deepEqual(jira.calls[1]?.query, {
    permissions: 'EDIT_ISSUES',
    issueId: '10042',
  });
});

test('[CC-1403] an issue wins over a project: only the issue goes on the wire and context says issue', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(body(answer('EDIT_ISSUES', false))), // synthetic
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['EDIT_ISSUES'],
    projectKey: 'ABC',
    issueKey: 'ABC-7',
  });

  // Cloud evaluates the project and ignores the issue when both are present;
  // sending only the issue is what keeps the answer about the issue.
  assert.deepEqual(jira.calls[0]?.query, {
    permissions: 'EDIT_ISSUES',
    issueKey: 'ABC-7',
  });
  assert.deepEqual(result, {
    context: 'issue',
    issueKey: 'ABC-7',
    permissions: [
      { key: 'EDIT_ISSUES', granted: false, name: 'Edit Issues', type: 'PROJECT' },
    ],
    unanswered: [],
  });
});

test('name and type are optional: a bare havePermission answer is still read', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ permissions: { WORK_ON_ISSUES: { havePermission: true, name: '' } } }), // synthetic
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['WORK_ON_ISSUES'],
  });

  assert.deepEqual(result.permissions, [{ key: 'WORK_ON_ISSUES', granted: true }]);
});

test('the signal and the deadline travel with the request', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(body(answer('BROWSE_PROJECTS', true))), // synthetic
  );
  const controller = new AbortController();
  const clock = createFakeClock(1_000);

  await getMyPermissions({
    jira: jira.fn,
    permissions: ['BROWSE_PROJECTS'],
    signal: controller.signal,
    deadlineAt: 31_000,
    clock,
  });

  assert.equal(jira.calls[0]?.signal, controller.signal);
  assert.equal(jira.calls[0]?.deadlineAt, 31_000);
});

// ---------------------------------------------------------------------------
// CC-1400 — refused before the wire
// ---------------------------------------------------------------------------

test('[CC-1400] a blank permission key is refused before anything reaches the wire', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    getMyPermissions({ jira: jira.fn, permissions: ['BROWSE_PROJECTS', '  '] }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

test('[CC-1400] a comma-separated list in one entry is refused as not a permission key', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    getMyPermissions({ jira: jira.fn, permissions: ['BROWSE_PROJECTS,CREATE_ISSUES'] }),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'validation' &&
      error.message.includes('"BROWSE_PROJECTS,CREATE_ISSUES"') &&
      error.message.includes('one key per array entry'),
  );
  assert.equal(jira.calls.length, 0);
});

test('[CC-1400] an empty key list is refused; Jira has nothing to answer', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    getMyPermissions({ jira: jira.fn, permissions: [] }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

test('[CC-1400] more keys than the cap are refused with the cap named; exact repeats do not count', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(body(answer('BROWSE_PROJECTS', true))), // synthetic
  );

  const tooMany = Array.from(
    { length: MAX_PERMISSION_KEYS + 1 },
    (_, i) => `PERM_${String(i)}`,
  );
  await assert.rejects(
    getMyPermissions({ jira: jira.fn, permissions: tooMany }),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'validation' &&
      error.message.includes(String(MAX_PERMISSION_KEYS)),
  );
  assert.equal(jira.calls.length, 0);

  // The same key repeated is one question, asked once.
  const repeated = Array.from(
    { length: MAX_PERMISSION_KEYS + 5 },
    () => 'BROWSE_PROJECTS',
  );
  const result = await getMyPermissions({ jira: jira.fn, permissions: repeated });
  assert.deepEqual(jira.calls[0]?.query, { permissions: 'BROWSE_PROJECTS' });
  assert.equal(result.permissions.length, 1);
});

test('[CC-1400] a blank scope is refused rather than silently widened to the whole site', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    getMyPermissions({
      jira: jira.fn,
      permissions: ['BROWSE_PROJECTS'],
      projectKey: ' ',
    }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    getMyPermissions({ jira: jira.fn, permissions: ['BROWSE_PROJECTS'], issueKey: '' }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CC-1401 / CC-1402 — what Jira did and did not answer
// ---------------------------------------------------------------------------

test('[CC-1401] a key Jira did not answer is reported unanswered, never as denied', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(body(answer('BROWSE_PROJECTS', true))), // synthetic — DELETE_ISSUES missing
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['DELETE_ISSUES', 'BROWSE_PROJECTS'],
  });

  assert.deepEqual(result.unanswered, ['DELETE_ISSUES']);
  assert.deepEqual(
    result.permissions.map((p) => [p.key, p.granted]),
    [['BROWSE_PROJECTS', true]],
  );
});

test('[CC-1402] answers for keys that were not asked for are dropped; request order is kept', async () => {
  // A Data Center build that ignores the `permissions` filter sends everything.
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(
      body(
        answer('ADMINISTER', false),
        answer('EDIT_ISSUES', true),
        answer('BROWSE_PROJECTS', true),
        answer('BULK_CHANGE', false),
      ), // synthetic
    ),
  );

  const result = await getMyPermissions({
    jira: jira.fn,
    permissions: ['BROWSE_PROJECTS', 'EDIT_ISSUES'],
  });

  assert.deepEqual(
    result.permissions.map((p) => p.key),
    ['BROWSE_PROJECTS', 'EDIT_ISSUES'],
  );
  assert.deepEqual(result.unanswered, []);
});

// ---------------------------------------------------------------------------
// Shape failures
// ---------------------------------------------------------------------------

test('a body without a permissions record is unexpected_shape', async () => {
  for (const data of [null, [], 'nope', {}, { permissions: ['BROWSE_PROJECTS'] }]) {
    const jira = createFakeJiraRequest().enqueue(jiraOk(data)); // synthetic
    await assert.rejects(
      getMyPermissions({ jira: jira.fn, permissions: ['BROWSE_PROJECTS'] }),
      isJiraErrorOfKind('unexpected_shape'),
      JSON.stringify(data),
    );
  }
});

test('an entry without a boolean havePermission is unexpected_shape, not a guess', async () => {
  for (const entry of [
    'granted',
    null,
    { havePermission: 'true' },
    { key: 'BROWSE_PROJECTS' },
  ]) {
    const jira = createFakeJiraRequest().enqueue(
      jiraOk({ permissions: { BROWSE_PROJECTS: entry } }), // synthetic
    );
    await assert.rejects(
      getMyPermissions({ jira: jira.fn, permissions: ['BROWSE_PROJECTS'] }),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'unexpected_shape' &&
        error.message.includes('BROWSE_PROJECTS'),
      JSON.stringify(entry),
    );
  }
});
