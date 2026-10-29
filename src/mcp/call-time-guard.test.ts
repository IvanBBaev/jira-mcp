// Call-time enforcement proof (V3-06, CC-5070–5089).
//
// The tool surface is gated twice: once when `tools/list` is built, and again
// when `tools/call` arrives. A client is free to call a name it was never shown —
// a stale cache, a hand-written request, a model that remembers yesterday's
// surface — so hiding a tool is not the guarantee. These tests pin the second
// half: a tool the configuration does not list is refused AT INVOCATION, with
// its handler never run and nothing sent to Jira, and the two scoped modes
// that keep a tool listed (`JIRA_PROJECTS`, plan-only `JIRA_WRITE_MODE`) still
// stop the request before it leaves.
//
// Everything is driven over the real MCP protocol (`InMemoryTransport`), so the
// proof covers the SDK wiring as well as the registry behind it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import type { FakeJiraRequest } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { MemoryJournal } from '../core/fakes/memoryJournal.js';
import type { Rng, Settings } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { ok } from './result.js';
import { buildServer } from './server.js';
import type { PackageSpec, ToolResult } from './types.js';

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
  writeMode: 'apply',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  metaCacheTtlS: 300,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
  ...FAKE_AUTH_SETTINGS,
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * The fixture manifest. Every handler records its own name in `invoked`, so a
 * test can tell "refused at the boundary" from "ran and failed".
 *
 * `agile` carries a write on purpose: the `reader` profile selects that
 * package, so its write is the one the profile has to strip (not merely leave
 * in an unselected package).
 */
function makeManifest(invoked: string[]): readonly PackageSpec[] {
  const ping = defineTool({
    name: 'jira_fx_ping',
    title: 'Ping',
    description: 'Answers without calling Jira.',
    package: 'core',
    annotations: { ...READ_ANNOTATIONS, openWorldHint: false },
    input: toolInput({}),
    handler() {
      invoked.push('jira_fx_ping');
      return Promise.resolve(ok({ pong: true }));
    },
  });

  const lookup = defineTool({
    name: 'jira_fx_lookup',
    title: 'Look up',
    description: 'Reads one issue.',
    package: 'search',
    annotations: READ_ANNOTATIONS,
    input: toolInput({ key: z.string() }),
    async handler(args, ctx) {
      invoked.push('jira_fx_lookup');
      const res = await ctx.jira<{ key: string }>({
        method: 'GET',
        path: `/issue/${args.key}`,
      });
      return ok({ key: res.data.key });
    },
  });

  const sprint = defineTool({
    name: 'jira_fx_sprint',
    title: 'Sprint',
    description: 'Answers without calling Jira.',
    package: 'agile',
    annotations: { ...READ_ANNOTATIONS, openWorldHint: false },
    input: toolInput({}),
    handler() {
      invoked.push('jira_fx_sprint');
      return Promise.resolve(ok({ sprint: 1 }));
    },
  });

  const move = defineTool({
    name: 'jira_fx_move',
    title: 'Move',
    description: 'Moves an issue into a sprint.',
    package: 'agile',
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    async handler(args, ctx) {
      invoked.push('jira_fx_move');
      await ctx.jira({
        method: 'POST',
        root: 'agile',
        path: '/sprint/1/issue',
        body: { issues: [args.issue] },
      });
      return ok({ moved: args.issue });
    },
  });

  const create = defineTool({
    name: 'jira_fx_create',
    title: 'Create',
    description: 'Creates an issue.',
    package: 'issues-write',
    annotations: WRITE_ANNOTATIONS,
    writeTier: 'standard',
    input: writeToolInput({ summary: z.string() }),
    async handler(args, ctx) {
      invoked.push('jira_fx_create');
      const res = await ctx.jira<{ id: string; key: string }>({
        method: 'POST',
        path: '/issue',
        body: { fields: { project: { key: 'ABC' }, summary: args.summary } },
      });
      return ok(res.data);
    },
  });

  const update = defineTool({
    name: 'jira_fx_update',
    title: 'Update',
    description: 'Updates an issue.',
    package: 'issues-write',
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string(), summary: z.string() }),
    async handler(args, ctx) {
      invoked.push('jira_fx_update');
      await ctx.jira({
        method: 'PUT',
        path: `/issue/${args.issue}`,
        body: { fields: { summary: args.summary } },
      });
      return ok({ updated: args.issue });
    },
  });

  return [
    { id: 'core', title: 'Core', description: 'The core package.', tools: [ping] },
    {
      id: 'search',
      title: 'Search',
      description: 'The search package.',
      tools: [lookup],
    },
    {
      id: 'agile',
      title: 'Agile',
      description: 'The agile package.',
      tools: [sprint, move],
    },
    {
      id: 'issues-write',
      title: 'Issue writes',
      description: 'The issues-write package.',
      tools: [create, update],
    },
  ];
}

