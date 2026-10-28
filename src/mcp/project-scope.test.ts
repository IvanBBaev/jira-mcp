// Tests for the JIRA_PROJECTS scope guard (D400).
//
// The load-bearing claims:
//   * JQL is confined as `project in (…) AND (<where>) ORDER BY …`, quote- and
//     parenthesis-aware, and unbalanced JQL is refused rather than wrapped;
//   * every entity a request names is resolved to its project and an
//     out-of-scope one is refused before anything is sent;
//   * project and board lists come back filtered;
//   * unknown routes and attachments by id are refused (fail closed).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeJiraRequest, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import type { FakeJiraRequest } from '../core/fakes/fakeJiraRequest.js';
import { JiraError } from '../core/types.js';
import {
  createProjectScope,
  projectClause,
  scopeJql,
  splitJql,
} from './project-scope.js';

const KEYS = ['ABC', 'DEF'] as const;
const CLAUSE = 'project in ("ABC", "DEF")';

function setup(deployment: 'cloud' | 'datacenter' = 'cloud'): {
  fake: FakeJiraRequest;
  scope: ReturnType<typeof createProjectScope>;
} {
  const fake = createFakeJiraRequest();
  const scope = createProjectScope({ keys: KEYS, inner: fake.fn, deployment });
  return { fake, scope };
}

async function refused(
  promise: Promise<unknown>,
  kind = 'permission',
): Promise<JiraError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JiraError, 'a JiraError');
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail('expected a refusal');
}

// --- JQL ---------------------------------------------------------------------

test('projectClause quotes every key', () => {
  assert.equal(projectClause(['ABC']), 'project in ("ABC")');
});

test('CC-4001: scopeJql wraps the where clause and keeps ORDER BY outside it', () => {
  assert.equal(
    scopeJql('status = Done OR assignee = currentUser() order by created DESC', KEYS),
    `${CLAUSE} AND (status = Done OR assignee = currentUser()) ORDER BY created DESC`,
  );
});

test('scopeJql turns an empty or absent query into the project clause', () => {
  assert.equal(scopeJql(undefined, KEYS), CLAUSE);
  assert.equal(scopeJql('   ', KEYS), CLAUSE);
  assert.equal(scopeJql('ORDER BY rank', KEYS), `${CLAUSE} ORDER BY rank`);
});

test('splitJql ignores ORDER BY inside strings, parentheses and longer words', () => {
  assert.deepEqual(splitJql("summary ~ \"order by x\" AND text ~ 'a\\'order by'"), {
    where: "summary ~ \"order by x\" AND text ~ 'a\\'order by'",
  });
  assert.deepEqual(splitJql('(a = 1) order by b'), { where: '(a = 1)', orderBy: 'b' });
  assert.deepEqual(splitJql('reorder by = 1'), { where: 'reorder by = 1' });
});

test('CC-4001: splitJql refuses unbalanced quotes and parentheses', () => {
  assert.equal(splitJql('summary ~ "open'), undefined);
  assert.equal(splitJql('a = 1) OR (b = 2'), undefined);
  assert.equal(splitJql('(a = 1'), undefined);
});

test('an injection attempt cannot escape the project clause', () => {
  // The closing parenthesis would break out of the wrapper; it is refused.
  assert.equal(scopeJql('a = 1) OR (project = XYZ', KEYS), undefined);
});

// --- Search ------------------------------------------------------------------

test('POST /search/jql has its body JQL rewritten', async () => {
  const { fake, scope } = setup();
  fake.on('POST /rest/api/3/search/jql', jiraOk({ issues: [] }));
  await scope.jira({
    method: 'POST',
    path: '/search/jql',
    body: { jql: 'a = 1', fields: [] },
    safe: true,
  });
  assert.deepEqual(fake.lastRequest()?.body, {
    jql: `${CLAUSE} AND (a = 1)`,
    fields: [],
  });
});

