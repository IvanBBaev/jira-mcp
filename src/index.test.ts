// ---------------------------------------------------------------------------
// Tests for the composition root.
//
// Two halves, for two different risks.
//
// The pure half covers the pieces of `main()` that have to be right before any
// I/O happens: the Node-version guard (which must work on a runtime too old to
// load the rest of the code) and the credential resolver (which decides, per
// call, which site and token a request is signed with — including that a profile
// cannot walk around JIRA_ALLOWED_HOSTS).
//
// The smoke half runs the BUILT server as a real child process over real stdio.
// It is the only test that proves the assembly as shipped: the bin entry, the
// dynamic-import chain, the transport, and — the part no in-memory test can
// check — that nothing but JSON-RPC ever reaches stdout. It calls
// `jira_capabilities`, which is answered entirely from local state, so the
// child makes zero Jira requests despite carrying credentials.
//
// The child is deliberately NOT started with the network fence preloaded: the
// fence strips ambient JIRA_* variables, which would erase the fake credentials
// the child needs in order to start at all. Hermetic isolation comes from the
// environment it is given instead — an empty temporary HOME/XDG/cwd, so no
// developer `.env` on this machine can be picked up.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { HostResolution } from './core/host.js';
import type { HostRef, Settings } from './core/types.js';
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_OK,
  MIN_NODE_MAJOR,
  buildCredentialResolver,
  nodeVersionProblem,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_HOST: HostRef = { origin: 'https://example.atlassian.net', pathPrefix: '' };

