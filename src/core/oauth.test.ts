// Unit tests for the OAuth 2.0 (3LO) core: PKCE, the authorize URL, site
// discovery, token parsing, the 0600 token store, and the refreshing credential
// resolver.
//
// Nothing here reaches the network — every test injects a fake `AuthRequestFn`,
// and the suite runs under the repo's network fence, so a forgotten seam fails
// loudly rather than dialling Atlassian. Time comes from the fake clock, so the
// expiry arithmetic is asserted exactly instead of being slept through.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { createJiraError } from './errors.js';
import { createFakeClock } from './fakes/fakeClock.js';
import { createFakeLogger } from './fakes/fakeLogger.js';
import type { FakeLogger } from './fakes/fakeLogger.js';
import { createFakeRedactor } from './fakes/fakeRedactor.js';
import type {
  AuthRequestFn,
  AuthRequestSpec,
  AuthResponse,
  BearerCredentials,
  JiraCredentials,
} from './http.js';
import {
  ACCESSIBLE_RESOURCES_PATH,
  DEFAULT_PROFILE_KEY,
  OAUTH_AUDIENCE,
  PKCE_VERIFIER_BYTES,
  TERMINAL_TOKEN_ERRORS,
  TOKEN_REFRESH_SKEW_MS,
  TOKEN_STORE_VERSION,
  accessibleResourcesEndpoint,
  buildAuthorizeUrl,
  createOAuthCredentialResolver,
  createPkcePair,
  createTokenStore,
  exchangeAuthorizationCode,
  isExpired,
  isTerminalTokenError,
  nodeCryptoRandom,
  parseAccessibleSites,
  parseTokenResponse,
  profileKey,
  randomUrlToken,
  requireRefreshToken,
  selectSite,
  tokenEndpoint,
  tokenErrorCode,
  type AccessibleSite,
  type CryptoRandom,
  type LockedTokenStore,
  type OAuthTokens,
  type StoredTokens,
  type TokenStore,
} from './oauth.js';
import { JiraError, type Clock, type OAuthSettings } from './types.js';

const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'jira-mcp-oauth-'));
let dir = root;
let counter = 0;

beforeEach(() => {
  counter += 1;
  dir = join(root, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A deterministic `CryptoRandom`: byte `i` is `seed + i`, so output is stable. */
function countingRandom(seed = 0): CryptoRandom {
  return (bytes) => Uint8Array.from({ length: bytes }, (_, i) => (seed + i) % 256);
}

/** A programmable `AuthRequestFn` that records every spec it is handed. */
interface FakeAuthRequest {
  readonly fn: AuthRequestFn;
  readonly specs: readonly AuthRequestSpec[];
  /** How many requests have been started (including ones still pending). */
  calls(): number;
}

type AuthReply = AuthResponse | Error | (() => Promise<AuthResponse>);

function fakeAuthRequest(replies: readonly AuthReply[]): FakeAuthRequest {
  const specs: AuthRequestSpec[] = [];
  let index = 0;
  const fn: AuthRequestFn = (spec) => {
    specs.push(spec);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) return Promise.reject(new Error('no reply programmed'));
    if (reply instanceof Error) return Promise.reject(reply);
    if (typeof reply === 'function') return reply();
    return Promise.resolve(reply);
  };
  return { fn, specs, calls: () => specs.length };
}

function ok(json: unknown, status = 200): AuthResponse {
  return { status, json, text: JSON.stringify(json) };
}

/**
 * A failure shaped the way `createAuthRequest` raises one: the OAuth `error`
 * code lives in `detail`, never in a body the caller can inspect.
 */
function raised(status: number, code: string, kind: 'auth' | 'validation'): JiraError {
  return createJiraError({
    kind,
    reason: `Atlassian rejected POST /oauth/token with HTTP ${String(status)}.`,
    remediation: 'Check the client credentials.',
    httpStatus: status,
    detail: `${code}: the request was rejected`,
  });
}

const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_CLOUD_ID = '99999999-8888-7777-6666-555555555555';

function settings(overrides: Partial<OAuthSettings> = {}): OAuthSettings {
  return {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    scopes: ['read:jira-work', 'offline_access'],
    tokenFile: join(dir, 'oauth.json'),
    redirectPort: 8250,
    authOrigin: 'https://auth.atlassian.com',
    gatewayOrigin: 'https://api.atlassian.com',
    ...overrides,
  };
}

function storedTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    cloudId: CLOUD_ID,
    site: 'https://acme.atlassian.net',
    clientId: 'client-abc',
    scopes: ['read:jira-work', 'offline_access'],
    refreshToken: 'refresh-1',
    accessToken: 'access-1',
    expiresAt: 1_000_000 + 3600_000,
    obtainedAt: 1_000_000,
    ...overrides,
  };
}

/**
 * A clock whose `sleep` advances virtual time instead of waiting. Only the
 * contended-lock paths need it; an uncontended `mkdir` never sleeps.
 */
function autoClock(startMs: number): Clock {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      await Promise.resolve();
    },
  };
}

interface ResolverHarness {
  readonly resolve: ReturnType<typeof createOAuthCredentialResolver>;
  readonly auth: FakeAuthRequest;
  readonly logger: FakeLogger;
  readonly store: TokenStore;
  readonly path: string;
  onDisk(profile?: string): StoredTokens | undefined;
}

interface HarnessOptions {
  readonly seed?: StoredTokens | undefined;
  readonly replies?: readonly AuthReply[];
  readonly settings?: Partial<OAuthSettings>;
  readonly now?: number;
  readonly allowedHosts?: readonly string[];
  readonly decorate?: (store: TokenStore) => TokenStore;
}

