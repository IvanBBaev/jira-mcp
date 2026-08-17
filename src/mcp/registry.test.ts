// Tests for the registry: the gating triple and the per-call boundary.
//
// Two contracts are asserted here. GATING — select, then deny (which wins),
// then force `core` back in (CC-29), then drop the write-tier tools of the
// read-only packages. CALL — a fresh cid per call, arguments validated before a
// handler runs, any throw rendered as a complete `ok: false` envelope, the
// redactor applied to both channels, and exactly two log events per call whose
// error fields are the `toLogFields` projection and nothing more (CC-15).

import assert from 'node:assert/strict';
import test from 'node:test';

import { FAKE_PLACEHOLDER, createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { currentCid } from '../core/log.js';
import { JiraError } from '../core/types.js';
import type { JiraRequestSpec, LogEvent, Rng, Settings } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { PROFILE_PACKAGES, createRegistry, expandSelection } from './registry.js';
import type { RegistryDeps } from './registry.js';
import { ok } from './result.js';
import { PACKAGE_IDS } from './types.js';
import type { AnyToolSpec, PackageSpec, ToolCtx } from './types.js';
import { IRREVERSIBLE_ENV_VAR, PLAN_NOTICE_LINE, noteBeforeState } from './write-mode.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function countingRng(start = 1): Rng {
  let n = start;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

const BASE_SETTINGS: Settings = {
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

function settingsOf(overrides: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...overrides };
}

interface Harness {
  readonly deps: RegistryDeps;
  readonly logger: ReturnType<typeof createFakeLogger>;
  readonly redactor: ReturnType<typeof createFakeRedactor>;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly jira: ReturnType<typeof createFakeJiraRequest>;
}

function harness(settings: Settings, secrets: readonly string[] = []): Harness {
  const logger = createFakeLogger();
  const redactor = createFakeRedactor(secrets);
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest();
  return {
    logger,
    redactor,
    clock,
    jira,
    deps: { settings, jira: jira.fn, logger, clock, rng: countingRng(), redactor },
  };
}

const capabilitiesTool = defineTool({
  name: 'jira_capabilities',
  title: 'Capabilities',
  description: 'Lists the enabled surface.',
  package: 'core',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: toolInput({}),
  handler(_args, ctx: ToolCtx) {
    return Promise.resolve(ok({ cid: ctx.cid, inContext: currentCid() }));
  },
});

const searchTool = defineTool({
  name: 'jira_search',
  title: 'Search',
  description: 'Searches issues.',
  package: 'search',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: toolInput({ jql: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ issues: readonly string[] }>({
      method: 'POST',
      path: '/search/jql',
      body: { jql: args.jql },
      safe: true,
    });
    return ok({ issues: res.data.issues });
  },
});

const usersTool = defineTool({
  name: 'jira_search_users',
  title: 'Search users',
  description: 'Finds users.',
  package: 'users',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: toolInput({ query: z.string() }),
  handler() {
    return Promise.resolve(ok({ users: [] }));
  },
});

const createIssueTool = defineTool({
  name: 'jira_create_issue',
  title: 'Create issue',
  description: 'Creates an issue.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ key: string }>({
      method: 'POST',
      path: '/issue',
      body: { fields: { summary: args.summary } },
    });
    return ok({ created: res.data.key });
  },
});

const deleteIssueTool = defineTool({
  name: 'jira_delete_issue',
  title: 'Delete issue',
  description: 'Deletes an issue.',
  package: 'issues-delete',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'irreversible',
  input: writeToolInput({ issue: z.string() }),
  async handler(args, ctx) {
    const read = await ctx.jira<{ fields: { summary: string } }>({
      method: 'GET',
      path: `/issue/${args.issue}`,
      safe: true,
    });
    noteBeforeState(ctx.jira, { key: args.issue, summary: read.data.fields.summary });
    await ctx.jira<unknown>({ method: 'DELETE', path: `/issue/${args.issue}` });
    return ok({ deleted: args.issue });
  },
});

const boardsTool = defineTool({
  name: 'jira_list_boards',
  title: 'List boards',
  description: 'Lists agile boards.',
  package: 'agile',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: toolInput({}),
  handler() {
    return Promise.resolve(ok({ boards: [] }));
  },
});

