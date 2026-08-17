// Tests for the agile package (WP-23, extended in WP-61): boards, sprints,
// sprint issues, both moves and the sprint lifecycle.
//
// Everything below is asserted against the CONTRACT tier — a fake
// `JiraRequestFn` that records specs and answers programmed routes, and that
// THROWS on a route nobody programmed. That last property is load-bearing here:
// a pagination loop which failed to stop would surface as "unexpected request",
// not as a quietly wrong item count.
//
// The response bodies are inline plain objects marked `// synthetic`: no
// fixtures exist yet (they are recorded against the scratch site in WP-41), so
// every body is hand-shaped from JIRA-API.md and the real Agile responses, using
// the TESTING.md placeholder vocabulary (`example.atlassian.net`,
// `5b10a2844c20165700ede21g`, `user-1@example.invalid`).
//
// What these tests are really pinning down:
//   * the route + root of every call (`/rest/agile/1.0/...`, never the v3 root);
//   * classic pagination through `fetchAll` — `isLast`, `total`, the page cap,
//     and the budget/cancellation plumbing that has to reach the loop;
//   * CC-03 (a `fields` list is never sent empty) on the sprint-issue read;
//   * the move writes: exact body, and the ABSENCE of `safe` (CC-12/13);
//   * the sprint lifecycle wire shape — POST `/sprint/{id}` (Atlassian's
//     "partially update sprint"), never the PUT that nulls every absent field;
//   * what is refused BEFORE the wire (D22): an over-cap batch, a nameless
//     sprint, a start without a window;
//   * CC-34 — a 403/404 from this root is usually "no Jira Software here",
//     and the sprint-state 400 that means "your sprint state is stale".

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError, type JiraRequestSpec } from '../core/types.js';
import {
  DEFAULT_AGILE_PAGE_SIZE,
  DEFAULT_SPRINT_ISSUE_FIELDS,
  MAX_MOVE_ISSUES,
  closeSprint,
  createSprint,
  listBoards,
  listSprintIssues,
  listSprints,
  moveIssuesToBacklog,
  moveIssuesToSprint,
  startSprint,
} from './agile.js';
import { DEFAULT_SEARCH_FIELDS } from './search.js';

// ---------------------------------------------------------------------------
// Synthetic bodies
// ---------------------------------------------------------------------------

/** One board row as the Agile API sends it — avatars and `self` included. */
function boardRow(id: number, key: string): unknown {
  // synthetic — shape of GET /rest/agile/1.0/board `values[]`
  return {
    id,
    self: `https://example.atlassian.net/rest/agile/1.0/board/${String(id)}`,
    name: `${key} board`,
    type: 'scrum',
    location: {
      projectId: 10000 + id,
      displayName: `Project ${key} (${key})`,
      projectName: `Project ${key}`,
      projectKey: key,
      projectTypeKey: 'software',
      avatarURI: '/secure/projectavatar?size=small&pid=10000',
      name: `Project ${key}`,
    },
  };
}

/** A classic collection envelope (`values`), as boards and sprints use it. */
function valuesPage(
  startAt: number,
  maxResults: number,
  isLast: boolean,
  values: readonly unknown[],
): unknown {
  // synthetic — GET /rest/agile/1.0/board and /board/{id}/sprint envelope
  return { maxResults, startAt, isLast, values };
}

/** One sprint row. */
function sprintRow(id: number, state: string): unknown {
  // synthetic — shape of GET /rest/agile/1.0/board/{id}/sprint `values[]`
  return {
    id,
    self: `https://example.atlassian.net/rest/agile/1.0/sprint/${String(id)}`,
    state,
    name: `Sprint ${String(id)}`,
    startDate: '2026-08-03T09:00:00.000+02:00',
    endDate: '2026-08-17T09:00:00.000+02:00',
    originBoardId: 7,
    goal: 'Ship the agile package',
  };
}

/** One issue row of a sprint, with the default field set populated. */
function issueRow(key: string, id: string): unknown {
  // synthetic — shape of GET /rest/agile/1.0/sprint/{id}/issue `issues[]`
  return {
    id,
    key,
    self: `https://example.atlassian.net/rest/agile/1.0/issue/${id}`,
    fields: {
      summary: `Something to do in ${key}`,
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: {
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'User One',
        emailAddress: 'user-1@example.invalid',
      },
      priority: { name: 'Medium' },
      issuetype: { name: 'Task', subtask: false },
      updated: '2026-08-09T10:15:00.000+02:00',
    },
  };
}

