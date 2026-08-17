// Tests for `tools/issues-delete.ts` (WP-72) — contract tier (TESTING.md).
//
// `api/issues.ts` already owns the wire shapes (the DELETE paths, the
// `deleteSubtasks` query, the subtask 400), so nothing here re-asserts them.
// What is asserted is the half this ring owns, and it is unusual in exactly one
// way: these tools are the only ones whose value to a caller is produced BEFORE
// the mutation. So the file is mostly about the before-state — that it is built
// by construction (D41), excerpted, projected free of PII, and that it reaches
// BOTH the plan envelope and the apply receipt with the same content.
//
// The gate is real here rather than faked: `createWriteGate` is what turns a
// handler into a plan, and the whole point of this package is what the gate does
// with `writeTier: 'irreversible'`. `mcp/write-mode.test.ts` proves the tier
// rules in isolation; this file proves the three tools are wired into them.
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads and marked `// synthetic`. The fake throws on a route nobody
// programmed, so "exactly these requests happened" holds by construction.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createMemoryJournal,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import type { JiraRequestFn } from '../core/types.js';
import { journalingGate } from '../mcp/server.js';
import type { AnyToolSpec, PlannedRequest, ToolCtx, ToolResult } from '../mcp/types.js';
import { createWriteGate } from '../mcp/write-mode.js';
import type { WriteGate } from '../mcp/write-mode.js';
import {
  deleteCommentTool,
  deleteIssueTool,
  deleteWorklogTool,
  issuesDeletePackage,
} from './issues-delete.js';

const KEY = 'PROJ-1';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';
const COMMENT_ID = '10100';
const WORKLOG_ID = '40001';

/** Routes are method + path; the query string is asserted separately. */
const ISSUE_ROUTE = `GET /rest/api/3/issue/${KEY}`;
const DELETE_ISSUE_ROUTE = `DELETE /rest/api/3/issue/${KEY}`;
const COMMENT_ROUTE = `GET /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`;
const DELETE_COMMENT_ROUTE = `DELETE /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`;
const WORKLOG_ROUTE = `GET /rest/api/3/issue/${KEY}/worklog/${WORKLOG_ID}`;
const DELETE_WORKLOG_ROUTE = `DELETE /rest/api/3/issue/${KEY}/worklog/${WORKLOG_ID}`;

/** 2026-08-07T10:00:00.000Z — the instant every call in this file runs at. */
const NOW = Date.UTC(2026, 7, 7, 10, 0, 0);

/** A user object as Jira embeds it, PII included. // synthetic */
const WIRE_USER = {
  self: `https://example.atlassian.net/rest/api/3/user?accountId=${ACCOUNT_ID}`,
  accountId: ACCOUNT_ID,
  accountType: 'atlassian',
  displayName: 'User One',
  active: true,
  emailAddress: 'user-1@example.invalid',
  timeZone: 'Asia/Kolkata',
};