const moveIssuesTool = defineTool({
  name: 'jira_move_issues_to_sprint',
  title: 'Move issues to sprint',
  description: 'Moves issues into a sprint.',
  package: 'agile',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ sprintId: z.number() }),
  handler() {
    return Promise.resolve(ok({ moved: true }));
  },
});

function packageOf(id: PackageSpec['id'], tools: readonly AnyToolSpec[]): PackageSpec {
  return { id, title: id, description: `The ${id} package.`, tools };
}

const MANIFEST: readonly PackageSpec[] = [
  packageOf('core', [capabilitiesTool]),
  packageOf('search', [searchTool]),
  packageOf('users', [usersTool]),
  packageOf('issues-write', [createIssueTool]),
  packageOf('agile', [boardsTool, moveIssuesTool]),
];

function toolNames(settings: Settings): readonly string[] {
  return createRegistry(MANIFEST, harness(settings).deps).tools.map((tool) => tool.name);
}

function fieldsOf(event: LogEvent | undefined): Record<string, unknown> {
  return { ...(event?.fields ?? {}) };
}

// ---------------------------------------------------------------------------
// Gating triple
// ---------------------------------------------------------------------------

test('the reader profile expands to the packages CONFIGURATION.md names', () => {
  assert.deepEqual(PROFILE_PACKAGES.core, ['core']);
  assert.deepEqual(PROFILE_PACKAGES.reader, [
    'core',
    'search',
    'issues',
    'meta',
    'users',
    'agile',
  ]);
  assert.deepEqual(PROFILE_PACKAGES.all, PACKAGE_IDS);
});

test('the default selection (all) exposes every manifest tool in PACKAGE_IDS order', () => {
  assert.deepEqual(toolNames(settingsOf()), [
    'jira_capabilities',
    'jira_search',
    'jira_create_issue',
    'jira_search_users',
    'jira_list_boards',
    'jira_move_issues_to_sprint',
  ]);
});

test('the core profile exposes core alone', () => {
  assert.deepEqual(toolNames(settingsOf({ toolPackages: ['core'] })), [
    'jira_capabilities',
  ]);
});

test('an explicit package list selects exactly those packages', () => {
  assert.deepEqual(toolNames(settingsOf({ toolPackages: ['search', 'users'] })), [
    'jira_capabilities',
    'jira_search',
    'jira_search_users',
  ]);
});

test('the reader profile keeps the read tools and drops every write tool', () => {
  assert.deepEqual(toolNames(settingsOf({ toolPackages: ['reader'] })), [
    'jira_capabilities',
    'jira_search',
    'jira_search_users',
    'jira_list_boards',
  ]);
});

test('deny wins over the selection', () => {
  const names = toolNames(
    settingsOf({ toolPackages: ['all'], packagesDeny: ['search', 'agile'] }),
  );
  assert.equal(names.includes('jira_search'), false);
  assert.equal(names.includes('jira_list_boards'), false);
  assert.equal(names.includes('jira_create_issue'), true);
});

test('CC-29: denying core is overridden — the registry force-re-adds it', () => {
  const names = toolNames(
    settingsOf({ toolPackages: ['core'], packagesDeny: ['core', 'search'] }),
  );
  assert.deepEqual(names, ['jira_capabilities']);
});

test('JIRA_PACKAGES_READONLY drops only the write-tier tools of the named package', () => {
  const names = toolNames(settingsOf({ packagesReadonly: ['agile', 'issues-write'] }));
  assert.equal(names.includes('jira_list_boards'), true);
  assert.equal(names.includes('jira_move_issues_to_sprint'), false);
  assert.equal(names.includes('jira_create_issue'), false);
});

test('an unknown package or profile token fails startup', () => {
  for (const settings of [
    settingsOf({ toolPackages: ['nope'] }),
    settingsOf({ packagesDeny: ['nope'] }),
    settingsOf({ packagesReadonly: ['nope'] }),
  ]) {
    assert.throws(
      () => createRegistry(MANIFEST, harness(settings).deps),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'config' &&
        error.message.includes('nope'),
    );
  }
});

test('expandSelection tolerates whitespace, case and empty entries', () => {
  assert.deepEqual(
    [...expandSelection([' Search ', '', 'USERS'], 'X')],
    ['search', 'users'],
  );
});

test('a selected package the manifest does not carry is skipped, not fatal', () => {
  const registry = createRegistry(
    [packageOf('core', [capabilitiesTool])],
    harness(settingsOf({ toolPackages: ['all'] })).deps,
  );
  assert.deepEqual(registry.enabledPackages, ['core']);
});

