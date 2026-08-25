// `jira-mcp-ai login` / `logout` — the whole browser flow, offline.
//
// The flow runs end to end against a real `node:http` stand-in for Atlassian
// rather than an `AuthRequestFn` handing back canned objects: the parts most
// likely to break are the ones that only exist once a request has crossed a
// socket — the `redirect_uri` that must match byte for byte, the bearer on
// accessible-resources, the 0600 file that ends up on disk.
//
// Nothing here can reach Atlassian. The network fence replaces global `fetch`
// only (`node:http` is untouched, which is what makes a loopback server legal
// in this suite), the configured OAuth origins are `.invalid` names that never
// resolve, and the injected `AuthRequestFn` rewrites their origin onto the
// stand-in — so a request that escaped the seam would have nowhere to go.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, createServer as createSocketServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { nodeEnvFileHost } from '../core/config.js';
import { createJiraError } from '../core/errors.js';
import {
  createFakeClock,
  createFakeLogger,
  createFakeRedactor,
  type FakeClock,
  type FakeRedactor,
} from '../core/fakes/index.js';
import type { AuthRequestFn, AuthRequestSpec, AuthResponse } from '../core/http.js';
import {
  EXIT_CONFIG,
  EXIT_FLOW_FAILED,
  EXIT_OK,
  LOOPBACK_HOST,
  redirectUriFor,
  run,
  runLogout,
  sameState,
  type LoginOptions,
  type LoginReport,
} from './login.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = 'oauth-client-id-0001';
const CLIENT_SECRET = 'oauth-client-secret-shhhh';
const ACCESS_TOKEN = 'access-token-must-never-be-printed';
const REFRESH_TOKEN = 'refresh-token-must-never-be-printed';
const AUTH_CODE = 'authorization-code-from-the-browser';
const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
const SITE_URL = 'https://acme.atlassian.net';
const SITE_NAME = 'Acme';
const OTHER_CLOUD_ID = '99999999-8888-7777-6666-555555555555';
const OTHER_SITE_URL = 'https://globex.atlassian.net';
/** `JIRA_OAUTH_SCOPES` is comma-separated; a token response's `scope` is not. */
const SCOPES_ENV = 'read:jira-work,write:jira-work,offline_access';
const GRANTED_SCOPES = 'read:jira-work write:jira-work offline_access';
const START_MS = Date.parse('2026-08-21T09:00:00.000Z');
const EXPIRES_IN = 3600;

// `.invalid` is reserved by RFC 2606 and never resolves, so a request that
// somehow bypassed the injected seam fails loudly instead of leaving the box.
const AUTH_ORIGIN = 'https://auth.test.invalid';
const GATEWAY_ORIGIN = 'https://gateway.test.invalid';

const TOKEN_PATH = '/oauth/token';
const RESOURCES_PATH = '/oauth/token/accessible-resources';

function tokenResponse(extra: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: EXPIRES_IN,
    scope: GRANTED_SCOPES,
    ...extra,
  };
}

function oneSite(): unknown {
  return [{ id: CLOUD_ID, url: SITE_URL, name: SITE_NAME, scopes: ['read:jira-work'] }];
}

function twoSites(): unknown {
  return [
    { id: CLOUD_ID, url: SITE_URL, name: SITE_NAME },
    { id: OTHER_CLOUD_ID, url: OTHER_SITE_URL, name: 'Globex' },
  ];
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

/**
 * One request over the loopback, with the body collected.
 *
 * `agent: false` opts out of the global keep-alive pool on purpose. The login
 * listener is torn down between runs with `closeAllConnections`, and a pooled
 * socket left over from the previous run would be handed to the next request
 * just as the server destroyed it — an ECONNRESET that looks exactly like a
 * callback that never arrived.
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
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Claim a port, learn its number, give it back.
 *
 * The redirect port is fixed by configuration rather than ephemeral — Atlassian
 * matches the registered Callback URL exactly, so `login` cannot pick one at
 * runtime — and a suite that hardcoded the default 8250 would fail on any
 * machine already running the server. The gap between closing this probe and
 * `login` binding the same port is the price of that, and it is the only race
 * in this file.
 */
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
 * Every address of this machine that is NOT the loopback literal.
 *
 * Link-local IPv6 is skipped: it needs a zone index to be connectable at all,
 * so failing to reach it would prove nothing about what the server bound. `::1`
 * is deliberately kept — it is loopback, but it is not `127.0.0.1`, and a
 * server that bound the wildcard would answer on it.
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
// The Atlassian stand-in
// ---------------------------------------------------------------------------

interface AuthCall {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly authorization?: string;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
}

interface FakeAuthServer {
  readonly origin: string;
  /** What actually crossed the socket, in order. */
  readonly calls: AuthCall[];
  /** The next token-endpoint answer; tests reassign it. */
  token: Canned;
  /** The next accessible-resources answer. */
  resources: Canned;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body ?? null));
}