/** ADF as Jira stores a one-paragraph rich-text field. // synthetic */
function adfDoc(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** `GET /issue/{key}?fields=...` for a parent with two subtasks. // synthetic */
function issueBody(subtaskKeys: readonly string[]): Record<string, unknown> {
  return {
    id: '10001',
    key: KEY,
    self: 'https://example.atlassian.net/rest/api/3/issue/10001',
    fields: {
      summary: 'Retry policy',
      status: {
        id: '10001',
        name: 'In Progress',
        statusCategory: { key: 'indeterminate' },
      },
      issuetype: { id: '10002', name: 'Task', subtask: false },
      subtasks: subtaskKeys.map((key, index) => ({
        id: String(20000 + index),
        key,
        fields: { summary: `Subtask ${key}`, status: { name: 'To Do' } },
      })),
    },
  };
}

/** `GET /issue/{key}/comment/{id}`. // synthetic */
const COMMENT_BODY = {
  self: `https://example.atlassian.net/rest/api/3/issue/10001/comment/${COMMENT_ID}`,
  id: COMMENT_ID,
  author: WIRE_USER,
  updateAuthor: WIRE_USER,
  body: adfDoc('Paired on the retry policy.'),
  created: '2026-08-07T10:00:00.000+0000',
  updated: '2026-08-07T10:00:00.000+0000',
  jsdPublic: false,
};

/** `GET /issue/{key}/worklog/{id}`. // synthetic */
const WORKLOG_BODY = {
  self: `https://example.atlassian.net/rest/api/3/issue/10001/worklog/${WORKLOG_ID}`,
  id: WORKLOG_ID,
  issueId: '10001',
  author: WIRE_USER,
  comment: adfDoc('Paired on the retry policy.'),
  started: '2026-08-07T15:30:00.000+0530',
  timeSpent: '1h',
  timeSpentSeconds: 3600,
  created: '2026-08-07T15:31:00.000+0530',
  updated: '2026-08-07T15:31:00.000+0530',
};

/** Jira's answer to all three DELETEs. */
const NO_CONTENT = jiraOk(undefined, { status: 204 });

type FakeJira = ReturnType<typeof createFakeJiraRequest>;

/** Distinct, reproducible plan-id draws — never `Math.random` [eslint]. */
function countingRng(): () => number {
  let n = 0;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

/** The `ToolCtx` the registry would build, with every seam faked. */
function ctxOf(jira: JiraRequestFn): ToolCtx {
  return {
    jira,
    log: createFakeLogger(),
    clock: createFakeClock(NOW),
    cid: 'c-7b2e04',
    limits: { maxResultChars: 100_000, maxPages: 1 },
    deadlineAt: NOW + 30_000,
  };
}

/** A gate call, exactly as `mcp/registry.ts` assembles one. */
function callOf(
  tool: AnyToolSpec,
  args: Record<string, unknown>,
  control: { apply?: boolean; plan_id?: string },
  jira: JiraRequestFn,
): Parameters<WriteGate['execute']>[0] {
  return {
    tool,
    args,
    control,
    jira,
    invoke: (seam: JiraRequestFn): Promise<ToolResult<unknown>> =>
      tool.handler(args, ctxOf(seam)),
  };
}

/** Plan the call, then apply it with the id the plan handed back. */
async function planThenApply(
  gate: WriteGate,
  tool: AnyToolSpec,
  args: Record<string, unknown>,
  fake: FakeJira,
): Promise<{ plan: ToolResult<unknown>; applied: ToolResult<unknown> }> {
  const plan = await gate.execute(callOf(tool, args, {}, fake.fn));
  const planId = (plan.data as { plan_id?: string } | undefined)?.plan_id;
  assert.equal(typeof planId, 'string', 'the plan produced no plan_id');
  const applied = await gate.execute(
    callOf(tool, args, { apply: true, plan_id: String(planId) }, fake.fn),
  );
  return { plan, applied };
}

function beforeOf(result: ToolResult<unknown>): Record<string, unknown> {
  const before = (result.data as { before?: unknown } | undefined)?.before;
  assert.ok(
    before !== null && typeof before === 'object',
    'no before-state on the result',
  );
  return before as Record<string, unknown>;
}

const ALL_TOOLS: readonly AnyToolSpec[] = issuesDeletePackage.tools;

// ---------------------------------------------------------------------------
// The package, its annotations and its schemas
// ---------------------------------------------------------------------------

test('the issues-delete package is the whole irreversible surface, and nothing else', () => {
  assert.equal(issuesDeletePackage.id, 'issues-delete');
  assert.deepEqual(
    ALL_TOOLS.map((tool) => tool.name),
    ['jira_delete_issue', 'jira_delete_comment', 'jira_delete_worklog'],
  );
  // One deny token removes the surface, so every tool must live in this package.
  for (const tool of ALL_TOOLS) assert.equal(tool.package, 'issues-delete');
});

test('every delete tool is irreversible, destructive and NOT idempotent', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.writeTier, 'irreversible', `${tool.name} tier`);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      // A second delete answers 404, so the two calls do NOT land in the same
      // place — claiming idempotence would invite a replay of an unsafe write.
      idempotentHint: false,
      openWorldHint: true,
    });
  }
});

