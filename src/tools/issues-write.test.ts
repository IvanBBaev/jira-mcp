// Tests for `tools/issues-write.ts` (WP-32) — contract tier (TESTING.md).
//
// `api/issues.ts` is already tested against Jira's wire shapes, so nothing here
// re-asserts how a request body is built. What is asserted is the half this ring
// owns: the annotation quadruple and the write tier (a wrong `destructiveHint`
// is invisible until a client silently stops confirming), the strict schemas and
// the intent refinements that reject a call BEFORE it reaches the gate (CC-22),
// the offset that turns a bare `started` into a real instant (CC-23), and the
// hints that turn an opaque 400 into a next call (CC-21, CC-24).
//
// The gate itself is NOT re-tested here: every handler below runs against an
// EXECUTING fake, which is exactly what apply mode hands it. What IS tested is
// the one way this ring could break plan mode — swallowing the non-`JiraError`
// unwind signal the capturing seam throws.
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads and marked `// synthetic`. The fake throws on a route nobody
// programmed, so "the handler issued exactly the requests we expected" holds by
// construction.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adfFromMarkdown } from '../api/adf.js';
import { errorFromResponse } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import type { AnyToolSpec, Hint, ToolCtx, ToolResult } from '../mcp/types.js';
import {
  addCommentTool,
  addWorklogTool,
  assignIssueTool,
  createIssueTool,
  issuesWritePackage,
  linkIssuesTool,
  transitionIssueTool,
  updateCommentTool,
  updateIssueTool,
} from './issues-write.js';

const KEY = 'PROJ-1';
const OTHER_KEY = 'PROJ-2';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

const CREATE_ROUTE = 'POST /rest/api/3/issue';
const UPDATE_ROUTE = `PUT /rest/api/3/issue/${KEY}`;
const GET_TRANSITIONS_ROUTE = `GET /rest/api/3/issue/${KEY}/transitions`;
const POST_TRANSITION_ROUTE = `POST /rest/api/3/issue/${KEY}/transitions`;
const COMMENT_ROUTE = `POST /rest/api/3/issue/${KEY}/comment`;
const COMMENT_ID = '10100';
const EDIT_COMMENT_ROUTE = `PUT /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`;
const ASSIGNEE_ROUTE = `PUT /rest/api/3/issue/${KEY}/assignee`;
const WORKLOG_ROUTE = `POST /rest/api/3/issue/${KEY}/worklog`;
const LINK_ROUTE = 'POST /rest/api/3/issueLink';
const MYSELF_ROUTE = 'GET /rest/api/3/myself';

/** 2026-08-07T10:00:00.000Z — the instant every call in this file runs at. */
const NOW = Date.UTC(2026, 7, 7, 10, 0, 0);

/**
 * The same instant in the authenticated user's zone. `Asia/Kolkata` is the
 * deliberate choice: its offset is half-hourly and never zero, so a rendering
 * that quietly fell back to the (UTC) test host cannot pass by coincidence.
 */
const STARTED_IST = '2026-08-07T15:30:00.000+0530';

/** A user object as Jira embeds it. // synthetic */
const WIRE_USER = {
  self: `https://example.atlassian.net/rest/api/3/user?accountId=${ACCOUNT_ID}`,
  accountId: ACCOUNT_ID,
  accountType: 'atlassian',
  displayName: 'User One',
  active: true,
};

/** `GET /myself` — D16's offset source. // synthetic */
const MYSELF_BODY = {
  ...WIRE_USER,
  emailAddress: 'user-1@example.invalid',
  timeZone: 'Asia/Kolkata',
  locale: 'en_US',
};

