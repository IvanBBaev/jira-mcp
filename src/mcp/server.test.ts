// Tests for server assembly: the protocol surface and the write journal.
//
// These drive the REAL MCP protocol over `InMemoryTransport` rather than poking
// at the registry directly — `buildServer`'s whole job is the wiring between the
// SDK and the registry, and a test that skipped the transport would assert the
// wiring by restating it. A fixture manifest of five tools stands in for the
// twenty-seven real ones: `buildServer` takes the manifest by injection exactly
// so this is possible.
//
// The journaling half asserts the distinction the wrapper exists to make: a line
// appears when, and only when, a mutation actually left the process.

import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraErr, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { MemoryJournal } from '../core/fakes/memoryJournal.js';
import { JiraError } from '../core/types.js';
import type { Rng, Settings } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { createRecentWrites, sessionRecentWrites } from './recent-writes.js';
import type { RecentWrites } from './recent-writes.js';
import { ok } from './result.js';
import {
  JOURNAL_UNAVAILABLE_MESSAGE,
  buildServer,
  journalingGate,
  recordingGate,
} from './server.js';
import type { BuildServerDeps } from './server.js';
import type { PackageSpec, ToolResult } from './types.js';
import {
  IRREVERSIBLE_ENV_VAR,
  createWriteGate,
  noteBeforeState,
  planFingerprint,
} from './write-mode.js';

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

/** Local-only read: proves a call needs no network to succeed. */
const pingTool = defineTool({
  name: 'jira_fx_ping',
  title: 'Ping',
  description: 'Answers without calling Jira.',
  package: 'core',
  annotations: { ...READ_ANNOTATIONS, openWorldHint: false },
  input: toolInput({}),
  handler() {
    return Promise.resolve(ok({ pong: true }));
  },
});

/** A read that DOES issue a request — a GET must never be journaled. */
const lookupTool = defineTool({
  name: 'jira_fx_lookup',
  title: 'Look up',
  description: 'Reads one issue.',
  package: 'search',
  annotations: READ_ANNOTATIONS,
  input: toolInput({ key: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ key: string }>({
      method: 'GET',
      path: `/issue/${args.key}`,
    });
    return ok({ key: res.data.key });
  },
});

/** A create: the issue id and key exist only in the RESULT, which is returned whole. */
const createTool = defineTool({
  name: 'jira_fx_create',
  title: 'Create',
  description: 'Creates an issue.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ id?: string; key: string }>({
      method: 'POST',
      path: '/issue',
      body: { fields: { summary: args.summary } },
    });
    return ok(res.data);
  },
});

/** An update: the issue key is in the ARGUMENTS, and the response has no body. */
const updateTool = defineTool({
  name: 'jira_fx_update',
  title: 'Update',
  description: 'Updates an issue.',
  package: 'issues-write',
  annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
  writeTier: 'standard',
  input: writeToolInput({ issue: z.string(), summary: z.string() }),
  async handler(args, ctx) {
    await ctx.jira({
      method: 'PUT',
      path: `/issue/${args.issue}`,
      body: { fields: { summary: args.summary } },
    });
    return ok({ updated: args.issue });
  },
});

/** A write that refuses locally — nothing reaches the wire, in either mode. */
const refuseTool = defineTool({
  name: 'jira_fx_refuse',
  title: 'Refuse',
  description: 'Fails before issuing its write.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: writeToolInput({ issue: z.string() }),
  handler(): Promise<ToolResult<unknown>> {
    throw new JiraError({
      kind: 'validation',
      message: 'nothing to do',
      retryable: false,
    });
  },
});

/**
 * A delete: the pre-read feeds the plan's before-state, the DELETE is the write.
 *
 * Deliberately outside `MANIFEST` — the protocol tests pin an exact tool list,
 * and the irreversible tier is a property of the gate, not of tools/list.
 */