/** The sprint-issue envelope — rows under `issues`, a `total`, no `isLast`. */
function issuesPage(
  startAt: number,
  maxResults: number,
  total: number,
  issues: readonly unknown[],
): unknown {
  // synthetic — GET /rest/agile/1.0/sprint/{id}/issue envelope
  return { expand: 'names,schema', startAt, maxResults, total, issues };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function queryOf(spec: JiraRequestSpec | undefined): Record<string, unknown> {
  assert.ok(spec !== undefined, 'expected a recorded request');
  return { ...spec.query };
}

/** Run `fn` and return the thrown value — identity matters in these tests. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject');
}

function asJiraError(error: unknown): JiraError {
  assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
  return error;
}

// ---------------------------------------------------------------------------
// listBoards
// ---------------------------------------------------------------------------

test('listBoards walks classic pages until isLast and flattens the location', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(valuesPage(0, 2, false, [boardRow(1, 'ABC'), boardRow(2, 'ABC')])))
    .enqueue(jiraOk(valuesPage(2, 2, false, [boardRow(3, 'DEF'), boardRow(4, 'DEF')])))
    .enqueue(jiraOk(valuesPage(4, 2, true, [boardRow(5, 'GHI'), boardRow(6, 'GHI')])));

  const result = await listBoards({ jira: jira.fn, pageSize: 2 });

  // Termination is on `isLast` alone: every page is full, so nothing else could
  // have stopped the loop, and a fourth request would have thrown.
  assert.equal(result.pages, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextStartAt, undefined);
  assert.equal(result.items.length, 6);

  assert.deepEqual(jira.routes(), [
    'GET /rest/agile/1.0/board',
    'GET /rest/agile/1.0/board',
    'GET /rest/agile/1.0/board',
  ]);
  assert.deepEqual(
    jira.calls.map((call) => call.query?.startAt),
    [0, 2, 4],
  );

  // The row is flattened: project identity kept, avatars and `self` dropped.
  assert.deepEqual(result.items[0], {
    id: 1,
    name: 'ABC board',
    type: 'scrum',
    projectId: 10001,
    projectKey: 'ABC',
    projectName: 'Project ABC',
  });
});

test('listBoards stops at the page cap and reports where to resume', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(valuesPage(0, 2, false, [boardRow(1, 'ABC'), boardRow(2, 'ABC')])))
    .enqueue(jiraOk(valuesPage(2, 2, false, [boardRow(3, 'DEF'), boardRow(4, 'DEF')])));

  const result = await listBoards({ jira: jira.fn, pageSize: 2, maxPages: 2 });

  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.pages, 2);
  assert.equal(result.items.length, 4);
  // The offset the caller resumes from — the third page was never requested.
  assert.equal(result.nextStartAt, 4);
  assert.equal(jira.calls.length, 2);
});

test('listBoards sends the project and type filters, and only those', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraOk(valuesPage(0, 50, true, [boardRow(1, 'ABC')])),
  );

  await listBoards({ jira: jira.fn, projectKeyOrId: 'ABC', type: 'kanban' });

  assert.deepEqual(queryOf(jira.lastRequest()), {
    startAt: 0,
    maxResults: DEFAULT_AGILE_PAGE_SIZE,
    projectKeyOrId: 'ABC',
    type: 'kanban',
  });
  // No id in the path, so no template either — the route IS its own template.
  assert.equal(jira.lastRequest()?.pathTemplate, undefined);
  assert.equal(jira.lastRequest()?.root, 'agile');
});

test('listBoards omits the filters entirely when the caller named none', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraOk(valuesPage(0, 50, true, [])),
  );

  const result = await listBoards({ jira: jira.fn });

  // An absent filter is absent, never `projectKeyOrId=` — an empty parameter is
  // a different request as far as Jira is concerned.
  assert.deepEqual(queryOf(jira.lastRequest()), {
    startAt: 0,
    maxResults: DEFAULT_AGILE_PAGE_SIZE,
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.stopReason, 'exhausted');
});

test('listBoards stamps the caller signal onto every page request', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraOk(valuesPage(0, 50, true, [boardRow(1, 'ABC')])),
  );

  await listBoards({ jira: jira.fn, signal: controller.signal });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
});

test('listBoards stops on an expired budget before touching the wire', async () => {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest();

  const result = await listBoards({ jira: jira.fn, clock, deadlineAt: 900 });

  // Proof that BOTH halves of the BudgetGuard union reached `fetchAll`: with the
  // clock missing, the deadline could only have been a silent no-op.
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.partial, true);
  assert.equal(result.pages, 0);
  assert.deepEqual(jira.calls, []);
});

// ---------------------------------------------------------------------------
// listSprints
// ---------------------------------------------------------------------------

test('listSprints targets the board route and filters by state', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraOk(valuesPage(0, 50, true, [sprintRow(21, 'active')])),
  );

  const result = await listSprints({ jira: jira.fn, boardId: 7, state: 'active' });

  const spec = jira.lastRequest();
  assert.equal(spec?.method, 'GET');
  assert.equal(spec?.root, 'agile');
  assert.equal(spec?.path, '/board/7/sprint');
  // The template is what the logs and telemetry group on — never the live id.
  assert.equal(spec?.pathTemplate, '/board/{boardId}/sprint');
  assert.deepEqual(queryOf(spec), {
    startAt: 0,
    maxResults: DEFAULT_AGILE_PAGE_SIZE,
    state: 'active',
  });

  assert.deepEqual(result.items, [
    {
      id: 21,
      name: 'Sprint 21',
      state: 'active',
      goal: 'Ship the agile package',
      startDate: '2026-08-03T09:00:00.000+02:00',
      endDate: '2026-08-17T09:00:00.000+02:00',
      originBoardId: 7,
    },
  ]);
});

test('listSprints joins several states into the CSV Jira expects', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraOk(valuesPage(0, 50, true, [sprintRow(21, 'active'), sprintRow(22, 'future')])),
  );

  await listSprints({ jira: jira.fn, boardId: '7', state: ['active', 'future'] });

  assert.equal(jira.lastRequest()?.query?.state, 'active,future');
});

test('listSprints rejects a board id that is not a Jira id, before any request', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 'ABC board' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /boardId/);
  assert.deepEqual(jira.calls, [], 'a malformed id must never reach the wire');
});

test('listSprints surfaces a page that is not a collection as unexpected_shape', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    // synthetic — a proxy or a changed API answering with something else
    jiraOk({ maxResults: 50, startAt: 0, isLast: true }),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /values/);
});

// ---------------------------------------------------------------------------
// listSprintIssues
// ---------------------------------------------------------------------------

test('the sprint field set IS the search field set — one const, two names', () => {
  // A sprint page and a search page are rendered identically by the tool ring,
  // so a model that switches between them must not get a different column set.
  // Referential equality, not deepEqual: the two names must not be able to drift.
  assert.equal(DEFAULT_SPRINT_ISSUE_FIELDS, DEFAULT_SEARCH_FIELDS);
});

test('listSprintIssues injects the documented field set when none was asked for', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/sprint/21/issue',
    jiraOk(issuesPage(0, 50, 1, [issueRow('ABC-1', '10001')])),
  );

  const result = await listSprintIssues({ jira: jira.fn, sprintId: 21 });

  // CC-03: an empty `fields` on the agile root means "every field Jira has".
  assert.equal(result.fieldsDefaulted, true);
  assert.deepEqual(result.fields, DEFAULT_SPRINT_ISSUE_FIELDS);
  assert.equal(
    jira.lastRequest()?.query?.fields,
    'summary,status,assignee,priority,issuetype,updated',
  );
  assert.equal(jira.lastRequest()?.pathTemplate, '/sprint/{sprintId}/issue');
  assert.equal(jira.lastRequest()?.query?.jql, undefined);

  // Requested fields come back verbatim, under the ids Jira used.
  assert.equal(result.items[0]?.key, 'ABC-1');
  assert.equal(result.items[0]?.id, '10001');
  assert.equal(result.items[0]?.fields?.['summary'], 'Something to do in ABC-1');
  assert.deepEqual(result.items[0]?.fields?.['priority'], { name: 'Medium' });
});

test("listSprintIssues sends the caller's own fields and JQL unchanged", async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/sprint/21/issue',
    jiraOk(issuesPage(0, 50, 1, [issueRow('ABC-2', '10002')])),
  );

  const result = await listSprintIssues({
    jira: jira.fn,
    sprintId: '21',
    fields: ['summary', ' customfield_10016 ', ''],
    jql: '  assignee = 5b10a2844c20165700ede21g  ',
  });

  assert.equal(result.fieldsDefaulted, false);
  assert.deepEqual(result.fields, ['summary', 'customfield_10016']);
  assert.equal(jira.lastRequest()?.query?.fields, 'summary,customfield_10016');
  assert.equal(
    jira.lastRequest()?.query?.jql,
    'assignee = 5b10a2844c20165700ede21g',
    'the JQL travels trimmed but otherwise untouched',
  );
});

test('listSprintIssues stops when the offset reaches the reported total', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(
      jiraOk(
        issuesPage(0, 2, 3, [issueRow('ABC-1', '10001'), issueRow('ABC-2', '10002')]),
      ),
    )
    .enqueue(jiraOk(issuesPage(2, 2, 3, [issueRow('ABC-3', '10003')])));

  const result = await listSprintIssues({ jira: jira.fn, sprintId: 21, pageSize: 2 });

  // This route reports `total` and no `isLast`, so the count is the terminator.
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((issue) => issue.key),
    ['ABC-1', 'ABC-2', 'ABC-3'],
  );
});

// ---------------------------------------------------------------------------
// moveIssuesToSprint
// ---------------------------------------------------------------------------

test('moveIssuesToSprint posts the membership body and is never marked safe', async () => {
  const jira = createFakeJiraRequest().on(
    'POST /rest/agile/1.0/sprint/42/issue',
    // synthetic — Jira answers 204 with no body
    jiraOk(undefined, { status: 204 }),
  );

  const result = await moveIssuesToSprint({
    jira: jira.fn,
    sprintId: 42,
    issues: ['ABC-1', ' ABC-2 '],
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/agile/1.0/sprint/42/issue']);
  assert.equal(spec?.method, 'POST');
  assert.equal(spec?.root, 'agile');
  assert.equal(spec?.pathTemplate, '/sprint/{sprintId}/issue');
  assert.deepEqual(spec?.body, { issues: ['ABC-1', 'ABC-2'] });
  assert.equal(spec?.query, undefined);
  // CC-12/13: an unsafe write is never replayed, so `safe` must be absent —
  // not `false`, absent: the retry matrix reads the property's presence.
  assert.equal(spec?.safe, undefined);
  assert.equal(Object.hasOwn(spec ?? {}, 'safe'), false);

  assert.deepEqual(result, {
    sprintId: 42,
    issues: ['ABC-1', 'ABC-2'],
    status: 204,
  });
});

test('moveIssuesToSprint carries the deadline and signal onto the write', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().on(
    'POST /rest/agile/1.0/sprint/42/issue',
    jiraOk(undefined, { status: 204 }),
  );

  await moveIssuesToSprint({
    jira: jira.fn,
    sprintId: 42,
    issues: ['ABC-1'],
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

test('moveIssuesToSprint refuses an empty batch without touching the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() =>
      moveIssuesToSprint({ jira: jira.fn, sprintId: 42, issues: ['   '] }),
    ),
  );

  assert.equal(error.kind, 'validation');
  assert.deepEqual(jira.calls, []);
});

test('moveIssuesToSprint refuses an oversized batch rather than half-applying it', async () => {
  const jira = createFakeJiraRequest();
  const issues = Array.from(
    { length: MAX_MOVE_ISSUES + 1 },
    (_unused, index) => `ABC-${String(index + 1)}`,
  );

  const error = asJiraError(
    await caught(() => moveIssuesToSprint({ jira: jira.fn, sprintId: 42, issues })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /Nothing was sent/);
  assert.deepEqual(jira.calls, [], 'the first 50 must not move before the error');
});

// ---------------------------------------------------------------------------
// moveIssuesToBacklog
// ---------------------------------------------------------------------------

test('moveIssuesToBacklog posts the bare issue list to the board-less route', async () => {
  const jira = createFakeJiraRequest().on(
    'POST /rest/agile/1.0/backlog/issue',
    // synthetic — Jira answers 204 with no body
    jiraOk(undefined, { status: 204 }),
  );

  const result = await moveIssuesToBacklog({
    jira: jira.fn,
    issues: ['ABC-1', ' ABC-2 ', '  '],
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/agile/1.0/backlog/issue']);
  assert.equal(spec?.method, 'POST');
  assert.equal(spec?.root, 'agile');
  // No id in the path, so no template — and NOT `/backlog/{boardId}/issue`,
  // which is the ranked sibling this module deliberately does not speak.
  assert.equal(spec?.path, '/backlog/issue');
  assert.equal(spec?.pathTemplate, undefined);
  assert.deepEqual(spec?.body, { issues: ['ABC-1', 'ABC-2'] });
  assert.equal(spec?.query, undefined);
  // CC-12/13, exactly as on the sprint move: absent, not `false`.
  assert.equal(spec?.safe, undefined);
  assert.equal(Object.hasOwn(spec ?? {}, 'safe'), false);

  assert.deepEqual(result, { issues: ['ABC-1', 'ABC-2'], status: 204 });
});

test('moveIssuesToBacklog carries the deadline and signal onto the write', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().on(
    'POST /rest/agile/1.0/backlog/issue',
    jiraOk(undefined, { status: 204 }),
  );

  await moveIssuesToBacklog({
    jira: jira.fn,
    issues: ['ABC-1'],
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

test('moveIssuesToBacklog refuses an empty batch and names its own caller', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => moveIssuesToBacklog({ jira: jira.fn, issues: ['  '] })),
  );

  assert.equal(error.kind, 'validation');
  // The two moves share the helper but must not share a message: an error that
  // said "moveIssuesToSprint" here would send the reader to the wrong tool.
  assert.match(error.message, /moveIssuesToBacklog/);
  assert.deepEqual(jira.calls, []);
});

test('moveIssuesToBacklog refuses an oversized batch and says which move it was', async () => {
  const jira = createFakeJiraRequest();
  const issues = Array.from(
    { length: MAX_MOVE_ISSUES + 1 },
    (_unused, index) => `ABC-${String(index + 1)}`,
  );

  const error = asJiraError(
    await caught(() => moveIssuesToBacklog({ jira: jira.fn, issues })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /per backlog call/);
  assert.match(error.message, /Nothing was sent/);
  assert.deepEqual(jira.calls, [], 'the first 50 must not move before the error');
});

// ---------------------------------------------------------------------------
// createSprint
// ---------------------------------------------------------------------------

const CREATE_SPRINT_ROUTE = 'POST /rest/agile/1.0/sprint';

test('createSprint sends only what the caller supplied, with a numeric board id', async () => {
  const jira = createFakeJiraRequest().on(
    CREATE_SPRINT_ROUTE,
    // synthetic — POST /rest/agile/1.0/sprint answers 201 with the new sprint
    jiraOk(
      {
        id: 43,
        self: 'https://example.atlassian.net/rest/agile/1.0/sprint/43',
        state: 'future',
        name: 'Sprint 14',
        originBoardId: 7,
      },
      { status: 201 },
    ),
  );

  const result = await createSprint({
    jira: jira.fn,
    name: '  Sprint 14  ',
    originBoardId: '7',
  });

  const spec = jira.lastRequest();
  assert.equal(spec?.method, 'POST');
  assert.equal(spec?.root, 'agile');
  assert.equal(spec?.path, '/sprint');
  assert.equal(spec?.pathTemplate, undefined);
  // `originBoardId` is a NUMBER on the wire even when the caller passed a
  // string, and the optional fields are absent rather than empty — Jira reads
  // `"goal": ""` as "set the goal to nothing".
  assert.deepEqual(spec?.body, { name: 'Sprint 14', originBoardId: 7 });
  assert.equal(spec?.safe, undefined);

  assert.deepEqual(result, {
    sprint: { id: 43, name: 'Sprint 14', state: 'future', originBoardId: 7 },
    status: 201,
  });
});

test('createSprint forwards the sprint window verbatim', async () => {
  const jira = createFakeJiraRequest().on(
    CREATE_SPRINT_ROUTE,
    jiraOk({ id: 43, name: 'Sprint 14' }, { status: 201 }),
  );

  await createSprint({
    jira: jira.fn,
    name: 'Sprint 14',
    originBoardId: 7,
    goal: '  Ship the importer  ',
    startDate: '2026-01-31T09:00:00.000+02:00',
    endDate: '2026-02-14T09:00:00.000+02:00',
  });

  // The offset survives: D16/CC-23 (the worklog "started" rule) is a v3 worklog
  // rule and must NOT reach this endpoint — no normalising, no UTC conversion.
  assert.deepEqual(jira.lastRequest()?.body, {
    name: 'Sprint 14',
    originBoardId: 7,
    goal: 'Ship the importer',
    startDate: '2026-01-31T09:00:00.000+02:00',
    endDate: '2026-02-14T09:00:00.000+02:00',
  });
});

test('createSprint refuses a nameless sprint before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => createSprint({ jira: jira.fn, name: '   ', originBoardId: 7 })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /Nothing was sent/);
  assert.deepEqual(jira.calls, []);
});

test('createSprint rejects a board id that is not one, and points at the board list', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() =>
      createSprint({ jira: jira.fn, name: 'Sprint 14', originBoardId: 'ABC' }),
    ),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /originBoardId/);
  // The remediation follows the id's NAME, not the call: this one is a board.
  assert.match(error.remediation ?? '', /jira_list_boards/);
  assert.deepEqual(jira.calls, []);
});

test('createSprint fails loudly when the created sprint cannot be read', async () => {
  const jira = createFakeJiraRequest().on(
    CREATE_SPRINT_ROUTE,
    // synthetic — a proxy that swallowed the body, or an API change
    jiraOk({ name: 'Sprint 14', state: 'future' }, { status: 201 }),
  );

  const error = asJiraError(
    await caught(() =>
      createSprint({ jira: jira.fn, name: 'Sprint 14', originBoardId: 7 }),
    ),
  );

  // Strict on purpose: a created sprint whose id cannot be read is useless to
  // every caller, so this one does NOT degrade the way the echo below does.
  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /sprint\.id/);
});

test('createSprint names the field it could not read, whatever went missing', async () => {
  // A body that is not an object at all, and one that is an object without the
  // name — each names itself, so a report says what changed upstream.
  const noBody = createFakeJiraRequest().on(
    CREATE_SPRINT_ROUTE,
    jiraOk('Created', { status: 201 }),
  );
  const noName = createFakeJiraRequest().on(
    CREATE_SPRINT_ROUTE,
    jiraOk({ id: 77, state: 'future' }, { status: 201 }),
  );

  const bodyless = asJiraError(
    await caught(() =>
      createSprint({ jira: noBody.fn, name: 'Sprint 14', originBoardId: 7 }),
    ),
  );
  const nameless = asJiraError(
    await caught(() =>
      createSprint({ jira: noName.fn, name: 'Sprint 14', originBoardId: 7 }),
    ),
  );

  assert.equal(bodyless.kind, 'unexpected_shape');
  assert.match(bodyless.message, /sprint that is not a JSON object/);
  assert.match(bodyless.message, /POST \/sprint/);
  assert.equal(nameless.kind, 'unexpected_shape');
  assert.match(nameless.message, /sprint\.name/);
});

// ---------------------------------------------------------------------------
// startSprint / closeSprint
// ---------------------------------------------------------------------------

const SPRINT_STATE_ROUTE = 'POST /rest/agile/1.0/sprint/42';

/** The sprint Jira echoes back after a state change. */
function sprintEchoBody(state: string): Record<string, unknown> {
  // synthetic — POST /rest/agile/1.0/sprint/{sprintId} echoes the whole sprint
  return {
    id: 42,
    self: 'https://example.atlassian.net/rest/agile/1.0/sprint/42',
    state,
    name: 'Sprint 7',
    goal: 'Ship the importer',
    startDate: '2026-01-31T09:00:00.000+02:00',
    endDate: '2026-02-14T09:00:00.000+02:00',
  };
}

test('startSprint partially updates the sprint — POST, never the nulling PUT', async () => {
  const jira = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraOk(sprintEchoBody('active')),
  );

  const result = await startSprint({
    jira: jira.fn,
    sprintId: '42',
    startDate: ' 2026-01-31T09:00:00.000+02:00 ',
    endDate: '2026-02-14T09:00:00.000+02:00',
  });

  const spec = jira.lastRequest();
  // The verb is the whole point: `PUT /sprint/{id}` is a FULL update whose
  // documented behaviour is to null every field the body omits, which would
  // erase the sprint's name and goal on the way to starting it.
  assert.equal(spec?.method, 'POST');
  assert.equal(spec?.root, 'agile');
  assert.equal(spec?.path, '/sprint/42');
  assert.equal(spec?.pathTemplate, '/sprint/{sprintId}');
  assert.deepEqual(spec?.body, {
    state: 'active',
    startDate: '2026-01-31T09:00:00.000+02:00',
    endDate: '2026-02-14T09:00:00.000+02:00',
  });
  assert.equal(spec?.safe, undefined);

  assert.equal(result.sprintId, 42);
  assert.equal(result.state, 'active');
  assert.equal(result.status, 200);
  assert.equal(result.sprint?.state, 'active');
  assert.equal(result.sprint?.goal, 'Ship the importer');
});

