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
import { createJiraError } from '../core/errors.js';
import { JiraError, type JiraRequestSpec } from '../core/types.js';
import {
  DEFAULT_AGILE_PAGE_SIZE,
  DEFAULT_SPRINT_ISSUE_FIELDS,
  MAX_MOVE_ISSUES,
  SPRINT_PATH_TEMPLATE,
  closeSprint,
  createSprint,
  deleteSprint,
  deleteSprintRequest,
  getBoardConfiguration,
  getSprint,
  listBacklogIssues,
  updateSprint,
  rankIssues,
  setEstimate,
  listBoards,
  listSprintIssues,
  listSprintIssuesDataCenter,
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

/** One `/rest/software/1.0` issue page (D501): token-paged, no `total`. */
function softwarePage(issues: readonly unknown[], nextPageToken?: string): unknown {
  // synthetic — GET /rest/software/1.0/sprint/{id}/issue envelope
  return nextPageToken === undefined
    ? { expand: 'names,schema', issues, isLast: true }
    : { expand: 'names,schema', issues, nextPageToken };
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

test('listBoards resumes from the offset the caller names', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(valuesPage(4, 2, true, [boardRow(5, 'GHI'), boardRow(6, 'GHI')])),
  );

  const result = await listBoards({ jira: jira.fn, pageSize: 2, startAt: 4 });

  // The `nextStartAt` of a capped run goes straight back in as `startAt`.
  assert.equal(jira.calls[0]?.query?.startAt, 4);
  assert.equal(result.pages, 1);
  assert.deepEqual(
    result.items.map((board) => board.id),
    [5, 6],
  );
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

test('listSprints sends no state filter for an empty state list', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraOk(valuesPage(0, 50, true, [sprintRow(21, 'active')])),
  );

  await listSprints({ jira: jira.fn, boardId: 7, state: [] });

  // An empty list means "no filter", never `state=` — the empty parameter is a
  // different request, and Jira answers it with a 400.
  assert.equal(Object.hasOwn(jira.lastRequest()?.query ?? {}, 'state'), false);
});

test('listBoards reads a bare envelope and a board without type or location', async () => {
  // synthetic — the smallest page the loop must still stop on: no `startAt`,
  // no `maxResults`, no `total`, a row with only the required keys.
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraOk({ isLast: true, values: [{ id: 9, name: 'Bare board' }] }),
  );

  const result = await listBoards({ jira: jira.fn });

  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'exhausted');
  assert.deepEqual(result.items, [{ id: 9, name: 'Bare board' }]);
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
    'GET /rest/software/1.0/sprint/21/issue',
    jiraOk(softwarePage([issueRow('ABC-1', '10001')])),
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
    'GET /rest/software/1.0/sprint/21/issue',
    jiraOk(softwarePage([issueRow('ABC-2', '10002')])),
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

test('listSprintIssues keeps a row whose fields are missing, without inventing them', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/software/1.0/sprint/21/issue',
    // synthetic — `fields=` was honoured with nothing to return
    jiraOk(softwarePage([{ key: 'ABC-2', id: '10002' }, { key: 'ABC-3' }])),
  );

  const result = await listSprintIssues({ jira: jira.fn, sprintId: 21 });

  // Only the key is required; `id` and `fields` are carried when present and
  // left out — never `undefined`, never `{}` — when they are not.
  assert.deepEqual(result.items, [{ key: 'ABC-2', id: '10002' }, { key: 'ABC-3' }]);
  assert.equal(Object.hasOwn(result.items[0] ?? {}, 'fields'), false);
  assert.equal(Object.hasOwn(result.items[1] ?? {}, 'id'), false);
});

test('CC-5000: listSprintIssues reads the software root and follows nextPageToken until isLast', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(
      jiraOk(
        softwarePage([issueRow('ABC-1', '10001'), issueRow('ABC-2', '10002')], 'tok-2'),
      ),
    )
    .enqueue(jiraOk(softwarePage([issueRow('ABC-3', '10003')])));

  const result = await listSprintIssues({ jira: jira.fn, sprintId: 21, pageSize: 2 });

  assert.equal(jira.calls[0]?.root, 'software');
  assert.equal(jira.calls[0]?.pathTemplate, '/sprint/{sprintId}/issue');
  assert.deepEqual(queryOf(jira.calls[0]), {
    maxResults: 2,
    fields: DEFAULT_SPRINT_ISSUE_FIELDS.join(','),
  });
  assert.equal(jira.calls[1]?.query?.nextPageToken, 'tok-2');
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  // D501: no `total` and no offset — the root reports neither.
  assert.equal(Object.hasOwn(result, 'total'), false);
  assert.equal(Object.hasOwn(result, 'nextStartAt'), false);
  assert.equal(Object.hasOwn(result, 'nextPageToken'), false);
  assert.deepEqual(
    result.items.map((issue) => issue.key),
    ['ABC-1', 'ABC-2', 'ABC-3'],
  );
});