const deleteTool = defineTool({
  name: 'jira_fx_delete',
  title: 'Delete',
  description: 'Deletes an issue.',
  package: 'issues-delete',
  annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
  writeTier: 'irreversible',
  input: writeToolInput({ issue: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ fields: { summary: string } }>({
      method: 'GET',
      path: `/issue/${args.issue}`,
      safe: true,
    });
    noteBeforeState(ctx.jira, { key: args.issue, summary: res.data.fields.summary });
    await ctx.jira({ method: 'DELETE', path: `/issue/${args.issue}` });
    return ok({ deleted: args.issue });
  },
});

const DELETE_MANIFEST: readonly PackageSpec[] = [
  {
    id: 'issues-delete',
    title: 'Issue deletes',
    description: 'The issues-delete package.',
    tools: [deleteTool],
  },
];

const MANIFEST: readonly PackageSpec[] = [
  { id: 'core', title: 'Core', description: 'The core package.', tools: [pingTool] },
  {
    id: 'search',
    title: 'Search',
    description: 'The search package.',
    tools: [lookupTool],
  },
  {
    id: 'issues-write',
    title: 'Issue writes',
    description: 'The issues-write package.',
    tools: [createTool, updateTool, refuseTool],
  },
];

interface Harness {
  readonly deps: BuildServerDeps;
  readonly jira: ReturnType<typeof createFakeJiraRequest>;
  readonly journal: MemoryJournal;
  readonly logger: ReturnType<typeof createFakeLogger>;
  /** CC-02: injected per harness, so no test writes into the ambient session. */
  readonly recent: RecentWrites;
}

interface HarnessOptions {
  readonly settings?: Partial<Settings>;
  /** Off by default in the protocol tests; on wherever the journal is asserted. */
  readonly journaling?: boolean;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest();
  const journal = createMemoryJournal(clock);
  const logger = createFakeLogger();
  const recent = createRecentWrites();
  return {
    jira,
    journal,
    logger,
    recent,
    deps: {
      recentWrites: recent,
      settings: { ...BASE_SETTINGS, ...options.settings },
      packages: MANIFEST,
      serverName: 'jira-mcp-ai',
      version: '9.9.9',
      jira: jira.fn,
      logger,
      redactor: createFakeRedactor([]),
      clock,
      rng: countingRng(),
      ...(options.journaling === true ? { journal } : {}),
    },
  };
}

interface Session {
  readonly client: Client;
  close(): Promise<void>;
}

/** Connect an SDK client to a freshly built server over a linked in-memory pair. */
async function connect(deps: BuildServerDeps): Promise<Session> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'jira-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

