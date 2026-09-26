// `jira-mcp-ai login` / `logout` — the OAuth 2.0 (3LO) browser flow (AUTH.md, D91).
//
// The properties this module owns, in the order they bite:
//
//  1. **The callback listener is loopback-only and short-lived.** It binds
//     `127.0.0.1` explicitly — not `::`, not the hostname `localhost` — and is
//     closed in a `finally`. Binding the wildcard would put an endpoint that
//     accepts authorization codes on every interface of the machine; leaking the
//     listener would leave a CLI process alive with nothing to do (CC-104).
//  2. **`state` is compared in constant time and BEFORE the exchange.** A
//     mismatch means the callback did not come from the authorization we
//     started, so the code in it is not ours to spend (CC-97).
//  3. **Nothing here reaches the wire directly.** The token endpoint and
//     accessible-resources are called through `AuthRequestFn` from
//     `core/http.ts`, which is still the only module that knows what `fetch` is
//     (D93).
//  4. **No token is ever printed.** Every token is registered with the redactor
//     the moment it is parsed, so even a message nobody anticipated comes out
//     blanked. The report prints the site, the cloudId, the granted scopes and
//     where the credentials were stored — never the credentials.
//
// Exit codes match the rest of the CLI: 0 signed in, 1 the flow failed, 2 a
// usage or configuration error prevented the flow from starting.

import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { systemClock } from '../core/clock.js';
import {
  nodeEnvFileHost,
  type EnvFileHost,
  type EnvFileOptions,
} from '../core/config.js';
import { effectiveCredentials } from '../core/credentials.js';
import { createJiraError, toJiraError } from '../core/errors.js';
import { createAuthRequest, type AuthRequestFn } from '../core/http.js';
import { createLogger, NO_CID } from '../core/log.js';
import {
  accessibleResourcesEndpoint,
  buildAuthorizeUrl,
  createPkcePair,
  createTokenStore,
  exchangeAuthorizationCode,
  nodeCryptoRandom,
  parseAccessibleSites,
  profileKey,
  randomUrlToken,
  selectSite,
  STATE_BYTES,
  type CryptoRandom,
  type StoredTokens,
  type TokenStore,
} from '../core/oauth.js';
import { createRedactor } from '../core/redact.js';
import { loadSettings } from '../core/settings.js';
import type { Clock, Logger, Redactor, Settings } from '../core/types.js';

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** Signed in (or signed out) successfully. */
export const EXIT_OK = 0;
/** The flow started but did not produce a usable credential. */
export const EXIT_FLOW_FAILED = 1;
/** A usage error, or a configuration that cannot support the flow at all. */
export const EXIT_CONFIG = 2;

// ---------------------------------------------------------------------------
// Loopback constants
// ---------------------------------------------------------------------------

/**
 * The interface the callback listener binds, and the literal that goes into
 * `redirect_uri`.
 *
 * The IP literal rather than the name `localhost` is RFC 8252's recommendation,
 * and on a dual-stack machine it is the difference between working and hanging:
 * `localhost` resolves to `::1` on many systems while this server listens on
 * IPv4 only, and the browser's callback would then arrive nowhere while the CLI
 * waits out its whole timeout.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/** The one path the listener answers. Everything else gets a 404. */
export const CALLBACK_PATH = '/callback';

/** How long to wait for the browser before giving up, when `--timeout` is absent. */
export const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * The `redirect_uri` sent to `/authorize` and repeated on the token exchange.
 *
 * Exported because it is a coupling point with the operator: Atlassian matches
 * it against the Callback URL registered in the developer console byte for byte,
 * and the same string must appear in both requests or the exchange fails with a
 * message that blames the code instead of the URL.
 */
