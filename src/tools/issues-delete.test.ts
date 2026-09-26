// Tests for `tools/issues-delete.ts` (WP-72, WP-111, WP-121) — contract tier
// (TESTING.md).
//
// `api/issues.ts`, `api/collab.ts`, `api/agile.ts` and `api/bulk.ts` already
// own the wire shapes (the DELETE paths, the `deleteSubtasks` query, the
// subtask 400, the removeAndSwap body, the sprint-state 400, the bulk submit
// bodies and the derived `selectedActions`), so nothing here re-asserts them.
// What is asserted is the half this ring owns, and it is unusual in exactly one
// way: these tools are the only ones whose value to a caller is produced BEFORE
// the mutation. So the file is mostly about the before-state — that it is built
// by construction (D41), excerpted, projected free of PII, and that it reaches
// BOTH the plan envelope and the apply receipt with the same content. The two
// bulk writes are the one exception this file proves on purpose: their
// before-state is the request's own blast radius (a count and a capped echo of
// the caller's list), fetched from nowhere (CC-129).
//
// The gate is real here rather than faked: `createWriteGate` is what turns a
// handler into a plan, and the whole point of this package is what the gate does
// with `writeTier: 'irreversible'`. `mcp/write-mode.test.ts` proves the tier
// rules in isolation; this file proves the eight tools are wired into them.
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads and marked `// synthetic`. The fake throws on a route nobody
// programmed, so "exactly these requests happened" holds by construction.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_API } from '../api/port.js';
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
  bulkDeleteIssuesTool,
  bulkEditIssuesTool,
  deleteCommentTool,
  deleteComponentTool,
  deleteIssueTool,
  deleteSprintTool,
  deleteVersionTool,
  deleteWorklogTool,
  issuesDeletePackage,
} from './issues-delete.js';

const KEY = 'PROJ-1';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';
const COMMENT_ID = '10100';
const WORKLOG_ID = '40001';
const COMPONENT_ID = 10500;
const MOVE_COMPONENT_ID = 10501;
const VERSION_ID = 10600;
const SWAP_VERSION_ID = 10601;
const SPRINT_ID = 42;

/** Routes are method + path; the query string is asserted separately. */
const ISSUE_ROUTE = `GET /rest/api/3/issue/${KEY}`;
const DELETE_ISSUE_ROUTE = `DELETE /rest/api/3/issue/${KEY}`;
const COMMENT_ROUTE = `GET /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`;
const DELETE_COMMENT_ROUTE = `DELETE /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`;
const WORKLOG_ROUTE = `GET /rest/api/3/issue/${KEY}/worklog/${WORKLOG_ID}`;
const DELETE_WORKLOG_ROUTE = `DELETE /rest/api/3/issue/${KEY}/worklog/${WORKLOG_ID}`;
const COMPONENT_ROUTE = `GET /rest/api/3/component/${COMPONENT_ID}`;
const COMPONENT_COUNTS_ROUTE = `GET /rest/api/3/component/${COMPONENT_ID}/relatedIssueCounts`;
const DELETE_COMPONENT_ROUTE = `DELETE /rest/api/3/component/${COMPONENT_ID}`;
const VERSION_ROUTE = `GET /rest/api/3/version/${VERSION_ID}`;
const VERSION_COUNTS_ROUTE = `GET /rest/api/3/version/${VERSION_ID}/relatedIssueCounts`;
/** The version delete: the bare `DELETE /version/{id}` is deprecated (CC-122). */
const REMOVE_AND_SWAP_ROUTE = `POST /rest/api/3/version/${VERSION_ID}/removeAndSwap`;
const SPRINT_ROUTE = `GET /rest/agile/1.0/sprint/${SPRINT_ID}`;
const DELETE_SPRINT_ROUTE = `DELETE /rest/agile/1.0/sprint/${SPRINT_ID}`;
/** The two bulk submits — neither route is a string prefix of the other. */
const BULK_DELETE_SUBMIT_ROUTE = 'POST /rest/api/3/bulk/issues/delete';
const BULK_EDIT_SUBMIT_ROUTE = 'POST /rest/api/3/bulk/issues/fields';
/** The bulk task id as both submits return it. // synthetic */
const TASK_ID = '10321';

/** `PROJ-1` … `PROJ-{count}` — distinct keys for the cap and echo tests. */
function bulkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `PROJ-${index + 1}`);
}

/** The 201 both bulk submits answer with. // synthetic */
const BULK_SUBMIT_RECEIPT = jiraOk({ taskId: TASK_ID }, { status: 201 });

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

/** `GET /component/{id}`. // synthetic */
const COMPONENT_BODY = {
  self: `https://example.atlassian.net/rest/api/3/component/${COMPONENT_ID}`,
  id: String(COMPONENT_ID),
  name: 'Backend',
  description: 'Everything server-side.',
  lead: WIRE_USER,
  assigneeType: 'PROJECT_LEAD',
  isAssigneeTypeValid: true,
  project: 'PROJ',
  projectId: 10000,
};

/** `GET /component/{id}/relatedIssueCounts`. // synthetic */
const COMPONENT_COUNTS_BODY = {
  self: `https://example.atlassian.net/rest/api/3/component/${COMPONENT_ID}/relatedIssueCounts`,
  issueCount: 7,
};