const BASE_SETTINGS: Settings = {
  site: 'example.atlassian.net',
  email: 'default@example.com',
  apiToken: 'default-token',
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

/** Stand-in for `core/host.ts`: accepts one extra host, rejects everything else. */
function fakeResolveHost(
  allowed: readonly string[] = [],
): (site: string | undefined, allowedHosts: readonly string[]) => HostResolution {
  return (site, allowedHosts): HostResolution => {
    if (site === undefined || site === '') return { problems: [] };
    const known = site === 'example.atlassian.net' || allowed.includes(site);
    const permitted = known || allowedHosts.includes(site);
    if (!permitted) {
      return {
        problems: [
          {
            severity: 'error',
            code: 'host_not_allowed',
            message: `${site} is not allowed.`,
            field: 'JIRA_ALLOWED_HOSTS',
          },
        ],
      };
    }
    return {
      host: { origin: `https://${site}`, pathPrefix: '' },
      hostname: site,
      problems: [],
    };
  };
}

function resolverFor(
  settings: Settings,
  allowed: readonly string[] = [],
): ReturnType<typeof buildCredentialResolver> {
  return buildCredentialResolver({
    settings,
    host: DEFAULT_HOST,
    resolveHost: fakeResolveHost(allowed),
  });
}

// ---------------------------------------------------------------------------
// The Node-version guard
// ---------------------------------------------------------------------------

describe('nodeVersionProblem', () => {
  test('passes the runtime this suite is running on', () => {
    assert.equal(nodeVersionProblem(), undefined);
  });

  test('accepts the floor and everything above it', () => {
    assert.equal(nodeVersionProblem(`${String(MIN_NODE_MAJOR)}.0.0`), undefined);
    assert.equal(nodeVersionProblem(`${String(MIN_NODE_MAJOR + 6)}.4.1`), undefined);
  });

  test('names the version it found and how to fix it', () => {
    const problem = nodeVersionProblem('20.11.1');
    assert.ok(problem);
    assert.match(problem, /20\.11\.1/);
    assert.match(problem, new RegExp(`>= ${String(MIN_NODE_MAJOR)}`));
    assert.match(problem, /nvm/);
  });

  test('stays quiet on a version string it cannot parse', () => {
    // Refusing to start over an unreadable version would strand a runtime that
    // is probably fine; the failure surfaces later, with a real message.
    assert.equal(nodeVersionProblem('not-a-version'), undefined);
  });
});

describe('exit codes', () => {
  test('follow the doctor table', () => {
    assert.equal(EXIT_OK, 0);
    assert.equal(EXIT_FAILURE, 1);
    assert.equal(EXIT_CONFIG, 2);
  });
});

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

describe('buildCredentialResolver', () => {
  test('returns the top-level credentials when no profile is involved', () => {
    const credentials = resolverFor(BASE_SETTINGS)();
    assert.deepEqual(credentials, {
      host: DEFAULT_HOST,
      email: 'default@example.com',
      apiToken: 'default-token',
    });
  });

  test('lets a profile override one field and inherit the rest', () => {
    const settings = settingsOf({
      profiles: { prod: { name: 'prod', apiToken: 'prod-token' } },
    });

    const credentials = resolverFor(settings)('prod');
    assert.equal(credentials.apiToken, 'prod-token');
    assert.equal(credentials.email, 'default@example.com');
    assert.deepEqual(credentials.host, DEFAULT_HOST);
  });

  test('uses the active profile when the call names none', () => {
    const settings = settingsOf({
      activeProfile: 'sandbox',
      profiles: {
        sandbox: { name: 'sandbox', email: 'sandbox@example.com', apiToken: 'sbx' },
      },
    });

    assert.equal(resolverFor(settings)().email, 'sandbox@example.com');
  });

  test('matches a profile name case-insensitively', () => {
    const settings = settingsOf({
      profiles: { prod: { name: 'prod', apiToken: 'prod-token' } },
    });

    assert.equal(resolverFor(settings)('PROD').apiToken, 'prod-token');
  });

  test('re-resolves a profile site through the host allowlist', () => {
    const settings = settingsOf({
      profiles: { other: { name: 'other', site: 'other.atlassian.net' } },
    });

    const credentials = resolverFor(settings, ['other.atlassian.net'])('other');
    assert.equal(credentials.host.origin, 'https://other.atlassian.net');
  });

  test('refuses a profile whose site the allowlist rejects', () => {
    // The point of the rule: a profile is configuration, not an escape hatch
    // around JIRA_ALLOWED_HOSTS.
    const settings = settingsOf({
      profiles: { evil: { name: 'evil', site: 'attacker.example.com' } },
    });

    assert.throws(() => resolverFor(settings)('evil'), /no usable credentials/);
  });

  test('names an unknown profile instead of silently using the default', () => {
    assert.throws(() => resolverFor(BASE_SETTINGS)('nope'), /"nope" is not configured/);
  });

  test('defers the failure of an unusable INACTIVE profile', () => {
    const settings = settingsOf({
      profiles: { broken: { name: 'broken', site: 'attacker.example.com' } },
    });

    // Building the resolver must not throw — a broken profile nobody calls must
    // not stop a server whose default credentials are fine.
    const resolve = resolverFor(settings);
    assert.ok(resolve().apiToken === 'default-token');
    assert.throws(() => resolve('broken'));
  });

  test('reports a config error, not a bare throw, when credentials are missing', () => {
    const settings = settingsOf({ email: undefined, apiToken: undefined });
    try {
      resolverFor(settings)();
      assert.fail('expected a throw');
    } catch (error) {
      const record = error as {
        kind?: string;
        retryable?: boolean;
        remediation?: string;
      };
      assert.equal(record.kind, 'config');
      assert.equal(record.retryable, false);
      assert.match(record.remediation ?? '', /doctor/);
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke: the built server, as a child process, over real stdio
// ---------------------------------------------------------------------------

const SERVER_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

interface Child {
  readonly client: Client;
  /** Everything the child wrote to stderr while the session was open. */
  stderr(): string;
  close(): Promise<void>;
}

const CHILD_TOKEN = 'smoke-token-not-real';

/**
 * A deliberately minimal child environment: no inherited JIRA_* from the
 * developer's shell, and HOME/XDG pointed at an empty directory so the env-file
 * lookup finds nothing on this machine. `NODE_V8_COVERAGE` is not passed on
 * either — under c8 the child would otherwise write a second profile into the
 * parent's coverage directory.
 */
function childEnv(home: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    JIRA_SITE: 'example.atlassian.net',
    JIRA_EMAIL: 'smoke@example.com',
    JIRA_API_TOKEN: CHILD_TOKEN,
    JIRA_LOG_LEVEL: 'info',
  };
}

async function startServer(home: string): Promise<Child> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: home,
    stderr: 'pipe',
    env: childEnv(home),
  });

  // Attached BEFORE the process starts: the startup report and `server_start`
  // are written within milliseconds of spawn, and a listener added afterwards
  // would race them.
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const client = new Client({ name: 'jira-mcp-smoke', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    stderr: (): string => stderr,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}

describe('the built server over stdio', () => {
  let home: string | undefined;
  let child: Child | undefined;

  after(async () => {
    if (child !== undefined) await child.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  test('completes a full initialize → list → call session', async () => {
    home = await mkdtemp(join(tmpdir(), 'jira-mcp-smoke-'));
    child = await startServer(home);

    // initialize() already happened in connect(); the handshake result is what
    // the SDK exposes here.
    const info = child.client.getServerVersion();
    assert.ok(info);
    assert.equal(info.name, 'jira-mcp-ai');

    const capabilities = child.client.getServerCapabilities();
    assert.ok(capabilities?.tools);

    const listed = await child.client.listTools();
    assert.ok(
      listed.tools.length > 20,
      `expected the full surface, got ${String(listed.tools.length)}`,
    );
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('jira_capabilities'));
    assert.ok(names.includes('jira_search'));
    assert.ok(names.every((name) => name.startsWith('jira_')));

    const called = (await child.client.callTool({
      name: 'jira_capabilities',
      arguments: {},
    })) as CallToolResult;

    assert.notEqual(called.isError, true);
    const report = called.structuredContent as {
      ok: boolean;
      data: { serverName: string; site?: string; writeMode: string; packages: unknown[] };
    };
    assert.equal(report.ok, true);
    assert.equal(report.data.serverName, 'jira-mcp-ai');
    assert.equal(report.data.site, 'example.atlassian.net');
    assert.equal(report.data.writeMode, 'plan');
    assert.equal(report.data.packages.length, 10);

    // The credentials the child was started with must not come back out of it.
    assert.ok(!JSON.stringify(called).includes('smoke-token-not-real'));
  });

  test('sends its diagnostics to stderr, never to the protocol stream', () => {
    assert.ok(child);
    const diagnostics = child.stderr();
    // stdout purity is asserted structurally: the SDK client parses every stdout
    // line as JSON-RPC, so a stray banner would already have failed the session
    // above. What remains to check is that the startup log went somewhere.
    assert.match(diagnostics, /server_start|settings_report/);
    assert.ok(!diagnostics.includes(CHILD_TOKEN));
  });
});

// ---------------------------------------------------------------------------
// stdout purity, at the byte level (TESTING.md suite 7)
//
// The session above proves stdout is parseable by an SDK client. This one drops
// the SDK and reads the child's raw stdout, because a client is allowed to be
// forgiving: a stray banner printed before the first frame, or a dependency
// writing a progress line mid-session, can leave the handshake working while the
// stream is no longer pure JSON-RPC. Here every single line has to be a frame.
//
// The console-guard half of suite 7 is the last test in this file: a `--import`
// module plays the dependency that calls `console.log`, and the probe line must
// come back on stderr, never inside the frame stream. The probe waits until
// `console.log` has been REPLACED before firing, so it proves the redirect —
// not a lucky write that happened before the transport connected.
// ---------------------------------------------------------------------------

interface Frame {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
}

/** Every non-empty stdout line, parsed — with the offending line on failure. */
function parseFrames(stdout: string): Frame[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as Frame;
      } catch {
        return assert.fail(
          `stdout carried a line that is not a JSON-RPC frame: ${JSON.stringify(line)}`,
        );
      }
    });
}

test('writes nothing but JSON-RPC frames to stdout, byte for byte', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jira-mcp-stdout-'));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: home,
    env: childEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    // A hand-written handshake: no SDK on this side of the pipe either.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'jira-mcp-stdout-probe', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    // Both responses, or a failure that shows what the child did say.
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        if (stdout.includes('"id":2') || stdout.includes('"id": 2')) {
          clearTimeout(timer);
          child.stdout.off('data', done);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        child.stdout.off('data', done);
        reject(
          new Error(
            `no tools/list response within 15 s.\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }, 15_000);
      child.stdout.on('data', done);
      done();
    });

    const frames = parseFrames(stdout);
    assert.ok(frames.length >= 2, `expected two responses, got ${frames.length}`);
    for (const frame of frames) {
      assert.equal(
        frame.jsonrpc,
        '2.0',
        `not a JSON-RPC 2.0 frame: ${JSON.stringify(frame)}`,
      );
      const isResponse = frame.result !== undefined || frame.error !== undefined;
      assert.ok(
        isResponse || typeof frame.method === 'string',
        `frame is neither a response nor a notification: ${JSON.stringify(frame)}`,
      );
      assert.equal(
        frame.error,
        undefined,
        `the child answered with an error: ${JSON.stringify(frame)}`,
      );
    }

    // The startup diagnostics went somewhere, and it was not the protocol stream.
    assert.match(stderr, /server_start|settings_report/);
    assert.ok(!stdout.includes('server_start'));
    assert.ok(!stdout.includes(CHILD_TOKEN));
  } finally {
    child.stdin.end();
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<boolean>((resolve) => {
        // unref'd: when the child exits first, this timer must not hold the
        // test runner's event loop open for the rest of its 5 s.
        setTimeout(() => resolve(false), 5_000).unref();
      }),
    ]);
    if (!exited) child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * The dependency stand-in for the console-guard test. It keeps the ORIGINAL
 * `console.log` and fires only after the guard in `serve()` has replaced it:
 * an immediate call could land on stdout before the guard runs and prove
 * nothing either way, while a fixed delay would race server startup on a slow
 * machine. If the guard is ever removed, the replacement never happens and the
 * test fails by timeout, naming this probe.
 */
const CONSOLE_PROBE = `const original = console.log;
const timer = setInterval(() => {
  if (console.log !== original) {
    clearInterval(timer);
    console.log('CONSOLE_GUARD_PROBE');
  }
}, 10);
timer.unref();
`;

test('redirects a dependency console.log to stderr (the console guard)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jira-mcp-console-'));
  const probePath = join(home, 'console-probe.mjs');
  await writeFile(probePath, CONSOLE_PROBE);

  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(probePath).href, SERVER_ENTRY],
    { cwd: home, env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (stderr.includes('CONSOLE_GUARD_PROBE')) {
          clearTimeout(timer);
          child.stderr.off('data', check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        child.stderr.off('data', check);
        reject(
          new Error(
            `the probe line never reached stderr — is the console guard gone from serve()?\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }, 15_000);
      child.stderr.on('data', check);
      check();
    });

    // The redirected write must not have touched the protocol stream, and
    // whatever stdout does carry must still be pure frames.
    assert.ok(!stdout.includes('CONSOLE_GUARD_PROBE'));
    for (const frame of parseFrames(stdout)) {
      assert.equal(frame.jsonrpc, '2.0', `not a frame: ${JSON.stringify(frame)}`);
    }
  } finally {
    child.stdin.end();
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 5_000).unref();
      }),
    ]);
    if (!exited) child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});
