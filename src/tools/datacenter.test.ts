// ---------------------------------------------------------------------------
// tools/datacenter.test.ts — every tool the Data Center adapter serves, end to
// end through the real tool handlers, against Data Center-shaped responses
// (D106, stage 13.3).
//
// The fixtures follow Atlassian's Data Center REST documentation; they are NOT
// recordings of a Data Center instance (none exists for this project — D104).
// What these tests prove is the adapter's own contract: the right root, the
// right routes, users projected by name/key, no email address on any result,
// and a refusal instead of a mislabelled answer where Data Center differs.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adapterFor } from '../api/adapters.js';
import {
  DATACENTER_API,
  DATACENTER_TOOLS,
  DATACENTER_WRITE_TOOLS,
} from '../api/datacenter.js';
import { listProjectsDataCenter, listStatusesDataCenter } from '../api/meta.js';
import { CLOUD_API } from '../api/port.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createFakeRedactor,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { errorFromResponse } from '../core/errors.js';
import type { Rng, Settings } from '../core/types.js';
import { createRegistry, selectPackages } from '../mcp/registry.js';
import type { AnyToolSpec, Hint, ToolCtx, ToolResult } from '../mcp/types.js';
import { getSprintIssuesTool, listBoardsTool, listSprintsTool } from './agile.js';
import { listAttachmentsTool } from './attachments.js';
import {
  listComponentsTool,
  listProjectRolesTool,
  listVersionsTool,
  listWatchersTool,
} from './collab.js';
import { getMyPermissionsTool, getMyselfTool } from './core.js';
import { buildCapabilitiesInfo, createPackages } from './index.js';
import {
  getChangelogTool,
  getCommentsTool,
  getIssueTool,
  getTransitionsTool,
  getWorklogsTool,
} from './issues.js';
import {
  getCreateMetaTool,
  getProjectTool,
  listFieldsTool,
  listLinkTypesTool,
  listProjectsTool,
  listStatusesTool,
} from './meta.js';
import { countTool, getFilterTool, listFiltersTool, searchTool } from './search.js';
import { searchUsersTool } from './users.js';

const EMAIL = 'jdoe@corp.example';

/** A Data Center project-role detail as `/rest/api/2/project/{p}/role/{id}` sends it. */
const DC_ROLE = {
  self: 'https://jira.corp.example/jira/rest/api/2/project/ABC/role/10002',
  name: 'Administrators',
  id: 10002,
  description: 'Project administrators',
  actors: [
    {
      id: 10240,
      displayName: 'Jane Doe',
      type: 'atlassian-user-role-actor',
      name: 'jdoe',
      avatarUrl:
        'https://jira.corp.example/jira/secure/useravatar?size=xsmall&ownerId=jdoe',
    },
    {
      id: 10241,
      displayName: 'jira-administrators',
      type: 'atlassian-group-role-actor',
      name: 'jira-administrators',
      avatarUrl:
        'https://jira.corp.example/jira/secure/useravatar?size=xsmall&avatarId=1',
    },
  ],
};

/** A Data Center user object as `/rest/api/2` sends one. */
const DC_USER = {
  self: 'https://jira.corp.example/jira/rest/api/2/user?username=jdoe',
  name: 'jdoe',
  key: 'JIRAUSER10100',
  emailAddress: EMAIL,
  avatarUrls: { '48x48': 'https://jira.corp.example/jira/secure/useravatar?avatarId=1' },
  displayName: 'Jane Doe',
  active: true,
  timeZone: 'Europe/Sofia',
};

const PROJECTED_USER = {
  name: 'jdoe',
  key: 'JIRAUSER10100',
  displayName: 'Jane Doe',
  active: true,
};

const ISSUE = {
  id: '10001',
  key: 'ABC-1',
  self: 'https://jira.corp.example/jira/rest/api/2/issue/10001',
  fields: {
    summary: 'Printer on fire',
    description: 'h1. Steps\n*Bold* and {{code}}',
    reporter: DC_USER,
    assignee: DC_USER,
    project: { id: '10000', key: 'ABC', name: 'Alpha', projectTypeKey: 'software' },
    status: {
      id: '1',
      name: 'To Do',
      statusCategory: { id: 2, key: 'new', name: 'To Do', colorName: 'blue-gray' },
    },
    fixVersions: [{ id: '100', name: '1.0', released: false }],
  },
};

/** One history as the changelog embedded by `GET /issue/{key}?expand=changelog` holds it. */
function dcHistory(id: number): Record<string, unknown> {
  return {
    id: String(id),
    author: DC_USER,
    created: '2026-09-01T09:00:00.000+0300',
    items: [
      {
        field: 'status',
        fieldtype: 'jira',
        from: '1',
        fromString: 'To Do',
        to: '3',
        toString: 'Done',
      },
    ],
  };
}

const DC_CHANGELOG = { startAt: 0, maxResults: 1, total: 1, histories: [dcHistory(1)] };

/** A Data Center attachment row as `fields.attachment` carries it. */
const DC_ATTACHMENT = {
  self: 'https://jira.corp.example/jira/rest/api/2/attachment/60001',
  id: '60001',
  filename: 'a.txt',
  author: DC_USER,
  created: '2026-09-01T09:00:00.000+0300',
  size: 3,
  mimeType: 'text/plain',
  content: 'https://jira.corp.example/jira/secure/attachment/60001/a.txt',
  thumbnail: 'https://jira.corp.example/jira/secure/thumbnail/60001/a.txt',
};

/** An accountId a Data Center payload should never carry — seeded to prove it is dropped. */
const STRAY_ACCOUNT_ID = '5b10a2844c20165700ede21g';

/**
 * A Data Center saved filter as `/rest/api/2/filter/{id}` and the favourites
 * list send it: the owner is a full Data Center user, and the share internals
 * are there — with a stray accountId and a group name — to prove the allowlist
 * reports none of them (D115).
 */
function dcFilter(id: string, name: string): Record<string, unknown> {
  return {
    self: `https://jira.corp.example/jira/rest/api/2/filter/${id}`,
    id,
    name,
    description: 'Saved for the stand-up',
    owner: DC_USER,
    jql: 'assignee = currentUser() AND resolution = Unresolved',
    viewUrl: `https://jira.corp.example/jira/issues/?filter=${id}`,
    searchUrl: 'https://jira.corp.example/jira/rest/api/2/search?jql=assignee',
    favourite: true,
    sharePermissions: [
      { id: 1, type: 'group', group: { name: 'secret-share-group' } },
      { id: 2, type: 'user', user: { ...DC_USER, accountId: STRAY_ACCOUNT_ID } },
    ],
    editPermissions: [],
    subscriptions: { size: 0, items: [] },
  };
}

const DC_FILTER = dcFilter('10000', 'My open issues');

function hintCodes(result: ToolResult<unknown>): string[] {
  return (result.hints ?? []).map((hint: Hint) => hint.code);
}

function ctxOf(jira: FakeJiraRequest, api = DATACENTER_API): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira: jira.fn,
    api,
    log: createFakeLogger({ cid: 'c-test01', clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 30_000, maxPages: 20 },
    deadlineAt: 9_000_000,
  };
}

function run(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  return spec.handler(spec.input.parse(args), ctx);
}

interface Case {
  readonly tool: AnyToolSpec;
  readonly args: Record<string, unknown>;
  readonly routes: readonly [string, unknown][];
  /** Whether the result is expected to carry a projected Data Center user. */
  readonly hasUser: boolean;
}

/** The paged create-metadata routes (D116), anchored so one is no prefix of the other. */
const DC_CREATE_META_TYPES = /^GET \/rest\/api\/2\/issue\/createmeta\/ABC\/issuetypes$/;
const DC_CREATE_META_SCREEN =
  /^GET \/rest\/api\/2\/issue\/createmeta\/ABC\/issuetypes\/10001$/;

/** A Data Center `values` page, as the 8.4+ create-metadata routes send one. */
function dcValues(
  values: readonly unknown[],
  startAt = 0,
  isLast = true,
  total = values.length,
): Record<string, unknown> {
  return { startAt, maxResults: 50, total, isLast, values };
}

const DC_ISSUE_TYPE_ROWS = [
  {
    self: 'https://jira.corp.example/jira/rest/api/2/issuetype/10001',
    id: '10001',
    name: 'Task',
    description: 'A task.',
    subtask: false,
    iconUrl: 'https://jira.corp.example/jira/secure/viewavatar?avatarId=10318',
  },
  {
    self: 'https://jira.corp.example/jira/rest/api/2/issuetype/10003',
    id: '10003',
    name: 'Sub-task',
    subtask: true,
  },
];

/**
 * A Data Center create screen: `fieldId`, `required`, `schema`, `operations`,
 * `allowedValues` — and a reporter default and an approver allowed value that
 * are whole Data Center users, email and avatar included.
 */