export function redirectUriFor(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(port)}${CALLBACK_PATH}`;
}

/**
 * Appended to whatever the token endpoint said when the exchange leg fails.
 *
 * Worth its own sentence because it is the failure this command will actually
 * produce in the field: Atlassian compares `redirect_uri` against the registered
 * Callback URL exactly, and a mismatched port answers with an error that blames
 * the authorization code instead of the URL that carried it.
 */
const REDIRECT_MISMATCH_HINT =
  "If the credentials themselves are right, check that the app's Callback URL in the " +
  'developer console is exactly the redirect URI printed above — Atlassian compares ' +
  'them character for character, port included.';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface LoginFlags {
  readonly profile?: string;
  readonly site?: string;
  readonly cloudId?: string;
  readonly noBrowser: boolean;
  readonly json: boolean;
  readonly timeoutSeconds: number;
  readonly help: boolean;
}

interface LogoutFlags {
  readonly profile?: string;
  readonly all: boolean;
  readonly help: boolean;
}

type ParseResult<T> =
  | { readonly ok: true; readonly flags: T }
  | { readonly ok: false; readonly message: string };

/** The `--help` text for `login`; also printed above a usage error. */
export function loginUsage(): string {
  return [
    'Usage: jira-mcp-ai login [options]',
    '',
    'Authorize this server against a Jira Cloud site with OAuth 2.0 (3LO) and',
    'store the resulting tokens locally. Opens a browser and waits for the',
    `callback on http://${LOOPBACK_HOST}:<JIRA_OAUTH_REDIRECT_PORT>${CALLBACK_PATH}.`,
    '',
    'Options:',
    '  --profile NAME     Store the tokens under this profile instead of the default.',
    '  --site SITE        Pick the site by URL or name when the account has several.',
    '  --cloud-id ID      Pick the site by cloudId instead.',
    '  --no-browser       Print the authorization URL instead of opening it.',
    '  --json             Print one machine-readable result object instead of text.',
    `  --timeout SECONDS  How long to wait for the browser (default ${String(DEFAULT_TIMEOUT_SECONDS)}).`,
    '  -h, --help         Show this text.',
    '',
    'JIRA_OAUTH_REDIRECT_PORT must match the Callback URL registered for your app',
    'in the Atlassian developer console — the two are compared exactly.',
    '',
    'Exit codes: 0 signed in, 1 the flow failed, 2 usage or config error.',
    '',
  ].join('\n');
}

/** The `--help` text for `logout`. */
export function logoutUsage(): string {
  return [
    'Usage: jira-mcp-ai logout [options]',
    '',
    'Delete stored OAuth tokens from the local token store.',
    '',
    'Options:',
    '  --profile NAME  Remove this profile instead of the default.',
    '  --all           Remove every profile in the store.',
    '  -h, --help      Show this text.',
    '',
    'This is local only: it deletes the credentials on this machine and does not',
    "revoke the grant, which stays listed in the Atlassian account's connected apps.",
    '',
    'Exit codes: 0 done, 2 usage or config error.',
    '',
  ].join('\n');
}

/**
 * Split `--flag=value` from `--flag value`.
 *
 * Both spellings exist in the wild and an operator who guesses wrong should not
 * be told their site name is an unknown option.
 */
function valueOf(
  arg: string,
  argv: readonly string[],
  index: number,
): { readonly value?: string; readonly next: number } {
  const eq = arg.indexOf('=');
  if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) return { next: index };
  return { value, next: index + 1 };
}

function nameOf(arg: string): string {
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
}

function parseLoginArgs(argv: readonly string[]): ParseResult<LoginFlags> {
  let profile: string | undefined;
  let site: string | undefined;
  let cloudId: string | undefined;
  let noBrowser = false;
  let json = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const name = nameOf(arg);
    switch (name) {
      case '--profile':
      case '--site':
      case '--cloud-id':
      case '--timeout': {
        const taken = valueOf(arg, argv, i);
        if (taken.value === undefined || taken.value === '') {
          return { ok: false, message: `${name} needs a value.` };
        }
        i = taken.next;
        if (name === '--profile') profile = taken.value;
        else if (name === '--site') site = taken.value;
        else if (name === '--cloud-id') cloudId = taken.value;
        else {
          const seconds = Number(taken.value);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            return {
              ok: false,
              message: `--timeout takes a positive number of seconds, not ${JSON.stringify(taken.value)}.`,
            };
          }
          timeoutSeconds = seconds;
        }
        break;
      }
      case '--no-browser':
        noBrowser = true;
        break;
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        return {
          ok: false,
          message: arg.startsWith('-')
            ? `Unknown option ${JSON.stringify(arg)}.`
            : `Unexpected argument ${JSON.stringify(arg)}; login takes options only.`,
        };
    }
  }

  return {
    ok: true,
    flags: {
      ...(profile === undefined ? {} : { profile }),
      ...(site === undefined ? {} : { site }),
      ...(cloudId === undefined ? {} : { cloudId }),
      noBrowser,
      json,
      timeoutSeconds,
      help,
    },
  };
}

