// Tests for the loopback Streamable HTTP transport (CC-114..CC-118).
//
// These drive the REAL listener over real loopback sockets rather than calling
// the request pipeline directly — the module's whole job is what a TCP client
// can and cannot reach, and a test that skipped the socket would assert the
// guard order by restating it. The MCP traffic is raw JSON-RPC over
// `node:http`, not the SDK client: the client would paper over exactly the
// header details (Accept, Mcp-Session-Id, Authorization) this transport is
// responsible for.
//
// The fixture manifest is three tools through the real `buildServer`, so the
// session tests exercise the same wiring production uses — in particular the
// per-session plan store that CC-117's plan-death test pins.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { connect, createServer as createSocketServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import test from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { JiraError } from '../core/types.js';
import type { Rng, Settings } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { createRecentWrites } from './recent-writes.js';
import { ok } from './result.js';
import { buildServer } from './server.js';
import {
  HTTP_IDLE_SWEEP_INTERVAL_MS,
  HTTP_SESSION_IDLE_TIMEOUT_MS,
  connectHttpTransport,
  hostAllowed,
} from './transport-http.js';
import type { HttpTransportDeps } from './transport-http.js';
import type { ConnectableServer, TransportHandle } from './transport.js';
import type { PackageSpec, ToolResult } from './types.js';

const LOOPBACK_HOST = '127.0.0.1';

/** The registered secret; the suite asserts it never appears in a refusal. */
const TOKEN = 'test-bearer-token-0123456789abcdef';
/** Same length as {@link TOKEN} — the case `timingSafeEqual` itself decides. */
const WRONG_TOKEN = 'test-bearer-token-fedcba9876543210';
/** Different length — the case the length gate decides. */
const SHORT_TOKEN = 'short';

// ---------------------------------------------------------------------------
// Fixture tools (the server.test.ts fixtures, trimmed to what HTTP needs)
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
  ...FAKE_AUTH_SETTINGS,
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Local-only read: proves a call needs no network to succeed. */
const pingTool = defineTool({
  name: 'jira_fx_ping',
  title: 'Ping',
  description: 'Answers without calling Jira.',
  package: 'core',
  annotations: READ_ANNOTATIONS,
  input: toolInput({}),
  handler() {
    return Promise.resolve(ok({ pong: true }));
  },
});

/** How many times the never-finishing handler has been entered. */
let slowStarted = 0;

/**
 * Starts and never settles — CC-118's in-flight call. The promise is
 * deliberately never released: the session dies mid-call, and releasing it
 * afterwards would only race an aborted Protocol for an unhandled rejection.
 */
const slowTool = defineTool({
  name: 'jira_fx_slow',
  title: 'Slow',
  description: 'Starts and never finishes.',
  package: 'core',
  annotations: READ_ANNOTATIONS,
  input: toolInput({}),
  handler(): Promise<ToolResult<unknown>> {
    slowStarted += 1;
    return new Promise(() => {
      /* never settles, on purpose */
    });
  },
});

/** A gated write: plans in one session must be unknown to the next. */
const updateTool = defineTool({
  name: 'jira_fx_update',
  title: 'Update',
  description: 'Updates an issue.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
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

const MANIFEST: readonly PackageSpec[] = [
  {
    id: 'core',
    title: 'Core',
    description: 'The core package.',
    tools: [pingTool, slowTool],
  },
  {
    id: 'issues-write',
    title: 'Issue writes',
    description: 'The issues-write package.',
    tools: [updateTool],
  },
];

const TOOL_SURFACE = ['jira_fx_ping', 'jira_fx_slow', 'jira_fx_update'];

// ---------------------------------------------------------------------------
// Small HTTP helpers (the login.test.ts loopback kit, plus response headers)
// ---------------------------------------------------------------------------

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
}

/**
 * One request over the loopback, with the body collected.
 *
 * `agent: false` opts out of the global keep-alive pool on purpose: the
 * transport is torn down with `closeAllConnections`, and a pooled socket left
 * over from a previous test would be handed to the next request just as the
 * server destroyed it.
 */
function send(
  method: string,
  url: string,
  body?: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method, headers, agent: false },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Claim a port, learn its number, give it back. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** True when something accepted a TCP connection there; a timeout counts as no. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Every address of this machine that is NOT the loopback literal. Link-local
 * IPv6 is skipped (unconnectable without a zone index); `::1` is deliberately
 * kept — it is loopback, but a server that bound the wildcard would answer on
 * it, and one bound to `127.0.0.1` must not.
 */
function otherLocalAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address === LOOPBACK_HOST) continue;
      if (entry.address.toLowerCase().startsWith('fe80')) continue;
      out.push(entry.address);
    }
  }
  return out;
}