test('GET search and the Data Center /search have their query JQL rewritten', async () => {
  const { fake, scope } = setup('datacenter');
  fake.on('GET /rest/api/2/search', jiraOk({ issues: [] }));
  await scope.jira({
    method: 'GET',
    root: 'v2',
    path: '/search',
    query: { jql: 'a = 1' },
  });
  assert.equal(fake.lastRequest()?.query?.['jql'], `${CLAUSE} AND (a = 1)`);
});

test('CC-4001: unbalanced JQL is refused as validation and never sent', async () => {
  const { fake, scope } = setup();
  await refused(
    scope.jira({
      method: 'POST',
      path: '/search/approximate-count',
      body: { jql: '(a' },
    }),
    'validation',
  );
  assert.equal(fake.calls.length, 0);
});

test('CC-4006: a search response carrying an out-of-scope issue is refused', async () => {
  const { fake, scope } = setup();
  fake.on(
    'POST /rest/api/3/search/jql',
    jiraOk({ issues: [{ key: 'XYZ-1', fields: { project: { key: 'XYZ' } } }] }),
  );
  await refused(
    scope.jira({ method: 'POST', path: '/search/jql', body: { jql: '' }, safe: true }),
  );
});

// --- Issues ------------------------------------------------------------------

test('CC-4002: an issue whose key prefix is out of scope is refused without a request', async () => {
  const { fake, scope } = setup();
  const error = await refused(
    scope.jira({ method: 'GET', path: '/issue/XYZ-1/comment' }),
  );
  assert.match(error.message, /JIRA_PROJECTS: ABC, DEF/);
  assert.equal(fake.calls.length, 0);
});

test('an in-scope issue key is confirmed once, then the request goes through', async () => {
  const { fake, scope } = setup();
  fake.on(
    (req) => req.path === '/issue/ABC-1' && req.query?.['fields'] === 'project',
    jiraOk({ key: 'ABC-1', fields: { project: { key: 'ABC' } } }),
  );
  fake.on('GET /rest/api/3/issue/ABC-1/comment', jiraOk({ comments: [] }));
  await scope.jira({ method: 'GET', path: '/issue/ABC-1/comment' });
  await scope.jira({ method: 'GET', path: '/issue/ABC-1/comment' });
  assert.deepEqual(fake.routes(), [
    'GET /rest/api/3/issue/ABC-1',
    'GET /rest/api/3/issue/ABC-1/comment',
    'GET /rest/api/3/issue/ABC-1/comment',
  ]);
});

test('an issue moved out of scope is refused even under its old in-scope key', async () => {
  const { fake, scope } = setup();
  fake.on(
    'GET /rest/api/3/issue/ABC-1',
    jiraOk({ key: 'XYZ-9', fields: { project: { key: 'XYZ' } } }),
  );
  await refused(scope.jira({ method: 'POST', path: '/issue/ABC-1/comment', body: {} }));
  assert.deepEqual(fake.routes(), ['GET /rest/api/3/issue/ABC-1']);
});

test('creating an issue checks the project and the parent', async () => {
  const { fake, scope } = setup();
  fake.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-2' }));
  await scope.jira({
    method: 'POST',
    path: '/issue',
    body: { fields: { project: { key: 'abc' } } },
  });
  await refused(
    scope.jira({
      method: 'POST',
      path: '/issue',
      body: { fields: { project: { key: 'XYZ' } } },
    }),
  );
  await refused(
    scope.jira({
      method: 'POST',
      path: '/issue',
      body: { fields: { project: { key: 'ABC' }, parent: { key: 'XYZ-1' } } },
    }),
  );
  assert.deepEqual(fake.routes(), ['POST /rest/api/3/issue']);
});