test('every delete tool warns about the opt-in and names an alternative', () => {
  for (const tool of ALL_TOOLS) {
    assert.match(tool.description, /IRREVERSIBLE/);
    assert.match(tool.description, /JIRA_ALLOW_IRREVERSIBLE/);
  }
  assert.match(deleteIssueTool.description, /closing the issue instead/);
  assert.match(deleteCommentTool.description, /jira_update_comment/);
});

test('the schemas are strict, carry the control fields and nothing extra', () => {
  for (const tool of ALL_TOOLS) {
    const parsed = tool.input.safeParse({ issue: KEY, commentId: '1', worklogId: '1' });
    // Each tool declares exactly one id argument, so the other two are unknown.
    assert.equal(parsed.success, false, `${tool.name} accepted a foreign id argument`);

    const control = tool.input.safeParse({
      issue: KEY,
      commentId: COMMENT_ID,
      worklogId: WORKLOG_ID,
      apply: true,
      plan_id: 'plan_000000000000000000000000',
      profile: 'prod',
    });
    assert.equal(control.success, false);
  }

  assert.equal(deleteIssueTool.input.safeParse({ issue: KEY }).success, true);
  assert.equal(deleteIssueTool.input.safeParse({ issue: '' }).success, false);
  assert.equal(
    deleteIssueTool.input.safeParse({ issue: KEY, deleteSubtasks: 'yes' }).success,
    false,
  );
  assert.equal(
    deleteCommentTool.input.safeParse({ issue: KEY, commentId: COMMENT_ID }).success,
    true,
  );
  assert.equal(
    deleteWorklogTool.input.safeParse({ issue: KEY, worklogId: WORKLOG_ID }).success,
    true,
  );
});

// ---------------------------------------------------------------------------
// jira_delete_issue
// ---------------------------------------------------------------------------

test('the plan of an issue delete reads the issue and shows what would be lost', async () => {
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(issueBody(['PROJ-2'])));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn));

  assert.equal(result.ok, true);
  // The read happened; the DELETE did not — the fake has no DELETE route, so a
  // request that escaped would have thrown rather than silently succeeded.
  assert.deepEqual(fake.routes(), [`GET /rest/api/3/issue/${KEY}`]);
  assert.equal(fake.lastRequest()?.query?.fields, 'summary,status,issuetype,subtasks');
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: `/issue/${KEY}`,
    // Always present, including when false: the URL always carries it, so the
    // plan always shows it.
    query: { deleteSubtasks: false },
  });
  assert.deepEqual(beforeOf(result), {
    kind: 'issue',
    id: '10001',
    key: KEY,
    summary: 'Retry policy',
    status: 'In Progress',
    issueType: 'Task',
    subtasks: ['PROJ-2'],
    subtaskCount: 1,
    deleteSubtasks: false,
  });
  // D15: an issue summary is tenant-authored prose the model is about to act on.
  assert.equal(result._untrusted, true);
  assert.equal((result.hints ?? [])[0]?.code, 'plan');
});

test('CC-63: the plan states the blast radius twice: in the query and in the snapshot', async () => {
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraOk(issueBody(['PROJ-2', 'PROJ-3'])),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(deleteIssueTool, { issue: KEY, deleteSubtasks: true }, {}, fake.fn),
  );

  // `deleteSubtasks` decides between losing one issue and losing a tree, so it
  // is visible in the request the plan shows AND in the snapshot of what goes.
  assert.deepEqual((result.data as { planned: PlannedRequest }).planned.query, {
    deleteSubtasks: true,
  });
  assert.deepEqual(beforeOf(result), {
    kind: 'issue',
    id: '10001',
    key: KEY,
    summary: 'Retry policy',
    status: 'In Progress',
    issueType: 'Task',
    subtasks: ['PROJ-2', 'PROJ-3'],
    subtaskCount: 2,
    deleteSubtasks: true,
  });
});