function harness(options: HarnessOptions = {}): ResolverHarness {
  const path = join(dir, 'oauth.json');
  const clock = createFakeClock(options.now ?? 1_000_000);
  const real = createTokenStore({
    path,
    clock,
    lock: { acquireTimeoutMs: 200, retryDelayMs: 5 },
  });
  const seed = options.seed ?? storedTokens();
  writeFileSync(
    path,
    `${JSON.stringify({ version: TOKEN_STORE_VERSION, tokens: { [DEFAULT_PROFILE_KEY]: seed } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const store = options.decorate === undefined ? real : options.decorate(real);
  const auth = fakeAuthRequest(options.replies ?? []);
  const logger = createFakeLogger();
  const resolve = createOAuthCredentialResolver({
    settings: settings(options.settings),
    store,
    authRequest: auth.fn,
    clock,
    logger,
    redactor: createFakeRedactor(),
    allowedHosts: options.allowedHosts ?? ['api.atlassian.com'],
  });
  return {
    resolve,
    auth,
    logger,
    store,
    path,
    onDisk: (profile = DEFAULT_PROFILE_KEY) => {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        tokens: Record<string, StoredTokens>;
      };
      return raw.tokens[profile];
    },
  };
}

/** A store with no file at all — `harness` seeds one unless told otherwise. */
function emptyHarness(options: HarnessOptions = {}): ResolverHarness {
  const path = join(dir, 'missing.json');
  const clock = createFakeClock(options.now ?? 1_000_000);
  const store = createTokenStore({ path, clock });
  const auth = fakeAuthRequest(options.replies ?? []);
  const logger = createFakeLogger();
  const resolve = createOAuthCredentialResolver({
    settings: settings(options.settings),
    store,
    authRequest: auth.fn,
    clock,
    logger,
    allowedHosts: ['api.atlassian.com'],
  });
  return {
    resolve,
    auth,
    logger,
    store,
    path,
    onDisk: () => undefined,
  };
}

/** Start a resolve and normalise the sync-or-async return into a promise. */
function resolved(h: ResolverHarness, profile?: string): Promise<JiraCredentials> {
  return Promise.resolve(h.resolve(profile));
}

/** Start a resolve and narrow the result to the bearer arm of the union. */
async function bearer(h: ResolverHarness, profile?: string): Promise<BearerCredentials> {
  const credentials = await resolved(h, profile);
  if (credentials.kind !== 'bearer') {
    throw new assert.AssertionError({ message: 'expected bearer credentials' });
  }
  return credentials;
}

async function rejects(fn: () => Promise<unknown>): Promise<JiraError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to reject' });
}

function throws(fn: () => unknown): JiraError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw' });
}

// ---------------------------------------------------------------------------
// PKCE and nonces
// ---------------------------------------------------------------------------

describe('randomUrlToken', () => {
  it('emits unpadded base64url', () => {
    const token = randomUrlToken(countingRandom(), 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(token.length, 43);
  });

  it('refuses a byte count that is not a positive whole number', () => {
    for (const bytes of [0, -1, 1.5, Number.NaN]) {
      const error = throws(() => randomUrlToken(countingRandom(), bytes));
      assert.equal(error.kind, 'config');
    }
  });

  it('refuses a randomness source that returns short', () => {
    const short: CryptoRandom = (bytes) => new Uint8Array(Math.max(bytes - 1, 0));
    const error = throws(() => randomUrlToken(short, 32));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /less entropy/);
  });

  it('draws from the injected seam, not from the module', () => {
    const seen: number[] = [];
    const spy: CryptoRandom = (bytes) => {
      seen.push(bytes);
      return countingRandom()(bytes);
    };
    randomUrlToken(spy, 16);
    assert.deepEqual(seen, [16]);
  });
});

describe('createPkcePair', () => {
  it('derives the challenge as base64url(sha256(verifier)) with method S256', () => {
    const pair = createPkcePair(countingRandom(7));
    assert.equal(pair.method, 'S256');
    assert.equal(
      pair.challenge,
      createHash('sha256').update(pair.verifier, 'ascii').digest('base64url'),
    );
  });

  it('produces a verifier inside the RFC 7636 length range', () => {
    const pair = createPkcePair(countingRandom());
    assert.ok(pair.verifier.length >= 43 && pair.verifier.length <= 128);
    assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  });

  it('refuses a randomness source that shortchanges the PKCE draw', () => {
    // 16 bytes is 22 base64url characters — below the RFC's floor of 43. The
    // entropy guard catches it first, which is the right order: a short draw is
    // a weak verifier whether or not the encoded length happens to pass.
    const error = throws(() => createPkcePair(() => new Uint8Array(16)));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /less entropy/);
  });

  it('asks the seam for PKCE_VERIFIER_BYTES bytes', () => {
    let asked = 0;
    createPkcePair((bytes) => {
      asked = bytes;
      return countingRandom()(bytes);
    });
    assert.equal(asked, PKCE_VERIFIER_BYTES);
  });

  it('the production seam produces distinct verifiers', () => {
    const a = createPkcePair(nodeCryptoRandom);
    const b = createPkcePair(nodeCryptoRandom);
    assert.notEqual(a.verifier, b.verifier);
  });
});

describe('profileKey', () => {
  it('folds nothing, blank and whitespace onto the default key', () => {
    assert.equal(profileKey(), DEFAULT_PROFILE_KEY);
    assert.equal(profileKey(''), DEFAULT_PROFILE_KEY);
    assert.equal(profileKey('   '), DEFAULT_PROFILE_KEY);
  });

  it('trims and lowercases a named profile', () => {
    assert.equal(profileKey('  Ops  '), 'ops');
  });
});

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  const input = {
    authOrigin: 'https://auth.atlassian.com',
    clientId: 'client-abc',
    scopes: ['read:jira-work', 'offline_access'],
    redirectUri: 'http://localhost:8250/callback',
    state: 'state-nonce',
    challenge: 'challenge-value',
  };

  it('carries audience and prompt=consent, which are the two easy ones to drop', () => {
    const url = new URL(buildAuthorizeUrl(input));
    assert.equal(url.searchParams.get('audience'), OAUTH_AUDIENCE);
    assert.equal(url.searchParams.get('prompt'), 'consent');
  });

  it('carries the rest of the documented parameters', () => {
    const url = new URL(buildAuthorizeUrl(input));
    assert.equal(url.origin, 'https://auth.atlassian.com');
    assert.equal(url.pathname, '/authorize');
    assert.equal(url.searchParams.get('client_id'), 'client-abc');
    assert.equal(url.searchParams.get('scope'), 'read:jira-work offline_access');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8250/callback');
    assert.equal(url.searchParams.get('state'), 'state-nonce');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  });

  it('never sends the client secret to the browser', () => {
    const url = buildAuthorizeUrl(input);
    assert.ok(!url.includes('client_secret'));
    assert.ok(!url.includes('secret-xyz'));
  });

  it('tolerates a trailing slash on the origin', () => {
    const url = new URL(
      buildAuthorizeUrl({ ...input, authOrigin: 'https://auth.example/' }),
    );
    assert.equal(url.pathname, '/authorize');
    assert.equal(url.origin, 'https://auth.example');
  });

  it('refuses an empty client id', () => {
    const error = throws(() => buildAuthorizeUrl({ ...input, clientId: '  ' }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /JIRA_OAUTH_CLIENT_ID/);
  });

  it('refuses an empty scope list', () => {
    const error = throws(() => buildAuthorizeUrl({ ...input, scopes: ['  ', ''] }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /grant nothing/);
  });

  it('refuses a scope containing whitespace, which would silently become two', () => {
    const error = throws(() =>
      buildAuthorizeUrl({ ...input, scopes: ['read:jira-work write:jira-work'] }),
    );
    assert.equal(error.kind, 'config');
    assert.match(error.message, /nobody asked for/);
  });

  it('refuses a missing redirect uri, state or challenge', () => {
    for (const patch of [{ redirectUri: '' }, { state: '' }, { challenge: '' }]) {
      const error = throws(() => buildAuthorizeUrl({ ...input, ...patch }));
      assert.equal(error.kind, 'config');
    }
  });

  it('refuses an unusable auth origin', () => {
    const error = throws(() => buildAuthorizeUrl({ ...input, authOrigin: 'not a url' }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /not a usable origin/);
  });
});

describe('endpoints', () => {
  it('puts the token endpoint on the auth origin', () => {
    assert.equal(
      tokenEndpoint('https://auth.atlassian.com'),
      'https://auth.atlassian.com/oauth/token',
    );
  });

  it('puts accessible-resources on the gateway origin', () => {
    assert.equal(
      accessibleResourcesEndpoint('https://api.atlassian.com'),
      `https://api.atlassian.com${ACCESSIBLE_RESOURCES_PATH}`,
    );
  });

  it('refuses a gateway origin that is not a URL', () => {
    const error = throws(() => accessibleResourcesEndpoint('::::'));
    assert.equal(error.kind, 'config');
  });
});