test('a numeric project id is resolved to its key', async () => {
  const { fake, scope } = setup('datacenter');
  fake.on('GET /rest/api/2/project/10000', jiraOk({ id: '10000', key: 'XYZ' }));
  await refused(
    scope.jira({
      method: 'POST',
      root: 'v2',
      path: '/issue',
      body: { fields: { project: { id: '10000' } } },
    }),
  );
});

test('CC-4004: bulk requests confirm every issue with one search per batch', async () => {
  const { fake, scope } = setup();
  fake.on(
    'POST /rest/api/3/search/jql',
    jiraOk({
      issues: [
        { id: '1', key: 'ABC-1', fields: { project: { key: 'ABC' } } },
        { id: '2', key: 'DEF-2', fields: { project: { key: 'DEF' } } },
      ],
    }),
  );
  fake.on('POST /rest/api/3/bulk/issues/delete', jiraOk({ taskId: 't' }));
  await scope.jira({
    method: 'POST',
    path: '/bulk/issues/delete',
    body: { selectedIssueIdsOrKeys: ['ABC-1', '2'] },
  });
  assert.equal(fake.calls[0]?.safe, true);
  assert.deepEqual(fake.calls[0]?.body, {
    jql: 'issuekey in ("ABC-1", "2")',
    fields: ['project'],
    maxResults: 100,
  });

  // A reference the search did not return is refused.
  fake.reset();
  fake.on('POST /rest/api/3/search/jql', jiraOk({ issues: [] }));
  await refused(
    scope.jira({
      method: 'POST',
      path: '/bulk/issues/fields',
      body: { selectedIssueIdsOrKeys: ['ABC-7', 'ABC-8'] },
    }),
  );
});

test('[CC-1557] the bulk issue and changelog reads confirm every issue they name', async () => {
  const { fake, scope } = setup();
  // An out-of-scope prefix is refused before anything is sent.
  await refused(
    scope.jira({
      method: 'POST',
      path: '/issue/bulkfetch',
      body: { issueIdsOrKeys: ['ABC-1', 'XYZ-2'] },
    }),
  );
  await refused(
    scope.jira({
      method: 'POST',
      path: '/changelog/bulkfetch',
      body: { issueIdsOrKeys: ['XYZ-2', 'ABC-1'] },
    }),
  );
  await refused(scope.jira({ method: 'POST', path: '/issue/bulkfetch', body: {} }));
  await refused(scope.jira({ method: 'POST', path: '/changelog/search', body: {} }));
  assert.equal(fake.calls.length, 0);

  // In-scope references are confirmed with one search, then the read goes out.
  fake.on(
    'POST /rest/api/3/search/jql',
    jiraOk({
      issues: [
        { id: '10', key: 'ABC-1', fields: { project: { key: 'ABC' } } },
        { id: '11', key: 'DEF-2', fields: { project: { key: 'DEF' } } },
      ],
    }),
  );
  fake.on('POST /rest/api/3/issue/bulkfetch', jiraOk({ issues: [] }));
  fake.on('POST /rest/api/3/changelog/bulkfetch', jiraOk({ issueChangeLogs: [] }));
  await scope.jira({
    method: 'POST',
    path: '/issue/bulkfetch',
    body: { issueIdsOrKeys: ['ABC-1', 'DEF-2'] },
  });
  await scope.jira({
    method: 'POST',
    path: '/changelog/bulkfetch',
    body: { issueIdsOrKeys: ['ABC-1', 'DEF-2'] },
  });
  assert.deepEqual(fake.routes(), [
    'POST /rest/api/3/search/jql',
    'POST /rest/api/3/issue/bulkfetch',
    'POST /rest/api/3/search/jql',
    'POST /rest/api/3/changelog/bulkfetch',
  ]);
});