test('CC-65: an applied issue delete echoes the same snapshot the plan showed', async () => {
  const fake = createFakeJiraRequest()
    .on(DELETE_ISSUE_ROUTE, NO_CONTENT)
    .on(ISSUE_ROUTE, jiraOk(issueBody([])));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteIssueTool,
    { issue: KEY },
    fake,
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.data, {
    issue: KEY,
    deleted: true,
    deleteSubtasks: false,
    before: beforeOf(plan),
  });
  assert.equal(applied._untrusted, true, 'the receipt carries the same tenant prose');
  assert.deepEqual(fake.routes(), [
    `GET /rest/api/3/issue/${KEY}`,
    `GET /rest/api/3/issue/${KEY}`,
    DELETE_ISSUE_ROUTE,
  ]);
  assert.equal(fake.lastRequest()?.query?.deleteSubtasks, false);
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('a long summary is excerpted and the subtask list is capped', async () => {
  const many = Array.from({ length: 25 }, (_, index) => `PROJ-${index + 2}`);
  const body = issueBody(many);
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(body));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn)),
  );

  assert.equal((before.subtasks as readonly string[]).length, 20);
  assert.equal(before.subtaskCount, 25, 'the count is honest even when the list is not');
});

test('the issue snapshot names its fields — no wire object is spread (D41)', async () => {
  const body = issueBody([]);
  const fields = body.fields as Record<string, unknown>;
  fields.description = adfDoc('An internal note nobody asked for.');
  fields.reporter = WIRE_USER;
  fields.customfield_10010 = 'secret';
  const fake = createFakeJiraRequest().on(ISSUE_ROUTE, jiraOk(body));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn)),
  );

  assert.deepEqual(Object.keys(before).sort(), [
    'deleteSubtasks',
    'id',
    'issueType',
    'key',
    'kind',
    'status',
    'subtaskCount',
    'subtasks',
    'summary',
  ]);
});

test('CC-66: a thin issue degrades to the keys it really has', async () => {
  // Jira omits `status`/`issuetype` from a `fields` projection the caller has no
  // permission for, and a `subtasks` array can carry rows without a `key`. The
  // snapshot must stay a valid object rather than invent an empty string — and
  // the rows it could not name still count (CC-87), so `subtaskCount` is 3
  // against an empty key list rather than the 0 that would read as "no
  // children" to whoever approves the delete.
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    // synthetic
    jiraOk({
      id: '10001',
      key: KEY,
      fields: { summary: null, status: 'Done', issuetype: [], subtasks: [{}, null, 7] },
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn)),
  );

  assert.deepEqual(before, {
    kind: 'issue',
    id: '10001',
    key: KEY,
    subtasks: [],
    subtaskCount: 3,
    deleteSubtasks: false,
  });
});

test('CC-87: a subtask row Jira did not name still COUNTS toward what is destroyed', async () => {
  // CC-66 records the wire shape: `fields.subtasks` can carry rows without a
  // readable `key`. Leaving such a row out of the KEY LIST is right — there is
  // nothing to name. Leaving it out of `subtaskCount` is not: the count is the
  // only number an approver of an irreversible `deleteSubtasks: true` reads,
  // and deriving it from the keys we managed to parse turns "a child we could
  // not name" into "no child at all". The count must describe the rows Jira
  // reported, so the plan can only ever over-state what the apply destroys.
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    // synthetic
    jiraOk({
      id: '10001',
      key: KEY,
      fields: {
        summary: 'Retry policy',
        subtasks: [
          { id: '20000', self: 'https://example.atlassian.net/rest/api/3/issue/20000' },
          { id: '20001', key: 'PROJ-2', fields: { summary: 'Subtask PROJ-2' } },
        ],
      },
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteIssueTool, { issue: KEY, deleteSubtasks: true }, {}, fake.fn),
    ),
  );

  assert.equal(before.subtaskCount, 2, 'both rows are children this delete takes');
  assert.deepEqual(before.subtasks, ['PROJ-2'], 'only the named row can be listed');
});