test('CC-5000: a partial sprint read hands back the unspent nextPageToken, and resumes from it', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(softwarePage([issueRow('ABC-1', '10001')], 'tok-2')))
    .enqueue(jiraOk(softwarePage([issueRow('ABC-2', '10002')])));

  const first = await listSprintIssues({ jira: jira.fn, sprintId: 21, maxPages: 1 });
  assert.equal(first.partial, true);
  assert.equal(first.stopReason, 'max_pages');
  assert.equal(first.nextPageToken, 'tok-2');

  const second = await listSprintIssues({
    jira: jira.fn,
    sprintId: 21,
    maxPages: 1,
    nextPageToken: ' tok-2 ',
  });
  assert.equal(jira.lastRequest()?.query?.nextPageToken, 'tok-2');
  assert.equal(second.partial, false);
  assert.deepEqual(
    second.items.map((issue) => issue.key),
    ['ABC-2'],
  );
});

test('CC-5000: a page with a null nextPageToken and no isLast ends the read', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/software/1.0/sprint/21/issue',
    // synthetic — the schema allows `nextPageToken: null` on the last page
    jiraOk({ issues: [issueRow('ABC-1', '10001')], nextPageToken: null }),
  );

  const result = await listSprintIssues({ jira: jira.fn, sprintId: 21 });

  assert.equal(result.stopReason, 'exhausted');
  assert.equal(jira.calls.length, 1);
});

test('CC-5001: a Cloud startAt above 0 is refused before the wire — there is no offset to honour', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listSprintIssues({ jira: jira.fn, sprintId: 21, startAt: 50 })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /nextPageToken/);
  assert.equal(jira.calls.length, 0);
});

test('CC-5001: a Cloud startAt of 0 is accepted and never sent', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/software/1.0/sprint/21/issue',
    jiraOk(softwarePage([])),
  );

  await listSprintIssues({ jira: jira.fn, sprintId: 21, startAt: 0 });

  assert.equal(jira.lastRequest()?.query?.startAt, undefined);
});

test('CC-5006: a software page without an issues array is unexpected_shape', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/software/1.0/sprint/21/issue',
    // synthetic — a proxy that rewrote the body
    jiraOk({ values: [], isLast: true }),
  );

  const error = asJiraError(
    await caught(() => listSprintIssues({ jira: jira.fn, sprintId: 21 })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /issues/);
});

test('CC-5005: a 404 from the software root keeps its kind and names the Jira Software possibility (CC-34)', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/software/1.0/sprint/21/issue',
    jiraErr(
      createJiraError({
        kind: 'not_found',
        reason: 'Jira answered 404.',
        httpStatus: 404,
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listSprintIssues({ jira: jira.fn, sprintId: 21 })),
  );

  assert.equal(error.kind, 'not_found');
  assert.match(error.message, /Agile API itself may be unavailable/);
});

test('CC-5004: the Data Center twin stays on the agile root with offset paging and a total', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(
      jiraOk(
        issuesPage(0, 2, 3, [issueRow('ABC-1', '10001'), issueRow('ABC-2', '10002')]),
      ),
    )
    .enqueue(jiraOk(issuesPage(2, 2, 3, [issueRow('ABC-3', '10003')])));

  const result = await listSprintIssuesDataCenter({
    jira: jira.fn,
    sprintId: 21,
    pageSize: 2,
  });

  assert.deepEqual(jira.routes(), [
    'GET /rest/agile/1.0/sprint/21/issue',
    'GET /rest/agile/1.0/sprint/21/issue',
  ]);
  assert.equal(jira.calls[1]?.query?.startAt, 2);
  // This route reports `total` and no `isLast`, so the count is the terminator.
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((issue) => issue.key),
    ['ABC-1', 'ABC-2', 'ABC-3'],
  );
});

test('CC-5004: the Data Center twin refuses a nextPageToken before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() =>
      listSprintIssuesDataCenter({ jira: jira.fn, sprintId: 21, nextPageToken: 'tok' }),
    ),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /startAt/);
  assert.equal(jira.calls.length, 0);
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