test('closeSprint sends the state and nothing else', async () => {
  const jira = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraOk({
      ...sprintEchoBody('closed'),
      completeDate: '2026-02-14T17:00:00.000+02:00',
    }),
  );

  const result = await closeSprint({ jira: jira.fn, sprintId: 42 });

  assert.equal(jira.lastRequest()?.method, 'POST');
  // No dates: a close must not restate a window it was not given, or the
  // partial update would rewrite the sprint's own plan.
  assert.deepEqual(jira.lastRequest()?.body, { state: 'closed' });
  assert.equal(result.state, 'closed');
  assert.equal(result.sprint?.completeDate, '2026-02-14T17:00:00.000+02:00');
});

test('startSprint refuses to send anything without a complete window', async () => {
  const jira = createFakeJiraRequest();

  const both = asJiraError(
    await caught(() => startSprint({ jira: jira.fn, sprintId: 42 })),
  );
  assert.equal(both.kind, 'validation');
  assert.match(both.message, /startDate and endDate are missing/);
  assert.match(both.message, /Nothing was sent/);

  const one = asJiraError(
    await caught(() =>
      startSprint({
        jira: jira.fn,
        sprintId: 42,
        startDate: '2026-01-31T09:00:00.000+02:00',
        endDate: '   ',
      }),
    ),
  );
  // Naming the ONE field that is missing is the whole reason this check is
  // local: Jira answers a windowless start with a generic 400.
  assert.match(one.message, /endDate is missing/);
  assert.doesNotMatch(one.message, /startDate is missing/);
  assert.match(one.remediation ?? '', /2026-01-31T09:00:00\.000\+02:00/);

  assert.deepEqual(jira.calls, []);
});