/** ADF as Jira stores a one-paragraph rich-text field. // synthetic */
function adfDoc(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** `POST /issue` — 201. // synthetic */
const CREATED_BODY = {
  id: '10001',
  key: KEY,
  self: 'https://example.atlassian.net/rest/api/3/issue/10001',
};

/** `GET /issue/{key}/transitions`. // synthetic */
const TRANSITIONS_BODY = {
  expand: 'transitions',
  transitions: [
    { id: '11', name: 'To Do', to: { id: '10000', name: 'To Do' } },
    { id: '31', name: 'Done', to: { id: '10001', name: 'Done' } },
  ],
};

/** `POST /issue/{key}/comment` — 201. // synthetic */
const COMMENT_BODY = {
  id: COMMENT_ID,
  author: WIRE_USER,
  body: adfDoc('Paired on the retry policy.'),
  created: '2026-08-07T10:00:00.000+0000',
  updated: '2026-08-07T10:00:00.000+0000',
};

/** `PUT /issue/{key}/comment/{id}` — 200, the stored comment after the edit. */
const EDITED_COMMENT_BODY = {
  ...COMMENT_BODY,
  updateAuthor: WIRE_USER,
  body: adfDoc('Paired on the retry policy, and on the backoff ceiling.'),
  updated: '2026-08-07T11:30:00.000+0000',
};

/** `POST /issue/{key}/worklog` — 201. // synthetic */
const WORKLOG_BODY = {
  id: '40001',
  author: WIRE_USER,
  started: STARTED_IST,
  timeSpent: '1h',
  timeSpentSeconds: 3600,
};

/** A 204 with no body, the answer to update, transition and assign. */
const NO_CONTENT = jiraOk({}, { status: 204 });

type FakeJira = ReturnType<typeof createFakeJiraRequest>;

/** The `ToolCtx` the registry would build, with every seam faked. */
function ctxOf(fake: FakeJira): ToolCtx {
  return {
    jira: fake.fn,
    log: createFakeLogger(),
    clock: createFakeClock(NOW),
    cid: 'c-7b2e04',
    limits: { maxResultChars: 100_000, maxPages: 1 },
    deadlineAt: NOW + 30_000,
  };
}

/** Every hint code an envelope carries, in order. */
function hintCodes(result: ToolResult<unknown>): string[] {
  return (result.hints ?? []).map((hint: Hint) => hint.code);
}

/** The body of the last request the fake received, as a plain record. */
function lastBody(fake: FakeJira): Record<string, unknown> {
  const body = fake.lastRequest()?.body;
  assert.ok(body !== undefined && typeof body === 'object', 'no request body recorded');
  return body as Record<string, unknown>;
}

/** A nested object inside a request body — `fields`, `update`, `transition`. */
function nested(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  assert.ok(
    value !== null && typeof value === 'object',
    `request body has no object "${key}"`,
  );
  return value as Record<string, unknown>;
}

/** A Jira 400 with the field-level `errors` map Jira answers CC-24 with. */
function fieldError(field: string, message: string): Error {
  return errorFromResponse({
    status: 400,
    body: { errorMessages: [], errors: { [field]: message } },
    method: 'POST',
    pathTemplate: '/issue',
  });
}

const ALL_TOOLS: readonly AnyToolSpec[] = issuesWritePackage.tools;

/**
 * The smallest argument set each tool accepts. Used for the schema sweeps, where
 * the assertion must be about the ONE key under test and not about a missing
 * required field.
 */
const MINIMAL_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  jira_create_issue: { project: 'PROJ', issueType: 'Task', summary: 'Retry policy' },
  jira_update_issue: { issue: KEY, summary: 'Retry policy' },
  jira_transition_issue: { issue: KEY, transition: 'Done' },
  jira_add_comment: { issue: KEY, body: 'Paired on the retry policy.' },
  jira_update_comment: { issue: KEY, commentId: COMMENT_ID, body: 'Corrected.' },
  jira_assign_issue: { issue: KEY, accountId: ACCOUNT_ID },
  jira_add_worklog: { issue: KEY, timeSpentSeconds: 3600 },
  jira_link_issues: { linkType: 'Blocks', inwardIssue: KEY, outwardIssue: OTHER_KEY },
};

function minimalArgs(tool: AnyToolSpec): Record<string, unknown> {
  const args = MINIMAL_ARGS[tool.name];
  assert.ok(args !== undefined, `no minimal args registered for ${tool.name}`);
  return { ...args };
}

/** True when the schema reported `key` as an UNKNOWN key (not merely invalid). */
function rejectsAsUnknown(tool: AnyToolSpec, input: Record<string, unknown>): boolean {
  const parsed = tool.input.safeParse(input);
  if (parsed.success) return false;
  return parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
}

// ---------------------------------------------------------------------------
// The package, its annotations and its schemas
// ---------------------------------------------------------------------------

test('the issues-write package exports exactly the eight documented write tools', () => {
  assert.equal(issuesWritePackage.id, 'issues-write');
  assert.deepEqual(
    ALL_TOOLS.map((tool) => tool.name),
    [
      'jira_create_issue',
      'jira_update_issue',
      'jira_transition_issue',
      'jira_add_comment',
      'jira_update_comment',
      'jira_assign_issue',
      'jira_add_worklog',
      'jira_link_issues',
    ],
  );
  for (const tool of ALL_TOOLS) assert.equal(tool.package, 'issues-write');
});