const DC_CREATE_META_FIELDS = [
  {
    required: true,
    schema: { type: 'string', system: 'summary' },
    name: 'Summary',
    fieldId: 'summary',
    hasDefaultValue: false,
    operations: ['set'],
  },
  {
    required: true,
    schema: { type: 'user', system: 'reporter' },
    name: 'Reporter',
    fieldId: 'reporter',
    autoCompleteUrl:
      'https://jira.corp.example/jira/rest/api/latest/user/search?username=',
    hasDefaultValue: true,
    defaultValue: DC_USER,
    operations: ['set'],
  },
  {
    required: false,
    schema: {
      type: 'user',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker',
      customId: 10200,
    },
    name: 'Approver',
    fieldId: 'customfield_10200',
    hasDefaultValue: false,
    operations: ['set'],
    allowedValues: [DC_USER],
  },
  {
    required: false,
    schema: {
      type: 'option',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
      customId: 10300,
    },
    name: 'Severity',
    fieldId: 'customfield_10300',
    hasDefaultValue: true,
    defaultValue: { id: '10400', value: 'Minor' },
    operations: ['set'],
    allowedValues: [
      {
        self: 'https://jira.corp.example/jira/rest/api/2/customFieldOption/10400',
        id: '10400',
        value: 'Minor',
      },
      {
        self: 'https://jira.corp.example/jira/rest/api/2/customFieldOption/10401',
        id: '10401',
        value: 'Major',
      },
    ],
  },
];

/** A 404 as `core/http.ts` would build it, with or without Jira's own messages. */
function notFound404(pathTemplate: string, errorMessages?: readonly string[]): Error {
  return errorFromResponse({
    status: 404,
    method: 'GET',
    pathTemplate,
    body:
      errorMessages === undefined
        ? '<html>Not Found</html>'
        : { errorMessages, errors: {} },
  });
}

const CASES: readonly Case[] = [
  {
    tool: getMyselfTool,
    args: {},
    routes: [['GET /rest/api/2/myself', { ...DC_USER, locale: 'en_US' }]],
    hasUser: true,
  },
  {
    // D122: the same record shape on the v2 root; a build that ignores the
    // key filter answers everything, and only what was asked survives.
    tool: getMyPermissionsTool,
    args: { permissions: ['BROWSE_PROJECTS'] },
    routes: [
      [
        'GET /rest/api/2/mypermissions',
        {
          permissions: {
            BROWSE_PROJECTS: {
              id: '10',
              key: 'BROWSE_PROJECTS',
              name: 'Browse Projects',
              type: 'PROJECT',
              description: 'Ability to browse projects and the issues within them.',
              havePermission: true,
            },
            ADMINISTER: {
              id: '0',
              key: 'ADMINISTER',
              name: 'Jira Administrators',
              type: 'GLOBAL',
              description: 'Ability to perform most administration functions.',
              havePermission: false,
            },
          },
        },
      ],
    ],
    hasUser: false,
  },
  {
    tool: searchTool,
    args: { jql: 'project = ABC' },
    routes: [
      [
        'POST /rest/api/2/search',
        { startAt: 0, maxResults: 25, total: 1, issues: [ISSUE] },
      ],
    ],
    hasUser: true,
  },
  {
    tool: getIssueTool,
    args: { issue: 'ABC-1', fields: ['summary', 'description', 'reporter', 'project'] },
    routes: [['GET /rest/api/2/issue/ABC-1', ISSUE]],
    hasUser: true,
  },
  {
    tool: getCommentsTool,
    args: { issue: 'ABC-1' },
    routes: [
      [
        'GET /rest/api/2/issue/ABC-1/comment',
        {
          startAt: 0,
          maxResults: 50,
          total: 1,
          comments: [
            {
              id: '200',
              author: DC_USER,
              updateAuthor: DC_USER,
              body: 'Hi [~jdoe], see *this*',
              created: '2026-09-01T09:00:00.000+0300',
            },
          ],
        },
      ],
    ],
    hasUser: true,
  },
  {
    tool: getTransitionsTool,
    args: { issue: 'ABC-1' },
    routes: [
      [
        'GET /rest/api/2/issue/ABC-1/transitions',
        {
          transitions: [
            {
              id: '11',
              name: 'Start',
              to: {
                id: '3',
                name: 'In Progress',
                statusCategory: { key: 'indeterminate', name: 'In Progress' },
              },
            },
          ],
        },
      ],
    ],
    hasUser: false,
  },
  {
    tool: getWorklogsTool,
    args: { issue: 'ABC-1' },
    routes: [
      [
        'GET /rest/api/2/issue/ABC-1/worklog',
        {
          startAt: 0,
          maxResults: 20,
          total: 1,
          worklogs: [
            {
              id: '300',
              author: DC_USER,
              comment: 'did *it*',
              started: '2026-09-01T09:00:00.000+0300',
              timeSpent: '1h',
              timeSpentSeconds: 3600,
            },
          ],
        },
      ],
    ],
    hasUser: true,
  },
  {
    tool: listProjectsTool,
    args: {},
    routes: [
      [
        'GET /rest/api/2/project',
        [
          {
            id: '10000',
            key: 'ABC',
            name: 'Alpha',
            projectTypeKey: 'software',
            lead: DC_USER,
          },
          { id: '10001', key: 'OPS', name: 'Operations', projectTypeKey: 'business' },
        ],
      ],
    ],
    hasUser: true,
  },
  {
    tool: getProjectTool,
    args: { project: 'ABC' },
    routes: [
      [
        'GET /rest/api/2/project/ABC',
        {
          id: '10000',
          key: 'ABC',
          name: 'Alpha',
          projectTypeKey: 'software',
          description: 'Alpha team',
          lead: DC_USER,
          issueTypes: [{ id: '1', name: 'Bug', subtask: false }],
        },
      ],
    ],
    hasUser: true,
  },
  {
    tool: listFieldsTool,
    args: {},
    routes: [
      [
        'GET /rest/api/2/field',
        [
          { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
          {
            id: 'customfield_10100',
            name: 'Story Points',
            custom: true,
            schema: {
              type: 'number',
              custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
            },
          },
        ],
      ],
    ],
    hasUser: false,
  },
  {
    tool: listStatusesTool,
    args: {},
    routes: [
      [
        'GET /rest/api/2/status',
        [
          { id: '1', name: 'To Do', statusCategory: { id: 2, key: 'new' } },
          {
            id: '3',
            name: 'In Progress',
            statusCategory: { id: 4, key: 'indeterminate' },
          },
        ],
      ],
    ],
    hasUser: false,
  },
  {
    tool: listLinkTypesTool,
    args: {},
    routes: [
      [
        'GET /rest/api/2/issueLinkType',
        {
          issueLinkTypes: [
            { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          ],
        },
      ],
    ],
    hasUser: false,
  },
  {
    tool: listWatchersTool,
    args: { issue: 'ABC-1' },
    routes: [
      [
        'GET /rest/api/2/issue/ABC-1/watchers',
        { isWatching: false, watchCount: 1, watchers: [DC_USER] },
      ],
    ],
    hasUser: true,
  },
  {
    tool: listComponentsTool,
    args: { project: 'ABC' },
    routes: [
      [
        'GET /rest/api/2/project/ABC/components',
        [
          {
            id: '10500',
            name: 'Backend',
            description: 'API and jobs',
            lead: DC_USER,
            leadUserName: 'jdoe',
            assigneeType: 'PROJECT_LEAD',
            realAssignee: DC_USER,
            project: 'ABC',
            projectId: 10000,
          },
        ],
      ],
    ],
    hasUser: true,
  },
  {
    tool: listVersionsTool,
    args: { project: 'ABC' },
    routes: [
      [
        'GET /rest/api/2/project/ABC/versions',
        [{ id: '100', name: '1.0', released: true, archived: false, projectId: 10000 }],
      ],
    ],
    hasUser: false,
  },
  {
    tool: listBoardsTool,
    args: {},
    routes: [
      [
        'GET /rest/agile/1.0/board',
        {
          startAt: 0,
          maxResults: 50,
          total: 1,
          isLast: true,
          values: [{ id: 1, name: 'ABC board', type: 'scrum' }],
        },
      ],
    ],
    hasUser: false,
  },
  {
    tool: listSprintsTool,
    args: { boardId: 1 },
    routes: [
      [
        'GET /rest/agile/1.0/board/1/sprint',
        {
          startAt: 0,
          maxResults: 50,
          isLast: true,
          values: [{ id: 5, state: 'active', name: 'Sprint 5', originBoardId: 1 }],
        },
      ],
    ],
    hasUser: false,
  },
  {
    tool: getSprintIssuesTool,
    args: { sprintId: 5 },
    routes: [
      [
        'GET /rest/agile/1.0/sprint/5/issue',
        { startAt: 0, maxResults: 50, total: 1, issues: [ISSUE] },
      ],
    ],
    hasUser: true,
  },
  {
    tool: searchUsersTool,
    args: { query: 'jdoe' },
    routes: [['GET /rest/api/2/user/search', [DC_USER]]],
    hasUser: true,
  },
  {
    tool: listProjectRolesTool,
    args: { project: 'ABC', roleId: 10002 },
    // Actors carry a name and no key, so the user regex below does not apply.
    routes: [['GET /rest/api/2/project/ABC/role/10002', DC_ROLE]],
    hasUser: false,
  },
  {
    tool: countTool,
    args: { jql: 'project = ABC' },
    routes: [
      ['POST /rest/api/2/search', { startAt: 0, maxResults: 0, total: 7, issues: [] }],
    ],
    hasUser: false,
  },
  {
    tool: getChangelogTool,
    args: { issue: 'ABC-1' },
    routes: [['GET /rest/api/2/issue/ABC-1', { ...ISSUE, changelog: DC_CHANGELOG }]],
    hasUser: true,
  },
  {
    tool: listAttachmentsTool,
    args: { issue: 'ABC-1' },
    routes: [
      [
        'GET /rest/api/2/issue/ABC-1',
        { key: 'ABC-1', fields: { attachment: [DC_ATTACHMENT] } },
      ],
    ],
    hasUser: true,
  },
  {
    tool: listFiltersTool,
    args: {},
    routes: [['GET /rest/api/2/filter/favourite', [DC_FILTER]]],
    hasUser: true,
  },
  {
    tool: getFilterTool,
    args: { filterId: 10000 },
    routes: [['GET /rest/api/2/filter/10000', DC_FILTER]],
    hasUser: true,
  },
  {
    tool: getCreateMetaTool,
    args: { project: 'ABC' },
    routes: [
      ['GET /rest/api/2/issue/createmeta/ABC/issuetypes', dcValues(DC_ISSUE_TYPE_ROWS)],
    ],
    hasUser: false,
  },
];

test('CC-265: the case table covers every read the adapter serves but capabilities', () => {
  const covered = new Set(CASES.map((c) => c.tool.name));
  // The writes have their own table in datacenter-write.test.ts (D109).
  // The download needs a media directory and moves bytes off the REST API;
  // it has its own file, datacenter-download.test.ts (D117, CC-370…CC-377).
  const served = [...DATACENTER_TOOLS].filter(
    (name) =>
      name !== 'jira_capabilities' &&
      name !== 'jira_download_attachment' &&
      !DATACENTER_WRITE_TOOLS.has(name),
  );
  assert.deepEqual([...covered].sort(), served.sort());
});

for (const { tool, args, routes, hasUser } of CASES) {
  test(`CC-265: ${tool.name} on Data Center — v2/agile routes only, users by name/key, no email`, async () => {
    const jira = createFakeJiraRequest();
    for (const [route, body] of routes) jira.on(route, jiraOk(body));
    const result = await run(tool, args, ctxOf(jira));

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.ok(jira.calls.length > 0);
    for (const route of jira.routes()) {
      assert.match(route, /^(GET|POST) \/rest\/(api\/2|agile\/1\.0)\//, route);
    }
    const text = JSON.stringify(result.data);
    assert.doesNotMatch(text, new RegExp(EMAIL), 'an email address leaked');
    assert.doesNotMatch(text, /avatarUrls|useravatar/, 'an avatar leaked');
    assert.doesNotMatch(text, /accountId/, 'a Cloud identity was invented');
    if (hasUser)
      assert.match(text, /"name":"jdoe","key":"JIRAUSER10100","displayName":"Jane Doe"/);
  });
}

test('CC-274: rich text is flattened from wiki markup; raw returns it as Jira sent it', async () => {
  const issue = {
    ...ISSUE,
    fields: {
      ...ISSUE.fields,
      summary: 'Fix *all* the_things',
      environment: '* Linux\n* {{x86}}',
    },
  };
  const jira = createFakeJiraRequest().on('GET /rest/api/2/issue/ABC-1', jiraOk(issue));
  const text = await run(getIssueTool, { issue: 'ABC-1' }, ctxOf(jira));
  const fields = (text.data as { fields: Record<string, unknown> }).fields;
  assert.equal(fields.description, 'Steps\nBold and code');
  assert.equal(fields.environment, '- Linux\n- x86');
  // A summary is not rich text: its asterisks are the user's, not markup.
  assert.equal(fields.summary, 'Fix *all* the_things');
  assert.deepEqual(fields.reporter, PROJECTED_USER);
  // Not a user: a project has key + name but no displayName.
  assert.deepEqual(fields.project, ISSUE.fields.project);

  const raw = await run(getIssueTool, { issue: 'ABC-1', raw: true }, ctxOf(jira));
  const rawFields = (raw.data as { fields: Record<string, unknown> }).fields;
  assert.equal(rawFields.description, 'h1. Steps\n*Bold* and {{code}}');
  assert.deepEqual(rawFields.reporter, PROJECTED_USER, 'raw never un-projects a user');
});

test('CC-274: comment bodies and worklog comments are flattened too', async () => {
  const comments = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1/comment',
    jiraOk({
      startAt: 0,
      maxResults: 50,
      total: 1,
      comments: [{ id: '200', author: DC_USER, body: 'Hi [~jdoe], see *this*' }],
    }),
  );
  const c = await run(getCommentsTool, { issue: 'ABC-1' }, ctxOf(comments));
  assert.equal(
    (c.data as { comments: { body: string }[] }).comments[0]?.body,
    'Hi @jdoe, see this',
  );
  const worklogs = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1/worklog',
    jiraOk({
      startAt: 0,
      maxResults: 20,
      total: 1,
      worklogs: [
        { id: '300', author: DC_USER, comment: 'did _it_', timeSpentSeconds: 60 },
      ],
    }),
  );
  const w = await run(getWorklogsTool, { issue: 'ABC-1' }, ctxOf(worklogs));
  assert.equal(
    (w.data as { worklogs: { comment?: string }[] }).worklogs[0]?.comment,
    'did it',
  );
});

test('[CC-298] the comment and worklog pages embedded in an issue read are flattened too', async () => {
  const issue = {
    ...ISSUE,
    fields: {
      ...ISSUE.fields,
      comment: {
        startAt: 0,
        maxResults: 50,
        total: 1,
        comments: [{ id: '200', author: DC_USER, body: 'Hi [~jdoe], see *this*' }],
      },
      worklog: {
        startAt: 0,
        maxResults: 20,
        total: 1,
        worklogs: [
          { id: '300', author: DC_USER, comment: 'did _it_', timeSpentSeconds: 60 },
        ],
      },
    },
  };
  const jira = createFakeJiraRequest().on('GET /rest/api/2/issue/ABC-1', jiraOk(issue));
  const result = await run(getIssueTool, { issue: 'ABC-1' }, ctxOf(jira));
  const fields = (result.data as { fields: Record<string, unknown> }).fields;
  const comment = fields.comment as { comments: Record<string, unknown>[] };
  const worklog = fields.worklog as { worklogs: Record<string, unknown>[] };
  assert.equal(comment.comments[0]?.body, 'Hi @jdoe, see this');
  assert.deepEqual(comment.comments[0]?.author, PROJECTED_USER);
  assert.equal(worklog.worklogs[0]?.comment, 'did it');

  const raw = await run(getIssueTool, { issue: 'ABC-1', raw: true }, ctxOf(jira));
  const rawFields = (raw.data as { fields: Record<string, unknown> }).fields;
  assert.equal(
    (rawFields.comment as { comments: Record<string, unknown>[] }).comments[0]?.body,
    'Hi [~jdoe], see *this*',
  );
});

test('CC-274: Cloud reads are untouched by the wiki flattener', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/issue/ABC-1',
    jiraOk({ id: '1', key: 'ABC-1', fields: { description: 'h1. *not* wiki on Cloud' } }),
  );
  const result = await run(getIssueTool, { issue: 'ABC-1' }, ctxOf(jira, CLOUD_API));
  assert.equal(
    (result.data as { fields: Record<string, unknown> }).fields.description,
    'h1. *not* wiki on Cloud',
  );
});

