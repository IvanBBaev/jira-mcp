// Tests for `jira_sprint_summary` (D155): the composite sprint read.
//
// Contract tier — the fake answers programmed routes and throws on anything
// else, so a read the summary should have skipped fails loudly. Bodies are
// synthetic, hand-shaped from JIRA-API.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_API } from '../api/port.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraOk,
} from '../core/fakes/index.js';
import type { JiraRequestFn } from '../core/types.js';
import type { ToolCtx, ToolResult } from '../mcp/types.js';
import { agilePackage } from './agile.js';
import {
  SPRINT_FIELD_TYPE,
  addedAfterStart,
  categoryOf,
  sprintIdsOf,
  sprintSummaryTool,
  totalsOf,
} from './sprint-summary.js';

const SPRINT_ROUTE = 'GET /rest/agile/1.0/sprint/42';
const SPRINT_ISSUES_ROUTE = 'GET /rest/software/1.0/sprint/42/issue';
const BOARD_CONFIG_ROUTE = 'GET /rest/agile/1.0/board/17/configuration';
const FIELDS_ROUTE = 'GET /rest/api/3/field';
const CHANGELOG_ROUTE = 'POST /rest/api/3/changelog/bulkfetch';

const START = '2026-10-01T09:00:00.000Z';

function createCtx(jira: JiraRequestFn): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira,
    api: CLOUD_API,
    log: createFakeLogger({ clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 100_000, maxPages: 20 },
    deadlineAt: 61_000,
  };
}

function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  if (result.data === undefined) throw new Error('ok result carried no data');
  return result.data;
}

// synthetic — GET /rest/agile/1.0/sprint/42
const SPRINT = {
  id: 42,
  state: 'active',
  name: 'Sprint 7',
  startDate: START,
  endDate: '2026-10-15T09:00:00.000Z',
  originBoardId: 17,
  goal: 'Ship it',
};

// synthetic — GET /rest/agile/1.0/board/17/configuration
const BOARD_CONFIG = {
  id: 17,
  name: 'Team board',
  type: 'scrum',
  filter: { id: '10000' },
  columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '1' }] }] },
  estimation: { type: 'field', field: { fieldId: 'customfield_10016' } },
  ranking: { rankCustomFieldId: 10019 },
};

function issue(
  id: string,
  key: string,
  category: string,
  points?: number,
): Record<string, unknown> {
  return {
    id,
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: category, statusCategory: { key: category } },
      issuetype: { name: 'Story' },
      ...(points === undefined ? {} : { customfield_10016: points }),
    },
  };
}

// synthetic — GET /rest/software/1.0/sprint/42/issue (token-paged, no total)
const ISSUES_PAGE = {
  isLast: true,
  issues: [
    issue('10001', 'SAN-1', 'done', 3),
    issue('10002', 'SAN-2', 'indeterminate', 5),
    issue('10003', 'SAN-3', 'new', 2.1),
    issue('10004', 'SAN-4', 'done'),
  ],
};

// synthetic — GET /rest/api/3/field (a bare array)
const FIELDS = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  {
    id: 'customfield_10020',
    name: 'Sprint',
    custom: true,
    schema: { type: 'array', items: 'json', custom: SPRINT_FIELD_TYPE, customId: 10020 },
  },
];

// synthetic — POST /rest/api/3/changelog/bulkfetch
const CHANGELOG = {
  issueChangeLogs: [
    {
      issueId: '10002',
      changeHistories: [
        {
          id: '1',
          created: '2026-10-03T12:00:00.000+0000',
          items: [
            { field: 'Sprint', fieldId: 'customfield_10020', from: '41', to: '41, 42' },
          ],
        },
      ],
    },
    {
      issueId: '10003',
      changeHistories: [
        {
          // Before the start: part of the commitment.
          id: '2',
          created: '2026-09-30T12:00:00.000+0000',
          items: [{ field: 'Sprint', fieldId: 'customfield_10020', from: '', to: '42' }],
        },
      ],
    },
  ],
};