test('[CC-1221] a created sprint whose echo cannot be read is ambiguous_write', async () => {
  // A 2xx means Jira most likely created the sprint, and sprint names are not
  // unique, so a caller told only "unexpected shape" who sends it again gets a
  // second sprint. Reported the CC-521 way instead — and the message still
  // names the field it could not read, so a report says what changed upstream.
  const cases: readonly [unknown, RegExp][] = [
    // synthetic — a proxy that swallowed the body, or an API change
    [{ name: 'Sprint 14', state: 'future' }, /sprint\.id/],
    [{ id: 77, state: 'future' }, /sprint\.name/],
    ['Created', /sprint that is not a JSON object/],
    [undefined, /sprint that is not a JSON object/],
  ];
  for (const [echo, field] of cases) {
    const jira = createFakeJiraRequest().on(
      CREATE_SPRINT_ROUTE,
      jiraOk(echo, { status: 201 }),
    );

    const error = asJiraError(
      await caught(() =>
        createSprint({ jira: jira.fn, name: 'Sprint 14', originBoardId: 7 }),
      ),
    );

    assert.equal(error.kind, 'ambiguous_write', JSON.stringify(echo));
    assert.equal(error.httpStatus, 201);
    assert.equal(error.retryable, false);
    assert.match(error.message, field);
    assert.match(error.message, /POST \/sprint/);
    assert.match(error.message, /NOT retried/);
    assert.doesNotMatch(error.remediation ?? '', /Retrying will not help/);
    assert.match(error.remediation ?? '', /jira_list_sprints/);
    assert.equal(jira.calls.length, 1);
  }
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

  // And something that is not a JiraError at all (a fence, a programming
  // error) is not even looked at.
  const foreign = new TypeError('fetch is not a function');
  const broken = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board',
    jiraErr(foreign),
  );
  assert.equal(await caught(() => listBoards({ jira: broken.fn })), foreign);
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

test('CC-524: a 404 on a project-filtered board list keeps its kind', async () => {
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

  const error = asJiraError(
    await caught(() => listBoards({ jira: jira.fn, projectKeyOrId: 'NOPE' })),
  );

  // The project key is an id: the 404 may be about it, not about the root, so
  // it must not be reported as "Jira Software is not available".
  assert.equal(error.kind, 'not_found');
  assert.equal(error.httpStatus, 404);
  assert.match(error.remediation ?? '', /Check the identifier/);
  assert.match(error.remediation ?? '', /Agile API/);
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

test('CC-34: the extended advice replaces the old tail instead of doubling it', async () => {
  // The client's own errors are `reason + remediation` (createJiraError's
  // format), so the rewrite must slice the old advice off before appending the
  // extended one — or the message would carry the first sentence twice.
  const upstream = createJiraError({
    kind: 'permission',
    reason: 'Jira refused GET /rest/agile/1.0/board/7/sprint (403).',
    httpStatus: 403,
    remediation: 'Ask a Jira admin for Browse Projects on this board.',
  });
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraErr(upstream),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  assert.equal(error.kind, 'permission');
  assert.equal(
    error.remediation,
    'Ask a Jira admin for Browse Projects on this board. ' +
      'If other agile calls fail the same way, the Agile API itself may be ' +
      'unavailable on this site (Jira Software licence or board permission) rather ' +
      'than the board/sprint being missing.',
  );
  assert.equal(
    error.message,
    `Jira refused GET /rest/agile/1.0/board/7/sprint (403). ${error.remediation ?? ''}`,
  );
  assert.equal(
    error.message.split('Ask a Jira admin').length,
    2,
    'the old advice appears once',
  );
});

test('CC-34: a root-probe refusal keeps what Jira said and the body snippet', async () => {
  const upstream = new JiraError({
    kind: 'permission',
    message: 'Jira returned 403 for GET /rest/agile/1.0/board.',
    httpStatus: 403,
    jiraMessages: ['The user does not have the required licence.'],
    detail: '{"errorMessages":["The user does not have the required licence."]}',
    remediation: 'Ask a Jira admin for access.',
  });
  const jira = createFakeJiraRequest().on('GET /rest/agile/1.0/board', jiraErr(upstream));

  const error = asJiraError(await caught(() => listBoards({ jira: jira.fn })));

  assert.equal(error.kind, 'unsupported');
  assert.equal(error.httpStatus, 403);
  assert.match(error.message, /answered 403 for the board list/);
  // CC-21's shape survives the rewrite: Jira's own words and the raw body.
  assert.deepEqual(error.jiraMessages, upstream.jiraMessages);
  assert.equal(error.detail, upstream.detail);
  assert.equal(error.cause, upstream);
});

test('CC-34: a scoped refusal with no advice of its own gets the Agile explanation alone', async () => {
  const upstream = new JiraError({
    kind: 'not_found',
    message: 'Jira returned 404 for GET /rest/agile/1.0/sprint/21.',
    httpStatus: 404,
    jiraMessages: ['Sprint does not exist or you do not have permission to view it.'],
    detail:
      '{"errorMessages":["Sprint does not exist or you do not have permission to view it."]}',
  });
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/sprint/21',
    jiraErr(upstream),
  );

  const error = asJiraError(
    await caught(() => getSprint({ jira: jira.fn, sprintId: 21 })),
  );

  assert.equal(error.kind, 'not_found');
  assert.equal(error.httpStatus, 404);
  // Nothing to slice off the tail, so the original message is the reason and
  // the Agile explanation is the whole remediation — no leading space, no
  // doubled advice.
  assert.match(error.remediation ?? '', /^If other agile calls fail the same way/);
  assert.equal(error.message, `${upstream.message} ${error.remediation ?? ''}`);
  assert.deepEqual(error.jiraMessages, upstream.jiraMessages);
  assert.equal(error.detail, upstream.detail);
  assert.equal(error.cause, upstream);
});

test('CC-95: the sprint-less rewrite copes with a refusal that carries no body snippet', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraErr(
      new JiraError({
        kind: 'validation',
        message: 'Jira rejected GET /rest/agile/1.0/board/7/sprint with HTTP 400.',
        httpStatus: 400,
        jiraMessages: ['The board does not support sprints'],
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  assert.equal(error.kind, 'unsupported');
  assert.deepEqual(error.jiraMessages, ['The board does not support sprints']);
  assert.equal(Object.hasOwn(error, 'detail') && error.detail !== undefined, false);
});

test('CC-95: a board that cannot hold sprints is unsupported, not a bad argument', async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message:
      'Jira rejected GET /rest/agile/1.0/board/7/sprint with HTTP 400: ' +
      'The board does not support sprints',
    httpStatus: 400,
    jiraMessages: ['The board does not support sprints'],
    remediation: 'Check the request fields and retry.',
    detail: '{"errorMessages":["The board does not support sprints"]}',
  });
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraErr(upstream),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  // `validation` would say the caller's arguments were wrong; they were not —
  // board 7 exists and the request is well formed, it is simply kanban or
  // team-managed. `unsupported` is the kind that stops the retry loop.
  assert.equal(error.kind, 'unsupported');
  assert.equal(error.httpStatus, 400);
  assert.match(error.remediation ?? '', /scrum/);
  assert.doesNotMatch(error.remediation ?? '', /Check the request fields/);
  // Jira's own words and the raw body survive the rewrite (CC-21's shape).
  assert.deepEqual(error.jiraMessages, ['The board does not support sprints']);
  assert.equal(error.detail, upstream.detail);
  assert.equal(error.cause, upstream);
});

test('CC-95: an ordinary 400 on a sprint list keeps its validation kind', async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message: 'Jira rejected GET /rest/agile/1.0/board/7/sprint with HTTP 400.',
    httpStatus: 400,
    jiraMessages: ['The state parameter is invalid.'],
    remediation: 'Check the request fields and retry.',
  });
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/board/7/sprint',
    jiraErr(upstream),
  );

  const error = asJiraError(
    await caught(() => listSprints({ jira: jira.fn, boardId: 7 })),
  );

  // The rewrite is keyed on Jira's sentence, not on the status — a 400 that
  // really is a bad argument must still read as one.
  assert.equal(error.kind, 'validation');
  assert.equal(error.remediation, 'Check the request fields and retry.');
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