test('CC-265: format "markdown" is refused before any request on Data Center', async () => {
  for (const [tool, args] of [
    [getIssueTool, { issue: 'ABC-1', format: 'markdown' }],
    [getCommentsTool, { issue: 'ABC-1', format: 'markdown' }],
  ] as const) {
    const jira = createFakeJiraRequest();
    const result = await run(tool, args, ctxOf(jira));
    assert.equal(result.ok, false, tool.name);
    assert.equal(result.error?.kind, 'validation', tool.name);
    assert.equal(jira.calls.length, 0, tool.name);
  }
});

test('CC-267: jira_search pages with an opaque dc1: cursor over startAt', async () => {
  const jira = createFakeJiraRequest().on(
    'POST /rest/api/2/search',
    jiraOk({ startAt: 0, maxResults: 1, total: 3, issues: [ISSUE] }),
  );
  const first = await run(
    searchTool,
    { jql: 'project = ABC', maxResults: 1 },
    ctxOf(jira),
  );
  const data = first.data as { nextPageToken?: string; hasMore: boolean };
  assert.equal(data.nextPageToken, 'dc1:1');
  assert.equal(data.hasMore, true);
  assert.deepEqual((jira.calls[0]?.body as { startAt: number; jql: string }).startAt, 0);

  const next = createFakeJiraRequest().on(
    'POST /rest/api/2/search',
    jiraOk({
      startAt: 2,
      maxResults: 1,
      total: 3,
      issues: [{ ...ISSUE, id: '10003', key: 'ABC-3' }],
    }),
  );
  const last = await run(
    searchTool,
    { jql: 'project = ABC', maxResults: 1, nextPageToken: 'dc1:2' },
    ctxOf(next),
  );
  assert.equal((next.calls[0]?.body as { startAt: number }).startAt, 2);
  assert.equal((last.data as { hasMore: boolean }).hasMore, false);
  assert.equal((last.data as { nextPageToken?: string }).nextPageToken, undefined);
});

test('CC-267: a cursor this server did not issue is refused before any request', async () => {
  for (const token of ['CAEaAggB', 'dc1:-1', 'dc1:01', 'dc2:5', 'dc1:1e3']) {
    const jira = createFakeJiraRequest();
    const result = await run(
      searchTool,
      { jql: 'project = ABC', nextPageToken: token },
      ctxOf(jira),
    );
    assert.equal(result.ok, false, token);
    assert.equal(result.error?.kind, 'validation', token);
    assert.equal(jira.calls.length, 0, token);
  }
});