test('duplicate package ids and duplicate tool names are startup errors', () => {
  const duplicatePackage = [packageOf('core', [capabilitiesTool]), packageOf('core', [])];
  const duplicateTool = [
    packageOf('core', [capabilitiesTool]),
    packageOf('search', [capabilitiesTool]),
  ];
  for (const manifest of [duplicatePackage, duplicateTool]) {
    assert.throws(
      () => createRegistry(manifest, harness(settingsOf()).deps),
      (error: unknown) => error instanceof JiraError && error.kind === 'config',
    );
  }
});

// ---------------------------------------------------------------------------
// Unavailable tools
// ---------------------------------------------------------------------------

test('an unknown tool name is not_found, a disabled package is config', async () => {
  const h = harness(settingsOf({ toolPackages: ['core'] }));
  const registry = createRegistry(MANIFEST, h.deps);

  const unknown = await registry.call('jira_nonexistent', {});
  assert.equal(unknown.structuredContent.error?.kind, 'not_found');

  const disabled = await registry.call('jira_search', { jql: 'x' });
  assert.equal(disabled.structuredContent.error?.kind, 'config');
  assert.ok(disabled.structuredContent.error?.message.includes('JIRA_TOOL_PACKAGES'));
  assert.equal(registry.has('jira_search'), false);
  assert.equal(registry.get('jira_capabilities')?.name, 'jira_capabilities');
});

test('a write tool dropped by a read-only package answers write_gated', async () => {
  const h = harness(settingsOf({ packagesReadonly: ['issues-write'] }));
  const registry = createRegistry(MANIFEST, h.deps);

  const result = await registry.call('jira_create_issue', { summary: 'x' });

  assert.equal(result.structuredContent.error?.kind, 'write_gated');
  assert.deepEqual(h.jira.calls, []);
});

// ---------------------------------------------------------------------------
// The call boundary
// ---------------------------------------------------------------------------

test('every call gets a fresh correlation id, visible to the handler and the log', async () => {
  const h = harness(settingsOf());
  const registry = createRegistry(MANIFEST, h.deps);

  const first = await registry.call('jira_capabilities', {});
  const second = await registry.call('jira_capabilities', {});

  const cids = (first.structuredContent.data as { cid: string; inContext?: string }).cid;
  const other = (second.structuredContent.data as { cid: string }).cid;
  assert.match(cids, /^c-[0-9a-f]{6}$/);
  assert.notEqual(cids, other);
  assert.equal(
    (first.structuredContent.data as { inContext?: string }).inContext,
    cids,
    'the handler runs inside runWithCid',
  );

  const events = h.logger.events;
  assert.deepEqual(
    events.map((event) => event.event),
    ['tool_call_start', 'tool_call_end', 'tool_call_start', 'tool_call_end'],
  );
  assert.equal(events[0]?.cid, cids);
  assert.equal(events[1]?.cid, cids);
  assert.deepEqual(fieldsOf(events[0]), { tool: 'jira_capabilities' });
});

test('tool_call_end carries the duration measured on the injected clock', async () => {
  const h = harness(settingsOf());
  const registry = createRegistry(MANIFEST, {
    ...h.deps,
    clock: {
      now: (() => {
        let calls = 0;
        return (): number => {
          calls += 1;
          return calls === 1 ? 1_000 : 1_042;
        };
      })(),
      sleep: () => Promise.resolve(),
    },
  });

  await registry.call('jira_capabilities', {});

  assert.equal(fieldsOf(h.logger.eventsOf('tool_call_end')[0])['durationMs'], 42);
});

test('arguments are validated before the handler runs, with a strict schema', async () => {
  const h = harness(settingsOf());
  const registry = createRegistry(MANIFEST, h.deps);

  const missing = await registry.call('jira_search', {});
  assert.equal(missing.structuredContent.error?.kind, 'validation');
  assert.ok(missing.structuredContent.error?.message.includes('jql'));

  const extra = await registry.call('jira_search', { jql: 'x', bogus: 1 });
  assert.equal(extra.structuredContent.error?.kind, 'validation');

  assert.deepEqual(h.jira.calls, [], 'a rejected call never reaches the network');
});