// ---------------------------------------------------------------------------
// getSprint / deleteSprint (Phase 11)
// ---------------------------------------------------------------------------

const SPRINT_DELETE_ROUTE = 'DELETE /rest/agile/1.0/sprint/42';

test('getSprint reads one sprint from the agile root and narrows it', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/agile/1.0/sprint/42',
    jiraOk(sprintRow(42, 'active')),
  );

  const sprint = await getSprint({ jira: jira.fn, sprintId: 42 });

  assert.deepEqual(jira.routes(), ['GET /rest/agile/1.0/sprint/42']);
  assert.equal(jira.lastRequest()?.method, 'GET');
  assert.equal(jira.lastRequest()?.root, 'agile');
  assert.equal(jira.lastRequest()?.pathTemplate, SPRINT_PATH_TEMPLATE);
  // Whole-object deepEqual: `self` is dropped, everything narrow survives.
  assert.deepEqual(sprint, {
    id: 42,
    name: 'Sprint 42',
    state: 'active',
    goal: 'Ship the agile package',
    startDate: '2026-08-03T09:00:00.000+02:00',
    endDate: '2026-08-17T09:00:00.000+02:00',
    originBoardId: 7,
  });
});

test('getSprint rejects a sprint id that is not one, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => getSprint({ jira: jira.fn, sprintId: 'board 7' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /sprintId/);
  assert.match(error.remediation ?? '', /jira_list_sprints/);
  assert.deepEqual(jira.calls, []);
});

test('deleteSprintRequest builds the bare spec the plan shows', () => {
  // Whole-spec deepEqual: the builder stamps neither controls nor a `safe`
  // flag — that is the executor's job.
  assert.deepEqual(deleteSprintRequest({ sprintId: '42' }), {
    method: 'DELETE',
    root: 'agile',
    path: '/sprint/42',
    pathTemplate: SPRINT_PATH_TEMPLATE,
  });
});

test('CC-124: deleteSprint sends the DELETE whatever the sprint state', async () => {
  // ONLY the DELETE route is programmed: a client-side state guard would have
  // to read the sprint first, hit an unprogrammed route, and fail this test.
  const jira = createFakeJiraRequest().on(
    SPRINT_DELETE_ROUTE,
    jiraOk(undefined, { status: 204 }),
  );

  const receipt = await deleteSprint({ jira: jira.fn, sprintId: 42 });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), [SPRINT_DELETE_ROUTE]);
  assert.equal(spec?.method, 'DELETE');
  assert.equal(spec?.root, 'agile');
  assert.equal(spec?.pathTemplate, SPRINT_PATH_TEMPLATE);
  assert.equal(spec?.body, undefined);
  // CC-12/13: an unsafe write is never replayed, so `safe` must be absent —
  // not `false`, absent: the retry matrix reads the property's presence.
  assert.equal(spec?.safe, undefined);
  assert.equal(Object.hasOwn(spec ?? {}, 'safe'), false);

  assert.deepEqual(receipt, { sprintId: 42, deleted: true });
});

test('CC-124: a 400 refusal is re-aimed like the other sprint writes', async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message:
      'Jira returned 400 for DELETE /sprint/{sprintId}: The sprint cannot be ' +
      'deleted. Check the request fields and retry.',
    httpStatus: 400,
    jiraMessages: ['The sprint cannot be deleted. It is the active sprint.'],
    remediation: 'Check the request fields and retry.',
    detail: '{"errorMessages":["The sprint cannot be deleted."]}',
  });
  const jira = createFakeJiraRequest().on(SPRINT_DELETE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() => deleteSprint({ jira: jira.fn, sprintId: 42 })),
  );

  // The kind and everything Jira said travel on untouched — CC-21's shape.
  assert.equal(error.kind, 'validation');
  assert.equal(error.httpStatus, 400);
  assert.deepEqual(error.jiraMessages, [
    'The sprint cannot be deleted. It is the active sprint.',
  ]);
  assert.equal(error.detail, upstream.detail);
  assert.equal(error.cause, upstream);
  assert.match(error.message, /Jira refused to delete this sprint/);
  assert.match(error.message, /It is the active sprint\./);
  assert.doesNotMatch(error.message, /\.\./);
  // Only the remediation changes: "check the request fields" is wrong advice
  // when the sprint's state, not the request, is what Jira objected to.
  assert.match(error.remediation ?? '', /jira_list_sprints/);
  assert.doesNotMatch(error.remediation ?? '', /Check the request fields/);
});