test('an issue link is checked at both ends', async () => {
  const { fake, scope } = setup();
  await refused(
    scope.jira({
      method: 'POST',
      path: '/issueLink',
      body: { inwardIssue: { key: 'XYZ-1' }, outwardIssue: { key: 'ABC-1' } },
    }),
  );
  fake.on(
    'GET /rest/api/3/issueLink/5',
    jiraOk({ inwardIssue: { key: 'XYZ-1' }, outwardIssue: { key: 'ABC-1' } }),
  );
  await refused(scope.jira({ method: 'DELETE', path: '/issueLink/5' }));
});

// --- Projects, components, versions -------------------------------------------

test('CC-4005: project lists are filtered to the scope', async () => {
  const { fake, scope } = setup();
  fake.on(
    'GET /rest/api/3/project/search',
    jiraOk({ values: [{ key: 'ABC' }, { key: 'XYZ' }], total: 2 }),
  );
  const response = await scope.jira({ method: 'GET', path: '/project/search' });
  assert.deepEqual(response.data, { values: [{ key: 'ABC' }], total: 2 });

  fake.on('GET /rest/api/2/project', jiraOk([{ key: 'DEF' }, { key: 'XYZ' }]));
  const listed = await scope.jira({ method: 'GET', root: 'v2', path: '/project' });
  assert.deepEqual(listed.data, [{ key: 'DEF' }]);
});

test('project routes and create metadata check the project', async () => {
  const { scope } = setup();
  await refused(scope.jira({ method: 'GET', path: '/project/XYZ/version' }));
  await refused(scope.jira({ method: 'GET', path: '/issue/createmeta/XYZ/issuetypes' }));
});

test('CC-4002: components and versions resolve to their project', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/api/3/component/7', jiraOk({ id: '7', project: 'XYZ' }));
  await refused(scope.jira({ method: 'DELETE', path: '/component/7' }));
  fake.on('GET /rest/api/3/version/8', jiraOk({ id: '8', projectId: 10000 }));
  fake.on('GET /rest/api/3/project/10000', jiraOk({ key: 'ABC' }));
  fake.on('PUT /rest/api/3/version/8', jiraOk({ id: '8' }));
  await scope.jira({ method: 'PUT', path: '/version/8', body: { name: 'v' } });
  await refused(
    scope.jira({ method: 'POST', path: '/version', body: { project: 'XYZ', name: 'v' } }),
  );
});

// --- Agile -------------------------------------------------------------------

test('boards are filtered and checked by their location project', async () => {
  const { fake, scope } = setup();
  fake.on(
    (req) => req.root === 'agile' && req.path === '/board',
    jiraOk({
      values: [
        { id: 1, location: { projectKey: 'ABC' } },
        { id: 2, location: { projectKey: 'XYZ' } },
        { id: 3 },
      ],
    }),
  );
  const listed = await scope.jira({ method: 'GET', root: 'agile', path: '/board' });
  assert.deepEqual(listed.data, { values: [{ id: 1, location: { projectKey: 'ABC' } }] });

  fake.on(
    'GET /rest/agile/1.0/board/2',
    jiraOk({ id: 2, location: { projectKey: 'XYZ' } }),
  );
  await refused(
    scope.jira({ method: 'GET', root: 'agile', path: '/board/2/configuration' }),
  );
});

test('sprint issue lists get the project clause added to their JQL', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/agile/1.0/sprint/9/issue', jiraOk({ issues: [] }));
  fake.on('GET /rest/agile/1.0/sprint/9', jiraOk({ id: 9, originBoardId: 1 }));
  fake.on(
    'GET /rest/agile/1.0/board/1',
    jiraOk({ id: 1, location: { projectKey: 'ABC' } }),
  );
  await scope.jira({
    method: 'GET',
    root: 'agile',
    path: '/sprint/9/issue',
    query: { fields: 'summary' },
  });
  assert.deepEqual(fake.lastRequest()?.query, { fields: 'summary', jql: CLAUSE });
});

