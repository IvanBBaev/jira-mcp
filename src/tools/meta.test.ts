// Tests for tools/meta.ts — the discovery tool package (WP-33).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives a real tool spec
// through `fakeJiraRequest`, so no socket is involved. The assertions are about
// what the TOOL ring promises on top of `api/meta.ts` — the annotation
// quadruple, the sealed input schema, and the exact shape of `data` a model
// receives. The api ring's own mapping is covered by `api/meta.test.ts`; the
// bodies here are the minimum needed to reach a tool-level decision.
//
// Bodies are inline plain objects marked `// synthetic`, using the placeholder
// vocabulary the fixture PII lint enforces (`example.atlassian.net`).
//
// Three properties carry the weight of this file:
//   * `jira_list_fields` never emits a raw Map — the whole envelope survives a
//     JSON round trip (a Map would arrive as `{}`);
//   * a PARTIAL create screen is never presented as complete;
//   * a page-cap stop is reported as paging metadata, never as `truncated`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import { errorResult } from '../mcp/errors.js';
import type { ToolCtx, ToolResult, ToolSpec } from '../mcp/types.js';
import {
  getCreateMetaTool,
  getProjectTool,
  listFieldsTool,
  listLinkTypesTool,
  listProjectsTool,
  listStatusesTool,
  metaPackage,
  PARTIAL_CREATE_SCREEN_WARNING,
} from './meta.js';

const SITE = 'https://example.atlassian.net';

/** TOOLS.md §Tool description budget. */
const MAX_DESCRIPTION_CHARS = 500;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A tool context with every seam faked. The deadline sits far past the fake
 * clock so `boundaryStop` never fires unasked — a budget stop that appeared by
 * accident would look exactly like the page-cap stop these tests assert.
 */
function createCtx(jira: FakeJiraRequest, maxPages = 20): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira: jira.fn,
    log: createFakeLogger({ cid: 'c-test01', clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 30_000, maxPages },
    deadlineAt: 9_000_000,
  };
}

/** Validate arguments the way the registry will, then run the handler. */
function run<In, Out>(
  spec: ToolSpec<In, Out>,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult<Out>> {
  return spec.handler(spec.input.parse(args), ctx);
}

/** Assert success and hand back `data`, which is optional on the envelope. */
function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
  const { data } = result;
  if (data === undefined) throw new Error('a successful envelope must carry data');
  return data;
}

/** The hint codes on an envelope, or `[]` when hints were (correctly) omitted. */
function hintCodes(result: ToolResult<unknown>): readonly string[] {
  return (result.hints ?? []).map((hint) => hint.code);
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Synthetic bodies
// ---------------------------------------------------------------------------

/** One `/project/search` page (classic PageBean). // synthetic */
function projectPage(startAt: number, keys: readonly string[], isLast: boolean) {
  return {
    maxResults: keys.length,
    startAt,
    // Kept ahead of every offset below, so `isLast` and the page cap are the
    // only things that can end the loop.
    total: 50,
    isLast,
    values: keys.map((key, index) => ({
      self: `${SITE}/rest/api/3/project/${String(10000 + index)}`,
      id: String(10000 + startAt + index),
      key,
      name: `Project ${key}`,
      projectTypeKey: 'software',
      isPrivate: false,
    })),
  };
}

/** `GET /rest/api/3/field` — a bare, UNPAGINATED array. // synthetic */
const FIELD_LIST: readonly unknown[] = [
  {
    id: 'summary',
    key: 'summary',
    name: 'Summary',
    custom: false,
    schema: { type: 'string', system: 'summary' },
  },
  {
    id: 'customfield_10016',
    key: 'customfield_10016',
    name: 'Story Points',
    custom: true,
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      customId: 10016,
    },
  },
  {
    // Same NAME, different id: two apps shipping "Story Points" is the case the
    // Map index exists for, and the case a model must not guess its way through.
    id: 'customfield_10038',
    key: 'customfield_10038',
    name: 'Story Points',
    custom: true,
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      customId: 10038,
    },
  },
];

/** One createmeta field. // synthetic */
function createMetaField(fieldId: string, required: boolean) {
  return {
    required,
    schema: { type: 'string', system: fieldId },
    name: fieldId,
    key: fieldId,
    fieldId,
    hasDefaultValue: false,
    operations: ['set'],
  };
}

/**
 * One `/issue/createmeta/{project}/issuetypes/{id}` page. A FULL page (`read`
 * equals the server's own `maxResults`) short of `total` is what keeps the loop
 * going, which is how the partial case below is reached.
 * // synthetic
 */