async function startFakeAuth(): Promise<FakeAuthServer> {
  const calls: AuthCall[] = [];
  const canned = {
    token: { status: 200, body: tokenResponse() } as Canned,
    resources: { status: 200, body: oneSite() } as Canned,
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
      const authorization = req.headers.authorization;
      calls.push({
        method: req.method ?? '',
        path: url.pathname,
        body: Buffer.concat(chunks).toString('utf8'),
        ...(authorization === undefined ? {} : { authorization }),
      });
      // Longest path first: accessible-resources lives under the token path.
      if (url.pathname === RESOURCES_PATH) {
        sendJson(res, canned.resources.status, canned.resources.body);
        return;
      }
      if (url.pathname === TOKEN_PATH) {
        sendJson(res, canned.token.status, canned.token.body);
        return;
      }
      sendJson(res, 404, { error: 'not_found', path: url.pathname });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    origin: `http://${LOOPBACK_HOST}:${String(port)}`,
    calls,
    get token(): Canned {
      return canned.token;
    },
    set token(value: Canned) {
      canned.token = value;
    },
    get resources(): Canned {
      return canned.resources;
    },
    set resources(value: Canned) {
      canned.resources = value;
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * An {@link AuthRequestFn} that carries the call to the stand-in.
 *
 * Only the ORIGIN is rewritten — path, method, body and bearer travel exactly
 * as `core/oauth.ts` built them, which is the point of using a server at all.
 * The non-2xx behaviour mirrors `createAuthRequest`: a failure is raised, never
 * returned, so this seam cannot make the caller look more careful than it is.
 */
function authRequestVia(fake: FakeAuthServer, seen: AuthRequestSpec[]): AuthRequestFn {
  return async (spec: AuthRequestSpec): Promise<AuthResponse> => {
    seen.push(spec);
    const target = new URL(spec.url);
    const local = `${fake.origin}${target.pathname}${target.search}`;
    const body = spec.json === undefined ? undefined : JSON.stringify(spec.json);
    const result = await send(spec.method, local, body, {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(spec.bearer === undefined ? {} : { authorization: `Bearer ${spec.bearer}` }),
    });

    let json: unknown;
    try {
      json = JSON.parse(result.body) as unknown;
    } catch {
      json = undefined;
    }

    if (result.status < 200 || result.status >= 300) {
      throw createJiraError({
        kind: 'auth',
        reason: `${spec.method} ${target.pathname} answered ${String(result.status)}: ${result.body}`,
        remediation: 'Check the client credentials and run `jira-mcp-ai login` again.',
      });
    }
    return { status: result.status, json, text: result.body };
  };
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

interface Rig {
  readonly options: LoginOptions;
  readonly auth: FakeAuthServer;
  readonly clock: FakeClock;
  readonly redactor: FakeRedactor;
  /** Specs handed to the network seam, before the origin rewrite. */
  readonly seen: AuthRequestSpec[];
  readonly port: number;
  readonly storePath: string;
  readonly redirectUri: string;
  /** The URL the default browser stub was handed, if it ran. */
  authorizeUrl(): string | undefined;
  /** Drive the callback the browser would have made. */
  callback(params: Readonly<Record<string, string>>): Promise<HttpResult>;
  /** The token store as it is on disk, or undefined when there is no file. */
  storeFile(): Record<string, unknown> | undefined;
  storeMode(): number | undefined;
  stdout(): string;
  stderr(): string;
  cleanup(): Promise<void>;
}

interface RigSetup {
  /** Merged over the oauth-mode defaults; an explicit `undefined` unsets one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly extra?: Partial<LoginOptions>;
}

async function rig(setup: RigSetup = {}): Promise<Rig> {
  const auth = await startFakeAuth();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-login-'));
  const storePath = join(dir, 'oauth.json');
  const clock = createFakeClock(START_MS);
  // Seeded with NOTHING on purpose: every secret blanked in the output must
  // have been registered by the flow itself, from the settings it loaded and
  // the tokens it parsed.
  const redactor = createFakeRedactor();
  const seen: AuthRequestSpec[] = [];
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let authorizeUrl: string | undefined;

  const env: NodeJS.ProcessEnv = {
    JIRA_AUTH_MODE: 'oauth',
    JIRA_OAUTH_CLIENT_ID: CLIENT_ID,
    JIRA_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    JIRA_OAUTH_SCOPES: SCOPES_ENV,
    JIRA_OAUTH_TOKEN_FILE: storePath,
    JIRA_OAUTH_REDIRECT_PORT: String(port),
    JIRA_OAUTH_AUTH_ORIGIN: AUTH_ORIGIN,
    JIRA_OAUTH_GATEWAY_ORIGIN: GATEWAY_ORIGIN,
    ...setup.env,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }

  const callback = (params: Readonly<Record<string, string>>): Promise<HttpResult> => {
    const url = new URL(redirectUriFor(port));
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return send('GET', url.toString());
  };

  const options: LoginOptions = {
    env,
    // Both point at the empty temp directory, so no stray `.env` on the
    // developer's machine can reach the settings this test asserts about.
    homeDir: dir,
    cwd: dir,
    platform: 'linux',
    // The real host: `statFile` has to report the mode of the file the store
    // actually wrote, which a map of canned numbers cannot.
    envFileHost: nodeEnvFileHost,
    clock,
    logger: createFakeLogger({ clock }),
    redactor,
    stdout: (text) => outChunks.push(text),
    stderr: (text) => errChunks.push(text),
    isTTY: true,
    authRequest: authRequestVia(auth, seen),
    openBrowser: (url: string): boolean => {
      authorizeUrl = url;
      const state = new URL(url).searchParams.get('state') ?? '';
      void callback({ code: AUTH_CODE, state }).catch(() => undefined);
      return true;
    },
    ...setup.extra,
  };

  return {
    options,
    auth,
    clock,
    redactor,
    seen,
    port,
    storePath,
    redirectUri: redirectUriFor(port),
    authorizeUrl: () => authorizeUrl,
    callback,
    storeFile: () => {
      if (!existsSync(storePath)) return undefined;
      return JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    },
    storeMode: () =>
      existsSync(storePath) ? statSync(storePath).mode & 0o777 : undefined,
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
    cleanup: async () => {
      await auth.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The stored entry for a profile, as JSON read back from disk. */
function storedEntry(
  file: Record<string, unknown> | undefined,
  key = 'default',
): Record<string, unknown> | undefined {
  const tokens = file?.['tokens'];
  if (tokens === null || typeof tokens !== 'object') return undefined;
  const entry = (tokens as Record<string, unknown>)[key];
  if (entry === null || typeof entry !== 'object') return undefined;
  return entry as Record<string, unknown>;
}

/** No secret may reach either stream, whatever else the test is about. */
function assertNoSecrets(rigged: Rig): void {
  const streams = `${rigged.stdout()}\n${rigged.stderr()}`;
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, AUTH_CODE]) {
    assert.equal(
      streams.includes(secret),
      false,
      `a secret reached the CLI output: ${secret}`,
    );
  }
}

/** `assert.match` without having to escape a temp path into a regex. */
function assertContains(haystack: string, needle: string): void {
  assert.equal(haystack.includes(needle), true, `expected output to contain ${needle}`);
}

// ---------------------------------------------------------------------------
// Usage and configuration refusals
// ---------------------------------------------------------------------------

test('login --help says the callback port has to match the registered one', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--help'] });

  assert.equal(code, EXIT_OK);
  assert.match(r.stdout(), /Usage: jira-mcp-ai login/);
  assert.match(r.stdout(), /JIRA_OAUTH_REDIRECT_PORT must match the Callback URL/);
  assert.equal(r.authorizeUrl(), undefined);
});

test('login rejects an unknown option with the usage text and exit 2', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--browser'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /Unknown option "--browser"/);
  assert.match(r.stderr(), /Usage: jira-mcp-ai login/);
  assert.equal(r.authorizeUrl(), undefined);
});

test('login refuses basic auth mode before it opens a socket', async (t) => {
  const r = await rig({ env: { JIRA_AUTH_MODE: 'basic' } });
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /JIRA_AUTH_MODE is "basic"/);
  assert.equal(r.authorizeUrl(), undefined);
  assert.equal(await accepts(LOOPBACK_HOST, r.port), false);
});

