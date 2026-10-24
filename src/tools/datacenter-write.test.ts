// ---------------------------------------------------------------------------
// tools/datacenter-write.test.ts — the writes the Data Center adapter serves
// (D109, stage 13.4b; the user writes of D111, stage 13.5b; the admin and
// agile writes of D113, stage 13.6b), end to end through the real tool
// handlers.
//
// The Cloud builders produce their ADF documents as usual; `onV2Wiki` moves the
// request to `/rest/api/2` and renders every document in the body to wiki
// markup. What is pinned here is that seam: no ADF object leaves for a Data
// Center host, text is escaped, markdown keeps its structure, a resolved
// mention is a `[~username]` link and every other mention literal text (D112),
// anything the writer cannot express is refused before a request exists, the
// user fields a Data Center host cannot take are refused, and plan mode shows
// the wiki body the apply would send. Like the read tests, the fixtures follow Atlassian's
// documentation and are NOT recordings of a Data Center instance (D104).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adfFromMarkdown } from '../api/adf.js';
import { DATACENTER_API, DATACENTER_WRITE_TOOLS } from '../api/datacenter.js';
import { CLOUD_API } from '../api/port.js';
import { wikiFromAdf } from '../api/wiki-writer.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createFakeRedactor,
  jiraOk,
} from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import type { JiraRequestSpec, Rng, Settings } from '../core/types.js';
import { createRegistry } from '../mcp/registry.js';
import type { AnyToolSpec, ToolCtx, ToolResult } from '../mcp/types.js';
import { createPackages } from './index.js';
import {
  closeSprintTool,
  createSprintTool,
  moveToBacklogTool,
  moveToSprintTool,
  startSprintTool,
} from './agile.js';
import {
  addVoteTool,
  addWatcherTool,
  createComponentTool,
  createVersionTool,
  removeVoteTool,
  removeWatcherTool,
  updateComponentTool,
  updateVersionTool,
} from './collab.js';
import {
  addCommentTool,
  addWorklogTool,
  assignIssueTool,
  createIssueTool,
  linkIssuesTool,
  transitionIssueTool,
  updateCommentTool,
  updateIssueTool,
} from './issues-write.js';

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

/** A comment as Data Center answers a comment write: the wiki body echoed. */
const DC_COMMENT = {
  self: 'https://jira.corp.example/jira/rest/api/2/issue/10001/comment/5',
  id: '5',
  author: DC_USER,
  updateAuthor: DC_USER,
  body: 'Plain \\*text\\*',
  created: '2026-09-28T10:00:00.000+0300',
  updated: '2026-09-28T10:00:00.000+0300',
};

const DC_WORKLOG = {
  self: 'https://jira.corp.example/jira/rest/api/2/issue/10001/worklog/7',
  id: '7',
  issueId: '10001',
  author: DC_USER,
  updateAuthor: DC_USER,
  comment: 'Did \\*it\\*',
  started: '2026-09-28T10:00:00.000+0300',
  timeSpent: '1h',
  timeSpentSeconds: 3600,
};

const TRANSITIONS = {
  transitions: [{ id: '31', name: 'Done', to: { id: '3', name: 'Done' } }],
};

