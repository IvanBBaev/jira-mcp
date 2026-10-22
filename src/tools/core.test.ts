// Tests for `tools/core.ts` (WP-30) — contract tier (TESTING.md §Mocking tiers).
//
// `api/users.ts` is already tested against Jira's wire shape, so nothing here
// re-asserts the `/myself` narrowing. What is asserted is what this ring owns:
// the annotation quadruple (`jira_capabilities` is the ONE tool with
// `openWorldHint: false`), the strict schemas, that `jira_capabilities` reaches
// no network at all, that the report is injected rather than invented, and that
// an account record is metadata — no untrusted brand, no email, no hints.
//
// Response bodies are inline plain objects shaped after real Jira Cloud v3
// payloads and marked `// synthetic`. The fake throws on a route nobody
// programmed, so "this handler made no request" is asserted by construction.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_API } from '../api/port.js';
import { errorFromResponse } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { UNEXPECTED_THROW_MESSAGE } from '../mcp/errors.js';
import { renderResult } from '../mcp/result.js';
import { TAINT_BEGIN } from '../mcp/taint.js';
import type { AnyToolSpec, Hint, ToolCtx, ToolResult } from '../mcp/types.js';
import {
  capabilitiesTool,
  corePackage,
  getMyPermissionsTool,
  getMyselfTool,
  type CapabilitiesInfo,
} from './core.js';

const MYSELF_ROUTE = 'GET /rest/api/3/myself';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

/** 2026-08-07T10:00:00.000Z — the instant every call in this file runs at. */
const NOW = Date.UTC(2026, 7, 7, 10, 0, 0);

/** `GET /myself` for a fully populated Atlassian account. // synthetic */
const MYSELF_BODY = {
  self: `https://example.atlassian.net/rest/api/3/user?accountId=${ACCOUNT_ID}`,
  accountId: ACCOUNT_ID,
  accountType: 'atlassian',
  emailAddress: 'user-1@example.invalid',
  displayName: 'User One',
  active: true,
  timeZone: 'Australia/Sydney',
  locale: 'en_US',
  avatarUrls: { '48x48': 'https://example.atlassian.net/avatar/48' },
};

/** The report the composition root (WP-40) would assemble. */
function infoOf(overrides: Partial<CapabilitiesInfo> = {}): CapabilitiesInfo {
  return {
    serverName: 'jira-mcp-ai',
    version: '0.0.0',
    site: 'example.atlassian.net',
    transport: 'stdio',
    writeMode: 'plan',
    activeProfile: 'default',
    profileLocked: false,
    packages: [
      {
        id: 'core',
        title: 'Core',
        description: 'Server self-description and credential check.',
        tools: [
          {
            name: 'jira_capabilities',
            title: 'Server capabilities',
            package: 'core',
            readOnly: true,
          },
        ],
      },
    ],
    limits: {
      maxResultChars: 40_000,
      maxPages: 20,
      metaCacheTtlS: 300,
      requestTimeoutMs: 30_000,
      callBudgetMs: 60_000,
    },
    journalEnabled: false,
    ...overrides,
  };
}

type FakeJira = ReturnType<typeof createFakeJiraRequest>;

/** The `ToolCtx` the registry would build, with the seams faked. */
function ctxOf(fake: FakeJira, maxResultChars = 100_000): ToolCtx {
  return {
    jira: fake.fn,
    api: CLOUD_API,
    log: createFakeLogger(),
    clock: createFakeClock(NOW),
    cid: 'c-4f9a01',
    limits: { maxResultChars, maxPages: 20 },
    deadlineAt: NOW + 30_000,
  };
}

/** Every hint code an envelope carries, in order. */
function hintCodes(result: ToolResult<unknown>): string[] {
  return (result.hints ?? []).map((hint: Hint) => hint.code);
}

const PACKAGE = corePackage(infoOf());
const ALL_TOOLS: readonly AnyToolSpec[] = PACKAGE.tools;

/** The smallest input each core tool's schema accepts. */
function minimalArgs(tool: AnyToolSpec): Record<string, unknown> {
  return tool.name === 'jira_get_my_permissions'
    ? { permissions: ['BROWSE_PROJECTS'] }
    : {};
}

// ---------------------------------------------------------------------------
// The package and its annotations
// ---------------------------------------------------------------------------