function createMetaPage(
  startAt: number,
  fields: readonly ReturnType<typeof createMetaField>[],
) {
  return { maxResults: fields.length, startAt, total: 50, fields };
}

// ---------------------------------------------------------------------------
// Package and spec shape
// ---------------------------------------------------------------------------

test('the package exposes the six meta tools in TOOLS.md order', () => {
  assert.equal(metaPackage.id, 'meta');
  assert.notEqual(metaPackage.title.trim(), '');
  assert.notEqual(metaPackage.description.trim(), '');
  assert.deepEqual(
    metaPackage.tools.map((tool) => tool.name),
    [
      'jira_list_projects',
      'jira_get_project',
      'jira_list_fields',
      'jira_get_create_meta',
      'jira_list_statuses',
      'jira_list_link_types',
    ],
  );
});

test('every meta tool is annotated as a read and declares no writeTier', () => {
  for (const tool of metaPackage.tools) {
    assert.deepEqual(
      tool.annotations,
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      `${tool.name} annotations`,
    );
    assert.equal(tool.writeTier, undefined, `${tool.name} must not declare a writeTier`);
    assert.equal(tool.package, 'meta');
    // `defineTool` freezes the spec, so a later mutation cannot smuggle a write
    // annotation past the import-time assertions.
    assert.equal(Object.isFrozen(tool), true, `${tool.name} must be frozen`);
  }
});

test('every description stays within the TOOLS.md budget', () => {
  for (const tool of metaPackage.tools) {
    assert.ok(
      tool.description.length <= MAX_DESCRIPTION_CHARS,
      `${tool.name} description is ${String(tool.description.length)} chars`,
    );
  }
});

test('every input schema is sealed and carries only the read control field', () => {
  const minimal: Readonly<Record<string, Record<string, unknown>>> = {
    jira_list_projects: {},
    jira_get_project: { project: 'ABC' },
    jira_list_fields: {},
    jira_get_create_meta: { project: 'ABC' },
    jira_list_statuses: {},
    jira_list_link_types: {},
  };

  for (const tool of metaPackage.tools) {
    const args = minimal[tool.name] ?? {};
    assert.equal(tool.input.safeParse(args).success, true, `${tool.name} minimal args`);
    // `profile` is auto-injected on every tool (TOOLS.md §Control fields).
    assert.equal(
      tool.input.safeParse({ ...args, profile: 'work' }).success,
      true,
      `${tool.name} must accept profile`,
    );
    // Unknown keys are REJECTED, never ignored — a typo'd argument must not be
    // silently dropped and then reported as a successful read.
    assert.equal(
      tool.input.safeParse({ ...args, bogus: 1 }).success,
      false,
      `${tool.name} must reject unknown keys`,
    );
    // A read tool must not declare the write-gate control fields.
    assert.equal(
      tool.input.safeParse({ ...args, apply: true }).success,
      false,
      `${tool.name} must not declare apply`,
    );
  }
});

// ---------------------------------------------------------------------------
// jira_list_projects
// ---------------------------------------------------------------------------

test('jira_list_projects returns the rows with exhausted paging', async () => {
  const jira = createFakeJiraRequest();
  jira.enqueue(jiraOk(projectPage(0, ['ABC'], true)));

  const result = await run(listProjectsTool, {}, createCtx(jira));
  const data = dataOf(result);

  assert.deepEqual(
    data.projects.map((project) => project.key),
    ['ABC'],
  );
  assert.equal(data.count, 1);
  assert.equal(data.paging.partial, false);
  assert.equal(data.paging.stopReason, 'exhausted');
  assert.equal(data.paging.pages, 1);
  assert.equal(data.paging.note, undefined);
  assert.equal(data.query, undefined);
  // A complete read carries no advisory at all — `hints: []` is never emitted.
  assert.equal(result.hints, undefined);
});

test('jira_list_projects forwards query to the server and echoes it back', async () => {
  const jira = createFakeJiraRequest();
  jira.enqueue(jiraOk(projectPage(0, ['ABC'], true)));

  const data = dataOf(await run(listProjectsTool, { query: 'alpha' }, createCtx(jira)));

  assert.equal(jira.lastRequest()?.query?.query, 'alpha');
  assert.equal(data.query, 'alpha');
});