function ctxOf(jira: FakeJiraRequest): ToolCtx {
  const clock = createFakeClock(Date.UTC(2026, 8, 28, 7, 0, 0));
  return {
    jira: jira.fn,
    api: DATACENTER_API,
    log: createFakeLogger({ cid: 'c-test01', clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 30_000, maxPages: 20 },
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
}

function run(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  return spec.handler(spec.input.parse(args), ctx);
}

/** The one write request a call sent (GETs it made first are skipped). */
function writeOf(jira: FakeJiraRequest): JiraRequestSpec {
  const writes = jira.calls.filter((call) => call.method !== 'GET');
  assert.equal(writes.length, 1, `expected one write, got ${jira.routes().join(', ')}`);
  return writes[0] as JiraRequestSpec;
}

/** Whether an ADF document is anywhere in a request body. */
function hasAdf(value: unknown): boolean {
  return JSON.stringify(value).includes('"type":"doc"');
}

interface WriteCase {
  readonly tool: AnyToolSpec;
  readonly args: Record<string, unknown>;
  readonly routes: readonly [string, unknown][];
  readonly write: string;
  /** Where the rendered rich text sits in the request body. */
  readonly at: (body: Record<string, unknown>) => unknown;
}

const RICH = 'Plain *text*';
const RICH_WIKI = 'Plain \\*text\\*';

const CASES: readonly WriteCase[] = [
  {
    tool: createIssueTool,
    args: { project: 'ABC', issueType: 'Task', summary: 'S', description: RICH },
    routes: [['POST /rest/api/2/issue', { id: '10002', key: 'ABC-2' }]],
    write: 'POST /rest/api/2/issue',
    at: (body) => (body.fields as Record<string, unknown>).description,
  },
  {
    tool: updateIssueTool,
    args: { issue: 'ABC-1', description: RICH },
    routes: [['PUT /rest/api/2/issue/ABC-1', jiraOk(undefined, { status: 204 })]],
    write: 'PUT /rest/api/2/issue/ABC-1',
    at: (body) => (body.fields as Record<string, unknown>).description,
  },
  {
    tool: transitionIssueTool,
    args: { issue: 'ABC-1', transition: 'Done', comment: RICH },
    routes: [
      ['GET /rest/api/2/issue/ABC-1/transitions', TRANSITIONS],
      ['POST /rest/api/2/issue/ABC-1/transitions', jiraOk(undefined, { status: 204 })],
    ],
    write: 'POST /rest/api/2/issue/ABC-1/transitions',
    at: (body) => {
      const update = body.update as { comment: { add: { body: unknown } }[] };
      return update.comment[0]?.add.body;
    },
  },
  {
    tool: addCommentTool,
    args: { issue: 'ABC-1', body: RICH },
    routes: [['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]],
    write: 'POST /rest/api/2/issue/ABC-1/comment',
    at: (body) => body.body,
  },
  {
    tool: updateCommentTool,
    args: { issue: 'ABC-1', commentId: '5', body: RICH },
    // CC-510: the stored restriction is read back before the edit.
    routes: [
      ['GET /rest/api/2/issue/ABC-1/comment/5', DC_COMMENT],
      ['PUT /rest/api/2/issue/ABC-1/comment/5', DC_COMMENT],
    ],
    write: 'PUT /rest/api/2/issue/ABC-1/comment/5',
    at: (body) => body.body,
  },
  {
    tool: addWorklogTool,
    args: { issue: 'ABC-1', timeSpentSeconds: 3600, comment: RICH },
    routes: [
      ['GET /rest/api/2/myself', DC_USER],
      ['POST /rest/api/2/issue/ABC-1/worklog', DC_WORKLOG],
    ],
    write: 'POST /rest/api/2/issue/ABC-1/worklog',
    at: (body) => body.comment,
  },
  {
    tool: linkIssuesTool,
    args: {
      linkType: 'Blocks',
      inwardIssue: 'ABC-1',
      outwardIssue: 'ABC-2',
      comment: RICH,
    },
    routes: [['POST /rest/api/2/issueLink', jiraOk(undefined, { status: 201 })]],
    write: 'POST /rest/api/2/issueLink',
    at: (body) => (body.comment as Record<string, unknown>).body,
  },
];

function fakeFor(routes: readonly [string, unknown][]): FakeJiraRequest {
  const jira = createFakeJiraRequest();
  for (const [route, answer] of routes) {
    const isStub =
      typeof answer === 'object' &&
      answer !== null &&
      'data' in answer &&
      'status' in answer;
    jira.on(route, isStub ? (answer as ReturnType<typeof jiraOk>) : jiraOk(answer));
  }
  return jira;
}

// ---------------------------------------------------------------------------
// CC-302 — every served write sends wiki markup to /rest/api/2, never ADF
// ---------------------------------------------------------------------------

test('CC-302: the cases cover every Data Center write, once', () => {
  // The rich-text writes are pinned here; the user writes of D111 carry no
  // rich text and are pinned by USER_CASES below (CC-317), the admin and agile
  // writes of D113 by ADMIN_CASES (CC-330).
  assert.deepEqual(
    [...CASES, ...USER_CASES, ...ADMIN_CASES].map((c) => c.tool.name).sort(),
    [...DATACENTER_WRITE_TOOLS].sort(),
  );
});

for (const c of CASES) {
  test(`CC-302: ${c.tool.name} sends an escaped wiki string to /rest/api/2`, async () => {
    const jira = fakeFor(c.routes);
    const result = await run(c.tool, c.args, ctxOf(jira));
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const route of jira.routes()) assert.match(route, / \/rest\/api\/2\//, route);
    const write = writeOf(jira);
    assert.equal(jira.routes()[jira.calls.indexOf(write)], c.write);
    assert.equal(
      hasAdf(write.body),
      false,
      'an ADF document left for a Data Center host',
    );
    assert.equal(c.at(write.body as Record<string, unknown>), RICH_WIKI);
  });
}

// ---------------------------------------------------------------------------
// CC-303 — markdown keeps its structure as wiki markup
// ---------------------------------------------------------------------------

test('CC-303: format "markdown" is rendered to wiki markup, not escaped as text', async () => {
  const jira = fakeFor([['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]]);
  const result = await run(
    addCommentTool,
    { issue: 'ABC-1', body: '## Steps\n\n- **one**\n- `two`', format: 'markdown' },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    (writeOf(jira).body as { body: unknown }).body,
    'h2. Steps\n\n* *one*\n* {{two}}',
  );
});

test('CC-303: a raw ADF body is rendered to wiki markup too', async () => {
  const jira = fakeFor([['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]]);
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }],
      },
    ],
  };
  const result = await run(addCommentTool, { issue: 'ABC-1', body: doc }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((writeOf(jira).body as { body: unknown }).body, '*bold*');
});

test('CC-303: a node wiki markup cannot express is refused and nothing is sent', async () => {
  const jira = fakeFor([['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]]);
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'panel', attrs: { panelType: 'info' }, content: [{ type: 'paragraph' }] },
    ],
  };
  const result = await run(addCommentTool, { issue: 'ABC-1', body: doc }, ctxOf(jira));
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /validation/);
  assert.match(JSON.stringify(result), /panel/);
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CC-304 — the user fields Data Center cannot take are refused up front
// ---------------------------------------------------------------------------

const ACCOUNT_ID = '5b10a2844c20165700ede21g';

for (const [tool, args] of [
  [
    createIssueTool,
    { project: 'ABC', issueType: 'Task', summary: 'S', assigneeAccountId: ACCOUNT_ID },
  ],
  [updateIssueTool, { issue: 'ABC-1', assigneeAccountId: ACCOUNT_ID }],
] as const) {
  test(`CC-304: ${tool.name} refuses assigneeAccountId on Data Center and sends nothing`, async () => {
    const jira = createFakeJiraRequest();
    const result = await run(tool, args, ctxOf(jira));
    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    assert.match(text, /validation/);
    assert.match(text, /assigneeAccountId/);
    assert.match(result.error?.remediation ?? '', /"assignee": \{ "name"/);
    assert.equal(jira.calls.length, 0);
  });
}

test('CC-304: the reporter accountId is refused on Data Center too', () => {
  const jira = createFakeJiraRequest();
  assert.throws(
    () =>
      DATACENTER_API.createIssue({
        jira: jira.fn,
        project: 'ABC',
        issueType: 'Task',
        summary: 'S',
        reporterAccountId: ACCOUNT_ID,
      }),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'validation');
      assert.match((error as Error).message, /reporterAccountId/);
      return true;
    },
  );
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CC-305 — answers are shaped in the Data Center user dialect
// ---------------------------------------------------------------------------

test('CC-305: a comment write answers with the DC user projected and no email', async () => {
  const jira = fakeFor([['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]]);
  const result = await run(addCommentTool, { issue: 'ABC-1', body: RICH }, ctxOf(jira));
  const data = result.data as { author?: unknown };
  assert.deepEqual(data.author, PROJECTED_USER);
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
});

test('CC-305: a worklog write answers with the DC user projected and no email', async () => {
  const jira = fakeFor([
    ['GET /rest/api/2/myself', DC_USER],
    ['POST /rest/api/2/issue/ABC-1/worklog', DC_WORKLOG],
  ]);
  const result = await run(
    addWorklogTool,
    { issue: 'ABC-1', timeSpentSeconds: 3600 },
    ctxOf(jira),
  );
  const data = result.data as { author?: unknown };
  assert.deepEqual(data.author, PROJECTED_USER);
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
});

// ---------------------------------------------------------------------------
// CC-306 — plan mode shows the wiki body the apply would send
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
  metaCacheTtlS: 300,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

const RNG: Rng = () => 0.5;

test('CC-306: a Data Center write plan carries the wiki body, not ADF, and sends nothing', async () => {
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
  assert.equal(registry.has('jira_add_comment'), true);
  const plan = await registry.call('jira_add_comment', { issue: 'ABC-1', body: RICH });
  assert.equal(plan.structuredContent.ok, true, plan.text);
  // The plan shows the path under the root, as on Cloud; the body is the one
  // the apply would send — rendered by the adapter, below the plan seam.
  const planned = (plan.structuredContent.data as { planned: unknown }).planned;
  assert.deepEqual(planned, {
    method: 'POST',
    path: '/issue/ABC-1/comment',
    body: { body: RICH_WIKI },
  });
  assert.equal(plan.text.includes('"type":"doc"'), false);
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// D112 (stage 13.6a) — resolveMentions on Data Center: `@[Name]` resolves
// through `GET /rest/api/2/user/search?username=` and is written `[~username]`
// ---------------------------------------------------------------------------

/** A Data Center user-search row, as `/rest/api/2/user/search` sends one. */
function dcRow(
  name: string,
  displayName: string,
  active = true,
): Record<string, unknown> {
  return { ...DC_USER, name, key: `JIRAUSER-${name}`, displayName, active };
}

/** A fake that answers the DC user search with `rows` and a comment POST. */
function mentionFake(rows: readonly unknown[]): FakeJiraRequest {
  return fakeFor([
    ['GET /rest/api/2/user/search', rows],
    ['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT],
  ]);
}

const MENTION_ARGS = {
  issue: 'ABC-1',
  body: 'hi @[Jane Doe], see **this**',
  format: 'markdown',
  resolveMentions: true,
} as const;

test('CC-323: a resolved mention is sent as [~username] after a DC user search', async () => {
  const jira = mentionFake([dcRow('jdoe', 'Jane Doe')]);
  const result = await run(addCommentTool, MENTION_ARGS, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(jira.routes(), [
    'GET /rest/api/2/user/search',
    'POST /rest/api/2/issue/ABC-1/comment',
  ]);
  const search = jira.calls[0] as JiraRequestSpec;
  assert.equal(search.root, 'v2');
  assert.equal((search.query as Record<string, unknown>).username, 'Jane Doe');
  assert.equal((search.query as Record<string, unknown>).query, undefined);
  const write = writeOf(jira);
  assert.equal(hasAdf(write.body), false);
  assert.equal((write.body as { body: unknown }).body, 'hi [~jdoe], see *this*');
});

test('CC-323: every rich-text field of a Data Center write resolves the same way', async () => {
  const jira = fakeFor([
    ['GET /rest/api/2/user/search', [dcRow('jdoe', 'Jane Doe')]],
    ['PUT /rest/api/2/issue/ABC-1', jiraOk(undefined, { status: 204 })],
  ]);
  const result = await run(
    updateIssueTool,
    {
      issue: 'ABC-1',
      description: 'owner: @[jane doe] and @[Jane Doe]',
      format: 'markdown',
      resolveMentions: true,
    },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  // Case-insensitive duplicates share one search (CC-112), both spellings map.
  assert.equal(jira.calls.filter((call) => call.method === 'GET').length, 1);
  const fields = (writeOf(jira).body as { fields: Record<string, unknown> }).fields;
  assert.equal(fields.description, 'owner: [~jdoe] and [~jdoe]');
});

test('CC-323: an unresolved @[token] with resolveMentions off stays literal, no search', async () => {
  const jira = mentionFake([]);
  const result = await run(
    addCommentTool,
    { ...MENTION_ARGS, resolveMentions: false },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(jira.routes(), ['POST /rest/api/2/issue/ABC-1/comment']);
  const body = (writeOf(jira).body as { body: string }).body;
  assert.doesNotMatch(body, /\[~/);
  assert.match(JSON.stringify(result), /mentions_skipped/);
});

for (const [label, username] of [
  ['a closing bracket', 'j]doe'],
  ['a pipe', 'j|doe'],
  ['a newline', 'j\ndoe'],
  ['a closing brace', 'j}doe'],
  ['an opening brace', 'j{doe'],
  ['an opening bracket', 'j[doe'],
  ['a backslash', 'j\\doe'],
  ['a space', 'j doe'],
  ['an empty name', ''],
] as const) {
  test(`CC-324: a username with ${label} is refused and nothing is written`, async () => {
    const jira = mentionFake([dcRow(username, 'Jane Doe')]);
    const result = await run(addCommentTool, MENTION_ARGS, ctxOf(jira));
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    assert.match(result.error?.remediation ?? '', /plain text/);
    assert.equal(
      jira.calls.some((call) => call.method !== 'GET'),
      false,
      'a write was sent',
    );
  });
}

test('CC-324: a matched user with no username is refused, never mentioned by key', async () => {
  const row = { ...dcRow('x', 'Jane Doe') };
  delete row.name;
  const jira = mentionFake([row]);
  const result = await run(addCommentTool, MENTION_ARGS, ctxOf(jira));
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? JSON.stringify(result), /no username/);
  assert.equal(jira.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('CC-325: a Data Center plan shows the [~username] body and writes nothing', async () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const jira = fakeFor([['GET /rest/api/2/user/search', [dcRow('jdoe', 'Jane Doe')]]]);
  const registry = createRegistry(manifest, {
    settings: DC_SETTINGS,
    jira: jira.fn,
    logger: createFakeLogger(),
    clock: createFakeClock(1_000),
    rng: RNG,
    redactor: createFakeRedactor(),
    api: DATACENTER_API,
  });
  const plan = await registry.call('jira_add_comment', MENTION_ARGS);
  assert.equal(plan.structuredContent.ok, true, plan.text);
  const planned = (plan.structuredContent.data as { planned: unknown }).planned;
  assert.deepEqual(planned, {
    method: 'POST',
    path: '/issue/ABC-1/comment',
    body: { body: 'hi [~jdoe], see *this*' },
  });
  // The resolution GET is a read and passes the plan seam (CC-111); no write.
  assert.deepEqual(jira.routes(), ['GET /rest/api/2/user/search']);
});

test('CC-326: no match, inactive-only and ambiguity refuse the whole call, as on Cloud', async () => {
  const refused = async (rows: readonly unknown[], pattern: RegExp): Promise<string> => {
    const jira = mentionFake(rows);
    const result = await run(addCommentTool, MENTION_ARGS, ctxOf(jira));
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    const text = JSON.stringify(result);
    assert.match(text, pattern);
    assert.equal(jira.calls.filter((call) => call.method !== 'GET').length, 0);
    return text;
  };
  await refused([], /No user matched the mention @\[Jane Doe\]/);
  await refused([dcRow('jdoe', 'Jane Doe', false)], /inactive/);
  const text = await refused(
    [dcRow('jdoe', 'Jane Doe'), dcRow('jdoe2', 'Jane Doe')],
    /ambiguous/,
  );
  // Candidates are listed by username, the identifier Data Center knows.
  assert.match(text, /Jane Doe \(jdoe\), Jane Doe \(jdoe2\)/);
});

test('CC-326: a unique exact display name wins over partial matches on Data Center', async () => {
  const jira = mentionFake([dcRow('jdoe', 'Jane Doe'), dcRow('jdoey', 'Jane Doey')]);
  const result = await run(addCommentTool, MENTION_ARGS, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((writeOf(jira).body as { body: unknown }).body, 'hi [~jdoe], see *this*');
});

test('CC-326: more than 20 distinct names are refused before any search', async () => {
  const jira = mentionFake([]);
  const names = Array.from({ length: 21 }, (_, i) => `@[User ${String(i)}]`).join(' ');
  const result = await run(addCommentTool, { ...MENTION_ARGS, body: names }, ctxOf(jira));
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /at most 20 distinct names/);
  assert.equal(jira.calls.length, 0);
});

test('CC-327: a raw ADF mention stays literal on Data Center, whatever its id', async () => {
  const jira = fakeFor([['POST /rest/api/2/issue/ABC-1/comment', DC_COMMENT]]);
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: 'jdoe', text: '@Jane Doe' } },
          { type: 'text', text: ' ' },
          { type: 'mention', attrs: { id: 'admin]|x', text: '@x' } },
        ],
      },
    ],
  };
  const result = await run(addCommentTool, { issue: 'ABC-1', body: doc }, ctxOf(jira));
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = (writeOf(jira).body as { body: string }).body;
  assert.equal(body, '@Jane Doe @x');
  assert.doesNotMatch(body, /\[~/);
});

test('CC-327: only targets the Data Center resolver produced are tagged', async () => {
  const jira = fakeFor([['GET /rest/api/2/user/search', [dcRow('jdoe', 'Jane Doe')]]]);
  const resolved = await DATACENTER_API.resolveMentionNames({
    jira: jira.fn,
    names: ['Jane Doe'],
  });
  assert.deepEqual([...resolved], [['Jane Doe', { id: 'jdoe', text: '@Jane Doe' }]]);
  const render = (mentions: ReadonlyMap<string, { id: string; text?: string }>): string =>
    wikiFromAdf(DATACENTER_API.adfFromMarkdown('cc @[Jane Doe]', { mentions }));
  assert.equal(render(resolved), 'cc [~jdoe]');
  // The same id and text from any other map — hand-made, or a copy — stays literal.
  assert.equal(
    render(new Map([['Jane Doe', { id: 'jdoe', text: '@Jane Doe' }]])),
    'cc @Jane Doe',
  );
  assert.equal(
    render(new Map([['Jane Doe', { ...(resolved.get('Jane Doe') as { id: string }) }]])),
    'cc @Jane Doe',
  );
  // No mentions map: the Cloud parse, unchanged.
  assert.deepEqual(
    DATACENTER_API.adfFromMarkdown('plain'),
    CLOUD_API.adfFromMarkdown('plain'),
  );
});

test('CC-328: Cloud mention resolution is unchanged by the Data Center twin', async () => {
  assert.notEqual(DATACENTER_API.resolveMentionNames, CLOUD_API.resolveMentionNames);
  assert.equal(CLOUD_API.adfFromMarkdown, adfFromMarkdown);
  const jira = fakeFor([
    [
      'GET /rest/api/3/user/search',
      [
        {
          accountId: '557058:abc',
          accountType: 'atlassian',
          displayName: 'Jane Doe',
          active: true,
        },
      ],
    ],
  ]);
  const resolved = await CLOUD_API.resolveMentionNames({
    jira: jira.fn,
    names: ['Jane Doe'],
  });
  assert.deepEqual(jira.routes(), ['GET /rest/api/3/user/search']);
  assert.equal((jira.calls[0]?.query as Record<string, unknown>).query, 'Jane Doe');
  assert.deepEqual(
    [...resolved],
    [['Jane Doe', { id: '557058:abc', text: '@Jane Doe' }]],
  );
  // A Cloud target never becomes a wiki user link, even through the DC parse.
  assert.equal(
    wikiFromAdf(DATACENTER_API.adfFromMarkdown('cc @[Jane Doe]', { mentions: resolved })),
    'cc @Jane Doe',
  );
});

// ---------------------------------------------------------------------------
// D111 (stage 13.5b) — the user writes: assign, watchers, votes
//
// Data Center names users by `username` where Cloud takes an accountId. The
// tool schemas accept both; the Data Center twins refuse accountId and the
// Cloud functions refuse username, before any request exists.
// ---------------------------------------------------------------------------

const NO_CONTENT = jiraOk(undefined, { status: 204 });

interface UserCase {
  readonly tool: AnyToolSpec;
  readonly args: Record<string, unknown>;
  readonly write: string;
  readonly body: unknown;
  readonly query: unknown;
  readonly data: Record<string, unknown>;
}

const USER_CASES: readonly UserCase[] = [
  {
    tool: assignIssueTool,
    args: { issue: 'ABC-1', username: 'jdoe' },
    write: 'PUT /rest/api/2/issue/ABC-1/assignee',
    body: { name: 'jdoe' },
    query: undefined,
    data: { issue: 'ABC-1', username: 'jdoe', assigned: true },
  },
  {
    tool: addWatcherTool,
    args: { issue: 'ABC-1', username: 'jdoe' },
    write: 'POST /rest/api/2/issue/ABC-1/watchers',
    // The documented body is the username itself, a bare JSON string.
    body: 'jdoe',
    query: undefined,
    data: { issue: 'ABC-1', username: 'jdoe', watching: true, status: 204 },
  },
  {
    tool: removeWatcherTool,
    args: { issue: 'ABC-1', username: 'jdoe' },
    write: 'DELETE /rest/api/2/issue/ABC-1/watchers',
    body: undefined,
    query: { username: 'jdoe' },
    data: { issue: 'ABC-1', username: 'jdoe', watching: false, status: 204 },
  },
  {
    tool: addVoteTool,
    args: { issue: 'ABC-1' },
    write: 'POST /rest/api/2/issue/ABC-1/votes',
    body: undefined,
    query: undefined,
    data: { issue: 'ABC-1', voted: true, status: 204 },
  },
  {
    tool: removeVoteTool,
    args: { issue: 'ABC-1' },
    write: 'DELETE /rest/api/2/issue/ABC-1/votes',
    body: undefined,
    query: undefined,
    data: { issue: 'ABC-1', voted: false, status: 204 },
  },
];

// ---------------------------------------------------------------------------
// CC-317 — the Data Center request shapes of the user writes
// ---------------------------------------------------------------------------

for (const c of USER_CASES) {
  test(`CC-317: ${c.tool.name} sends the Data Center shape to /rest/api/2`, async () => {
    const jira = fakeFor([[c.write, NO_CONTENT]]);
    const result = await run(c.tool, c.args, ctxOf(jira));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(jira.routes(), [c.write]);
    const sent = writeOf(jira);
    assert.deepEqual(sent.body, c.body);
    assert.deepEqual(sent.query, c.query);
  });
}

test('CC-317: jira_assign_issue unassigns on Data Center with {"name": null}', async () => {
  const jira = fakeFor([['PUT /rest/api/2/issue/ABC-1/assignee', NO_CONTENT]]);
  const result = await run(
    assignIssueTool,
    { issue: 'ABC-1', unassign: true },
    ctxOf(jira),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  // `null` is kept on the wire — dropping the key would be a 400, not an unassign.
  assert.deepEqual(writeOf(jira).body, { name: null });
  assert.deepEqual(result.data, { issue: 'ABC-1', username: null, assigned: true });
});

// ---------------------------------------------------------------------------
// CC-318 — Data Center refuses accountId before any request
// ---------------------------------------------------------------------------

for (const tool of [assignIssueTool, addWatcherTool, removeWatcherTool]) {
  test(`CC-318: ${tool.name} refuses accountId on Data Center and sends nothing`, async () => {
    const jira = createFakeJiraRequest();
    const result = await run(
      tool,
      { issue: 'ABC-1', accountId: ACCOUNT_ID },
      ctxOf(jira),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    assert.match(result.error?.message ?? '', /accountId/);
    assert.match(result.error?.remediation ?? '', /username/);
    assert.equal(jira.calls.length, 0);
  });
}

test('CC-318: the Data Center assign twin refuses an ambiguous or intentless call', async () => {
  for (const [input, pattern] of [
    [{ username: 'jdoe', unassign: true }, /ambiguous/],
    [{}, /username or unassign/],
    [{ accountId: ACCOUNT_ID, unassign: true }, /accountId/],
  ] as const) {
    const jira = createFakeJiraRequest();
    await assert.rejects(
      DATACENTER_API.assignIssue({ jira: jira.fn, issue: 'ABC-1', ...input }),
      (error: unknown) => {
        assert.equal((error as { kind?: string }).kind, 'validation');
        assert.match((error as Error).message, pattern);
        return true;
      },
    );
    assert.equal(jira.calls.length, 0);
  }
});

test('CC-318: the Data Center watcher twins need a username and refuse accountId', async () => {
  for (const call of [DATACENTER_API.addWatcher, DATACENTER_API.removeWatcher]) {
    for (const [input, pattern] of [
      [{}, /username/],
      [{ accountId: ACCOUNT_ID }, /accountId/],
    ] as const) {
      const jira = createFakeJiraRequest();
      await assert.rejects(
        call({ jira: jira.fn, issue: 'ABC-1', ...input }),
        (error: unknown) => {
          assert.equal((error as { kind?: string }).kind, 'validation');
          assert.match((error as Error).message, pattern);
          return true;
        },
      );
      assert.equal(jira.calls.length, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// CC-319 — the Data Center answers carry username, never accountId
// ---------------------------------------------------------------------------

for (const c of USER_CASES) {
  test(`CC-319: ${c.tool.name} answers in the Data Center dialect`, async () => {
    const jira = fakeFor([[c.write, NO_CONTENT]]);
    const result = await run(c.tool, c.args, ctxOf(jira));
    assert.deepEqual(result.data, c.data);
    assert.equal(JSON.stringify(result.data).includes('accountId'), false);
  });
}

// ---------------------------------------------------------------------------
// CC-320 — plan mode shows the Data Center path, body and query
// ---------------------------------------------------------------------------

test('CC-320: a Data Center user-write plan carries the username dialect and sends nothing', async () => {
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
  const expected: readonly [string, Record<string, unknown>, unknown][] = [
    [
      'jira_assign_issue',
      { issue: 'ABC-1', username: 'jdoe' },
      { method: 'PUT', path: '/issue/ABC-1/assignee', body: { name: 'jdoe' } },
    ],
    [
      'jira_add_watcher',
      { issue: 'ABC-1', username: 'jdoe' },
      { method: 'POST', path: '/issue/ABC-1/watchers', body: 'jdoe' },
    ],
    [
      'jira_remove_watcher',
      { issue: 'ABC-1', username: 'jdoe' },
      { method: 'DELETE', path: '/issue/ABC-1/watchers', query: { username: 'jdoe' } },
    ],
    ['jira_add_vote', { issue: 'ABC-1' }, { method: 'POST', path: '/issue/ABC-1/votes' }],
  ];
  for (const [name, args, planned] of expected) {
    assert.equal(registry.has(name), true, name);
    const plan = await registry.call(name, args);
    assert.equal(plan.structuredContent.ok, true, plan.text);
    assert.deepEqual(
      (plan.structuredContent.data as { planned: unknown }).planned,
      planned,
      name,
    );
  }
  // A refusal below the plan seam still refuses in plan mode.
  const refused = await registry.call('jira_add_watcher', {
    issue: 'ABC-1',
    accountId: ACCOUNT_ID,
  });
  assert.equal(refused.structuredContent.ok, false, refused.text);
  assert.match(refused.text, /validation/);
  // Only reads left the process: the D132 plan context reads the live assignee.
  assert.deepEqual(
    jira.calls.filter((call) => call.method !== 'GET'),
    [],
  );
});

// ---------------------------------------------------------------------------
// D113 (stage 13.6b) — the reversible admin and agile writes
//
// Components and versions go to `/rest/api/2` with the Cloud body fields; the
// sprint writes and the two moves stay on the agile root, which Jira Software
// Data Center shares. A component lead is refused as an accountId, and closing
// a sprint — which cannot be undone — is not served.
// ---------------------------------------------------------------------------

const START = '2026-10-01T09:00:00.000+03:00';
const END = '2026-10-14T18:00:00.000+03:00';

/** A component as Data Center answers a component write. */
const DC_COMPONENT = {
  self: 'https://jira.corp.example/jira/rest/api/2/component/10100',
  id: '10100',
  name: 'Backend',
  description: 'API',
  lead: DC_USER,
  assigneeType: 'PROJECT_LEAD',
  assignee: DC_USER,
  realAssigneeType: 'PROJECT_LEAD',
  realAssignee: DC_USER,
  isAssigneeTypeValid: true,
  project: 'ABC',
  projectId: 10000,
};

/** A version as Data Center answers a version write. */
const DC_VERSION = {
  self: 'https://jira.corp.example/jira/rest/api/2/version/10200',
  id: '10200',
  name: '1.4.0',
  archived: false,
  released: false,
  startDate: '2026-10-01',
  releaseDate: '2026-10-31',
  userStartDate: '01/Oct/26',
  userReleaseDate: '31/Oct/26',
  projectId: 10000,
};

const DC_SPRINT = {
  id: 7,
  self: 'https://jira.corp.example/jira/rest/agile/1.0/sprint/7',
  state: 'future',
  name: 'Sprint 14',
  goal: 'Ship it',
  startDate: START,
  endDate: END,
  originBoardId: 1,
};

interface AdminCase {
  readonly tool: AnyToolSpec;
  readonly args: Record<string, unknown>;
  readonly write: string;
  readonly answer: unknown;
  readonly body: unknown;
  /** The path under the root a plan shows. */
  readonly path: string;
}

const ADMIN_CASES: readonly AdminCase[] = [
  {
    tool: createComponentTool,
    args: {
      project: 'ABC',
      name: 'Backend',
      description: 'API *as is*',
      assigneeType: 'PROJECT_LEAD',
    },
    write: 'POST /rest/api/2/component',
    answer: DC_COMPONENT,
    // The description is plain text on both products: sent as given, unescaped.
    body: {
      name: 'Backend',
      project: 'ABC',
      description: 'API *as is*',
      assigneeType: 'PROJECT_LEAD',
    },
    path: '/component',
  },
  {
    tool: updateComponentTool,
    args: { componentId: '10100', name: 'Core', description: '' },
    write: 'PUT /rest/api/2/component/10100',
    answer: DC_COMPONENT,
    body: { name: 'Core', description: '' },
    path: '/component/10100',
  },
  {
    tool: createVersionTool,
    args: {
      projectId: '10000',
      name: '1.4.0',
      startDate: '2026-10-01',
      releaseDate: '2026-10-31',
      released: false,
    },
    write: 'POST /rest/api/2/version',
    answer: DC_VERSION,
    body: {
      name: '1.4.0',
      projectId: 10000,
      startDate: '2026-10-01',
      releaseDate: '2026-10-31',
      released: false,
    },
    path: '/version',
  },
  {
    tool: updateVersionTool,
    args: { versionId: '10200', released: true, archived: false },
    write: 'PUT /rest/api/2/version/10200',
    answer: { ...DC_VERSION, released: true },
    body: { released: true, archived: false },
    path: '/version/10200',
  },
  {
    tool: createSprintTool,
    args: {
      name: 'Sprint 14',
      originBoardId: 1,
      goal: 'Ship it',
      startDate: START,
      endDate: END,
    },
    write: 'POST /rest/agile/1.0/sprint',
    answer: jiraOk(DC_SPRINT, { status: 201 }),
    body: {
      name: 'Sprint 14',
      originBoardId: 1,
      goal: 'Ship it',
      startDate: START,
      endDate: END,
    },
    path: '/sprint',
  },
  {
    tool: startSprintTool,
    args: { sprintId: 7, startDate: START, endDate: END },
    write: 'POST /rest/agile/1.0/sprint/7',
    answer: { ...DC_SPRINT, state: 'active' },
    body: { state: 'active', startDate: START, endDate: END },
    path: '/sprint/7',
  },
  {
    tool: moveToSprintTool,
    args: { sprintId: 7, issues: ['ABC-1', 'ABC-2'] },
    write: 'POST /rest/agile/1.0/sprint/7/issue',
    answer: NO_CONTENT,
    body: { issues: ['ABC-1', 'ABC-2'] },
    path: '/sprint/7/issue',
  },
  {
    tool: moveToBacklogTool,
    args: { issues: ['ABC-1'] },
    write: 'POST /rest/agile/1.0/backlog/issue',
    answer: NO_CONTENT,
    body: { issues: ['ABC-1'] },
    path: '/backlog/issue',
  },
];

// ---------------------------------------------------------------------------
// CC-330 — each admin and agile write sends the Cloud body to its DC route
// ---------------------------------------------------------------------------

for (const c of ADMIN_CASES) {
  test(`CC-330: ${c.tool.name} sends the Cloud body to its Data Center route`, async () => {
    const jira = fakeFor([[c.write, c.answer]]);
    const result = await run(c.tool, c.args, ctxOf(jira));
    assert.equal(result.ok, true, JSON.stringify(result));
    // One request, on the v2 or agile root — never v3, never a read first.
    assert.deepEqual(jira.routes(), [c.write]);
    assert.deepEqual(writeOf(jira).body, c.body);
    assert.equal(hasAdf(writeOf(jira).body), false);
  });
}

// ---------------------------------------------------------------------------
// CC-331 — a component lead given as an accountId is refused up front
// ---------------------------------------------------------------------------

for (const [tool, args] of [
  [createComponentTool, { project: 'ABC', name: 'Backend', leadAccountId: ACCOUNT_ID }],
  [updateComponentTool, { componentId: '10100', leadAccountId: ACCOUNT_ID }],
  [
    updateComponentTool,
    { componentId: '10100', name: 'Core', leadAccountId: ACCOUNT_ID },
  ],
] as const) {
  test(`CC-331: ${tool.name} refuses leadAccountId on Data Center and sends nothing`, async () => {
    const jira = createFakeJiraRequest();
    const result = await run(tool, args, ctxOf(jira));
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    assert.match(result.error?.message ?? '', /leadAccountId/);
    assert.match(result.error?.remediation ?? '', /Drop leadAccountId/);
    assert.equal(jira.calls.length, 0);
  });
}

test('CC-331: the refusal sits in the adapter, below the tools ring', () => {
  const jira = createFakeJiraRequest();
  for (const call of [
    () =>
      DATACENTER_API.createComponent({
        jira: jira.fn,
        project: 'ABC',
        name: 'Backend',
        leadAccountId: ACCOUNT_ID,
      }),
    () =>
      DATACENTER_API.updateComponent({
        jira: jira.fn,
        componentId: '10100',
        leadAccountId: ACCOUNT_ID,
      }),
  ]) {
    assert.throws(call, (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'validation');
      return true;
    });
  }
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CC-332 — the answers are shaped in the Data Center dialect
// ---------------------------------------------------------------------------

test('CC-332: a component write answers with the DC lead projected and no email', async () => {
  for (const c of ADMIN_CASES.slice(0, 2)) {
    const jira = fakeFor([[c.write, c.answer]]);
    const result = await run(c.tool, c.args, ctxOf(jira));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual((result.data as { component: unknown }).component, {
      id: '10100',
      name: 'Backend',
      description: 'API',
      project: 'ABC',
      projectId: 10000,
      lead: PROJECTED_USER,
      assigneeType: 'PROJECT_LEAD',
      isAssigneeTypeValid: true,
    });
    const text = JSON.stringify(result);
    assert.equal(text.includes(EMAIL), false, c.tool.name);
    assert.equal(text.includes('avatar'), false, c.tool.name);
  }
});

test('CC-332: version and sprint answers keep the allowlist on Data Center', async () => {
  const version = await run(
    createVersionTool,
    { projectId: '10000', name: '1.4.0' },
    ctxOf(fakeFor([['POST /rest/api/2/version', DC_VERSION]])),
  );
  assert.deepEqual((version.data as { version: unknown }).version, {
    id: '10200',
    name: '1.4.0',
    projectId: 10000,
    archived: false,
    released: false,
    startDate: '2026-10-01',
    releaseDate: '2026-10-31',
  });
  const sprint = await run(
    createSprintTool,
    { name: 'Sprint 14', originBoardId: 1 },
    ctxOf(fakeFor([['POST /rest/agile/1.0/sprint', jiraOk(DC_SPRINT, { status: 201 })]])),
  );
  assert.deepEqual(sprint.data, {
    sprint: {
      id: 7,
      name: 'Sprint 14',
      state: 'future',
      goal: 'Ship it',
      startDate: START,
      endDate: END,
      originBoardId: 1,
    },
    status: 201,
  });
});

// ---------------------------------------------------------------------------
// CC-333 — plan mode shows the root-relative path and the body, sends nothing
// ---------------------------------------------------------------------------

test('CC-333: a Data Center admin or agile write plan carries the apply request and sends nothing', async () => {
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
  for (const c of ADMIN_CASES) {
    const [method] = c.write.split(' ');
    assert.equal(registry.has(c.tool.name), true, c.tool.name);
    const plan = await registry.call(c.tool.name, c.args);
    assert.equal(plan.structuredContent.ok, true, plan.text);
    assert.deepEqual(
      (plan.structuredContent.data as { planned: unknown }).planned,
      { method, path: c.path, body: c.body },
      c.tool.name,
    );
  }
  // A refusal below the plan seam still refuses in plan mode.
  const refused = await registry.call('jira_create_component', {
    project: 'ABC',
    name: 'Backend',
    leadAccountId: ACCOUNT_ID,
  });
  assert.equal(refused.structuredContent.ok, false, refused.text);
  assert.match(refused.text, /validation/);
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CC-334 — no irreversible write is served; closing a sprint is not either
// ---------------------------------------------------------------------------

test('CC-334: no served Data Center write is irreversible, and jira_close_sprint is not served', async () => {
  const manifest = createPackages(() => {
    throw new Error('not called');
  });
  const tools = manifest.flatMap((pkg) => pkg.tools);
  for (const name of DATACENTER_WRITE_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.writeTier, 'standard', name);
  }
  // Tier alone does not decide it: a closed sprint cannot be reopened, so the
  // tool is held back until a Data Center host has been proven (D109, D113).
  assert.equal(DATACENTER_WRITE_TOOLS.has(closeSprintTool.name), false);
  const jira = createFakeJiraRequest();
  const result = await run(closeSprintTool, { sprintId: 7 }, ctxOf(jira));
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'unsupported');
  assert.equal(jira.calls.length, 0);
});