/** Run `fn` against a connected session and always tear the pair down. */
async function withSession(
  deps: BuildServerDeps,
  fn: (s: Session) => Promise<void> | void,
): Promise<void> {
  const session = await connect(deps);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The machine channel, typed as the envelope it is. */
function envelopeOf(result: CallToolResult): ToolResult<Record<string, unknown>> {
  assert.ok(result.structuredContent, 'expected a structuredContent channel');
  return result.structuredContent as unknown as ToolResult<Record<string, unknown>>;
}

function dataOf(result: CallToolResult): Record<string, unknown> {
  const envelope = envelopeOf(result);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  assert.ok(envelope.data);
  return envelope.data;
}

/** Plan a write and return the single-use id the apply must quote. */
async function planIdFor(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const planned = dataOf(await callTool(client, name, args));
  assert.equal(planned['executed'], false);
  const planId = planned['plan_id'];
  assert.equal(typeof planId, 'string');
  return planId as string;
}

// ---------------------------------------------------------------------------
// The protocol surface
// ---------------------------------------------------------------------------

test('tools/list mirrors the manifest, in manifest order', async () => {
  const { deps } = makeHarness();
  await withSession(deps, async ({ client }) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        'jira_fx_ping',
        'jira_fx_lookup',
        'jira_fx_create',
        'jira_fx_update',
        'jira_fx_refuse',
      ],
    );

    const ping = listed.tools[0];
    assert.equal(ping?.title, 'Ping');
    assert.equal(ping?.description, 'Answers without calling Jira.');
    // The annotation quadruple is what a client uses to decide whether to
    // auto-approve a call, so it must survive the conversion whole.
    assert.deepEqual(ping?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

test('a tool renders a JSON Schema carrying its control fields', async () => {
  const { deps } = makeHarness();
  await withSession(deps, async ({ client }) => {
    const listed = await client.listTools();
    const update = listed.tools.find((tool) => tool.name === 'jira_fx_update');
    assert.ok(update);

    assert.equal(update.inputSchema.type, 'object');
    const properties = update.inputSchema.properties ?? {};
    // The control fields are the model's only route to an apply, so a schema
    // that omitted them would make the write surface uncallable.
    assert.deepEqual(Object.keys(properties).sort(), [
      'apply',
      'issue',
      'plan_id',
      'profile',
      'summary',
    ]);
    assert.deepEqual([...(update.inputSchema.required ?? [])].sort(), [
      'issue',
      'summary',
    ]);
  });
});

test('the server advertises tools.listChanged and logging', async () => {
  const { deps } = makeHarness();
  await withSession(deps, ({ client }) => {
    const capabilities = client.getServerCapabilities();
    assert.deepEqual(capabilities?.tools, { listChanged: true });
    assert.deepEqual(capabilities?.logging, {});
  });
});

test('the handshake reports the injected name and version', async () => {
  const { deps } = makeHarness();
  await withSession(deps, ({ client }) => {
    assert.deepEqual(client.getServerVersion(), {
      name: 'jira-mcp-ai',
      version: '9.9.9',
    });
  });
});

test('a successful call carries the same envelope on both channels', async () => {
  const { deps } = makeHarness();
  await withSession(deps, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_ping');

    assert.equal(result.isError, undefined);
    assert.deepEqual(dataOf(result), { pong: true });
    // The text channel is the same JSON, not a second rendering of it.
    const block = result.content[0];
    assert.equal(block?.type, 'text');
    assert.deepEqual(
      JSON.parse(block?.type === 'text' ? block.text : ''),
      result.structuredContent,
    );
  });
});

test('a failure comes back as an envelope with isError, not a protocol error', async () => {
  const { deps, jira } = makeHarness();
  jira.on('GET /rest/api/3/issue/ABC-1', jiraErr(new Error('boom')));

  await withSession(deps, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_lookup', { key: 'ABC-1' });

    assert.equal(result.isError, true);
    const envelope = envelopeOf(result);
    assert.equal(envelope.ok, false);
    // The envelope survives: a client that never opens it still sees isError,
    // and a model that does gets the kind and the remediation.
    assert.equal(typeof envelope.error?.kind, 'string');
  });
});

test('a tools/call that omits arguments entirely is a call with no arguments', async () => {
  const { deps } = makeHarness();
  await withSession(deps, async ({ client }) => {
    // MCP makes `params.arguments` optional, and a client calling a zero-argument
    // tool may simply leave it out. The registry is handed an object either way —
    // a bare `undefined` would be refused by the tool's schema, turning a legal
    // request into a validation error.
    const result = (await client.callTool({ name: 'jira_fx_ping' })) as CallToolResult;

    assert.equal(result.isError, undefined);
    assert.deepEqual(dataOf(result), { pong: true });
  });
});

test('an unknown tool name is an envelope, not a thrown McpError', async () => {
  const { deps } = makeHarness();
  await withSession(deps, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_nope');

    assert.equal(result.isError, true);
    assert.equal(envelopeOf(result).ok, false);
  });
});

test('invalid arguments are refused as an envelope before any request', async () => {
  const { deps, jira } = makeHarness();
  await withSession(deps, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_lookup', { key: 42 });

    assert.equal(result.isError, true);
    assert.equal(envelopeOf(result).ok, false);
    assert.deepEqual(jira.routes(), []);
  });
});

