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
import { DATACENTER_API, DATACENTER_TOOLS } from '../api/datacenter.js';
import { listProjectsDataCenter, listStatusesDataCenter } from '../api/meta.js';
import { CLOUD_API } from '../api/port.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createFakeRedactor,
  jiraOk,
} from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import type { Rng, Settings } from '../core/types.js';
import { createRegistry, selectPackages } from '../mcp/registry.js';
import type { AnyToolSpec, ToolCtx, ToolResult } from '../mcp/types.js';
import { getSprintIssuesTool, listBoardsTool, listSprintsTool } from './agile.js';
import { getMyselfTool } from './core.js';
import { buildCapabilitiesInfo, createPackages } from './index.js';
import {
  getCommentsTool,
  getIssueTool,
  getTransitionsTool,
  getWorklogsTool,
} from './issues.js';
import {
  getProjectTool,
  listFieldsTool,
  listLinkTypesTool,
  listProjectsTool,
  listStatusesTool,
} from './meta.js';
import { searchTool } from './search.js';

const EMAIL = 'jdoe@corp.example';

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

const CASES: readonly Case[] = [
  {
    tool: getMyselfTool,
    args: {},
    routes: [['GET /rest/api/2/myself', { ...DC_USER, locale: 'en_US' }]],
    hasUser: true,
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
];

test('CC-265: the case table covers every tool the adapter serves but capabilities', () => {
  const covered = new Set(CASES.map((c) => c.tool.name));
  const served = [...DATACENTER_TOOLS].filter((name) => name !== 'jira_capabilities');
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

test('CC-265: wiki markup comes back as Jira sent it, not rendered or re-labelled', async () => {
  const jira = createFakeJiraRequest().on('GET /rest/api/2/issue/ABC-1', jiraOk(ISSUE));
  const result = await run(getIssueTool, { issue: 'ABC-1' }, ctxOf(jira));
  const fields = (result.data as { fields: Record<string, unknown> }).fields;
  assert.equal(fields.description, 'h1. Steps\n*Bold* and {{code}}');
  assert.deepEqual(fields.reporter, PROJECTED_USER);
  // Not a user: a project has key + name but no displayName.
  assert.deepEqual(fields.project, ISSUE.fields.project);
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
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
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
  assert.equal(registry.has('jira_create_issue'), false);
  const rendered = await registry.call('jira_create_issue', {
    project: 'ABC',
    summary: 'x',
  });
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

// ---------------------------------------------------------------------------
// The adapter's own edges
// ---------------------------------------------------------------------------

test('CC-263: an unserved port member throws unsupported rather than calling Cloud', () => {
  const jira = createFakeJiraRequest();
  for (const call of [
    () => DATACENTER_API.createIssue({ jira: jira.fn } as never),
    () => DATACENTER_API.searchUsers({ jira: jira.fn } as never),
    () => DATACENTER_API.adfFromMarkdown('x'),
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