test('a page-cap stop is paging metadata, NOT the truncated hint', async () => {
  const jira = createFakeJiraRequest();
  jira
    .enqueue(jiraOk(projectPage(0, ['AAA', 'BBB'], false)))
    .enqueue(jiraOk(projectPage(2, ['CCC', 'DDD'], false)));

  // A third request would throw "unexpected request" — the cap is what stopped it.
  const result = await run(listProjectsTool, {}, createCtx(jira, 2));
  const data = dataOf(result);

  assert.equal(jira.calls.length, 2);
  assert.equal(data.paging.partial, true);
  assert.equal(data.paging.stopReason, 'max_pages');
  assert.equal(data.paging.nextStartAt, 4);
  assert.equal(data.paging.total, 50);
  assert.match(data.paging.note ?? '', /INCOMPLETE/);
  assert.match(data.paging.note ?? '', /JIRA_MAX_PAGES/);
  // The catalog's `truncated` means "the result exceeded JIRA_MAX_RESULT_CHARS"
  // and tells the model NOT to page on. "More rows exist upstream" is the
  // opposite fact, and the character budget is owned by mcp/result.ts anyway.
  assert.deepEqual(hintCodes(result), []);
  assert.equal(result._truncation, undefined);
});

// ---------------------------------------------------------------------------
// jira_get_project
// ---------------------------------------------------------------------------

test('jira_get_project reads one project by key', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/project/ABC
  jira.on(
    'GET /rest/api/3/project/ABC',
    jiraOk({
      id: '10000',
      key: 'ABC',
      name: 'Alpha',
      description: 'The alpha delivery board.',
      projectTypeKey: 'software',
      issueTypes: [{ id: '10001', name: 'Task', subtask: false, hierarchyLevel: 0 }],
      components: [{ id: '10100', name: 'api' }],
      versions: [{ id: '10200', name: '1.0', released: true }],
    }),
  );

  const data = dataOf(await run(getProjectTool, { project: 'ABC' }, createCtx(jira)));

  assert.equal(jira.lastRequest()?.path, '/project/ABC');
  // OBSERVABILITY.md: a concrete key must never reach a log event.
  assert.equal(jira.lastRequest()?.pathTemplate, '/project/{projectIdOrKey}');
  assert.equal(jira.lastRequest()?.query?.expand, 'description,lead,issueTypes');
  assert.equal(data.project.key, 'ABC');
  assert.deepEqual(
    (data.project.issueTypes ?? []).map((type) => type.id),
    ['10001'],
  );
});

test('jira_get_project passes a caller expand through', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/project/ABC', jiraOk({ id: '10000', key: 'ABC', name: 'A' }));

  await run(getProjectTool, { project: 'ABC', expand: 'lead' }, createCtx(jira));

  assert.equal(jira.lastRequest()?.query?.expand, 'lead');
});

// ---------------------------------------------------------------------------
// jira_list_fields — the Map serialization guarantee
// ---------------------------------------------------------------------------

test('jira_list_fields reports the catalog counts and the ambiguous names', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk(FIELD_LIST));

  const result = await run(listFieldsTool, {}, createCtx(jira));
  const data = dataOf(result);

  assert.equal(data.count, 3);
  assert.equal(data.totalCount, 3);
  assert.equal(data.customCount, 2);
  assert.equal(data.query, undefined);
  // Only the AMBIGUOUS names, keyed lower-case exactly as the catalog keys them.
  assert.deepEqual(data.duplicateNames, [
    { name: 'story points', ids: ['customfield_10016', 'customfield_10038'] },
  ]);
  assert.equal(result.hints, undefined);
});

test('jira_list_fields filters by name or id, over the whole catalog', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk(FIELD_LIST));

  const data = dataOf(await run(listFieldsTool, { query: '10038' }, createCtx(jira)));

  assert.deepEqual(
    data.fields.map((field) => field.id),
    ['customfield_10038'],
  );
  assert.equal(data.count, 1);
  // The counts and the ambiguity index describe the CATALOG, not the slice —
  // a filtered listing that reported `totalCount: 1` would read as "there is
  // only one field on this site".
  assert.equal(data.totalCount, 3);
  assert.equal(data.duplicateNames.length, 1);
  assert.equal(data.query, '10038');
});

test('no Map reaches the envelope: jira_list_fields survives a JSON round trip', async () => {
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraOk(FIELD_LIST));

  const result = await run(listFieldsTool, {}, createCtx(jira));
  const data = dataOf(result);

  // The whole envelope is what the transport serializes, so that is what is
  // round-tripped here — `JSON.stringify(new Map(...))` is `{}`, so any Map that
  // leaked into `data` would come back as an empty object and fail this compare.
  const roundTripped: unknown = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTripped, result);

  const revived: unknown = JSON.parse(JSON.stringify(data));
  assert.deepEqual(revived, data);
  // Named explicitly, because the deep compare above would also pass if BOTH
  // sides were the empty object a Map serializes to.
  assert.equal(Array.isArray(data.duplicateNames), true);
  assert.equal(at(data.duplicateNames, 0).ids.length, 2);
  const json = JSON.stringify(data);
  assert.match(json, /"duplicateNames":\[\{"name":"story points"/);
  assert.doesNotMatch(json, /"idsByName"|"nameById"/);
});