/** Yield to the event loop until `predicate` holds, or fail the test. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// MCP-over-HTTP helpers
// ---------------------------------------------------------------------------

function mcpUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(port)}/mcp`;
}

/**
 * Headers every Streamable HTTP POST needs — the SDK refuses (406) an Accept
 * that does not offer BOTH `application/json` and `text/event-stream`, even
 * with `enableJsonResponse` on.
 */
function baseHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...extra,
  };
}

function rpcHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return baseHeaders({ authorization: `Bearer ${TOKEN}`, ...extra });
}

let nextId = 0;

function rpc(method: string, params: unknown): string {
  nextId += 1;
  return JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params });
}

function initializeBody(): string {
  return rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'transport-http-test', version: '0.0.0' },
  });
}

/** The tool-result envelope, read structurally — HTTP tests parse raw JSON. */
interface Envelope {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly kind?: string; readonly message?: string };
}

function envelopeOf(res: HttpResult): Envelope {
  const parsed = JSON.parse(res.body) as { result?: { structuredContent?: unknown } };
  const content = parsed.result?.structuredContent;
  assert.ok(content, `expected a structuredContent channel in: ${res.body}`);
  return content as Envelope;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly port: number;
  readonly clock: ReturnType<typeof createFakeClock>;
  /** The TRANSPORT's logger — must see nothing but the one `shutdown`. */
  readonly logger: ReturnType<typeof createFakeLogger>;
  readonly jira: ReturnType<typeof createFakeJiraRequest>;
  readonly deps: HttpTransportDeps;
}

/**
 * A transport wired to the real `buildServer`. The per-session `Server`s get
 * their own logger so registry events (`tool_call`, ...) cannot blur the
 * transport logger's only-shutdown invariant.
 */
async function makeHarness(overrides: Partial<Settings> = {}): Promise<Harness> {
  const port = await freePort();
  const clock = createFakeClock(0);
  const logger = createFakeLogger();
  const serverLogger = createFakeLogger();
  const jira = createFakeJiraRequest();
  const rng = countingRng();
  const settings: Settings = {
    ...BASE_SETTINGS,
    transport: 'http',
    httpPort: port,
    httpToken: TOKEN,
    ...overrides,
  };
  const deps: HttpTransportDeps = {
    settings,
    logger,
    clock,
    createServer: () =>
      buildServer({
        settings,
        packages: MANIFEST,
        serverName: 'jira-mcp-test',
        version: '0.0.0',
        jira: jira.fn,
        logger: serverLogger,
        redactor: createFakeRedactor([]),
        clock,
        rng,
        recentWrites: createRecentWrites(),
      }),
  };
  return { port, clock, logger, jira, deps };
}

/** Run `fn` against a bound transport and always close it. */
async function withHandle(
  harness: Harness,
  fn: (handle: TransportHandle) => Promise<void>,
): Promise<void> {
  const handle = await connectHttpTransport(harness.deps);
  try {
    await fn(handle);
  } finally {
    await handle.close('sigterm');
  }
}

/** Initialize a session like a real client: handshake, then initialized. */
async function openSession(harness: Harness): Promise<string> {
  const res = await send('POST', mcpUrl(harness.port), initializeBody(), rpcHeaders());
  assert.equal(res.status, 200, res.body);
  const header = res.headers['mcp-session-id'];
  const sid = Array.isArray(header) ? header[0] : header;
  assert.equal(typeof sid, 'string', 'expected an Mcp-Session-Id response header');
  const noted = await send(
    'POST',
    mcpUrl(harness.port),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    rpcHeaders({ 'mcp-session-id': sid as string }),
  );
  assert.equal(noted.status, 202, noted.body);
  return sid as string;
}