test('login refuses an oauth mode with no client id, naming the variable', async (t) => {
  const r = await rig({ env: { JIRA_OAUTH_CLIENT_ID: undefined } });
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /JIRA_OAUTH_CLIENT_ID is not set/);
  assert.equal(r.authorizeUrl(), undefined);
});

test('login refuses an oauth mode with no client secret, because PKCE does not replace it', async (t) => {
  const r = await rig({ env: { JIRA_OAUTH_CLIENT_SECRET: undefined } });
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /JIRA_OAUTH_CLIENT_SECRET is not set/);
  assert.match(r.stderr(), /PKCE does not replace it/);
  assert.equal(r.authorizeUrl(), undefined);
});

test('login refuses to run without a TTY, since nobody can complete the browser flow', async (t) => {
  const r = await rig({ extra: { isTTY: false } });
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /login needs a terminal/);
  assert.equal(await accepts(LOOPBACK_HOST, r.port), false);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('login runs the browser flow and stores the tokens in a 0600 file', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_OK);

  const authorizeUrl = new URL(r.authorizeUrl() ?? '');
  assert.equal(authorizeUrl.origin, AUTH_ORIGIN);
  assert.equal(authorizeUrl.pathname, '/authorize');
  assert.equal(authorizeUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), r.redirectUri);

  // Two calls, in that order, and both of them really crossed a socket.
  assert.deepEqual(
    r.auth.calls.map((call) => `${call.method} ${call.path}`),
    [`POST ${TOKEN_PATH}`, `GET ${RESOURCES_PATH}`],
  );
  assert.deepEqual(
    r.seen.map((spec) => spec.url),
    [`${AUTH_ORIGIN}${TOKEN_PATH}`, `${GATEWAY_ORIGIN}${RESOURCES_PATH}`],
  );

  const exchange = JSON.parse(r.auth.calls[0]?.body ?? '{}') as Record<string, string>;
  assert.equal(exchange['grant_type'], 'authorization_code');
  assert.equal(exchange['client_id'], CLIENT_ID);
  assert.equal(exchange['client_secret'], CLIENT_SECRET);
  assert.equal(exchange['code'], AUTH_CODE);
  // Byte for byte the same string that went to `/authorize`: Atlassian compares
  // the two, and a mismatch fails with an error that blames the code instead.
  assert.equal(exchange['redirect_uri'], r.redirectUri);
  // And the verifier really is the pre-image of the challenge that was shown.
  assert.equal(
    createHash('sha256')
      .update(exchange['code_verifier'] ?? '', 'ascii')
      .digest('base64url'),
    authorizeUrl.searchParams.get('code_challenge'),
  );

  // Discovery is authenticated with the token that was just issued.
  assert.equal(r.auth.calls[1]?.authorization, `Bearer ${ACCESS_TOKEN}`);

  // The report names the site, the store and the horizon the endpoint gave us.
  const out = r.stdout();
  assertContains(out, `waiting for the callback on ${r.redirectUri}`);
  assertContains(out, 'Signed in to Acme (https://acme.atlassian.net)');
  assertContains(out, `cloudId   ${CLOUD_ID}`);
  assertContains(out, 'scopes    read:jira-work write:jira-work offline_access');
  // Straight from `expires_in`; no lifetime is hardcoded anywhere in the CLI.
  assertContains(out, 'the access token expires in 60 minutes');
  assertContains(out, 'profile   default');
  assertContains(out, `stored in ${r.storePath} (mode 0600)`);
  // A listed site says nothing about what the account may do in it.
  assertContains(out, 'says nothing about what this account may do');
  assertNoSecrets(r);

  // And what ended up on disk.
  const file = r.storeFile();
  const entry = storedEntry(file);
  assert.equal(file?.['version'], 1);
  assert.equal(entry?.['cloudId'], CLOUD_ID);
  assert.equal(entry?.['site'], SITE_URL);
  assert.equal(entry?.['clientId'], CLIENT_ID);
  assert.deepEqual(entry?.['scopes'], GRANTED_SCOPES.split(' '));
  assert.equal(entry?.['refreshToken'], REFRESH_TOKEN);
  assert.equal(entry?.['accessToken'], ACCESS_TOKEN);
  assert.equal(entry?.['expiresAt'], START_MS + EXPIRES_IN * 1000);
  assert.equal(entry?.['obtainedAt'], START_MS);
  assert.equal(r.storeMode(), 0o600);
});