function parseLogoutArgs(argv: readonly string[]): ParseResult<LogoutFlags> {
  let profile: string | undefined;
  let all = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const name = nameOf(arg);
    switch (name) {
      case '--profile': {
        const taken = valueOf(arg, argv, i);
        if (taken.value === undefined || taken.value === '') {
          return { ok: false, message: '--profile needs a value.' };
        }
        i = taken.next;
        profile = taken.value;
        break;
      }
      case '--all':
        all = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        return {
          ok: false,
          message: arg.startsWith('-')
            ? `Unknown option ${JSON.stringify(arg)}.`
            : `Unexpected argument ${JSON.stringify(arg)}; logout takes options only.`,
        };
    }
  }

  if (all && profile !== undefined) {
    return {
      ok: false,
      message: '--all removes every profile, so it cannot be combined with --profile.',
    };
  }

  return {
    ok: true,
    flags: { ...(profile === undefined ? {} : { profile }), all, help },
  };
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** The `--json` document: one object, never a token in it. */
export interface LoginReport {
  readonly ok: boolean;
  /** The store key the tokens were written under. */
  readonly profile: string;
  readonly site?: string;
  readonly siteName?: string;
  readonly cloudId?: string;
  readonly scopes?: readonly string[];
  /** Absolute epoch ms, straight from the `expires_in` the endpoint reported. */
  readonly expiresAt?: number;
  /** True when a refresh token was issued — `offline_access` was granted. */
  readonly refreshToken?: boolean;
  readonly storePath?: string;
  /** Permission bits as `chmod` spells them, when the platform has them. */
  readonly storeMode?: string;
  readonly error?: string;
  readonly remediation?: string;
}

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

/** Everything ambient, injectable. Defaults are the real host. */
export interface LoginOptions {
  /**
   * Arguments after the subcommand — `['--json']`, not `['login', '--json']`.
   * Defaults to none, for the same reason doctor does (CC-79): the dispatcher
   * has already split the subcommand off.
   */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly envFileHost?: EnvFileHost;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Defaults to a fresh redactor; the settings' secrets are registered either way. */
  readonly redactor?: Redactor;
  /** The report. Defaults to `process.stdout`. */
  readonly stdout?: (text: string) => void;
  /** Errors and diagnostics. Defaults to `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** Whether a human is watching; defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  /**
   * CSPRNG seam for the PKCE verifier and the `state` nonce.
   *
   * Separate from the injected `Rng`, which is documented as NOT a security
   * primitive (D96): a predictable `state` is a callback an attacker can forge.
   */
  readonly random?: CryptoRandom;
  /** The only network seam. Defaults to `createAuthRequest` over the two OAuth origins. */
  readonly authRequest?: AuthRequestFn;
  /** Token store. Defaults to the 0600 file at `JIRA_OAUTH_TOKEN_FILE`. */
  readonly store?: TokenStore;
  /**
   * Launch a browser at `url`; returns false when nothing could be launched.
   * Defaults to the platform's opener, best-effort.
   */
  readonly openBrowser?: (url: string) => boolean;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function unit(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** `0600`, the way `chmod` spells it — a decimal mode is a support ticket. */
function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * A duration in the largest unit that still reads as a number.
 *
 * Always derived from the `expires_in` the endpoint actually reported: Atlassian
 * documents no access-token lifetime anywhere, so any figure this CLI prints has
 * to come from the response rather than from a constant someone once measured.
 */
function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return unit(seconds, 'second', 'seconds');
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return unit(minutes, 'minute', 'minutes');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, 'hour', 'hours');
  return unit(Math.round(hours / 24), 'day', 'days');
}

// ---------------------------------------------------------------------------
// The loopback callback
// ---------------------------------------------------------------------------

/** Drop C0/C1 control characters (CC-144): the text is printed to a terminal. */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/**
 * Compare the `state` nonce without leaking where two values diverge.
 *
 * `timingSafeEqual` throws on unequal lengths, so the length is checked first —
 * and a length mismatch is simply a mismatch. There is nothing to protect there:
 * the length of the nonce is a constant this process chose, not a secret.
 */