/** `GET /version/{id}`. // synthetic */
const VERSION_BODY = {
  self: `https://example.atlassian.net/rest/api/3/version/${VERSION_ID}`,
  id: String(VERSION_ID),
  name: '2.0.0',
  description: 'The rewrite.',
  archived: false,
  released: true,
  startDate: '2026-01-05',
  releaseDate: '2026-06-30',
  userStartDate: '05/Jan/26',
  userReleaseDate: '30/Jun/26',
  overdue: false,
  projectId: 10000,
};

/** `GET /version/{id}/relatedIssueCounts`. // synthetic */
const VERSION_COUNTS_BODY = {
  self: `https://example.atlassian.net/rest/api/3/version/${VERSION_ID}/relatedIssueCounts`,
  issuesFixedCount: 5,
  issuesAffectedCount: 2,
  issueCountWithCustomFieldsShowingVersion: 1,
  customFieldUsage: [],
};

/** `GET /rest/agile/1.0/sprint/{sprintId}` for an ACTIVE sprint. // synthetic */
const SPRINT_BODY = {
  id: SPRINT_ID,
  self: `https://example.atlassian.net/rest/agile/1.0/sprint/${SPRINT_ID}`,
  state: 'active',
  name: 'Sprint 7',
  startDate: '2026-08-03T08:00:00.000Z',
  endDate: '2026-08-17T08:00:00.000Z',
  goal: 'Ship the retry policy.',
  originBoardId: 17,
};

/** Jira's answer to every delete here, the removeAndSwap POST included. */
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
    api: CLOUD_API,
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

test('CC-120: the issues-delete package is the whole irreversible surface, and nothing else', () => {
  // The ID is historical — it predates the non-issue deletes and stays so that
  // an existing `JIRA_PACKAGES_DENY=issues-delete` keeps denying EVERYTHING
  // irreversible after the upgrade; the title is what generalized. Phase 12
  // repeated the same argument for the bulk writes (CC-126).
  assert.equal(issuesDeletePackage.id, 'issues-delete');
  assert.equal(issuesDeletePackage.title, 'Deletes and bulk changes (irreversible)');
  assert.deepEqual(
    ALL_TOOLS.map((tool) => tool.name),
    [
      'jira_delete_issue',
      'jira_delete_comment',
      'jira_delete_worklog',
      'jira_delete_component',
      'jira_delete_version',
      'jira_delete_sprint',
      'jira_bulk_delete_issues',
      'jira_bulk_edit_issues',
    ],
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
  assert.match(deleteComponentTool.description, /jira_update_component/);
  assert.match(deleteVersionTool.description, /jira_update_version/);
  assert.match(deleteSprintTool.description, /jira_close_sprint/);
  // The one delete whose issues survive: the model must know they only move.
  assert.match(deleteSprintTool.description, /backlog/);
  // The bulk writes name the poller: a 201 receipt alone never says "done".
  assert.match(bulkDeleteIssuesTool.description, /jira_get_bulk_status/);
  assert.match(bulkEditIssuesTool.description, /jira_get_bulk_status/);
});

test('the schemas are strict, carry the control fields and nothing extra', () => {
  for (const tool of ALL_TOOLS) {
    const parsed = tool.input.safeParse({ issue: KEY, commentId: '1', worklogId: '1' });
    // Each tool declares at most one of these id arguments (the bulk writes
    // declare none of them), so at least two of the keys are always unknown.
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

  // The project-entity deletes take NUMERIC ids (the collab pattern). CC-181:
  // the digit-string spelling the list tools report is converted, and a name
  // or a non-positive spelling is still refused.
  assert.equal(
    deleteComponentTool.input.safeParse({ componentId: COMPONENT_ID }).success,
    true,
  );
  assert.equal(
    deleteComponentTool.input.safeParse({
      componentId: COMPONENT_ID,
      moveIssuesTo: MOVE_COMPONENT_ID,
    }).success,
    true,
  );
  const spelled = deleteComponentTool.input.safeParse({
    componentId: String(COMPONENT_ID),
  });
  assert.equal(spelled.success, true);
  assert.equal(spelled.data?.componentId, COMPONENT_ID);
  assert.equal(
    deleteComponentTool.input.safeParse({ componentId: 'Billing' }).success,
    false,
  );
  assert.equal(deleteComponentTool.input.safeParse({ componentId: '0' }).success, false);
  assert.equal(
    deleteComponentTool.input.safeParse({ componentId: '010' }).success,
    false,
  );
  assert.equal(
    deleteVersionTool.input.safeParse({
      versionId: VERSION_ID,
      moveFixIssuesTo: SWAP_VERSION_ID,
      moveAffectedIssuesTo: SWAP_VERSION_ID,
    }).success,
    true,
  );
  assert.equal(deleteVersionTool.input.safeParse({ versionId: 0 }).success, false);
  assert.equal(deleteSprintTool.input.safeParse({ sprintId: SPRINT_ID }).success, true);
  assert.equal(deleteSprintTool.input.safeParse({ sprintId: 1.5 }).success, false);
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
// jira_delete_component
// ---------------------------------------------------------------------------

test('CC-121: the component plan shows the blast radius, and no DELETE escapes', async () => {
  const fake = createFakeJiraRequest()
    // Counts before the component: string rules match by PREFIX, and the
    // component route is a prefix of its own /relatedIssueCounts.
    .on(COMPONENT_COUNTS_ROUTE, jiraOk(COMPONENT_COUNTS_BODY))
    .on(COMPONENT_ROUTE, jiraOk(COMPONENT_BODY));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(
      deleteComponentTool,
      { componentId: COMPONENT_ID, moveIssuesTo: MOVE_COMPONENT_ID },
      {},
      fake.fn,
    ),
  );

  assert.equal(result.ok, true);
  // Both reads happened; the DELETE did not — its route is not programmed, so a
  // request that escaped would have thrown rather than silently succeeded.
  assert.deepEqual(fake.routes(), [COMPONENT_ROUTE, COMPONENT_COUNTS_ROUTE]);
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: `/component/${COMPONENT_ID}`,
    query: { moveIssuesTo: '10501' },
  });
  // `issueCount` is the number the approver reads before saying yes (CC-121),
  // and the reassignment target sits right beside it (CC-125).
  assert.deepEqual(beforeOf(result), {
    kind: 'component',
    id: '10500',
    name: 'Backend',
    description: 'Everything server-side.',
    descriptionTruncated: false,
    lead: 'User One',
    project: 'PROJ',
    issueCount: 7,
    moveIssuesTo: '10501',
  });
  // The lead survives as a display name only — no accountId, no email.
  assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
  assert.equal(result._untrusted, true);
});

test('an applied component delete echoes the snapshot and the reassignment', async () => {
  const fake = createFakeJiraRequest()
    .on(DELETE_COMPONENT_ROUTE, NO_CONTENT)
    // Counts before the component: string rules match by PREFIX, and the
    // component route is a prefix of its own /relatedIssueCounts.
    .on(COMPONENT_COUNTS_ROUTE, jiraOk(COMPONENT_COUNTS_BODY))
    .on(COMPONENT_ROUTE, jiraOk(COMPONENT_BODY));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteComponentTool,
    { componentId: COMPONENT_ID, moveIssuesTo: MOVE_COMPONENT_ID },
    fake,
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.data, {
    componentId: '10500',
    deleted: true,
    movedIssuesTo: '10501',
    before: beforeOf(plan),
  });
  assert.equal(applied._untrusted, true, 'the receipt carries the same tenant prose');
  assert.deepEqual(fake.routes(), [
    COMPONENT_ROUTE,
    COMPONENT_COUNTS_ROUTE,
    COMPONENT_ROUTE,
    COMPONENT_COUNTS_ROUTE,
    DELETE_COMPONENT_ROUTE,
  ]);
  assert.deepEqual(fake.lastRequest()?.query, { moveIssuesTo: '10501' });
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('a thin component and a countless answer degrade to what Jira sent (CC-66)', async () => {
  const fake = createFakeJiraRequest()
    // synthetic — the counts endpoint answered without a number. Registered
    // before the component route, which is a string PREFIX of this one.
    .on(COMPONENT_COUNTS_ROUTE, jiraOk({ self: COMPONENT_COUNTS_BODY.self }))
    // synthetic — a stub component: no description, no lead, no project halves.
    .on(COMPONENT_ROUTE, jiraOk({ id: '10500', name: 'Backend' }));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(deleteComponentTool, { componentId: COMPONENT_ID }, {}, fake.fn),
    ),
  );

  // No `issueCount: 0` guess: a blast radius the plan cannot state is different
  // from one it states as zero (CC-66).
  assert.deepEqual(before, { kind: 'component', id: '10500', name: 'Backend' });
});