test('the gating triple is applied to the surface the client sees', async () => {
  const { deps } = makeHarness({ settings: { toolPackages: ['core', 'search'] } });
  await withSession(deps, async ({ client }) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['jira_fx_ping', 'jira_fx_lookup'],
    );

    // A gated-out tool is not merely hidden: calling it is refused too.
    assert.equal(envelopeOf(await callTool(client, 'jira_fx_create')).ok, false);
  });
});

// ---------------------------------------------------------------------------
// The irreversible tier (D45)
// ---------------------------------------------------------------------------

test('planning a delete works without the opt-in and carries the before-state', async () => {
  const { deps, jira } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on('GET /rest/api/3/issue/ABC-5', jiraOk({ fields: { summary: 'Doomed' } }));

  await withSession({ ...deps, packages: DELETE_MANIFEST }, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_delete', { issue: 'ABC-5' });
    const planned = dataOf(result);

    assert.equal(planned['executed'], false);
    assert.deepEqual(planned['before'], { key: 'ABC-5', summary: 'Doomed' });
    // The plan says, in the same breath, that this apply is currently disabled.
    const hint = (envelopeOf(result).hints ?? []).find((h) => h.code === 'plan');
    assert.ok(hint?.message.includes(IRREVERSIBLE_ENV_VAR));
    // Only the pre-read reached the wire; the DELETE was captured.
    assert.deepEqual(jira.routes(), ['GET /rest/api/3/issue/ABC-5']);
  });
});

test('an apply is refused until JIRA_ALLOW_IRREVERSIBLE is on, then it goes through', async () => {
  for (const allowIrreversible of [false, true]) {
    const { deps, jira, journal } = makeHarness({
      journaling: true,
      settings: { writeMode: 'apply', allowIrreversible },
    });
    jira.on('GET /rest/api/3/issue/ABC-5', jiraOk({ fields: { summary: 'Doomed' } }));
    jira.on('DELETE /rest/api/3/issue/ABC-5', jiraOk(undefined, { status: 204 }));

    await withSession({ ...deps, packages: DELETE_MANIFEST }, async ({ client }) => {
      const args = { issue: 'ABC-5' };
      const planId = await planIdFor(client, 'jira_fx_delete', args);
      const result = await callTool(client, 'jira_fx_delete', {
        ...args,
        apply: true,
        plan_id: planId,
      });

      if (!allowIrreversible) {
        const error = envelopeOf(result).error;
        assert.equal(error?.kind, 'write_gated');
        assert.ok(error?.remediation?.includes(IRREVERSIBLE_ENV_VAR));
        // Refused before the handler: no second read, no DELETE, no journal line.
        assert.deepEqual(jira.routes(), ['GET /rest/api/3/issue/ABC-5']);
        assert.equal(journal.entries.length, 0);
        return;
      }

      assert.deepEqual(dataOf(result), { deleted: 'ABC-5' });
      assert.ok(jira.routes().includes('DELETE /rest/api/3/issue/ABC-5'));
      assert.equal(journal.entries.length, 1);
      assert.equal(journal.entries[0]?.tool, 'jira_fx_delete');
      assert.equal(journal.entries[0]?.httpStatus, 204);
    });
  }
});

// ---------------------------------------------------------------------------
// The write journal (CC-33)
// ---------------------------------------------------------------------------

test('a plan-mode write journals nothing — nothing happened', async () => {
  const { deps, jira, journal } = makeHarness({ journaling: true });
  await withSession(deps, async ({ client }) => {
    const planned = dataOf(await callTool(client, 'jira_fx_create', { summary: 'S' }));

    assert.equal(planned['executed'], false);
    assert.deepEqual(jira.routes(), []);
    assert.deepEqual(journal.entries, []);
  });
});