function fullFake(): ReturnType<typeof createFakeJiraRequest> {
  return createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(ISSUES_PAGE))
    .on(SPRINT_ROUTE, jiraOk(SPRINT))
    .on(BOARD_CONFIG_ROUTE, jiraOk(BOARD_CONFIG))
    .on(FIELDS_ROUTE, jiraOk(FIELDS))
    .on(CHANGELOG_ROUTE, jiraOk(CHANGELOG));
}

test('[CC-1574] the summary counts, sums and finds the issue added after the start', async () => {
  const fake = fullFake();
  const result = await sprintSummaryTool.handler({ sprintId: 42 }, createCtx(fake.fn));
  const data = dataOf(result);

  assert.equal(result._untrusted, true);
  assert.equal(data.boardId, 17);
  assert.equal(data.estimationField, 'customfield_10016');
  assert.deepEqual(data.issues, {
    total: 4,
    done: 2,
    inProgress: 1,
    toDo: 1,
    unknown: 0,
  });
  assert.deepEqual(data.estimates, {
    total: 10.1,
    done: 3,
    inProgress: 5,
    toDo: 2.1,
    unknown: 0,
    unestimated: 1,
  });
  assert.deepEqual(data.completion, { issues: 0.5, estimate: 0.297 });
  assert.deepEqual(data.scopeChanges, {
    checked: true,
    added: [{ key: 'SAN-2', addedAt: '2026-10-03T12:00:00.000+0000' }],
  });
  assert.deepEqual(data.committed, { issues: 3, estimate: 5.1 });
  assert.equal(data.partial, false);
  assert.equal(
    data.rows.find((row) => row.key === 'SAN-2')?.addedAt,
    '2026-10-03T12:00:00.000+0000',
  );
  assert.equal(data.rows.find((row) => row.key === 'SAN-4')?.estimate, undefined);

  // The changelog asks only for the Sprint field, for every issue of the sprint.
  const bulk = fake.calls.find((call) => call.method === 'POST');
  assert.deepEqual(bulk?.body, {
    issueIdsOrKeys: ['SAN-1', 'SAN-2', 'SAN-3', 'SAN-4'],
    fieldIds: ['customfield_10020'],
    maxResults: 1000,
  });
  const issuesCall = fake.calls.find((call) => call.path.endsWith('/sprint/42/issue'));
  assert.match(JSON.stringify(issuesCall?.query), /customfield_10016/);
});

test('[CC-1575] a future sprint and scopeChanges:false skip the changelog reads', async () => {
  const future = createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(ISSUES_PAGE))
    .on(
      SPRINT_ROUTE,
      jiraOk({ id: 42, state: 'future', name: 'Next', originBoardId: 17 }),
    )
    .on(BOARD_CONFIG_ROUTE, jiraOk(BOARD_CONFIG));
  const planned = dataOf(
    await sprintSummaryTool.handler({ sprintId: 42 }, createCtx(future.fn)),
  );
  assert.equal(planned.scopeChanges.checked, false);
  assert.match(planned.scopeChanges.reason ?? '', /not started/);
  assert.equal(planned.committed, undefined);

  const skipped = createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(ISSUES_PAGE))
    .on(SPRINT_ROUTE, jiraOk(SPRINT))
    .on(BOARD_CONFIG_ROUTE, jiraOk(BOARD_CONFIG));
  const data = dataOf(
    await sprintSummaryTool.handler(
      { sprintId: 42, scopeChanges: false },
      createCtx(skipped.fn),
    ),
  );
  assert.deepEqual(data.scopeChanges, {
    checked: false,
    reason: 'scopeChanges was false.',
  });
  assert.equal(
    skipped.calls.some((call) => call.method === 'POST' || call.path.endsWith('/field')),
    false,
  );
});