// ---------------------------------------------------------------------------
// jira_get_create_meta
// ---------------------------------------------------------------------------

test('jira_get_create_meta without an issue type lists the choices', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/issue/createmeta/ABC/issuetypes
  jira.on(
    'GET /rest/api/3/issue/createmeta/ABC/issuetypes',
    jiraOk({
      maxResults: 50,
      startAt: 0,
      total: 2,
      issueTypes: [
        { id: '10001', name: 'Task', subtask: false, hierarchyLevel: 0 },
        { id: '10003', name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
      ],
    }),
  );

  const result = await run(getCreateMetaTool, { project: 'ABC' }, createCtx(jira));
  const data = dataOf(result);

  assert.equal(jira.lastRequest()?.path, '/issue/createmeta/ABC/issuetypes');
  assert.equal(data.step, 'choose_issue_type');
  if (data.step !== 'choose_issue_type') throw new Error('unreachable');
  assert.deepEqual(
    data.issueTypes.map((type) => type.id),
    ['10001', '10003'],
  );
  assert.equal(data.count, 2);
  assert.equal(data.paging.partial, false);
  // Instance-specific ids are exactly what the `discovery` hint exists for.
  assert.deepEqual(hintCodes(result), ['discovery']);
});

test('jira_get_create_meta returns a complete screen with its required subset', async () => {
  const jira = createFakeJiraRequest();
  jira.on(
    'GET /rest/api/3/issue/createmeta/ABC/issuetypes/10001',
    // synthetic — a short page ends the loop, so the screen is complete.
    jiraOk({
      maxResults: 50,
      startAt: 0,
      total: 3,
      fields: [
        createMetaField('summary', true),
        createMetaField('issuetype', true),
        createMetaField('assignee', false),
      ],
    }),
  );

  const result = await run(
    getCreateMetaTool,
    { project: 'ABC', issueTypeId: '10001' },
    createCtx(jira),
  );
  const data = dataOf(result);

  assert.equal(
    jira.lastRequest()?.pathTemplate,
    '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
  );
  assert.equal(data.step, 'create_screen');
  if (data.step !== 'create_screen' || !data.complete) {
    throw new Error('expected a complete create screen');
  }
  assert.equal(data.issueTypeId, '10001');
  assert.deepEqual(
    data.fields.map((field) => field.fieldId),
    ['summary', 'issuetype', 'assignee'],
  );
  assert.deepEqual(
    data.required.map((field) => field.fieldId),
    ['summary', 'issuetype'],
  );
  assert.equal(data.paging.partial, false);
  // A complete screen needs no caveat, so it carries none.
  assert.equal(result.hints, undefined);
  const json = JSON.stringify(data);
  assert.doesNotMatch(json, /SoFar/);
});

test('a PARTIAL create screen is never presented as the complete field list', async () => {
  const jira = createFakeJiraRequest();
  jira
    .enqueue(
      jiraOk(
        createMetaPage(0, [
          createMetaField('summary', true),
          createMetaField('a', false),
        ]),
      ),
    )
    .enqueue(
      jiraOk(
        createMetaPage(2, [createMetaField('b', false), createMetaField('c', true)]),
      ),
    );

  const result = await run(
    getCreateMetaTool,
    { project: 'ABC', issueTypeId: '10001' },
    createCtx(jira, 2),
  );
  const data = dataOf(result);

  assert.equal(jira.calls.length, 2);
  assert.equal(data.step, 'create_screen');
  if (data.step !== 'create_screen' || data.complete) {
    throw new Error('expected a partial create screen');
  }
  assert.equal(data.complete, false);
  assert.deepEqual(
    data.fieldsSoFar.map((field) => field.fieldId),
    ['summary', 'a', 'b', 'c'],
  );
  assert.deepEqual(
    data.requiredSoFar.map((field) => field.fieldId),
    ['summary', 'c'],
  );
  assert.equal(data.paging.partial, true);
  assert.equal(data.paging.stopReason, 'max_pages');

  // The MUST: nothing in this result may read as the full required list.
  const serialized = JSON.stringify(data);
  const record: unknown = JSON.parse(serialized);
  assert.equal(typeof record, 'object');
  assert.equal(Object.hasOwn(record as object, 'required'), false);
  assert.equal(Object.hasOwn(record as object, 'fields'), false);
  assert.match(serialized, /"complete":false/);
  assert.equal(data.warning, PARTIAL_CREATE_SCREEN_WARNING);
  assert.match(data.warning, /INCOMPLETE create screen/);
  assert.match(data.warning, /NOT the full set of required fields/);
  // Advisory too, so the caveat survives a reader who only skims `hints`.
  assert.deepEqual(hintCodes(result), ['discovery']);
  // And still not `truncated`: nothing exceeded the character budget.
  assert.equal(hintCodes(result).includes('truncated'), false);
});