test('a status and a type without a name drop out, and no subtasks key means none', async () => {
  // Two shapes the previous case does not reach: the field IS an object but
  // carries no `name` (a status the caller may see the id of but not the
  // workflow behind), and `subtasks` is absent altogether (Jira Work Management
  // has no subtasks at all). Both must degrade to a missing key — `undefined`
  // under `status` would travel to the model as a field that exists and is
  // empty, which is a different claim.
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    // synthetic
    jiraOk({
      id: '10001',
      key: KEY,
      fields: {
        summary: 'Retry policy',
        status: { id: '10001', statusCategory: { key: 'indeterminate' } },
        issuetype: { id: '10002', subtask: false },
      },
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn)),
  );

  assert.deepEqual(before, {
    kind: 'issue',
    id: '10001',
    key: KEY,
    summary: 'Retry policy',
    subtasks: [],
    subtaskCount: 0,
    deleteSubtasks: false,
  });
});

test('the subtask refusal survives the tool ring with its remediation', async () => {
  const fake = createFakeJiraRequest()
    .on(
      DELETE_ISSUE_ROUTE,
      jiraErr(
        new JiraError({
          kind: 'validation',
          message: 'The issue has subtasks and deleteSubtasks is false.',
          retryable: false,
          httpStatus: 400,
          jiraMessages: ['The issue has subtasks and deleteSubtasks is false.'],
        }),
      ),
    )
    .on(ISSUE_ROUTE, jiraOk(issueBody(['PROJ-2'])));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { applied } = await planThenApply(gate, deleteIssueTool, { issue: KEY }, fake);

  assert.equal(applied.ok, false);
  assert.equal(applied.error?.kind, 'validation');
  assert.match(applied.error?.remediation ?? '', /deleteSubtasks/);
});

// ---------------------------------------------------------------------------
// jira_delete_comment and jira_delete_worklog
// ---------------------------------------------------------------------------

test('the comment snapshot flattens the ADF body and drops the author PII', async () => {
  const fake = createFakeJiraRequest()
    .on(DELETE_COMMENT_ROUTE, NO_CONTENT)
    .on(COMMENT_ROUTE, jiraOk(COMMENT_BODY));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteCommentTool,
    { issue: KEY, commentId: COMMENT_ID },
    fake,
  );

  assert.deepEqual(beforeOf(plan), {
    kind: 'comment',
    issue: KEY,
    id: COMMENT_ID,
    author: { accountId: ACCOUNT_ID, displayName: 'User One' },
    created: '2026-08-07T10:00:00.000+0000',
    updated: '2026-08-07T10:00:00.000+0000',
    body: 'Paired on the retry policy.',
    bodyTruncated: false,
    // JSM: the plan has to say the comment was internal, not customer-visible.
    jsdPublic: false,
  });
  assert.deepEqual(applied.data, {
    issue: KEY,
    commentId: COMMENT_ID,
    deleted: true,
    before: beforeOf(plan),
  });
  assert.equal(applied._untrusted, true);
  assert.equal(JSON.stringify(applied.data).includes('example.invalid'), false);
});

test('a long comment body is excerpted and says so', async () => {
  const long = 'x'.repeat(900);
  const fake = createFakeJiraRequest().on(
    COMMENT_ROUTE,
    jiraOk({ ...COMMENT_BODY, body: adfDoc(long) }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteCommentTool, { issue: KEY, commentId: COMMENT_ID }, {}, fake.fn),
    ),
  );

  assert.equal(before.bodyTruncated, true);
  assert.equal(String(before.body).length, 501, '500 characters plus the cut marker');
  assert.match(String(before.body), /…$/);
});

test('a comment with no author and no timestamps still plans, with only its body', async () => {
  // A JSM portal comment from an unauthenticated customer arrives with no
  // `accountId`, so the projection has no user to name; a comment fetched from
  // an app-created record can come back without `created`/`updated`/`jsdPublic`
  // as well. What the operator is about to lose is the text, and the text is
  // what the plan must still show.
  const fake = createFakeJiraRequest().on(
    COMMENT_ROUTE,
    // synthetic
    jiraOk({
      id: COMMENT_ID,
      author: { accountType: 'customer', displayName: 'Anonymous' },
      body: adfDoc('Raised from the portal.'),
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteCommentTool, { issue: KEY, commentId: COMMENT_ID }, {}, fake.fn),
    ),
  );

  assert.deepEqual(before, {
    kind: 'comment',
    issue: KEY,
    id: COMMENT_ID,
    body: 'Raised from the portal.',
    bodyTruncated: false,
  });
});