/** Every fixture tool, in the canonical package order `tools/list` uses. */
const ALL_TOOLS = [
  'jira_fx_ping',
  'jira_fx_lookup',
  'jira_fx_create',
  'jira_fx_update',
  'jira_fx_sprint',
  'jira_fx_move',
] as const;

/** A plausible argument set per tool, so a refusal is never a schema refusal. */
const ARGS: Readonly<Record<(typeof ALL_TOOLS)[number], Record<string, unknown>>> = {
  jira_fx_ping: {},
  jira_fx_lookup: { key: 'ABC-1' },
  jira_fx_sprint: {},
  jira_fx_move: { issue: 'ABC-1' },
  jira_fx_create: { summary: 'New' },
  jira_fx_update: { issue: 'ABC-1', summary: 'Renamed' },
};

interface Harness {
  readonly client: Client;
  readonly jira: FakeJiraRequest;
  readonly journal: MemoryJournal;
  readonly invoked: string[];
  close(): Promise<void>;
}

async function open(settings: Partial<Settings> = {}): Promise<Harness> {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest();
  const journal = createMemoryJournal(clock);
  const invoked: string[] = [];
  const server = buildServer({
    settings: { ...BASE_SETTINGS, ...settings },
    packages: makeManifest(invoked),
    serverName: 'jira-mcp-ai',
    version: '9.9.9',
    jira: jira.fn,
    logger: createFakeLogger(),
    redactor: createFakeRedactor([]),
    clock,
    rng: countingRng(),
    journal,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'call-time-guard-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    jira,
    journal,
    invoked,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

async function withHarness(
  settings: Partial<Settings>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const harness = await open(settings);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function envelopeOf(result: CallToolResult): ToolResult<Record<string, unknown>> {
  assert.ok(result.structuredContent, 'expected a structuredContent channel');
  return result.structuredContent as unknown as ToolResult<Record<string, unknown>>;
}

async function listed(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

/**
 * The refusal contract: an `ok: false` envelope of `kind` with `isError`, the
 * handler never ran, no request reached Jira and nothing was journaled.
 */
async function assertRefused(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
  kind: string,
): Promise<void> {
  const result = await call(h.client, name, args);
  const envelope = envelopeOf(result);
  assert.equal(result.isError, true, `${name}: expected isError`);
  assert.equal(envelope.ok, false, `${name}: expected a refusal`);
  assert.equal(envelope.error?.kind, kind, `${name}: ${JSON.stringify(envelope.error)}`);
  assert.deepEqual(h.invoked, [], `${name}: the handler must not run`);
  assert.deepEqual(h.jira.routes(), [], `${name}: nothing may reach Jira`);
  assert.deepEqual(h.journal.entries, [], `${name}: nothing may be journaled`);
}

/** Plan a write and return the single-use id an apply quotes. */
async function planIdFor(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const envelope = envelopeOf(await call(h.client, name, args));
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  const planId = envelope.data?.['plan_id'];
  assert.equal(typeof planId, 'string');
  return planId as string;
}

// ---------------------------------------------------------------------------
// Packages: JIRA_TOOL_PACKAGES and JIRA_PACKAGES_DENY
// ---------------------------------------------------------------------------

test('[CC-5070] a tool in a package JIRA_TOOL_PACKAGES did not select is unlisted and refused at invocation', async () => {
  await withHarness({ toolPackages: ['core', 'search'] }, async (h) => {
    const names = await listed(h.client);
    assert.ok(!names.includes('jira_fx_sprint'));
    assert.ok(!names.includes('jira_fx_create'));

    await assertRefused(h, 'jira_fx_sprint', ARGS.jira_fx_sprint, 'config');
    // A write is refused the same way, even with a well-formed apply request.
    await assertRefused(
      h,
      'jira_fx_create',
      { ...ARGS.jira_fx_create, apply: true, plan_id: 'p-forged' },
      'config',
    );
  });
});

test('[CC-5071] JIRA_PACKAGES_DENY wins over the selection: the denied package is unlisted and refused at invocation', async () => {
  await withHarness(
    { toolPackages: ['all'], packagesDeny: ['issues-write'] },
    async (h) => {
      const names = await listed(h.client);
      assert.ok(!names.includes('jira_fx_create'));
      assert.ok(!names.includes('jira_fx_update'));
      assert.ok(names.includes('jira_fx_move'));

      await assertRefused(h, 'jira_fx_update', ARGS.jira_fx_update, 'config');
    },
  );
});

test('[CC-5072] the package refusal names the env vars that would enable the tool', async () => {
  await withHarness({ packagesDeny: ['search'] }, async (h) => {
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_lookup', ARGS.jira_fx_lookup),
    );
    assert.equal(envelope.error?.kind, 'config');
    assert.match(envelope.error?.message ?? '', /JIRA_TOOL_PACKAGES/);
    assert.match(envelope.error?.remediation ?? '', /JIRA_PACKAGES_DENY/);
    assert.equal(envelope.error?.retryable, false);
  });
});

test('[CC-5073] denying core does not remove it: core stays listed and callable', async () => {
  await withHarness({ toolPackages: ['search'], packagesDeny: ['core'] }, async (h) => {
    assert.deepEqual(await listed(h.client), ['jira_fx_ping', 'jira_fx_lookup']);
    const envelope = envelopeOf(await call(h.client, 'jira_fx_ping', {}));
    assert.equal(envelope.ok, true);
    assert.deepEqual(h.invoked, ['jira_fx_ping']);
  });
});

test('[CC-5074] a name the manifest never declared is refused as not_found with nothing sent', async () => {
  await withHarness({}, async (h) => {
    await assertRefused(h, 'jira_fx_nope', {}, 'not_found');
  });
});

// ---------------------------------------------------------------------------
// Read-only: JIRA_PACKAGES_READONLY and the reader profile
// ---------------------------------------------------------------------------

test('[CC-5075] a write in a JIRA_PACKAGES_READONLY package is unlisted and refused as write_gated, plan or apply', async () => {
  await withHarness({ packagesReadonly: ['issues-write'] }, async (h) => {
    const names = await listed(h.client);
    assert.ok(!names.includes('jira_fx_create'));
    assert.ok(!names.includes('jira_fx_update'));

    // Neither a plan request nor an apply with a plan id gets past the boundary.
    await assertRefused(h, 'jira_fx_create', ARGS.jira_fx_create, 'write_gated');
    await assertRefused(
      h,
      'jira_fx_update',
      { ...ARGS.jira_fx_update, apply: true, plan_id: 'p-forged' },
      'write_gated',
    );
  });
});

test('[CC-5076] JIRA_PACKAGES_READONLY strips only the writes of the packages it names', async () => {
  await withHarness({ packagesReadonly: ['agile'] }, async (h) => {
    const names = await listed(h.client);
    assert.ok(names.includes('jira_fx_sprint'));
    assert.ok(!names.includes('jira_fx_move'));
    assert.ok(names.includes('jira_fx_create'));

    await assertRefused(h, 'jira_fx_move', ARGS.jira_fx_move, 'write_gated');
    assert.equal(envelopeOf(await call(h.client, 'jira_fx_sprint', {})).ok, true);
  });
});

test('[CC-5077] the reader profile refuses the writes of the packages it selects at invocation', async () => {
  await withHarness({ toolPackages: ['reader'] }, async (h) => {
    const names = await listed(h.client);
    assert.ok(names.includes('jira_fx_sprint'));
    assert.ok(!names.includes('jira_fx_move'));

    await assertRefused(
      h,
      'jira_fx_move',
      { ...ARGS.jira_fx_move, apply: true, plan_id: 'p-forged' },
      'write_gated',
    );
    // issues-write is outside the profile, so its writes are a package refusal.
    await assertRefused(h, 'jira_fx_create', ARGS.jira_fx_create, 'config');
  });
});

test('[CC-5078] the read-only refusal names the knob that would lift it', async () => {
  await withHarness({ packagesReadonly: ['agile'] }, async (h) => {
    const envelope = envelopeOf(await call(h.client, 'jira_fx_move', ARGS.jira_fx_move));
    assert.equal(envelope.error?.kind, 'write_gated');
    assert.match(envelope.error?.message ?? '', /Nothing was sent to Jira/);
    assert.match(envelope.error?.remediation ?? '', /JIRA_PACKAGES_READONLY/);
  });
});

// ---------------------------------------------------------------------------
// The sweep: listed and callable are the same set
// ---------------------------------------------------------------------------

const GATING_KINDS = new Set(['config', 'write_gated', 'not_found', 'unsupported']);

const SWEEP: readonly { readonly label: string; readonly settings: Partial<Settings> }[] =
  [
    { label: 'all', settings: {} },
    { label: 'core only', settings: { toolPackages: ['core'] } },
    { label: 'reader', settings: { toolPackages: ['reader'] } },
    { label: 'deny agile', settings: { packagesDeny: ['agile'] } },
    { label: 'deny everything', settings: { packagesDeny: ['all'] } },
    {
      label: 'read-only writes',
      settings: { packagesReadonly: ['agile', 'issues-write'] },
    },
    {
      label: 'mixed',
      settings: {
        toolPackages: ['search', 'agile', 'issues-write'],
        packagesDeny: ['search'],
        packagesReadonly: ['issues-write'],
      },
    },
  ];

test('[CC-5079] across gating configurations, every unlisted tool is refused at invocation and every listed one is not', async () => {
  for (const { label, settings } of SWEEP) {
    // Plan mode, so a listed write answers with a plan and never needs the wire.
    await withHarness({ ...settings, writeMode: 'plan' }, async (h) => {
      h.jira.on('GET /rest/api/3/issue/ABC-1', jiraOk({ key: 'ABC-1' }));
      const names = new Set(await listed(h.client));
      for (const name of ALL_TOOLS) {
        const before = h.invoked.length;
        const sent = h.jira.routes().length;
        const envelope = envelopeOf(await call(h.client, name, ARGS[name]));
        if (names.has(name)) {
          assert.ok(
            envelope.ok || !GATING_KINDS.has(envelope.error?.kind ?? ''),
            `${label}: listed ${name} was gated: ${JSON.stringify(envelope.error)}`,
          );
          assert.equal(h.invoked.length, before + 1, `${label}: ${name} did not run`);
        } else {
          assert.equal(envelope.ok, false, `${label}: unlisted ${name} ran`);
          assert.ok(
            GATING_KINDS.has(envelope.error?.kind ?? ''),
            `${label}: ${name} refused as ${String(envelope.error?.kind)}`,
          );
          assert.equal(h.invoked.length, before, `${label}: unlisted ${name} ran`);
          assert.equal(h.jira.routes().length, sent, `${label}: ${name} reached Jira`);
        }
      }
      assert.deepEqual(
        h.journal.entries,
        [],
        `${label}: a plan-mode sweep journals nothing`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// JIRA_PROJECTS: listed, but confined per call
// ---------------------------------------------------------------------------

test('[CC-5080] under JIRA_PROJECTS every tool stays listed: the scope is enforced per call, not on the surface', async () => {
  await withHarness({ projects: ['ABC'] }, async (h) => {
    assert.deepEqual(await listed(h.client), [...ALL_TOOLS]);
  });
});

test('[CC-5081] a read naming an out-of-scope issue is refused as permission at invocation with nothing sent', async () => {
  await withHarness({ projects: ['ABC'] }, async (h) => {
    const result = await call(h.client, 'jira_fx_lookup', { key: 'OTHER-1' });
    const envelope = envelopeOf(result);
    assert.equal(result.isError, true);
    assert.equal(envelope.error?.kind, 'permission');
    assert.match(envelope.error?.message ?? '', /JIRA_PROJECTS/);
    assert.deepEqual(h.jira.routes(), []);
  });
});

test('[CC-5082] an out-of-scope write is refused at plan time: no plan is minted and nothing is sent', async () => {
  await withHarness({ projects: ['ABC'], writeMode: 'apply' }, async (h) => {
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_update', { issue: 'OTHER-1', summary: 'x' }),
    );
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.kind, 'permission');
    assert.equal(envelope.data, undefined);
    assert.deepEqual(h.jira.routes(), []);
    assert.deepEqual(h.journal.entries, []);
  });
});

test('[CC-5083] an apply quoting a plan id it never got for an out-of-scope write sends nothing', async () => {
  await withHarness({ projects: ['ABC'], writeMode: 'apply' }, async (h) => {
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_update', {
        issue: 'OTHER-1',
        summary: 'x',
        apply: true,
        plan_id: 'p-forged',
      }),
    );
    assert.equal(envelope.ok, false);
    assert.deepEqual(h.jira.routes(), []);
    assert.deepEqual(h.journal.entries, []);
  });
});

test('[CC-5084] an in-scope call under JIRA_PROJECTS reaches Jira after its project is confirmed', async () => {
  await withHarness({ projects: ['ABC'] }, async (h) => {
    h.jira.on(
      'GET /rest/api/3/issue/ABC-1',
      jiraOk({ key: 'ABC-1', fields: { project: { key: 'ABC' } } }),
    );
    const envelope = envelopeOf(await call(h.client, 'jira_fx_lookup', { key: 'ABC-1' }));
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    assert.ok(
      h.jira.routes().every((route) => route.startsWith('GET /rest/api/3/issue/ABC-1')),
    );
  });
});

// ---------------------------------------------------------------------------
// Plan-only mode: JIRA_WRITE_MODE=plan
// ---------------------------------------------------------------------------

test('[CC-5085] in plan-only mode every write stays listed and a call returns a plan, never a mutation', async () => {
  await withHarness({ writeMode: 'plan' }, async (h) => {
    assert.deepEqual(await listed(h.client), [...ALL_TOOLS]);

    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_create', ARGS.jira_fx_create),
    );
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    assert.equal(envelope.data?.['executed'], false);
    assert.equal(typeof envelope.data?.['plan_id'], 'string');
    assert.deepEqual(h.jira.routes(), []);
  });
});

test('[CC-5086] in plan-only mode an apply quoting a real plan id is planned again, not executed', async () => {
  await withHarness({ writeMode: 'plan' }, async (h) => {
    const planId = await planIdFor(h, 'jira_fx_update', ARGS.jira_fx_update);
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_update', {
        ...ARGS.jira_fx_update,
        apply: true,
        plan_id: planId,
      }),
    );
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    assert.equal(envelope.data?.['executed'], false);
    assert.notEqual(envelope.data?.['executed'], true);
    assert.deepEqual(h.jira.routes(), []);
    assert.deepEqual(h.journal.entries, []);
  });
});

test('[CC-5087] in plan-only mode the plan hint tells the caller that apply is off on this server', async () => {
  await withHarness({ writeMode: 'plan' }, async (h) => {
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_move', { ...ARGS.jira_fx_move, apply: true }),
    );
    const hint = (envelope.hints ?? []).find((entry) => entry.code === 'plan');
    assert.ok(hint, 'expected the plan hint');
    assert.match(hint.message, /JIRA_WRITE_MODE/);
    assert.deepEqual(h.jira.routes(), []);
  });
});

test('[CC-5088] plan-only mode lets reads through unchanged', async () => {
  await withHarness({ writeMode: 'plan' }, async (h) => {
    h.jira.on('GET /rest/api/3/issue/ABC-1', jiraOk({ key: 'ABC-1' }));
    const envelope = envelopeOf(
      await call(h.client, 'jira_fx_lookup', ARGS.jira_fx_lookup),
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(h.jira.routes(), ['GET /rest/api/3/issue/ABC-1']);
  });
});

test('[CC-5089] the gates compose: a read-only package under plan-only mode and JIRA_PROJECTS is still refused before the scope or the planner', async () => {
  await withHarness(
    { packagesReadonly: ['issues-write'], writeMode: 'plan', projects: ['ABC'] },
    async (h) => {
      await assertRefused(
        h,
        'jira_fx_update',
        { issue: 'OTHER-1', summary: 'x', apply: true },
        'write_gated',
      );
    },
  );
});