test('a lead with no display name is named by accountId; one with no accountId drops out', async () => {
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  // synthetic — a lead Jira sent as an accountId alone (the display name is
  // withheld under some privacy settings), and a project echoed only by id.
  const byId = createFakeJiraRequest()
    .on(COMPONENT_COUNTS_ROUTE, jiraOk(COMPONENT_COUNTS_BODY))
    .on(
      COMPONENT_ROUTE,
      jiraOk({
        id: String(COMPONENT_ID),
        name: 'Backend',
        lead: { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: '' },
        projectId: 10000,
      }),
    );
  const named = beforeOf(
    await gate.execute(
      callOf(deleteComponentTool, { componentId: COMPONENT_ID }, {}, byId.fn),
    ),
  );
  assert.equal(named['lead'], '5b10ac8d82e05b22cc7d4ef5');
  // `projectId` is a number on the wire; the snapshot keeps every id a string.
  assert.equal(named['project'], '10000');

  // synthetic — a lead with a name but no accountId is not addressable and the
  // api ring drops it (JIRA-API.md §Users), so the snapshot has no `lead` key
  // rather than a name nobody can resolve.
  const anonymous = createFakeJiraRequest()
    .on(COMPONENT_COUNTS_ROUTE, jiraOk(COMPONENT_COUNTS_BODY))
    .on(
      COMPONENT_ROUTE,
      jiraOk({
        id: String(COMPONENT_ID),
        name: 'Backend',
        lead: { displayName: 'Ghost' },
      }),
    );
  const unnamed = beforeOf(
    await gate.execute(
      callOf(deleteComponentTool, { componentId: COMPONENT_ID }, {}, anonymous.fn),
    ),
  );
  assert.equal(Object.hasOwn(unnamed, 'lead'), false);
  assert.equal(Object.hasOwn(unnamed, 'project'), false);
});