// ---------------------------------------------------------------------------
// Discovery and site selection
// ---------------------------------------------------------------------------

describe('parseAccessibleSites', () => {
  it('reads the documented shape', () => {
    const sites = parseAccessibleSites([
      {
        id: CLOUD_ID,
        url: 'https://acme.atlassian.net',
        name: 'Acme',
        scopes: ['read:jira-work', 42],
        avatarUrl: 'https://example/x.png',
      },
    ]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.id, CLOUD_ID);
    assert.equal(sites[0]?.url, 'https://acme.atlassian.net');
    assert.equal(sites[0]?.name, 'Acme');
    // The non-string scope is dropped rather than stringified.
    assert.deepEqual(sites[0]?.scopes, ['read:jira-work']);
  });

  it('omits name and scopes when the response omits them', () => {
    const sites = parseAccessibleSites([
      { id: CLOUD_ID, url: 'https://acme.atlassian.net' },
    ]);
    assert.equal(sites[0]?.name, undefined);
    assert.equal(sites[0]?.scopes, undefined);
  });

  it('refuses a body that is not an array', () => {
    const error = throws(() => parseAccessibleSites({ values: [] }));
    assert.equal(error.kind, 'unexpected_shape');
  });

  it('refuses a malformed entry rather than skipping it', () => {
    for (const entry of [
      null,
      'x',
      { url: 'https://acme.atlassian.net' },
      { id: CLOUD_ID },
    ]) {
      const error = throws(() => parseAccessibleSites([entry]));
      assert.equal(error.kind, 'unexpected_shape');
    }
  });
});