test('the author projection keeps the halves Jira actually sent', async () => {
  const gateOf = (): WriteGate =>
    createWriteGate({ writeMode: 'plan', allowIrreversible: true, rng: countingRng() });
  const planWith = async (author: Record<string, unknown>): Promise<unknown> => {
    const fake = createFakeJiraRequest().on(
      COMMENT_ROUTE,
      jiraOk({ ...COMMENT_BODY, author }),
    );
    const before = beforeOf(
      await gateOf().execute(
        callOf(deleteCommentTool, { issue: KEY, commentId: COMMENT_ID }, {}, fake.fn),
      ),
    );
    return before['author'];
  };

  // A user deleted under GDPR keeps the shape but loses the id: an empty
  // accountId is not an id, and echoing `accountId: ''` would invite a follow-up
  // call that resolves to nobody.
  assert.deepEqual(await planWith({ accountId: '', displayName: 'Former user' }), {
    displayName: 'Former user',
  });
  // The opposite half: an id with the display name withheld by the tenant's
  // privacy setting. The id is the part that identifies the author anyway.
  assert.deepEqual(await planWith({ accountId: ACCOUNT_ID }), {
    accountId: ACCOUNT_ID,
  });
  // Both halves gone at once — GDPR-deleted *and* name withheld. The key is
  // omitted rather than emitted empty: `"author": {}` in front of a human
  // approving a delete answers nothing and reads as a bug.
  assert.equal(await planWith({ accountId: '' }), undefined);
});

test('the worklog snapshot keeps the time and the started instant verbatim', async () => {
  const fake = createFakeJiraRequest()
    .on(DELETE_WORKLOG_ROUTE, NO_CONTENT)
    .on(WORKLOG_ROUTE, jiraOk(WORKLOG_BODY));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteWorklogTool,
    { issue: KEY, worklogId: WORKLOG_ID },
    fake,
  );

  assert.deepEqual(beforeOf(plan), {
    kind: 'worklog',
    issue: KEY,
    id: WORKLOG_ID,
    author: { accountId: ACCOUNT_ID, displayName: 'User One' },
    // Jira's own offset, never re-rendered in the host zone (D16).
    started: '2026-08-07T15:30:00.000+0530',
    timeSpent: '1h',
    timeSpentSeconds: 3600,
    comment: 'Paired on the retry policy.',
    commentTruncated: false,
  });
  assert.deepEqual(applied.data, {
    issue: KEY,
    worklogId: WORKLOG_ID,
    deleted: true,
    before: beforeOf(plan),
  });
  // `adjustEstimate` is not exposed: Jira's default gives the time back.
  assert.equal(fake.lastRequest()?.query, undefined);
});

test('a worklog with no comment yields a snapshot without the comment keys', async () => {
  const bare: Record<string, unknown> = { ...WORKLOG_BODY };
  delete bare['comment'];
  const fake = createFakeJiraRequest().on(WORKLOG_ROUTE, jiraOk(bare));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteWorklogTool, { issue: KEY, worklogId: WORKLOG_ID }, {}, fake.fn),
    ),
  );

  assert.equal(Object.hasOwn(before, 'comment'), false);
  assert.equal(Object.hasOwn(before, 'commentTruncated'), false);
});

test('a worklog whose fields arrive in the wrong shape plans without inventing them', async () => {
  // `api/issues.ts` emits `started`/`timeSpent`/`timeSpentSeconds` only when the
  // wire types match, and a record with no `accountId` is not a user (JIRA-API
  // §Users). All four guards can fire together — an imported or app-created
  // worklog is the everyday way it happens — and the snapshot then has to be
  // honest about holding nothing but the identity of what is about to be lost,
  // rather than reporting `timeSpent: undefined` as if the field were empty.
  const fake = createFakeJiraRequest().on(
    WORKLOG_ROUTE,
    // synthetic
    jiraOk({
      id: WORKLOG_ID,
      issueId: '10001',
      author: { displayName: 'Imported' },
      started: 1_754_570_000_000,
      timeSpent: null,
      timeSpentSeconds: '3600',
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteWorklogTool, { issue: KEY, worklogId: WORKLOG_ID }, {}, fake.fn),
    ),
  );

  assert.deepEqual(before, { kind: 'worklog', issue: KEY, id: WORKLOG_ID });
});