function callTool(
  harness: Harness,
  sid: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<HttpResult> {
  return send(
    'POST',
    mcpUrl(harness.port),
    rpc('tools/call', { name, arguments: args }),
    rpcHeaders({ 'mcp-session-id': sid }),
  );
}

async function listToolNames(harness: Harness, sid: string): Promise<string[]> {
  const res = await send(
    'POST',
    mcpUrl(harness.port),
    rpc('tools/list', {}),
    rpcHeaders({ 'mcp-session-id': sid }),
  );
  assert.equal(res.status, 200, res.body);
  const parsed = JSON.parse(res.body) as { result?: { tools?: { name: string }[] } };
  return (parsed.result?.tools ?? []).map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// CC-114 — bearer authentication
// ---------------------------------------------------------------------------

test('CC-114: a request without a valid bearer token is refused with 401', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const url = mcpUrl(harness.port);
    assert.equal(
      TOKEN.length,
      WRONG_TOKEN.length,
      'the same-length case must be same-length',
    );

    const noAuth = await send('POST', url, initializeBody(), baseHeaders());
    assert.equal(noAuth.status, 401);

    const wrong = await send(
      'POST',
      url,
      initializeBody(),
      baseHeaders({ authorization: `Bearer ${WRONG_TOKEN}` }),
    );
    assert.equal(wrong.status, 401);

    const short = await send(
      'POST',
      url,
      initializeBody(),
      baseHeaders({ authorization: `Bearer ${SHORT_TOKEN}` }),
    );
    assert.equal(short.status, 401);

    // The refusal names neither the expected token nor the presented one.
    for (const refusal of [noAuth, wrong, short]) {
      assert.equal(
        refusal.body.includes(TOKEN),
        false,
        'the 401 body must not echo the secret',
      );
      assert.equal(refusal.body.includes(WRONG_TOKEN), false);
      assert.equal(refusal.body.includes(SHORT_TOKEN), false);
    }

    // The correct token opens a session — the guard refuses values, not POSTs.
    await openSession(harness);
  });
});

// ---------------------------------------------------------------------------
// CC-115 — loopback bind
// ---------------------------------------------------------------------------

test('CC-115: the listener answers on 127.0.0.1 only, and dies with the handle', async () => {
  const harness = await makeHarness();
  const handle = await connectHttpTransport(harness.deps);
  try {
    assert.equal(handle.kind, 'http');
    assert.equal(handle.closed, false);
    assert.equal(await accepts(LOOPBACK_HOST, harness.port), true);
    for (const address of otherLocalAddresses()) {
      assert.equal(
        await accepts(address, harness.port),
        false,
        `the listener must not answer on ${address}`,
      );
    }
  } finally {
    await handle.close('sigterm');
  }
  assert.equal(await accepts(LOOPBACK_HOST, harness.port), false);
});

// ---------------------------------------------------------------------------
// CC-116 — Host and Origin (DNS-rebinding defense)
// ---------------------------------------------------------------------------

test('CC-116: a non-loopback Host or Origin is refused with 403', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const url = mcpUrl(harness.port);

    // A DNS-rebound page carries its own hostname in Host.
    const evilHost = await send(
      'POST',
      url,
      initializeBody(),
      rpcHeaders({ host: `evil.example:${String(harness.port)}` }),
    );
    assert.equal(evilHost.status, 403);

    // A hostile browser page carries its own Origin.
    const evilOrigin = await send(
      'POST',
      url,
      initializeBody(),
      rpcHeaders({ origin: 'https://evil.example' }),
    );
    assert.equal(evilOrigin.status, 403);

    // No Origin at all passes — curl and MCP clients send none.
    // (`openSession` and every other request in this suite prove it.)
    // A loopback Origin on a foreign port passes — MCP inspector's case.
    const inspector = await send(
      'POST',
      url,
      initializeBody(),
      rpcHeaders({ origin: 'http://localhost:6274' }),
    );
    assert.equal(inspector.status, 200, inspector.body);

    // `localhost` is as good a spelling of the bound authority as the literal.
    const localhostHost = await send(
      'POST',
      url,
      initializeBody(),
      rpcHeaders({ host: `localhost:${String(harness.port)}` }),
    );
    assert.equal(localhostHost.status, 200, localhostHost.body);
  });
});

test('unknown paths are refused with a JSON-RPC 404 body', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const res = await send(
      'POST',
      `http://${LOOPBACK_HOST}:${String(harness.port)}/healthz`,
      initializeBody(),
      rpcHeaders(),
    );
    assert.equal(res.status, 404);
    const parsed = JSON.parse(res.body) as {
      jsonrpc?: string;
      id?: unknown;
      error?: { code?: number };
    };
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, null);
    assert.equal(typeof parsed.error?.code, 'number');
  });
});