test('an executed write journals one line with the plan fingerprint', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });
  jira.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-7' }, { status: 201 }));

  await withSession(deps, async ({ client }) => {
    const args = { summary: 'S' };
    const planId = await planIdFor(client, 'jira_fx_create', args);
    const data = dataOf(
      await callTool(client, 'jira_fx_create', { ...args, apply: true, plan_id: planId }),
    );
    assert.deepEqual(data, { key: 'ABC-7' });

    assert.equal(journal.entries.length, 1);
    const entry = journal.entries[0];
    assert.equal(entry?.tool, 'jira_fx_create');
    assert.equal(entry?.ok, true);
    assert.equal(entry?.httpStatus, 201);
    // A create's key exists only in the result — the argument list has none.
    assert.equal(entry?.issueKey, 'ABC-7');
    // The same hash that bound the plan; it cannot carry a field value.
    assert.equal(entry?.argsHash, planFingerprint('jira_fx_create', args, undefined));
    // The registry's per-call cid, not the root `-`.
    assert.notEqual(entry?.cid, '-');
  });
});

test('the journalled issue key comes from the arguments when there is one', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });
  jira.on('PUT /rest/api/3/issue/ABC-2', jiraOk(undefined, { status: 204 }));

  await withSession(deps, async ({ client }) => {
    const args = { issue: 'ABC-2', summary: 'S' };
    const planId = await planIdFor(client, 'jira_fx_update', args);
    await callTool(client, 'jira_fx_update', { ...args, apply: true, plan_id: planId });

    assert.equal(journal.entries[0]?.issueKey, 'ABC-2');
    assert.equal(journal.entries[0]?.httpStatus, 204);
  });
});

test('a write that came back 4xx is journaled with ok:false and its status', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });
  jira.on(
    'POST /rest/api/3/issue',
    jiraErr(
      new JiraError({
        kind: 'validation',
        message: 'field required',
        retryable: false,
        httpStatus: 400,
      }),
    ),
  );

  await withSession(deps, async ({ client }) => {
    const args = { summary: 'S' };
    const planId = await planIdFor(client, 'jira_fx_create', args);
    const result = await callTool(client, 'jira_fx_create', {
      ...args,
      apply: true,
      plan_id: planId,
    });

    assert.equal(envelopeOf(result).ok, false);
    // "Was this attempted?" is the question the journal answers, so a refused
    // request that WAS made still produces a line.
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0]?.ok, false);
    assert.equal(journal.entries[0]?.httpStatus, 400);
  });
});

test('a write that failed without a status is still journaled as attempted', async () => {
  // Two ways a mutation that HAS left the process comes back without an HTTP
  // status: a timeout (a JiraError whose status never arrived) and a rejection
  // that is not a JiraError at all. The journal answers "was this attempted?",
  // so both must produce a line — and neither may invent a status.
  const failures: readonly Error[] = [
    new JiraError({ kind: 'timeout', message: 'Jira did not answer', retryable: true }),
    new Error('socket hang up'),
  ];

  for (const failure of failures) {
    const { deps, jira, journal } = makeHarness({
      journaling: true,
      settings: { writeMode: 'apply' },
    });
    jira.on('POST /rest/api/3/issue', jiraErr(failure));

    await withSession(deps, async ({ client }) => {
      const args = { summary: 'S' };
      const planId = await planIdFor(client, 'jira_fx_create', args);
      const result = await callTool(client, 'jira_fx_create', {
        ...args,
        apply: true,
        plan_id: planId,
      });

      assert.equal(envelopeOf(result).ok, false, failure.message);
      assert.equal(journal.entries.length, 1, failure.message);
      const entry = journal.entries[0];
      assert.equal(entry?.ok, false);
      assert.equal(entry?.tool, 'jira_fx_create');
      // Absent, not `undefined`: the line is a record of what is known, and an
      // empty status column would read as "the status was nothing".
      assert.ok(entry !== undefined && !('httpStatus' in entry), failure.message);
    });
  }
});

test('a refused apply never reaches the journal', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });

  await withSession(deps, async ({ client }) => {
    // `apply: true` with no plan_id — the gate refuses before the handler runs.
    const result = await callTool(client, 'jira_fx_create', {
      summary: 'S',
      apply: true,
    });

    assert.equal(envelopeOf(result).error?.kind, 'write_gated');
    assert.deepEqual(jira.routes(), []);
    assert.deepEqual(journal.entries, []);
  });
});