// ---------------------------------------------------------------------------
// jira_list_statuses and jira_list_link_types
// ---------------------------------------------------------------------------

test('jira_list_statuses forwards projectId and echoes it back', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/statuses/search
  jira.on(
    'GET /rest/api/3/statuses/search',
    jiraOk({
      maxResults: 200,
      startAt: 0,
      total: 1,
      isLast: true,
      values: [
        {
          id: '10000',
          name: 'To Do',
          statusCategory: 'TODO',
          scope: { type: 'PROJECT', project: { id: '10000' } },
        },
      ],
    }),
  );

  const result = await run(listStatusesTool, { projectId: '10000' }, createCtx(jira));
  const data = dataOf(result);

  assert.equal(jira.lastRequest()?.query?.projectId, '10000');
  assert.equal(data.projectId, '10000');
  assert.deepEqual(at(data.statuses, 0), {
    id: '10000',
    name: 'To Do',
    statusCategory: 'TODO',
    scopeType: 'PROJECT',
    scopeProjectId: '10000',
  });
  assert.equal(data.count, 1);
  assert.equal(data.paging.stopReason, 'exhausted');
});

test('jira_list_link_types returns the inward/outward phrase pairs', async () => {
  const jira = createFakeJiraRequest();
  // synthetic — GET /rest/api/3/issueLinkType
  jira.on(
    'GET /rest/api/3/issueLinkType',
    jiraOk({
      issueLinkTypes: [
        { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      ],
    }),
  );

  const result = await run(listLinkTypesTool, {}, createCtx(jira));
  const data = dataOf(result);

  assert.equal(jira.lastRequest()?.path, '/issueLinkType');
  assert.equal(data.count, 1);
  assert.deepEqual(at(data.linkTypes, 0), {
    id: '10000',
    name: 'Blocks',
    inward: 'is blocked by',
    outward: 'blocks',
  });
  assert.equal(result.hints, undefined);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('a Jira failure becomes an ok:false envelope, never a raw throw', async () => {
  const jira = createFakeJiraRequest();
  jira.on(
    'GET /rest/api/3/project/SECRET',
    jiraErr(
      new JiraError({
        kind: 'permission',
        httpStatus: 403,
        message: 'Jira refused the request: the account may not browse this project.',
        remediation: 'Request Browse Projects on the project, then re-run.',
      }),
    ),
  );

  const result = await run(getProjectTool, { project: 'SECRET' }, createCtx(jira));

  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(result.error?.kind, 'permission');
  assert.match(result.error?.message ?? '', /may not browse/);
  assert.equal(
    result.error?.remediation,
    'Request Browse Projects on the project, then re-run.',
  );
});

test('a non-JiraError throw keeps travelling, and is contained one ring up', async () => {
  const bug = new Error('socket exploded');
  const jira = createFakeJiraRequest();
  jira.on('GET /rest/api/3/field', jiraErr(bug));

  // `guarded` (mcp/tool-helpers.ts) turns a `JiraError` into an envelope and
  // RE-THROWS everything else: a handler that swallowed an internal throw would
  // also swallow the rejection plan mode unwinds a captured write with.
  await assert.rejects(
    run(listFieldsTool, {}, createCtx(jira)),
    (error) => error === bug,
  );

  // Containment is `mcp/registry.ts`'s catch-all, which is what a model actually
  // meets. Asserted here on the same projection the registry uses, because a
  // stack trace is exactly the value that would smuggle a token into the
  // transcript and the raw message must not survive anywhere.
  const contained = errorResult(bug);
  assert.equal(contained.ok, false);
  assert.equal(contained.error?.kind, 'unexpected_shape');
  assert.doesNotMatch(JSON.stringify(contained), /socket exploded/);
});