test('login --json prints one machine-readable object with no token in it', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--json'] });

  assert.equal(code, EXIT_OK);
  // One document, not a document with a greeting in front of it.
  assert.equal(r.stdout().trimStart().startsWith('{'), true);
  const report = JSON.parse(r.stdout()) as LoginReport;
  assert.equal(report.ok, true);
  assert.equal(report.profile, 'default');
  assert.equal(report.site, SITE_URL);
  assert.equal(report.siteName, SITE_NAME);
  assert.equal(report.cloudId, CLOUD_ID);
  assert.deepEqual(report.scopes, GRANTED_SCOPES.split(' '));
  assert.equal(report.expiresAt, START_MS + EXPIRES_IN * 1000);
  assert.equal(report.refreshToken, true);
  assert.equal(report.storePath, r.storePath);
  assert.equal(report.storeMode, '0600');
  assertNoSecrets(r);
});

test('login --json reports a refusal as an object rather than prose', async (t) => {
  const r = await rig({ env: { JIRA_AUTH_MODE: 'basic' } });
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--json'] });

  assert.equal(code, EXIT_CONFIG);
  const report = JSON.parse(r.stdout()) as LoginReport;
  assert.equal(report.ok, false);
  assert.equal(report.profile, 'default');
  assert.match(report.error ?? '', /JIRA_AUTH_MODE is "basic"/);
  assert.equal(r.stderr(), '');
});