test('CC-267: reconcileIssues is refused on Data Center rather than dropped', async () => {
  const jira = createFakeJiraRequest();
  const result = await run(
    searchTool,
    { jql: 'project = ABC', reconcileIssues: ['10001'] },
    ctxOf(jira),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.equal(jira.calls.length, 0);
});

test('CC-268: projects are filtered here, and a filter DC cannot apply is refused', async () => {
  const projects = [
    { id: '10000', key: 'ABC', name: 'Alpha', projectTypeKey: 'software' },
    { id: '10001', key: 'OPS', name: 'Operations', projectTypeKey: 'business' },
  ];
  const jira = createFakeJiraRequest().on('GET /rest/api/2/project', jiraOk(projects));
  const byName = await run(listProjectsTool, { query: 'oper' }, ctxOf(jira));
  assert.deepEqual(
    (byName.data as { projects: { key: string }[] }).projects.map((p) => p.key),
    ['OPS'],
  );
  const byKey = await run(listProjectsTool, { query: 'abc' }, ctxOf(jira));
  assert.deepEqual(
    (byKey.data as { projects: { key: string }[] }).projects.map((p) => p.key),
    ['ABC'],
  );

  // The api-level filters no tool exposes today behave the same way.
  const base = { jira: jira.fn };
  const software = await listProjectsDataCenter({ ...base, typeKey: 'software' });
  assert.deepEqual(
    software.items.map((p) => p.key),
    ['ABC'],
  );
  assert.equal(software.partial, false);
  const refused = createFakeJiraRequest();
  await assert.rejects(
    listProjectsDataCenter({ jira: refused.fn, orderBy: 'name' }),
    (error: unknown) => (error as { kind?: string }).kind === 'validation',
  );
  assert.equal(refused.calls.length, 0);
});

test('CC-268: status categories map to the Cloud words, and projectId is refused', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/status',
    jiraOk([
      { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      { id: '6', name: 'Closed', statusCategory: { key: 'done' } },
      { id: '9', name: 'Odd', statusCategory: { key: 'undefined' } },
    ]),
  );
  const all = await run(listStatusesTool, {}, ctxOf(jira));
  assert.deepEqual(
    (all.data as { statuses: { name: string; statusCategory?: string }[] }).statuses.map(
      (s) => [s.name, s.statusCategory],
    ),
    [
      ['To Do', 'TODO'],
      ['In Progress', 'IN_PROGRESS'],
      ['Closed', 'DONE'],
      ['Odd', undefined],
    ],
  );
  const done = await listStatusesDataCenter({ jira: jira.fn, statusCategory: 'done' });
  assert.deepEqual(
    done.items.map((s) => s.name),
    ['Closed'],
  );
  const named = await listStatusesDataCenter({ jira: jira.fn, searchString: 'PROG' });
  assert.deepEqual(
    named.items.map((s) => s.name),
    ['In Progress'],
  );

  const refused = createFakeJiraRequest();
  const scoped = await run(listStatusesTool, { projectId: '10000' }, ctxOf(refused));
  assert.equal(scoped.error?.kind, 'validation');
  await assert.rejects(
    listStatusesDataCenter({ jira: refused.fn, expand: 'usages' }),
    (error: unknown) => (error as { kind?: string }).kind === 'validation',
  );
  assert.equal(refused.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The registry and the capabilities report (CC-263)
// ---------------------------------------------------------------------------

const DC_SETTINGS: Settings = {
  ...FAKE_AUTH_SETTINGS,
  authMode: 'pat',
  deployment: 'datacenter',
  datacenterPreview: true,
  site: 'https://jira.corp.example/jira',
  allowedHosts: ['jira.corp.example'],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  metaCacheTtlS: 300,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

const RNG: Rng = () => 0.5;

test('CC-263: on Data Center the registry lists exactly the served tools', () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const selection = selectPackages(manifest, DC_SETTINGS, DATACENTER_API);
  const listed = selection.packages.flatMap((pkg) => pkg.tools.map((tool) => tool.name));
  assert.deepEqual(listed.sort(), [...DATACENTER_TOOLS].sort());
  for (const [name, reason] of selection.excludedTools) {
    assert.equal(reason, 'deployment_unsupported', name);
  }
  // Every manifest tool is either listed or excluded with its reason.
  const total = manifest.reduce((n, pkg) => n + pkg.tools.length, 0);
  assert.equal(listed.length + selection.excludedTools.size, total);

  // The same manifest on Cloud is untouched by the adapter step.
  const cloud = selectPackages(
    manifest,
    { ...DC_SETTINGS, deployment: 'cloud' },
    CLOUD_API,
  );
  assert.equal(cloud.excludedTools.size, 0);
});

test('CC-880: an unserved tool in a disabled package is still deployment_unsupported', async () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const settings: Settings = { ...DC_SETTINGS, toolPackages: ['core'] };
  const selection = selectPackages(manifest, settings, DATACENTER_API);
  // jira_delete_version is never served on the preview; jira_list_boards is.
  assert.equal(
    selection.excludedTools.get('jira_delete_version'),
    'deployment_unsupported',
  );
  assert.equal(selection.excludedTools.get('jira_list_boards'), 'package_disabled');

  const jira = createFakeJiraRequest();
  const registry = createRegistry(manifest, {
    settings,
    jira: jira.fn,
    logger: createFakeLogger(),
    clock: createFakeClock(1_000),
    rng: RNG,
    redactor: createFakeRedactor(),
    api: DATACENTER_API,
  });
  const rendered = await registry.call('jira_delete_version', { versionId: '10000' });
  const text = JSON.stringify(rendered);
  assert.match(text, /not available on Jira Data Center/);
  assert.doesNotMatch(text, /JIRA_TOOL_PACKAGES/);
  assert.equal(jira.calls.length, 0);
});

test('CC-263: calling an unserved tool on Data Center is unsupported and sends nothing', async () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const jira = createFakeJiraRequest();
  const registry = createRegistry(manifest, {
    settings: DC_SETTINGS,
    jira: jira.fn,
    logger: createFakeLogger(),
    clock: createFakeClock(1_000),
    rng: RNG,
    redactor: createFakeRedactor(),
    api: DATACENTER_API,
  });
  // jira_create_version is served since D113; a delete never is on the preview.
  assert.equal(registry.has('jira_delete_version'), false);
  const rendered = await registry.call('jira_delete_version', { versionId: '10000' });
  const text = JSON.stringify(rendered);
  assert.match(text, /unsupported/);
  assert.match(text, /not available on Jira Data Center/);
  assert.equal(jira.calls.length, 0);
});

test('CC-263: capabilities flag the Data Center preview as unverified; Cloud carries no such field', () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const dc = buildCapabilitiesInfo({
    settings: DC_SETTINGS,
    selection: selectPackages(manifest, DC_SETTINGS, DATACENTER_API),
    serverName: 'jira-mcp-ai',
    version: '0.0.0',
  });
  assert.deepEqual(
    { product: dc.deployment?.product, verified: dc.deployment?.verified },
    { product: 'datacenter', verified: false },
  );
  assert.ok((dc.excludedTools ?? []).some((e) => e.reason === 'deployment_unsupported'));

  const cloudSettings: Settings = {
    ...DC_SETTINGS,
    deployment: 'cloud',
    authMode: 'basic',
  };
  const cloud = buildCapabilitiesInfo({
    settings: cloudSettings,
    selection: selectPackages(manifest, cloudSettings),
    serverName: 'jira-mcp-ai',
    version: '0.0.0',
  });
  assert.equal('deployment' in cloud, false);
});

test('CC-275: components and versions are filtered here over the Data Center arrays', async () => {
  const versions = [
    { id: '1', name: '1.0', description: 'first cut', released: true, archived: false },
    { id: '2', name: '2.0', released: false, archived: false },
    { id: '3', name: '0.9', released: true, archived: true },
  ];
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/project/ABC/versions',
    jiraOk(versions),
  );
  const names = async (args: Record<string, unknown>): Promise<string[]> => {
    const result = await run(listVersionsTool, { project: 'ABC', ...args }, ctxOf(jira));
    return (result.data as { versions: { name: string }[] }).versions.map((v) => v.name);
  };
  assert.deepEqual(await names({}), ['1.0', '2.0', '0.9']);
  assert.deepEqual(await names({ status: ['released'] }), ['1.0']);
  // Archived wins over released: 0.9 is archived, not released.
  assert.deepEqual(await names({ status: ['archived'] }), ['0.9']);
  assert.deepEqual(await names({ status: ['unreleased', 'archived'] }), ['2.0', '0.9']);
  assert.deepEqual(await names({ query: 'FIRST' }), ['1.0']);

  const components = createFakeJiraRequest().on(
    'GET /rest/api/2/project/ABC/components',
    jiraOk([
      { id: '1', name: 'Backend', description: 'API' },
      { id: '2', name: 'Web' },
    ]),
  );
  const c = await run(
    listComponentsTool,
    { project: 'ABC', query: 'api' },
    ctxOf(components),
  );
  assert.deepEqual(
    (c.data as { components: { name: string }[] }).components.map((x) => x.name),
    ['Backend'],
  );
  for (const route of [...jira.routes(), ...components.routes()]) {
    assert.match(route, /^GET \/rest\/api\/2\/project\/ABC\/(versions|components)$/);
  }
});

