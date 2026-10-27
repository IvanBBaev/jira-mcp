// Tests for `api/issues.ts` (WP-21) — contract tier (TESTING.md §Mocking tiers).
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads (`/issue/{key}`, `/comment`, `/transitions`, `/worklog`,
// `/changelog`) and marked `// synthetic`; the recorded fixtures that replace
// them land in WP-41, and `fake.fixture(...)` is already the hook. Placeholder
// vocabulary is TESTING.md's: `example.atlassian.net`,
// `5b10a2844c20165700ede21g`-style accountIds, `user-1@example.invalid`.
//
// Two things every write test asserts, because they are the rules that cannot be
// caught by reading the code once: the exact BODY Jira receives, and the ABSENCE
// of the `safe` flag — an unsafe write must never be replayed (JIRA-API.md
// §Rate limiting and retries).
//
// The fake throws on a route nobody programmed, so "no second request happened"
// is asserted by construction rather than by counting.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJiraError, errorFromResponse } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError, type JiraRequestSpec } from '../core/types.js';
import {
  AMBIGUOUS_TRANSITION,
  DEFAULT_COMMENT_ORDER_BY,
  ISSUE_ASSIGNEE_PATH_TEMPLATE,
  CHANGELOG_BULKFETCH_PATH,
  ISSUE_BULKFETCH_PATH,
  MAX_BULK_CHANGELOG_ISSUES,
  MAX_BULK_CHANGELOG_RESULTS,
  MAX_BULK_ISSUES,
  MAX_PAGE_SIZE,
  MAX_SHAPE_DEPTH,
  ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  ISSUE_COMMENT_PATH_TEMPLATE,
  ISSUE_LINK_ITEM_PATH_TEMPLATE,
  ISSUE_LINK_PATH,
  ISSUE_PATH_TEMPLATE,
  ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE,
  ISSUE_REMOTE_LINK_PATH_TEMPLATE,
  ISSUE_TRANSITIONS_PATH_TEMPLATE,
  ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  ISSUE_WORKLOG_PATH_TEMPLATE,
  addComment,
  addRemoteLink,
  addRemoteLinkRequest,
  addWorklog,
  assignIssue,
  createIssue,
  deleteComment,
  deleteCommentRequest,
  deleteIssue,
  deleteIssueLink,
  deleteIssueLinkRequest,
  deleteIssueRequest,
  deleteRemoteLink,
  deleteRemoteLinkRequest,
  deleteWorklog,
  deleteWorklogRequest,
  formatJiraTimestamp,
  getComment,
  getIssue,
  getIssueLink,
  getChangelogsBulk,
  getIssuesBulk,
  getRemoteLink,
  getWorklog,
  linkIssues,
  listChangelog,
  listComments,
  listRemoteLinks,
  listTransitions,
  listWorklogs,
  resolveTransitionId,
  shapeIssueFields,
  shapeUser,
  startedInstant,
  transitionIssue,
  updateComment,
  updateCommentRequest,
  updateIssue,
  updateWorklog,
  updateWorklogRequest,
  utcOffsetMinutesForZone,
  type IssueLink,
} from './issues.js';

const KEY = 'PROJ-1';
const ISSUE_ROUTE = `GET /rest/api/3/issue/${KEY}`;
const ACCOUNT_ID = '5b10a2844c20165700ede21g';
const OTHER_ACCOUNT_ID = '712020:2f0c1e6d-9a4b-4f1d-8f7a-6d3b0c9a1e22';

/** 2026-08-07T10:00:00.000Z — the instant every worklog test logs against. */
const STARTED_AT = Date.UTC(2026, 7, 7, 10, 0, 0);

/** An ADF document as Jira stores a one-paragraph description. // synthetic */
function adfDoc(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A user object as Jira embeds it — email and avatars included. // synthetic */
function wireUser(accountId: string, displayName: string): Record<string, unknown> {
  return {
    self: `https://example.atlassian.net/rest/api/3/user?accountId=${accountId}`,
    accountId,
    accountType: 'atlassian',
    emailAddress: 'user-1@example.invalid',
    avatarUrls: { '48x48': 'https://example.atlassian.net/avatar/48' },
    displayName,
    active: true,
    timeZone: 'Asia/Kolkata',
  };
}

function isJiraErrorOfKind(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

/** Every write must reach `core/http.ts` WITHOUT the replay opt-in. */
function assertNeverSafe(calls: readonly JiraRequestSpec[]): void {
  for (const call of calls) {
    assert.equal(call.safe, undefined, `${call.method} ${call.path} must not be safe`);
  }
}

// ---------------------------------------------------------------------------
// getIssue — read shaping
// ---------------------------------------------------------------------------

/**
 * The one fixture TOOLS.md §Read shaping demands: `issuelinks`, `fixVersions`
 * and `expand=changelog` in a SINGLE response, because each of them is a
 * different failure mode (restated relation, preserved structure, expanded
 * payload) and they have to survive together. // synthetic
 */
function issueWithEverything(): Record<string, unknown> {
  return {
    id: '10001',
    key: KEY,
    self: `https://example.atlassian.net/rest/api/3/issue/10001`,
    fields: {
      summary: 'Ship the issues surface',
      description: adfDoc('Port the read and write paths.'),
      assignee: wireUser(ACCOUNT_ID, 'User One'),
      reporter: wireUser(OTHER_ACCOUNT_ID, 'User Two'),
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      fixVersions: [
        { id: '10100', name: '2026.8', released: false, archived: false },
        { id: '10101', name: '2026.9', released: false, archived: false },
      ],
      components: [{ id: '10200', name: 'api' }],
      parent: {
        id: '10000',
        key: 'PROJ-0',
        fields: { summary: 'Epic: Jira MCP', status: { name: 'To Do' } },
      },
      issuelinks: [
        {
          id: '20001',
          type: {
            id: '10003',
            name: 'Blocks',
            inward: 'is blocked by',
            outward: 'blocks',
          },
          outwardIssue: {
            id: '10002',
            key: 'PROJ-2',
            fields: {
              summary: 'Tool ring',
              status: { name: 'To Do' },
              issuetype: { name: 'Task' },
              priority: { name: 'High' },
            },
          },
        },
        {
          id: '20002',
          type: {
            id: '10003',
            name: 'Blocks',
            inward: 'is blocked by',
            outward: 'blocks',
          },
          inwardIssue: {
            id: '10003',
            key: 'PROJ-3',
            fields: { summary: 'Core http', status: { name: 'Done' } },
          },
        },
      ],
      customfield_10011: 'Epic name passes through untouched',
    },
    changelog: {
      startAt: 0,
      maxResults: 2,
      total: 2,
      histories: [
        {
          id: '30001',
          author: wireUser(ACCOUNT_ID, 'User One'),
          created: '2026-08-01T09:00:00.000+0000',
          items: [
            {
              field: 'status',
              fieldtype: 'jira',
              from: '1',
              fromString: 'To Do',
              to: '3',
              toString: 'In Progress',
            },
          ],
        },
      ],
    },
  };
}

test('getIssue shapes links, versions and an expanded changelog in one read', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueWithEverything()));

  const issue = await getIssue({
    jira: fake.fn,
    issue: KEY,
    fields: ['summary', 'description', ' ', 'issuelinks'],
    expand: ['changelog'],
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'GET');
  assert.equal(request?.path, `/issue/${KEY}`);
  assert.equal(request?.pathTemplate, ISSUE_PATH_TEMPLATE);
  // Blank entries are dropped, order is kept, and the list travels as CSV.
  assert.equal(request?.query?.fields, 'summary,description,issuelinks');
  assert.equal(request?.query?.expand, 'changelog');

  assert.equal(issue.id, '10001');
  assert.equal(issue.key, KEY);
  assert.deepEqual(issue.expand, ['changelog']);

  // ADF flattened, structures preserved, custom field untouched.
  assert.equal(issue.fields.description, 'Port the read and write paths.');
  assert.deepEqual(issue.fields.fixVersions, [
    { id: '10100', name: '2026.8', released: false, archived: false },
    { id: '10101', name: '2026.9', released: false, archived: false },
  ]);
  assert.deepEqual(issue.fields.components, [{ id: '10200', name: 'api' }]);
  assert.equal(issue.fields.customfield_10011, 'Epic name passes through untouched');

  // Users collapse to accountId/displayName/active — no email, no avatars.
  assert.deepEqual(issue.fields.assignee, {
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
  });

  assert.deepEqual(issue.fields.parent, {
    id: '10000',
    key: 'PROJ-0',
    summary: 'Epic: Jira MCP',
    status: 'To Do',
  });

  // The relation is restated from THIS issue's side: outward → "blocks".
  const links = issue.fields.issuelinks as readonly IssueLink[];
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], {
    id: '20001',
    type: { id: '10003', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    direction: 'outward',
    relation: 'blocks',
    issue: {
      id: '10002',
      key: 'PROJ-2',
      summary: 'Tool ring',
      status: 'To Do',
      issueType: 'Task',
      priority: 'High',
    },
  });
  assert.equal(links[1]?.direction, 'inward');
  assert.equal(links[1]?.relation, 'is blocked by');
  assert.equal(links[1]?.issue.key, 'PROJ-3');

  // The expanded payload keeps Jira's own item vocabulary, author projected.
  assert.equal(issue.changelog?.total, 2);
  assert.deepEqual(issue.changelog?.histories[0]?.author, {
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
  });
  assert.deepEqual(issue.changelog?.histories[0]?.items[0], {
    field: 'status',
    fieldtype: 'jira',
    from: '1',
    fromString: 'To Do',
    to: '3',
    toString: 'In Progress',
  });
});

test('getIssue with raw: true returns the ADF tree instead of text', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueWithEverything()));

  const issue = await getIssue({ jira: fake.fn, issue: KEY, raw: true });

  assert.equal(issue.raw, true);
  assert.deepEqual(issue.fields.description, adfDoc('Port the read and write paths.'));
});

test('getIssue accepts an expand string and omits empty query parameters', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueWithEverything()));

  await getIssue({
    jira: fake.fn,
    issue: ` ${KEY} `,
    expand: 'changelog, renderedFields',
  });

  const request = fake.lastRequest();
  assert.equal(request?.path, `/issue/${KEY}`);
  assert.equal(request?.query?.expand, 'changelog,renderedFields');
  assert.equal(request?.query?.fields, undefined);
  assert.equal(request?.query?.properties, undefined);
});

test('[CC-134] getIssue returns the other expand sections under expanded, users projected', async () => {
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraOk({
      ...issueWithEverything(),
      expand: 'renderedFields,names',
      renderedFields: { description: '<p>Port the read and write paths.</p>' },
      names: { summary: 'Summary' },
      versionedRepresentations: {
        assignee: {
          '1': { ...wireUser(ACCOUNT_ID, 'User One'), emailAddress: 'u1@example.com' },
        },
      },
    }),
  );

  const issue = await getIssue({ jira: fake.fn, issue: KEY, expand: ['renderedFields'] });

  assert.deepEqual(issue.expanded?.['renderedFields'], {
    description: '<p>Port the read and write paths.</p>',
  });
  assert.deepEqual(issue.expanded?.['names'], { summary: 'Summary' });
  assert.ok(!JSON.stringify(issue).includes('u1@example.com'));
  // The envelope keys are restated, never duplicated under expanded.
  for (const key of ['id', 'key', 'self', 'expand', 'fields', 'changelog']) {
    assert.equal(issue.expanded?.[key], undefined, key);
  }
});

test('getIssue omits expanded when the response carried no extra section', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueWithEverything()));
  const issue = await getIssue({ jira: fake.fn, issue: KEY });
  assert.equal('expanded' in issue, false);
});

test('getIssue refuses an issue key that would escape its path segment', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    getIssue({ jira: fake.fn, issue: '../../admin' }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    getIssue({ jira: fake.fn, issue: '   ' }),
    isJiraErrorOfKind('validation'),
  );
  // Nothing reached the network: a rejected key never becomes a URL.
  assert.equal(fake.calls.length, 0);
});