test('CC-37: a state change survives an echo it cannot read', async () => {
  const jira = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    // synthetic — a 204, or a proxy that replaced the body with a string
    jiraOk('', { status: 204 }),
  );

  const result = await closeSprint({ jira: jira.fn, sprintId: 42 });

  // The write HAS happened by the time the body is read, so an unreadable echo
  // must not turn an applied close into a failed call: the sprint is simply
  // absent, and the key is absent rather than `undefined`.
  assert.deepEqual(result, { sprintId: 42, state: 'closed', status: 204 });
  assert.equal(Object.hasOwn(result, 'sprint'), false);
});

test('an echo that is a record but not a sprint is dropped, not narrowed', async () => {
  const jira = createFakeJiraRequest().on(SPRINT_STATE_ROUTE, jiraOk({ message: 'ok' }));

  const result = await closeSprint({ jira: jira.fn, sprintId: 42 });

  assert.equal(result.sprint, undefined);
  assert.equal(result.state, 'closed');
});

test('startSprint rejects a sprint id that is not one, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() =>
      startSprint({
        jira: jira.fn,
        sprintId: '0',
        startDate: '2026-01-31T09:00:00.000+02:00',
        endDate: '2026-02-14T09:00:00.000+02:00',
      }),
    ),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /sprintId/);
  assert.match(error.remediation ?? '', /jira_list_sprints/);
  assert.deepEqual(jira.calls, []);
});

