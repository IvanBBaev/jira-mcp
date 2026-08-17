// Tests for api/meta.ts — the discovery reads (WP-22).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives the module
// through `fakeJiraRequest`, so no socket is involved and the assertions are
// about what this ring promises — the request it builds, the shape it narrows
// the response into, and the pagination metadata it passes out untouched.
//
// Bodies are inline plain objects marked `// synthetic`, copied field-for-field
// from real Jira Cloud v3 responses and JIRA-API.md. They are inline rather than
// loaded from `test/fixtures/` because that corpus holds only the two responses
// that cannot be triggered live; the recorded majority waits on the scratch site
// (WP-41), and `core/fakes/fakeJiraRequest.ts` documents the inline path as the
// sanctioned interim. The placeholder vocabulary is the one the fixture PII lint
// (`src/testing/fixture-pii.ts`) enforces on the corpus that does exist:
// `example.atlassian.net`, `5b10a2844c20165700ede21g`-style accountIds.
//
// The fake throws on a route nobody programmed, so a loop that runs one page too
// far surfaces as "unexpected request" instead of a quietly wrong item count.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import {
  DEFAULT_PROJECT_DETAIL_EXPAND,
  DEFAULT_PROJECT_EXPAND,
  filterFields,
  getCreateMeta,
  getProject,
  listCreateMetaIssueTypes,
  listFields,
  listLinkTypes,
  listProjects,
  listStatuses,
} from './meta.js';

const SITE = 'https://example.atlassian.net';

/**
 * Index into a mapped list. `noUncheckedIndexedAccess` makes `items[0]` a
 * `T | undefined`, and a test that silently reads `undefined` proves nothing.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${String(item)}`);
  }
  return item;
}

function isJiraError(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

// --- project search bodies -------------------------------------------------

/** One `/project/search` row. // synthetic */
function projectRow(index: number): Record<string, unknown> {
  const id = String(10000 + index);
  return {
    self: `${SITE}/rest/api/3/project/${id}`,
    id,
    key: `PR${index}`,
    name: `Project ${index}`,
    projectTypeKey: 'software',
    simplified: false,
    style: 'classic',
    isPrivate: false,
    // Present only because the loop expands `lead`.
    lead: {
      self: `${SITE}/rest/api/3/user?accountId=5b10a2844c20165700ede21g`,
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'User One',
      active: true,
    },
    // An extra key the guards must tolerate rather than choke on.
    avatarUrls: { '48x48': `${SITE}/secure/projectavatar?size=large&pid=${id}` },
  };
}