test('getIssue reports an unreadable body as unexpected_shape', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk([1, 2, 3]));

  await assert.rejects(
    getIssue({ jira: fake.fn, issue: KEY }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('CC-16: a 404 keeps the "not found OR no permission" wording', async () => {
  // Jira answers 404 for an issue this account may not see, not 403. // synthetic
  const notFound = errorFromResponse({
    status: 404,
    body: {
      errorMessages: ['Issue does not exist or you do not have permission to see it.'],
      errors: {},
    },
    method: 'GET',
    pathTemplate: ISSUE_PATH_TEMPLATE,
  });
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraErr(notFound));

  await assert.rejects(getIssue({ jira: fake.fn, issue: KEY }), (error: unknown) => {
    assert.ok(error instanceof JiraError);
    assert.equal(error.kind, 'not_found');
    assert.equal(error.httpStatus, 404);
    // The permission alternative must survive the api ring untouched.
    assert.match(error.message, /permission/i);
    assert.deepEqual(error.jiraMessages, [
      'Issue does not exist or you do not have permission to see it.',
    ]);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Comments, worklogs, changelog, transitions
// ---------------------------------------------------------------------------

/** `GET /issue/{key}/comment` page. // synthetic */
function commentPage(startAt: number, ids: readonly string[]): Record<string, unknown> {
  return {
    startAt,
    maxResults: 2,
    total: 5,
    comments: ids.map((id) => ({
      self: `https://example.atlassian.net/rest/api/3/issue/10001/comment/${id}`,
      id,
      author: wireUser(ACCOUNT_ID, 'User One'),
      body: adfDoc(`Comment ${id}`),
      updateAuthor: wireUser(ACCOUNT_ID, 'User One'),
      created: '2026-08-05T08:00:00.000+0000',
      updated: '2026-08-05T08:00:00.000+0000',
      jsdPublic: true,
    })),
  };
}

test('listComments reads one page by default and reports where to resume', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment`,
    jiraOk(commentPage(0, ['1', '2'])),
  );

  const result = await listComments({ jira: fake.fn, issue: KEY, maxResults: 2 });

  const request = fake.lastRequest();
  assert.equal(request?.pathTemplate, ISSUE_COMMENT_PATH_TEMPLATE);
  assert.equal(request?.path, `/issue/${KEY}/comment`);
  assert.equal(request?.query?.startAt, 0);
  assert.equal(request?.query?.maxResults, 2);
  // Newest first is the tool default, not Jira's.
  assert.equal(request?.query?.orderBy, DEFAULT_COMMENT_ORDER_BY);

  assert.equal(result.orderBy, '-created');
  assert.equal(result.comments.length, 2);
  assert.deepEqual(result.comments[0], {
    id: '1',
    author: { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
    updateAuthor: { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
    body: 'Comment 1',
    created: '2026-08-05T08:00:00.000+0000',
    updated: '2026-08-05T08:00:00.000+0000',
    jsdPublic: true,
  });
  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.total, 5);
  assert.equal(result.nextStartAt, 2);
});

test('listComments walks classic pages up to maxPages', async () => {
  const fake = createFakeJiraRequest()
    .on(
      (req) => req.path.endsWith('/comment') && req.query?.startAt === 0,
      jiraOk(commentPage(0, ['1', '2'])),
    )
    .on(
      (req) => req.path.endsWith('/comment') && req.query?.startAt === 2,
      jiraOk(commentPage(2, ['3', '4'])),
    );

  const result = await listComments({
    jira: fake.fn,
    issue: KEY,
    maxResults: 2,
    maxPages: 2,
    orderBy: 'created',
  });

  assert.deepEqual(
    result.comments.map((comment) => comment.id),
    ['1', '2', '3', '4'],
  );
  assert.equal(result.pages, 2);
  assert.equal(result.partial, true);
  assert.equal(result.nextStartAt, 4);
  assert.equal(fake.lastRequest()?.query?.orderBy, 'created');
});

test('[CC-161] listComments counts an unmappable row toward the offset', async () => {
  // Page one carries a row with no id: it is dropped from the output, but it is
  // still one of the server's two rows, so the page is full and the next offset
  // is 2 — not 1, which would re-read comment 2.
  const first = commentPage(0, ['1', '2']);
  (first.comments as Array<Record<string, unknown>>)[0] = { self: 'x' };
  const fake = createFakeJiraRequest()
    .on((req) => req.path.endsWith('/comment') && req.query?.startAt === 0, jiraOk(first))
    .on(
      (req) => req.path.endsWith('/comment') && req.query?.startAt === 2,
      jiraOk(commentPage(2, ['3', '4'])),
    );

  const result = await listComments({
    jira: fake.fn,
    issue: KEY,
    maxResults: 2,
    maxPages: 2,
  });

  assert.deepEqual(
    result.comments.map((comment) => comment.id),
    ['2', '3', '4'],
  );
  assert.equal(result.pages, 2);
  assert.equal(result.nextStartAt, 4);
});

test('listWorklogs flattens the worklog comment and projects the author', async () => {
  // `GET /issue/{key}/worklog` — classic paging, isLast absent. // synthetic
  const body = {
    startAt: 0,
    maxResults: 50,
    total: 1,
    worklogs: [
      {
        self: 'https://example.atlassian.net/rest/api/3/issue/10001/worklog/40001',
        id: '40001',
        issueId: '10001',
        author: wireUser(ACCOUNT_ID, 'User One'),
        comment: adfDoc('Paired on the retry policy.'),
        created: '2026-08-07T15:31:00.000+0530',
        updated: '2026-08-07T15:31:00.000+0530',
        started: '2026-08-07T15:30:00.000+0530',
        timeSpent: '2h 30m',
        timeSpentSeconds: 9000,
      },
    ],
  };
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/worklog`,
    jiraOk(body),
  );

  const result = await listWorklogs({ jira: fake.fn, issue: KEY });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_WORKLOG_PATH_TEMPLATE);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextStartAt, undefined);
  assert.deepEqual(result.worklogs[0], {
    id: '40001',
    issueId: '10001',
    author: { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
    comment: 'Paired on the retry policy.',
    started: '2026-08-07T15:30:00.000+0530',
    timeSpent: '2h 30m',
    timeSpentSeconds: 9000,
    created: '2026-08-07T15:31:00.000+0530',
    updated: '2026-08-07T15:31:00.000+0530',
  });
});

test('listChangelog keeps Jira order and passes items through verbatim', async () => {
  // `GET /issue/{key}/changelog` — the `values`/`isLast` classic page. // synthetic
  const body = {
    startAt: 0,
    maxResults: 100,
    total: 2,
    isLast: true,
    values: [
      {
        id: '30001',
        author: wireUser(ACCOUNT_ID, 'User One'),
        created: '2026-08-01T09:00:00.000+0000',
        items: [
          { field: 'summary', fieldtype: 'jira', fromString: 'Old', toString: 'New' },
        ],
      },
      {
        id: '30002',
        author: wireUser(OTHER_ACCOUNT_ID, 'User Two'),
        created: '2026-08-02T09:00:00.000+0000',
        items: [
          {
            field: 'assignee',
            fieldtype: 'jira',
            from: null,
            fromString: null,
            to: ACCOUNT_ID,
            toString: 'User One',
          },
        ],
      },
    ],
  };
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/changelog`,
    jiraOk(body),
  );

  const result = await listChangelog({ jira: fake.fn, issue: KEY });

  assert.deepEqual(
    result.histories.map((entry) => entry.id),
    ['30001', '30002'],
  );
  assert.equal(result.stopReason, 'exhausted');
  assert.deepEqual(result.histories[1]?.items[0], {
    field: 'assignee',
    fieldtype: 'jira',
    from: null,
    fromString: null,
    to: ACCOUNT_ID,
    toString: 'User One',
  });
  assert.deepEqual(result.histories[1]?.author, {
    accountId: OTHER_ACCOUNT_ID,
    displayName: 'User Two',
    active: true,
  });
});

/** `GET /issue/{key}/transitions`. // synthetic */
const TRANSITIONS_BODY = {
  expand: 'transitions',
  transitions: [
    {
      id: '11',
      name: 'To Do',
      to: { id: '1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
      hasScreen: false,
      isAvailable: true,
      isGlobal: false,
      isInitial: true,
      isConditional: false,
      looped: false,
    },
    {
      id: '31',
      name: 'Done',
      to: { id: '3', name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
      hasScreen: true,
      isAvailable: true,
      fields: { resolution: { required: true, name: 'Resolution' } },
    },
  ],
};

test('listTransitions shapes the workflow options and can ask for the screen', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/transitions`,
    jiraOk(TRANSITIONS_BODY),
  );

  const result = await listTransitions({ jira: fake.fn, issue: KEY, expandFields: true });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_TRANSITIONS_PATH_TEMPLATE);
  assert.equal(fake.lastRequest()?.query?.expand, 'transitions.fields');
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(result.transitions[0], {
    id: '11',
    name: 'To Do',
    to: { id: '1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
    hasScreen: false,
    isAvailable: true,
    isGlobal: false,
    isInitial: true,
    isConditional: false,
    looped: false,
  });
  assert.deepEqual(result.transitions[1]?.fields, {
    resolution: { required: true, name: 'Resolution' },
  });
});

test('CC-21: resolveTransitionId matches by id or name and names the alternatives', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/transitions`,
    jiraOk(TRANSITIONS_BODY),
  );
  const { transitions } = await listTransitions({ jira: fake.fn, issue: KEY });

  assert.equal(resolveTransitionId(transitions, '31'), '31');
  assert.equal(resolveTransitionId(transitions, 'done'), '31');

  assert.throws(
    () => resolveTransitionId(transitions, 'Close'),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      // An invented transition is answered with the real catalogue.
      assert.match(error.message, /11 \(To Do\), 31 \(Done\)/);
      return true;
    },
  );
});

test('[CC-428] a transition name two transitions share is refused, not guessed', () => {
  const transitions = [
    { id: '41', name: 'Close', to: { name: "Won't Do" } },
    { id: '51', name: 'Close', to: { name: 'Closed' } },
    { id: '7', name: 'Reopen', to: { name: 'Open' } },
    { id: '9', name: 'REOPEN', to: { name: 'Reopened' } },
  ];

  assert.throws(
    () => resolveTransitionId(transitions, 'close'),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.ok(error.reason?.startsWith(AMBIGUOUS_TRANSITION));
      assert.match(error.message, /41 \(Close -> Won't Do\), 51 \(Close -> Closed\)/);
      return true;
    },
  );
  // The exact spelling picks one of two names that only differ in case.
  assert.equal(resolveTransitionId(transitions, 'REOPEN'), '9');
  assert.equal(resolveTransitionId(transitions, 'Reopen'), '7');
  assert.throws(() => resolveTransitionId(transitions, 'reopen'), JiraError);
  assert.equal(resolveTransitionId(transitions, '51'), '51');
});

test('CC-21: resolveTransitionId says "unnamed" and "none" rather than printing holes', () => {
  assert.throws(
    () => resolveTransitionId([{ id: '31' }], 'Done'),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.match(error.message, /Available now: 31 \(unnamed\)\./);
      return true;
    },
  );
  assert.throws(
    () => resolveTransitionId([], 'Done'),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.match(error.message, /Available now: none\./);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test('createIssue sends v3 fields with an ADF description and no safe flag', async () => {
  // `POST /rest/api/3/issue` answers with the identifiers only. // synthetic
  const fake = createFakeJiraRequest().on(
    'POST /rest/api/3/issue',
    jiraOk(
      {
        id: '10010',
        key: 'PROJ-10',
        self: 'https://example.atlassian.net/rest/api/3/issue/10010',
      },
      { status: 201 },
    ),
  );

  const created = await createIssue({
    jira: fake.fn,
    project: 'PROJ',
    issueType: 'Task',
    summary: 'Wire the issues package',
    description: 'Read and write, one module.',
    assigneeAccountId: ACCOUNT_ID,
    priority: 'High',
    labels: ['mcp', 'api'],
    parent: 'PROJ-0',
    fields: { customfield_10011: 'Jira MCP' },
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.path, '/issue');
  assert.deepEqual(request?.body, {
    fields: {
      project: { key: 'PROJ' },
      issuetype: { name: 'Task' },
      summary: 'Wire the issues package',
      description: adfDoc('Read and write, one module.'),
      assignee: { accountId: ACCOUNT_ID },
      priority: { name: 'High' },
      labels: ['mcp', 'api'],
      parent: { key: 'PROJ-0' },
      customfield_10011: 'Jira MCP',
    },
  });
  assertNeverSafe(fake.calls);
  assert.deepEqual(created, {
    id: '10010',
    key: 'PROJ-10',
    self: 'https://example.atlassian.net/rest/api/3/issue/10010',
  });
});

test('createIssue takes numeric ids as ids, not names', async () => {
  const fake = createFakeJiraRequest().on(
    'POST /rest/api/3/issue',
    jiraOk({ id: '10011', key: 'PROJ-11' }, { status: 201 }),
  );

  await createIssue({
    jira: fake.fn,
    project: '10000',
    issueType: '10002',
    summary: 'Numeric references',
    dueDate: '2026-10-01',
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    fields: {
      project: { id: '10000' },
      issuetype: { id: '10002' },
      summary: 'Numeric references',
      duedate: '2026-10-01',
    },
  });
});

test('createIssue refuses a field set twice and an empty summary', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    createIssue({
      jira: fake.fn,
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Duplicated',
      labels: ['one'],
      fields: { labels: ['two'] },
    }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    createIssue({ jira: fake.fn, project: 'PROJ', issueType: 'Task', summary: '  ' }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

test('CC-24: an unknown custom field keeps Jira’s field-level 400 verbatim', async () => {
  // Jira names the offending field in `errors`, keyed by field id. // synthetic
  const rejected = errorFromResponse({
    status: 400,
    body: {
      errorMessages: [],
      errors: {
        customfield_10999:
          "Field 'customfield_10999' cannot be set. It is not on the appropriate screen, or unknown.",
      },
    },
    method: 'POST',
    pathTemplate: '/issue',
  });
  const fake = createFakeJiraRequest().on('POST /rest/api/3/issue', jiraErr(rejected));

  await assert.rejects(
    createIssue({
      jira: fake.fn,
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Bad field',
      fields: { customfield_10999: 'nope' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.equal(error.httpStatus, 400);
      assert.deepEqual(error.jiraMessages, [
        "customfield_10999: Field 'customfield_10999' cannot be set. It is not on the appropriate screen, or unknown.",
      ]);
      // The remediation still points at the discovery tools, unrewritten.
      assert.match(error.message, /jira_get_create_meta|jira_list_fields/);
      return true;
    },
  );
});

test('updateIssue splits incremental labels into Jira update verbs', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}`,
    jiraOk(undefined, { status: 204 }),
  );

  const result = await updateIssue({
    jira: fake.fn,
    issue: KEY,
    summary: 'Renamed',
    labelsAdd: ['triaged'],
    labelsRemove: ['needs-triage'],
    notifyUsers: false,
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'PUT');
  assert.equal(request?.path, `/issue/${KEY}`);
  assert.equal(request?.pathTemplate, ISSUE_PATH_TEMPLATE);
  assert.equal(request?.query?.notifyUsers, false);
  assert.deepEqual(request?.body, {
    fields: { summary: 'Renamed' },
    update: { labels: [{ add: 'triaged' }, { remove: 'needs-triage' }] },
  });
  assertNeverSafe(fake.calls);
  assert.deepEqual(result, { issue: KEY, updated: true, notifyUsers: false });
});