test('CC-275: a watcher list withheld on Data Center stays withheld, not empty', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1/watchers',
    jiraOk({ isWatching: true, watchCount: 4 }),
  );
  const result = await run(listWatchersTool, { issue: 'ABC-1' }, ctxOf(jira));
  const data = result.data as { watchersVisible: boolean; watchCount: number };
  assert.equal(data.watchersVisible, false);
  assert.equal(data.watchCount, 4);
});

// ---------------------------------------------------------------------------
// The adapter's own edges
// ---------------------------------------------------------------------------

test('CC-263: an unserved port member throws unsupported rather than calling Cloud', () => {
  const jira = createFakeJiraRequest();
  for (const call of [
    () => DATACENTER_API.uploadAttachment({ jira: jira.fn } as never),
    () => DATACENTER_API.deleteVersion({ jira: jira.fn } as never),
    () => DATACENTER_API.closeSprint({ jira: jira.fn } as never),
  ]) {
    assert.throws(call, (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'unsupported');
      assert.match((error as Error).message, /not available on Jira Data Center/);
      return true;
    });
  }
  assert.equal(jira.calls.length, 0);
  // Every served member is a real implementation, not a stub.
  for (const name of Object.keys(CLOUD_API).filter((key) => key !== 'deployment')) {
    assert.equal(
      typeof (DATACENTER_API as unknown as Record<string, unknown>)[name],
      'function',
      name,
    );
  }
  assert.ok(Object.isFrozen(DATACENTER_API));
});

test('CC-263: adapterFor picks the adapter by deployment', () => {
  assert.equal(adapterFor('cloud'), CLOUD_API);
  assert.equal(adapterFor('datacenter'), DATACENTER_API);
  assert.equal(CLOUD_API.serves, undefined);
});

test('CC-268: a Data Center list endpoint answering a non-array is an unexpected shape', async () => {
  for (const [route, call] of [
    [
      'GET /rest/api/2/project',
      (fn: FakeJiraRequest['fn']) => listProjectsDataCenter({ jira: fn }),
    ],
    [
      'GET /rest/api/2/status',
      (fn: FakeJiraRequest['fn']) => listStatusesDataCenter({ jira: fn }),
    ],
    [
      'GET /rest/api/2/project/ABC/components',
      (fn: FakeJiraRequest['fn']) =>
        DATACENTER_API.listComponents({ jira: fn, project: 'ABC' }),
    ],
    [
      'GET /rest/api/2/project/ABC/versions',
      (fn: FakeJiraRequest['fn']) =>
        DATACENTER_API.listVersions({ jira: fn, project: 'ABC' }),
    ],
    [
      'POST /rest/api/2/search',
      (fn: FakeJiraRequest['fn']) => DATACENTER_API.searchIssues({ jira: fn, jql: 'x' }),
    ],
  ] as const) {
    const jira = createFakeJiraRequest().on(
      route,
      jiraOk({ issues: 'nope', values: [] }),
    );
    await assert.rejects(call(jira.fn), (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'unexpected_shape', route);
      return true;
    });
  }
  const notObject = createFakeJiraRequest().on('POST /rest/api/2/search', jiraOk('html'));
  await assert.rejects(
    DATACENTER_API.searchIssues({ jira: notObject.fn, jql: 'x' }),
    (error: unknown) => (error as { kind?: string }).kind === 'unexpected_shape',
  );
});

test('CC-270: jira_get_myself on Data Center omits what the site did not send', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/myself',
    jiraOk({ key: 'JIRAUSER1' }),
  );
  const result = await run(getMyselfTool, {}, ctxOf(jira));
  assert.deepEqual(result.data, { key: 'JIRAUSER1' });
});

// ---------------------------------------------------------------------------
// The Data Center user reads (D110, stage 13.5a)
// ---------------------------------------------------------------------------

test('CC-307: jira_search_users on Data Center sends username, never query, and answers by name', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/user/search',
    jiraOk([DC_USER, { ...DC_USER, name: 'jroe', key: 'JIRAUSER10101', active: false }]),
  );
  const result = await run(searchUsersTool, { query: ' jdoe ' }, ctxOf(jira));

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(jira.routes(), ['GET /rest/api/2/user/search']);
  assert.deepEqual(jira.calls[0]?.query, {
    username: 'jdoe',
    startAt: 0,
    maxResults: 50,
  });
  const data = result.data as { users: unknown[]; scope: string; emailIncluded: boolean };
  assert.deepEqual(data.users, [
    PROJECTED_USER,
    { name: 'jroe', key: 'JIRAUSER10101', displayName: 'Jane Doe', active: false },
  ]);
  assert.equal(data.scope, 'query');
  assert.equal(data.emailIncluded, false);
});

test('CC-308: issue or project switch Data Center to the assignable search, and issue wins', async () => {
  const cases: readonly [Record<string, unknown>, Record<string, unknown>][] = [
    [
      { query: 'jdoe', project: 'ABC' },
      { username: 'jdoe', project: 'ABC' },
    ],
    [
      { query: 'jdoe', issue: 'ABC-1' },
      { username: 'jdoe', issueKey: 'ABC-1' },
    ],
    [
      { query: 'jdoe', issue: 'ABC-1', project: 'ABC' },
      { username: 'jdoe', issueKey: 'ABC-1' },
    ],
  ];
  for (const [args, sent] of cases) {
    const jira = createFakeJiraRequest().on(
      'GET /rest/api/2/user/assignable/search',
      jiraOk([DC_USER]),
    );
    const result = await run(searchUsersTool, args, ctxOf(jira));
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(jira.routes(), ['GET /rest/api/2/user/assignable/search']);
    assert.deepEqual(jira.calls[0]?.query, { ...sent, startAt: 0, maxResults: 50 });
    const data = result.data as { users: unknown[]; scope: string };
    assert.equal(data.scope, 'assignable');
    assert.deepEqual(data.users, [PROJECTED_USER]);
  }
});

test('CC-309: includeEmail on Data Center is refused as validation before any request', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/user/search',
    jiraOk([DC_USER]),
  );
  const result = await run(
    searchUsersTool,
    { query: 'jdoe', includeEmail: true },
    ctxOf(jira),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(result.error?.message ?? '', /includeEmail/);
  assert.equal(jira.calls.length, 0);

  // includeEmail: false is simply the default, and is served.
  const served = await run(
    searchUsersTool,
    { query: 'jdoe', includeEmail: false },
    ctxOf(jira),
  );
  assert.equal(served.ok, true, JSON.stringify(served.error));
});

test('CC-310: a user-search row that is not a Data Center user is unexpected_shape, never passed through', async () => {
  const rows: readonly unknown[] = [
    // A Cloud row: an accountId on a Data Center site is not something to trust.
    {
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'Jane Doe',
      emailAddress: EMAIL,
    },
    // Neither name nor key.
    { displayName: 'Jane Doe', emailAddress: EMAIL },
    'jdoe',
  ];
  for (const row of rows) {
    const jira = createFakeJiraRequest().on('GET /rest/api/2/user/search', jiraOk([row]));
    const result = await run(searchUsersTool, { query: 'jdoe' }, ctxOf(jira));
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.equal(result.error?.kind, 'unexpected_shape');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(EMAIL));
  }
});

test('CC-311: Data Center role actors carry the user name and no accountId; groups are as on Cloud', async () => {
  // The fake matches by prefix, so the detail route is registered first.
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/2/project/ABC/role/10002', jiraOk(DC_ROLE))
    .on(
      'GET /rest/api/2/project/ABC/role',
      jiraOk({
        Developers: 'https://jira.corp.example/jira/rest/api/2/project/ABC/role/10001',
        Administrators:
          'https://jira.corp.example/jira/rest/api/2/project/ABC/role/10002',
      }),
    );

  const list = await run(listProjectRolesTool, { project: 'ABC' }, ctxOf(jira));
  assert.equal(list.ok, true, JSON.stringify(list.error));
  assert.deepEqual((list.data as { roles: unknown }).roles, [
    { id: '10002', name: 'Administrators' },
    { id: '10001', name: 'Developers' },
  ]);

  const detail = await run(
    listProjectRolesTool,
    { project: 'ABC', roleId: '10002' },
    ctxOf(jira),
  );
  assert.equal(detail.ok, true, JSON.stringify(detail.error));
  assert.deepEqual((detail.data as { actors: unknown }).actors, [
    { type: 'atlassian-user-role-actor', name: 'jdoe', displayName: 'Jane Doe' },
    { type: 'atlassian-group-role-actor', displayName: 'jira-administrators' },
  ]);
  assert.deepEqual(jira.routes(), [
    'GET /rest/api/2/project/ABC/role',
    'GET /rest/api/2/project/ABC/role/10002',
  ]);
});

test('CC-311: the Cloud role read is untouched — a user actor keeps its accountId, a name is not read', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/project/ABC/role/10002',
    jiraOk({
      ...DC_ROLE,
      actors: [
        {
          id: 10240,
          displayName: 'Jane Doe',
          type: 'atlassian-user-role-actor',
          name: 'jdoe',
          actorUser: { accountId: '5b10a2844c20165700ede21g' },
        },
      ],
    }),
  );
  const result = await run(
    listProjectRolesTool,
    { project: 'ABC', roleId: '10002' },
    ctxOf(jira, CLOUD_API),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual((result.data as { actors: unknown }).actors, [
    {
      type: 'atlassian-user-role-actor',
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'Jane Doe',
    },
  ]);
});