/** One `/project/search` page (classic PageBean). // synthetic */
function projectPage(
  startAt: number,
  indexes: readonly number[],
  isLast: boolean,
): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/project/search?startAt=${startAt}&maxResults=2`,
    maxResults: 2,
    startAt,
    // Deliberately ahead of the offset in every page below, so `isLast` is the
    // only thing that can end the loop.
    total: 10,
    isLast,
    values: indexes.map(projectRow),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('listProjects walks classic pages until the server says isLast', async () => {
  const jira = createFakeJiraRequest();
  jira
    .enqueue(jiraOk(projectPage(0, [1, 2], false)))
    .enqueue(jiraOk(projectPage(2, [3, 4], false)))
    .enqueue(jiraOk(projectPage(4, [5, 6], true)));

  const result = await listProjects({ jira: jira.fn, pageSize: 2 });

  assert.equal(result.pages, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextStartAt, undefined);
  assert.equal(result.total, 10);
  assert.deepEqual(
    result.items.map((project) => project.key),
    ['PR1', 'PR2', 'PR3', 'PR4', 'PR5', 'PR6'],
  );
  assert.deepEqual(
    jira.calls.map((call) => call.query?.startAt),
    [0, 2, 4],
  );
  assert.deepEqual(jira.routes(), [
    'GET /rest/api/3/project/search',
    'GET /rest/api/3/project/search',
    'GET /rest/api/3/project/search',
  ]);
  // `/project/search` is a constant route, so it carries no pathTemplate.
  assert.equal(jira.calls[0]?.pathTemplate, undefined);
  assert.equal(jira.calls[0]?.query?.expand, DEFAULT_PROJECT_EXPAND);
  assert.deepEqual(at(result.items, 0), {
    id: '10001',
    key: 'PR1',
    name: 'Project 1',
    projectTypeKey: 'software',
    style: 'classic',
    simplified: false,
    isPrivate: false,
    lead: {
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'User One',
      active: true,
    },
  });
});

test('listProjects reports a max_pages stop as a partial prefix', async () => {
  const jira = createFakeJiraRequest();
  jira
    .enqueue(jiraOk(projectPage(0, [1, 2], false)))
    .enqueue(jiraOk(projectPage(2, [3, 4], false)));

  const result = await listProjects({ jira: jira.fn, pageSize: 2, maxPages: 2 });

  // A third request would throw "unexpected request" — the cap is what stopped it.
  assert.equal(jira.calls.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextStartAt, 4);
  assert.equal(result.total, 10);
  assert.equal(result.items.length, 4);
});

test('listProjects forwards the server-side filters and omits blank ones', async () => {
  const jira = createFakeJiraRequest();
  jira.enqueue(jiraOk(projectPage(0, [1], true)));

  await listProjects({
    jira: jira.fn,
    pageSize: 2,
    query: '  alpha  ',
    typeKey: 'software',
    orderBy: '-lastIssueUpdatedTime',
    expand: 'lead,description',
  });

  const query = jira.lastRequest()?.query;
  assert.equal(query?.query, 'alpha');
  assert.equal(query?.typeKey, 'software');
  assert.equal(query?.orderBy, '-lastIssueUpdatedTime');
  assert.equal(query?.expand, 'lead,description');
  assert.equal(query?.maxResults, 2);

  jira.reset();
  jira.enqueue(jiraOk(projectPage(0, [1], true)));
  await listProjects({ jira: jira.fn, pageSize: 2, query: '   ' });
  assert.equal(jira.lastRequest()?.query?.query, undefined);
});

test('getProject reads the detail expands, components and versions', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/project/ABC?expand=description,lead,issueTypes
  jira.on(
    'GET /rest/api/3/project/ABC',
    jiraOk({
      self: `${SITE}/rest/api/3/project/10000`,
      id: '10000',
      key: 'ABC',
      name: 'Alpha',
      description: 'The alpha delivery board.',
      projectTypeKey: 'software',
      simplified: false,
      style: 'classic',
      isPrivate: false,
      lead: {
        self: `${SITE}/rest/api/3/user?accountId=5b10a2844c20165700ede21g`,
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'User One',
        active: true,
      },
      issueTypes: [
        {
          self: `${SITE}/rest/api/3/issuetype/10001`,
          id: '10001',
          name: 'Task',
          description: 'A small, distinct piece of work.',
          subtask: false,
          hierarchyLevel: 0,
        },
        {
          self: `${SITE}/rest/api/3/issuetype/10003`,
          id: '10003',
          name: 'Sub-task',
          subtask: true,
          hierarchyLevel: -1,
        },
      ],
      components: [
        { self: `${SITE}/rest/api/3/component/10100`, id: '10100', name: 'api' },
      ],
      versions: [
        {
          self: `${SITE}/rest/api/3/version/10200`,
          id: '10200',
          name: '1.0',
          archived: false,
          released: true,
          releaseDate: '2026-01-15',
        },
      ],
    }),
  );

  const project = await getProject({ jira: jira.fn, project: 'ABC' });

  assert.equal(jira.lastRequest()?.path, '/project/ABC');
  // OBSERVABILITY.md: a concrete key must never reach a log event.
  assert.equal(jira.lastRequest()?.pathTemplate, '/project/{projectIdOrKey}');
  assert.equal(jira.lastRequest()?.query?.expand, DEFAULT_PROJECT_DETAIL_EXPAND);
  assert.equal(project.key, 'ABC');
  assert.equal(project.description, 'The alpha delivery board.');
  assert.equal(project.lead?.accountId, '5b10a2844c20165700ede21g');
  assert.deepEqual(
    (project.issueTypes ?? []).map((type) => type.name),
    ['Task', 'Sub-task'],
  );
  assert.equal(at(project.issueTypes ?? [], 1).hierarchyLevel, -1);
  assert.deepEqual(at(project.components ?? [], 0), { id: '10100', name: 'api' });
  assert.equal(at(project.versions ?? [], 0).releaseDate, '2026-01-15');
});

test('getProject validates the path segment: trims, rejects blank and traversal keys', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/project/', jiraOk({ id: '10000', key: 'ABC', name: 'Alpha' }));

  // Surrounding whitespace is a caller slip, not part of the key.
  await getProject({ jira: jira.fn, project: '  ABC ' });
  assert.equal(jira.lastRequest()?.path, '/project/ABC');

  // Blank, embedded-whitespace and traversal keys are rejected outright —
  // encodeSegment REJECTS what percent-encoding would merely smuggle through
  // (no Jira project key or id contains a space or a dot segment).
  for (const bad of ['   ', 'A B', '..']) {
    await assert.rejects(
      () => getProject({ jira: jira.fn, project: bad }),
      isJiraError('validation'),
    );
  }
  // None of the rejected keys ever reached the wire.
  assert.equal(jira.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** `GET /rest/api/3/field` — a bare, UNPAGINATED array. // synthetic */
const FIELD_LIST: readonly unknown[] = [
  {
    id: 'summary',
    key: 'summary',
    name: 'Summary',
    custom: false,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ['summary'],
    schema: { type: 'string', system: 'summary' },
  },
  {
    id: 'customfield_10014',
    key: 'customfield_10014',
    name: 'Epic Link',
    untranslatedName: 'Epic Link',
    custom: true,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ['cf[10014]', 'Epic Link'],
    schema: {
      type: 'any',
      custom: 'com.pyxis.greenhopper.jira:gh-epic-link',
      customId: 10014,
    },
  },
  {
    id: 'customfield_10016',
    key: 'customfield_10016',
    name: 'Story Points',
    custom: true,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ['cf[10016]', 'Story Points'],
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      customId: 10016,
    },
  },
  {
    id: 'customfield_10038',
    key: 'customfield_10038',
    name: 'Story Points',
    custom: true,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ['cf[10038]', 'Story Points'],
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      customId: 10038,
    },
  },
];

test('listFields indexes the catalog by name and by id', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk(FIELD_LIST));

  const catalog = await listFields({ jira: jira.fn });

  assert.equal(jira.lastRequest()?.path, '/field');
  assert.equal(jira.calls.length, 1, 'GET /field is not paginated');
  assert.equal(catalog.fields.length, 4);
  assert.deepEqual(
    catalog.custom.map((field) => field.id),
    ['customfield_10014', 'customfield_10016', 'customfield_10038'],
  );
  assert.deepEqual(at(catalog.fields, 1), {
    id: 'customfield_10014',
    key: 'customfield_10014',
    name: 'Epic Link',
    custom: true,
    schemaType: 'any',
    customType: 'com.pyxis.greenhopper.jira:gh-epic-link',
    customId: 10014,
    clauseNames: ['cf[10014]', 'Epic Link'],
    searchable: true,
    orderable: true,
    navigable: true,
  });
  assert.equal(catalog.nameById.get('customfield_10014'), 'Epic Link');
  assert.equal(catalog.nameById.get('summary'), 'Summary');
  assert.deepEqual(catalog.idsByName.get('epic link'), ['customfield_10014']);
  // Two apps, one name: both ids survive so a caller asks instead of guessing.
  assert.deepEqual(catalog.idsByName.get('story points'), [
    'customfield_10016',
    'customfield_10038',
  ]);
});

test('filterFields matches name and id, case-insensitively', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk(FIELD_LIST));
  const catalog = await listFields({ jira: jira.fn });

  assert.deepEqual(
    filterFields(catalog.fields, 'STORY points').map((field) => field.id),
    ['customfield_10016', 'customfield_10038'],
  );
  assert.deepEqual(
    filterFields(catalog.fields, '10014').map((field) => field.id),
    ['customfield_10014'],
  );
  assert.equal(filterFields(catalog.fields, '  ').length, 4);
  assert.equal(filterFields(catalog.fields, undefined).length, 4);
});

// ---------------------------------------------------------------------------
// Create metadata
// ---------------------------------------------------------------------------

test('listCreateMetaIssueTypes reads the issueTypes collection', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/issue/createmeta/ABC/issuetypes
  jira.on(
    'GET /rest/api/3/issue/createmeta/ABC/issuetypes',
    jiraOk({
      maxResults: 50,
      startAt: 0,
      total: 2,
      issueTypes: [
        {
          self: `${SITE}/rest/api/3/issuetype/10001`,
          id: '10001',
          description: 'A small, distinct piece of work.',
          iconUrl: `${SITE}/rest/api/2/universal_avatar/view/type/issuetype/avatar/10318`,
          name: 'Task',
          untranslatedName: 'Task',
          subtask: false,
          hierarchyLevel: 0,
        },
        {
          self: `${SITE}/rest/api/3/issuetype/10003`,
          id: '10003',
          description: 'A small piece of a larger task.',
          name: 'Sub-task',
          subtask: true,
          hierarchyLevel: -1,
        },
      ],
    }),
  );

  const result = await listCreateMetaIssueTypes({ jira: jira.fn, project: 'ABC' });

  assert.equal(jira.lastRequest()?.path, '/issue/createmeta/ABC/issuetypes');
  assert.equal(
    jira.lastRequest()?.pathTemplate,
    '/issue/createmeta/{projectIdOrKey}/issuetypes',
  );
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.pages, 1);
  assert.deepEqual(
    result.items.map((type) => `${type.id}:${type.name}`),
    ['10001:Task', '10003:Sub-task'],
  );
  assert.equal(at(result.items, 1).subtask, true);
});

test('getCreateMeta returns one create screen with its required subset', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/issue/createmeta/ABC/issuetypes/10001
  jira.on(
    'GET /rest/api/3/issue/createmeta/ABC/issuetypes/10001',
    jiraOk({
      maxResults: 50,
      startAt: 0,
      total: 4,
      fields: [
        {
          required: true,
          schema: { type: 'string', system: 'summary' },
          name: 'Summary',
          key: 'summary',
          fieldId: 'summary',
          hasDefaultValue: false,
          operations: ['set'],
        },
        {
          required: true,
          schema: { type: 'issuetype', system: 'issuetype' },
          name: 'Issue Type',
          key: 'issuetype',
          fieldId: 'issuetype',
          hasDefaultValue: false,
          operations: [],
          allowedValues: [
            {
              self: `${SITE}/rest/api/3/issuetype/10001`,
              id: '10001',
              name: 'Task',
              subtask: false,
            },
          ],
        },
        {
          required: false,
          schema: { type: 'user', system: 'assignee' },
          name: 'Assignee',
          key: 'assignee',
          fieldId: 'assignee',
          hasDefaultValue: false,
          operations: ['set'],
          autoCompleteUrl: `${SITE}/rest/api/3/user/assignable/search?project=ABC&query=`,
        },
        {
          required: false,
          schema: {
            type: 'number',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
            customId: 10016,
          },
          name: 'Story Points',
          key: 'customfield_10016',
          fieldId: 'customfield_10016',
          hasDefaultValue: false,
          operations: ['set'],
        },
      ],
    }),
  );

  const meta = await getCreateMeta({
    jira: jira.fn,
    project: 'ABC',
    issueTypeId: '10001',
  });

  assert.equal(jira.lastRequest()?.path, '/issue/createmeta/ABC/issuetypes/10001');
  assert.equal(
    jira.lastRequest()?.pathTemplate,
    '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
  );
  assert.equal(meta.project, 'ABC');
  assert.equal(meta.issueTypeId, '10001');
  assert.equal(meta.stopReason, 'exhausted');
  assert.equal(meta.partial, false);
  assert.deepEqual(
    meta.items.map((field) => field.fieldId),
    ['summary', 'issuetype', 'assignee', 'customfield_10016'],
  );
  assert.deepEqual(
    meta.required.map((field) => field.fieldId),
    ['summary', 'issuetype'],
  );
  assert.deepEqual(at(meta.items, 1).allowedValues, [{ id: '10001', name: 'Task' }]);
  assert.equal(
    at(meta.items, 2).autoCompleteUrl,
    `${SITE}/rest/api/3/user/assignable/search?project=ABC&query=`,
  );
  assert.equal(at(meta.items, 2).allowedValues, undefined);
  assert.equal(
    at(meta.items, 3).customType,
    'com.atlassian.jira.plugin.system.customfieldtypes:float',
  );
  assert.deepEqual(at(meta.items, 3).operations, ['set']);
});

// ---------------------------------------------------------------------------
// Statuses and link types
// ---------------------------------------------------------------------------

test('listStatuses maps the flat statusCategory and the project scope', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/statuses/search
  jira.on(
    'GET /rest/api/3/statuses/search',
    jiraOk({
      maxResults: 200,
      startAt: 0,
      total: 2,
      isLast: true,
      values: [
        {
          id: '10000',
          name: 'To Do',
          statusCategory: 'TODO',
          scope: { type: 'PROJECT', project: { id: '10000' } },
          description: '',
          usages: [],
        },
        {
          id: '3',
          name: 'In Progress',
          description: 'This issue is being actively worked on.',
          statusCategory: 'IN_PROGRESS',
          scope: { type: 'GLOBAL' },
          usages: [],
        },
      ],
    }),
  );

  const result = await listStatuses({
    jira: jira.fn,
    projectId: '10000',
    searchString: 'to',
    statusCategory: 'TODO',
  });

  const query = jira.lastRequest()?.query;
  assert.equal(query?.projectId, '10000');
  assert.equal(query?.searchString, 'to');
  assert.equal(query?.statusCategory, 'TODO');
  assert.equal(query?.expand, undefined);
  assert.equal(result.stopReason, 'exhausted');
  // A bare string here, not the nested object an issue's `status` field carries.
  assert.deepEqual(at(result.items, 0), {
    id: '10000',
    name: 'To Do',
    statusCategory: 'TODO',
    scopeType: 'PROJECT',
    scopeProjectId: '10000',
  });
  assert.deepEqual(at(result.items, 1), {
    id: '3',
    name: 'In Progress',
    description: 'This issue is being actively worked on.',
    statusCategory: 'IN_PROGRESS',
    scopeType: 'GLOBAL',
  });
});

test('listLinkTypes unwraps the issueLinkTypes array', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/issueLinkType
  jira.on(
    'GET /rest/api/3/issueLinkType',
    jiraOk({
      issueLinkTypes: [
        {
          id: '10000',
          name: 'Blocks',
          inward: 'is blocked by',
          outward: 'blocks',
          self: `${SITE}/rest/api/3/issueLinkType/10000`,
        },
        {
          id: '10001',
          name: 'Cloners',
          inward: 'is cloned by',
          outward: 'clones',
          self: `${SITE}/rest/api/3/issueLinkType/10001`,
        },
      ],
    }),
  );

  const types = await listLinkTypes({ jira: jira.fn });

  assert.equal(jira.lastRequest()?.path, '/issueLinkType');
  assert.deepEqual(types, [
    { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '10001', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
  ]);
});

// ---------------------------------------------------------------------------
// Error propagation and budget plumbing
// ---------------------------------------------------------------------------

test('a 403 travels out of a meta read untouched', async () => {
  const jira = createFakeJiraRequest();
  const denied = new JiraError({
    kind: 'permission',
    httpStatus: 403,
    message:
      'Jira refused the request: the account may not browse this project. ' +
      'Ask a site admin for the Browse Projects permission.',
    jiraMessages: ['You do not have permission to view this project.'],
    remediation: 'Request Browse Projects on the project, then re-run.',
  });
  jira.on('GET /rest/api/3/project/SECRET', jiraErr(denied));

  await assert.rejects(
    () => getProject({ jira: jira.fn, project: 'SECRET' }),
    // Identity, not just kind: this ring adds no fallback, no re-wrap, no
    // empty-project-on-failure.
    (error: unknown) => error === denied,
  );
});

test('a mid-loop failure is not downgraded to a partial result', async () => {
  const jira = createFakeJiraRequest();
  const denied = new JiraError({
    kind: 'permission',
    httpStatus: 403,
    message: 'Jira refused the request while paging project search.',
  });
  jira.enqueue(jiraOk(projectPage(0, [1, 2], false))).enqueue(jiraErr(denied));

  await assert.rejects(
    () => listProjects({ jira: jira.fn, pageSize: 2 }),
    (error: unknown) => error === denied,
  );
  assert.equal(jira.calls.length, 2);
});

test('the caller signal and deadline reach paged and single requests', async () => {
  const jira = createFakeJiraRequest();
  const clock = createFakeClock(1_000);
  const controller = new AbortController();
  jira.enqueue(jiraOk(projectPage(0, [1], true)));
  jira.on('GET /rest/api/3/project/ABC', jiraOk({ id: '10000', key: 'ABC', name: 'A' }));

  await listProjects({
    jira: jira.fn,
    pageSize: 2,
    clock,
    deadlineAt: 30_000,
    signal: controller.signal,
  });
  assert.equal(jira.lastRequest()?.deadlineAt, 30_000);
  assert.equal(jira.lastRequest()?.signal, controller.signal);

  await getProject({
    jira: jira.fn,
    project: 'ABC',
    clock,
    deadlineAt: 30_000,
    signal: controller.signal,
  });
  assert.equal(jira.lastRequest()?.deadlineAt, 30_000);
  assert.equal(jira.lastRequest()?.signal, controller.signal);
});

test('an expired budget stops a meta loop before the first request', async () => {
  const jira = createFakeJiraRequest();
  const clock = createFakeClock(10_000);

  const result = await listStatuses({ jira: jira.fn, clock, deadlineAt: 9_000 });

  assert.equal(jira.calls.length, 0);
  assert.equal(result.pages, 0);
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.partial, true);
  assert.deepEqual(result.items, []);
});

test('a response Jira should never send becomes unexpected_shape', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk({ fields: [] }));
  jira.on('GET /rest/api/3/issueLinkType', jiraOk({ values: [] }));
  jira.on('GET /rest/api/3/statuses/search', jiraOk({ maxResults: 200, startAt: 0 }));
  jira.on('GET /rest/api/3/project/search', jiraOk({ values: [{ key: 'ABC' }] }));

  await assert.rejects(
    () => listFields({ jira: jira.fn }),
    isJiraError('unexpected_shape'),
  );
  await assert.rejects(
    () => listLinkTypes({ jira: jira.fn }),
    isJiraError('unexpected_shape'),
  );
  await assert.rejects(
    () => listStatuses({ jira: jira.fn }),
    isJiraError('unexpected_shape'),
  );
  // A row missing a mandatory field fails too — a half-mapped project is worse
  // than a loud error, because the id it lacks is what a write would need.
  await assert.rejects(
    () => listProjects({ jira: jira.fn }),
    isJiraError('unexpected_shape'),
  );
});