test('login --profile stores the grant under its own key', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--profile', 'Sandbox'] });

  assert.equal(code, EXIT_OK);
  // Keys are case-folded, so `Sandbox` and `sandbox` cannot become two grants.
  assert.equal(storedEntry(r.storeFile(), 'sandbox')?.['cloudId'], CLOUD_ID);
  assert.equal(storedEntry(r.storeFile(), 'default'), undefined);
  assertContains(r.stdout(), 'profile   sandbox');
});

test('login --no-browser prints the authorization URL instead of opening one', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const running = run({ ...r.options, argv: ['--no-browser'] });

  await until(() => r.stdout().includes('code_challenge'), 'the authorization URL');
  assert.equal(r.authorizeUrl(), undefined, 'nothing may be launched under --no-browser');
  assert.match(r.stdout(), /Open this URL to authorize:/);

  // The printed URL is the whole contract with the operator, so the callback is
  // driven from exactly what was printed rather than from a rebuilt copy.
  const printed = /https:\/\/\S+/.exec(r.stdout())?.[0] ?? '';
  const state = new URL(printed).searchParams.get('state') ?? '';
  const answered = await r.callback({ code: AUTH_CODE, state });
  assert.equal(answered.status, 200);
  assert.match(answered.body, /Authorized/);

  assert.equal(await running, EXIT_OK);
  assertNoSecrets(r);
});

// ---------------------------------------------------------------------------
// The loopback listener
// ---------------------------------------------------------------------------