test('a session id is required: sessionless GET gets 400, sessionless non-initialize POST too', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const url = mcpUrl(harness.port);

    // Non-POST without a session: refused by this module before the SDK.
    const get = await send('GET', url, undefined, rpcHeaders());
    assert.equal(get.status, 400);

    // Non-initialize POST without a session: refused by the SDK (and the
    // speculative server pair is torn down, not leaked).
    const list = await send('POST', url, rpc('tools/list', {}), rpcHeaders());
    assert.equal(list.status, 400);

    // Neither refusal broke the transport: a real initialize still works.
    await openSession(harness);
  });
});

// ---------------------------------------------------------------------------
// CC-117 — session lifecycle
// ---------------------------------------------------------------------------

test('CC-117: initialize opens a session and tools/list shows the full surface', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const sid = await openSession(harness);
    assert.deepEqual(await listToolNames(harness, sid), TOOL_SURFACE);

    const called = await callTool(harness, sid, 'jira_fx_ping');
    assert.equal(called.status, 200, called.body);
    const envelope = envelopeOf(called);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data?.['pong'], true);
  });
});

test('CC-117: an unknown session id is refused with 404', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const res = await send(
      'POST',
      mcpUrl(harness.port),
      rpc('tools/list', {}),
      rpcHeaders({ 'mcp-session-id': randomUUID() }),
    );
    assert.equal(res.status, 404);
  });
});

test('CC-117: DELETE ends the session; its id is dead afterwards', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const sid = await openSession(harness);
    const del = await send(
      'DELETE',
      mcpUrl(harness.port),
      undefined,
      rpcHeaders({ 'mcp-session-id': sid }),
    );
    assert.equal(del.status, 200, del.body);

    const after = await callTool(harness, sid, 'jira_fx_ping');
    assert.equal(after.status, 404);
  });
});

test('CC-117: a plan dies with its session — no cross-session apply', async () => {
  // Apply mode: in plan mode the gate re-plans an `apply: true` call instead of
  // consuming the id, so only apply mode can show a dead plan being refused.
  const harness = await makeHarness({ writeMode: 'apply' });
  await withHandle(harness, async () => {
    // Arm a plan in session A.
    const a = await openSession(harness);
    const planned = await callTool(harness, a, 'jira_fx_update', {
      issue: 'ABC-1',
      summary: 'planned in A',
    });
    assert.equal(planned.status, 200, planned.body);
    const plannedEnvelope = envelopeOf(planned);
    assert.equal(plannedEnvelope.ok, true);
    assert.equal(plannedEnvelope.data?.['executed'], false);
    const planId = plannedEnvelope.data?.['plan_id'];
    assert.equal(typeof planId, 'string');

    // Kill A: its Server — and the plan table inside it — die together.
    const del = await send(
      'DELETE',
      mcpUrl(harness.port),
      undefined,
      rpcHeaders({ 'mcp-session-id': a }),
    );
    assert.equal(del.status, 200, del.body);

    // Session B cannot apply A's plan.
    const b = await openSession(harness);
    const applied = await callTool(harness, b, 'jira_fx_update', {
      issue: 'ABC-1',
      summary: 'planned in A',
      apply: true,
      plan_id: planId,
    });
    assert.equal(applied.status, 200, applied.body);
    const appliedEnvelope = envelopeOf(applied);
    assert.equal(appliedEnvelope.ok, false);
    assert.equal(appliedEnvelope.error?.kind, 'write_gated');
    assert.match(appliedEnvelope.error?.message ?? '', /unknown/);

    // Nothing left the process at any point.
    assert.equal(harness.jira.calls.length, 0);
  });
});

test('CC-117: the idle sweeper ends idle sessions and spares active ones', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    // t = 0: session A.
    const a = await openSession(harness);

    // First sweep at t = 60 s: A is 60 s idle — far under the timeout.
    harness.clock.advance(HTTP_IDLE_SWEEP_INTERVAL_MS);
    // The sweeper is the only sleeper on this clock (no tool call is in
    // flight), and the loop re-sleeps only after finishing a pass — so one
    // pending sleep means the sweep completed.
    await until(() => harness.clock.pendingSleeps() === 1, 'the first sweep to finish');

    // t = 60 s: session B.
    const b = await openSession(harness);

    // Jump to t = 30 min: A is 30 min idle (dead), B 29 min (alive). The fake
    // clock fires only the currently pending sleep, so exactly one sweep runs.
    harness.clock.advance(HTTP_SESSION_IDLE_TIMEOUT_MS - HTTP_IDLE_SWEEP_INTERVAL_MS);
    await until(() => harness.clock.pendingSleeps() === 1, 'the reaping sweep to finish');

    const dead = await callTool(harness, a, 'jira_fx_ping');
    assert.equal(dead.status, 404, 'the idle session must be gone');

    assert.deepEqual(
      await listToolNames(harness, b),
      TOOL_SURFACE,
      'the active session survives',
    );
  });
});