test('a refused delete without Jira messages has no dangling colon', async () => {
  const upstream = new JiraError({
    kind: 'validation',
    message: 'Jira returned 400 for DELETE /sprint/{sprintId}.',
    httpStatus: 400,
  });
  const jira = createFakeJiraRequest().on(SPRINT_DELETE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() => deleteSprint({ jira: jira.fn, sprintId: 42 })),
  );

  assert.equal(error.jiraMessages, undefined);
  assert.match(error.message, /Jira refused to delete this sprint\./);
});

test("the delete re-aim only touches 400s — a 403 is CC-34's business", async () => {
  const upstream = new JiraError({
    kind: 'permission',
    message: 'Jira returned 403 for DELETE /sprint/{sprintId}.',
    httpStatus: 403,
    remediation: 'Ask a Jira admin for the Manage Sprints permission.',
  });
  const jira = createFakeJiraRequest().on(SPRINT_DELETE_ROUTE, jiraErr(upstream));

  const error = asJiraError(
    await caught(() => deleteSprint({ jira: jira.fn, sprintId: 42 })),
  );

  assert.equal(error.kind, 'permission');
  assert.match(error.remediation ?? '', /Manage Sprints/);
  assert.match(error.remediation ?? '', /Agile API/);
  // Not the sprint-state wording: nothing here says the state is stale.
  assert.doesNotMatch(error.remediation ?? '', /jira_list_sprints/);
});

test('a 500 from a sprint delete propagates untouched — the same instance', async () => {
  const upstream = new JiraError({
    kind: 'transport',
    message: 'Jira returned 500 for DELETE /sprint/{sprintId}.',
    httpStatus: 500,
  });
  const jira = createFakeJiraRequest().on(SPRINT_DELETE_ROUTE, jiraErr(upstream));

  const error = await caught(() => deleteSprint({ jira: jira.fn, sprintId: 42 }));

  // Same instance: an unsafe write that failed ambiguously belongs to the retry
  // policy in `core/http.ts`, and this ring has no opinion to add.
  assert.equal(error, upstream);
});