test('the loopback callback binds 127.0.0.1 only and rejects a request without a code [CC-104]', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  // A browser that opens the page and then does nothing, so the listener is up
  // and still waiting while the probes below run.
  let authorizeUrl = '';
  let exitCode: number | undefined;
  const running = run({
    ...r.options,
    openBrowser: (url: string): boolean => {
      authorizeUrl = url;
      return true;
    },
  }).then((code) => {
    exitCode = code;
    return code;
  });
  await until(() => r.stdout().includes('waiting for the callback'), 'the listener');

  // Any other path is a 404 that settles nothing.
  const stray = await send(
    'GET',
    `http://${LOOPBACK_HOST}:${String(r.port)}/favicon.ico`,
  );
  assert.equal(stray.status, 404);

  // A callback with no `code` is refused — and, crucially, does not end the
  // wait: a browser preflight, a favicon fetch or a port scan must not cancel a
  // login the operator is still completing in another tab.
  const empty = await r.callback({});
  assert.equal(empty.status, 400);
  assert.match(empty.body, /Missing the "code" parameter/);

  // Nothing on any other address of this machine can reach the listener. On a
  // host with no non-loopback address the loop is vacuous, which is the correct
  // answer there: there is no interface it could have been exposed on.
  for (const address of otherLocalAddresses()) {
    assert.equal(
      await accepts(address, r.port),
      false,
      `the callback listener accepted a connection on ${address}`,
    );
  }

  assert.equal(exitCode, undefined, 'a codeless callback must not end the wait');
  assert.deepEqual(r.auth.calls, [], 'nothing may be exchanged before a real callback');

  // The real callback still completes the flow that survived all of that.
  const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
  await r.callback({ code: AUTH_CODE, state });
  assert.equal(await running, EXIT_OK);

  // And the listener is gone once the command returns.
  assert.equal(await accepts(LOOPBACK_HOST, r.port), false);
});

test('a state mismatch on the callback aborts before the token exchange [CC-97]', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  let answered: HttpResult | undefined;
  const code = await run({
    ...r.options,
    openBrowser: (url: string): boolean => {
      // The shape of the attack: a callback that did not come from the
      // authorization this process started, carrying somebody else's code.
      assert.notEqual(new URL(url).searchParams.get('state'), null);
      void r.callback({ code: 'attacker-code', state: 'not-our-state' }).then(
        (result) => {
          answered = result;
        },
        () => undefined,
      );
      return true;
    },
  });

  assert.equal(code, EXIT_FLOW_FAILED);
  // The whole property: nothing reached the token endpoint, so the code in that
  // callback was never spent.
  assert.deepEqual(r.auth.calls, []);
  assert.equal(r.seen.length, 0);
  assert.match(r.stderr(), /state value that does not match/);
  assert.match(r.stderr(), /jira-mcp-ai login/);
  assert.equal(r.storeFile(), undefined);

  await until(() => answered !== undefined, 'the callback response');
  assert.equal(answered?.status, 400);
  assert.match(answered?.body ?? '', /State mismatch/);
});

test('sameState treats a length mismatch as a mismatch instead of throwing', () => {
  assert.equal(sameState('abc', 'abc'), true);
  assert.equal(sameState('abc', 'abcd'), false);
  assert.equal(sameState('abc', ''), false);
  assert.equal(sameState('', ''), true);
  assert.equal(sameState('abc', 'abd'), false);
});

test('an error redirect from Atlassian ends the wait with what it said', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({
    ...r.options,
    openBrowser: (): boolean => {
      void r
        .callback({ error: 'access_denied', error_description: 'The user said no' })
        .catch(() => undefined);
      return true;
    },
  });

  assert.equal(code, EXIT_FLOW_FAILED);
  assert.match(r.stderr(), /Atlassian refused the authorization: access_denied/);
  assert.match(r.stderr(), /The user said no/);
  assert.deepEqual(r.auth.calls, []);
  assert.equal(r.storeFile(), undefined);
});

test('login gives up when no callback arrives before the timeout', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({
    ...r.options,
    argv: ['--timeout', '30'],
    openBrowser: (): boolean => {
      // Queued rather than immediate: the sleep this releases is registered a
      // few statements after `openBrowser` returns, still in this same job.
      queueMicrotask(() => {
        r.clock.advance(30_000);
      });
      return true;
    },
  });

  assert.equal(code, EXIT_FLOW_FAILED);
  assert.match(r.stderr(), /No callback arrived within 30 seconds/);
  assert.match(r.stderr(), /raise --timeout/);
  assert.deepEqual(r.auth.calls, []);
  // A leaked listener in a CLI is a process that never exits, so the teardown
  // has to have run on this path too.
  assert.equal(await accepts(LOOPBACK_HOST, r.port), false);
  assert.equal(r.clock.pendingSleeps(), 0);
});

test('login rejects a --timeout that is not a positive number of seconds', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--timeout', 'soon'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /--timeout takes a positive number of seconds/);
  assert.equal(await accepts(LOOPBACK_HOST, r.port), false);
});

// ---------------------------------------------------------------------------
// Failures on the far side
// ---------------------------------------------------------------------------