// ---------------------------------------------------------------------------
// Error handling — passthrough and CC-34
// ---------------------------------------------------------------------------

test('an upstream failure this ring has no opinion about propagates untouched', async () => {
  const upstream = new JiraError({
    kind: 'rate_limited',
    message: 'Jira asked us to slow down.',
    httpStatus: 429,
    remediation: 'Retry after the Retry-After delay.',
  });
  const jira = createFakeJiraRequest().on('GET /rest/agile/1.0/board', jiraErr(upstream));

  const error = await caught(() => listBoards({ jira: jira.fn }));

  // Same instance, not a re-wrap: the retry policy lives in `core/http.ts`.
  assert.equal(error, upstream);
});

test('CC-34: a 404 on the board list is unsupported, not a missing board', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraErr(
      new JiraError({
        kind: 'not_found',
        message: 'Jira returned 404 for GET /rest/agile/1.0/board.',
        httpStatus: 404,
        remediation: 'Check the identifier.',
      }),
    ),
  );

  const error = asJiraError(await caught(() => listBoards({ jira: jira.fn })));

  // `/board` carries no id, so 404 cannot mean "that board is gone".
  assert.equal(error.kind, 'unsupported');
  assert.equal(error.httpStatus, 404);
  assert.match(error.remediation ?? '', /Jira Software/);
  assert.ok(error.cause instanceof JiraError, 'the original error stays as the cause');
});