test('deleteSprint carries the deadline and signal onto the write', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().on(
    SPRINT_DELETE_ROUTE,
    jiraOk(undefined, { status: 204 }),
  );

  await deleteSprint({
    jira: jira.fn,
    sprintId: 42,
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

// ---------------------------------------------------------------------------
// Board configuration (D133)
// ---------------------------------------------------------------------------

const BOARD_CONFIG_ROUTE = 'GET /rest/agile/1.0/board/7/configuration';

/** A scrum board's configuration, as Cloud answers it. */
function boardConfigBody(): Record<string, unknown> {
  // synthetic
  return {
    id: 7,
    name: 'PROJ board',
    type: 'scrum',
    self: 'https://example.atlassian.net/rest/agile/1.0/board/7/configuration',
    location: { type: 'project', key: 'PROJ', id: '10000', name: 'Project' },
    filter: {
      id: '10042',
      self: 'https://example.atlassian.net/rest/api/2/filter/10042',
    },
    subQuery: { query: '' },
    columnConfig: {
      columns: [
        { name: 'To Do', statuses: [{ id: '10000', self: 'x' }] },
        { name: 'In Progress', statuses: [{ id: '3' }, { id: 10001 }], max: 5 },
        { name: 'Done', statuses: [{ id: '10002' }], min: 1 },
        { name: 'Parked', statuses: [] },
      ],
      constraintType: 'issueCount',
    },
    estimation: {
      type: 'field',
      field: { fieldId: 'customfield_10016', displayName: 'Story point estimate' },
    },
    ranking: { rankCustomFieldId: 10019 },
  };
}

test('CC-1480: getBoardConfiguration reads one board and narrows it', async () => {
  const jira = createFakeJiraRequest().on(BOARD_CONFIG_ROUTE, jiraOk(boardConfigBody()));

  const config = await getBoardConfiguration({ jira: jira.fn, boardId: 7 });

  assert.deepEqual(jira.routes(), [BOARD_CONFIG_ROUTE]);
  assert.equal(jira.lastRequest()?.root, 'agile');
  assert.equal(jira.lastRequest()?.pathTemplate, '/board/{boardId}/configuration');
  // Whole-object deepEqual: `self` links are dropped, a blank sub-query is
  // absent, numeric status ids become strings like the rest, and the string
  // project id Cloud sends becomes the number the board list reports.
  assert.deepEqual(config, {
    boardId: 7,
    name: 'PROJ board',
    type: 'scrum',
    filterId: '10042',
    projectKey: 'PROJ',
    projectId: 10000,
    columns: [
      { name: 'To Do', statusIds: ['10000'] },
      { name: 'In Progress', statusIds: ['3', '10001'], max: 5 },
      { name: 'Done', statusIds: ['10002'], min: 1 },
      { name: 'Parked', statusIds: [] },
    ],
    constraintType: 'issueCount',
    estimation: {
      type: 'field',
      fieldId: 'customfield_10016',
      fieldName: 'Story point estimate',
    },
    rankFieldId: 10019,
  });
});

test('CC-1481: a kanban board without estimation or columns still narrows', async () => {
  const jira = createFakeJiraRequest().on(
    BOARD_CONFIG_ROUTE,
    // synthetic
    jiraOk({
      id: 7,
      name: 'Ops kanban',
      type: 'kanban',
      location: { type: 'user', name: 'someone' },
      filter: { id: 10042 },
      subQuery: { query: 'fixVersion in unreleasedVersions()' },
      estimation: { type: 'none' },
    }),
  );

  const config = await getBoardConfiguration({ jira: jira.fn, boardId: 7 });

  // A user-located board names no project; a numeric filter id is a string.
  assert.deepEqual(config, {
    boardId: 7,
    name: 'Ops kanban',
    type: 'kanban',
    filterId: '10042',
    subQuery: 'fixVersion in unreleasedVersions()',
    columns: [],
    estimation: { type: 'none' },
  });
});

test('CC-1482: a board configuration without an id is an unexpected shape', async () => {
  const jira = createFakeJiraRequest().on(BOARD_CONFIG_ROUTE, jiraOk({ name: 'x' }));

  const error = asJiraError(
    await caught(() => getBoardConfiguration({ jira: jira.fn, boardId: 7 })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /board\.id/);
});

test('CC-1482: getBoardConfiguration rejects a board id that is not one, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => getBoardConfiguration({ jira: jira.fn, boardId: 'PROJ' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /boardId/);
  assert.deepEqual(jira.calls, []);
});

test('CC-1483: a 404 on a board configuration is that board, not the root', async () => {
  const jira = createFakeJiraRequest().on(
    BOARD_CONFIG_ROUTE,
    jiraErr(
      new JiraError({
        kind: 'not_found',
        message: 'Jira returned 404 for GET /rest/agile/1.0/board/7/configuration.',
        httpStatus: 404,
        remediation: 'Check the identifier.',
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => getBoardConfiguration({ jira: jira.fn, boardId: 7 })),
  );

  // An id-bearing route: the board can be gone, so no root probe rewrite.
  assert.equal(error.kind, 'not_found');
});

// ---------------------------------------------------------------------------
// Backlog (D134)
// ---------------------------------------------------------------------------

const BACKLOG_ROUTE = 'GET /rest/software/1.0/board/7/backlog';

test('CC-1485: listBacklogIssues reads the board backlog with the default fields', async () => {
  const jira = createFakeJiraRequest().on(
    BACKLOG_ROUTE,
    jiraOk(softwarePage([issueRow('ABC-9', '10009')])),
  );

  const result = await listBacklogIssues({ jira: jira.fn, boardId: 7 });

  const request = jira.lastRequest();
  assert.equal(request?.method, 'GET');
  assert.equal(request?.root, 'software');
  assert.equal(request?.pathTemplate, '/board/{boardId}/backlog');
  assert.equal(request?.safe, undefined, 'a GET needs no safe flag');
  assert.equal(request?.query?.fields, DEFAULT_SPRINT_ISSUE_FIELDS.join(','));
  assert.equal(request?.query?.jql, undefined);
  assert.equal(result.fieldsDefaulted, true);
  assert.deepEqual(
    result.items.map((issue) => issue.key),
    ['ABC-9'],
  );
});

test("CC-1485: listBacklogIssues sends the caller's fields, JQL and resume token", async () => {
  const jira = createFakeJiraRequest().on(
    BACKLOG_ROUTE,
    jiraOk(softwarePage([issueRow('ABC-30', '10030')])),
  );

  const result = await listBacklogIssues({
    jira: jira.fn,
    boardId: '7',
    fields: [' summary ', 'customfield_10016'],
    jql: ' issuetype = Bug ',
    nextPageToken: 'tok-20',
    pageSize: 10,
    maxPages: 1,
  });

  assert.deepEqual(queryOf(jira.lastRequest()), {
    maxResults: 10,
    fields: 'summary,customfield_10016',
    jql: 'issuetype = Bug',
    nextPageToken: 'tok-20',
  });
  assert.equal(result.fieldsDefaulted, false);
  assert.equal(result.stopReason, 'exhausted');
});

test('CC-1486: listBacklogIssues rejects a board id that is not one, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listBacklogIssues({ jira: jira.fn, boardId: 'ABC board' })),
  );

  assert.equal(error.kind, 'validation');
  assert.equal(jira.calls.length, 0);
});

test('CC-1487: a backlog refusal (kanban without a backlog) passes through', async () => {
  const jira = createFakeJiraRequest().on(
    BACKLOG_ROUTE,
    jiraErr(
      createJiraError({
        kind: 'validation',
        reason: 'Jira refused GET /rest/software/1.0/board/7/backlog (400).',
        httpStatus: 400,
        remediation: 'Enable the backlog on this board.',
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listBacklogIssues({ jira: jira.fn, boardId: 7 })),
  );

  assert.equal(error.kind, 'validation');
  assert.equal(error.httpStatus, 400);
});

// ---------------------------------------------------------------------------
// Sprint edit (D135)
// ---------------------------------------------------------------------------

test('CC-1489: updateSprint sends only the named fields, as a partial POST', async () => {
  const jira = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraOk({ ...sprintEchoBody('future'), goal: 'Ship the refund flow' }),
  );

  const result = await updateSprint({
    jira: jira.fn,
    sprintId: 42,
    goal: '  Ship the refund flow ',
    endDate: '2026-11-11T17:00:00.000+02:00',
  });

  const request = jira.lastRequest();
  // POST, never PUT: the PUT nulls every field the body leaves out.
  assert.equal(request?.method, 'POST');
  assert.deepEqual(request?.body, {
    goal: 'Ship the refund flow',
    endDate: '2026-11-11T17:00:00.000+02:00',
  });
  assert.equal(request?.safe, undefined);
  assert.deepEqual(result.updated, ['goal', 'endDate']);
  assert.equal(result.sprintId, 42);
  assert.equal(result.sprint?.goal, 'Ship the refund flow');
});

test('CC-1489: an empty goal clears it rather than being dropped', async () => {
  const jira = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraOk(sprintEchoBody('future')),
  );

  const result = await updateSprint({ jira: jira.fn, sprintId: 42, goal: '' });

  assert.deepEqual(jira.lastRequest()?.body, { goal: '' });
  assert.deepEqual(result.updated, ['goal']);
});

test('CC-1490: updateSprint refuses an empty edit, an empty name or date, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const none = asJiraError(
    await caught(() => updateSprint({ jira: jira.fn, sprintId: 42 })),
  );
  assert.equal(none.kind, 'validation');
  assert.match(none.message, /at least one of name, goal, startDate or endDate/);

  const name = asJiraError(
    await caught(() => updateSprint({ jira: jira.fn, sprintId: 42, name: '  ' })),
  );
  assert.match(name.message, /empty name/);

  const date = asJiraError(
    await caught(() => updateSprint({ jira: jira.fn, sprintId: 42, startDate: ' ' })),
  );
  assert.match(date.message, /empty startDate/);
  assert.match(date.message, /Nothing was sent/);

  const id = asJiraError(
    await caught(() => updateSprint({ jira: jira.fn, sprintId: 'next', name: 'S1' })),
  );
  assert.equal(id.kind, 'validation');

  assert.equal(jira.calls.length, 0);
});

test("CC-1491: an edit to a closed sprint passes Jira's 400 through, with no echo needed", async () => {
  const refused = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraErr(
      createJiraError({
        kind: 'validation',
        reason: 'Jira refused POST /rest/agile/1.0/sprint/42 (400).',
        httpStatus: 400,
        remediation: 'A closed sprint cannot be edited.',
      }),
    ),
  );
  const error = asJiraError(
    await caught(() => updateSprint({ jira: refused.fn, sprintId: 42, name: 'Renamed' })),
  );
  assert.equal(error.kind, 'validation');
  assert.equal(refused.calls.length, 1);

  const silent = createFakeJiraRequest().on(
    SPRINT_STATE_ROUTE,
    jiraOk('', { status: 204 }),
  );
  const result = await updateSprint({ jira: silent.fn, sprintId: 42, name: 'Renamed' });
  assert.deepEqual(result, { sprintId: 42, updated: ['name'], status: 204 });
});