// ---------------------------------------------------------------------------
// CC-118 — drain on close
// ---------------------------------------------------------------------------

test('CC-118: close() resolves with a call in flight, and emits shutdown exactly once', async () => {
  const harness = await makeHarness();
  const handle = await connectHttpTransport(harness.deps);
  let closedInTest = false;
  try {
    const sid = await openSession(harness);

    // A call that will still be running when the process is told to die.
    const before = slowStarted;
    const inFlight = callTool(harness, sid, 'jira_fx_slow').then(
      () => 'resolved',
      () => 'rejected',
    );
    await until(() => slowStarted > before, 'the slow handler to start');

    await handle.close('sigterm');
    closedInTest = true;
    assert.equal(handle.closed, true);

    // The in-flight request died with its connection instead of holding the
    // listener open — the handler itself never settles.
    assert.equal(await inFlight, 'rejected');

    // A second close (a second signal) is a no-op, not a second teardown.
    await handle.close('sigint');

    const shutdowns = harness.logger.eventsOf('shutdown');
    assert.equal(shutdowns.length, 1, 'shutdown must be emitted exactly once');
    assert.equal(shutdowns[0]?.fields?.['reason'], 'sigterm');

    assert.equal(await accepts(LOOPBACK_HOST, harness.port), false);
  } finally {
    if (!closedInTest) await handle.close('sigterm');
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

test('the transport logger sees no event other than the one shutdown', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    // A busy little life: a session, a list, a call, three refusals, a DELETE.
    const sid = await openSession(harness);
    await listToolNames(harness, sid);
    await callTool(harness, sid, 'jira_fx_ping');
    await send('POST', mcpUrl(harness.port), initializeBody(), baseHeaders());
    await send(
      'POST',
      `http://${LOOPBACK_HOST}:${String(harness.port)}/nope`,
      initializeBody(),
      rpcHeaders(),
    );
    await send('GET', mcpUrl(harness.port), undefined, rpcHeaders());
    await send(
      'DELETE',
      mcpUrl(harness.port),
      undefined,
      rpcHeaders({ 'mcp-session-id': sid }),
    );
  });
  for (const entry of harness.logger.events) {
    assert.equal(entry.event, 'shutdown', 'the transport must log nothing but shutdown');
  }
  assert.equal(harness.logger.eventsOf('shutdown').length, 1);
});