test('CC-34: a 403 on an id-bearing route keeps its kind and names the other cause', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraErr(
      new JiraError({
        kind: 'permission',
        message: 'Jira returned 403 for GET /rest/agile/1.0/board/7/sprint.',
        httpStatus: 403,
        remediation: 'Ask a Jira admin for Browse Projects on this board.',
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  // The board id really may be wrong, so the kind survives — only the
  // remediation gains the second explanation.
  assert.equal(error.kind, 'permission');
  assert.match(error.remediation ?? '', /Browse Projects/);
  assert.match(error.remediation ?? '', /Agile API/);
});

test("CC-36: a stale sprint state keeps Jira's words and replaces only the advice", async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message:
      'Jira returned 400 for POST /sprint/{sprintId}: Sprint cannot be started. ' +
      'Check the request fields and retry.',
    httpStatus: 400,
    jiraMessages: ['Sprint cannot be started. It has already been completed.'],
    remediation: 'Check the request fields and retry.',
    detail: '{"errorMessages":["Sprint cannot be started."]}',
  });
  const jira = createFakeJiraRequest().on(SPRINT_STATE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() =>
      startSprint({
        jira: jira.fn,
        sprintId: 42,
        startDate: '2026-01-31T09:00:00.000+02:00',
        endDate: '2026-02-14T09:00:00.000+02:00',
      }),
    ),
  );

  // The kind and everything Jira said travel on untouched — CC-21's shape.
  assert.equal(error.kind, 'validation');
  assert.equal(error.httpStatus, 400);
  assert.deepEqual(error.jiraMessages, [
    'Sprint cannot be started. It has already been completed.',
  ]);
  assert.equal(error.detail, upstream.detail);
  assert.equal(error.cause, upstream);
  assert.match(error.message, /It has already been completed\./);
  // Jira's sentence already ends itself — no ".." seam where the two meet.
  assert.doesNotMatch(error.message, /\.\./);
  // Only the remediation changes: "check the request fields" is wrong advice
  // for a sprint whose state moved on between the list call and this one.
  assert.match(error.remediation ?? '', /jira_list_sprints/);
  assert.match(error.remediation ?? '', /future/);
  assert.doesNotMatch(error.remediation ?? '', /Check the request fields/);
});