test('a handler that throws becomes a complete ok:false envelope', async () => {
  const boom = defineTool({
    name: 'jira_boom',
    title: 'Boom',
    description: 'Throws.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler() {
      throw new Error('secret internal detail');
    },
  });
  const h = harness(settingsOf());
  const registry = createRegistry([packageOf('core', [boom])], h.deps);

  const result = await registry.call('jira_boom', {});

  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error?.kind, 'unexpected_shape');
  assert.equal(result.structuredContent.error?.message.includes('secret'), false);
  assert.equal((JSON.parse(result.text) as { ok: boolean }).ok, false);

  const end = fieldsOf(h.logger.eventsOf('tool_call_end')[0]);
  assert.deepEqual(Object.keys(end).sort(), [
    'durationMs',
    'errorKind',
    'ok',
    'retryable',
    'tool',
  ]);
  assert.equal(end['errorKind'], 'unexpected_shape');
  assert.equal(end['ok'], false);
});

test('a returned error envelope is logged through the same three-field projection', async () => {
  const failing = defineTool({
    name: 'jira_failing',
    title: 'Failing',
    description: 'Returns an error envelope.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler() {
      return Promise.resolve({
        ok: false as const,
        error: {
          kind: 'permission' as const,
          message: 'Nope.',
          retryable: false,
          httpStatus: 403,
        },
      });
    },
  });
  const h = harness(settingsOf());
  const registry = createRegistry([packageOf('core', [failing])], h.deps);

  await registry.call('jira_failing', {});

  const end = fieldsOf(h.logger.eventsOf('tool_call_end')[0]);
  assert.equal(end['errorKind'], 'permission');
  assert.equal(end['httpStatus'], 403);
  assert.equal('message' in end, false, 'CC-15: no error text in a log event');
});

test('budget_exceeded and ambiguous_write are enriched with the tool name here', async () => {
  for (const kind of ['budget_exceeded', 'ambiguous_write'] as const) {
    const tool = defineTool({
      name: 'jira_deep_failure',
      title: 'Deep failure',
      description: 'Fails the way core/http.ts does.',
      package: 'core',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      input: toolInput({}),
      handler() {
        throw new JiraError({
          kind,
          message: 'The call budget was exhausted.',
          retryable: false,
        });
      },
    });
    const h = harness(settingsOf());
    const registry = createRegistry([packageOf('core', [tool])], h.deps);

    const result = await registry.call('jira_deep_failure', {});

    assert.equal(result.structuredContent.error?.kind, kind);
    assert.ok(
      result.structuredContent.error?.message.endsWith('Tool: jira_deep_failure.'),
      'the boundary is the only place that knows the tool name',
    );
    assert.equal(fieldsOf(h.logger.eventsOf('tool_call_end')[0])['errorKind'], kind);
  }
});

test('other error kinds are left exactly as the lower layer wrote them', async () => {
  const tool = defineTool({
    name: 'jira_not_found_failure',
    title: 'Not found',
    description: 'Fails with not_found.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler() {
      throw new JiraError({ kind: 'not_found', message: 'Gone.', retryable: false });
    },
  });
  const registry = createRegistry(
    [packageOf('core', [tool])],
    harness(settingsOf()).deps,
  );

  const result = await registry.call('jira_not_found_failure', {});
  assert.equal(result.structuredContent.error?.message, 'Gone.');
});

test('the redactor is applied to both channels of a rendered result', async () => {
  const leaky = defineTool({
    name: 'jira_leaky',
    title: 'Leaky',
    description: 'Returns a secret.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler() {
      return Promise.resolve(ok({ token: 'ATATT-s3cret' }));
    },
  });
  const h = harness(settingsOf(), ['ATATT-s3cret']);
  const registry = createRegistry([packageOf('core', [leaky])], h.deps);

  const result = await registry.call('jira_leaky', {});

  assert.equal(result.text.includes('ATATT-s3cret'), false);
  assert.equal(
    (result.structuredContent.data as { token: string }).token,
    FAKE_PLACEHOLDER,
  );
});

test('a truncated result is flagged on the envelope and in the log event', async () => {
  const bulky = defineTool({
    name: 'jira_bulky',
    title: 'Bulky',
    description: 'Returns too much.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler() {
      return Promise.resolve(ok({ items: Array.from({ length: 50 }, (_v, i) => i) }));
    },
  });
  const h = harness(settingsOf({ maxResultChars: 120 }));
  const registry = createRegistry([packageOf('core', [bulky])], h.deps);

  const result = await registry.call('jira_bulky', {});

  assert.equal(result.truncated, true);
  assert.equal(fieldsOf(h.logger.eventsOf('tool_call_end')[0])['truncated'], true);
  assert.doesNotThrow(() => JSON.parse(result.text));
});