// ---------------------------------------------------------------------------
// jira_delete_version
// ---------------------------------------------------------------------------

test('CC-123: the version plan carries all three related-issue counts', async () => {
  const fake = createFakeJiraRequest()
    // Counts before the version — the same prefix rule as the component's.
    .on(VERSION_COUNTS_ROUTE, jiraOk(VERSION_COUNTS_BODY))
    .on(VERSION_ROUTE, jiraOk(VERSION_BODY));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(
      deleteVersionTool,
      {
        versionId: VERSION_ID,
        moveFixIssuesTo: SWAP_VERSION_ID,
        moveAffectedIssuesTo: SWAP_VERSION_ID,
      },
      {},
      fake.fn,
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.routes(), [VERSION_ROUTE, VERSION_COUNTS_ROUTE]);
  // The delete is the removeAndSwap POST (CC-122) and the ids in its body are
  // NUMBERS — the plan shows the request exactly as it would go out.
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'POST',
    path: `/version/${VERSION_ID}/removeAndSwap`,
    body: { moveFixIssuesTo: SWAP_VERSION_ID, moveAffectedIssuesTo: SWAP_VERSION_ID },
  });
  // fixVersion, affectedVersion AND the custom-field pickers: three different
  // blast radii, and an approver needs all three (CC-123). The swap targets
  // sit beside them (CC-125).
  assert.deepEqual(beforeOf(result), {
    kind: 'version',
    id: '10600',
    name: '2.0.0',
    description: 'The rewrite.',
    descriptionTruncated: false,
    archived: false,
    released: true,
    startDate: '2026-01-05',
    releaseDate: '2026-06-30',
    project: '10000',
    issuesFixedCount: 5,
    issuesAffectedCount: 2,
    issueCountWithCustomFieldsShowingVersion: 1,
    moveFixIssuesTo: '10601',
    moveAffectedIssuesTo: '10601',
  });
  assert.equal(result._untrusted, true);
});

test('an applied version delete echoes the snapshot and both swap targets', async () => {
  const fake = createFakeJiraRequest()
    .on(REMOVE_AND_SWAP_ROUTE, NO_CONTENT)
    // Counts before the version — the same prefix rule as the component's.
    .on(VERSION_COUNTS_ROUTE, jiraOk(VERSION_COUNTS_BODY))
    .on(VERSION_ROUTE, jiraOk(VERSION_BODY));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteVersionTool,
    {
      versionId: VERSION_ID,
      moveFixIssuesTo: SWAP_VERSION_ID,
      moveAffectedIssuesTo: SWAP_VERSION_ID,
    },
    fake,
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.data, {
    versionId: '10600',
    deleted: true,
    movedFixIssuesTo: '10601',
    movedAffectedIssuesTo: '10601',
    before: beforeOf(plan),
  });
  assert.equal(applied._untrusted, true, 'the receipt carries the same tenant prose');
  assert.deepEqual(fake.routes(), [
    VERSION_ROUTE,
    VERSION_COUNTS_ROUTE,
    VERSION_ROUTE,
    VERSION_COUNTS_ROUTE,
    REMOVE_AND_SWAP_ROUTE,
  ]);
  assert.deepEqual(fake.lastRequest()?.body, {
    moveFixIssuesTo: SWAP_VERSION_ID,
    moveAffectedIssuesTo: SWAP_VERSION_ID,
  });
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('CC-125: an absent target reads as stripped or cleared, never as an error', async () => {
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  // Component: no target ⇒ no `moveIssuesTo` query key — `?moveIssuesTo=`
  // would be a different request — and no before-state key either.
  const componentFake = createFakeJiraRequest()
    // Counts before the component: string rules match by PREFIX, and the
    // component route is a prefix of its own /relatedIssueCounts.
    .on(COMPONENT_COUNTS_ROUTE, jiraOk(COMPONENT_COUNTS_BODY))
    .on(COMPONENT_ROUTE, jiraOk(COMPONENT_BODY));
  const componentPlan = await gate.execute(
    callOf(deleteComponentTool, { componentId: COMPONENT_ID }, {}, componentFake.fn),
  );
  assert.deepEqual((componentPlan.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: `/component/${COMPONENT_ID}`,
  });
  assert.equal(Object.hasOwn(beforeOf(componentPlan), 'moveIssuesTo'), false);

  // Version: no targets ⇒ the swap body is `{}` — STILL SENT, because the
  // route stays removeAndSwap (CC-122) — and the documented cleared outcome
  // shows as absent swap keys in the snapshot.
  const versionFake = createFakeJiraRequest()
    // Counts before the version — the same prefix rule as the component's.
    .on(VERSION_COUNTS_ROUTE, jiraOk(VERSION_COUNTS_BODY))
    .on(VERSION_ROUTE, jiraOk(VERSION_BODY));
  const versionPlan = await gate.execute(
    callOf(deleteVersionTool, { versionId: VERSION_ID }, {}, versionFake.fn),
  );
  assert.deepEqual((versionPlan.data as { planned: unknown }).planned, {
    method: 'POST',
    path: `/version/${VERSION_ID}/removeAndSwap`,
    body: {},
  });
  const versionSnapshot = beforeOf(versionPlan);
  assert.equal(Object.hasOwn(versionSnapshot, 'moveFixIssuesTo'), false);
  assert.equal(Object.hasOwn(versionSnapshot, 'moveAffectedIssuesTo'), false);
});

test('a version that is only an id and a name plans without inventing its flags', async () => {
  // synthetic — a freshly created version: no description, no dates, and
  // Jira omits `archived`/`released` rather than sending false. The snapshot
  // must not turn an absent flag into `false`, nor a missing count into 0.
  const fake = createFakeJiraRequest()
    .on(VERSION_COUNTS_ROUTE, jiraOk({ self: VERSION_COUNTS_BODY.self }))
    .on(VERSION_ROUTE, jiraOk({ id: String(VERSION_ID), name: '2.0.0' }));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteVersionTool, { versionId: VERSION_ID }, {}, fake.fn)),
  );

  assert.deepEqual(before, { kind: 'version', id: String(VERSION_ID), name: '2.0.0' });
});