test('a write that fails locally never reaches the journal', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });

  await withSession(deps, async ({ client }) => {
    const result = await callTool(client, 'jira_fx_refuse', { issue: 'ABC-3' });

    assert.equal(envelopeOf(result).ok, false);
    assert.deepEqual(jira.routes(), []);
    assert.deepEqual(journal.entries, []);
  });
});

test('reads are never journaled', async () => {
  const { deps, jira, journal } = makeHarness({ journaling: true });
  jira.on('GET /rest/api/3/issue/ABC-1', jiraOk({ key: 'ABC-1' }));

  await withSession(deps, async ({ client }) => {
    await callTool(client, 'jira_fx_ping');
    await callTool(client, 'jira_fx_lookup', { key: 'ABC-1' });

    assert.deepEqual(journal.entries, []);
  });
});

test('a failed append hints instead of failing the write (CC-33)', async () => {
  const { deps, jira, journal } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });
  jira.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }, { status: 201 }));
  journal.failNext();

  await withSession(deps, async ({ client }) => {
    const args = { summary: 'S' };
    const planId = await planIdFor(client, 'jira_fx_create', args);
    const result = await callTool(client, 'jira_fx_create', {
      ...args,
      apply: true,
      plan_id: planId,
    });

    // The write succeeded; saying otherwise would make the model retry it.
    assert.equal(result.isError, undefined);
    assert.deepEqual(dataOf(result), { key: 'ABC-9' });
    const hints = envelopeOf(result).hints ?? [];
    const hint = hints.find((h) => h.code === 'journal_unavailable');
    assert.equal(hint?.message, JOURNAL_UNAVAILABLE_MESSAGE);
  });
});

test('without a journal the write path is unchanged', async () => {
  const { deps, jira } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-4' }, { status: 201 }));

  await withSession(deps, async ({ client }) => {
    const args = { summary: 'S' };
    const planId = await planIdFor(client, 'jira_fx_create', args);
    const result = await callTool(client, 'jira_fx_create', {
      ...args,
      apply: true,
      plan_id: planId,
    });

    assert.deepEqual(dataOf(result), { key: 'ABC-4' });
    assert.deepEqual(envelopeOf(result).hints ?? [], []);
  });
});

test('the gate wrappers report the plans the gate holds, not their own idea of it', async () => {
  // `outstandingPlans` is a diagnostic on the WriteGate contract, and the object
  // that has to answer it is the outermost wrapper — the one `buildServer` hands
  // the registry. Both wrappers therefore forward it live: a wrapper that
  // answered for itself, or that snapshotted the number when it was built, would
  // report an empty session while a plan was still outstanding.
  const { deps, journal, recent } = makeHarness({
    journaling: true,
    settings: { writeMode: 'apply' },
  });
  const base = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const wrapped = recordingGate(journalingGate(base, { journal }), { recent });

  assert.equal(wrapped.outstandingPlans, 0);

  await withSession({ ...deps, gate: base }, async ({ client }) => {
    await planIdFor(client, 'jira_fx_create', { summary: 'S' });
  });

  assert.equal(base.outstandingPlans, 1, 'the plan is outstanding in the real gate');
  assert.equal(wrapped.outstandingPlans, 1);
});

// ---------------------------------------------------------------------------
// Recently written issues (CC-02)
// ---------------------------------------------------------------------------

/** Plan and then apply one write, returning the applied call's result. */
async function applyWrite(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const planId = await planIdFor(client, name, args);
  return callTool(client, name, { ...args, apply: true, plan_id: planId });
}

test('CC-02: an applied create records the id it minted', async () => {
  const { deps, jira, recent } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on(
    'POST /rest/api/3/issue',
    jiraOk({ id: '10007', key: 'ABC-7' }, { status: 201 }),
  );

  await withSession(deps, async ({ client }) => {
    const result = await applyWrite(client, 'jira_fx_create', { summary: 'S' });

    assert.deepEqual(dataOf(result), { id: '10007', key: 'ABC-7' });
    assert.deepEqual(recent.snapshot(), ['10007']);
  });
});