test('every issues-write tool is plan-gated at the standard write tier', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.writeTier, 'standard', `${tool.name} write tier`);
    assert.equal(tool.annotations.readOnlyHint, false, `${tool.name} is not read-only`);
  }
});

test('every issues-write tool carries the documented annotation quadruple', () => {
  // TOOLS.md §Annotations reference. The two destructive tools are the two that
  // replace rich text wholesale (CC-31): jira_update_issue on a field, and
  // jira_update_comment on a comment body. Those two plus assign are the ones
  // whose repeat lands on the same state, so they alone are idempotent.
  const expected: Readonly<Record<string, readonly [boolean, boolean]>> = {
    jira_create_issue: [false, false],
    jira_update_issue: [true, true],
    jira_transition_issue: [false, false],
    jira_add_comment: [false, false],
    jira_update_comment: [true, true],
    jira_assign_issue: [false, true],
    jira_add_worklog: [false, false],
    jira_link_issues: [false, false],
  };

  for (const tool of ALL_TOOLS) {
    const pair = expected[tool.name];
    assert.ok(pair !== undefined, `${tool.name} is not in the annotations table`);
    assert.deepEqual(
      tool.annotations,
      {
        readOnlyHint: false,
        destructiveHint: pair[0],
        idempotentHint: pair[1],
        openWorldHint: true,
      },
      `${tool.name} annotations`,
    );
  }
});

test('every tool description stays inside the 500-character budget', () => {
  for (const tool of ALL_TOOLS) {
    assert.ok(
      tool.description.length <= 500,
      `${tool.name} description is ${tool.description.length} chars`,
    );
  }
});

test('every input schema is strict — an unknown key is rejected, not ignored', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(
      rejectsAsUnknown(tool, { ...minimalArgs(tool), bogus: 1 }),
      true,
      `${tool.name} accepted an unknown key`,
    );
    assert.equal(
      tool.input.safeParse(minimalArgs(tool)).success,
      true,
      `${tool.name} rejected its own minimal arguments`,
    );
  }
});

test('every write tool declares the auto-injected control fields', () => {
  for (const tool of ALL_TOOLS) {
    const args = minimalArgs(tool);
    assert.equal(
      tool.input.safeParse({ ...args, apply: true, plan_id: 'p-1', profile: 'agile' })
        .success,
      true,
      `${tool.name} rejected the control fields`,
    );
  }
});

// ---------------------------------------------------------------------------
// jira_create_issue
// ---------------------------------------------------------------------------

test('jira_create_issue posts the create body and returns the new key', async () => {
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraOk(CREATED_BODY));

  const result = await createIssueTool.handler(
    {
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Retry policy needs a decision',
      description: 'Plain text becomes ADF.',
      assigneeAccountId: ACCOUNT_ID,
      labels: ['retry'],
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.key, KEY);
  assert.deepEqual(fake.routes(), [CREATE_ROUTE]);

  const fields = nested(lastBody(fake), 'fields');
  assert.deepEqual(fields['project'], { key: 'PROJ' });
  assert.deepEqual(fields['issuetype'], { name: 'Task' });
  assert.deepEqual(fields['assignee'], { accountId: ACCOUNT_ID });
  assert.deepEqual(fields['labels'], ['retry']);
});

test('a write result is never branded untrusted — it echoes the caller, not Jira', async () => {
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraOk(CREATED_BODY));

  const result = await createIssueTool.handler(
    { project: 'PROJ', issueType: 'Task', summary: 'Retry policy' },
    ctxOf(fake),
  );

  assert.equal(result._untrusted, undefined);
  assert.deepEqual(hintCodes(result), []);
});