// ---------------------------------------------------------------------------
// Count, changelog and attachment reads (D114, stage 13.6c)
// ---------------------------------------------------------------------------

test('[CC-340] jira_count on Data Center is the classic search total, labelled exact, with no approximate hint', async () => {
  const jira = createFakeJiraRequest().on(
    'POST /rest/api/2/search',
    jiraOk({ startAt: 0, maxResults: 0, total: 7, issues: [] }),
  );
  const result = await run(countTool, { jql: 'project = ABC' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data, { count: 7, approximate: false });
  assert.equal(hintCodes(result).includes('approximate'), false);
  assert.equal(jira.calls.length, 1);
  const body = jira.calls[0]?.body as Record<string, unknown>;
  assert.equal(body.jql, 'project = ABC');
  assert.equal(body.maxResults, 0, 'the count fetches no issues');
  assert.equal(body.startAt, 0);
  assert.equal(jira.calls[0]?.root, 'v2');
});

test('[CC-340] jira_count on Cloud is untouched — the approximate-count route, approximate true and the hint', async () => {
  const jira = createFakeJiraRequest().on(
    'POST /rest/api/3/search/approximate-count',
    jiraOk({ count: 7 }),
  );
  const result = await run(countTool, { jql: 'project = ABC' }, ctxOf(jira, CLOUD_API));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data, { count: 7, approximate: true });
  assert.equal(hintCodes(result).includes('approximate'), true);
});

test('[CC-341] a Data Center search that answers without a non-negative integer total is unexpected_shape, never a count', async () => {
  for (const total of [undefined, -1, 1.5, '7', null]) {
    const jira = createFakeJiraRequest().on(
      'POST /rest/api/2/search',
      jiraOk({ startAt: 0, maxResults: 0, total, issues: [] }),
    );
    const result = await run(countTool, { jql: 'project = ABC' }, ctxOf(jira));
    assert.equal(result.ok, false, String(total));
    assert.equal(result.error?.kind, 'unexpected_shape', String(total));
  }
});

test('[CC-342] jira_get_changelog on Data Center reads the embedded changelog on v2 and pages inside it', async () => {
  const histories = [1, 2, 3, 4, 5].map(dcHistory);
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1',
    jiraOk({ ...ISSUE, changelog: { startAt: 0, maxResults: 5, total: 5, histories } }),
  );
  const result = await run(
    getChangelogTool,
    { issue: 'ABC-1', startAt: 1, maxResults: 2 },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(
    (data.histories as { id: string }[]).map((h) => h.id),
    ['2', '3'],
  );
  assert.equal(data.total, 5);
  assert.equal(data.partial, true);
  assert.equal(data.nextStartAt, 3);
  assert.equal(data.incomplete, undefined, 'a whole embedded history is complete');
  assert.equal(jira.calls[0]?.root, 'v2');
  assert.deepEqual(jira.calls[0]?.query, { expand: 'changelog', fields: '' });
  // Items pass through as Jira sent them.
  const [first] = data.histories as { items: unknown[] }[];
  assert.deepEqual(first?.items[0], (histories[1] as { items: unknown[] }).items[0]);
});

test('[CC-343] a Data Center changelog embedded short of its total is flagged incomplete, and paging stops at the window', async () => {
  const histories = [1, 2].map(dcHistory);
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1',
    jiraOk({ ...ISSUE, changelog: { startAt: 0, maxResults: 2, total: 150, histories } }),
  );
  const result = await run(getChangelogTool, { issue: 'ABC-1' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as Record<string, unknown>;
  assert.equal((data.histories as unknown[]).length, 2);
  assert.equal(data.total, 150);
  assert.equal(data.partial, false, 'nothing past the embedded window is reachable');
  assert.equal(data.nextStartAt, undefined);
  const incomplete = data.incomplete as Record<string, unknown>;
  assert.equal(incomplete.reachableStartAt, 0);
  assert.equal(incomplete.reachableEndAt, 2);
  assert.equal(incomplete.total, 150);
  assert.match(String(incomplete.note), /^INCOMPLETE: /);
  assert.match(String(incomplete.note), /150 change histories/);
});

test('[CC-343] a startAt past the embedded window answers an empty page, still flagged incomplete', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1',
    jiraOk({
      ...ISSUE,
      changelog: {
        startAt: 0,
        maxResults: 2,
        total: 150,
        histories: [1, 2].map(dcHistory),
      },
    }),
  );
  const result = await run(
    getChangelogTool,
    { issue: 'ABC-1', startAt: 100 },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(data.histories, []);
  assert.ok(data.incomplete);
});

test('[CC-344] a Data Center issue read with no embedded changelog is unexpected_shape, never an empty history', async () => {
  for (const changelog of [undefined, null, [], { histories: 'x' }]) {
    const jira = createFakeJiraRequest().on(
      'GET /rest/api/2/issue/ABC-1',
      jiraOk({ ...ISSUE, changelog }),
    );
    const result = await run(getChangelogTool, { issue: 'ABC-1' }, ctxOf(jira));
    assert.equal(result.ok, false, JSON.stringify(changelog));
    assert.equal(result.error?.kind, 'unexpected_shape', JSON.stringify(changelog));
  }
});

test('[CC-345] jira_list_attachments on Data Center strips the URLs and projects the author by name/key', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1',
    jiraOk({ key: 'ABC-1', fields: { attachment: [DC_ATTACHMENT] } }),
  );
  const result = await run(listAttachmentsTool, { issue: 'ABC-1' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls[0]?.root, 'v2');
  assert.deepEqual(jira.calls[0]?.query, { fields: 'attachment' });
  const data = result.data as { attachments: Record<string, unknown>[]; count: number };
  assert.equal(data.count, 1);
  const [row] = data.attachments;
  assert.equal(row?.id, '60001');
  assert.equal(row?.filename, 'a.txt');
  assert.deepEqual(row?.author, {
    name: 'jdoe',
    key: 'JIRAUSER10100',
    displayName: 'Jane Doe',
  });
  const text = JSON.stringify(result.data);
  assert.doesNotMatch(
    text,
    /secure\/attachment|secure\/thumbnail|rest\/api\/2\/attachment/,
  );
  assert.doesNotMatch(text, new RegExp(EMAIL));
});

test('[CC-346] a Data Center attachment author carrying an accountId is dropped, not passed through', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/issue/ABC-1',
    jiraOk({
      key: 'ABC-1',
      fields: {
        attachment: [
          {
            ...DC_ATTACHMENT,
            author: { ...DC_USER, accountId: '5b10a2844c20165700ede21g' },
          },
        ],
      },
    }),
  );
  const result = await run(listAttachmentsTool, { issue: 'ABC-1' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const [row] = (result.data as { attachments: Record<string, unknown>[] }).attachments;
  assert.equal(row?.author, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /accountId/);
});

test('[CC-346] jira_list_attachments on Cloud is untouched — v3, no root, the accountId author', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/issue/ABC-1',
    jiraOk({
      key: 'ABC-1',
      fields: {
        attachment: [
          {
            ...DC_ATTACHMENT,
            author: { accountId: '5b10a2844c20165700ede21g', displayName: 'Jane Doe' },
          },
        ],
      },
    }),
  );
  const result = await run(
    listAttachmentsTool,
    { issue: 'ABC-1' },
    ctxOf(jira, CLOUD_API),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls[0]?.root, undefined);
  const [row] = (result.data as { attachments: Record<string, unknown>[] }).attachments;
  assert.deepEqual(row?.author, {
    accountId: '5b10a2844c20165700ede21g',
    displayName: 'Jane Doe',
  });
});

test('[CC-347] jira_upload_attachment stays unserved on Data Center (amended by D117: the download is served)', () => {
  // Filters left this list with D115 (stage 13.7a, CC-350…CC-359),
  // jira_get_create_meta with D116 (stage 13.7b, CC-360…CC-365) and
  // jira_download_attachment with D117 (stage 13.8, CC-370…CC-377). The upload
  // stays: no served tool can remove an attachment it would create (D109).
  assert.equal(DATACENTER_TOOLS.has('jira_upload_attachment'), false);
  assert.throws(
    () => DATACENTER_API.uploadAttachment({ jira: createFakeJiraRequest().fn } as never),
    (error: unknown) => (error as { kind?: string }).kind === 'unsupported',
  );
  for (const name of [
    'jira_count',
    'jira_get_changelog',
    'jira_list_attachments',
    'jira_download_attachment',
  ]) {
    assert.equal(DATACENTER_TOOLS.has(name), true, name);
  }
});

// ---------------------------------------------------------------------------
// The saved filters (D115, stage 13.7a)
// ---------------------------------------------------------------------------

interface FilterListShape {
  filters: Record<string, unknown>[];
  count: number;
  paging: Record<string, unknown>;
  filterName?: string;
  scope?: { source: string; note: string };
}