test('updateIssue clears fields with an explicit null', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}`,
    jiraOk(undefined, { status: 204 }),
  );

  await updateIssue({
    jira: fake.fn,
    issue: KEY,
    description: null,
    assigneeAccountId: null,
    parent: null,
    dueDate: '2026-09-01',
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    fields: { description: null, assignee: null, parent: null, duedate: '2026-09-01' },
  });
});

test('updateIssue replaces description, assignee, labels and parent, and clears a due date', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}`,
    jiraOk(undefined, { status: 204 }),
  );

  await updateIssue({
    jira: fake.fn,
    issue: KEY,
    description: 'Rewritten wholesale.',
    assigneeAccountId: ACCOUNT_ID,
    labels: ['mcp', 'api'],
    parent: '10000',
    dueDate: null,
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    fields: {
      description: adfDoc('Rewritten wholesale.'),
      assignee: { accountId: ACCOUNT_ID },
      labels: ['mcp', 'api'],
      parent: { id: '10000' },
      duedate: null,
    },
  });

  // Label verbs alone: the body carries `update` and no empty `fields` block.
  await updateIssue({ jira: fake.fn, issue: KEY, labelsAdd: ['triaged'] });
  assert.deepEqual(fake.lastRequest()?.body, {
    update: { labels: [{ add: 'triaged' }] },
  });
});