test('CC-02: a plan-mode write records nothing — nothing happened', async () => {
  const { deps, jira, recent } = makeHarness();
  jira.on(
    'POST /rest/api/3/issue',
    jiraOk({ id: '10007', key: 'ABC-7' }, { status: 201 }),
  );

  await withSession(deps, async ({ client }) => {
    const planned = dataOf(await callTool(client, 'jira_fx_create', { summary: 'S' }));

    assert.equal(planned['executed'], false);
    assert.deepEqual(jira.routes(), []);
    assert.deepEqual(recent.snapshot(), []);
  });
});

test('CC-02: an applied write records a numeric issue argument', async () => {
  const { deps, jira, recent } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on('PUT /rest/api/3/issue/10001', jiraOk(undefined, { status: 204 }));

  await withSession(deps, async ({ client }) => {
    await applyWrite(client, 'jira_fx_update', { issue: '10001', summary: 'S' });

    assert.deepEqual(recent.snapshot(), ['10001']);
  });
});

test('CC-02: a write addressed by issue KEY records nothing', async () => {
  const { deps, jira, recent } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on('PUT /rest/api/3/issue/ABC-2', jiraOk(undefined, { status: 204 }));

  await withSession(deps, async ({ client }) => {
    await applyWrite(client, 'jira_fx_update', { issue: 'ABC-2', summary: 'S' });

    // A key cannot be reconciled and resolving it would need another request.
    assert.deepEqual(recent.snapshot(), []);
  });
});

test('CC-02: a write that came back 4xx records nothing', async () => {
  const { deps, jira, recent } = makeHarness({ settings: { writeMode: 'apply' } });
  jira.on(
    'PUT /rest/api/3/issue/10001',
    jiraErr(
      new JiraError({
        kind: 'validation',
        message: 'field required',
        retryable: false,
        httpStatus: 400,
      }),
    ),
  );

  await withSession(deps, async ({ client }) => {
    const result = await applyWrite(client, 'jira_fx_update', {
      issue: '10001',
      summary: 'S',
    });

    assert.equal(envelopeOf(result).ok, false);
    // The journal records the attempt; the registry only remembers what exists.
    assert.deepEqual(recent.snapshot(), []);
  });
});

test('CC-02: a refused apply and a local failure record nothing', async () => {
  const { deps, recent } = makeHarness({ settings: { writeMode: 'apply' } });

  await withSession(deps, async ({ client }) => {
    await callTool(client, 'jira_fx_update', {
      issue: '10001',
      summary: 'S',
      apply: true,
    });
    await callTool(client, 'jira_fx_refuse', { issue: '10002' });

    assert.deepEqual(recent.snapshot(), []);
  });
});

test('CC-02: reads never record, however numeric their arguments', async () => {
  const { deps, jira, recent } = makeHarness();
  jira.on('GET /rest/api/3/issue/10001', jiraOk({ key: 'ABC-1' }));

  await withSession(deps, async ({ client }) => {
    await callTool(client, 'jira_fx_lookup', { key: '10001' });

    assert.deepEqual(recent.snapshot(), []);
  });
});

test('CC-02: without an injected registry the write lands in the session one', async () => {
  const { deps, jira } = makeHarness({ settings: { writeMode: 'apply' } });
  const ambient: BuildServerDeps = { ...deps, recentWrites: undefined };
  jira.on(
    'POST /rest/api/3/issue',
    jiraOk({ id: '10042', key: 'ABC-42' }, { status: 201 }),
  );

  sessionRecentWrites.clear();
  try {
    await withSession(ambient, async ({ client }) => {
      await applyWrite(client, 'jira_fx_create', { summary: 'S' });

      // The default the search tool reads (`mcp/recent-writes.ts`).
      assert.deepEqual(sessionRecentWrites.snapshot(), ['10042']);
    });
  } finally {
    sessionRecentWrites.clear();
  }
});