describe('selectSite', () => {
  const acme: AccessibleSite = {
    id: CLOUD_ID,
    url: 'https://acme.atlassian.net',
    name: 'Acme',
  };
  const beta: AccessibleSite = {
    id: OTHER_CLOUD_ID,
    url: 'https://beta.atlassian.net',
    name: 'Beta Sandbox',
  };

  it('returns the only site when the grant covers one', () => {
    assert.equal(selectSite([acme]).id, CLOUD_ID);
  });

  it('[CC-103] multi-site discovery with no pin is an error that lists the candidates', () => {
    const error = throws(() => selectSite([acme, beta]));
    assert.equal(error.kind, 'config');
    assert.equal(error.retryable, false);
    // Both candidates, both cloudIds — an operator can copy one straight out.
    assert.match(error.message, /2 Jira sites/);
    assert.match(error.message, /https:\/\/acme\.atlassian\.net/);
    assert.match(error.message, /https:\/\/beta\.atlassian\.net/);
    assert.ok(error.message.includes(CLOUD_ID));
    assert.ok(error.message.includes(OTHER_CLOUD_ID));
    assert.match(error.message, /--site|JIRA_OAUTH_CLOUD_ID/);
  });

  it('matches a site label exactly, never as a prefix', () => {
    const twin: AccessibleSite = {
      id: OTHER_CLOUD_ID,
      url: 'https://acme-sandbox.atlassian.net',
    };
    // `acme` must not also match `acme-sandbox`, or the pin would be ambiguous
    // exactly when the operator was being specific.
    assert.equal(selectSite([acme, twin], { site: 'acme' }).id, CLOUD_ID);
    assert.equal(selectSite([acme, twin], { site: 'acme-sandbox' }).id, OTHER_CLOUD_ID);
  });

  it('never picks silently when two sites still match the pin', () => {
    // `name` is not unique — two containers can carry the same display name.
    const twin: AccessibleSite = {
      id: OTHER_CLOUD_ID,
      url: 'https://acme-sandbox.atlassian.net',
      name: 'Acme',
    };
    const error = throws(() => selectSite([acme, twin], { site: 'Acme' }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /2 Jira sites/);
    assert.match(error.message, /acme-sandbox/);
  });

  it('matches --site on the full url, the host, the first label and the name', () => {
    for (const wanted of [
      'https://acme.atlassian.net',
      'https://acme.atlassian.net/',
      'acme.atlassian.net',
      'ACME',
      'Acme',
    ]) {
      assert.equal(selectSite([acme, beta], { site: wanted }).id, CLOUD_ID, wanted);
    }
  });

  it('pins on cloudId', () => {
    assert.equal(
      selectSite([acme, beta], { cloudId: OTHER_CLOUD_ID }).id,
      OTHER_CLOUD_ID,
    );
  });

  it('lists the grant when the pinned cloudId is not in it', () => {
    const error = throws(() => selectSite([acme, beta], { cloudId: 'nope' }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /https:\/\/beta\.atlassian\.net/);
    assert.match(error.message, /JIRA_OAUTH_CLOUD_ID/);
  });

  it('lists the grant when --site matches nothing', () => {
    const error = throws(() => selectSite([acme, beta], { site: 'gamma' }));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /No accessible site matches/);
    assert.match(error.message, /https:\/\/acme\.atlassian\.net/);
  });

  it('collapses two containers that share one id and url, and unions their scopes', () => {
    // The docs are explicit that `id` is not unique across containers: a Jira
    // and a Confluence row for one site are one choice, not an ambiguity.
    const jira: AccessibleSite = { ...acme, scopes: ['read:jira-work'] };
    const confluence: AccessibleSite = {
      ...acme,
      scopes: ['read:confluence-space.summary'],
    };
    const chosen = selectSite([jira, confluence]);
    assert.equal(chosen.id, CLOUD_ID);
    assert.deepEqual([...(chosen.scopes ?? [])].sort(), [
      'read:confluence-space.summary',
      'read:jira-work',
    ]);
  });

  it('keeps two different sites that share an id ambiguous', () => {
    const sameIdOtherSite: AccessibleSite = {
      id: CLOUD_ID,
      url: 'https://beta.atlassian.net',
    };
    const error = throws(() => selectSite([acme, sameIdOtherSite]));
    assert.match(error.message, /2 Jira sites/);
  });

  it('refuses a grant that covers no site at all', () => {
    const error = throws(() => selectSite([]));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /no Jira site/);
  });

  it('ignores a blank pin instead of filtering everything away', () => {
    assert.equal(selectSite([acme], { cloudId: '  ', site: '  ' }).id, CLOUD_ID);
  });

  it('does not crash on a site whose url will not parse', () => {
    const broken: AccessibleSite = {
      id: OTHER_CLOUD_ID,
      url: 'not a url',
      name: 'Broken',
    };
    // The name still matches; the unparseable url just fails to match a host.
    assert.equal(selectSite([acme, broken], { site: 'Broken' }).id, OTHER_CLOUD_ID);
    const error = throws(() => selectSite([acme, broken], { site: 'nothing' }));
    assert.match(error.message, /No accessible site matches/);
  });
});

// ---------------------------------------------------------------------------
// Token responses
// ---------------------------------------------------------------------------

describe('parseTokenResponse', () => {
  it('turns the documented response into an absolute expiry on the injected clock', () => {
    const tokens = parseTokenResponse(
      {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'read:jira-work offline_access',
      },
      1_000_000,
    );
    assert.equal(tokens.accessToken, 'at-1');
    assert.equal(tokens.refreshToken, 'rt-1');
    assert.equal(tokens.expiresAt, 1_000_000 + 3_600_000);
    assert.deepEqual(tokens.scopes, ['read:jira-work', 'offline_access']);
  });

  it('ignores token_type, which no documented example carries', () => {
    const tokens = parseTokenResponse(
      { access_token: 'at-1', expires_in: 60, token_type: 'MAC' },
      0,
    );
    assert.equal(tokens.accessToken, 'at-1');
  });

  it('accepts a refresh token being absent — the documented example omits one', () => {
    const tokens = parseTokenResponse({ access_token: 'at-1', expires_in: 60 }, 0);
    assert.equal(tokens.refreshToken, undefined);
    assert.deepEqual(tokens.scopes, []);
  });

  it('refuses a response with no usable expires_in rather than inventing a lifetime', () => {
    for (const expires of [undefined, 0, -1, 'soon', null, Number.POSITIVE_INFINITY]) {
      const error = throws(() =>
        parseTokenResponse({ access_token: 'at-1', expires_in: expires }, 0),
      );
      assert.equal(error.kind, 'unexpected_shape');
      assert.match(error.message, /expires_in/);
    }
  });

  it('accepts a numeric expires_in delivered as a string', () => {
    const tokens = parseTokenResponse({ access_token: 'at-1', expires_in: '120' }, 0);
    assert.equal(tokens.expiresAt, 120_000);
  });

  it('refuses a missing access token and a non-object body', () => {
    assert.equal(
      throws(() => parseTokenResponse({ expires_in: 60 }, 0)).kind,
      'unexpected_shape',
    );
    assert.equal(throws(() => parseTokenResponse('nope', 0)).kind, 'unexpected_shape');
  });

  it('refuses an empty refresh token', () => {
    const error = throws(() =>
      parseTokenResponse({ access_token: 'at-1', expires_in: 60, refresh_token: '' }, 0),
    );
    assert.match(error.message, /empty refresh_token/);
  });
});

describe('requireRefreshToken', () => {
  it('returns the token when there is one', () => {
    const tokens: OAuthTokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      scopes: [],
    };
    assert.equal(requireRefreshToken(tokens), 'r');
  });

  it('names offline_access when there is none', () => {
    const tokens: OAuthTokens = { accessToken: 'a', expiresAt: 1, scopes: [] };
    const error = throws(() => requireRefreshToken(tokens));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /offline_access/);
  });
});

describe('isExpired', () => {
  const tokens: OAuthTokens = { accessToken: 'a', expiresAt: 1_000_000, scopes: [] };

  it('treats the skew window as already expired', () => {
    assert.equal(isExpired(tokens, 1_000_000 - TOKEN_REFRESH_SKEW_MS - 1), false);
    assert.equal(isExpired(tokens, 1_000_000 - TOKEN_REFRESH_SKEW_MS), true);
    assert.equal(isExpired(tokens, 1_000_000), true);
  });
});