// ---------------------------------------------------------------------------
// jira_delete_sprint
// ---------------------------------------------------------------------------

test('CC-124: the sprint snapshot records the state — an audit trail, not a guard', async () => {
  // SPRINT_BODY is an ACTIVE sprint and the delete still goes through: Jira
  // accepts the delete in any state, and the tool adds no client-side guard.
  // What it adds is the `state` field in the before-state, so the plan is the
  // record of what state the sprint was in when it was destroyed.
  const fake = createFakeJiraRequest()
    .on(DELETE_SPRINT_ROUTE, NO_CONTENT)
    .on(SPRINT_ROUTE, jiraOk(SPRINT_BODY));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    deleteSprintTool,
    { sprintId: SPRINT_ID },
    fake,
  );

  assert.deepEqual(beforeOf(plan), {
    kind: 'sprint',
    id: SPRINT_ID,
    name: 'Sprint 7',
    state: 'active',
    goal: 'Ship the retry policy.',
    goalTruncated: false,
    startDate: '2026-08-03T08:00:00.000Z',
    endDate: '2026-08-17T08:00:00.000Z',
    originBoardId: 17,
  });
  assert.deepEqual((plan.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: `/sprint/${SPRINT_ID}`,
  });
  assert.equal(applied.ok, true);
  // `sprintId` is a NUMBER in the receipt — agile ids are numeric end to end.
  assert.deepEqual(applied.data, {
    sprintId: SPRINT_ID,
    deleted: true,
    before: beforeOf(plan),
  });
  assert.deepEqual(fake.routes(), [SPRINT_ROUTE, SPRINT_ROUTE, DELETE_SPRINT_ROUTE]);
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('a sprint that is only an id and a name still plans honestly', async () => {
  // A sprint that was never started has no dates, no goal, often no board
  // echo; the snapshot then holds the identity and nothing invented.
  const fake = createFakeJiraRequest().on(
    SPRINT_ROUTE,
    jiraOk({ id: SPRINT_ID, name: 'Sprint 7' }), // synthetic
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteSprintTool, { sprintId: SPRINT_ID }, {}, fake.fn)),
  );

  assert.deepEqual(before, { kind: 'sprint', id: SPRINT_ID, name: 'Sprint 7' });
});

test('a closed sprint keeps its completeDate in the snapshot', async () => {
  // synthetic — the same sprint after jira_close_sprint: `completeDate` is
  // the one field only a closed sprint carries, and the audit trail keeps it.
  const fake = createFakeJiraRequest().on(
    SPRINT_ROUTE,
    jiraOk({
      ...SPRINT_BODY,
      state: 'closed',
      completeDate: '2026-08-17T09:15:00.000Z',
    }),
  );
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(deleteSprintTool, { sprintId: SPRINT_ID }, {}, fake.fn)),
  );

  assert.equal(before['state'], 'closed');
  assert.equal(before['completeDate'], '2026-08-17T09:15:00.000Z');
  assert.equal(before['originBoardId'], 17);
});

// ---------------------------------------------------------------------------
// The bulk writes (D103) — jira_bulk_delete_issues / jira_bulk_edit_issues
// ---------------------------------------------------------------------------

test('CC-126: the bulk writes ship inside issues-delete, so one deny token still works', () => {
  // Phase 12 repeats the D102 argument: an operator who set
  // `JIRA_PACKAGES_DENY=issues-delete` before the bulk writes existed keeps
  // denying the WHOLE irreversible surface after the upgrade, without edits.
  for (const tool of [bulkDeleteIssuesTool, bulkEditIssuesTool]) {
    assert.equal(tool.package, 'issues-delete', `${tool.name} package`);
    assert.ok(ALL_TOOLS.includes(tool), `${tool.name} must be exported by the package`);
  }
});