test('a refused token exchange points at the registered callback URL', async (t) => {
  const r = await rig();
  r.auth.token = { status: 400, body: { error: 'invalid_grant' } };
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_FLOW_FAILED);
  assert.match(r.stderr(), /invalid_grant/);
  // The failure this command will actually produce in the field.
  assert.match(r.stderr(), /Callback URL in the developer console/);
  assert.equal(r.storeFile(), undefined);
  assertNoSecrets(r);
});

test('a grant without offline_access is refused instead of stored', async (t) => {
  const r = await rig();
  r.auth.token = {
    status: 200,
    body: tokenResponse({ refresh_token: undefined, scope: 'read:jira-work' }),
  };
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_FLOW_FAILED);
  assert.match(r.stderr(), /no refresh token/);
  assert.match(r.stderr(), /offline_access/);
  // Discovery never ran: there is nothing worth discovering for a credential
  // that dies at the first expiry.
  assert.equal(r.auth.calls.length, 1);
  assert.equal(r.storeFile(), undefined);
});

test('login lists the candidates when the grant covers several sites and none is pinned', async (t) => {
  const r = await rig();
  r.auth.resources = { status: 200, body: twoSites() };
  t.after(() => r.cleanup());

  const code = await run(r.options);

  assert.equal(code, EXIT_FLOW_FAILED);
  assert.match(r.stderr(), /acme\.atlassian\.net/);
  assert.match(r.stderr(), /globex\.atlassian\.net/);
  assert.equal(r.storeFile(), undefined);
});

test('login --site picks one of several sites by URL', async (t) => {
  const r = await rig();
  r.auth.resources = { status: 200, body: twoSites() };
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--site', OTHER_SITE_URL] });

  assert.equal(code, EXIT_OK);
  assert.equal(storedEntry(r.storeFile())?.['cloudId'], OTHER_CLOUD_ID);
  assertContains(r.stdout(), OTHER_SITE_URL);
});

test('login --cloud-id picks one of several sites by id', async (t) => {
  const r = await rig();
  r.auth.resources = { status: 200, body: twoSites() };
  t.after(() => r.cleanup());

  const code = await run({ ...r.options, argv: ['--cloud-id', OTHER_CLOUD_ID] });

  assert.equal(code, EXIT_OK);
  assert.equal(storedEntry(r.storeFile())?.['site'], OTHER_SITE_URL);
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test('logout removes the profile and says the grant is still live upstream', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  assert.equal(await run(r.options), EXIT_OK);
  assert.notEqual(storedEntry(r.storeFile()), undefined);

  const code = await runLogout(r.options);

  assert.equal(code, EXIT_OK);
  assert.equal(storedEntry(r.storeFile()), undefined);
  assert.match(r.stdout(), /Removed the stored OAuth tokens for profile "default"/);
  // Local only: nothing here revokes anything at Atlassian, and the operator
  // must not be left believing otherwise.
  assert.match(r.stdout(), /removed local credentials only/);
  assert.match(r.stdout(), /connected apps/);
});

test('logout --all empties a store holding several profiles', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  assert.equal(await run(r.options), EXIT_OK);
  assert.equal(await run({ ...r.options, argv: ['--profile', 'sandbox'] }), EXIT_OK);

  const code = await runLogout({ ...r.options, argv: ['--all'] });

  assert.equal(code, EXIT_OK);
  assert.deepEqual(r.storeFile()?.['tokens'], {});
  assert.match(r.stdout(), /Removed 2 profiles \(default, sandbox\)/);
});

test('logout on a store that was never written says there was nothing to remove', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await runLogout(r.options);

  assert.equal(code, EXIT_OK);
  assert.match(r.stdout(), /No stored OAuth tokens for profile "default"/);
  assert.equal(r.storeFile(), undefined);
});

test('logout --all with --profile is a usage error, not a guess', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await runLogout({ ...r.options, argv: ['--all', '--profile', 'sandbox'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /--all removes every profile/);
  assert.match(r.stderr(), /Usage: jira-mcp-ai logout/);
});

test('logout --help says the deletion is local only', async (t) => {
  const r = await rig();
  t.after(() => r.cleanup());

  const code = await runLogout({ ...r.options, argv: ['--help'] });

  assert.equal(code, EXIT_OK);
  assert.match(r.stdout(), /This is local only/);
  assert.match(r.stdout(), /revoke the grant/);
});