// ---------------------------------------------------------------------------
// Rank (D136)
// ---------------------------------------------------------------------------

const RANK_ROUTE = 'PUT /rest/agile/1.0/issue/rank';

test('CC-1493: rankIssues sends one anchor, keeps the order and reads a 204 as all ranked', async () => {
  const jira = createFakeJiraRequest().on(RANK_ROUTE, jiraOk('', { status: 204 }));

  const result = await rankIssues({
    jira: jira.fn,
    issues: [' SHOP-412 ', 'SHOP-415'],
    rankBeforeIssue: 'SHOP-398',
    rankCustomFieldId: 10019,
  });

  const request = jira.lastRequest();
  assert.equal(request?.method, 'PUT');
  assert.equal(request?.root, 'agile');
  assert.deepEqual(request?.body, {
    issues: ['SHOP-412', 'SHOP-415'],
    rankBeforeIssue: 'SHOP-398',
    rankCustomFieldId: 10019,
  });
  assert.equal(request?.safe, undefined);
  assert.deepEqual(result, {
    issues: ['SHOP-412', 'SHOP-415'],
    outcome: 'all',
    failed: [],
    status: 204,
  });
});

test('CC-1494: rankIssues refuses no anchor, two anchors, a self-anchor and 51 issues, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const none = asJiraError(
    await caught(() => rankIssues({ jira: jira.fn, issues: ['A-1'] })),
  );
  assert.equal(none.kind, 'validation');
  assert.match(none.message, /exactly one of rankBeforeIssue or rankAfterIssue/);

  const both = asJiraError(
    await caught(() =>
      rankIssues({
        jira: jira.fn,
        issues: ['A-1'],
        rankBeforeIssue: 'A-2',
        rankAfterIssue: 'A-3',
      }),
    ),
  );
  assert.match(both.message, /exactly one/);

  const self = asJiraError(
    await caught(() =>
      rankIssues({ jira: jira.fn, issues: ['A-1', 'A-2'], rankAfterIssue: ' A-2 ' }),
    ),
  );
  assert.match(self.message, /relative to itself/);
  assert.match(self.message, /Nothing was sent/);

  const many = Array.from(
    { length: MAX_MOVE_ISSUES + 1 },
    (_, index) => `A-${String(index + 10)}`,
  );
  const capped = asJiraError(
    await caught(() =>
      rankIssues({ jira: jira.fn, issues: many, rankAfterIssue: 'A-1' }),
    ),
  );
  assert.match(capped.message, /per rank call/);

  assert.equal(jira.calls.length, 0);
});