test('CC-5007: Cloud sprint issue and backlog reads on the software root get the project clause', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/software/1.0/sprint/9/issue', jiraOk({ issues: [] }));
  fake.on('GET /rest/software/1.0/board/1/backlog', jiraOk({ issues: [] }));
  fake.on('GET /rest/agile/1.0/sprint/9', jiraOk({ id: 9, originBoardId: 1 }));
  fake.on(
    'GET /rest/agile/1.0/board/1',
    jiraOk({ id: 1, location: { projectKey: 'ABC' } }),
  );
  await scope.jira({
    method: 'GET',
    root: 'software',
    path: '/sprint/9/issue',
    query: { fields: 'summary' },
  });
  assert.deepEqual(fake.lastRequest()?.query, { fields: 'summary', jql: CLAUSE });
  await scope.jira({
    method: 'GET',
    root: 'software',
    path: '/board/1/backlog',
    query: { fields: 'summary' },
  });
  assert.deepEqual(fake.lastRequest()?.query, { fields: 'summary', jql: CLAUSE });
});

test('CC-5007: the software root refuses an out-of-scope board and any route but the issue reads', async () => {
  const { fake, scope } = setup();
  fake.on(
    'GET /rest/agile/1.0/board/2',
    jiraOk({ id: 2, location: { projectKey: 'XYZ' } }),
  );
  await refused(
    scope.jira({ method: 'GET', root: 'software', path: '/board/2/backlog' }),
  );
  await refused(scope.jira({ method: 'GET', root: 'software', path: '/board/1' }));
  await refused(
    scope.jira({ method: 'POST', root: 'software', path: '/sprint/9/issue', body: {} }),
  );
});

test('rank checks every issue and both anchors', async () => {
  const { scope } = setup();
  await refused(
    scope.jira({
      method: 'PUT',
      root: 'agile',
      path: '/issue/rank',
      body: { issues: ['ABC-1'], rankBeforeIssue: 'XYZ-1' },
    }),
  );
});

// --- Global routes and fail-closed ----------------------------------------------

test('CC-4005: global metadata passes untouched', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/api/3/field', jiraOk([]));
  fake.on('GET /rest/api/3/myself', jiraOk({ accountId: 'a' }));
  await scope.jira({ method: 'GET', path: '/field' });
  await scope.jira({ method: 'GET', path: '/myself' });
  assert.equal(fake.calls.length, 2);
});

test('permission and assignable-user queries are checked when they name a scope', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/api/3/mypermissions', jiraOk({ permissions: {} }));
  await scope.jira({
    method: 'GET',
    path: '/mypermissions',
    query: { permissions: 'BROWSE_PROJECTS' },
  });
  await refused(
    scope.jira({ method: 'GET', path: '/mypermissions', query: { projectKey: 'XYZ' } }),
  );
  await refused(
    scope.jira({
      method: 'GET',
      path: '/user/assignable/search',
      query: { issueKey: 'XYZ-1' },
    }),
  );
});

test('CC-4006: attachments by id and unknown routes are refused', async () => {
  const { fake, scope } = setup('datacenter');
  await refused(scope.jira({ method: 'GET', root: 'v2', path: '/attachment/10001' }));
  await refused(
    scope.jira({ method: 'GET', root: 'secure', path: '/attachment/10001/a.txt' }),
  );
  await refused(scope.jira({ method: 'GET', path: '/workflow/search' }));
  await refused(scope.jira({ method: 'GET', root: 'agile', path: '/epic/1' }));
  assert.equal(fake.calls.length, 0);
});

test('check admits without sending and resolves through the triggering profile', async () => {
  const { fake, scope } = setup();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ fields: { project: { key: 'ABC' } } }));
  await scope.check({ method: 'PUT', path: '/issue/ABC-1', body: {}, profile: 'work' });
  assert.deepEqual(fake.routes(), ['GET /rest/api/3/issue/ABC-1']);
  assert.equal(fake.calls[0]?.profile, 'work');
  await refused(scope.check({ method: 'DELETE', path: '/issue/XYZ-1' }));
});