// ---------------------------------------------------------------------------
// The tier, end to end through the tools
// ---------------------------------------------------------------------------

test('without the opt-in every delete plans and none of them applies', async () => {
  const cases: readonly [AnyToolSpec, Record<string, unknown>, string][] = [
    [deleteIssueTool, { issue: KEY }, ISSUE_ROUTE],
    [deleteCommentTool, { issue: KEY, commentId: COMMENT_ID }, COMMENT_ROUTE],
    [deleteWorklogTool, { issue: KEY, worklogId: WORKLOG_ID }, WORKLOG_ROUTE],
  ];
  const bodies: readonly Record<string, unknown>[] = [
    issueBody([]),
    COMMENT_BODY,
    WORKLOG_BODY,
  ];

  for (const [index, [tool, args]] of cases.entries()) {
    const fake = createFakeJiraRequest();
    // Only the READ is programmed: any DELETE that escaped would throw.
    fake.on(cases[index]?.[2] ?? '', jiraOk(bodies[index]));
    const gate = createWriteGate({
      writeMode: 'apply',
      allowIrreversible: false,
      rng: countingRng(),
    });

    const plan = await gate.execute(callOf(tool, args, {}, fake.fn));
    assert.equal(plan.ok, true, `${tool.name} must still plan`);
    assert.match(
      (plan.hints ?? [])[0]?.message ?? '',
      /JIRA_ALLOW_IRREVERSIBLE/,
      `${tool.name} must say why apply will fail`,
    );

    const planId = String((plan.data as { plan_id?: string }).plan_id);
    const refused = await gate.execute(
      callOf(tool, args, { apply: true, plan_id: planId }, fake.fn),
    );
    assert.equal(refused.ok, false, `${tool.name} must not apply`);
    assert.equal(refused.error?.kind, 'write_gated');
    assert.match(refused.error?.remediation ?? '', /JIRA_ALLOW_IRREVERSIBLE/);
    assert.equal(fake.routes().length, 1, 'the refusal read nothing and sent nothing');
  }
});

test('an applied delete leaves exactly one journal line; a plan leaves none', async () => {
  const clock = createFakeClock(NOW);
  const journal = createMemoryJournal(clock);
  const fake = createFakeJiraRequest()
    .on(DELETE_ISSUE_ROUTE, NO_CONTENT)
    .on(ISSUE_ROUTE, jiraOk(issueBody([])));
  const gate = journalingGate(
    createWriteGate({ writeMode: 'apply', allowIrreversible: true, rng: countingRng() }),
    { journal },
  );

  const plan = await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn));
  assert.equal(
    journal.entries.length,
    0,
    'a plan destroyed nothing, so it records nothing',
  );

  const planId = String((plan.data as { plan_id?: string }).plan_id);
  const applied = await gate.execute(
    callOf(deleteIssueTool, { issue: KEY }, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(applied.ok, true);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.tool, 'jira_delete_issue');
  assert.equal(journal.entries[0]?.ok, true);
  assert.equal(journal.entries[0]?.httpStatus, 204);
  assert.equal(journal.entries[0]?.issueKey, KEY);
});

test('a read that fails before the delete never reaches the DELETE', async () => {
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraErr(
      new JiraError({
        kind: 'not_found',
        message: 'Issue does not exist or you do not have permission to see it.',
        retryable: false,
        httpStatus: 404,
      }),
    ),
  );
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const result = await gate.execute(callOf(deleteIssueTool, { issue: KEY }, {}, fake.fn));

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'not_found');
  assert.deepEqual(fake.routes(), [`GET /rest/api/3/issue/${KEY}`]);
});