test('updateIssue refuses a no-op and refuses replacing and editing labels at once', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    updateIssue({ jira: fake.fn, issue: KEY }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    updateIssue({ jira: fake.fn, issue: KEY, labels: ['a'], labelsAdd: ['b'] }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

test('[CC-162] a raw fields.labels conflicts with labelsAdd/labelsRemove like named labels does', async () => {
  const fake = createFakeJiraRequest();
  await assert.rejects(
    updateIssue({
      jira: fake.fn,
      issue: KEY,
      fields: { labels: ['a'] },
      labelsAdd: ['b'],
    }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    updateIssue({
      jira: fake.fn,
      issue: KEY,
      fields: { labels: ['a'] },
      labelsRemove: ['b'],
    }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

test('[CC-492] a label named in both labelsAdd and labelsRemove is refused, not sent as a silent remove', async () => {
  const fake = createFakeJiraRequest();
  await assert.rejects(
    updateIssue({
      jira: fake.fn,
      issue: KEY,
      labelsAdd: ['keep', ' both '],
      labelsRemove: ['both', 'drop'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.match(error.message, /"both"/);
      assert.doesNotMatch(error.message, /"keep"|"drop"/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test('transitionIssue posts the transition with screen fields and a comment', async () => {
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/transitions`,
    jiraOk(undefined, { status: 204 }),
  );

  const result = await transitionIssue({
    jira: fake.fn,
    issue: KEY,
    transitionId: '31',
    resolution: 'Done',
    comment: 'Shipped.',
  });

  const request = fake.lastRequest();
  assert.equal(request?.pathTemplate, ISSUE_TRANSITIONS_PATH_TEMPLATE);
  assert.deepEqual(request?.body, {
    transition: { id: '31' },
    fields: { resolution: { name: 'Done' } },
    update: { comment: [{ add: { body: adfDoc('Shipped.') } }] },
  });
  assertNeverSafe(fake.calls);
  assert.deepEqual(result, { issue: KEY, transitionId: '31', transitioned: true });
});

test('CC-21: a rejected transition id is re-aimed at re-fetching the transitions', async () => {
  // The workflow moved between the GET and the POST. // synthetic
  const stale = errorFromResponse({
    status: 400,
    body: {
      errorMessages: ['Transition id 31 is not valid for issue PROJ-1.'],
      errors: {},
    },
    method: 'POST',
    pathTemplate: ISSUE_TRANSITIONS_PATH_TEMPLATE,
  });
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/transitions`,
    jiraErr(stale),
  );

  await assert.rejects(
    transitionIssue({ jira: fake.fn, issue: KEY, transitionId: '31' }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.equal(error.httpStatus, 400);
      // Jira's own words survive, and the advice is now actionable.
      assert.deepEqual(error.jiraMessages, [
        'Transition id 31 is not valid for issue PROJ-1.',
      ]);
      assert.match(error.message, /Transition id 31 is not valid/);
      assert.match(error.message, /jira_get_transitions/);
      return true;
    },
  );
});

test('addComment converts text to ADF and carries visibility', async () => {
  // `POST /issue/{key}/comment` echoes the stored comment. // synthetic
  const stored = {
    id: '50001',
    author: wireUser(ACCOUNT_ID, 'User One'),
    body: adfDoc('Looks good.'),
    created: '2026-08-09T12:00:00.000+0000',
    visibility: { type: 'role', value: 'Administrators', identifier: '10002' },
  };
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/comment`,
    jiraOk(stored, { status: 201 }),
  );

  const comment = await addComment({
    jira: fake.fn,
    issue: KEY,
    body: 'Looks good.',
    visibility: { type: 'role', value: 'Administrators' },
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.pathTemplate, ISSUE_COMMENT_PATH_TEMPLATE);
  assert.deepEqual(request?.body, {
    body: adfDoc('Looks good.'),
    visibility: { type: 'role', value: 'Administrators' },
  });
  assertNeverSafe(fake.calls);
  assert.equal(comment.body, 'Looks good.');
  assert.deepEqual(comment.visibility, {
    type: 'role',
    value: 'Administrators',
    identifier: '10002',
  });
});

test('updateComment PUTs the edited body to the comment itself', async () => {
  // `PUT /issue/{key}/comment/{id}` echoes the stored comment. // synthetic
  const stored = {
    id: '50001',
    author: wireUser(ACCOUNT_ID, 'User One'),
    updateAuthor: wireUser(ACCOUNT_ID, 'User One'),
    body: adfDoc('Corrected.'),
    created: '2026-08-09T12:00:00.000+0000',
    updated: '2026-08-09T12:30:00.000+0000',
  };
  const fake = createFakeJiraRequest()
    .on(`GET /rest/api/3/issue/${KEY}/comment/50001`, jiraOk(stored))
    .on(`PUT /rest/api/3/issue/${KEY}/comment/50001`, jiraOk(stored));

  const comment = await updateComment({
    jira: fake.fn,
    issue: KEY,
    commentId: 50001,
    body: 'Corrected.',
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'PUT');
  // The item template, not the thread template: the id is a path segment.
  assert.equal(request?.pathTemplate, ISSUE_COMMENT_ITEM_PATH_TEMPLATE);
  // CC-31 on a comment: the body key carries the WHOLE replacement document,
  // and nothing else is sent, so no other stored field can be disturbed.
  assert.deepEqual(request?.body, { body: adfDoc('Corrected.') });
  assertNeverSafe(fake.calls);
  assert.equal(comment.id, '50001');
  assert.equal(comment.body, 'Corrected.');
  assert.equal(comment.updated, '2026-08-09T12:30:00.000+0000');
});

test('updateComment passes raw ADF through untouched and keeps visibility', () => {
  // A caller that already has ADF must not have it re-wrapped in a paragraph.
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Plan' }] },
    ],
  };

  const request = updateCommentRequest({
    issue: KEY,
    commentId: '50001',
    body: adf,
    visibility: { type: 'role', value: 'Administrators' },
  });

  assert.equal(request.method, 'PUT');
  assert.equal(request.path, `/issue/${KEY}/comment/50001`);
  assert.deepEqual(request.body, {
    body: adf,
    visibility: { type: 'role', value: 'Administrators' },
  });
});

test('D22: updateComment refuses a non-numeric comment id before the wire', async () => {
  const fake = createFakeJiraRequest();

  for (const commentId of ['', '  ', 'abc', '0', '-3', '50001x', '1.5']) {
    await assert.rejects(
      updateComment({ jira: fake.fn, issue: KEY, commentId, body: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'validation');
        assert.match(error.remediation ?? '', /jira_get_comments/);
        return true;
      },
    );
  }

  // A refusal that never became a request: no half-applied edit is possible.
  assert.equal(fake.calls.length, 0);
});

test('updateComment reports an unexpected shape when the echo has no id', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}/comment/50001`,
    jiraOk({ body: adfDoc('Corrected.') }),
  );

  await assert.rejects(
    updateComment({
      jira: fake.fn,
      issue: KEY,
      commentId: 50001,
      body: 'Corrected.',
      visibility: null,
    }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('CC-510: updateComment refuses to edit a comment whose restriction it cannot restate', async () => {
  // A restriction dropped on the floor would publish the comment. // synthetic
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment/50001`,
    jiraOk({ id: '50001', body: adfDoc('Secret.'), visibility: { identifier: '10002' } }),
  );

  await assert.rejects(
    updateComment({ jira: fake.fn, issue: KEY, commentId: 50001, body: 'Corrected.' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  // The PUT never went out.
  assert.equal(fake.calls.length, 1);
});

test('assignIssue sends an accountId, and unassign sends an explicit null', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}/assignee`,
    jiraOk(undefined, { status: 204 }),
  );

  const assigned = await assignIssue({
    jira: fake.fn,
    issue: KEY,
    accountId: ACCOUNT_ID,
  });
  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_ASSIGNEE_PATH_TEMPLATE);
  assert.deepEqual(fake.lastRequest()?.body, { accountId: ACCOUNT_ID });
  assert.deepEqual(assigned, { issue: KEY, accountId: ACCOUNT_ID, assigned: true });

  const cleared = await assignIssue({ jira: fake.fn, issue: KEY, unassign: true });
  // `null`, never an omitted key: an empty body would leave the assignee alone.
  assert.deepEqual(fake.lastRequest()?.body, { accountId: null });
  assert.deepEqual(cleared, { issue: KEY, accountId: null, assigned: true });

  assertNeverSafe(fake.calls);
});

test('CC-22: assign refuses an ambiguous or empty intent', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    assignIssue({ jira: fake.fn, issue: KEY, accountId: ACCOUNT_ID, unassign: true }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    assignIssue({ jira: fake.fn, issue: KEY }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Worklogs (D16 / CC-23)
// ---------------------------------------------------------------------------

/** `POST /issue/{key}/worklog` echoes the stored worklog. // synthetic */
const STORED_WORKLOG = {
  id: '40002',
  issueId: '10001',
  author: wireUser(ACCOUNT_ID, 'User One'),
  started: '2026-08-07T15:30:00.000+0530',
  timeSpent: '2h 30m',
  timeSpentSeconds: 9000,
};

test('CC-23: addWorklog stamps started with the injected offset, never Z', async () => {
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/worklog`,
    jiraOk(STORED_WORKLOG, { status: 201 }),
  );

  const worklog = await addWorklog({
    jira: fake.fn,
    issue: KEY,
    timeSpentSeconds: 9000,
    startedAt: STARTED_AT,
    // +05:30 — pinned by the test, read from the user's Jira timezone in prod.
    utcOffsetMinutes: 330,
    comment: 'Paired on the retry policy.',
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.pathTemplate, ISSUE_WORKLOG_PATH_TEMPLATE);
  assert.deepEqual(request?.body, {
    timeSpentSeconds: 9000,
    started: '2026-08-07T15:30:00.000+0530',
    comment: adfDoc('Paired on the retry policy.'),
  });
  const started = (request?.body as { started: string }).started;
  assert.ok(!started.endsWith('Z'), 'Jira rejects a Z-suffixed worklog start');
  assertNeverSafe(fake.calls);
  assert.equal(worklog.id, '40002');
  assert.equal(worklog.timeSpentSeconds, 9000);
});

test('addWorklog accepts a duration string and defaults started from the clock', async () => {
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/worklog`,
    jiraOk(STORED_WORKLOG, { status: 201 }),
  );
  const clock = createFakeClock(STARTED_AT);

  await addWorklog({
    jira: fake.fn,
    issue: KEY,
    timeSpent: '2h 30m',
    utcOffsetMinutes: 0,
    clock,
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    timeSpent: '2h 30m',
    started: '2026-08-07T10:00:00.000+0000',
  });
});

test('addWorklog refuses both time formats, neither, and a missing time source', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    addWorklog({
      jira: fake.fn,
      issue: KEY,
      timeSpentSeconds: 9000,
      timeSpent: '2h 30m',
      startedAt: STARTED_AT,
      utcOffsetMinutes: 0,
    }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    addWorklog({ jira: fake.fn, issue: KEY, startedAt: STARTED_AT, utcOffsetMinutes: 0 }),
    isJiraErrorOfKind('validation'),
  );
  // No startedAt and no clock: the host clock is never consulted.
  await assert.rejects(
    addWorklog({ jira: fake.fn, issue: KEY, timeSpentSeconds: 60, utcOffsetMinutes: 0 }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

test('formatJiraTimestamp renders both offset directions with milliseconds', () => {
  assert.equal(formatJiraTimestamp(STARTED_AT, 0), '2026-08-07T10:00:00.000+0000');
  assert.equal(formatJiraTimestamp(STARTED_AT, 330), '2026-08-07T15:30:00.000+0530');
  assert.equal(formatJiraTimestamp(STARTED_AT, -420), '2026-08-07T03:00:00.000-0700');
  // A negative sub-hour offset keeps the sign on the whole offset.
  assert.equal(formatJiraTimestamp(STARTED_AT, -30), '2026-08-07T09:30:00.000-0030');
  assert.throws(
    () => formatJiraTimestamp(STARTED_AT, 900),
    isJiraErrorOfKind('validation'),
  );
  assert.throws(
    () => formatJiraTimestamp(Number.NaN, 0),
    isJiraErrorOfKind('validation'),
  );
});

test('utcOffsetMinutesForZone reads a zone at an instant and falls back to the host', () => {
  assert.equal(utcOffsetMinutesForZone('UTC', STARTED_AT), 0);
  assert.equal(utcOffsetMinutesForZone('Asia/Kolkata', STARTED_AT), 330);
  // DST is a property of the instant, not of the zone.
  const january = Date.UTC(2026, 0, 15, 12, 0, 0);
  assert.equal(utcOffsetMinutesForZone('Europe/Sofia', STARTED_AT), 180);
  assert.equal(utcOffsetMinutesForZone('Europe/Sofia', january), 120);
  // An unusable zone degrades to the host offset instead of losing the worklog.
  assert.equal(
    utcOffsetMinutesForZone('Not/AZone', STARTED_AT),
    -new Date(STARTED_AT).getTimezoneOffset(),
  );
});

test('utcOffsetMinutesForZone reads years 0000-0099 as themselves, not as 19xx (CC-922)', () => {
  assert.equal(utcOffsetMinutesForZone('UTC', Date.parse('0050-06-01T10:00:00Z')), 0);
  assert.equal(
    utcOffsetMinutesForZone('Asia/Kolkata', Date.parse('0099-12-31T23:00:00Z')),
    353,
  );
  // `0000` is `1 BC` to Intl.
  assert.equal(utcOffsetMinutesForZone('UTC', Date.parse('0000-01-01T00:00:00Z')), 0);

  const started = startedInstant('0050-06-01T10:00:00', 'UTC', 0);
  assert.ok(started);
  assert.deepEqual(started, {
    epochMs: Date.parse('0050-06-01T10:00:00Z'),
    offsetMinutes: 0,
  });
  assert.equal(
    formatJiraTimestamp(started.epochMs, started.offsetMinutes),
    '0050-06-01T10:00:00.000+0000',
  );
});

test('startedInstant without a started value uses the injected now in the user zone', () => {
  assert.deepEqual(startedInstant(undefined, 'Asia/Kolkata', STARTED_AT), {
    epochMs: STARTED_AT,
    offsetMinutes: 330,
  });
  assert.deepEqual(startedInstant(undefined, 'UTC', STARTED_AT), {
    epochMs: STARTED_AT,
    offsetMinutes: 0,
  });
});

test('startedInstant reads an offsetless started IN the user zone, not in UTC', () => {
  // 15:30 on the wall clock of a user in +0530 is 10:00 UTC — the host clock of
  // the process running this test never enters the calculation.
  assert.deepEqual(startedInstant('2026-08-07T15:30:00', 'Asia/Kolkata', 0), {
    epochMs: STARTED_AT,
    offsetMinutes: 330,
  });
  // A space instead of `T` is what models write, and it means the same thing.
  assert.deepEqual(startedInstant('2026-08-07 15:30:00', 'Asia/Kolkata', 0), {
    epochMs: STARTED_AT,
    offsetMinutes: 330,
  });
  // Seconds and milliseconds are both optional.
  assert.deepEqual(startedInstant('2026-08-07T15:30', 'Asia/Kolkata', 0), {
    epochMs: STARTED_AT,
    offsetMinutes: 330,
  });
  assert.deepEqual(startedInstant('2026-08-07T15:30:00.000', 'Asia/Kolkata', 0), {
    epochMs: STARTED_AT,
    offsetMinutes: 330,
  });
});

test('startedInstant treats an offset-carrying started as an absolute instant', () => {
  // Same moment written four ways; the offset REPORTED is always the user's.
  for (const written of [
    '2026-08-07T10:00:00.000+0000',
    '2026-08-07T15:30:00+0530',
    '2026-08-07T15:30:00+05:30',
    '2026-08-07T10:00:00Z',
  ]) {
    assert.deepEqual(
      startedInstant(written, 'Asia/Kolkata', 0),
      { epochMs: STARTED_AT, offsetMinutes: 330 },
      written,
    );
  }
  // …and re-rendering that pair is the wall clock the user would have written.
  const instant = startedInstant('2026-08-07T10:00:00Z', 'Asia/Kolkata', 0);
  assert.notEqual(instant, undefined);
  assert.equal(
    formatJiraTimestamp(instant?.epochMs ?? 0, instant?.offsetMinutes ?? 0),
    '2026-08-07T15:30:00.000+0530',
  );
});

test('startedInstant picks the zone offset at the instant, not a constant', () => {
  // Europe/Sofia is +0200 in January and +0300 in August (D16, CC-23).
  assert.equal(
    startedInstant('2026-01-15T12:00:00', 'Europe/Sofia', 0)?.offsetMinutes,
    120,
  );
  assert.equal(
    startedInstant('2026-08-07T12:00:00', 'Europe/Sofia', 0)?.offsetMinutes,
    180,
  );
});

test('CC-520: an offsetless started near a DST change takes the offset of its own side', () => {
  const cases: readonly (readonly [string, string, number, string])[] = [
    // East of UTC, the hours before the switch: still standard time.
    ['Australia/Sydney', '2026-10-03T17:00:00', 600, '2026-10-03T07:00:00.000Z'],
    ['Europe/Sofia', '2026-03-29T02:30:00', 120, '2026-03-29T00:30:00.000Z'],
    // The last hour of summer time before the fall-back.
    ['Europe/Sofia', '2026-10-25T02:00:00', 180, '2026-10-24T23:00:00.000Z'],
    // West of UTC, the hours after the switch: already summer time.
    ['America/New_York', '2026-03-08T04:00:00', -240, '2026-03-08T08:00:00.000Z'],
    // Inside the spring-forward gap: moved forward by the gap.
    ['Europe/Sofia', '2026-03-29T03:30:00', 120, '2026-03-29T01:30:00.000Z'],
    // A repeated fall-back wall time: the later (standard-time) occurrence.
    ['Europe/Sofia', '2026-10-25T03:30:00', 120, '2026-10-25T01:30:00.000Z'],
  ];
  for (const [zone, started, offsetMinutes, iso] of cases) {
    assert.deepEqual(
      startedInstant(started, zone, 0),
      { epochMs: Date.parse(iso), offsetMinutes },
      `${zone} ${started}`,
    );
  }
});

test('startedInstant refuses an impossible calendar date instead of rolling it over', () => {
  // V8 turns 2026-02-30 into 2026-03-02; logging work on the wrong day silently
  // is worse than an error the caller can fix.
  assert.equal(startedInstant('2026-02-30T10:00:00', 'UTC', 0), undefined);
  assert.equal(startedInstant('2026-02-30T10:00:00+0200', 'UTC', 0), undefined);
  // A month that does not exist never parses at all.
  assert.equal(startedInstant('2026-13-01T10:00:00', 'UTC', 0), undefined);
  // Anything the pattern rejects outright.
  assert.equal(startedInstant('yesterday', 'UTC', 0), undefined);
  assert.equal(startedInstant('2026-08-07', 'UTC', 0), undefined);
  assert.equal(startedInstant('2026-08-07T24:00:00', 'UTC', 0), undefined);
});

// ---------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------

test('linkIssues posts the link type by name with both ends', async () => {
  const fake = createFakeJiraRequest().on(
    'POST /rest/api/3/issueLink',
    jiraOk(undefined, { status: 201 }),
  );

  const result = await linkIssues({
    jira: fake.fn,
    linkType: 'Blocks',
    inwardIssue: 'PROJ-2',
    outwardIssue: '10001',
    comment: 'Ordering the work.',
    commentVisibility: { type: 'group', value: 'jira-developers' },
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.path, ISSUE_LINK_PATH);
  assert.deepEqual(request?.body, {
    type: { name: 'Blocks' },
    inwardIssue: { key: 'PROJ-2' },
    // A numeric reference is an id, not a key.
    outwardIssue: { id: '10001' },
    comment: {
      body: adfDoc('Ordering the work.'),
      visibility: { type: 'group', value: 'jira-developers' },
    },
  });
  assertNeverSafe(fake.calls);
  assert.deepEqual(result, {
    linkType: 'Blocks',
    inwardIssue: 'PROJ-2',
    outwardIssue: '10001',
    linked: true,
  });
});

test('linkIssues refuses an empty link type', async () => {
  const fake = createFakeJiraRequest();

  await assert.rejects(
    linkIssues({
      jira: fake.fn,
      linkType: ' ',
      inwardIssue: 'PROJ-2',
      outwardIssue: 'PROJ-3',
    }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Cancellation and budget plumbing
// ---------------------------------------------------------------------------

test('the abort signal and the deadline reach every request', async () => {
  const fake = createFakeJiraRequest()
    .on(ISSUE_ROUTE, jiraOk(issueWithEverything()))
    .on(
      `POST /rest/api/3/issue/${KEY}/comment`,
      jiraOk({ id: '50002', body: adfDoc('Hi') }, { status: 201 }),
    );
  const controller = new AbortController();
  const clock = createFakeClock(STARTED_AT);
  const deadlineAt = STARTED_AT + 30_000;

  await getIssue({
    jira: fake.fn,
    issue: KEY,
    signal: controller.signal,
    deadlineAt,
    clock,
  });
  assert.equal(fake.lastRequest()?.signal, controller.signal);
  assert.equal(fake.lastRequest()?.deadlineAt, deadlineAt);

  await addComment({
    jira: fake.fn,
    issue: KEY,
    body: 'Hi',
    signal: controller.signal,
    deadlineAt,
    clock,
  });
  assert.equal(fake.lastRequest()?.signal, controller.signal);
  assert.equal(fake.lastRequest()?.deadlineAt, deadlineAt);
});

// ---------------------------------------------------------------------------
// shapeUser — the PII collapse (TOOLS.md §Read shaping)
// ---------------------------------------------------------------------------

test('shapeUser emits three keys and drops every PII field Jira sent', () => {
  const shaped = shapeUser({
    self: `https://example.atlassian.net/rest/api/3/user?accountId=${ACCOUNT_ID}`,
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
    emailAddress: 'user-1@example.invalid',
    timeZone: 'Australia/Sydney',
    locale: 'en_US',
    accountType: 'atlassian',
    avatarUrls: { '48x48': 'https://example.atlassian.net/avatar/1' },
  }); // synthetic — a fully disclosed user record

  // The narrow projection is a RUNTIME rule, not a type-level one: `JiraUser` is
  // the wide record `api/users.ts` defines, so only this assertion stops an
  // email from riding out on a comment author.
  assert.deepEqual(shaped, {
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
  });
});

test('shapeUser rejects a record with no accountId', () => {
  assert.equal(shapeUser({ displayName: 'User One' }), undefined); // synthetic
  assert.equal(shapeUser(null), undefined);
});

test('shapeUser keeps only the accountId when Jira sent nothing else usable', () => {
  // A deleted or app user comes back with the id alone; nothing is invented.
  assert.deepEqual(shapeUser({ accountId: ACCOUNT_ID, displayName: 7, active: 'yes' }), {
    accountId: ACCOUNT_ID,
  });
});

// ---------------------------------------------------------------------------
// Deletes (D45 / WP-72)
// ---------------------------------------------------------------------------

test('getComment addresses one comment and shapes it like the list does', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment/50001`,
    jiraOk({
      self: 'https://example.atlassian.net/rest/api/3/issue/10001/comment/50001',
      id: '50001',
      author: wireUser(ACCOUNT_ID, 'User One'),
      body: adfDoc('Only one comment matters here.'),
      created: '2026-08-05T08:00:00.000+0000',
      updated: '2026-08-05T08:00:00.000+0000',
      jsdPublic: true,
    }), // synthetic
  );

  const comment = await getComment({ jira: fake.fn, issue: KEY, commentId: '50001' });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'GET');
  assert.equal(request?.pathTemplate, ISSUE_COMMENT_ITEM_PATH_TEMPLATE);
  assert.equal(request?.path, `/issue/${KEY}/comment/50001`);
  assert.deepEqual(comment, {
    id: '50001',
    author: { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
    body: 'Only one comment matters here.',
    created: '2026-08-05T08:00:00.000+0000',
    updated: '2026-08-05T08:00:00.000+0000',
    jsdPublic: true,
  });
});

test('getComment rejects a body with no id rather than inventing one', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment/50001`,
    jiraOk({ body: adfDoc('No id at all.') }), // synthetic
  );

  await assert.rejects(
    getComment({ jira: fake.fn, issue: KEY, commentId: 50001 }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'unexpected_shape');
      return true;
    },
  );
});

test('getWorklog addresses one worklog entry', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/worklog/40001`,
    jiraOk({
      self: 'https://example.atlassian.net/rest/api/3/issue/10001/worklog/40001',
      id: '40001',
      issueId: '10001',
      author: wireUser(ACCOUNT_ID, 'User One'),
      comment: adfDoc('Paired on the retry policy.'),
      created: '2026-08-07T15:31:00.000+0530',
      updated: '2026-08-07T15:31:00.000+0530',
      started: '2026-08-07T15:30:00.000+0530',
      timeSpent: '2h 30m',
      timeSpentSeconds: 9000,
    }), // synthetic
  );

  const worklog = await getWorklog({ jira: fake.fn, issue: KEY, worklogId: 40001 });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_WORKLOG_ITEM_PATH_TEMPLATE);
  assert.equal(fake.lastRequest()?.path, `/issue/${KEY}/worklog/40001`);
  assert.equal(worklog.id, '40001');
  assert.equal(worklog.timeSpentSeconds, 9000);
  assert.deepEqual(worklog.author, {
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
  });
});

test('deleteIssueRequest always states deleteSubtasks, including when it is false', () => {
  assert.deepEqual(deleteIssueRequest({ issue: KEY }), {
    method: 'DELETE',
    path: `/issue/${KEY}`,
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: { deleteSubtasks: false },
  });
  assert.deepEqual(deleteIssueRequest({ issue: KEY, deleteSubtasks: true }).query, {
    deleteSubtasks: true,
  });
});

test('deleteIssue sends one unsafe DELETE and echoes what it destroyed', async () => {
  const fake = createFakeJiraRequest().on(
    `DELETE /rest/api/3/issue/${KEY}`,
    jiraOk(undefined, { status: 204 }), // synthetic — Jira answers 204, no body
  );

  const result = await deleteIssue({ jira: fake.fn, issue: KEY, deleteSubtasks: true });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'DELETE');
  assert.equal(request?.path, `/issue/${KEY}`);
  assert.equal(request?.pathTemplate, ISSUE_PATH_TEMPLATE);
  assert.equal(request?.query?.deleteSubtasks, true);
  assert.equal(request?.body, undefined);
  // An unsafe write is never replayed (JIRA-API.md §Rate limiting and retries).
  assert.equal(request?.safe, undefined);
  assert.deepEqual(result, { issue: KEY, deleted: true, deleteSubtasks: true });
});

test('the subtask 400 keeps Jira words and points at the deleteSubtasks flag', async () => {
  const refused = errorFromResponse({
    status: 400,
    body: {
      errorMessages: ['The issue has subtasks and deleteSubtasks is false.'],
      errors: {},
    },
    method: 'DELETE',
    pathTemplate: ISSUE_PATH_TEMPLATE,
  });
  const fake = createFakeJiraRequest().on(
    `DELETE /rest/api/3/issue/${KEY}`,
    jiraErr(refused),
  );

  await assert.rejects(deleteIssue({ jira: fake.fn, issue: KEY }), (error: unknown) => {
    assert.ok(error instanceof JiraError);
    assert.equal(error.kind, 'validation');
    assert.equal(error.httpStatus, 400);
    assert.deepEqual(error.jiraMessages, [
      'The issue has subtasks and deleteSubtasks is false.',
    ]);
    assert.match(error.message, /has subtasks and deleteSubtasks is false/);
    assert.match(error.remediation ?? '', /deleteSubtasks/);
    assert.match(error.remediation ?? '', /jira_get_issue/);
    return true;
  });
});

test('a 400 is left alone once deleteSubtasks was already true', async () => {
  const other = errorFromResponse({
    status: 400,
    body: { errorMessages: ['Something else entirely.'], errors: {} },
    method: 'DELETE',
    pathTemplate: ISSUE_PATH_TEMPLATE,
  });
  const fake = createFakeJiraRequest().on(
    `DELETE /rest/api/3/issue/${KEY}`,
    jiraErr(other),
  );

  await assert.rejects(
    deleteIssue({ jira: fake.fn, issue: KEY, deleteSubtasks: true }),
    (error: unknown) => {
      assert.equal(error, other, 'no re-aiming when the flag cannot be the cause');
      return true;
    },
  );
});

test('a 404 from the issue DELETE is not mistaken for a subtask refusal', async () => {
  const missing = errorFromResponse({
    status: 404,
    body: {
      errorMessages: ['Issue does not exist or you do not have permission to see it.'],
      errors: {},
    },
    method: 'DELETE',
    pathTemplate: ISSUE_PATH_TEMPLATE,
  });
  const fake = createFakeJiraRequest().on(
    `DELETE /rest/api/3/issue/${KEY}`,
    jiraErr(missing),
  );

  await assert.rejects(deleteIssue({ jira: fake.fn, issue: KEY }), (error: unknown) => {
    assert.equal(error, missing); // CC-16 survives untouched
    return true;
  });
});

test('deleteComment and deleteWorklog address the row and echo the receipt', async () => {
  const fake = createFakeJiraRequest()
    .on(
      `DELETE /rest/api/3/issue/${KEY}/comment/50001`,
      jiraOk(undefined, { status: 204 }),
    )
    .on(
      `DELETE /rest/api/3/issue/${KEY}/worklog/40001`,
      jiraOk(undefined, { status: 204 }),
    );

  const comment = await deleteComment({ jira: fake.fn, issue: KEY, commentId: 50001 });
  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_COMMENT_ITEM_PATH_TEMPLATE);
  assert.equal(fake.lastRequest()?.safe, undefined);
  assert.deepEqual(comment, { issue: KEY, commentId: '50001', deleted: true });

  const worklog = await deleteWorklog({ jira: fake.fn, issue: KEY, worklogId: '40001' });
  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_WORKLOG_ITEM_PATH_TEMPLATE);
  assert.equal(fake.lastRequest()?.query, undefined, 'adjustEstimate stays at Jira auto');
  assert.deepEqual(worklog, { issue: KEY, worklogId: '40001', deleted: true });
});

test('D22: a bad comment or worklog id never reaches a URL', async () => {
  const fake = createFakeJiraRequest(); // every route unprogrammed: a call would throw

  for (const commentId of ['', '0', 'abc', '12x', '-3', '1.5']) {
    await assert.rejects(
      deleteComment({ jira: fake.fn, issue: KEY, commentId }),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'validation');
        return true;
      },
    );
  }

  for (const worklogId of ['', '0', 'abc', '40001 ; rm', '-1']) {
    await assert.rejects(
      deleteWorklog({ jira: fake.fn, issue: KEY, worklogId }),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'validation');
        assert.match(error.remediation ?? '', /jira_get_worklogs/);
        return true;
      },
    );
  }

  assert.deepEqual(fake.calls, []);
});

test('deleteWorklogRequest and deleteCommentRequest build the plan-mode spec', () => {
  assert.deepEqual(deleteCommentRequest({ issue: KEY, commentId: '50001' }), {
    method: 'DELETE',
    path: `/issue/${KEY}/comment/50001`,
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  });
  assert.deepEqual(deleteWorklogRequest({ issue: KEY, worklogId: 40001 }), {
    method: 'DELETE',
    path: `/issue/${KEY}/worklog/40001`,
    pathTemplate: ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  });
});

// ---------------------------------------------------------------------------
// CC-67 — the shaping walk is one walk, and `format` only picks the renderer.
//
// `MAX_SHAPE_DEPTH` guards a custom field holding a whole document from blowing
// the stack. The claim worth pinning is not the number, it is that the number
// applies to BOTH renderings identically: markdown and text stop at the same
// node, so a caller cannot get a deeper (or shallower) view of an issue by
// asking for the other format.
// ---------------------------------------------------------------------------

/** An ADF paragraph whose two renderings are trivially distinguishable. */
const BOLD_DOC = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'deep', marks: [{ type: 'strong' }] }],
    },
  ],
};

/**
 * `levels` nested records around `leaf`. `shapeIssueFields` enters the field
 * value at depth 0, so the leaf of `nest(n, …)` is visited at depth `n` — which
 * makes `nest(MAX_SHAPE_DEPTH, …)` the first depth the cap refuses to walk.
 */
function nest(levels: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { child: value };
  return value;
}

test('CC-67: below MAX_SHAPE_DEPTH both formats render the same node, differently', () => {
  const fields = { customfield_10050: nest(MAX_SHAPE_DEPTH - 1, BOLD_DOC) };

  const asText = shapeIssueFields(fields, false, 'text');
  const asMarkdown = shapeIssueFields(fields, false, 'markdown');

  const leafOf = (shaped: Record<string, unknown>): unknown => {
    let value: unknown = shaped['customfield_10050'];
    for (let i = 0; i < MAX_SHAPE_DEPTH - 1; i += 1) {
      value = (value as Record<string, unknown>)['child'];
    }
    return value;
  };

  assert.equal(leafOf(asText), 'deep');
  assert.equal(leafOf(asMarkdown), '**deep**');
});

test('CC-67: at MAX_SHAPE_DEPTH both formats stop at the SAME node, untouched', () => {
  const fields = { customfield_10050: nest(MAX_SHAPE_DEPTH, BOLD_DOC) };

  const asText = shapeIssueFields(fields, false, 'text');
  const asMarkdown = shapeIssueFields(fields, false, 'markdown');

  // Same node, same result: the cap is a property of the walk, not of the
  // renderer. If either format walked one level further this would be a string.
  assert.deepEqual(asText, asMarkdown);
  assert.deepEqual(asText, fields);
  assert.deepEqual(shapeIssueFields(fields, true), fields);
});

// ---------------------------------------------------------------------------
// Guards the tools never trip — held here so a future caller cannot either
// ---------------------------------------------------------------------------

test('addWorklog refuses a timeSpentSeconds that is not a positive whole number', async () => {
  const fake = createFakeJiraRequest();

  for (const timeSpentSeconds of [0, -5, 1.5]) {
    await assert.rejects(
      addWorklog({
        jira: fake.fn,
        issue: KEY,
        timeSpentSeconds,
        startedAt: STARTED_AT,
        utcOffsetMinutes: 0,
      }),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'validation' &&
        /timeSpentSeconds must be a whole number of seconds above zero/.test(
          error.message,
        ),
      String(timeSpentSeconds),
    );
  }
  assert.equal(fake.calls.length, 0);
});

test('an explicit startAt resumes a classic list where the previous page stopped', async () => {
  // The offset the previous call reported as `nextStartAt`, handed back in —
  // the first request goes out at that offset, not at zero.
  const fake = createFakeJiraRequest().on(
    (req) => req.path.endsWith('/comment') && req.query?.startAt === 2,
    jiraOk(commentPage(2, ['3', '4'])),
  );

  const result = await listComments({
    jira: fake.fn,
    issue: KEY,
    startAt: 2,
    maxResults: 2,
  });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.lastRequest()?.query?.startAt, 2);
  assert.deepEqual(
    result.comments.map((comment) => comment.id),
    ['3', '4'],
  );
  assert.equal(result.nextStartAt, 4);
});

test('classic lists refuse a negative or fractional startAt and a maxResults below 1', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment`,
    jiraOk(commentPage(0, ['1'])),
  );

  for (const startAt of [-1, 2.5]) {
    await assert.rejects(
      listComments({ jira: fake.fn, issue: KEY, startAt }),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'validation' &&
        /startAt must be a whole number of rows/.test(error.message),
      String(startAt),
    );
  }
  await assert.rejects(
    listComments({ jira: fake.fn, issue: KEY, maxResults: 0 }),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'validation' &&
      /maxResults must be a whole number of at least 1/.test(error.message),
  );
  assert.equal(fake.calls.length, 0);

  // Over the cap is not an error: the page is clamped and the caller pages on.
  await listComments({ jira: fake.fn, issue: KEY, maxResults: MAX_PAGE_SIZE * 10 });
  assert.equal(fake.lastRequest()?.query?.maxResults, MAX_PAGE_SIZE);
});

test('a classic list whose collection is not an array is an unexpected_shape', async () => {
  const fake = createFakeJiraRequest()
    .on(
      `GET /rest/api/3/issue/${KEY}/comment`,
      jiraOk({ startAt: 0, maxResults: 50, total: 1, comments: { id: '1' } }),
    )
    .on(`GET /rest/api/3/issue/${KEY}/transitions`, jiraOk({ transitions: 'none' }));

  await assert.rejects(
    listComments({ jira: fake.fn, issue: KEY }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  await assert.rejects(
    listTransitions({ jira: fake.fn, issue: KEY }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('an issue echo without a string id or key is an unexpected_shape, not a blank', async () => {
  // Jira always sends both; a proxy that rewrote the body is the realistic
  // way to lose them, and the tool must not report a "created" issue it
  // cannot name. // synthetic
  const fake = createFakeJiraRequest()
    .on(ISSUE_ROUTE, jiraOk({ key: KEY, fields: {} }))
    .on('POST /rest/api/3/issue', jiraOk({ id: 10010, key: 'PROJ-10' }, { status: 201 }));

  await assert.rejects(
    getIssue({ jira: fake.fn, issue: KEY }),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'unexpected_shape' &&
      /issue\.id is missing or not a string/.test(error.message),
  );
  await assert.rejects(
    createIssue({ jira: fake.fn, project: 'PROJ', issueType: 'Task', summary: 'Named' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('listTransitions tolerates a numeric transition id and echoes it as a string', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/transitions`,
    jiraOk({
      transitions: [
        { id: 21, name: 'In Progress', to: { id: '2', name: 'In Progress' } },
        { name: 'no id at all' },
      ],
    }),
  );

  const result = await listTransitions({ jira: fake.fn, issue: KEY });

  // The id-less row is dropped rather than shaped into a transition nobody
  // can POST.
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0]?.id, '21');
  assert.equal(result.transitions[0]?.name, 'In Progress');
});

// ---------------------------------------------------------------------------
// Sparse payloads: what a read keeps, drops and refuses to invent
// ---------------------------------------------------------------------------

test('shapeIssueFields keeps a bare link and drops one that points at no issue', () => {
  const fields = shapeIssueFields(
    {
      issuelinks: [
        // No id, no type, an outward issue that is only a key: kept as-is.
        { outwardIssue: { key: 'PROJ-2' } },
        // Inward only, with a `fields` that is not an object.
        {
          id: '10002',
          type: { name: 'Blocks', inward: 'is blocked by' },
          inwardIssue: { id: '10003', key: 'PROJ-3', fields: 'nope' },
        },
        // Neither side names an issue: nothing to point at, so it is dropped.
        { id: '10004', type: { name: 'Relates' } },
        // An issue without a string key is no issue at all.
        { type: {}, outwardIssue: { id: '10005' } },
        'not a link',
      ],
      // A parent that is not an object becomes null rather than a fake ref.
      parent: 'nope',
    },
    false,
  );

  assert.deepEqual(fields.issuelinks, [
    { type: {}, direction: 'outward', issue: { key: 'PROJ-2' } },
    {
      id: '10002',
      type: { name: 'Blocks', inward: 'is blocked by' },
      direction: 'inward',
      relation: 'is blocked by',
      issue: { id: '10003', key: 'PROJ-3' },
    },
  ]);
  assert.equal(fields.parent, null);
});

test('shapeIssueFields passes a non-array issuelinks value through like any field', () => {
  assert.deepEqual(shapeIssueFields({ issuelinks: 'n/a' }, false), { issuelinks: 'n/a' });
  // Not an object at all: nothing to shape.
  assert.deepEqual(shapeIssueFields('nope', false), {});
});

test('getIssue keeps a sparse changelog block and leaves out one that is not an object', async () => {
  const sparse = {
    ...issueWithEverything(),
    changelog: {
      histories: [
        // No id, created or author; `items` is not an array.
        { items: 'nope' },
        // Items that are not objects are dropped, the rest passed through.
        { id: '30002', items: ['nope', { field: 'summary' }] },
        'not a history',
      ],
    },
  };
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(sparse));

  const issue = await getIssue({ jira: fake.fn, issue: KEY });

  assert.deepEqual(issue.changelog, {
    histories: [{ items: [] }, { id: '30002', items: [{ field: 'summary' }] }],
  });

  // A changelog that is not an object (or has no histories) is not invented.
  const odd = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraOk({ ...issueWithEverything(), changelog: 'nope' }),
  );
  assert.equal((await getIssue({ jira: odd.fn, issue: KEY })).changelog, undefined);
  const empty = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraOk({ ...issueWithEverything(), changelog: { histories: 'nope' } }),
  );
  assert.deepEqual((await getIssue({ jira: empty.fn, issue: KEY })).changelog, {
    histories: [],
  });
});

test('listTransitions shapes a bare transition without inventing what Jira left out', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/transitions`,
    jiraOk({
      transitions: [
        { id: '31' },
        { id: '41', to: {} },
        {
          id: '51',
          to: { id: '5', statusCategory: {} },
          hasScreen: 'yes',
          fields: 'nope',
        },
        'not a transition',
      ],
    }),
  );

  const result = await listTransitions({ jira: fake.fn, issue: KEY });

  assert.deepEqual(result.transitions, [
    { id: '31' },
    { id: '41', to: {} },
    { id: '51', to: { id: '5', statusCategory: {} } },
  ]);
});

test('listTransitions treats a body with no transitions as an empty list', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/transitions`,
    jiraOk({ expand: 'transitions' }),
  );

  assert.deepEqual(await listTransitions({ jira: fake.fn, issue: KEY }), {
    transitions: [],
  });
});

test('listComments keeps a bare comment, drops a row that is not one and ends on a page with no counters', async () => {
  const signal = new AbortController().signal;
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment`,
    jiraOk({
      comments: [
        { id: '7', body: adfDoc('Bare'), visibility: {} },
        { body: adfDoc('No id') },
        'nope',
      ],
    }),
  );

  const result = await listComments({ jira: fake.fn, issue: KEY, signal });

  assert.deepEqual(result.comments, [{ id: '7', body: 'Bare', visibility: {} }]);
  // No `total`, `isLast`, `startAt` or `maxResults`: one short page is the end,
  // and the result reports no total rather than a made-up zero.
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.total, undefined);
  assert.equal(result.pages, 1);
  // The MCP cancellation rides along on the wire request.
  assert.equal(fake.lastRequest()?.signal, signal);
});

test('listComments reads a body with no comments key as an empty page', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/comment`,
    jiraOk({ startAt: 0 }),
  );

  const result = await listComments({ jira: fake.fn, issue: KEY });

  assert.deepEqual(result.comments, []);
  assert.equal(result.stopReason, 'exhausted');
});

test('CC-900: listWorklogs cuts a server that ignores the window down to the one asked for', async () => {
  // Data Center's worklog route answers every worklog from offset 0, whatever
  // startAt/maxResults said. // synthetic
  const all = ['1', '2', '3', '4', '5'].map((id) => ({ id: `4000${id}` }));
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/worklog`,
    jiraOk({ startAt: 0, maxResults: 5, total: 5, isLast: true, worklogs: all }),
  );
  const ids = (result: { worklogs: readonly { id: string }[] }): string[] =>
    result.worklogs.map((worklog) => worklog.id);

  const first = await listWorklogs({ jira: fake.fn, issue: KEY, maxResults: 2 });
  assert.deepEqual(ids(first), ['40001', '40002']);
  assert.equal(first.partial, true);
  assert.equal(first.nextStartAt, 2);

  const middle = await listWorklogs({
    jira: fake.fn,
    issue: KEY,
    startAt: 2,
    maxResults: 2,
  });
  assert.deepEqual(ids(middle), ['40003', '40004']);
  assert.equal(middle.startAt, 2);
  assert.equal(middle.nextStartAt, 4);

  const last = await listWorklogs({
    jira: fake.fn,
    issue: KEY,
    startAt: 4,
    maxResults: 2,
  });
  assert.deepEqual(ids(last), ['40005']);
  assert.equal(last.partial, false);
  assert.equal(last.stopReason, 'exhausted');
  assert.equal(last.total, 5);

  const past = await listWorklogs({ jira: fake.fn, issue: KEY, startAt: 9 });
  assert.deepEqual(ids(past), []);
  assert.equal(past.partial, false);
});

test('listWorklogs keeps a bare worklog and drops rows that are not one', async () => {
  const fake = createFakeJiraRequest().on(
    `GET /rest/api/3/issue/${KEY}/worklog`,
    jiraOk({
      worklogs: [
        // Only an id: nothing else is invented, not even an empty comment.
        { id: '40002', issueId: 10001, timeSpentSeconds: '9000', visibility: 'nope' },
        {
          id: '40003',
          updateAuthor: wireUser(OTHER_ACCOUNT_ID, 'User Two'),
          visibility: { type: 'role', value: 'Developers', identifier: '10100' },
        },
        { comment: adfDoc('no id') },
        'nope',
      ],
    }),
  );

  const result = await listWorklogs({ jira: fake.fn, issue: KEY });

  assert.deepEqual(result.worklogs, [
    { id: '40002' },
    {
      id: '40003',
      updateAuthor: {
        accountId: OTHER_ACCOUNT_ID,
        displayName: 'User Two',
        active: true,
      },
      visibility: { type: 'role', value: 'Developers', identifier: '10100' },
    },
  ]);
});

test('getComment renders the body as markdown when asked, like the list does', async () => {
  const body = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ship ' },
          { type: 'text', text: 'now', marks: [{ type: 'strong' }] },
        ],
      },
    ],
  };
  const route = `GET /rest/api/3/issue/${KEY}/comment/50001`;
  const reply = { id: '50001', body };

  const markdown = await getComment({
    jira: createFakeJiraRequest().on(route, jiraOk(reply)).fn,
    issue: KEY,
    commentId: '50001',
    format: 'markdown',
  });
  const text = await getComment({
    jira: createFakeJiraRequest().on(route, jiraOk(reply)).fn,
    issue: KEY,
    commentId: '50001',
  });

  assert.equal(markdown.body, 'Ship **now**');
  assert.equal(text.body, 'Ship now');
});

test('getIssue carries requested properties and does without a self link', async () => {
  const body: Record<string, unknown> = {
    ...issueWithEverything(),
    properties: { 'ops.owner': 'sre' },
  };
  delete body['self'];
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(body));

  const issue = await getIssue({ jira: fake.fn, issue: KEY, properties: ['ops.owner'] });

  assert.equal(fake.lastRequest()?.query?.properties, 'ops.owner');
  assert.equal(issue.self, undefined);
  assert.deepEqual(issue.properties, { 'ops.owner': 'sre' });
});

test('linkIssues sends no comment block when none was given, and no visibility when open', async () => {
  const fake = createFakeJiraRequest().on(
    'POST /rest/api/3/issueLink',
    jiraOk(undefined, { status: 201 }),
  );

  await linkIssues({
    jira: fake.fn,
    linkType: 'Blocks',
    inwardIssue: 'PROJ-2',
    outwardIssue: 'PROJ-3',
  });
  assert.deepEqual(fake.lastRequest()?.body, {
    type: { name: 'Blocks' },
    inwardIssue: { key: 'PROJ-2' },
    outwardIssue: { key: 'PROJ-3' },
  });

  await linkIssues({
    jira: fake.fn,
    linkType: 'Blocks',
    inwardIssue: 'PROJ-2',
    outwardIssue: 'PROJ-3',
    comment: 'Visible to all.',
  });
  assert.deepEqual(fake.lastRequest()?.body, {
    type: { name: 'Blocks' },
    inwardIssue: { key: 'PROJ-2' },
    outwardIssue: { key: 'PROJ-3' },
    comment: { body: adfDoc('Visible to all.') },
  });
});

test('CC-21: a bare 400 on a transition is re-aimed without quoting messages Jira never sent', async () => {
  const bare = createJiraError({
    kind: 'validation',
    reason: 'Bad Request',
    httpStatus: 400,
  });
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/transitions`,
    jiraErr(bare),
  );

  await assert.rejects(
    transitionIssue({ jira: fake.fn, issue: KEY, transitionId: '31' }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.reason, 'Jira rejected transition 31 for this issue.');
      assert.equal(error.jiraMessages, undefined);
      assert.equal(error.detail, undefined);
      assert.equal(error.cause, bare);
      return true;
    },
  );
});

test('transitionIssue passes a non-400 failure through untouched', async () => {
  const forbidden = createJiraError({
    kind: 'permission',
    reason: 'Forbidden',
    httpStatus: 403,
  });
  const fake = createFakeJiraRequest().on(
    `POST /rest/api/3/issue/${KEY}/transitions`,
    jiraErr(forbidden),
  );

  await assert.rejects(
    transitionIssue({ jira: fake.fn, issue: KEY, transitionId: '31' }),
    (error: unknown) => error === forbidden,
  );
});

test('a bare 400 on an issue delete is re-aimed without quoting messages Jira never sent', async () => {
  const bare = createJiraError({
    kind: 'validation',
    reason: 'Bad Request',
    httpStatus: 400,
  });
  const fake = createFakeJiraRequest().on(
    `DELETE /rest/api/3/issue/${KEY}`,
    jiraErr(bare),
  );

  await assert.rejects(deleteIssue({ jira: fake.fn, issue: KEY }), (error: unknown) => {
    assert.ok(error instanceof JiraError);
    assert.equal(error.reason, `Jira refused to delete ${KEY}.`);
    assert.equal(error.jiraMessages, undefined);
    assert.equal(error.detail, undefined);
    assert.equal(error.cause, bare);
    return true;
  });
});

test('a created comment or worklog, or a read worklog, without an id is unexpected_shape', async () => {
  const fake = createFakeJiraRequest()
    .on(
      `POST /rest/api/3/issue/${KEY}/comment`,
      jiraOk({ body: adfDoc('x') }, { status: 201 }),
    )
    .on(
      `POST /rest/api/3/issue/${KEY}/worklog`,
      jiraOk({ timeSpent: '1h' }, { status: 201 }),
    )
    .on(`GET /rest/api/3/issue/${KEY}/worklog/40001`, jiraOk({ timeSpent: '1h' }));

  await assert.rejects(
    addComment({ jira: fake.fn, issue: KEY, body: 'x' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  await assert.rejects(
    addWorklog({
      jira: fake.fn,
      issue: KEY,
      timeSpent: '1h',
      startedAt: STARTED_AT,
      utcOffsetMinutes: 0,
    }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  await assert.rejects(
    getWorklog({ jira: fake.fn, issue: KEY, worklogId: '40001' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('createIssue sets the reporter and updateIssue sets the priority by name or id', async () => {
  const fake = createFakeJiraRequest()
    .on(
      'POST /rest/api/3/issue',
      jiraOk(
        { id: '10011', key: 'PROJ-11', self: 'https://example/i/10011' },
        { status: 201 },
      ),
    )
    .on(`PUT /rest/api/3/issue/${KEY}`, jiraOk(undefined, { status: 204 }));

  await createIssue({
    jira: fake.fn,
    project: 'PROJ',
    issueType: 'Task',
    summary: 'On behalf of',
    reporterAccountId: OTHER_ACCOUNT_ID,
  });
  const created = fake.lastRequest()?.body as { fields: Record<string, unknown> };
  assert.deepEqual(created.fields.reporter, { accountId: OTHER_ACCOUNT_ID });

  await updateIssue({ jira: fake.fn, issue: KEY, priority: 'Highest' });
  assert.deepEqual(
    (fake.lastRequest()?.body as { fields: Record<string, unknown> }).fields,
    {
      priority: { name: 'Highest' },
    },
  );
  await updateIssue({ jira: fake.fn, issue: KEY, priority: '1' });
  assert.deepEqual(
    (fake.lastRequest()?.body as { fields: Record<string, unknown> }).fields,
    {
      priority: { id: '1' },
    },
  );
  assertNeverSafe(fake.calls);
});

test('formatJiraTimestamp refuses an instant outside the calendar Jira stores', () => {
  // Year 10000 renders in the expanded `+010000-…` ISO form that no fixed
  // slice reads; the offset can also push a valid instant past the Date limit.
  assert.throws(
    () => formatJiraTimestamp(Date.UTC(10_000, 0, 1), 0),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'validation' &&
      /outside the range Jira accepts/.test(error.message),
  );
  assert.throws(
    () => formatJiraTimestamp(8.64e15, 60),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === 'validation' &&
      /outside the range Jira accepts/.test(error.message),
  );
});

test('[CC-196] a due date travels as the system field id duedate, and a raw duedate collides', async () => {
  const fake = createFakeJiraRequest().on(
    `PUT /rest/api/3/issue/${KEY}`,
    jiraOk(undefined, { status: 204 }),
  );

  await updateIssue({ jira: fake.fn, issue: KEY, dueDate: '2026-10-01' });

  assert.deepEqual(fake.lastRequest()?.body, { fields: { duedate: '2026-10-01' } });
  await assert.rejects(
    updateIssue({
      jira: fake.fn,
      issue: KEY,
      dueDate: '2026-10-01',
      fields: { duedate: '2026-11-01' },
    }),
    /set twice/,
  );
});

// ---------------------------------------------------------------------------
// Remote links (D141)
// ---------------------------------------------------------------------------

const REMOTE_LINK_GET = `GET /rest/api/3/issue/${KEY}/remotelink`;
const REMOTE_LINK_POST = `POST /rest/api/3/issue/${KEY}/remotelink`;

test('CC-1518: listRemoteLinks projects each link and drops the icon noise', async () => {
  const fake = createFakeJiraRequest().on(
    REMOTE_LINK_GET,
    // `GET /issue/{key}/remotelink`. // synthetic
    jiraOk([
      {
        id: 10000,
        self: 'https://example.atlassian.net/rest/api/3/issue/PROJ-1/remotelink/10000',
        globalId: 'pr:acme/app/42',
        application: { type: 'com.github', name: 'GitHub' },
        relationship: 'fixed by',
        object: {
          url: 'https://example.com/acme/app/pull/42',
          title: 'Fix the retry loop',
          summary: 'Bounded retries.',
          icon: { url16x16: 'https://example.com/favicon.ico', title: 'GitHub' },
          status: { resolved: true, icon: {} },
        },
      },
      { id: 10001, object: { url: 'https://example.com/runbook', title: 'Runbook' } },
    ]),
  );

  const result = await listRemoteLinks({ jira: fake.fn, issue: ` ${KEY} ` });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_REMOTE_LINK_PATH_TEMPLATE);
  assert.deepEqual(result, {
    issue: KEY,
    remoteLinks: [
      {
        id: 10000,
        globalId: 'pr:acme/app/42',
        relationship: 'fixed by',
        application: { type: 'com.github', name: 'GitHub' },
        url: 'https://example.com/acme/app/pull/42',
        title: 'Fix the retry loop',
        summary: 'Bounded retries.',
        resolved: true,
      },
      { id: 10001, url: 'https://example.com/runbook', title: 'Runbook' },
    ],
  });
});

test('CC-1518: a remote link list that is not an array, or a row without a numeric id, is unexpected_shape', async () => {
  for (const body of [{ values: [] }, [{ id: '10000', object: {} }], [null]]) {
    const fake = createFakeJiraRequest().on(REMOTE_LINK_GET, jiraOk(body));
    await assert.rejects(
      listRemoteLinks({ jira: fake.fn, issue: KEY }),
      (error: unknown) => error instanceof JiraError && error.kind === 'unexpected_shape',
      JSON.stringify(body),
    );
  }
});

test('CC-1519: addRemoteLink sends a trimmed link object and reads 201 as created', async () => {
  const fake = createFakeJiraRequest().on(
    REMOTE_LINK_POST,
    jiraOk({ id: 10000, self: 'https://example.atlassian.net/x' }, { status: 201 }),
  );

  const result = await addRemoteLink({
    jira: fake.fn,
    issue: KEY,
    url: ' https://example.com/pull/42 ',
    title: ' PR 42 ',
    summary: '  ',
    relationship: 'fixed by',
    globalId: ' pr:42 ',
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    globalId: 'pr:42',
    relationship: 'fixed by',
    object: { url: 'https://example.com/pull/42', title: 'PR 42' },
  });
  assert.deepEqual(result, {
    issue: KEY,
    id: 10000,
    url: 'https://example.com/pull/42',
    title: 'PR 42',
    globalId: 'pr:42',
    created: true,
  });
  assertNeverSafe(fake.calls);
});

test('CC-1519: a 200 answer means the globalId matched and the link was replaced', async () => {
  const fake = createFakeJiraRequest().on(
    REMOTE_LINK_POST,
    jiraOk({ id: 10000, self: 'https://example.atlassian.net/x' }, { status: 200 }),
  );

  const result = await addRemoteLink({
    jira: fake.fn,
    issue: KEY,
    url: 'https://example.com/pull/42',
    title: 'PR 42',
    globalId: 'pr:42',
  });

  assert.equal(result.created, false);
});

test('CC-1519: a remote link answer without a numeric id is unexpected_shape', async () => {
  const fake = createFakeJiraRequest().on(
    REMOTE_LINK_POST,
    jiraOk({ id: '10000' }, { status: 201 }),
  );

  await assert.rejects(
    addRemoteLink({ jira: fake.fn, issue: KEY, url: 'https://example.com', title: 'x' }),
    (error: unknown) => error instanceof JiraError && error.kind === 'unexpected_shape',
  );
});

test('CC-1519: only an absolute http(s) url is a remote link target', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'example.com/pull/42',
    '/pull/42',
    'ftp://example.com',
  ]) {
    assert.throws(
      () => addRemoteLinkRequest({ issue: KEY, url, title: 'x' }),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'validation' &&
        /absolute http or https URL/.test(error.message),
      url,
    );
  }
  assert.equal(
    (
      addRemoteLinkRequest({ issue: KEY, url: 'http://intranet.local/x', title: 'x' })
        .body as {
        object: { url: string };
      }
    ).object.url,
    'http://intranet.local/x',
  );
});

// ---------------------------------------------------------------------------
// Worklog edit (D142)
// ---------------------------------------------------------------------------

const WORKLOG_ITEM = `/rest/api/3/issue/${KEY}/worklog/40001`;
const EDITED_WORKLOG = {
  id: '40001',
  issueId: '10001',
  started: '2026-08-07T15:30:00.000+0530',
  timeSpent: '2h 30m',
  timeSpentSeconds: 9000,
}; // synthetic

test('CC-1522: a worklog edit sends only the fields it names', () => {
  const durationOnly = updateWorklogRequest({
    issue: KEY,
    worklogId: 40001,
    timeSpent: ' 45m ',
  });
  assert.equal(durationOnly.method, 'PUT');
  assert.equal(durationOnly.path, `/issue/${KEY}/worklog/40001`);
  assert.equal(durationOnly.pathTemplate, ISSUE_WORKLOG_ITEM_PATH_TEMPLATE);
  assert.deepEqual(durationOnly.body, { timeSpent: '45m' });

  const commentOnly = updateWorklogRequest({
    issue: KEY,
    worklogId: '40001',
    comment: 'Re-scoped.',
  });
  assert.deepEqual(Object.keys(commentOnly.body as object), ['comment']);

  const startOnly = updateWorklogRequest({
    issue: KEY,
    worklogId: 40001,
    startedAt: Date.UTC(2026, 7, 7, 10, 0, 0),
    utcOffsetMinutes: 330,
  });
  assert.deepEqual(startOnly.body, { started: '2026-08-07T15:30:00.000+0530' });
});

test('CC-1523: a worklog edit with nothing to change, two durations or an offset-less start is refused before the wire', () => {
  for (const [input, pattern] of [
    [{ issue: KEY, worklogId: 40001 }, /at least one change/],
    [
      { issue: KEY, worklogId: 40001, timeSpent: '1h', timeSpentSeconds: 60 },
      /exactly one/,
    ],
    [{ issue: KEY, worklogId: 40001, startedAt: 0 }, /utcOffsetMinutes/],
    [{ issue: KEY, worklogId: 'abc', timeSpent: '1h' }, /positive integer/],
  ] as const) {
    assert.throws(
      () => updateWorklogRequest(input),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'validation' &&
        pattern.test(error.message),
      JSON.stringify(input),
    );
  }
});

test('CC-1523: an invalid edit is refused before the stored entry is read', async () => {
  const fake = createFakeJiraRequest();
  await assert.rejects(
    updateWorklog({ jira: fake.fn, issue: KEY, worklogId: 40001 }),
    (error: unknown) => error instanceof JiraError && error.kind === 'validation',
  );
  assert.equal(fake.calls.length, 0);
});

test('CC-1524: updateWorklog resends the stored visibility and answers with the updated entry', async () => {
  const visibility = { type: 'role', value: 'Developers' };
  const fake = createFakeJiraRequest()
    .on(`GET ${WORKLOG_ITEM}`, jiraOk({ ...EDITED_WORKLOG, visibility }))
    .on(
      `PUT ${WORKLOG_ITEM}`,
      jiraOk({ ...EDITED_WORKLOG, timeSpent: '45m', timeSpentSeconds: 2700, visibility }),
    );

  const worklog = await updateWorklog({
    jira: fake.fn,
    issue: KEY,
    worklogId: 40001,
    timeSpentSeconds: 2700,
  });

  assert.deepEqual(fake.lastRequest()?.body, { timeSpentSeconds: 2700, visibility });
  assert.equal(worklog.timeSpentSeconds, 2700);
  assertNeverSafe(fake.calls.filter((call) => call.method === 'PUT'));
});

test('CC-1524: an unrestricted entry is edited without a visibility key', async () => {
  const fake = createFakeJiraRequest()
    .on(`GET ${WORKLOG_ITEM}`, jiraOk(EDITED_WORKLOG))
    .on(`PUT ${WORKLOG_ITEM}`, jiraOk(EDITED_WORKLOG));

  await updateWorklog({ jira: fake.fn, issue: KEY, worklogId: 40001, comment: 'x' });

  assert.equal('visibility' in (fake.lastRequest()?.body as object), false);
});

test('CC-1524: an updated worklog answer without a string id is unexpected_shape', async () => {
  const fake = createFakeJiraRequest()
    .on(`GET ${WORKLOG_ITEM}`, jiraOk(EDITED_WORKLOG))
    .on(`PUT ${WORKLOG_ITEM}`, jiraOk({ id: 40001 }));

  await assert.rejects(
    updateWorklog({ jira: fake.fn, issue: KEY, worklogId: 40001, timeSpent: '1h' }),
    (error: unknown) => error instanceof JiraError && error.kind === 'unexpected_shape',
  );
});

// ---------------------------------------------------------------------------
// D143 — issue link delete
// ---------------------------------------------------------------------------

/** `GET /issueLink/{id}` — both ends, under Jira's own names. // synthetic */
const ISSUE_LINK_BODY = {
  id: '10200',
  self: 'https://example.atlassian.net/rest/api/3/issueLink/10200',
  type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: {
    id: '10001',
    key: 'PROJ-1',
    fields: { summary: 'Retry policy', status: { name: 'In Progress' } },
  },
  outwardIssue: {
    id: '10002',
    key: 'PROJ-2',
    fields: { summary: 'Release', status: { name: 'To Do' } },
  },
};

test('CC-1526: getIssueLink reads one link with both of its ends', async () => {
  const fake = createFakeJiraRequest().on(
    'GET /rest/api/3/issueLink/10200',
    jiraOk(ISSUE_LINK_BODY),
  );

  const link = await getIssueLink({ jira: fake.fn, linkId: 10200 });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_LINK_ITEM_PATH_TEMPLATE);
  assert.deepEqual(link, {
    id: '10200',
    type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    inwardIssue: {
      id: '10001',
      key: 'PROJ-1',
      summary: 'Retry policy',
      status: 'In Progress',
    },
    outwardIssue: { id: '10002', key: 'PROJ-2', summary: 'Release', status: 'To Do' },
  });
});

test('CC-1526: a link body without an id or without both ends is an unexpected_shape', async () => {
  const fake = createFakeJiraRequest()
    .on('GET /rest/api/3/issueLink/1', jiraOk({ ...ISSUE_LINK_BODY, id: undefined }))
    .on(
      'GET /rest/api/3/issueLink/2',
      jiraOk({ ...ISSUE_LINK_BODY, outwardIssue: undefined }),
    );

  await assert.rejects(
    getIssueLink({ jira: fake.fn, linkId: '1' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  await assert.rejects(
    getIssueLink({ jira: fake.fn, linkId: '2' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('CC-1527: deleteIssueLink addresses the link and echoes the receipt', async () => {
  const fake = createFakeJiraRequest().on(
    'DELETE /rest/api/3/issueLink/10200',
    jiraOk(undefined, { status: 204 }),
  );

  const deleted = await deleteIssueLink({ jira: fake.fn, linkId: ' 10200 ' });

  assert.equal(fake.lastRequest()?.safe, undefined);
  assert.deepEqual(deleted, { linkId: '10200', deleted: true });
  assert.deepEqual(deleteIssueLinkRequest({ linkId: 10200 }), {
    method: 'DELETE',
    path: `${ISSUE_LINK_PATH}/10200`,
    pathTemplate: ISSUE_LINK_ITEM_PATH_TEMPLATE,
  });
});

test('CC-1527: a bad issue link id never reaches a URL', async () => {
  const fake = createFakeJiraRequest(); // every route unprogrammed: a call would throw

  for (const linkId of ['', '0', 'abc', '10200/../1', '-1']) {
    await assert.rejects(deleteIssueLink({ jira: fake.fn, linkId }), (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.match(error.remediation ?? '', /issuelinks/);
      return true;
    });
    await assert.rejects(
      getIssueLink({ jira: fake.fn, linkId }),
      isJiraErrorOfKind('validation'),
    );
  }

  assert.deepEqual(fake.calls, []);
});

// ---------------------------------------------------------------------------
// Remote link delete (D145)
// ---------------------------------------------------------------------------

const REMOTE_LINK_ID = 10300;
const REMOTE_LINK_ITEM = `/rest/api/3/issue/${KEY}/remotelink/${REMOTE_LINK_ID}`;

test('CC-1531: getRemoteLink reads one link and shapes it like a list row', async () => {
  const fake = createFakeJiraRequest().on(
    `GET ${REMOTE_LINK_ITEM}`,
    jiraOk({
      id: REMOTE_LINK_ID,
      self: `https://example.atlassian.net${REMOTE_LINK_ITEM}`,
      relationship: 'mentioned in',
      object: {
        url: 'https://example.com/pull/42',
        title: 'PR #42',
        icon: { url16x16: 'https://example.com/favicon.ico' },
      },
    }),
  );

  const link = await getRemoteLink({ jira: fake.fn, issue: KEY, linkId: '10300' });

  assert.equal(fake.lastRequest()?.pathTemplate, ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE);
  assert.deepEqual(link, {
    id: REMOTE_LINK_ID,
    relationship: 'mentioned in',
    url: 'https://example.com/pull/42',
    title: 'PR #42',
  });
});

test('CC-1531: a remote link body without a numeric id is unexpected_shape', async () => {
  const fake = createFakeJiraRequest().on(
    `GET ${REMOTE_LINK_ITEM}`,
    jiraOk({ id: '10300', object: { url: 'https://example.com', title: 'x' } }),
  );

  await assert.rejects(
    getRemoteLink({ jira: fake.fn, issue: KEY, linkId: REMOTE_LINK_ID }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('CC-1532: deleteRemoteLink addresses the link under its issue and echoes the receipt', async () => {
  const fake = createFakeJiraRequest().on(
    `DELETE ${REMOTE_LINK_ITEM}`,
    jiraOk(undefined, { status: 204 }),
  );

  const deleted = await deleteRemoteLink({
    jira: fake.fn,
    issue: ` ${KEY} `,
    linkId: ' 10300 ',
  });

  assert.equal(fake.lastRequest()?.safe, undefined);
  assert.deepEqual(deleted, { issue: KEY, linkId: REMOTE_LINK_ID, deleted: true });
  assert.deepEqual(deleteRemoteLinkRequest({ issue: KEY, linkId: REMOTE_LINK_ID }), {
    method: 'DELETE',
    path: `/issue/${KEY}/remotelink/${REMOTE_LINK_ID}`,
    pathTemplate: ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE,
  });
});

test('CC-1532: a bad remote link id never reaches a URL', async () => {
  const fake = createFakeJiraRequest(); // every route unprogrammed: a call would throw

  for (const linkId of ['', '0', 'abc', '10300/../1', '-1', '9007199254740993']) {
    await assert.rejects(
      deleteRemoteLink({ jira: fake.fn, issue: KEY, linkId }),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'validation');
        assert.match(error.remediation ?? '', /jira_get_remote_links/);
        return true;
      },
    );
    await assert.rejects(
      getRemoteLink({ jira: fake.fn, issue: KEY, linkId }),
      isJiraErrorOfKind('validation'),
    );
  }

  assert.deepEqual(fake.calls, []);
});

// ---------------------------------------------------------------------------
// getIssuesBulk (D149)
// ---------------------------------------------------------------------------

const BULK_ROUTE = 'POST /rest/api/3/issue/bulkfetch';

test('[CC-1544] getIssuesBulk sends one POST and shapes every issue like getIssue', async () => {
  const fake = createFakeJiraRequest().on(
    BULK_ROUTE,
    jiraOk({ issues: [issueWithEverything()], issueErrors: [] }),
  );

  const result = await getIssuesBulk({
    jira: fake.fn,
    issues: [KEY, ` ${KEY} `, 'PROJ-2'],
    fields: ['summary', 'description', ' '],
    expand: ['changelog'],
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.path, ISSUE_BULKFETCH_PATH);
  // Refs are trimmed and de-duplicated; the lists travel as arrays, not CSV.
  assert.deepEqual(request?.body, {
    issueIdsOrKeys: [KEY, 'PROJ-2'],
    fields: ['summary', 'description'],
    expand: ['changelog'],
  });
  assert.equal(fake.calls.length, 1);

  const single = await getIssue({
    jira: createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueWithEverything())).fn,
    issue: KEY,
    fields: ['summary', 'description'],
    expand: ['changelog'],
  });
  const { raw, fieldsRequested, expand, ...record } = single;
  assert.deepEqual(result.issues, [record]);
  assert.equal(result.raw, raw);
  assert.deepEqual(result.fieldsRequested, fieldsRequested);
  assert.deepEqual(result.expand, expand);
  assert.deepEqual(result.requested, [KEY, 'PROJ-2']);
  assert.deepEqual(result.unmatched, ['PROJ-2']);
  assert.deepEqual(result.errors, []);
});

test('[CC-1545] getIssuesBulk refuses an empty or over-long ref list before sending', async () => {
  const fake = createFakeJiraRequest();
  const tooMany = Array.from(
    { length: MAX_BULK_ISSUES + 1 },
    (_, i) => `PROJ-${String(i + 1)}`,
  );

  await assert.rejects(
    getIssuesBulk({ jira: fake.fn, issues: [] }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    getIssuesBulk({ jira: fake.fn, issues: tooMany }),
    isJiraErrorOfKind('validation'),
  );
  await assert.rejects(
    getIssuesBulk({ jira: fake.fn, issues: [KEY, '  '] }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(fake.calls.length, 0);

  // Duplicates collapse before the cap is counted.
  const dupes = createFakeJiraRequest().on(BULK_ROUTE, jiraOk({ issues: [] }));
  const result = await getIssuesBulk({
    jira: dupes.fn,
    issues: [...tooMany.slice(0, MAX_BULK_ISSUES), KEY],
  });
  assert.equal(result.requested.length, MAX_BULK_ISSUES);
});

test('[CC-1546] getIssuesBulk matches refs by key (any case) or id and keeps issueErrors as messages', async () => {
  const fake = createFakeJiraRequest().on(
    BULK_ROUTE,
    jiraOk({
      issues: [
        { id: '10001', key: 'PROJ-1', fields: {} },
        { id: '10002', key: 'NEW-7', fields: {} },
      ],
      issueErrors: [
        {
          status: 404,
          failedElementNumber: 2,
          elementErrors: {
            errorMessages: [
              'Issue does not exist or you do not have permission to see it.',
            ],
            errors: { issueIdsOrKeys: 'GONE-9' },
            email: 'someone@example.com',
          },
        },
        'not a record',
      ],
    }),
  );

  const result = await getIssuesBulk({
    jira: fake.fn,
    issues: ['proj-1', '10002', 'OLD-7', 'GONE-9'],
  });

  // OLD-7 moved to NEW-7: it was served, but under its new key (CC-1546).
  assert.deepEqual(result.unmatched, ['OLD-7', 'GONE-9']);
  assert.deepEqual(result.errors, [
    {
      status: 404,
      failedElementNumber: 2,
      messages: [
        'Issue does not exist or you do not have permission to see it.',
        'issueIdsOrKeys: GONE-9',
      ],
    },
    { messages: [] },
  ]);
  // Absent fields stay absent rather than defaulting (D41).
  assert.equal('fieldsRequested' in result, false);
});

// ---------------------------------------------------------------------------
// getChangelogsBulk (D150)
// ---------------------------------------------------------------------------

const CHANGELOG_BULK_ROUTE = 'POST /rest/api/3/changelog/bulkfetch';

const HISTORY = {
  id: '9001',
  created: '2026-10-01T10:00:00.000+0000',
  author: {
    accountId: 'acc-1',
    displayName: 'Ada',
    active: true,
    emailAddress: 'ada@example.com',
  },
  items: [{ field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'Done' }],
};

test('[CC-1549] getChangelogsBulk sends one POST and shapes histories like listChangelog', async () => {
  const fake = createFakeJiraRequest().on(
    CHANGELOG_BULK_ROUTE,
    jiraOk({
      issueChangeLogs: [
        { issueId: '10001', changeHistories: [HISTORY, 'junk'] },
        { issueId: 10002, changeHistories: [] },
        { changeHistories: [HISTORY] },
      ],
      nextPageToken: 'next-1',
    }),
  );

  const result = await getChangelogsBulk({
    jira: fake.fn,
    issues: [KEY, ` ${KEY} `, '10002'],
    fieldIds: ['status', ' '],
    maxResults: 50,
  });

  const request = fake.lastRequest();
  assert.equal(request?.method, 'POST');
  assert.equal(request?.path, CHANGELOG_BULKFETCH_PATH);
  assert.deepEqual(request?.body, {
    issueIdsOrKeys: [KEY, '10002'],
    fieldIds: ['status'],
    maxResults: 50,
  });
  assert.equal(fake.calls.length, 1);

  const single = await listChangelog({
    jira: createFakeJiraRequest().on(
      `GET /rest/api/3/issue/${KEY}/changelog`,
      jiraOk({ values: [HISTORY], startAt: 0, maxResults: 50, total: 1, isLast: true }),
    ).fn,
    issue: KEY,
  });
  // A numeric issue id is restated as a string; a block without one is dropped.
  assert.deepEqual(result.issues, [
    { issueId: '10001', histories: single.histories },
    { issueId: '10002', histories: [] },
  ]);
  assert.equal(JSON.stringify(result).includes('ada@example.com'), false);
  assert.deepEqual(result.requested, [KEY, '10002']);
  assert.deepEqual(result.fieldIds, ['status']);
  assert.equal(result.nextPageToken, 'next-1');
  assert.equal(result.hasMore, true);
});

test('[CC-1550] getChangelogsBulk refuses bad refs or page size before sending', async () => {
  const fake = createFakeJiraRequest();
  const tooMany = Array.from(
    { length: MAX_BULK_CHANGELOG_ISSUES + 1 },
    (_, i) => `PROJ-${String(i + 1)}`,
  );
  for (const options of [
    { issues: [] },
    { issues: tooMany },
    { issues: [KEY, '  '] },
    { issues: [KEY], maxResults: 0 },
    { issues: [KEY], maxResults: MAX_BULK_CHANGELOG_RESULTS + 1 },
    { issues: [KEY], maxResults: 1.5 },
  ]) {
    await assert.rejects(
      getChangelogsBulk({ jira: fake.fn, ...options }),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'validation' &&
        /Nothing was sent|issue key or id/.test(error.message + error.reason),
    );
  }
  assert.equal(fake.calls.length, 0);

  // Duplicates collapse before the cap is counted.
  const ok = createFakeJiraRequest().on(
    CHANGELOG_BULK_ROUTE,
    jiraOk({ issueChangeLogs: [] }),
  );
  await getChangelogsBulk({
    jira: ok.fn,
    issues: [...tooMany.slice(0, MAX_BULK_CHANGELOG_ISSUES), 'PROJ-1'],
  });
  assert.equal(ok.calls.length, 1);
});

test('[CC-1551] getChangelogsBulk forwards the cursor and reports the last page', async () => {
  const fake = createFakeJiraRequest().on(
    CHANGELOG_BULK_ROUTE,
    jiraOk({ issueChangeLogs: [], nextPageToken: '' }),
  );

  const result = await getChangelogsBulk({
    jira: fake.fn,
    issues: [KEY],
    nextPageToken: ' cursor-2 ',
  });

  assert.deepEqual(fake.lastRequest()?.body, {
    issueIdsOrKeys: [KEY],
    nextPageToken: 'cursor-2',
  });
  // An empty token is the end of the read, not a cursor (D41: absent stays absent).
  assert.equal('nextPageToken' in result, false);
  assert.equal('fieldIds' in result, false);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.issues, []);
});