test('[CC-1576] a board without a field estimate counts issues only; no board says so', async () => {
  const counted = createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(ISSUES_PAGE))
    .on(SPRINT_ROUTE, jiraOk(SPRINT))
    .on(
      BOARD_CONFIG_ROUTE,
      jiraOk({ ...BOARD_CONFIG, estimation: { type: 'issueCount' } }),
    );
  const data = dataOf(
    await sprintSummaryTool.handler(
      { sprintId: 42, scopeChanges: false },
      createCtx(counted.fn),
    ),
  );
  assert.equal(data.estimationField, undefined);
  assert.equal(data.estimates, undefined);
  assert.deepEqual(data.completion, { issues: 0.5 });
  assert.ok(data.notes.some((note) => /counted only/.test(note)));

  const boardless = createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(ISSUES_PAGE))
    .on(SPRINT_ROUTE, jiraOk({ ...SPRINT, originBoardId: undefined }));
  const orphan = dataOf(
    await sprintSummaryTool.handler(
      { sprintId: 42, scopeChanges: false },
      createCtx(boardless.fn),
    ),
  );
  assert.equal(orphan.boardId, undefined);
  assert.ok(orphan.notes.some((note) => /Pass boardId/.test(note)));
});

test('[CC-1577][CC-5002] a sprint larger than the issue cap is partial and says how far it got', async () => {
  // Cloud reports no total on this root (D501), so the note cannot name one.
  const page = { issues: ISSUES_PAGE.issues, nextPageToken: 'tok-2' };
  const fake = createFakeJiraRequest()
    .on(SPRINT_ISSUES_ROUTE, jiraOk(page))
    .on(SPRINT_ROUTE, jiraOk(SPRINT))
    .on(BOARD_CONFIG_ROUTE, jiraOk(BOARD_CONFIG));
  const ctx = { ...createCtx(fake.fn), limits: { maxResultChars: 100_000, maxPages: 1 } };
  const data = dataOf(
    await sprintSummaryTool.handler({ sprintId: 42, scopeChanges: false }, ctx),
  );
  assert.equal(data.partial, true);
  assert.ok(
    data.notes.some((note) =>
      /INCOMPLETE: only the first 4 issues were summarised \(Jira reports no total/.test(
        note,
      ),
    ),
  );
  assert.equal(data.committed, undefined);
});

test('[CC-1578] the pure helpers: categories, sprint ids, the add test and the totals', () => {
  assert.equal(categoryOf({ statusCategory: { key: 'done' } }), 'done');
  assert.equal(categoryOf({ statusCategory: { key: 'weird' } }), 'unknown');
  assert.equal(categoryOf(undefined), 'unknown');
  assert.deepEqual(sprintIdsOf('41, 42,'), ['41', '42']);
  assert.deepEqual(sprintIdsOf(null), []);

  const startMs = Date.parse(START);
  const ids = new Set(['customfield_10020']);
  const joined = { field: 'Sprint', from: '', to: '42' };
  // Joined, left, came back: the return counts. A move between other sprints does not.
  assert.equal(
    addedAfterStart(
      [
        { created: '2026-10-02T00:00:00.000Z', items: [joined] },
        {
          created: '2026-10-03T00:00:00.000Z',
          items: [{ field: 'Sprint', from: '42', to: '' }],
        },
        { created: '2026-10-04T00:00:00.000Z', items: [joined] },
        {
          created: '2026-10-05T00:00:00.000Z',
          items: [{ field: 'Sprint', from: '1', to: '2' }],
        },
      ],
      42,
      startMs,
      ids,
    ),
    '2026-10-04T00:00:00.000Z',
  );
  // Staying in the sprint while another is added is not an addition.
  assert.equal(
    addedAfterStart(
      [
        {
          created: '2026-10-02T00:00:00.000Z',
          items: [{ fieldId: 'customfield_10020', from: '42', to: '42, 43' }],
        },
      ],
      42,
      startMs,
      ids,
    ),
    undefined,
  );
  // Before the start, undated, or another field: never an addition.
  assert.equal(
    addedAfterStart(
      [
        { created: '2026-09-01T00:00:00.000Z', items: [joined] },
        { items: [joined] },
        {
          created: '2026-10-02T00:00:00.000Z',
          items: [{ field: 'status', from: '', to: '42' }],
        },
      ],
      42,
      startMs,
      ids,
    ),
    undefined,
  );

  assert.deepEqual(totalsOf([], true).completion, { issues: 0, estimate: 0 });
});

test('[CC-1579] jira_sprint_summary is a read in the agile package and Cloud-only', () => {
  assert.ok(agilePackage.tools.includes(sprintSummaryTool));
  assert.equal(sprintSummaryTool.annotations.readOnlyHint, true);
  assert.equal(sprintSummaryTool.package, 'agile');
});