test('CC-127 [CC-183]: a 201 means ENQUEUED — the receipt carries the enqueued hint and never claims done', async () => {
  const fake = createFakeJiraRequest().on(BULK_DELETE_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    bulkDeleteIssuesTool,
    { issues: [KEY, 'PROJ-2'] },
    fake,
  );

  assert.equal(applied.ok, true);
  // The receipt is the taskId and the before-state — no completion claim.
  assert.deepEqual(applied.data, { taskId: TASK_ID, before: beforeOf(plan) });
  const hint = (applied.hints ?? [])[0];
  // CC-183: its own code — `discovery` would send a client to a lookup tool.
  assert.equal(hint?.code, 'enqueued');
  assert.match(hint?.message ?? '', /ENQUEUED/);
  assert.match(hint?.message ?? '', /jira_get_bulk_status/);
  assert.match(hint?.message ?? '', /never waits/);
  assert.equal(applied._untrusted, true);
  // One POST in the whole exchange: the plan sent nothing, and the tool did
  // not block on the queue or poll it behind the caller's back.
  assert.deepEqual(fake.routes(), [BULK_DELETE_SUBMIT_ROUTE]);
  // A replayed submit would enqueue a SECOND task doing the same damage.
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('[CC-178] jira_bulk_edit_issues refuses a label with whitespace', () => {
  const args = { issues: bulkKeys(1), labelsAction: 'ADD' };
  assert.equal(
    bulkEditIssuesTool.input.safeParse({ ...args, labels: ['needs review'] }).success,
    false,
  );
  assert.equal(
    bulkEditIssuesTool.input.safeParse({ ...args, labels: ['needs-review'] }).success,
    true,
  );
});

test('CC-128: the 1000-issue cap is enforced in the schema, before anything is sent', () => {
  // The registry parses input before any handler runs, so a failed parse IS
  // "nothing was sent" — there is no request left to assert away.
  assert.equal(
    bulkDeleteIssuesTool.input.safeParse({ issues: bulkKeys(1000) }).success,
    true,
  );
  assert.equal(
    bulkDeleteIssuesTool.input.safeParse({ issues: bulkKeys(1001) }).success,
    false,
  );
  assert.equal(bulkDeleteIssuesTool.input.safeParse({ issues: [] }).success, false);
  assert.equal(
    bulkEditIssuesTool.input.safeParse({ issues: bulkKeys(1000), priorityId: '2' })
      .success,
    true,
  );
  assert.equal(
    bulkEditIssuesTool.input.safeParse({ issues: bulkKeys(1001), priorityId: '2' })
      .success,
    false,
  );
  assert.equal(
    bulkEditIssuesTool.input.safeParse({ issues: [], priorityId: '2' }).success,
    false,
  );
});

test('[CC-215] the bulk issue list is trimmed in validation, and a blank entry is refused', () => {
  for (const tool of [bulkDeleteIssuesTool, bulkEditIssuesTool]) {
    const extra = tool === bulkEditIssuesTool ? { priorityId: '3' } : {};
    const parsed = tool.input.safeParse({ issues: [' PROJ-1 ', '10001'], ...extra });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.issues, ['PROJ-1', '10001']);
    assert.equal(tool.input.safeParse({ issues: ['   '], ...extra }).success, false);
  }
});

test('[CC-242] bulk edit ids are trimmed in validation, so the plan echoes what apply sends', async () => {
  const parsed = bulkEditIssuesTool.input.safeParse({
    issues: [KEY],
    priorityId: ' 2 ',
    assigneeAccountId: ' acc-1 ',
    fixVersionIds: [' 10600 '],
    fixVersionsAction: 'ADD',
  });
  assert.equal(parsed.success, true);
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });
  const plan = await gate.execute(
    callOf(bulkEditIssuesTool, parsed.data, {}, createFakeJiraRequest().fn),
  );
  assert.deepEqual((beforeOf(plan) as { edits: unknown }).edits, {
    priorityId: '2',
    assigneeAccountId: 'acc-1',
    fixVersions: { action: 'ADD', versionIds: ['10600'] },
  });
  for (const blank of [
    { priorityId: '  ' },
    { assigneeAccountId: '  ' },
    { fixVersionIds: ['  '], fixVersionsAction: 'ADD' },
  ]) {
    assert.equal(
      bulkEditIssuesTool.input.safeParse({ issues: [KEY], ...blank }).success,
      false,
    );
  }
});

test('[CC-243] duplicate bulk targets are dropped before the count and the 1000 cap', async () => {
  const parsed = bulkDeleteIssuesTool.input.safeParse({
    issues: ['PROJ-2', ' PROJ-1', 'PROJ-2', 'PROJ-1 ', 'proj-1'],
  });
  assert.equal(parsed.success, true);
  // First-seen order; case and key-vs-id aliases are NOT folded.
  assert.deepEqual(parsed.data?.issues, ['PROJ-2', 'PROJ-1', 'proj-1']);

  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });
  const plan = await gate.execute(
    callOf(bulkDeleteIssuesTool, parsed.data, {}, createFakeJiraRequest().fn),
  );
  assert.equal(beforeOf(plan)['issueCount'], 3);

  // 1000 distinct keys plus repeats is still within the cap.
  const padded = [...bulkKeys(1000), ...bulkKeys(5)];
  assert.equal(bulkDeleteIssuesTool.input.safeParse({ issues: padded }).success, true);
  assert.equal(
    bulkDeleteIssuesTool.input.safeParse({ issues: bulkKeys(1001) }).success,
    false,
  );
});