// ---------------------------------------------------------------------------
// The write gate, seen from the boundary
// ---------------------------------------------------------------------------

test('a write tool in plan mode returns a plan whose text opens with the notice', async () => {
  const h = harness(settingsOf({ writeMode: 'plan' }));
  const registry = createRegistry(MANIFEST, h.deps);

  const result = await registry.call('jira_create_issue', { summary: 'Ship it' });

  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(h.jira.calls, []);

  const [banner, ...rest] = result.text.split('\n');
  assert.equal(banner, PLAN_NOTICE_LINE);
  const parsed = JSON.parse(rest.join('\n')) as { data: { executed: boolean } };
  assert.equal(parsed.data.executed, false);
});

test('a read tool never gets the plan banner', async () => {
  const h = harness(settingsOf());
  h.jira.on('POST /rest/api/3/search/jql', jiraOk({ issues: ['ABC-1'] }));
  const registry = createRegistry(MANIFEST, h.deps);

  const result = await registry.call('jira_search', { jql: 'project = ABC' });

  assert.equal(result.text.startsWith(PLAN_NOTICE_LINE), false);
  assert.doesNotThrow(() => JSON.parse(result.text));
});

test('apply mode with a plan_id from the plan call executes the write', async () => {
  const h = harness(settingsOf({ writeMode: 'apply' }));
  h.jira.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-7' }));
  const registry = createRegistry(MANIFEST, h.deps);

  const plan = await registry.call('jira_create_issue', { summary: 'Ship it' });
  const planId = (plan.structuredContent.data as { plan_id: string }).plan_id;

  const applied = await registry.call('jira_create_issue', {
    summary: 'Ship it',
    apply: true,
    plan_id: planId,
  });

  assert.deepEqual(applied.structuredContent.data, { created: 'ABC-7' });
  assert.deepEqual(h.jira.routes(), ['POST /rest/api/3/issue']);
});

// `settings.allowIrreversible` is one line of wiring in `createRegistry`, and a
// line that silently reads `undefined` would open the irreversible tier for
// everyone. These two tests pin both sides of that switch at the boundary.

test('an irreversible apply is refused while the opt-in is off, but planning is not', async () => {
  const h = harness(settingsOf({ writeMode: 'apply', allowIrreversible: false }));
  h.jira.on('GET /rest/api/3/issue/ABC-9', jiraOk({ fields: { summary: 'Doomed' } }));
  const registry = createRegistry(
    [packageOf('issues-delete', [deleteIssueTool])],
    h.deps,
  );

  const plan = await registry.call('jira_delete_issue', { issue: 'ABC-9' });
  const planId = (plan.structuredContent.data as { plan_id: string }).plan_id;
  assert.equal(plan.structuredContent.ok, true);

  const applied = await registry.call('jira_delete_issue', {
    issue: 'ABC-9',
    apply: true,
    plan_id: planId,
  });

  assert.equal(applied.structuredContent.error?.kind, 'write_gated');
  assert.ok(applied.structuredContent.error?.remediation?.includes(IRREVERSIBLE_ENV_VAR));
  // The pre-read of the plan ran; the DELETE never did.
  assert.deepEqual(h.jira.routes(), ['GET /rest/api/3/issue/ABC-9']);
});

