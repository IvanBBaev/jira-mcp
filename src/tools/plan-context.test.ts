// Tests for `tools/plan-context.ts` and the issue writes' `planContext` (D132).
//
// The gate's half — binding the version, refusing a stale apply — is tested in
// `mcp/write-mode.test.ts`. What is asserted here is the half this ring owns:
// how a Jira value is compacted into a diff cell, and which rows each issue
// write reports for which arguments.
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads and marked `// synthetic`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_API } from '../api/port.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraOk,
} from '../core/fakes/index.js';
import type { AnyToolSpec, PlanContext, ToolCtx } from '../mcp/types.js';
import { assignIssueTool, transitionIssueTool, updateIssueTool } from './issues-write.js';
import { DIFF_LIST_ITEMS, DIFF_TEXT_CHARS, compactValue } from './plan-context.js';

const KEY = 'PROJ-1';
const ISSUE_ROUTE = new RegExp(`^GET /rest/api/3/issue/${KEY}$`);
const TRANSITIONS_ROUTE = `GET /rest/api/3/issue/${KEY}/transitions`;
const UPDATED = '2026-10-24T09:00:00.000+0000';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

type FakeJira = ReturnType<typeof createFakeJiraRequest>;

function ctxOf(fake: FakeJira): ToolCtx {
  return {
    jira: fake.fn,
    api: CLOUD_API,
    log: createFakeLogger(),
    clock: createFakeClock(0),
    cid: 'c-d132',
    limits: { maxResultChars: 100_000, maxPages: 1 },
    deadlineAt: 30_000,
  };
}

/** `GET /issue/{key}?fields=…` — the touched fields plus `updated`. // synthetic */
function issueBody(fields: Record<string, unknown>): ReturnType<typeof jiraOk> {
  return jiraOk({ id: '10001', key: KEY, fields: { ...fields, updated: UPDATED } });
}

async function contextOf(
  tool: AnyToolSpec,
  input: Record<string, unknown>,
  fake: FakeJira,
): Promise<PlanContext> {
  assert.ok(tool.planContext !== undefined, `${tool.name} declares no planContext`);
  return tool.planContext(tool.input.parse(input), ctxOf(fake));
}

// ---------------------------------------------------------------------------
// compactValue
// ---------------------------------------------------------------------------

test('CC-1472: compactValue keeps scalars and nulls the absent', () => {
  assert.equal(compactValue(undefined), null);
  assert.equal(compactValue(null), null);
  assert.equal(compactValue(3), 3);
  assert.equal(compactValue(false), false);
  assert.equal(compactValue('short'), 'short');
});

test('CC-1473: compactValue cuts long text and long lists', () => {
  const long = 'x'.repeat(DIFF_TEXT_CHARS + 50);
  assert.equal(compactValue(long), `${'x'.repeat(DIFF_TEXT_CHARS)}…`);

  const many = Array.from({ length: DIFF_LIST_ITEMS + 3 }, (_, i) => `l${String(i)}`);
  const cell = compactValue(many) as unknown[];
  assert.equal(cell.length, DIFF_LIST_ITEMS + 1);
  assert.equal(cell.at(-1), '… 3 more');
});

test('CC-1474: compactValue names users, options and rich text the way a human reads them', () => {
  assert.deepEqual(
    compactValue({ accountId: ACCOUNT_ID, displayName: 'User One', active: true }),
    { accountId: ACCOUNT_ID, displayName: 'User One' },
  );
  assert.equal(compactValue({ self: 'https://x', id: '3', name: 'High' }), 'High');
  assert.equal(compactValue({ id: '10020', value: 'Red' }), 'Red');
  assert.equal(compactValue({ id: '10002', key: 'PROJ-9', fields: {} }), 'PROJ-9');
  assert.equal(
    compactValue({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    }),
    'Hello world',
  );
  assert.deepEqual(compactValue([{ name: 'A' }, { odd: true }]), ['A', '{…}']);
  assert.equal(compactValue({ odd: true }), '{"odd":true}');
});

// ---------------------------------------------------------------------------
// The issue writes
// ---------------------------------------------------------------------------

test('CC-1475: update reports one row per touched field and binds the stamp', async () => {
  const fake = createFakeJiraRequest();
  fake.on(
    ISSUE_ROUTE,
    issueBody({
      summary: 'Old title',
      priority: { id: '2', name: 'Highest' },
      customfield_10050: { id: '10020', value: 'Red' },
    }),
  );

  const context = await contextOf(
    updateIssueTool,
    {
      issue: KEY,
      summary: 'New title',
      priority: 'High',
      fields: { customfield_10050: { value: 'Blue' } },
    },
    fake,
  );

  assert.deepEqual(context, {
    diff: [
      { field: 'summary', from: 'Old title', to: 'New title' },
      { field: 'priority', from: 'Highest', to: 'High' },
      { field: 'customfield_10050', from: 'Red', to: 'Blue' },
    ],
    version: UPDATED,
  });
  assert.equal(fake.calls.length, 1, 'one read, and nothing else');
});

test('CC-1476: an incremental label edit shows the list the apply would leave', async () => {
  const fake = createFakeJiraRequest();
  fake.on(ISSUE_ROUTE, issueBody({ labels: ['a', 'b'] }));

  const context = await contextOf(
    updateIssueTool,
    { issue: KEY, labelsAdd: ['c'], labelsRemove: ['a'] },
    fake,
  );

  assert.deepEqual(context.diff, [{ field: 'labels', from: ['a', 'b'], to: ['b', 'c'] }]);
});

test('CC-1477: transition names the target status, not the transition id', async () => {
  const fake = createFakeJiraRequest();
  fake.on(ISSUE_ROUTE, issueBody({ status: { id: '10000', name: 'To Do' } }));
  fake.on(
    TRANSITIONS_ROUTE,
    // synthetic
    jiraOk({
      transitions: [
        { id: '11', name: 'Start', to: { id: '3', name: 'In Progress' } },
        { id: '31', name: 'Finish', to: { id: '10001', name: 'Done' } },
      ],
    }),
  );

  const context = await contextOf(
    transitionIssueTool,
    { issue: KEY, transition: '31' },
    fake,
  );

  assert.deepEqual(context, {
    diff: [{ field: 'status', from: 'To Do', to: 'Done' }],
    version: UPDATED,
  });
});

test('CC-1478: an unresolvable transition is described as the caller wrote it', async () => {
  const fake = createFakeJiraRequest();
  fake.on(ISSUE_ROUTE, issueBody({ status: { id: '10000', name: 'To Do' } }));
  fake.on(TRANSITIONS_ROUTE, jiraOk({ transitions: [] })); // synthetic

  const context = await contextOf(
    transitionIssueTool,
    { issue: KEY, transition: 'Ship it' },
    fake,
  );

  assert.deepEqual(context.diff, [{ field: 'status', from: 'To Do', to: 'Ship it' }]);
});

test('CC-1479: assign and unassign diff the live assignee', async () => {
  const fake = createFakeJiraRequest();
  fake.on(
    ISSUE_ROUTE,
    issueBody({ assignee: { accountId: ACCOUNT_ID, displayName: 'User One' } }),
  );

  const unassign = await contextOf(assignIssueTool, { issue: KEY, unassign: true }, fake);
  assert.deepEqual(unassign.diff, [
    {
      field: 'assignee',
      from: { accountId: ACCOUNT_ID, displayName: 'User One' },
      to: null,
    },
  ]);

  const reassign = await contextOf(
    assignIssueTool,
    { issue: KEY, accountId: 'other' },
    fake,
  );
  assert.equal(reassign.diff[0]?.to, 'other');
});