export function sameState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const SUCCESS_PAGE = [
  '<!doctype html><meta charset="utf-8">',
  '<title>jira-mcp-ai</title>',
  '<body style="font:16px system-ui;margin:3rem">',
  '<h1>Authorized</h1>',
  '<p>You can close this tab and return to the terminal.</p>',
].join('');

function respond(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

interface Loopback {
  /** Resolves with the authorization code, or rejects when the callback is refused. */
  readonly received: Promise<string>;
  close(): Promise<void>;
}

/**
 * Start the one-request callback listener.
 *
 * It answers exactly one path on exactly one interface, and a request that is
 * not a usable callback gets a status code and nothing else: neither a 404 nor a
 * missing `code` may settle the flow, because a browser preflight, a favicon
 * request or a stray `curl` must not cancel a login the operator is still
 * completing in another tab (CC-104).
 */
async function startLoopback(args: {
  readonly port: number;
  readonly expectedState: string;
  readonly redactor: Redactor;
  /** Called for each code callback whose state is not ours (CC-246). */
  readonly onForeignState?: () => void;
}): Promise<Loopback> {
  let settle: (code: string) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const received = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Marks the promise as handled up front: when the timeout wins the race below
  // nobody is left awaiting this one, and a late rejection would otherwise
  // surface as an unhandled rejection that kills the process.
  received.catch(() => undefined);

  const server: Server = createServer((req, res) => {
    // `req.url` is origin-form (a path), so the base is a parsing formality.
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);

    if (url.pathname !== CALLBACK_PATH) {
      respond(res, 404, 'Not found. This listener only answers the OAuth callback.');
      return;
    }

    const providerError = url.searchParams.get('error');
    if (providerError !== null) {
      // An error redirect echoes our state too (RFC 6749 §4.1.2.1). One that
      // does not is not from the authorization we started — any page can
      // navigate here — so it must not end the login (CC-144).
      if (!sameState(args.expectedState, url.searchParams.get('state') ?? '')) {
        respond(res, 400, 'State mismatch; this callback was ignored.');
        return;
      }
      const description = url.searchParams.get('error_description');
      respond(res, 400, 'Authorization failed. You can close this tab.');
      fail(
        createJiraError({
          kind: 'auth',
          // Query text goes to a terminal: control characters (ANSI escapes
          // included) are dropped so it cannot repaint the screen.
          reason: `Atlassian refused the authorization: ${stripControl(providerError)}${
            description === null || description === ''
              ? ''
              : ` (${stripControl(description)})`
          }.`,
          remediation:
            'Approve the requested scopes in the browser, and check that the app in ' +
            'the developer console actually offers every scope in JIRA_OAUTH_SCOPES.',
          redactor: args.redactor,
        }),
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      respond(res, 400, 'Missing the "code" parameter; this is not an OAuth callback.');
      return;
    }

    // Constant-time, and BEFORE the code is handed to anyone: a callback whose
    // state is not ours did not come from the authorization we started, so its
    // code is not ours to spend (CC-97). Nor may it end the flow: any page can
    // navigate here, and a forged callback that aborted the login would let
    // it cancel every attempt the operator makes. Like a foreign error
    // redirect (CC-144), it is refused and the wait goes on (CC-246).
    if (!sameState(args.expectedState, url.searchParams.get('state') ?? '')) {
      respond(res, 400, 'State mismatch; this callback was ignored.');
      args.onForeignState?.();
      return;
    }

    respond(res, 200, SUCCESS_PAGE, 'text/html; charset=utf-8');
    settle(code);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: unknown): void => {
      reject(
        createJiraError({
          kind: 'config',
          reason: `The loopback callback listener could not bind ${LOOPBACK_HOST}:${String(args.port)}: ${
            error instanceof Error ? error.message : 'unknown error'
          }.`,
          remediation:
            'Free the port or set JIRA_OAUTH_REDIRECT_PORT to another one — and change the ' +
            'Callback URL registered for the app to match, because Atlassian compares them exactly.',
          cause: error,
          redactor: args.redactor,
        }),
      );
    };
    server.once('error', onListenError);
    // Host and port together: passing only a port binds every interface, which
    // would publish a code-accepting endpoint on the machine's LAN address.
    server.listen({ host: LOOPBACK_HOST, port: args.port }, () => {
      server.removeListener('error', onListenError);
      server.on('error', (error) => fail(error));
      resolve();
    });
  });

  return {
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A browser keeps the callback connection alive; without this the close
        // callback never fires and the CLI hangs after a successful login.
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

/** The platform's "open this URL" command, argv-style. */
function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin, and its FIRST quoted argument is a window title —
  // hence the empty string, without which a quoted URL becomes the title and
  // nothing opens.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Launch a browser, best-effort.
 *
 * Failure is not an error: a headless box, a container without `xdg-open`, or a
 * desktop session the CLI cannot reach all end with the operator opening the URL
 * themselves — which is why the URL is printed either way.
 */
function openBrowserWith(platform: NodeJS.Platform, url: string): boolean {
  const { command, args } = browserCommand(platform, url);
  try {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    // An ENOENT arrives asynchronously; without a listener it becomes an
    // uncaught exception in a CLI that was only ever being polite.
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/**
 * Run the browser flow and RETURN the exit code — the caller owns `process.exit`.
 *
 * Ordering matters and is deliberate: parse, load settings, refuse a
 * configuration that cannot work, refuse a non-interactive run, and only then
 * mint a nonce and open a socket. Everything that can be decided without side
 * effects is decided first, so a misconfigured run never leaves a listener or a
 * half-written store behind.
 */
export async function run(options: LoginOptions = {}): Promise<number> {
  const redactor = options.redactor ?? createRedactor();
  const writeOut =
    options.stdout ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const writeErr =
    options.stderr ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const out = (text: string): void => writeOut(redactor.redactString(text));
  const err = (text: string): void => writeErr(redactor.redactString(text));

  const parsed = parseLoginArgs(options.argv ?? []);
  if (!parsed.ok) {
    err(`${parsed.message}\n\n${loginUsage()}`);
    return EXIT_CONFIG;
  }
  const flags = parsed.flags;
  if (flags.help) {
    out(loginUsage());
    return EXIT_OK;
  }

  const clock = options.clock ?? systemClock;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envFileHost = options.envFileHost ?? nodeEnvFileHost;

  const envOptions: EnvFileOptions = {
    env,
    platform,
    host: envFileHost,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };

  const loaded = loadSettings({ ...envOptions, clock });
  // Before a single byte is written, exactly as doctor does: a client secret
  // that is already in the environment must not be able to reach stdout through
  // a message nobody anticipated.
  for (const secret of loaded.secrets) redactor.addSecret(secret);
  const settings: Settings = loaded.settings;
  const oauth = settings.oauth;

  const logger =
    options.logger ??
    createLogger({ level: settings.logLevel, clock, redactor, cid: NO_CID });

  const profile = flags.profile ?? settings.activeProfile;
  const key = profileKey(profile);
  const fail = (message: string, remediation: string, code: number): number => {
    if (flags.json) {
      emitJson(writeOut, redactor, {
        ok: false,
        profile: key,
        error: message,
        remediation,
      });
    } else err(`${message}\n${remediation}\n`);
    return code;
  };

  // --- configuration that cannot work, refused before anything is started ---

  if (settings.authMode !== 'oauth') {
    return fail(
      `login is the OAuth flow, but JIRA_AUTH_MODE is ${quote(settings.authMode)}.`,
      'Set JIRA_AUTH_MODE=oauth to use OAuth, or keep basic auth and configure JIRA_EMAIL and JIRA_API_TOKEN instead.',
      EXIT_CONFIG,
    );
  }
  const clientId = oauth.clientId;
  if (clientId === undefined || clientId === '') {
    return fail(
      'JIRA_OAUTH_CLIENT_ID is not set, so there is no app to authorize against.',
      'Create an OAuth 2.0 (3LO) app in the Atlassian developer console and set JIRA_OAUTH_CLIENT_ID to its Client ID.',
      EXIT_CONFIG,
    );
  }
  const clientSecret = oauth.clientSecret;
  if (clientSecret === undefined || clientSecret === '') {
    // Atlassian documents `client_secret` as required on both the code exchange
    // and every refresh, and its OIDC metadata does not advertise public
    // clients: PKCE is defence in depth here, not a way to do without a secret.
    // Failing now beats opening a browser for a flow that cannot complete.
    return fail(
      'JIRA_OAUTH_CLIENT_SECRET is not set, and Atlassian requires it on the token exchange.',
      'Copy the Secret from the same app in the developer console into JIRA_OAUTH_CLIENT_SECRET; PKCE does not replace it.',
      EXIT_CONFIG,
    );
  }

  const interactive = options.isTTY ?? process.stdin.isTTY === true;
  if (!interactive) {
    // The same rule as `doctor --save`, for a sharper reason: this command waits
    // for a human to click Accept in a browser. Inside a cron job or a CI step
    // that wait is a process that hangs until its timeout and then fails anyway.
    return fail(
      'login needs a terminal: stdin is not a TTY, so nobody can complete the browser flow.',
      'Run it from an interactive shell once; the server itself then refreshes the stored tokens without a browser.',
      EXIT_CONFIG,
    );
  }

  // --- the flow ---

  const random = options.random ?? nodeCryptoRandom;
  const authRequest =
    options.authRequest ??
    createAuthRequest({
      clock,
      logger,
      redactor,
      allowedOrigins: [oauth.authOrigin, oauth.gatewayOrigin],
      requestTimeoutMs: settings.requestTimeoutMs,
    });
  const store = options.store ?? createTokenStore({ path: oauth.tokenFile, clock });

  const pkce = createPkcePair(random);
  const state = randomUrlToken(random, STATE_BYTES);
  const redirectUri = redirectUriFor(oauth.redirectPort);
  const authorizeUrl = buildAuthorizeUrl({
    authOrigin: oauth.authOrigin,
    clientId,
    scopes: oauth.scopes,
    redirectUri,
    state,
    challenge: pkce.challenge,
  });

  let loopback: Loopback | undefined;
  // Which leg is in flight, so a failure can name the likeliest cause instead of
  // repeating the endpoint's own opaque `error` code back at the operator.
  let exchanging = false;
  let foreignCallbacks = 0;
  try {
    loopback = await startLoopback({
      port: oauth.redirectPort,
      expectedState: state,
      redactor,
      onForeignState: () => {
        foreignCallbacks += 1;
        // Once is enough to explain a stale tab; a page replaying the
        // callback in a loop must not flood the terminal.
        if (foreignCallbacks === 1) {
          err(
            'Ignored a callback whose state does not match this login; its authorization code was discarded unspent. ' +
              'Still waiting — complete the flow in the tab this login opened, not one from an earlier attempt.\n',
          );
        }
      },
    });

    if (!flags.json) {
      out(`jira-mcp-ai login — waiting for the callback on ${redirectUri}\n\n`);
    }
    const opened = flags.noBrowser
      ? false
      : (options.openBrowser ?? ((url: string) => openBrowserWith(platform, url)))(
          authorizeUrl,
        );
    if (!flags.json) {
      out(
        opened
          ? `A browser was opened. If nothing appeared, visit:\n${authorizeUrl}\n\n`
          : `Open this URL to authorize:\n${authorizeUrl}\n\n`,
      );
    } else if (!opened) {
      // stdout is the one JSON object, but a URL nobody can see is a login
      // nobody can finish: `--json --no-browser` waited out the timeout (CC-207).
      err(`Open this URL to authorize:\n${authorizeUrl}\n`);
    }

    // The wait, bounded. `clock.sleep` rather than a timer, so the whole flow is
    // assertable under the fake clock (`AbortSignal.timeout` is banned).
    const timeoutMs = flags.timeoutSeconds * 1000;
    const abort = new AbortController();
    const expiry = clock.sleep(timeoutMs, abort.signal).then(
      () => undefined,
      () => undefined,
    );
    let code: string | undefined;
    try {
      code = await Promise.race([loopback.received, expiry]);
    } finally {
      abort.abort();
    }

    if (code === undefined) {
      return fail(
        foreignCallbacks === 0
          ? `No callback arrived within ${describeDuration(timeoutMs)}, so the login was abandoned.`
          : `No callback for this login arrived within ${describeDuration(timeoutMs)}, so the login was abandoned; ${String(foreignCallbacks)} callback(s) with a state value that does not match were ignored and their codes discarded unexchanged.`,
        foreignCallbacks === 0
          ? 'Re-run the command and complete the authorization in the browser, or raise --timeout if the wait was genuinely too short.'
          : 'Re-run the command and complete the authorization in the browser tab it opens; a stale tab from an earlier attempt produces exactly this.',
        EXIT_FLOW_FAILED,
      );
    }

    // --- exchange ---

    // The exchange itself lives in `core/oauth.ts`, not here: it has to agree
    // with the refresh path about what a token response looks like and which
    // failures are terminal, and two copies of that would drift. It registers
    // the code, the verifier and both tokens with the redactor as it goes, so
    // nothing below this line can print one. `redirectUri` is the same string
    // that went into the authorize URL — Atlassian compares them.
    exchanging = true;
    const tokens = await exchangeAuthorizationCode({
      settings: oauth,
      authRequest,
      clock,
      code,
      redirectUri,
      verifier: pkce.verifier,
      redactor,
    });
    exchanging = false;

    if (tokens.refreshToken === undefined) {
      // Without one, the session dies at the first expiry and the server starts
      // demanding a browser in the middle of a tool call.
      return fail(
        'Atlassian issued an access token but no refresh token, so these credentials would stop working as soon as the access token expires.',
        'Add `offline_access` to JIRA_OAUTH_SCOPES (and to the app in the developer console), then run login again.',
        EXIT_FLOW_FAILED,
      );
    }

    // --- which site ---

    const resources = await authRequest({
      method: 'GET',
      url: accessibleResourcesEndpoint(oauth.gatewayOrigin),
      bearer: tokens.accessToken,
    });
    // Flags beat the environment; `selectSite` refuses to guess when the account
    // has several sites and neither says which. Note the ordering asymmetry that
    // is not a bug: accessible-resources ids are not globally unique, so `--site`
    // matches on URL or name rather than on the id.
    const wantedCloudId = flags.cloudId ?? oauth.cloudId;
    // The site of the profile being logged in, not of the active one: `--profile
    // work` must match work's JIRA_PROFILE_WORK_SITE (CC-166). `--cloud-id`
    // alone picks the site INSTEAD of the environment's, so that site is not
    // applied on top of it — it would refuse every other site of the grant
    // (CC-245). Both flags together still both apply.
    const wantedSite =
      flags.site ??
      (flags.cloudId === undefined
        ? effectiveCredentials(settings, profile).site
        : undefined);
    const site = selectSite(parseAccessibleSites(resources.json), {
      ...(wantedCloudId === undefined || wantedCloudId === ''
        ? {}
        : { cloudId: wantedCloudId }),
      ...(wantedSite === undefined || wantedSite === '' ? {} : { site: wantedSite }),
    });

    // --- persist, then report ---

    const stored: StoredTokens = {
      cloudId: site.id,
      site: site.url,
      clientId,
      scopes: tokens.scopes,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      obtainedAt: clock.now(),
    };
    await store.put(profile, stored);

    const mode = envFileHost.statFile(store.path);
    const report: LoginReport = {
      ok: true,
      profile: key,
      site: site.url,
      ...(site.name === undefined ? {} : { siteName: site.name }),
      cloudId: site.id,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
      refreshToken: true,
      storePath: store.path,
      ...(mode === undefined || platform === 'win32' ? {} : { storeMode: octal(mode) }),
    };

    if (flags.json) emitJson(writeOut, redactor, report);
    else out(renderLogin(report, tokens.expiresAt - clock.now()));
    return EXIT_OK;
  } catch (error) {
    const wrapped = toJiraError(error, { redactor });
    const base =
      wrapped.remediation ??
      'Run `jira-mcp-ai doctor` to see the whole configuration at once.';
    return fail(
      wrapped.message,
      exchanging ? `${base}\n${REDIRECT_MISMATCH_HINT}` : base,
      EXIT_FLOW_FAILED,
    );
  } finally {
    // A leaked listener in a CLI is a process that never exits, so this runs on
    // every path including the ones that threw before the flow got anywhere.
    await loopback?.close();
  }
}

/**
 * Emit the `--json` document.
 *
 * Redact the OBJECT and then serialize, deliberately bypassing the string pass
 * the prose path uses: the string redactor knows nothing about JSON, so a short
 * secret also matches inside the syntax and the document stops parsing (CC-78).
 */
function emitJson(
  writeOut: (text: string) => void,
  redactor: Redactor,
  report: LoginReport,
): void {
  writeOut(`${JSON.stringify(redactor.redact(report), null, 2)}\n`);
}

function renderLogin(report: LoginReport, remainingMs: number): string {
  const lines = [
    `Signed in to ${report.siteName ?? 'the site'} (${report.site ?? 'unknown'})`,
    `  cloudId   ${report.cloudId ?? 'unknown'}`,
    `  scopes    ${(report.scopes ?? []).join(' ')}`,
    `  expires   the access token expires in ${describeDuration(remainingMs)}; the refresh token renews it`,
    `  profile   ${report.profile}`,
    `  stored in ${report.storePath ?? 'unknown'}${
      report.storeMode === undefined ? '' : ` (mode ${report.storeMode})`
    }`,
    '',
    'A site listed here says nothing about what this account may do in it —',
    'run `jira-mcp-ai doctor` to check the permissions the tools actually need.',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

/**
 * Remove stored tokens and RETURN the exit code.
 *
 * Local only, and the output says so: Atlassian's revocation endpoint is not
 * part of the documented 3LO surface, so nothing here can honestly claim the
 * grant is gone. Deleting a credential must still not require hand-editing a
 * 0600 file, which is the whole reason this command exists.
 */
export async function runLogout(options: LoginOptions = {}): Promise<number> {
  const redactor = options.redactor ?? createRedactor();
  const writeOut =
    options.stdout ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const writeErr =
    options.stderr ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const out = (text: string): void => writeOut(redactor.redactString(text));
  const err = (text: string): void => writeErr(redactor.redactString(text));

  const parsed = parseLogoutArgs(options.argv ?? []);
  if (!parsed.ok) {
    err(`${parsed.message}\n\n${logoutUsage()}`);
    return EXIT_CONFIG;
  }
  const flags = parsed.flags;
  if (flags.help) {
    out(logoutUsage());
    return EXIT_OK;
  }

  const clock = options.clock ?? systemClock;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envFileHost = options.envFileHost ?? nodeEnvFileHost;

  const loaded = loadSettings({
    env,
    platform,
    host: envFileHost,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    clock,
  });
  for (const secret of loaded.secrets) redactor.addSecret(secret);
  const settings = loaded.settings;
  const store =
    options.store ?? createTokenStore({ path: settings.oauth.tokenFile, clock });

  try {
    if (flags.all) {
      // `TokenStore` has no "truncate" — and it should not: removing profile by
      // profile goes through the same locked read-modify-write as everything
      // else, so a concurrent refresh in another process cannot lose its write
      // to a wholesale overwrite.
      const file = await store.read();
      const keys: string[] = [];
      for (const key of Object.keys(file.tokens)) {
        // Only what actually went: a key that was not removed must not be
        // reported as gone while its refresh token stays on disk (CC-211).
        if (await store.remove(key)) keys.push(key);
      }
      out(
        keys.length === 0
          ? `No stored OAuth tokens in ${quote(store.path)}; nothing to remove.\n`
          : `Removed ${unit(keys.length, 'profile', 'profiles')} (${keys.join(', ')}) from ${quote(store.path)}.\n`,
      );
    } else {
      const profile = flags.profile ?? settings.activeProfile;
      const key = profileKey(profile);
      const removed = await store.remove(profile);
      out(
        removed
          ? `Removed the stored OAuth tokens for profile ${quote(key)} from ${quote(store.path)}.\n`
          : `No stored OAuth tokens for profile ${quote(key)} in ${quote(store.path)}; nothing to remove.\n`,
      );
    }
  } catch (error) {
    const wrapped = toJiraError(error, { redactor });
    err(`${wrapped.message}\n`);
    return EXIT_CONFIG;
  }

  out(
    'This removed local credentials only — the authorization itself is still listed\n' +
      "in the Atlassian account's connected apps until it is revoked there.\n",
  );
  return EXIT_OK;
}