test('the opt-in reaches the gate and lets the same plan_id through', async () => {
  const h = harness(settingsOf({ writeMode: 'apply', allowIrreversible: true }));
  h.jira.on('GET /rest/api/3/issue/ABC-9', jiraOk({ fields: { summary: 'Doomed' } }));
  h.jira.on('DELETE /rest/api/3/issue/ABC-9', jiraOk(undefined, { status: 204 }));
  const registry = createRegistry(
    [packageOf('issues-delete', [deleteIssueTool])],
    h.deps,
  );

  const plan = await registry.call('jira_delete_issue', { issue: 'ABC-9' });
  const planned = plan.structuredContent.data as {
    plan_id: string;
    before: { key: string; summary: string };
  };
  assert.deepEqual(planned.before, { key: 'ABC-9', summary: 'Doomed' });

  const applied = await registry.call('jira_delete_issue', {
    issue: 'ABC-9',
    apply: true,
    plan_id: planned.plan_id,
  });

  assert.deepEqual(applied.structuredContent.data, { deleted: 'ABC-9' });
  assert.deepEqual(h.jira.routes(), [
    'GET /rest/api/3/issue/ABC-9',
    'GET /rest/api/3/issue/ABC-9',
    'DELETE /rest/api/3/issue/ABC-9',
  ]);
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test('a per-call profile is refused while JIRA_LOCK_PROFILE is on (O-6)', async () => {
  const h = harness(settingsOf({ lockProfile: true }));
  const registry = createRegistry(MANIFEST, h.deps);

  const result = await registry.call('jira_search', { jql: 'x', profile: 'prod' });

  assert.equal(result.structuredContent.error?.kind, 'config');
  assert.ok(result.structuredContent.error?.message.includes('JIRA_LOCK_PROFILE'));
  assert.deepEqual(h.jira.calls, []);
});

test('an unlocked profile is forwarded onto every request the handler makes', async () => {
  const h = harness(settingsOf({ lockProfile: false }));
  h.jira.on('POST /rest/api/3/search/jql', jiraOk({ issues: [] }));
  const registry = createRegistry(MANIFEST, h.deps);

  await registry.call('jira_search', { jql: 'x', profile: 'prod' });

  assert.equal(h.jira.lastRequest()?.profile, 'prod');
});

test('the handler receives the limits, deadline and signal of the call', async () => {
  let seen: ToolCtx | undefined;
  const probe = defineTool({
    name: 'jira_probe',
    title: 'Probe',
    description: 'Records its context.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    handler(_args, ctx: ToolCtx) {
      seen = ctx;
      return Promise.resolve(ok({}));
    },
  });
  const h = harness(
    settingsOf({ maxResultChars: 999, maxPages: 3, callBudgetMs: 5_000 }),
  );
  const registry = createRegistry([packageOf('core', [probe])], h.deps);
  const controller = new AbortController();

  await registry.call('jira_probe', {}, { signal: controller.signal });

  assert.deepEqual(seen?.limits, { maxResultChars: 999, maxPages: 3 });
  assert.equal(seen?.deadlineAt, 1_000 + 5_000);
  assert.equal(seen?.signal, controller.signal);
});

test('control fields never reach the handler', async () => {
  let seen: unknown;
  const probe = defineTool({
    name: 'jira_arg_probe',
    title: 'Arg probe',
    description: 'Records its arguments.',
    package: 'issues-write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ summary: z.string() }),
    async handler(args, ctx) {
      seen = args;
      await ctx.jira({ method: 'POST', path: '/probe', body: { ...args } });
      return ok({});
    },
  });
  const h = harness(settingsOf({ writeMode: 'apply', lockProfile: false }));
  h.jira.on('POST /rest/api/3/probe', jiraOk({}));
  const registry = createRegistry([packageOf('issues-write', [probe])], h.deps);

  const plan = await registry.call('jira_arg_probe', {
    summary: 'Ship it',
    profile: 'prod',
  });
  assert.deepEqual(seen, { summary: 'Ship it' }, 'the plan pass is already stripped');

  seen = undefined;
  await registry.call('jira_arg_probe', {
    summary: 'Ship it',
    apply: true,
    plan_id: (plan.structuredContent.data as { plan_id: string }).plan_id,
    profile: 'prod',
  });

  assert.deepEqual(seen, { summary: 'Ship it' });
});

// ---------------------------------------------------------------------------
// Request spec sanity — the registry must not disturb what the handler builds
// ---------------------------------------------------------------------------

test('a forwarded profile does not overwrite one the request already set', async () => {
  const explicit = defineTool({
    name: 'jira_explicit_profile',
    title: 'Explicit profile',
    description: 'Sets its own profile.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({}),
    async handler(_args, ctx: ToolCtx) {
      const req: JiraRequestSpec = { method: 'GET', path: '/myself', profile: 'pinned' };
      await ctx.jira(req);
      return ok({});
    },
  });
  const h = harness(settingsOf({ lockProfile: false }));
  h.jira.on('GET /rest/api/3/myself', jiraOk({}));
  const registry = createRegistry([packageOf('core', [explicit])], h.deps);

  await registry.call('jira_explicit_profile', { profile: 'prod' });

  assert.equal(h.jira.lastRequest()?.profile, 'pinned');
});