test('CC-1495: a 207 names the issues Jira refused and is never resent', async () => {
  const jira = createFakeJiraRequest().on(
    RANK_ROUTE,
    jiraOk(
      {
        entries: [
          { issueId: 10412, issueKey: 'SHOP-412', status: 200 },
          {
            issueId: 10415,
            issueKey: 'SHOP-415',
            status: 403,
            errors: ['No rank permission'],
          },
          { issueId: 10416 },
        ],
      },
      { status: 207 },
    ),
  );

  const result = await rankIssues({
    jira: jira.fn,
    issues: ['SHOP-412', 'SHOP-415', 'SHOP-416'],
    rankAfterIssue: 'SHOP-398',
  });

  assert.equal(jira.calls.length, 1);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.status, 207);
  assert.deepEqual(result.failed, [
    { issue: 'SHOP-415', status: 403, errors: ['No rank permission'] },
    { issue: '10416', status: 0, errors: [] },
  ]);
});

test('CC-1496: an unreadable 207 is reported as unknown, an all-green one as all', async () => {
  const garbled = createFakeJiraRequest().on(RANK_ROUTE, jiraOk('', { status: 207 }));
  const unknown = await rankIssues({
    jira: garbled.fn,
    issues: ['A-1'],
    rankAfterIssue: 'A-2',
  });
  assert.equal(unknown.outcome, 'unknown');
  assert.deepEqual(unknown.failed, []);

  const green = createFakeJiraRequest().on(
    RANK_ROUTE,
    jiraOk({ entries: [{ issueKey: 'A-1', status: 200 }] }, { status: 207 }),
  );
  const all = await rankIssues({
    jira: green.fn,
    issues: ['A-1'],
    rankAfterIssue: 'A-2',
  });
  assert.equal(all.outcome, 'all');
});

// ---------------------------------------------------------------------------
// Estimate (D137)
// ---------------------------------------------------------------------------

const ESTIMATE_ROUTE = 'PUT /rest/agile/1.0/issue/SHOP-412/estimation';

test('CC-1498: setEstimate sends the value as a string, scoped to the board', async () => {
  const jira = createFakeJiraRequest().on(
    ESTIMATE_ROUTE,
    jiraOk({ fieldId: 'customfield_10016', value: '5' }),
  );

  const result = await setEstimate({
    jira: jira.fn,
    issue: ' SHOP-412 ',
    boardId: '7',
    value: 5,
  });

  const request = jira.lastRequest();
  assert.equal(request?.method, 'PUT');
  assert.equal(request?.root, 'agile');
  assert.equal(request?.pathTemplate, '/issue/{issueIdOrKey}/estimation');
  assert.deepEqual(queryOf(request), { boardId: '7' });
  assert.deepEqual(request?.body, { value: '5' });
  assert.equal(request?.safe, undefined);
  assert.deepEqual(result, {
    issue: 'SHOP-412',
    boardId: 7,
    sent: '5',
    status: 200,
    fieldId: 'customfield_10016',
    value: '5',
  });
});

test('CC-1499: setEstimate refuses an empty issue, a negative or empty value and a bad board, before the wire', async () => {
  const jira = createFakeJiraRequest();

  const issue = asJiraError(
    await caught(() => setEstimate({ jira: jira.fn, issue: ' ', boardId: 7, value: 3 })),
  );
  assert.equal(issue.kind, 'validation');

  const negative = asJiraError(
    await caught(() =>
      setEstimate({ jira: jira.fn, issue: 'A-1', boardId: 7, value: -1 }),
    ),
  );
  assert.match(negative.message, /non-negative/);

  const empty = asJiraError(
    await caught(() =>
      setEstimate({ jira: jira.fn, issue: 'A-1', boardId: 7, value: '  ' }),
    ),
  );
  assert.match(empty.message, /empty estimate/);
  assert.match(empty.message, /Nothing was sent/);

  const board = asJiraError(
    await caught(() =>
      setEstimate({ jira: jira.fn, issue: 'A-1', boardId: 'main', value: 3 }),
    ),
  );
  assert.equal(board.kind, 'validation');

  assert.equal(jira.calls.length, 0);
});

test('CC-1504: a duration passes verbatim and a bodiless answer still succeeds without an echo', async () => {
  const jira = createFakeJiraRequest().on(ESTIMATE_ROUTE, jiraOk('', { status: 204 }));

  const result = await setEstimate({
    jira: jira.fn,
    issue: 'SHOP-412',
    boardId: 7,
    value: ' 1d 4h ',
  });

  assert.deepEqual(jira.lastRequest()?.body, { value: '1d 4h' });
  assert.deepEqual(result, { issue: 'SHOP-412', boardId: 7, sent: '1d 4h', status: 204 });
});