test('a missing JIRA_HTTP_TOKEN is refused with a config error, and nothing binds', async () => {
  const port = await freePort();
  const clock = createFakeClock(0);
  const logger = createFakeLogger();
  // No `httpToken` — the field is absent, exactly as `loadSettings` would
  // leave it with the variable unset.
  const settings: Settings = { ...BASE_SETTINGS, transport: 'http', httpPort: port };
  await assert.rejects(
    connectHttpTransport({
      settings,
      logger,
      clock,
      createServer: () => {
        throw new Error('createServer must not be called without a token');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'config');
      assert.match(error.message, /JIRA_HTTP_TOKEN/);
      assert.match(error.message, /CC-30/);
      return true;
    },
  );
  assert.equal(await accepts(LOOPBACK_HOST, port), false);
});

test('a port already in use rejects with a config error naming host and port', async () => {
  const port = await freePort();
  const blocker = createSocketServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen({ host: LOOPBACK_HOST, port }, () => {
      resolve();
    });
  });
  try {
    const harness = await makeHarness();
    const deps: HttpTransportDeps = {
      ...harness.deps,
      settings: { ...harness.deps.settings, httpPort: port },
    };
    await assert.rejects(connectHttpTransport(deps), (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'config');
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${String(port)}`));
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// CC-116 — the port-80 Host forms (unit: binding port 80 needs privileges)
// ---------------------------------------------------------------------------

test('CC-116: on port 80 the bare loopback Host is the bound authority', () => {
  assert.equal(hostAllowed('127.0.0.1', 80), true);
  assert.equal(hostAllowed('localhost', 80), true);
  assert.equal(hostAllowed('LOCALHOST', 80), true);
  assert.equal(hostAllowed('127.0.0.1:80', 80), true);
  assert.equal(hostAllowed('localhost:80', 80), true);
  // The elision is the default port's alone: a bare Host on any other port is
  // not the bound authority, and a foreign host never is.
  assert.equal(hostAllowed('127.0.0.1', 3334), false);
  assert.equal(hostAllowed('localhost', 3334), false);
  assert.equal(hostAllowed('evil.example', 80), false);
  assert.equal(hostAllowed('evil.example:80', 80), false);
  assert.equal(hostAllowed(undefined, 80), false);
});

// ---------------------------------------------------------------------------
// CC-117 — teardown resilience and the not-idle SSE stream
// ---------------------------------------------------------------------------

/**
 * A few timer macrotasks, so socket-close events already queued by finished
 * responses reach the server before a clock-driven sweep — the sweeper counts
 * open responses, and a session is only idle once they have settled.
 */
async function drainEventLoop(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

test('CC-117: a rejected session close neither crashes nor stops the sweeper', async () => {
  const harness = await makeHarness();
  // Every per-session Server closes for real, then rejects — the shape of an
  // SDK teardown failure. Neither caller of `teardown` can answer one: the
  // DELETE path would crash the process, the sweeper would stop sweeping.
  const deps: HttpTransportDeps = {
    ...harness.deps,
    createServer: (): ConnectableServer => {
      const product = harness.deps.createServer();
      return {
        connect: (transport) => product.connect(transport),
        close: async (): Promise<void> => {
          await product.close();
          throw new Error('close failed, on purpose');
        },
      };
    },
  };
  const handle = await connectHttpTransport(deps);
  try {
    // DELETE: the SDK fires `onsessionclosed`, whose fire-and-forget teardown
    // must swallow the rejection instead of leaving it unhandled.
    const a = await openSession(harness);
    const del = await send(
      'DELETE',
      mcpUrl(harness.port),
      undefined,
      rpcHeaders({ 'mcp-session-id': a }),
    );
    assert.equal(del.status, 200, del.body);
    const gone = await callTool(harness, a, 'jira_fx_ping');
    assert.equal(gone.status, 404, 'the deleted session must be gone');

    // Sweeper: reaping B rejects the same way — the NEXT sweep must still
    // run, and reap C.
    const b = await openSession(harness);
    await drainEventLoop();
    harness.clock.advance(HTTP_SESSION_IDLE_TIMEOUT_MS);
    await until(() => harness.clock.pendingSleeps() === 1, 'the sweep that reaps B');
    assert.equal((await callTool(harness, b, 'jira_fx_ping')).status, 404);

    const c = await openSession(harness);
    await drainEventLoop();
    harness.clock.advance(HTTP_SESSION_IDLE_TIMEOUT_MS);
    await until(() => harness.clock.pendingSleeps() === 1, 'the sweep that reaps C');
    assert.equal((await callTool(harness, c, 'jira_fx_ping')).status, 404);
  } finally {
    await handle.close('sigterm');
  }
});

/** Open the standalone SSE GET stream and resolve once its headers arrive. */
function openStream(
  harness: Harness,
  sid: string,
): Promise<{ res: IncomingMessage; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      mcpUrl(harness.port),
      {
        method: 'GET',
        agent: false,
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': sid,
        },
      },
      (res: IncomingMessage) => {
        resolve({
          res,
          destroy: (): void => {
            req.destroy();
          },
        });
      },
    );
    // After settling this keeps the teardown's connection reset from becoming
    // an unhandled 'error'.
    req.on('error', reject);
    req.end();
  });
}

test('CC-117: a session holding the standalone SSE stream is not idle', async () => {
  const harness = await makeHarness();
  await withHandle(harness, async () => {
    const sid = await openSession(harness);
    const stream = await openStream(harness, sid);
    stream.res.on('error', () => {
      /* the stream dies with the transport at the end of the test */
    });
    assert.equal(stream.res.statusCode, 200, 'the SSE stream must open');
    assert.match(stream.res.headers['content-type'] ?? '', /text\/event-stream/);

    // Thirty silent minutes. The sweep runs — and must spare the session: a
    // response is still open, so it is connected, not idle.
    harness.clock.advance(HTTP_SESSION_IDLE_TIMEOUT_MS);
    await until(() => harness.clock.pendingSleeps() === 1, 'the sparing sweep');
    const alive = await callTool(harness, sid, 'jira_fx_ping');
    assert.equal(alive.status, 200, 'the streaming session must survive');

    stream.destroy();
  });
});