test('[CC-350] jira_list_filters on Data Center reads the favourites on v2 in one request, and says so', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/filter/favourite',
    jiraOk([DC_FILTER]),
  );
  const result = await run(listFiltersTool, {}, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(jira.routes(), ['GET /rest/api/2/filter/favourite']);
  assert.equal(jira.calls[0]?.root, 'v2');
  // Nothing Cloud-shaped rides along: no expand, no paging params, no owner.
  assert.equal(jira.calls[0]?.query, undefined);
  const data = result.data as FilterListShape;
  assert.equal(data.count, 1);
  assert.deepEqual(data.filters[0], {
    id: '10000',
    name: 'My open issues',
    description: 'Saved for the stand-up',
    owner: { name: 'jdoe', key: 'JIRAUSER10100', displayName: 'Jane Doe', active: true },
    jql: 'assignee = currentUser() AND resolution = Unresolved',
    favourite: true,
  });
  assert.equal(data.scope?.source, 'favourites');
  assert.match(data.scope?.note ?? '', /^SCOPE: .*FAVOURITE filters/);
  assert.equal(data.paging['partial'], false);
  assert.equal(data.paging['total'], 1);
});

test('[CC-350] jira_get_filter on Data Center reads /filter/{id} on v2 with the Data Center owner', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/filter/10000',
    jiraOk(DC_FILTER),
  );
  const result = await run(getFilterTool, { filterId: '10000' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls[0]?.root, 'v2');
  assert.equal(jira.calls[0]?.pathTemplate, '/filter/{id}');
  const filter = (result.data as { filter: Record<string, unknown> }).filter;
  assert.deepEqual(filter['owner'], PROJECTED_USER);
  assert.equal(filter['jql'], 'assignee = currentUser() AND resolution = Unresolved');
});

test('[CC-351] filterName is applied client-side on Data Center, case-insensitively, and echoed', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/filter/favourite',
    jiraOk([
      DC_FILTER,
      dcFilter('10001', 'Escalations board'),
      dcFilter('10002', 'Reopened last week'),
    ]),
  );
  const result = await run(listFiltersTool, { filterName: 'OPEN' }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls[0]?.query, undefined, 'the name never reaches Jira');
  const data = result.data as FilterListShape;
  assert.deepEqual(
    data.filters.map((filter) => filter['id']),
    ['10000', '10002'],
  );
  assert.equal(data.filterName, 'OPEN');
  assert.equal(data.paging['total'], 2);

  // A blank name is refused before any request, exactly as on Cloud (CC-430).
  assert.equal(listFiltersTool.input.safeParse({ filterName: '   ' }).success, false);
});

test('[CC-352] maxResults and startAt page the favourites client-side, with Cloud paging semantics', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/2/filter/favourite',
    jiraOk([DC_FILTER, dcFilter('10001', 'Two'), dcFilter('10002', 'Three')]),
  );
  const first = await run(listFiltersTool, { maxResults: 2 }, ctxOf(jira));
  const page1 = first.data as FilterListShape;
  assert.deepEqual(
    page1.filters.map((filter) => filter['id']),
    ['10000', '10001'],
  );
  assert.equal(page1.paging['partial'], true);
  assert.equal(page1.paging['stopReason'], 'max_pages');
  assert.equal(page1.paging['nextStartAt'], 2);
  assert.equal(page1.paging['total'], 3);
  assert.match(String(page1.paging['note']), /^INCOMPLETE/);

  const second = await run(listFiltersTool, { maxResults: 2, startAt: 2 }, ctxOf(jira));
  const page2 = second.data as FilterListShape;
  assert.deepEqual(
    page2.filters.map((filter) => filter['id']),
    ['10002'],
  );
  assert.equal(page2.paging['partial'], false);
  assert.equal(page2.paging['nextStartAt'], undefined);
});

test('[CC-353] accountId is refused on Data Center as validation, before any request', async () => {
  const jira = createFakeJiraRequest();
  const result = await run(listFiltersTool, { accountId: STRAY_ACCOUNT_ID }, ctxOf(jira));
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(String(result.error?.message), /no accountIds/);
  assert.equal(jira.calls.length, 0);
});

test('[CC-354] a malformed favourites list or filter is unexpected_shape on Data Center', async () => {
  for (const body of [
    { values: [DC_FILTER] },
    [DC_FILTER, 'not a filter'],
    [{ ...DC_FILTER, name: undefined }],
    [{ ...DC_FILTER, id: undefined }],
  ]) {
    const jira = createFakeJiraRequest().on(
      'GET /rest/api/2/filter/favourite',
      jiraOk(body),
    );
    const result = await run(listFiltersTool, {}, ctxOf(jira));
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error?.kind, 'unexpected_shape', JSON.stringify(body));
  }
  const jira = createFakeJiraRequest().on('GET /rest/api/2/filter/10000', jiraOk([]));
  const result = await run(getFilterTool, { filterId: 10000 }, ctxOf(jira));
  assert.equal(result.error?.kind, 'unexpected_shape');
});

test('[CC-355] a Data Center filter owner carrying an accountId is dropped, and no share internals are reported', async () => {
  const owned = { ...DC_FILTER, owner: { ...DC_USER, accountId: STRAY_ACCOUNT_ID } };
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/2/filter/favourite', jiraOk([owned]))
    .on('GET /rest/api/2/filter/10000', jiraOk(owned));
  const list = await run(listFiltersTool, {}, ctxOf(jira));
  const get = await run(getFilterTool, { filterId: 10000 }, ctxOf(jira));
  const listed = (list.data as FilterListShape).filters[0];
  const read = (get.data as { filter: Record<string, unknown> }).filter;
  assert.equal(listed?.['owner'], undefined);
  assert.equal(read['owner'], undefined);
  for (const data of [list.data, get.data]) {
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /accountId/);
    assert.doesNotMatch(text, /sharePermissions|editPermissions|subscriptions/);
    assert.doesNotMatch(text, /secret-share-group/);
    assert.doesNotMatch(text, /viewUrl|searchUrl/);
  }
});

test('[CC-356] jira_list_filters and jira_get_filter on Cloud are untouched — /filter/search on v3, no scope', async () => {
  const cloudFilter = {
    ...DC_FILTER,
    owner: { accountId: STRAY_ACCOUNT_ID, displayName: 'Jane Doe' },
  };
  const jira = createFakeJiraRequest()
    .on(
      'GET /rest/api/3/filter/search',
      jiraOk({
        startAt: 0,
        maxResults: 50,
        total: 1,
        isLast: true,
        values: [cloudFilter],
      }),
    )
    .on('GET /rest/api/3/filter/10000', jiraOk(cloudFilter));
  const list = await run(
    listFiltersTool,
    { filterName: 'open', accountId: STRAY_ACCOUNT_ID },
    ctxOf(jira, CLOUD_API),
  );
  assert.equal(list.ok, true, JSON.stringify(list.error));
  assert.equal(jira.calls[0]?.root, undefined);
  assert.deepEqual(jira.calls[0]?.query, {
    startAt: 0,
    maxResults: 50,
    expand: 'description,owner,jql',
    filterName: 'open',
    accountId: STRAY_ACCOUNT_ID,
  });
  const data = list.data as FilterListShape;
  assert.equal(data.scope, undefined);
  assert.deepEqual(data.filters[0]?.['owner'], {
    accountId: STRAY_ACCOUNT_ID,
    displayName: 'Jane Doe',
  });

  const get = await run(getFilterTool, { filterId: 10000 }, ctxOf(jira, CLOUD_API));
  assert.equal(jira.calls[1]?.root, undefined);
  assert.deepEqual((get.data as { filter: Record<string, unknown> }).filter['owner'], {
    accountId: STRAY_ACCOUNT_ID,
    displayName: 'Jane Doe',
  });
});

test('[CC-357] a filter NAME passed as filterId is refused on Data Center before any request', async () => {
  const jira = createFakeJiraRequest();
  const result = await run(getFilterTool, { filterId: 'My open issues' }, ctxOf(jira));
  assert.equal(result.error?.kind, 'validation');
  assert.match(String(result.error?.remediation), /jira_list_filters/);
  assert.equal(jira.calls.length, 0);
  assert.equal(DATACENTER_TOOLS.has('jira_list_filters'), true);
  assert.equal(DATACENTER_TOOLS.has('jira_get_filter'), true);
});

// --- D116 (stage 13.7b): the create metadata over the paged 8.4+ routes -----

test('[CC-360] jira_get_create_meta on Data Center lists issue types from `values` on v2, paging on isLast', async () => {
  const [task, subtask] = DC_ISSUE_TYPE_ROWS;
  const jira = createFakeJiraRequest()
    .on(
      (req) =>
        req.path === '/issue/createmeta/ABC/issuetypes' && req.query?.startAt === 0,
      jiraOk({ ...dcValues([task], 0, false, 2), maxResults: 1 }),
    )
    .on(
      (req) =>
        req.path === '/issue/createmeta/ABC/issuetypes' && req.query?.startAt === 1,
      jiraOk({ ...dcValues([subtask], 1, true, 2), maxResults: 1 }),
    );
  const result = await run(getCreateMetaTool, { project: 'ABC' }, ctxOf(jira));

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls.length, 2);
  for (const call of jira.calls) assert.equal(call.root, 'v2');
  assert.deepEqual(jira.routes(), [
    'GET /rest/api/2/issue/createmeta/ABC/issuetypes',
    'GET /rest/api/2/issue/createmeta/ABC/issuetypes',
  ]);
  const data = result.data as {
    step: string;
    issueTypes: { id: string }[];
    count: number;
  };
  assert.equal(data.step, 'choose_issue_type');
  assert.deepEqual(
    data.issueTypes.map((row) => row.id),
    ['10001', '10003'],
  );
  assert.equal(data.count, 2);
});