test('a refused close is told that closed is terminal, and says so without Jira', async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message: 'Jira returned 400 for POST /sprint/{sprintId}.',
    httpStatus: 400,
  });
  const jira = createFakeJiraRequest().on(SPRINT_STATE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() => closeSprint({ jira: jira.fn, sprintId: 42 })),
  );

  // A 400 with no `errorMessages` still gets the re-aimed remediation, and the
  // reason must not end up with a dangling colon.
  assert.equal(error.jiraMessages, undefined);
  assert.match(error.message, /Jira refused to move this sprint to closed\./);
  assert.match(error.remediation ?? '', /do not retry/);
  assert.match(error.remediation ?? '', /jira_list_sprints/);
});

test("the stale-state rule only touches 400s — a 403 is CC-34's business", async () => {
  const upstream = new JiraError({
    kind: 'permission',
    message: 'Jira returned 403 for POST /sprint/{sprintId}.',
    httpStatus: 403,
    remediation: 'Ask a Jira admin for the Manage Sprints permission.',
  });
  const jira = createFakeJiraRequest().on(SPRINT_STATE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() => closeSprint({ jira: jira.fn, sprintId: 42 })),
  );

  assert.equal(error.kind, 'permission');
  assert.match(error.remediation ?? '', /Manage Sprints/);
  assert.match(error.remediation ?? '', /Agile API/);
  // Not the sprint-state wording: nothing here says the state is stale.
  assert.doesNotMatch(error.remediation ?? '', /jira_list_sprints/);
});

test('a 500 from a state change is not re-shaped by either rule', async () => {
  const upstream = new JiraError({
    kind: 'transport',
    message: 'Jira returned 500 for POST /sprint/{sprintId}.',
    httpStatus: 500,
  });
  const jira = createFakeJiraRequest().on(SPRINT_STATE_ROUTE, jiraErr(upstream));

  const error = await caught(() => closeSprint({ jira: jira.fn, sprintId: 42 }));

  // Same instance: an unsafe write that failed ambiguously belongs to the retry
  // policy in `core/http.ts`, and this ring has no opinion to add.
  assert.equal(error, upstream);
});

test('CC-34 never rewrites a 403 the client already read as an auth failure', async () => {
  const upstream = new JiraError({
    kind: 'auth',
    message: 'Jira rejected the credentials (403 with an auth challenge).',
    httpStatus: 403,
    remediation: 'Re-issue the API token.',
  });
  const jira = createFakeJiraRequest().on('GET /rest/agile/1.0/board', jiraErr(upstream));

  const error = await caught(() => listBoards({ jira: jira.fn }));

  // Telling this caller to check their Jira Software licence would send them
  // after the wrong problem entirely.
  assert.equal(error, upstream);
});