test('CC-24: an unknown field id keeps Jira field-level message and earns a discovery hint', async () => {
  const fake = createFakeJiraRequest().on(
    CREATE_ROUTE,
    jiraErr(
      fieldError(
        'customfield_10999',
        "Field 'customfield_10999' cannot be set. It is not on the appropriate screen, or unknown.",
      ),
    ),
  );

  const result = await createIssueTool.handler(
    {
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Retry policy',
      fields: { customfield_10999: 'nope' },
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.deepEqual(result.error?.jiraMessages, [
    "customfield_10999: Field 'customfield_10999' cannot be set. It is not on the " +
      'appropriate screen, or unknown.',
  ]);
  assert.deepEqual(hintCodes(result), ['discovery']);
  assert.match(result.hints?.[0]?.message ?? '', /jira_list_fields/);
  assert.match(result.hints?.[0]?.message ?? '', /jira_get_create_meta/);
});

test('jira_create_issue hints sprint_move_required when a sprint field was requested', async () => {
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraOk(CREATED_BODY));

  const result = await createIssueTool.handler(
    {
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Retry policy',
      fields: { Sprint: 42 },
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(hintCodes(result), ['sprint_move_required']);
  assert.match(result.hints?.[0]?.message ?? '', /jira_move_to_sprint/);
});

test('jira_create_issue stays quiet when no sprint was requested', async () => {
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraOk(CREATED_BODY));

  const result = await createIssueTool.handler(
    {
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Retry policy',
      fields: { customfield_10011: 'Epic name' },
    },
    ctxOf(fake),
  );

  assert.deepEqual(hintCodes(result), []);
});

// ---------------------------------------------------------------------------
// jira_update_issue (CC-31)
// ---------------------------------------------------------------------------

test('CC-31: labelsAdd/labelsRemove build an incremental update, never a replace', async () => {
  const fake = createFakeJiraRequest().on(UPDATE_ROUTE, NO_CONTENT);

  const result = await updateIssueTool.handler(
    { issue: KEY, labelsAdd: ['retry'], labelsRemove: ['stale'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.updated, true);

  const body = lastBody(fake);
  assert.deepEqual(nested(body, 'update')['labels'], [
    { add: 'retry' },
    { remove: 'stale' },
  ]);
  // The whole-list replace must be absent: sending both is what Jira rejects.
  assert.equal(body['fields'], undefined);
});

test('CC-31: description replaces the whole rich-text field, and the description says so', async () => {
  const fake = createFakeJiraRequest().on(UPDATE_ROUTE, NO_CONTENT);

  await updateIssueTool.handler(
    { issue: KEY, description: 'The new body.', parent: null, notifyUsers: false },
    ctxOf(fake),
  );

  const fields = nested(lastBody(fake), 'fields');
  assert.deepEqual(fields['description'], adfDoc('The new body.'));
  // `null` un-parents; an omitted key would have left the parent in place.
  assert.equal(fields['parent'], null);
  assert.equal(fake.lastRequest()?.query?.['notifyUsers'], false);

  assert.match(updateIssueTool.description, /replaces the WHOLE rich-text field/);
  assert.match(updateIssueTool.description, /labelsAdd/);
});

test('jira_update_issue clears the assignee with an explicit null', async () => {
  const fake = createFakeJiraRequest().on(UPDATE_ROUTE, NO_CONTENT);

  await updateIssueTool.handler({ issue: KEY, assigneeAccountId: null }, ctxOf(fake));

  assert.equal(nested(lastBody(fake), 'fields')['assignee'], null);
});

// ---------------------------------------------------------------------------
// jira_transition_issue (CC-21)
// ---------------------------------------------------------------------------

test('CC-21: a transition NAME is resolved against the live list before the POST', async () => {
  const fake = createFakeJiraRequest()
    .on(GET_TRANSITIONS_ROUTE, jiraOk(TRANSITIONS_BODY))
    .on(POST_TRANSITION_ROUTE, NO_CONTENT);

  const result = await transitionIssueTool.handler(
    { issue: KEY, transition: 'done', comment: 'Shipped.' },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.transitionId, '31');
  assert.deepEqual(fake.routes(), [GET_TRANSITIONS_ROUTE, POST_TRANSITION_ROUTE]);

  const body = lastBody(fake);
  assert.deepEqual(nested(body, 'transition'), { id: '31' });
  assert.deepEqual(nested(body, 'update')['comment'], [
    { add: { body: adfDoc('Shipped.') } },
  ]);
});

test('CC-21: an unresolvable name lists the valid transitions and sends nothing', async () => {
  const fake = createFakeJiraRequest().on(
    GET_TRANSITIONS_ROUTE,
    jiraOk(TRANSITIONS_BODY),
  );

  const result = await transitionIssueTool.handler(
    { issue: KEY, transition: 'Close' },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(result.error?.message ?? '', /11 \(To Do\), 31 \(Done\)/);
  // The GET happened; the POST never did.
  assert.deepEqual(fake.routes(), [GET_TRANSITIONS_ROUTE]);
  assert.deepEqual(hintCodes(result), ['discovery']);
  assert.match(result.hints?.[0]?.message ?? '', /jira_get_transitions/);
});

test('CC-21: a stale transition id comes back with the re-fetch remediation', async () => {
  const fake = createFakeJiraRequest()
    .on(GET_TRANSITIONS_ROUTE, jiraOk(TRANSITIONS_BODY))
    .on(
      POST_TRANSITION_ROUTE,
      jiraErr(
        errorFromResponse({
          status: 400,
          body: { errorMessages: ['Transition id 31 is not valid for this issue.'] },
          method: 'POST',
          pathTemplate: '/issue/{issueIdOrKey}/transitions',
        }),
      ),
    );

  const result = await transitionIssueTool.handler(
    { issue: KEY, transition: '31' },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(result.error?.remediation ?? '', /Re-fetch the transitions/);
  // Jira's own wording survives the remediation swap.
  assert.deepEqual(result.error?.jiraMessages, [
    'Transition id 31 is not valid for this issue.',
  ]);
  assert.deepEqual(hintCodes(result), ['discovery']);
});

// ---------------------------------------------------------------------------
// jira_add_comment
// ---------------------------------------------------------------------------

test('jira_add_comment converts text to ADF and forwards visibility', async () => {
  const fake = createFakeJiraRequest().on(COMMENT_ROUTE, jiraOk(COMMENT_BODY));

  const result = await addCommentTool.handler(
    {
      issue: KEY,
      body: 'Paired on the retry policy.',
      visibility: { type: 'role', value: 'Developers' },
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.id, '10100');

  const body = lastBody(fake);
  assert.deepEqual(body['body'], adfDoc('Paired on the retry policy.'));
  assert.deepEqual(body['visibility'], { type: 'role', value: 'Developers' });
});

test('jira_add_comment accepts a raw ADF document unchanged', async () => {
  const fake = createFakeJiraRequest().on(COMMENT_ROUTE, jiraOk(COMMENT_BODY));

  await addCommentTool.handler({ issue: KEY, body: adfDoc('Raw ADF.') }, ctxOf(fake));

  assert.deepEqual(lastBody(fake)['body'], adfDoc('Raw ADF.'));
});

// ---------------------------------------------------------------------------
// jira_update_comment (CC-31 on a comment)
// ---------------------------------------------------------------------------

test('CC-39: jira_update_comment PUTs the whole replacement body at the comment id', async () => {
  const fake = createFakeJiraRequest().on(
    EDIT_COMMENT_ROUTE,
    jiraOk(EDITED_COMMENT_BODY),
  );

  const result = await updateCommentTool.handler(
    {
      issue: KEY,
      commentId: COMMENT_ID,
      body: 'Paired on the retry policy, and on the backoff ceiling.',
      visibility: { type: 'role', value: 'Developers' },
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.id, COMMENT_ID);
  assert.equal(result.data?.updated, '2026-08-07T11:30:00.000+0000');
  // The id travels as a PATH segment, so the edit can only reach one comment.
  assert.deepEqual(fake.routes(), [EDIT_COMMENT_ROUTE]);

  const body = lastBody(fake);
  assert.deepEqual(
    body['body'],
    adfDoc('Paired on the retry policy, and on the backoff ceiling.'),
  );
  assert.deepEqual(body['visibility'], { type: 'role', value: 'Developers' });
  // Nothing else is sent: an edit that carried a partial document would let
  // Jira drop whatever the caller failed to resend.
  assert.deepEqual(Object.keys(body).sort(), ['body', 'visibility']);
});

test('jira_update_comment accepts a raw ADF document unchanged', async () => {
  const fake = createFakeJiraRequest().on(
    EDIT_COMMENT_ROUTE,
    jiraOk(EDITED_COMMENT_BODY),
  );

  await updateCommentTool.handler(
    { issue: KEY, commentId: 10_100, body: adfDoc('Raw ADF.') },
    ctxOf(fake),
  );

  assert.deepEqual(lastBody(fake)['body'], adfDoc('Raw ADF.'));
  // A numeric id renders as the same path segment a string id does.
  assert.deepEqual(fake.routes(), [EDIT_COMMENT_ROUTE]);
});

test('D32: the issue argument of jira_update_comment is named `issue`', () => {
  // The recent-writes registry records the touched issue by reading this key off
  // the arguments. Renaming it (issueIdOrKey, issueKey) would keep the tool
  // working and make the edit invisible to jira_recent_writes.
  assert.equal(
    updateCommentTool.input.safeParse({
      issue: KEY,
      commentId: COMMENT_ID,
      body: 'Corrected.',
    }).success,
    true,
  );
  assert.equal(
    updateCommentTool.input.safeParse({
      issueIdOrKey: KEY,
      commentId: COMMENT_ID,
      body: 'Corrected.',
    }).success,
    false,
  );
});

test('jira_update_comment refuses a comment id that is not one, before the wire', async () => {
  // D22: the model reaching for the issue key or the comment TEXT is the likely
  // mistake, and it must not turn into a PUT at some other path.
  const fake = createFakeJiraRequest();

  const result = await updateCommentTool.handler(
    { issue: KEY, commentId: KEY, body: 'Corrected.' },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(result.error?.remediation ?? '', /jira_get_comments/);
  assert.equal(fake.calls.length, 0);
});

test('the plan seam sees the real edit — the capture unwind is not swallowed', async () => {
  const captured = new Error(
    `PlanCaptured: PUT /rest/api/3/issue/${KEY}/comment/${COMMENT_ID}`,
  );
  const fake = createFakeJiraRequest().on(EDIT_COMMENT_ROUTE, jiraErr(captured));

  await assert.rejects(
    updateCommentTool.handler(
      { issue: KEY, commentId: COMMENT_ID, body: 'Corrected.' },
      ctxOf(fake),
    ),
    (error: unknown) => error === captured,
  );
});

// ---------------------------------------------------------------------------
// jira_assign_issue (CC-22)
// ---------------------------------------------------------------------------

test('CC-22: accountId together with unassign: true is rejected by the schema', () => {
  const parsed = assignIssueTool.input.safeParse({
    issue: KEY,
    accountId: ACCOUNT_ID,
    unassign: true,
  });

  assert.equal(parsed.success, false);
  const message = parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');
  assert.match(message, /mutually exclusive/);
});

test('CC-22: an assignment with neither accountId nor unassign is rejected', () => {
  const parsed = assignIssueTool.input.safeParse({ issue: KEY });

  assert.equal(parsed.success, false);
  const message = parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');
  assert.match(message, /accountId|unassign/);
});

test('CC-22: unassign: true alone is accepted and sends an explicit null', async () => {
  const fake = createFakeJiraRequest().on(ASSIGNEE_ROUTE, NO_CONTENT);
  assert.equal(
    assignIssueTool.input.safeParse({ issue: KEY, unassign: true }).success,
    true,
  );

  const result = await assignIssueTool.handler(
    { issue: KEY, unassign: true },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.accountId, null);
  assert.deepEqual(lastBody(fake), { accountId: null });
});

test('jira_assign_issue assigns by accountId', async () => {
  const fake = createFakeJiraRequest().on(ASSIGNEE_ROUTE, NO_CONTENT);

  const result = await assignIssueTool.handler(
    { issue: KEY, accountId: ACCOUNT_ID },
    ctxOf(fake),
  );

  assert.equal(result.data?.accountId, ACCOUNT_ID);
  assert.deepEqual(lastBody(fake), { accountId: ACCOUNT_ID });
});

// ---------------------------------------------------------------------------
// jira_add_worklog (CC-23 / D16)
// ---------------------------------------------------------------------------

/** Both routes a worklog needs: the offset source and the write itself. */
function worklogFake(): FakeJira {
  return createFakeJiraRequest()
    .on(MYSELF_ROUTE, jiraOk(MYSELF_BODY))
    .on(WORKLOG_ROUTE, jiraOk(WORKLOG_BODY));
}

test("CC-23: a bare started is read in the user's Jira timezone, not the host's", async () => {
  const fake = worklogFake();

  const result = await addWorklogTool.handler(
    { issue: KEY, timeSpentSeconds: 3600, started: '2026-08-07T15:30:00' },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.routes(), [MYSELF_ROUTE, WORKLOG_ROUTE]);
  // The host runs UTC; +0530 can only have come from the injected /myself zone.
  assert.equal(lastBody(fake)['started'], STARTED_IST);
  assert.equal(lastBody(fake)['timeSpentSeconds'], 3600);
});

test("CC-23: an omitted started uses the injected clock, rendered in the user's zone", async () => {
  const fake = worklogFake();

  await addWorklogTool.handler({ issue: KEY, timeSpent: '1h' }, ctxOf(fake));

  assert.equal(lastBody(fake)['started'], STARTED_IST);
  assert.equal(lastBody(fake)['timeSpent'], '1h');
});

test('CC-23: an absolute started is re-rendered with an offset — Z is never sent', async () => {
  const fake = worklogFake();

  await addWorklogTool.handler(
    { issue: KEY, timeSpentSeconds: 3600, started: '2026-08-07T10:00:00.000Z' },
    ctxOf(fake),
  );
  assert.equal(lastBody(fake)['started'], STARTED_IST);

  // The colonless offset Jira itself emits parses to the same instant.
  await addWorklogTool.handler(
    { issue: KEY, timeSpentSeconds: 3600, started: '2026-08-07T12:00:00+0200' },
    ctxOf(fake),
  );
  const started = lastBody(fake)['started'];
  assert.equal(started, STARTED_IST);
  assert.equal(String(started).endsWith('Z'), false);
});

test('CC-23: a started that is not a real instant fails before anything is written', async () => {
  const fake = worklogFake();

  const result = await addWorklogTool.handler(
    { issue: KEY, timeSpentSeconds: 3600, started: '2026-02-30T10:00:00' },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.deepEqual(fake.routes(), [MYSELF_ROUTE]);
});

test('jira_add_worklog demands exactly one duration', () => {
  const both = addWorklogTool.input.safeParse({
    issue: KEY,
    timeSpentSeconds: 3600,
    timeSpent: '1h',
  });
  const neither = addWorklogTool.input.safeParse({ issue: KEY });

  assert.equal(both.success, false);
  assert.equal(neither.success, false);
});

test('jira_add_worklog rejects a started that is not a timestamp at all', () => {
  const parsed = addWorklogTool.input.safeParse({
    issue: KEY,
    timeSpentSeconds: 3600,
    started: 'yesterday',
  });

  assert.equal(parsed.success, false);
});

// ---------------------------------------------------------------------------
// jira_link_issues
// ---------------------------------------------------------------------------

test('jira_link_issues sends the link type by name, in the given direction', async () => {
  const fake = createFakeJiraRequest().on(LINK_ROUTE, jiraOk({}, { status: 201 }));

  const result = await linkIssuesTool.handler(
    {
      linkType: 'Blocks',
      inwardIssue: KEY,
      outwardIssue: OTHER_KEY,
      comment: 'Blocked by the retry work.',
    },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.linked, true);

  const body = lastBody(fake);
  assert.deepEqual(body['type'], { name: 'Blocks' });
  assert.deepEqual(body['inwardIssue'], { key: KEY });
  assert.deepEqual(body['outwardIssue'], { key: OTHER_KEY });
  assert.deepEqual(nested(body, 'comment')['body'], adfDoc('Blocked by the retry work.'));
});

test('an unknown link type name earns the link-type discovery hint', async () => {
  const fake = createFakeJiraRequest().on(
    LINK_ROUTE,
    jiraErr(
      errorFromResponse({
        status: 400,
        body: { errorMessages: ['No issue link type with name "Blocked By" found.'] },
        method: 'POST',
        pathTemplate: '/issueLink',
      }),
    ),
  );

  const result = await linkIssuesTool.handler(
    { linkType: 'Blocked By', inwardIssue: KEY, outwardIssue: OTHER_KEY },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(hintCodes(result), ['discovery']);
  assert.match(result.hints?.[0]?.message ?? '', /jira_list_link_types/);
});

// ---------------------------------------------------------------------------
// format (CC-46 / D44)
// ---------------------------------------------------------------------------

/** Markdown that parses to something adfFromText could never produce. */
const MD_TEXT = '# Plan\n\nUse **bounded** retries.';

/**
 * The rich-text input of every tool that has one. jira_assign_issue is the one
 * write tool without a rich-text surface, so it takes no `format` at all.
 */
const RICH_TEXT_FIELDS: Readonly<Record<string, string>> = {
  jira_create_issue: 'description',
  jira_update_issue: 'description',
  jira_transition_issue: 'comment',
  jira_add_comment: 'body',
  jira_update_comment: 'body',
  jira_add_worklog: 'comment',
  jira_link_issues: 'comment',
};

test('CC-46: format: "markdown" is parsed BEFORE the seam — plan mode cannot see anything else', async () => {
  // The conversion sits above ctx.jira, so the body the executing fake records
  // here is byte-for-byte the body a capturing plan seam would record (CC-20).
  const fake = createFakeJiraRequest().on(COMMENT_ROUTE, jiraOk(COMMENT_BODY));

  const result = await addCommentTool.handler(
    { issue: KEY, body: MD_TEXT, format: 'markdown' },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  const body = lastBody(fake)['body'] as Record<string, unknown>;
  assert.deepEqual(body, adfFromMarkdown(MD_TEXT));
  // And the conversion really was the markdown one: a heading node exists,
  // which the text grammar cannot emit.
  const first = (body['content'] as Record<string, unknown>[])[0];
  assert.equal(first?.['type'], 'heading');
});

test('CC-46: omitting format keeps v1 text semantics — markup stays literal', async () => {
  const fake = createFakeJiraRequest().on(COMMENT_ROUTE, jiraOk(COMMENT_BODY));

  await addCommentTool.handler({ issue: KEY, body: '# Not a heading' }, ctxOf(fake));

  assert.deepEqual(lastBody(fake)['body'], adfDoc('# Not a heading'));
});

test('CC-46: format alongside a raw ADF document is refused by every schema', () => {
  for (const [name, field] of Object.entries(RICH_TEXT_FIELDS)) {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} is not exported`);

    const parsed = tool.input.safeParse({
      ...minimalArgs(tool),
      [field]: adfDoc('Raw ADF.'),
      format: 'markdown',
    });
    assert.equal(parsed.success, false, `${name} accepted format + raw ADF`);
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    assert.deepEqual(issue?.path, ['format'], `${name} refusal path`);

    // The string form with the same format is legal — only the contradiction
    // is refused.
    assert.equal(
      tool.input.safeParse({
        ...minimalArgs(tool),
        [field]: 'A string body.',
        format: 'markdown',
      }).success,
      true,
      `${name} rejected format with a string ${field}`,
    );
  }
});

test('CC-46: format with an absent rich-text input is a no-op, not an error', () => {
  for (const name of Object.keys(RICH_TEXT_FIELDS)) {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} is not exported`);
    assert.equal(
      tool.input.safeParse({ ...minimalArgs(tool), format: 'markdown' }).success,
      true,
      `${name} rejected format without a rich-text input`,
    );
  }
});

test('CC-46: update_issue converts markdown, and null + format still clears (CC-31)', async () => {
  const fake = createFakeJiraRequest().on(UPDATE_ROUTE, NO_CONTENT);

  await updateIssueTool.handler(
    { issue: KEY, description: MD_TEXT, format: 'markdown' },
    ctxOf(fake),
  );
  assert.deepEqual(
    nested(lastBody(fake), 'fields')['description'],
    adfFromMarkdown(MD_TEXT),
  );

  // `null` needs no grammar, so format does not turn a clear into an error.
  await updateIssueTool.handler(
    { issue: KEY, description: null, format: 'markdown' },
    ctxOf(fake),
  );
  assert.equal(nested(lastBody(fake), 'fields')['description'], null);
});

test('CC-46: create_issue sends the converted document under fields.description', async () => {
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraOk(CREATED_BODY));

  await createIssueTool.handler(
    {
      project: 'PROJ',
      issueType: 'Task',
      summary: 'Retry policy',
      description: MD_TEXT,
      format: 'markdown',
    },
    ctxOf(fake),
  );

  assert.deepEqual(
    nested(lastBody(fake), 'fields')['description'],
    adfFromMarkdown(MD_TEXT),
  );
});

// ---------------------------------------------------------------------------
// The plan seam
// ---------------------------------------------------------------------------

test('the plan-capture unwind is never swallowed — a non-JiraError throw propagates', async () => {
  // `mcp/write-mode.ts` stops a planned write by rejecting with a plain Error.
  // A handler that caught it would report every plan as a failed write, so the
  // catch site must let anything that is not a JiraError travel on.
  const captured = new Error('PlanCaptured: POST /rest/api/3/issue');
  const fake = createFakeJiraRequest().on(CREATE_ROUTE, jiraErr(captured));

  await assert.rejects(
    createIssueTool.handler(
      { project: 'PROJ', issueType: 'Task', summary: 'Retry policy' },
      ctxOf(fake),
    ),
    (error: unknown) => error === captured,
  );
});

test('the same rule holds for the tools that read before they write', async () => {
  const captured = new Error('PlanCaptured: POST /rest/api/3/issue/PROJ-1/transitions');
  const fake = createFakeJiraRequest()
    .on(GET_TRANSITIONS_ROUTE, jiraOk(TRANSITIONS_BODY))
    .on(POST_TRANSITION_ROUTE, jiraErr(captured));

  await assert.rejects(
    transitionIssueTool.handler({ issue: KEY, transition: 'Done' }, ctxOf(fake)),
    (error: unknown) => error === captured,
  );
});