test('CC-129: the bulk plan is the request itself — zero reads, a count and a capped echo', async () => {
  // The other six tools fetch what would be lost; a bulk plan does NOT. Its
  // blast radius is the caller's own list, and pre-fetching up to a thousand
  // issues would spend rate limit restating the input. The before-state is
  // the count plus the first-20 echo, built with no network at all.
  const issues = bulkKeys(21);
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const plan = await gate.execute(callOf(bulkDeleteIssuesTool, { issues }, {}, fake.fn));

  assert.equal(plan.ok, true);
  assert.deepEqual(fake.routes(), [], 'the plan made no network call');
  assert.deepEqual((plan.data as { planned: unknown }).planned, {
    method: 'POST',
    path: '/bulk/issues/delete',
    body: { selectedIssueIdsOrKeys: issues },
  });
  assert.deepEqual(beforeOf(plan), {
    kind: 'bulk-delete',
    issueCount: 21,
    issues: issues.slice(0, 20),
    truncated: true,
  });
  assert.equal(plan._untrusted, true);
  assert.equal((plan.hints ?? [])[0]?.code, 'plan');
});

test('a bulk plan of exactly twenty issues echoes them all and claims no truncation', async () => {
  const issues = bulkKeys(20);
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(callOf(bulkDeleteIssuesTool, { issues }, {}, fake.fn)),
  );

  assert.deepEqual(before, { kind: 'bulk-delete', issueCount: 20, issues });
  assert.equal(Object.hasOwn(before, 'truncated'), false);
});

test('CC-130: the edit posts to /bulk/issues/fields and DERIVES selectedActions itself', async () => {
  const fake = createFakeJiraRequest().on(BULK_EDIT_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    bulkEditIssuesTool,
    {
      issues: [KEY, 'PROJ-2'],
      labels: ['triaged'],
      labelsAction: 'ADD',
      priorityId: '2',
    },
    fake,
  );

  const planned = (plan.data as { planned: PlannedRequest }).planned;
  assert.equal(planned.method, 'POST');
  assert.equal(planned.path, '/bulk/issues/fields');
  // The top-level wire envelope is this ring's concern; `editedFieldsInput`'s
  // sub-shape is `api/bulk.test.ts`'s contract and is not re-asserted here.
  const body = fake.lastRequest()?.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    'editedFieldsInput',
    'selectedActions',
    'selectedIssueIdsOrKeys',
  ]);
  assert.deepEqual(body['selectedActions'], ['labels', 'priority']);
  assert.deepEqual(body['selectedIssueIdsOrKeys'], [KEY, 'PROJ-2']);
  assert.deepEqual(beforeOf(plan), {
    kind: 'bulk-edit',
    issueCount: 2,
    issues: [KEY, 'PROJ-2'],
    edits: { labels: { action: 'ADD', values: ['triaged'] }, priorityId: '2' },
  });
  assert.deepEqual(applied.data, { taskId: TASK_ID, before: beforeOf(plan) });
  // `selectedActions` is derived, never caller-supplied: the strict schema
  // refuses the key rather than trusting a caller's account of their intent.
  assert.equal(
    bulkEditIssuesTool.input.safeParse({
      issues: [KEY],
      priorityId: '2',
      selectedActions: ['labels'],
    }).success,
    false,
  );
  assert.equal(fake.lastRequest()?.safe, undefined, 'an unsafe write is never replayed');
});