describe('tokenErrorCode / isTerminalTokenError', () => {
  it('reads the error code out of a rejection body', () => {
    assert.equal(tokenErrorCode({ error: 'invalid_grant' }), 'invalid_grant');
    assert.equal(tokenErrorCode({ error: '' }), undefined);
    assert.equal(tokenErrorCode('nope'), undefined);
  });

  it('treats every documented dead code as terminal on 400 and 403', () => {
    for (const code of TERMINAL_TOKEN_ERRORS) {
      assert.equal(isTerminalTokenError(400, { error: code }), true, code);
      assert.equal(isTerminalTokenError(403, { error: code }), true, code);
    }
  });

  it('does not treat a transient failure as terminal', () => {
    assert.equal(isTerminalTokenError(500, { error: 'invalid_grant' }), false);
    assert.equal(isTerminalTokenError(429, { error: 'invalid_grant' }), false);
    assert.equal(isTerminalTokenError(400, { error: 'slow_down' }), false);
    assert.equal(isTerminalTokenError(400, {}), false);
  });
});

// ---------------------------------------------------------------------------
// The token store
// ---------------------------------------------------------------------------

describe('createTokenStore', () => {
  function store(name = 'oauth.json'): TokenStore {
    return createTokenStore({
      path: join(dir, name),
      clock: autoClock(1_000_000),
      lock: { acquireTimeoutMs: 200, retryDelayMs: 5 },
    });
  }

  it('reads an empty store when the file does not exist yet', async () => {
    const file = await store().read();
    assert.equal(file.version, TOKEN_STORE_VERSION);
    assert.deepEqual(file.tokens, {});
  });

  it('round-trips an entry and writes the file 0600', async (t) => {
    const s = store();
    await s.put(undefined, storedTokens());
    const back = await s.get();
    assert.deepEqual(back, storedTokens());
    if (!POSIX) {
      t.skip('mode bits are POSIX-only');
      return;
    }
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
  });

  it('keeps profiles apart and folds the default key', async () => {
    const s = store();
    await s.put(undefined, storedTokens({ refreshToken: 'default-r' }));
    await s.put('Ops', storedTokens({ refreshToken: 'ops-r' }));
    assert.equal((await s.get())?.refreshToken, 'default-r');
    assert.equal((await s.get('ops'))?.refreshToken, 'ops-r');
    assert.equal((await s.get('OPS'))?.refreshToken, 'ops-r');
    const file = await s.read();
    assert.deepEqual(Object.keys(file.tokens).sort(), ['default', 'ops']);
  });

  it('reports whether remove found anything, and leaves no temp files behind', async () => {
    const s = store();
    await s.put('ops', storedTokens());
    assert.equal(await s.remove('ops'), true);
    assert.equal(await s.remove('ops'), false);
    assert.equal(await s.get('ops'), undefined);
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('reports a read failure that is not a missing file', async () => {
    const s = store('a-directory.json');
    mkdirSync(s.path, { recursive: true });
    const error = await rejects(() => s.read());
    assert.equal(error.kind, 'config');
    assert.match(error.message, /could not be read/);
  });

  it('refuses a file that is not valid JSON', async () => {
    const s = store('broken.json');
    writeFileSync(s.path, '{ not json', { mode: 0o600 });
    const error = await rejects(() => s.read());
    assert.equal(error.kind, 'config');
    assert.match(error.message, /not valid JSON/);
    assert.match(error.message, /login/);
  });

  it('refuses a store written by a future version, and names both numbers', async () => {
    const s = store('v2.json');
    writeFileSync(s.path, JSON.stringify({ version: 2, tokens: {} }), { mode: 0o600 });
    const error = await rejects(() => s.read());
    assert.match(error.message, /version 2/);
    assert.match(error.message, /version 1/);
  });

  it('refuses a store whose version is not even a number', async () => {
    const s = store('vx.json');
    writeFileSync(s.path, JSON.stringify({ version: { a: 1 }, tokens: {} }), {
      mode: 0o600,
    });
    const error = await rejects(() => s.read());
    assert.match(error.message, /nothing recognisable/);
  });

  it('refuses a store with no tokens object', async () => {
    const s = store('notokens.json');
    writeFileSync(s.path, JSON.stringify({ version: 1 }), { mode: 0o600 });
    const error = await rejects(() => s.read());
    assert.match(error.message, /`tokens` object/);
  });

  it('names the damaged field of a damaged entry', async () => {
    const cases: readonly (readonly [unknown, RegExp])[] = [
      ['nope', /not an object/],
      [{ ...storedTokens(), cloudId: '' }, /cloudId/],
      [{ ...storedTokens(), site: undefined }, /site/],
      [{ ...storedTokens(), clientId: 42 }, /clientId/],
      [{ ...storedTokens(), refreshToken: '' }, /refreshToken/],
      [{ ...storedTokens(), scopes: 'read' }, /scopes/],
      [{ ...storedTokens(), obtainedAt: 'now' }, /obtainedAt/],
      [{ ...storedTokens(), accessToken: '' }, /accessToken/],
      [{ ...storedTokens(), expiresAt: 'soon' }, /expiresAt/],
    ];
    let index = 0;
    for (const [entry, pattern] of cases) {
      index += 1;
      const s = store(`damaged-${String(index)}.json`);
      writeFileSync(s.path, JSON.stringify({ version: 1, tokens: { default: entry } }), {
        mode: 0o600,
      });
      const error = await rejects(() => s.read());
      assert.equal(error.kind, 'config');
      assert.match(error.message, pattern);
    }
  });

  it('serializes concurrent writers in one process instead of racing the lock', async () => {
    const s = store();
    await Promise.all([
      s.put('a', storedTokens({ refreshToken: 'a' })),
      s.put('b', storedTokens({ refreshToken: 'b' })),
      s.put('c', storedTokens({ refreshToken: 'c' })),
    ]);
    const file = await s.read();
    assert.deepEqual(Object.keys(file.tokens).sort(), ['a', 'b', 'c']);
  });

  it('keeps the queue alive after a writer throws', async () => {
    const s = store();
    await assert.rejects(
      s.update(() => {
        throw new Error('boom');
      }),
      /boom/,
    );
    await s.put('after', storedTokens());
    assert.notEqual(await s.get('after'), undefined);
  });

  it('hands the callback a view that reads the file as it is right now', async () => {
    const s = store();
    await s.put('ops', storedTokens({ refreshToken: 'r1' }));
    const seen = await s.update((view: LockedTokenStore) => {
      const before = view.get('ops')?.refreshToken;
      view.put('ops', storedTokens({ refreshToken: 'r2' }));
      return [before, view.get('ops')?.refreshToken];
    });
    assert.deepEqual(seen, ['r1', 'r2']);
    assert.equal((await s.get('ops'))?.refreshToken, 'r2');
  });
});

// ---------------------------------------------------------------------------
// Authorization code exchange
// ---------------------------------------------------------------------------

describe('exchangeAuthorizationCode', () => {
  it('posts the documented JSON body and never a form', async () => {
    const auth = fakeAuthRequest([
      ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ]);
    const tokens = await exchangeAuthorizationCode({
      settings: settings(),
      authRequest: auth.fn,
      clock: createFakeClock(5_000),
      code: 'the-code',
      redirectUri: 'http://localhost:8250/callback',
      verifier: 'the-verifier',
    });
    const spec = auth.specs[0];
    assert.equal(spec?.method, 'POST');
    assert.equal(spec?.url, 'https://auth.atlassian.com/oauth/token');
    assert.deepEqual(spec?.json, {
      grant_type: 'authorization_code',
      client_id: 'client-abc',
      client_secret: 'secret-xyz',
      code: 'the-code',
      redirect_uri: 'http://localhost:8250/callback',
      code_verifier: 'the-verifier',
    });
    assert.equal(tokens.expiresAt, 5_000 + 3_600_000);
  });

  it('registers the code, the verifier and both tokens with the redactor', async () => {
    const redactor = createFakeRedactor();
    const auth = fakeAuthRequest([
      ok({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }),
    ]);
    await exchangeAuthorizationCode({
      settings: settings(),
      authRequest: auth.fn,
      clock: createFakeClock(0),
      code: 'the-code',
      redirectUri: 'http://localhost:8250/callback',
      verifier: 'the-verifier',
      redactor,
    });
    for (const secret of ['secret-xyz', 'the-code', 'the-verifier', 'at', 'rt']) {
      assert.ok(redactor.secrets.includes(secret), secret);
    }
  });

  it('refuses to run without a client secret, because PKCE does not replace one', async () => {
    const auth = fakeAuthRequest([ok({})]);
    const error = await rejects(() =>
      exchangeAuthorizationCode({
        settings: settings({ clientSecret: undefined }),
        authRequest: auth.fn,
        clock: createFakeClock(0),
        code: 'c',
        redirectUri: 'http://localhost:8250/callback',
        verifier: 'v',
      }),
    );
    assert.equal(error.kind, 'config');
    assert.match(error.message, /JIRA_OAUTH_CLIENT_SECRET/);
    assert.equal(auth.calls(), 0);
  });

  it('turns a returned rejection into a terminal auth error', async () => {
    const auth = fakeAuthRequest([ok({ error: 'invalid_grant' }, 403)]);
    const error = await rejects(() =>
      exchangeAuthorizationCode({
        settings: settings(),
        authRequest: auth.fn,
        clock: createFakeClock(0),
        code: 'c',
        redirectUri: 'http://localhost:8250/callback',
        verifier: 'v',
      }),
    );
    assert.equal(error.kind, 'auth');
    assert.equal(error.retryable, false);
  });

  it('upgrades a raised 400 invalid_client to a terminal auth error', async () => {
    const auth = fakeAuthRequest([raised(400, 'invalid_client', 'validation')]);
    const error = await rejects(() =>
      exchangeAuthorizationCode({
        settings: settings(),
        authRequest: auth.fn,
        clock: createFakeClock(0),
        code: 'c',
        redirectUri: 'http://localhost:8250/callback',
        verifier: 'v',
      }),
    );
    assert.equal(error.kind, 'auth');
    assert.equal(error.retryable, false);
    assert.match(error.message, /jira-mcp-ai login/);
  });

  it('passes a transport failure through untouched', async () => {
    const boom = createJiraError({
      kind: 'transport',
      reason: 'Could not reach https://auth.atlassian.com.',
      remediation: 'Check the network.',
    });
    const auth = fakeAuthRequest([boom]);
    const error = await rejects(() =>
      exchangeAuthorizationCode({
        settings: settings(),
        authRequest: auth.fn,
        clock: createFakeClock(0),
        code: 'c',
        redirectUri: 'http://localhost:8250/callback',
        verifier: 'v',
      }),
    );
    assert.equal(error, boom);
  });
});

// ---------------------------------------------------------------------------
// The refreshing credential resolver
// ---------------------------------------------------------------------------

describe('createOAuthCredentialResolver', () => {
  it('hands out the stored access token without a network call while it is fresh', async () => {
    const h = harness();
    const credentials = await bearer(h);
    assert.equal(credentials.kind, 'bearer');
    assert.equal(credentials.accessToken, 'access-1');
    assert.deepEqual(credentials.host, {
      origin: 'https://api.atlassian.com',
      pathPrefix: `/ex/jira/${CLOUD_ID}`,
    });
    assert.equal(h.auth.calls(), 0);
  });

  it('refreshes inside the skew window, before the token is actually dead', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 1_000_000 + TOKEN_REFRESH_SKEW_MS - 1 }),
      replies: [
        ok({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      ],
    });
    const credentials = await bearer(h);
    assert.equal(credentials.accessToken, 'access-2');
    assert.equal(h.auth.calls(), 1);
    assert.deepEqual(h.auth.specs[0]?.json, {
      grant_type: 'refresh_token',
      client_id: 'client-abc',
      client_secret: 'secret-xyz',
      refresh_token: 'refresh-1',
    });
    assert.equal(h.logger.eventsOf('oauth_token_refreshed').length, 1);
    assert.equal(
      h.logger.eventsOf('oauth_token_refreshed')[0]?.fields?.['rotated'],
      true,
    );
  });

  it('never puts a token in a log field', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [
        ok({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      ],
    });
    await bearer(h);
    const serialized = JSON.stringify(h.logger.events);
    for (const secret of [
      'access-1',
      'access-2',
      'refresh-1',
      'refresh-2',
      'secret-xyz',
    ]) {
      assert.ok(!serialized.includes(secret), `${secret} leaked into a log event`);
    }
  });

  it('[CC-98] a single refresh happens under concurrent callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updates = 0;
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [
        async () => {
          await gate;
          return ok({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_in: 3600,
          });
        },
      ],
      decorate: (store) => ({
        ...store,
        path: store.path,
        update: (fn) => {
          updates += 1;
          return store.update(fn);
        },
      }),
    });

    const callers = [bearer(h), bearer(h), bearer(h), bearer(h), bearer(h)];
    // Let every caller reach the refresh decision before the response lands.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.ok(release);
    release();
    const results = await Promise.all(callers);

    // One POST, and — the part only in-process single-flight can deliver — one
    // trip through the cross-process lock rather than five.
    assert.equal(h.auth.calls(), 1);
    assert.equal(updates, 1);
    for (const result of results) assert.equal(result.accessToken, 'access-2');
    assert.equal(h.logger.eventsOf('oauth_token_refreshed').length, 1);
  });

  it('starts a fresh refresh after an earlier one has settled', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [
        ok({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 0.001 }),
        ok({ access_token: 'access-3', refresh_token: 'refresh-3', expires_in: 3600 }),
      ],
    });
    assert.equal((await bearer(h)).accessToken, 'access-2');
    // access-2 expires 1 ms after it was issued, so the next call must refresh
    // again instead of finding a promise the map forgot to clear.
    assert.equal((await bearer(h)).accessToken, 'access-3');
    assert.equal(h.auth.calls(), 2);
  });

  it('[CC-99] the rotated refresh token is persisted before it is used', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [
        ok({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      ],
    });
    const credentials = await bearer(h);
    const onDisk = h.onDisk();
    assert.equal(onDisk?.refreshToken, 'refresh-2');
    assert.equal(onDisk?.accessToken, 'access-2');
    assert.equal(credentials.accessToken, 'access-2');
    // The stored expiry is the one the resolver computed from the fake clock,
    // not a lifetime anybody hardcoded.
    assert.equal(onDisk?.expiresAt, 1_000_000 + 3_600_000);
  });

  it('[CC-99] a failed write fails the refresh instead of handing out a token whose rotation was lost', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [
        ok({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      ],
      decorate: (store) => ({
        ...store,
        path: store.path,
        update: (fn) =>
          store.update((view) =>
            fn({
              ...view,
              put: () => {
                throw new Error('disk full');
              },
            }),
          ),
      }),
    });

    await assert.rejects(() => resolved(h), /disk full/);
    // The rotation was never persisted, so the OLD refresh token must survive:
    // it is the only one a restart could still use.
    assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
    // And the success event must not have been emitted for a refresh that
    // never reached the disk.
    assert.equal(h.logger.has('oauth_token_refreshed'), false);
  });

  it('keeps the old refresh token when the response rotates nothing', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ access_token: 'access-2', expires_in: 3600 })],
    });
    await bearer(h);
    assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
    assert.equal(
      h.logger.eventsOf('oauth_token_refreshed')[0]?.fields?.['rotated'],
      false,
    );
  });

  it('adopts a token another process refreshed while we waited for the lock', async () => {
    const h = harness({ seed: storedTokens({ expiresAt: 0 }) });
    // Simulate the other process by rewriting the file from inside the lock,
    // before the refresh decision is taken.
    const fresh = storedTokens({
      accessToken: 'access-from-elsewhere',
      refreshToken: 'refresh-from-elsewhere',
      expiresAt: 1_000_000 + 3_600_000,
    });
    writeFileSync(
      h.path,
      JSON.stringify({ version: 1, tokens: { [DEFAULT_PROFILE_KEY]: fresh } }),
      { mode: 0o600 },
    );
    const credentials = await bearer(h);
    assert.equal(credentials.accessToken, 'access-from-elsewhere');
    assert.equal(h.auth.calls(), 0);
  });

  it('re-reads inside the lock and does not burn a token another process just rotated', async () => {
    const h = harness({ seed: storedTokens({ expiresAt: 0 }) });
    const fresh = storedTokens({
      accessToken: 'access-late',
      refreshToken: 'refresh-late',
      expiresAt: 1_000_000 + 3_600_000,
    });
    // The resolver's first read sees the expired entry; the write lands before
    // the locked section runs, which is exactly the race the re-read exists for.
    const pending = bearer(h);
    writeFileSync(
      h.path,
      JSON.stringify({ version: 1, tokens: { [DEFAULT_PROFILE_KEY]: fresh } }),
      { mode: 0o600 },
    );
    const credentials = await pending;
    assert.equal(credentials.accessToken, 'access-late');
    assert.equal(h.auth.calls(), 0);
    assert.equal(h.onDisk()?.refreshToken, 'refresh-late');
  });

  for (const [status, code] of [
    [403, 'invalid_grant'],
    [400, 'invalid_client'],
    [403, 'unauthorized_client'],
  ] as const) {
    it(`[CC-100] a terminal token error is terminal and tells the user to log in again (returned ${String(status)} ${code})`, async () => {
      const h = harness({
        seed: storedTokens({ expiresAt: 0 }),
        replies: [ok({ error: code, error_description: 'no' }, status)],
      });
      const error = await rejects(() => resolved(h));
      assert.equal(error.kind, 'auth');
      assert.equal(error.retryable, false);
      assert.equal(error.httpStatus, status);
      assert.match(error.message, /run `jira-mcp-ai login` again/i);
      // Never replayed: a rotating refresh token cannot survive a second try.
      assert.equal(h.auth.calls(), 1);
      // The store is left exactly as it was; nothing half-written.
      assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
      const failure = h.logger.eventsOf('oauth_token_refresh_failed')[0];
      assert.equal(failure?.fields?.['status'], status);
      assert.equal(failure?.fields?.['code'], code);
      assert.equal(h.logger.has('oauth_token_refreshed'), false);
    });

    it(`[CC-100] a terminal token error is terminal and tells the user to log in again (raised ${String(status)} ${code})`, async () => {
      // The same failure as the request layer actually delivers it: thrown,
      // with the OAuth code in `detail` rather than in a readable body.
      const h = harness({
        seed: storedTokens({ expiresAt: 0 }),
        replies: [raised(status, code, status === 403 ? 'auth' : 'validation')],
      });
      const error = await rejects(() => resolved(h));
      assert.equal(error.kind, 'auth');
      assert.equal(error.retryable, false);
      assert.match(error.message, /run `jira-mcp-ai login` again/i);
      assert.equal(h.auth.calls(), 1);
      assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
      const failure = h.logger.eventsOf('oauth_token_refresh_failed')[0];
      assert.equal(failure?.fields?.['status'], status);
      assert.equal(failure?.fields?.['code'], code);
    });
  }

  it('leaves a server-side failure retryable, with the grant intact', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ error: 'server_error' }, 503)],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'transport');
    assert.equal(error.retryable, true);
    assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
  });

  it('reports a rate-limited token endpoint without replaying it', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ error: 'too_many' }, 429)],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'rate_limited');
    assert.equal(h.auth.calls(), 1);
  });

  it('passes a non-terminal raised failure through with its own kind', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [raised(400, 'slow_down', 'validation')],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'validation');
    assert.equal(
      h.logger.eventsOf('oauth_token_refresh_failed')[0]?.fields?.['code'],
      'slow_down',
    );
  });

  it('logs a raised failure that carries no status or code at all', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [new Error('socket hang up')],
    });
    await assert.rejects(() => resolved(h), /socket hang up/);
    const failure = h.logger.eventsOf('oauth_token_refresh_failed')[0];
    assert.equal(failure?.fields?.['status'], 0);
    assert.equal(failure?.fields?.['code'], 'none');
  });

  it('refuses a token response that cannot be scheduled from', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ access_token: 'access-2' })],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'unexpected_shape');
    assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
  });

  it('[CC-102] names login when there is no token store at all', async () => {
    const h = emptyHarness();
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
    assert.ok(error.message.includes(h.path));
    assert.match(error.message, /jira-mcp-ai login/);
    // The point of the corner case: it is `config`, raised here, with nothing
    // sent. A request with no credential would come back a 401 whose stock
    // remediation — check the token, regenerate it — is advice for a problem
    // this operator does not have.
    assert.equal(h.auth.calls(), 0);
  });

  it('[CC-102] names login when the store has no entry for this profile', async () => {
    const h = harness();
    const error = await rejects(() => resolved(h, 'ops'));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /"ops"/);
    assert.ok(error.message.includes(h.path));
    assert.match(error.message, /jira-mcp-ai login/);
    assert.equal(h.auth.calls(), 0);
  });

  it('refuses to refresh a grant that belongs to a different client id', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0, clientId: 'someone-elses-client' }),
      replies: [ok({ access_token: 'access-2', expires_in: 3600 })],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /different OAuth client/);
    assert.equal(h.auth.calls(), 0);
  });

  it('reports an unrecognised rejection as a plain auth failure', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ error: 'something_new' }, 401)],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'auth');
    assert.equal(error.retryable, false);
    assert.match(error.message, /JIRA_OAUTH_CLIENT_ID/);
    assert.equal(h.onDisk()?.refreshToken, 'refresh-1');
  });

  it('refuses to refresh with no client id configured', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      settings: { clientId: undefined },
      replies: [ok({ access_token: 'access-2', expires_in: 3600 })],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /JIRA_OAUTH_CLIENT_ID/);
    assert.equal(h.auth.calls(), 0);
  });

  it('refuses to refresh with no client secret configured', async () => {
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      settings: { clientSecret: '  ' },
      replies: [ok({ access_token: 'access-2', expires_in: 3600 })],
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /JIRA_OAUTH_CLIENT_SECRET/);
    assert.equal(h.auth.calls(), 0);
  });

  it('lets JIRA_OAUTH_CLOUD_ID override the stored site', async () => {
    const h = harness({ settings: { cloudId: OTHER_CLOUD_ID } });
    const credentials = await bearer(h);
    assert.equal(credentials.host.pathPrefix, `/ex/jira/${OTHER_CLOUD_ID}`);
  });

  it('refuses a cloudId that is not a plain identifier', async () => {
    const h = harness({ settings: { cloudId: '../../evil' } });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
  });

  it('refuses a gateway host the allowlist does not cover', async () => {
    const h = harness({ allowedHosts: [] });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'config');
    assert.match(error.message, /JIRA_ALLOWED_HOSTS/);
    assert.match(error.message, /api\.atlassian\.com/);
  });

  it('registers the access token it hands out with the redactor', async () => {
    const redactor = createFakeRedactor();
    const path = join(dir, 'oauth.json');
    const clock = createFakeClock(1_000_000);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, tokens: { [DEFAULT_PROFILE_KEY]: storedTokens() } }),
      { mode: 0o600 },
    );
    const resolve = createOAuthCredentialResolver({
      settings: settings(),
      store: createTokenStore({ path, clock }),
      authRequest: fakeAuthRequest([]).fn,
      clock,
      logger: createFakeLogger(),
      redactor,
      allowedHosts: ['api.atlassian.com'],
    });
    await resolve();
    assert.ok(redactor.secrets.includes('access-1'));
    assert.ok(redactor.secrets.includes('secret-xyz'));
  });

  it('refuses to hand out credentials when a refresh produced no access token', async () => {
    // A store decorator that swallows the write and reports a rotated entry
    // with no access token — the shape the resolver must not treat as usable.
    const h = harness({
      seed: storedTokens({ expiresAt: 0 }),
      replies: [ok({ access_token: 'access-2', expires_in: 3600 })],
      decorate: (store) => ({
        ...store,
        path: store.path,
        update: <T>(fn: (view: LockedTokenStore) => T | Promise<T>): Promise<T> =>
          store.update(async (view) => {
            const result = await fn(view);
            return { ...(result as object), accessToken: undefined } as T;
          }),
      }),
    });
    const error = await rejects(() => resolved(h));
    assert.equal(error.kind, 'auth');
    assert.match(error.message, /no access token/);
  });
});