test('[CC-361] the Data Center create screen keeps schema, operations and allowed values, and leaks no user identity', async () => {
  const jira = createFakeJiraRequest().on(
    DC_CREATE_META_SCREEN,
    jiraOk(dcValues(DC_CREATE_META_FIELDS)),
  );
  const result = await run(
    getCreateMetaTool,
    { project: 'ABC', issueTypeId: '10001' },
    ctxOf(jira),
  );

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(jira.calls[0]?.root, 'v2');
  const data = result.data as {
    step: string;
    complete: boolean;
    fields: Record<string, unknown>[];
    required: { fieldId: string }[];
  };
  assert.equal(data.step, 'create_screen');
  assert.equal(data.complete, true);
  assert.deepEqual(
    data.required.map((field) => field.fieldId),
    ['summary', 'reporter'],
  );
  const severity = data.fields.find((field) => field.fieldId === 'customfield_10300');
  assert.equal(severity?.schemaType, 'option');
  assert.deepEqual(severity?.operations, ['set']);
  assert.deepEqual(severity?.allowedValues, [
    { id: '10400', value: 'Minor' },
    { id: '10401', value: 'Major' },
  ]);
  // The user allowed value keeps its username — what a DC write takes — and
  // nothing else; no field carries the reporter default.
  const approver = data.fields.find((field) => field.fieldId === 'customfield_10200');
  assert.deepEqual(approver?.allowedValues, [{ name: 'jdoe' }]);
  for (const field of data.fields) assert.equal('defaultValue' in field, false);
  const text = JSON.stringify(result.data);
  assert.doesNotMatch(text, new RegExp(EMAIL), 'an email address leaked');
  assert.doesNotMatch(text, /JIRAUSER10100/, 'a user key leaked');
  assert.doesNotMatch(text, /avatarUrls|useravatar/, 'an avatar leaked');
  assert.doesNotMatch(text, /accountId/, 'a Cloud identity was invented');
});

test('[CC-362] a bare 404 from the paged create metadata is unsupported and names Data Center 8.4; the legacy route is never tried', async () => {
  for (const [args, template] of [
    [{ project: 'ABC' }, '/issue/createmeta/{projectIdOrKey}/issuetypes'],
    [
      { project: 'ABC', issueTypeId: '10001' },
      '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
    ],
  ] as const) {
    const jira = createFakeJiraRequest().on(
      /^GET \/rest\/api\/2\/issue\/createmeta\/ABC\/issuetypes/,
      jiraErr(notFound404(template)),
    );
    const result = await run(getCreateMetaTool, args, ctxOf(jira));
    assert.equal(result.ok, false, template);
    assert.equal(result.error?.kind, 'unsupported', template);
    assert.match(
      `${String(result.error?.message)} ${String(result.error?.remediation)}`,
      /Jira Data Center 8\.4 or later/,
    );
    // One request, to the paged route; never the removed all-projects route.
    assert.equal(jira.calls.length, 1, template);
    for (const route of jira.routes()) {
      assert.doesNotMatch(route, /\/issue\/createmeta(\?|$)/, route);
    }
    assert.equal(
      jira.calls.some((call) => call.query?.expand !== undefined),
      false,
      template,
    );
  }
});

test('[CC-363] a 404 carrying Jira messages stays not_found with the 8.4 hint; other failures pass through', async () => {
  const jira = createFakeJiraRequest().on(
    DC_CREATE_META_SCREEN,
    jiraErr(
      notFound404('/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}', [
        'Issue type with id 10001 does not exist or is not valid for the project.',
      ]),
    ),
  );
  const result = await run(
    getCreateMetaTool,
    { project: 'ABC', issueTypeId: '10001' },
    ctxOf(jira),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'not_found');
  assert.match(String(result.error?.message), /Issue type with id 10001 does not exist/);
  assert.match(String(result.error?.remediation), /Jira Data Center 8\.4/);

  const denied = createFakeJiraRequest().on(
    DC_CREATE_META_TYPES,
    jiraErr(
      errorFromResponse({
        status: 403,
        method: 'GET',
        pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes',
        body: { errorMessages: ['You do not have permission.'], errors: {} },
      }),
    ),
  );
  const refused = await run(getCreateMetaTool, { project: 'ABC' }, ctxOf(denied));
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.kind, 'permission');
  assert.doesNotMatch(String(refused.error?.remediation), /8\.4/);
});

test('[CC-380] a pre-8.4 host\'s Jersey "null for uri" 404 on the paged create metadata is unsupported, not not_found', async () => {
  // A host without the 8.4 route answers the unmatched path from the REST
  // framework, not from Jira: `{"message":"null for uri: …","status-code":404}`.
  // That `message` says nothing about the project or the issue type.
  for (const [args, template, uri] of [
    [
      { project: 'ABC' },
      '/issue/createmeta/{projectIdOrKey}/issuetypes',
      'https://jira.corp.example/rest/api/2/issue/createmeta/ABC/issuetypes',
    ],
    [
      { project: 'ABC', issueTypeId: '10001' },
      '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
      'https://jira.corp.example/rest/api/2/issue/createmeta/ABC/issuetypes/10001',
    ],
  ] as const) {
    const jira = createFakeJiraRequest().on(
      /^GET \/rest\/api\/2\/issue\/createmeta\/ABC\/issuetypes/,
      jiraErr(
        errorFromResponse({
          status: 404,
          method: 'GET',
          pathTemplate: template,
          body: { message: `null for uri: ${uri}`, 'status-code': 404 },
        }),
      ),
    );
    const result = await run(getCreateMetaTool, args, ctxOf(jira));
    assert.equal(result.ok, false, template);
    assert.equal(result.error?.kind, 'unsupported', template);
    assert.match(
      `${String(result.error?.message)} ${String(result.error?.remediation)}`,
      /Jira Data Center 8\.4 or later/,
      template,
    );
    assert.equal(jira.calls.length, 1, template);
  }
});

test('[CC-364] a Data Center create-metadata page without a `values` array is unexpected_shape, never an empty list', async () => {
  const cases: readonly [Record<string, unknown>, RegExp, Record<string, unknown>][] = [
    // The Cloud shape: rows under `issueTypes` / `fields`, not `values`.
    [
      { project: 'ABC' },
      DC_CREATE_META_TYPES,
      { startAt: 0, maxResults: 50, total: 2, issueTypes: DC_ISSUE_TYPE_ROWS },
    ],
    [
      { project: 'ABC', issueTypeId: '10001' },
      DC_CREATE_META_SCREEN,
      { startAt: 0, maxResults: 50, total: 4, fields: DC_CREATE_META_FIELDS },
    ],
    [{ project: 'ABC' }, DC_CREATE_META_TYPES, { ...dcValues([]), values: 'none' }],
  ];
  for (const [args, route, body] of cases) {
    const jira = createFakeJiraRequest().on(route, jiraOk(body));
    const result = await run(getCreateMetaTool, args, ctxOf(jira));
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error?.kind, 'unexpected_shape', JSON.stringify(body));
  }
});

test('[CC-365] jira_get_create_meta on Cloud is untouched — v3, no root, `issueTypes` and `fields`', async () => {
  const jira = createFakeJiraRequest()
    .on(
      /^GET \/rest\/api\/3\/issue\/createmeta\/ABC\/issuetypes$/,
      jiraOk({
        startAt: 0,
        maxResults: 50,
        total: 1,
        issueTypes: [DC_ISSUE_TYPE_ROWS[0]],
      }),
    )
    .on(
      /^GET \/rest\/api\/3\/issue\/createmeta\/ABC\/issuetypes\/10001$/,
      jiraOk({
        startAt: 0,
        maxResults: 50,
        total: 1,
        fields: [DC_CREATE_META_FIELDS[0]],
      }),
    );
  const types = await run(getCreateMetaTool, { project: 'ABC' }, ctxOf(jira, CLOUD_API));
  const screen = await run(
    getCreateMetaTool,
    { project: 'ABC', issueTypeId: '10001' },
    ctxOf(jira, CLOUD_API),
  );
  assert.equal(types.ok, true, JSON.stringify(types.error));
  assert.equal(screen.ok, true, JSON.stringify(screen.error));
  for (const call of jira.calls) assert.equal(call.root, undefined);
  assert.equal((screen.data as { count: number }).count, 1);

  // A Cloud 404 is not re-aimed at a Data Center version floor.
  const missing = createFakeJiraRequest().on(
    /^GET \/rest\/api\/3\/issue\/createmeta/,
    jiraErr(notFound404('/issue/createmeta/{projectIdOrKey}/issuetypes')),
  );
  const result = await run(
    getCreateMetaTool,
    { project: 'ABC' },
    ctxOf(missing, CLOUD_API),
  );
  assert.equal(result.error?.kind, 'not_found');
  assert.doesNotMatch(String(result.error?.remediation), /8\.4/);
});

test('[CC-1548] jira_get_issue refuses issues: [...] on Data Center before sending', async () => {
  const jira = createFakeJiraRequest();
  const result = await run(getIssueTool, { issues: ['ABC-1', 'ABC-2'] }, ctxOf(jira));
  assert.equal(result.error?.kind, 'validation');
  assert.match(String(result.error?.message), /Cloud only/);
  assert.equal(jira.calls.length, 0);
});