test('the fixVersions family rides through the tool into the wire and the before-state', async () => {
  const fake = createFakeJiraRequest().on(BULK_EDIT_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const { plan, applied } = await planThenApply(
    gate,
    bulkEditIssuesTool,
    { issues: [KEY], fixVersionIds: ['10600', '10601'], fixVersionsAction: 'REPLACE' },
    fake,
  );

  const body = fake.lastRequest()?.body as Record<string, unknown>;
  assert.deepEqual(body['selectedActions'], ['fixVersions']);
  assert.deepEqual(
    (body['editedFieldsInput'] as Record<string, unknown>)['multipleVersionPickerFields'],
    [
      {
        fieldId: 'fixVersions',
        bulkEditMultiSelectFieldOption: 'REPLACE',
        versions: [{ versionId: '10600' }, { versionId: '10601' }],
      },
    ],
  );
  assert.deepEqual(beforeOf(plan)['edits'], {
    fixVersions: { action: 'REPLACE', versionIds: ['10600', '10601'] },
  });
  assert.deepEqual(applied.data, { taskId: TASK_ID, before: beforeOf(plan) });
});

test('CC-131: notifyUsers maps to sendBulkNotification, and absent means omitted', async () => {
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const muted = createFakeJiraRequest().on(BULK_DELETE_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  await planThenApply(
    gate,
    bulkDeleteIssuesTool,
    { issues: [KEY], notifyUsers: false },
    muted,
  );
  assert.deepEqual(muted.lastRequest()?.body, {
    selectedIssueIdsOrKeys: [KEY],
    sendBulkNotification: false,
  });

  // Absent means ABSENT on the wire — the tenant default decides, not a guess.
  const defaulted = createFakeJiraRequest().on(
    BULK_DELETE_SUBMIT_ROUTE,
    BULK_SUBMIT_RECEIPT,
  );
  await planThenApply(gate, bulkDeleteIssuesTool, { issues: [KEY] }, defaulted);
  assert.deepEqual(defaulted.lastRequest()?.body, { selectedIssueIdsOrKeys: [KEY] });

  const edited = createFakeJiraRequest().on(BULK_EDIT_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  await planThenApply(
    gate,
    bulkEditIssuesTool,
    { issues: [KEY], priorityId: '2' },
    edited,
  );
  assert.equal(
    Object.hasOwn(
      edited.lastRequest()?.body as Record<string, unknown>,
      'sendBulkNotification',
    ),
    false,
  );

  // And the edit carries the flag the same way when it is given.
  const loud = createFakeJiraRequest().on(BULK_EDIT_SUBMIT_ROUTE, BULK_SUBMIT_RECEIPT);
  await planThenApply(
    gate,
    bulkEditIssuesTool,
    { issues: [KEY], priorityId: '2', notifyUsers: true },
    loud,
  );
  assert.equal(
    (loud.lastRequest()?.body as Record<string, unknown>)['sendBulkNotification'],
    true,
  );
});

test('CC-133: a value without its action — or the reverse — is refused client-side', () => {
  // Zod refinement, not Jira: the pairing is validated before anything is
  // sent, so a half-stated intent cannot reach the queue and fail there.
  const parses = (extra: Record<string, unknown>): boolean =>
    bulkEditIssuesTool.input.safeParse({ issues: [KEY], ...extra }).success;

  assert.equal(parses({ labels: ['triaged'] }), false, 'labels without labelsAction');
  assert.equal(parses({ labelsAction: 'ADD' }), false, 'labelsAction without labels');
  assert.equal(
    parses({ labels: ['triaged'], labelsAction: 'REMOVE_ALL' }),
    false,
    'REMOVE_ALL takes no values',
  );
  assert.equal(
    parses({ labels: [], labelsAction: 'ADD' }),
    false,
    'ADD with an empty list edits nothing',
  );
  assert.equal(parses({ fixVersionIds: ['10600'] }), false);
  assert.equal(parses({ fixVersionIds: [], fixVersionsAction: 'REPLACE' }), false);
  // No field at all is not an edit; notifyUsers alone states no intent either.
  assert.equal(parses({}), false);
  assert.equal(parses({ notifyUsers: false }), false);

  assert.equal(parses({ labels: ['triaged'], labelsAction: 'ADD' }), true);
  assert.equal(parses({ labels: [], labelsAction: 'REMOVE_ALL' }), true);
  assert.equal(parses({ fixVersionIds: ['10600'], fixVersionsAction: 'REPLACE' }), true);
  assert.equal(parses({ priorityId: '2' }), true);
  assert.equal(parses({ assigneeAccountId: ACCOUNT_ID }), true);
  assert.equal(parses({ assigneeAccountId: null }), true);
});

test('an explicit null assignee survives into the before-state as the unassign intent', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const before = beforeOf(
    await gate.execute(
      callOf(bulkEditIssuesTool, { issues: [KEY], assigneeAccountId: null }, {}, fake.fn),
    ),
  );

  assert.deepEqual(before['edits'], { assigneeAccountId: null });
});

// ---------------------------------------------------------------------------
// The tier, end to end through the tools
// ---------------------------------------------------------------------------

test('without the opt-in every delete plans and none of them applies', async () => {
  type Case = readonly [
    AnyToolSpec,
    Record<string, unknown>,
    readonly (readonly [string, Record<string, unknown>])[],
  ];
  const cases: readonly Case[] = [
    [deleteIssueTool, { issue: KEY }, [[ISSUE_ROUTE, issueBody([])]]],
    [
      deleteCommentTool,
      { issue: KEY, commentId: COMMENT_ID },
      [[COMMENT_ROUTE, COMMENT_BODY]],
    ],
    [
      deleteWorklogTool,
      { issue: KEY, worklogId: WORKLOG_ID },
      [[WORKLOG_ROUTE, WORKLOG_BODY]],
    ],
    [
      deleteComponentTool,
      { componentId: COMPONENT_ID },
      [
        [COMPONENT_ROUTE, COMPONENT_BODY],
        [COMPONENT_COUNTS_ROUTE, COMPONENT_COUNTS_BODY],
      ],
    ],
    [
      deleteVersionTool,
      { versionId: VERSION_ID },
      [
        [VERSION_ROUTE, VERSION_BODY],
        [VERSION_COUNTS_ROUTE, VERSION_COUNTS_BODY],
      ],
    ],
    [deleteSprintTool, { sprintId: SPRINT_ID }, [[SPRINT_ROUTE, SPRINT_BODY]]],
    // The bulk plans read nothing (CC-129), so their reads lists are empty.
    [bulkDeleteIssuesTool, { issues: [KEY] }, []],
    [bulkEditIssuesTool, { issues: [KEY], priorityId: '2' }, []],
  ];

  for (const [tool, args, reads] of cases) {
    const fake = createFakeJiraRequest();
    // Only the READs are programmed: any DELETE — or removeAndSwap/bulk-submit
    // POST — that escaped would throw on its unprogrammed route.
    for (const [route, body] of reads) fake.on(route, jiraOk(body));
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
    assert.equal(
      fake.routes().length,
      reads.length,
      `${tool.name}: the refusal read nothing and sent nothing`,
    );
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

test('[CC-195] a delete id spelled past the safe integer range is refused, not rounded', () => {
  assert.equal(
    deleteComponentTool.input.safeParse({ componentId: '9007199254740993' }).success,
    false,
  );
});