test('the core package exports exactly the three documented tools', () => {
  assert.equal(PACKAGE.id, 'core');
  assert.deepEqual(
    ALL_TOOLS.map((tool) => tool.name),
    ['jira_capabilities', 'jira_get_myself', 'jira_get_my_permissions'],
  );
  for (const tool of ALL_TOOLS) assert.equal(tool.package, 'core');
});

test('every core tool is read-only, idempotent and carries no write tier', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} destructiveHint`);
    assert.equal(tool.annotations.idempotentHint, true, `${tool.name} idempotentHint`);
    assert.equal(tool.writeTier, undefined, `${tool.name} must not be gated`);
  }
});

test('jira_capabilities is the local tool — openWorldHint is false there alone', () => {
  const capabilities = capabilitiesTool(infoOf());
  assert.equal(capabilities.annotations.openWorldHint, false);
  assert.equal(getMyselfTool.annotations.openWorldHint, true);
  assert.equal(getMyPermissionsTool.annotations.openWorldHint, true);
});

test('every core tool description stays inside the 500-character budget', () => {
  for (const tool of ALL_TOOLS) {
    assert.ok(
      tool.description.length <= 500,
      `${tool.name} description is ${tool.description.length} chars`,
    );
  }
});

test('every core input schema is strict — an unknown key is rejected, not ignored', () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(
      tool.input.safeParse({ ...minimalArgs(tool), bogus: 1 }).success,
      false,
      `${tool.name} accepted an unknown key`,
    );
  }
});

test('every core tool takes profile and refuses the write control fields', () => {
  for (const tool of ALL_TOOLS) {
    const minimal = minimalArgs(tool);
    assert.equal(
      tool.input.safeParse(minimal).success,
      true,
      `${tool.name} rejected its minimal input`,
    );
    assert.equal(
      tool.input.safeParse({ ...minimal, profile: 'agile' }).success,
      true,
      `${tool.name} rejected profile`,
    );
    // A read tool never declares the plan/apply pair — accepting `apply` would
    // let a model believe there is a gate to satisfy here.
    assert.equal(
      tool.input.safeParse({ ...minimal, apply: true }).success,
      false,
      `${tool.name} accepted apply`,
    );
    assert.equal(
      tool.input.safeParse({ ...minimal, plan_id: 'p-1' }).success,
      false,
      `${tool.name} accepted plan_id`,
    );
  }
});

// ---------------------------------------------------------------------------
// jira_capabilities
// ---------------------------------------------------------------------------

test('jira_capabilities answers from the injected report and calls no route', async () => {
  // No rule is programmed: the fake THROWS on any request, so a single call
  // would fail this test rather than quietly succeed.
  const fake = createFakeJiraRequest();
  const info = infoOf();

  const result = await capabilitiesTool(info).handler({}, ctxOf(fake));

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 0);
  assert.equal(result.data?.serverName, 'jira-mcp-ai');
  assert.equal(result.data?.site, 'example.atlassian.net');
  assert.equal(result.data?.writeMode, 'plan');
  assert.deepEqual(
    result.data?.packages.map((pkg) => pkg.id),
    ['core'],
  );
  assert.equal(result.data?.limits.maxResultChars, 40_000);
});

test('jira_capabilities carries no hints and is not untrusted content', async () => {
  const result = await capabilitiesTool(infoOf()).handler(
    {},
    ctxOf(createFakeJiraRequest()),
  );

  assert.deepEqual(hintCodes(result), []);
  assert.equal(result.hints, undefined);
  assert.equal(result._untrusted, undefined);
  const rendered = renderResult(result, { maxResultChars: 100_000 });
  assert.equal(rendered.text.includes(TAINT_BEGIN), false);
});

test('CC-29: jira_capabilities names the tools this configuration gated out', async () => {
  const info = infoOf({
    excludedTools: [
      { name: 'jira_create_issue', reason: 'package_disabled' },
      { name: 'jira_update_issue', reason: 'readonly' },
    ],
  });

  const result = await capabilitiesTool(info).handler({}, ctxOf(createFakeJiraRequest()));

  assert.deepEqual(result.data?.excludedTools, [
    { name: 'jira_create_issue', reason: 'package_disabled' },
    { name: 'jira_update_issue', reason: 'readonly' },
  ]);
});

test('CC-29: an empty exclusion list is omitted rather than reported as []', async () => {
  const result = await capabilitiesTool(infoOf({ excludedTools: [] })).handler(
    {},
    ctxOf(createFakeJiraRequest()),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.excludedTools, undefined);
  assert.equal('excludedTools' in (result.data ?? {}), false);
});

test('a thunk source is re-read on every call, so a late report is not stale', async () => {
  let writeMode: CapabilitiesInfo['writeMode'] = 'plan';
  const tool = capabilitiesTool(() => infoOf({ writeMode }));

  const first = await tool.handler({}, ctxOf(createFakeJiraRequest()));
  writeMode = 'apply';
  const second = await tool.handler({}, ctxOf(createFakeJiraRequest()));

  assert.equal(first.data?.writeMode, 'plan');
  assert.equal(second.data?.writeMode, 'apply');
});

test('D12: counters are reported when the root supplies them, and omitted otherwise', async () => {
  const withCounters = await capabilitiesTool(
    infoOf({
      counters: { requests: 7, retries: 2, rateLimitWaits: 1, errors: { auth: 1 } },
    }),
  ).handler({}, ctxOf(createFakeJiraRequest()));

  assert.deepEqual(withCounters.data?.counters, {
    requests: 7,
    retries: 2,
    rateLimitWaits: 1,
    errors: { auth: 1 },
  });

  // A report assembled without a Telemetry is still a valid report — the tool
  // stays total (D27 kept the field optional for exactly this reason).
  const without = await capabilitiesTool(infoOf()).handler(
    {},
    ctxOf(createFakeJiraRequest()),
  );
  assert.equal(without.ok, true);
  assert.equal(without.data?.counters, undefined);
});

test('D12: a thunk reports the counters as they are at call time, not at startup', async () => {
  let counters = { requests: 0, retries: 0, rateLimitWaits: 0, errors: {} };
  const tool = capabilitiesTool(() => infoOf({ counters }));

  const first = await tool.handler({}, ctxOf(createFakeJiraRequest()));
  counters = { requests: 3, retries: 1, rateLimitWaits: 1, errors: { rate_limited: 1 } };
  const second = await tool.handler({}, ctxOf(createFakeJiraRequest()));

  assert.equal(first.data?.counters?.requests, 0);
  assert.equal(second.data?.counters?.requests, 3);
  assert.deepEqual(second.data?.counters?.errors, { rate_limited: 1 });
});

test('a throwing capabilities source becomes an error envelope, not a rejection', async () => {
  const tool = capabilitiesTool(() => {
    throw new Error('registry not built yet');
  });

  const result = await tool.handler({}, ctxOf(createFakeJiraRequest()));

  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(result.error?.kind, 'unexpected_shape');
  // An internal throw is reported as a bug in this server, not echoed at the
  // model as if it were something the request could fix.
  assert.equal(result.error?.message, UNEXPECTED_THROW_MESSAGE);
});

test('the capabilities report structurally cannot carry a credential', async () => {
  const result = await capabilitiesTool(infoOf()).handler(
    {},
    ctxOf(createFakeJiraRequest()),
  );

  const serialized = JSON.stringify(result);
  for (const secret of ['apiToken', 'password', 'authorization', 'Bearer']) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// jira_get_myself
// ---------------------------------------------------------------------------

test('jira_get_myself reads /myself once and returns the narrowed account', async () => {
  const fake = createFakeJiraRequest().on(MYSELF_ROUTE, jiraOk(MYSELF_BODY));

  const result = await getMyselfTool.handler({}, ctxOf(fake));

  assert.equal(result.ok, true);
  assert.deepEqual(fake.routes(), [MYSELF_ROUTE]);
  assert.deepEqual(result.data, {
    accountId: ACCOUNT_ID,
    displayName: 'User One',
    active: true,
    accountType: 'atlassian',
    timeZone: 'Australia/Sydney',
    locale: 'en_US',
  });
});

test('jira_get_myself never returns the email address Jira sent', async () => {
  const fake = createFakeJiraRequest().on(MYSELF_ROUTE, jiraOk(MYSELF_BODY));

  const result = await getMyselfTool.handler({}, ctxOf(fake));

  assert.equal(JSON.stringify(result).includes('user-1@example.invalid'), false);
  // CC-19 belongs to jira_search_users: a tool that never offers an address has
  // no masking to report, so `email_hidden` would be noise here.
  assert.equal(hintCodes(result).includes('email_hidden'), false);
  assert.equal(result.hints, undefined);
});

test('jira_get_myself omits absent optional keys instead of emitting undefined', async () => {
  // A minimal account — Jira sends this for an app (bot) identity. // synthetic
  const fake = createFakeJiraRequest().on(
    MYSELF_ROUTE,
    jiraOk({ accountId: ACCOUNT_ID, accountType: 'app' }),
  );

  const result = await getMyselfTool.handler({}, ctxOf(fake));

  assert.deepEqual(result.data, { accountId: ACCOUNT_ID, accountType: 'app' });
  assert.equal(Object.keys(result.data ?? {}).includes('displayName'), false);

  // The bare minimum — an id and nothing else — is exactly one key out.
  const bare = createFakeJiraRequest().on(
    MYSELF_ROUTE,
    jiraOk({ accountId: ACCOUNT_ID }),
  );
  const minimal = await getMyselfTool.handler({}, ctxOf(bare));
  assert.deepEqual(minimal.data, { accountId: ACCOUNT_ID });
});

test('CC-35: an account record is metadata and is NOT branded untrusted', async () => {
  const fake = createFakeJiraRequest().on(MYSELF_ROUTE, jiraOk(MYSELF_BODY));

  const result = await getMyselfTool.handler({}, ctxOf(fake));
  const rendered = renderResult(result, { maxResultChars: 100_000 });

  assert.equal(result._untrusted, undefined);
  assert.equal(hintCodes(result).includes('untrusted_content'), false);
  assert.equal(rendered.text.includes(TAINT_BEGIN), false);
});

test('CC-17: a 401 reaches the model as an auth error, wording untouched', async () => {
  const unauthorized = errorFromResponse({
    status: 401,
    body: { errorMessages: ['Client must be authenticated to access this resource.'] },
    method: 'GET',
    pathTemplate: '/myself',
  });
  const fake = createFakeJiraRequest().on(MYSELF_ROUTE, jiraErr(unauthorized));

  const result = await getMyselfTool.handler({}, ctxOf(fake));

  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(result.error?.kind, 'auth');
  // The api/core layers own this wording; the tool ring knows strictly less.
  assert.equal(result.error?.message, unauthorized.message);
  assert.match(String(result.error?.remediation), /token/i);
});

test('a malformed /myself body fails loudly rather than returning a blank account', async () => {
  const fake = createFakeJiraRequest().on(
    MYSELF_ROUTE,
    jiraOk({ displayName: 'User One' }),
  );

  const result = await getMyselfTool.handler({}, ctxOf(fake));

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'unexpected_shape');
});

// ---------------------------------------------------------------------------
// jira_get_my_permissions (D122)
// ---------------------------------------------------------------------------

const PERMISSIONS_ROUTE = 'GET /rest/api/3/mypermissions';

/** One entry of `GET /mypermissions`, as Jira Cloud shapes it. // synthetic */
function permissionEntry(key: string, havePermission: boolean, type = 'PROJECT') {
  return {
    id: '10',
    key,
    name: key.toLowerCase().replaceAll('_', ' '),
    type,
    description: `Ability to ${key.toLowerCase().replaceAll('_', ' ')}.`,
    havePermission,
  };
}

test('jira_get_my_permissions reads /mypermissions once and returns one verdict per key', async () => {
  const fake = createFakeJiraRequest().on(
    PERMISSIONS_ROUTE,
    jiraOk({
      permissions: {
        BROWSE_PROJECTS: permissionEntry('BROWSE_PROJECTS', true),
        ADMINISTER: permissionEntry('ADMINISTER', false, 'GLOBAL'),
      },
    }),
  );

  const result = await getMyPermissionsTool.handler(
    { permissions: ['BROWSE_PROJECTS', 'ADMINISTER'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.routes(), [PERMISSIONS_ROUTE]);
  assert.deepEqual(fake.lastRequest()?.query, {
    permissions: 'BROWSE_PROJECTS,ADMINISTER',
  });
  assert.deepEqual(result.data, {
    context: 'global',
    permissions: [
      { key: 'BROWSE_PROJECTS', granted: true, name: 'browse projects', type: 'PROJECT' },
      { key: 'ADMINISTER', granted: false, name: 'administer', type: 'GLOBAL' },
    ],
  });
  // Verdicts are metadata, not Jira free text: no brand, no hints.
  assert.equal(result.hints, undefined);
  assert.equal(result._untrusted, undefined);
});

test('jira_get_my_permissions checks in a project and says so in the result', async () => {
  const fake = createFakeJiraRequest().on(
    PERMISSIONS_ROUTE,
    jiraOk({ permissions: { CREATE_ISSUES: permissionEntry('CREATE_ISSUES', true) } }),
  );

  const result = await getMyPermissionsTool.handler(
    { permissions: ['CREATE_ISSUES'], project: ' ABC ' },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.lastRequest()?.query, {
    permissions: 'CREATE_ISSUES',
    projectKey: 'ABC',
  });
  assert.equal(result.data?.context, 'project');
  assert.equal(result.data?.project, 'ABC');
  assert.equal(result.data?.issue, undefined);
});

test('[CC-1403] jira_get_my_permissions sends only the issue when both scopes are given', async () => {
  const fake = createFakeJiraRequest().on(
    PERMISSIONS_ROUTE,
    jiraOk({ permissions: { EDIT_ISSUES: permissionEntry('EDIT_ISSUES', false) } }),
  );

  const result = await getMyPermissionsTool.handler(
    { permissions: ['EDIT_ISSUES'], project: 'ABC', issue: 'ABC-7' },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  // The project is not sent alongside: Jira would evaluate the pair in its own
  // order, and the result must name the scope the verdict applies to.
  assert.deepEqual(fake.lastRequest()?.query, {
    permissions: 'EDIT_ISSUES',
    issueKey: 'ABC-7',
  });
  assert.deepEqual(result.data, {
    context: 'issue',
    issue: 'ABC-7',
    permissions: [
      { key: 'EDIT_ISSUES', granted: false, name: 'edit issues', type: 'PROJECT' },
    ],
  });
});

test('[CC-1401] jira_get_my_permissions lists a key Jira skipped as unanswered, not as denied', async () => {
  const fake = createFakeJiraRequest().on(
    PERMISSIONS_ROUTE,
    jiraOk({
      permissions: { BROWSE_PROJECTS: permissionEntry('BROWSE_PROJECTS', true) },
    }),
  );

  const result = await getMyPermissionsTool.handler(
    { permissions: ['BROWSE_PROJECTS', 'DELETE_ISSUES'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.data?.permissions.map((check) => check.key),
    ['BROWSE_PROJECTS'],
  );
  assert.deepEqual(result.data?.unanswered, ['DELETE_ISSUES']);
});

test('[CC-1400] jira_get_my_permissions refuses a comma-joined key before the wire', async () => {
  const fake = createFakeJiraRequest();

  const result = await getMyPermissionsTool.handler(
    { permissions: ['BROWSE_PROJECTS,CREATE_ISSUES'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.match(String(result.error?.remediation), /one key per array entry/);
  assert.equal(fake.calls.length, 0, 'nothing may reach Jira');
});

test('a Jira 400 for an unknown permission key reaches the model as validation, wording untouched', async () => {
  const rejected = errorFromResponse({
    status: 400,
    body: { errorMessages: ["Invalid permission key 'BROWSE'."] },
    method: 'GET',
    pathTemplate: '/mypermissions',
  });
  const fake = createFakeJiraRequest().on(PERMISSIONS_ROUTE, jiraErr(rejected));

  const result = await getMyPermissionsTool.handler(
    { permissions: ['BROWSE'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.equal(result.error?.message, rejected.message);
});

test('a malformed /mypermissions body fails loudly rather than returning no verdicts', async () => {
  const fake = createFakeJiraRequest().on(
    PERMISSIONS_ROUTE,
    jiraOk({ permissions: { BROWSE_PROJECTS: { key: 'BROWSE_PROJECTS' } } }),
  );

  const result = await getMyPermissionsTool.handler(
    { permissions: ['BROWSE_PROJECTS'] },
    ctxOf(fake),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'unexpected_shape');
});
