// OAuth 2.0 (3LO): PKCE, site discovery, the token store, and the refreshing
// credential resolver (WP-A; D91, D92, D93, D94, D95, D96).
//
// Everything here is either pure or filesystem-only. The one thing this module
// must never do is reach the network itself: `core/http.ts` owns `fetch`
// (ARCHITECTURE.md), so the token endpoint is reached through the injected
// {@link AuthRequestFn} primitive (D93). That is also why `core/http.ts` must
// not import this file — the dependency runs one way, or it is a cycle.
//
// What the Atlassian corpus actually says, and what this module encodes because
// of it:
//
//   - **PKCE is defence in depth, not a replacement for the client secret.**
//     The OIDC discovery document does not advertise `none` as a token endpoint
//     auth method, so a confidential client is the only shape known to work:
//     `client_secret` travels on every token request AND `code_challenge` is
//     sent on the authorize request. Dropping either is a downgrade.
//   - **The token endpoint speaks JSON**, not `application/x-www-form-urlencoded`
//     as RFC 6749 requires. Form encoding is accepted in practice but documented
//     nowhere, so only the documented shape is used.
//   - **The access-token lifetime is not documented anywhere.** `expires_in` is
//     read at runtime and never assumed; {@link TOKEN_REFRESH_SKEW_MS} is a skew
//     applied to whatever the server reported, not a lifetime of our own.
//   - **`token_type` appears in no documented response**, so it is neither
//     required nor switched on — every token here is used as a Bearer because
//     the whole corpus uses `Authorization: Bearer`.
//   - **`refresh_token` is missing from the documented code-exchange example**
//     yet the session dies at the first expiry without one. It parses as
//     optional and {@link requireRefreshToken} turns its absence into a loud,
//     actionable failure instead of a session that quietly ends in an hour.
//   - **Refresh tokens rotate**: "Every new refresh token returned invalidates
//     the refresh token used to get the new access token." A rotated token held
//     only in memory is a logout on restart, so it is persisted BEFORE it is
//     used (CC-99) and a failed write fails the refresh.
//   - **The `id` from accessible-resources is not unique across containers** —
//     two entries may share it — so it is never treated as a primary key, and
//     `--site` matches on `url`/`name` instead (CC-103).
//   - **The gateway is mandatory**: "Requests that use OAuth 2.0 (3LO) are made
//     via `api.atlassian.com`", which is why the resolver returns a
//     {@link BearerCredentials} pointed at `/ex/jira/<cloudId>` and never at the
//     site host.
//
// Terminal-error detection deliberately does NOT match the single documented
// string. The live endpoint answers a dead refresh token with
// `403 unauthorized_client`, not the documented `403 invalid_grant`, and an
// unknown client with `400 invalid_client`. Matching one exact string would
// strand the operator in a retry loop against a token that can never work
// again, so any 400/403 carrying one of {@link TERMINAL_TOKEN_ERRORS} ends the
// session and says so (CC-100).
//
// Randomness comes from `node:crypto` through the injected {@link CryptoRandom}
// seam (D96). The repo's `Rng` is documented as *not* a security primitive and
// is not used here for anything — not the verifier, not the `state` nonce.
//
// Time comes from the injected {@link Clock}; `Date.now()` is banned outside the
// seam [eslint], which also makes every expiry boundary here testable without
// sleeping.
//
// Secrets: every token this module sees is registered with the {@link Redactor}
// choke point before anything can log or throw, and no message ever carries a
// token, a client secret, an authorization code or a `code_verifier` — only a
// status and the endpoint's `error` code.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  SECRET_FILE_MODE,
  withEnvLock,
  writeFileAtomic,
  type EnvLockOptions,
} from './env-lock.js';
import { createJiraError, isJiraError } from './errors.js';
import { gatewayHost, isAllowedHost } from './host.js';
import type { AuthRequestFn, BearerCredentials, CredentialResolver } from './http.js';
import type { Clock, Logger, OAuthSettings, Redactor } from './types.js';

// ---------------------------------------------------------------------------
// 1. Endpoints and constants
// ---------------------------------------------------------------------------

/**
 * The `audience` every authorize request must carry. It is documented as
 * required and is the easiest of the seven parameters to forget, because
 * leaving it out produces a consent screen that looks right and a token that
 * cannot address the gateway.
 */
export const OAUTH_AUDIENCE = 'api.atlassian.com';

/** Authorize path on `JIRA_OAUTH_AUTH_ORIGIN`. */
export const AUTHORIZE_PATH = '/authorize';
/** Token path on `JIRA_OAUTH_AUTH_ORIGIN` — code exchange AND refresh. */
export const TOKEN_PATH = '/oauth/token';
/** Site-discovery path on `JIRA_OAUTH_GATEWAY_ORIGIN`; takes no parameters. */
export const ACCESSIBLE_RESOURCES_PATH = '/oauth/token/accessible-resources';

/**
 * Refresh this many ms before the access token actually expires.
 *
 * It is a skew on the server's reported `expires_in`, never a lifetime — the
 * numeric lifetime is undocumented, so assuming one is how a build ends up
 * refreshing an hour after a token that lived fifteen minutes.
 */
export const TOKEN_REFRESH_SKEW_MS = 120_000;

/** Store key for a call that names no profile. */
export const DEFAULT_PROFILE_KEY = 'default';

/** The only token-store layout this build understands. */
export const TOKEN_STORE_VERSION = 1;

/**
 * Bytes of entropy behind the PKCE verifier and the `state` nonce. 32 random
 * bytes base64url-encode to exactly 43 characters — RFC 7636's minimum verifier
 * length, and 256 bits either way.
 */
export const PKCE_VERIFIER_BYTES = 32;
/** Bytes of entropy behind the `state` nonce. */
export const STATE_BYTES = 32;

const PKCE_VERIFIER_MIN_CHARS = 43;
const PKCE_VERIFIER_MAX_CHARS = 128;

/**
 * Token-endpoint `error` codes that mean "this authorization is dead, start
 * over". Wider than the single documented `invalid_grant` on purpose: the live
 * endpoint returns `unauthorized_client` for a bad refresh token and
 * `invalid_client` for an unknown client, and both are just as terminal.
 */
export const TERMINAL_TOKEN_ERRORS: readonly string[] = Object.freeze([
  'invalid_grant',
  'unauthorized_client',
  'invalid_client',
]);

/** The one remediation a terminal token error may ever end with. */
const RE_LOGIN = 'Run `jira-mcp-ai login` again to authorize from scratch.';

// ---------------------------------------------------------------------------
// 2. Small shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, and `any` then leaks into every
 * expression that touches an element. This guard narrows to `readonly unknown[]`
 * instead, so wire data stays `unknown` until a real check says otherwise
 * (ARCHITECTURE.md §Typing strategy).
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Make an untrusted string safe to put in a message a human or a model reads.
 *
 * Site names arrive from a network response and profile keys from a file anyone
 * who can write the config directory can edit, so both are treated the way
 * `env-lock.ts` treats a lock owner record: first line only, no control
 * characters (terminal escapes included), bounded length.
 */
function safeLabel(value: string, max = 80): string {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

/**
 * Store key for a profile name. Mirrors `core/credentials.ts`: names are
 * case-insensitive, and "no profile" is one key rather than a missing one, so a
 * default login and a `--profile default` login cannot end up in two places.
 */
export function profileKey(profile?: string): string {
  const trimmed = profile?.trim() ?? '';
  return trimmed === '' ? DEFAULT_PROFILE_KEY : trimmed.toLowerCase();
}

// ---------------------------------------------------------------------------
// 3. PKCE and nonces
// ---------------------------------------------------------------------------

/**
 * Injected CSPRNG seam.
 *
 * It exists so tests can be deterministic, and it is separate from the repo's
 * `Rng` because `Rng` is documented as explicitly not a security primitive
 * (D96). A correlation id may come from a fast non-cryptographic generator; a
 * `code_verifier` may not.
 */
export type CryptoRandom = (bytes: number) => Uint8Array;

/** The production seam: `node:crypto.randomBytes`. */
export const nodeCryptoRandom: CryptoRandom = (bytes) => randomBytes(bytes);

/** A PKCE challenge pair. `S256` only — `plain` is not offered, ever. */
export interface PkcePair {
  /** 43–128 characters from the RFC 7636 unreserved set. */
  readonly verifier: string;
  /** base64url(SHA-256(ASCII(verifier))). */
  readonly challenge: string;
  readonly method: 'S256';
}

/**
 * base64url with no padding — used for the verifier and the `state` nonce.
 *
 * The length of the seam's output is checked rather than trusted. A source that
 * returns short data would silently halve the entropy of every login, and
 * nothing downstream would look wrong.
 */
export function randomUrlToken(random: CryptoRandom, bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw createJiraError({
      kind: 'config',
      reason: `A random token of ${String(bytes)} bytes was requested, which is not a positive whole number.`,
      remediation: 'This is a programming error; report it.',
    });
  }

  const raw = random(bytes);
  if (raw.length !== bytes) {
    throw createJiraError({
      kind: 'config',
      reason: `The injected randomness source returned ${String(raw.length)} bytes when ${String(bytes)} were requested, so the value would carry less entropy than it appears to.`,
      remediation: 'This is a programming error; report it.',
    });
  }

  return Buffer.from(raw).toString('base64url');
}

/**
 * Build a PKCE pair. base64url output is a subset of RFC 7636's unreserved
 * verifier alphabet, so no further encoding is needed and none is applied.
 */
export function createPkcePair(random: CryptoRandom): PkcePair {
  const verifier = randomUrlToken(random, PKCE_VERIFIER_BYTES);

  if (
    verifier.length < PKCE_VERIFIER_MIN_CHARS ||
    verifier.length > PKCE_VERIFIER_MAX_CHARS
  ) {
    throw createJiraError({
      kind: 'config',
      reason: `The generated PKCE verifier is ${String(verifier.length)} characters, outside the ${String(PKCE_VERIFIER_MIN_CHARS)}–${String(PKCE_VERIFIER_MAX_CHARS)} range RFC 7636 requires.`,
      remediation: 'This is a programming error; report it.',
    });
  }

  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

// ---------------------------------------------------------------------------
// 4. Authorize URL
// ---------------------------------------------------------------------------

export interface AuthorizeUrlInput {
  readonly authOrigin: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}

function joinOrigin(origin: string, path: string, whatFor: string): URL {
  const trimmed = origin.trim().replace(/\/+$/, '');
  try {
    return new URL(`${trimmed}${path}`);
  } catch (cause) {
    throw createJiraError({
      kind: 'config',
      reason: `The ${whatFor} ${JSON.stringify(safeLabel(origin))} is not a usable origin, so no URL could be built from it.`,
      remediation:
        'Unset the override to use the Atlassian default, or set it to a bare https origin such as https://auth.atlassian.com.',
      cause,
    });
  }
}

/** `https://auth.atlassian.com/oauth/token` — code exchange and refresh alike. */
export function tokenEndpoint(authOrigin: string): string {
  return joinOrigin(authOrigin, TOKEN_PATH, 'OAuth auth origin').toString();
}

/** `https://api.atlassian.com/oauth/token/accessible-resources`. */
export function accessibleResourcesEndpoint(gatewayOrigin: string): string {
  return joinOrigin(
    gatewayOrigin,
    ACCESSIBLE_RESOURCES_PATH,
    'OAuth gateway origin',
  ).toString();
}

/**
 * Build the consent URL.
 *
 * All seven documented parameters are present, in the documented order, and two
 * of them are the ones that get dropped: `audience`, without which the token
 * cannot address the gateway, and `prompt=consent`, without which a returning
 * user is silently re-granted the OLD scope set and the new scopes never
 * arrive. The PKCE pair follows them (defence in depth — the client secret is
 * still sent at the token endpoint).
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (!nonEmptyString(input.clientId)) {
    throw createJiraError({
      kind: 'config',
      reason: 'No OAuth client id was supplied, so no authorize URL could be built.',
      remediation:
        'Set JIRA_OAUTH_CLIENT_ID to the client id of your app in the Atlassian developer console.',
    });
  }

  const scopes = input.scopes.map((scope) => scope.trim()).filter((s) => s.length > 0);
  if (scopes.length === 0) {
    throw createJiraError({
      kind: 'config',
      reason: 'The OAuth scope list is empty, so the authorization would grant nothing.',
      remediation:
        'Leave JIRA_OAUTH_SCOPES unset to use the defaults, or set it to a space-separated scope list.',
    });
  }
  // Scopes are joined with spaces, so a scope that already contains one would
  // silently become two — including two that were never granted.
  const split = scopes.find((scope) => /\s/.test(scope));
  if (split !== undefined) {
    throw createJiraError({
      kind: 'config',
      reason: `The OAuth scope ${JSON.stringify(safeLabel(split))} contains whitespace, which would split it into scopes nobody asked for.`,
      remediation: 'Separate scopes with single spaces in JIRA_OAUTH_SCOPES.',
    });
  }

  for (const [label, value] of [
    ['redirect URI', input.redirectUri],
    ['state nonce', input.state],
    ['PKCE challenge', input.challenge],
  ] as const) {
    if (!nonEmptyString(value)) {
      throw createJiraError({
        kind: 'config',
        reason: `The authorize request has no ${label}, which would make the callback unverifiable.`,
        remediation: 'This is a programming error; report it.',
      });
    }
  }

  const url = joinOrigin(input.authOrigin, AUTHORIZE_PATH, 'OAuth auth origin');
  const params = url.searchParams;
  params.set('audience', OAUTH_AUDIENCE);
  params.set('client_id', input.clientId);
  params.set('scope', scopes.join(' '));
  params.set('redirect_uri', input.redirectUri);
  params.set('state', input.state);
  params.set('response_type', 'code');
  params.set('prompt', 'consent');
  params.set('code_challenge', input.challenge);
  params.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// 5. Accessible resources and site selection
// ---------------------------------------------------------------------------

/** One site from `/oauth/token/accessible-resources`. */
export interface AccessibleSite {
  readonly id: string;
  readonly url: string;
  readonly name?: string;
  readonly scopes?: readonly string[];
}

function shapeError(reason: string, cause?: unknown): never {
  throw createJiraError({
    kind: 'unexpected_shape',
    reason,
    remediation:
      'This usually means the Atlassian response changed shape; re-run `jira-mcp-ai doctor` and report it if it persists.',
    cause,
  });
}

/**
 * Validate the discovery response.
 *
 * A malformed entry is refused rather than skipped: dropping one silently could
 * turn a genuinely ambiguous two-site grant into an unambiguous-looking one and
 * pick a site the operator never chose.
 */
export function parseAccessibleSites(json: unknown): readonly AccessibleSite[] {
  if (!isArray(json)) {
    shapeError('The accessible-resources response was not a JSON array of sites.');
  }

  return Object.freeze(
    json.map((entry, index): AccessibleSite => {
      if (!isRecord(entry)) {
        shapeError(
          `Entry ${String(index)} of the accessible-resources response is not an object.`,
        );
      }
      const id = entry['id'];
      const url = entry['url'];
      if (!nonEmptyString(id)) {
        shapeError(
          `Entry ${String(index)} of the accessible-resources response has no cloudId.`,
        );
      }
      if (!nonEmptyString(url)) {
        shapeError(
          `Entry ${String(index)} of the accessible-resources response has no site url.`,
        );
      }
      const name = entry['name'];
      const scopes = entry['scopes'];
      return {
        id,
        url,
        ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
        ...(isArray(scopes)
          ? {
              scopes: Object.freeze(
                scopes.filter((s): s is string => typeof s === 'string'),
              ),
            }
          : {}),
      };
    }),
  );
}

function describeSite(site: AccessibleSite): string {
  const name = site.name === undefined ? '' : `${safeLabel(site.name)} — `;
  return `${name}${safeLabel(site.url)} (cloudId ${safeLabel(site.id, 64)})`;
}

function siteList(sites: readonly AccessibleSite[]): string {
  return sites.map((site) => `  - ${describeSite(site)}`).join('\n');
}

/**
 * Collapse entries that describe the same site.
 *
 * The docs are explicit that "the `id` is not unique across containers (that
 * is, two entries in the results can have the same `id`)", and a Jira + a
 * Confluence container on one site arrive as two rows with one id and one url.
 * Those are one choice, not an ambiguity, so they merge — scopes unioned,
 * because between them they describe what the token may do on that site.
 * Genuinely different sites keep their own row and stay ambiguous.
 */
function dedupeSites(sites: readonly AccessibleSite[]): readonly AccessibleSite[] {
  const byKey = new Map<string, { site: AccessibleSite; scopes: Set<string> }>();
  for (const site of sites) {
    const key = `${site.id}\u0000${site.url.toLowerCase()}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, { site, scopes: new Set(site.scopes ?? []) });
      continue;
    }
    for (const scope of site.scopes ?? []) seen.scopes.add(scope);
  }
  return [...byKey.values()].map(({ site, scopes }) =>
    scopes.size === 0 ? site : { ...site, scopes: Object.freeze([...scopes]) },
  );
}

/**
 * Does `wanted` name this site?
 *
 * Accepts what an operator would plausibly type: the full url, the host, the
 * first label of the host, or the display name — all case-insensitively. Nothing
 * fuzzier: a prefix or substring match would make `acme` quietly select
 * `acme-sandbox` on the day someone adds one.
 */
function siteMatches(site: AccessibleSite, wanted: string): boolean {
  const needle = wanted.trim().toLowerCase().replace(/\/+$/, '');
  if (needle === '') return false;
  if (site.name !== undefined && site.name.trim().toLowerCase() === needle) return true;

  const url = site.url.trim().toLowerCase().replace(/\/+$/, '');
  if (url === needle) return true;

  let hostname: string;
  try {
    hostname = new URL(site.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = needle.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return hostname === bare || hostname.split('.')[0] === bare;
}

/**
 * Pick the site a login or a refresh should address.
 *
 * Ambiguity is an error that lists every candidate (CC-103). A silent pick here
 * is the worst available outcome: the operator gets a working server that reads
 * and writes the wrong Jira, and nothing in the output says so.
 */
export function selectSite(
  sites: readonly AccessibleSite[],
  wanted?: { readonly cloudId?: string; readonly site?: string },
): AccessibleSite {
  const all = dedupeSites(sites);

  if (all.length === 0) {
    throw createJiraError({
      kind: 'config',
      reason:
        'The authorization grants access to no Jira site, so there is nothing to address.',
      remediation: `Grant the app access to a site when you consent, then ${RE_LOGIN.toLowerCase()}`,
    });
  }

  const pinnedId = wanted?.cloudId?.trim();
  const pinnedSite = wanted?.site?.trim();

  let candidates = all;
  if (pinnedId !== undefined && pinnedId !== '') {
    candidates = candidates.filter((site) => site.id === pinnedId);
    if (candidates.length === 0) {
      throw createJiraError({
        kind: 'config',
        reason: `No accessible site has cloudId ${JSON.stringify(safeLabel(pinnedId, 64))}. The authorization covers:\n${siteList(all)}`,
        remediation:
          'Set JIRA_OAUTH_CLOUD_ID to one of the ids listed above, or unset it and let discovery pick the site.',
      });
    }
  }

  if (pinnedSite !== undefined && pinnedSite !== '') {
    const matched = candidates.filter((site) => siteMatches(site, pinnedSite));
    if (matched.length === 0) {
      throw createJiraError({
        kind: 'config',
        reason: `No accessible site matches ${JSON.stringify(safeLabel(pinnedSite))}. The authorization covers:\n${siteList(candidates)}`,
        remediation:
          'Pass --site with one of the urls listed above, or omit it when the authorization covers a single site.',
      });
    }
    candidates = matched;
  }

  const chosen = candidates[0];
  if (candidates.length === 1 && chosen !== undefined) return chosen;

  throw createJiraError({
    kind: 'config',
    reason: `The authorization covers ${String(candidates.length)} Jira sites and nothing says which one to use:\n${siteList(candidates)}`,
    remediation:
      'Pass --site with one of the urls listed above, or set JIRA_OAUTH_CLOUD_ID to its cloudId.',
  });
}

// ---------------------------------------------------------------------------
// 6. Token responses
// ---------------------------------------------------------------------------

/** A validated token response. `expiresAt` is absolute ms from the Clock. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

function parseExpiresIn(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return seconds;
}

/**
 * Validate a token response and turn its relative lifetime into an absolute
 * instant on the injected clock.
 *
 * `expires_in` is required rather than defaulted. The numeric lifetime appears
 * nowhere in the documentation — the "one hour" figure is folklore — so a
 * response without it is a response we cannot schedule a refresh from, and
 * inventing a number would mean handing out a token that expired ten minutes
 * ago. `token_type` is ignored entirely: no documented example contains it.
 */
export function parseTokenResponse(json: unknown, now: number): OAuthTokens {
  if (!isRecord(json)) {
    shapeError('The token endpoint returned a body that was not a JSON object.');
  }

  const accessToken = json['access_token'];
  if (!nonEmptyString(accessToken)) {
    shapeError('The token endpoint returned no access_token.');
  }

  const seconds = parseExpiresIn(json['expires_in']);
  if (seconds === undefined) {
    shapeError(
      'The token endpoint returned no usable expires_in, so there is no way to know when the access token dies.',
    );
  }

  const refreshToken = json['refresh_token'];
  if (refreshToken !== undefined && !nonEmptyString(refreshToken)) {
    shapeError('The token endpoint returned an empty refresh_token.');
  }

  const scope = json['scope'];
  const scopes =
    typeof scope === 'string'
      ? Object.freeze(scope.split(/\s+/).filter((s) => s.length > 0))
      : Object.freeze([]);

  return {
    accessToken,
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    expiresAt: now + seconds * 1000,
    scopes,
  };
}

/**
 * Insist on a refresh token.
 *
 * The documented code-exchange example does not show one, and it only arrives
 * when `offline_access` was among the granted scopes. Without it the server
 * works until the first expiry and then starts failing with no obvious cause,
 * so its absence is surfaced at login instead.
 */
export function requireRefreshToken(tokens: OAuthTokens): string {
  if (tokens.refreshToken === undefined) {
    throw createJiraError({
      kind: 'config',
      reason:
        'The authorization returned no refresh token, so the session would stop working at the first token expiry.',
      remediation:
        'Add the `offline_access` scope to JIRA_OAUTH_SCOPES (it is in the defaults) and run `jira-mcp-ai login` again.',
    });
  }
  return tokens.refreshToken;
}

/** True while the token is inside {@link TOKEN_REFRESH_SKEW_MS} of expiry. */
export function isExpired(tokens: OAuthTokens, now: number): boolean {
  return now + TOKEN_REFRESH_SKEW_MS >= tokens.expiresAt;
}

// ---------------------------------------------------------------------------
// 7. The token store — <config dir>/oauth.json, 0600, atomic, locked
// ---------------------------------------------------------------------------

export interface StoredTokens {
  readonly cloudId: string;
  readonly site: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly refreshToken: string;
  readonly accessToken?: string;
  readonly expiresAt?: number;
  readonly obtainedAt: number;
}

/** `{ version: 1, tokens: { "<profile>": StoredTokens } }`. */
export interface TokenStoreFile {
  readonly version: typeof TOKEN_STORE_VERSION;
  readonly tokens: Readonly<Record<string, StoredTokens>>;
}

const EMPTY_STORE: TokenStoreFile = Object.freeze({
  version: TOKEN_STORE_VERSION,
  tokens: Object.freeze({}),
});

/**
 * The store as seen from inside the cross-process lock.
 *
 * It exists so the refresh path can read-modify-write atomically without
 * deadlocking: the lock is an advisory `mkdir` and is therefore NOT reentrant,
 * so calling the locking {@link TokenStore.put} from inside
 * {@link TokenStore.update} would wait for a lock this process already holds
 * until the acquire timeout. Handing the callback a view whose writes assume
 * the lock removes the temptation rather than documenting it away.
 */
export interface LockedTokenStore {
  read(): TokenStoreFile;
  get(profile?: string): StoredTokens | undefined;
  put(profile: string | undefined, tokens: StoredTokens): void;
  remove(profile?: string): boolean;
}

export interface TokenStore {
  read(): Promise<TokenStoreFile>;
  get(profile?: string): Promise<StoredTokens | undefined>;
  /** Read-modify-write under the cross-process lock. */
  put(profile: string | undefined, tokens: StoredTokens): Promise<void>;
  remove(profile?: string): Promise<boolean>;
  /**
   * Run `fn` holding the lock, with a re-read available inside it. Do not nest.
   */
  update<T>(fn: (locked: LockedTokenStore) => T | Promise<T>): Promise<T>;
  readonly path: string;
}

export interface TokenStoreDeps {
  readonly path: string;
  readonly clock: Clock;
  /**
   * Lock knobs (timeouts, warning sink). Production uses the defaults; tests
   * drive them so a contended lock does not depend on wall-clock patience.
   */
  readonly lock?: Omit<EnvLockOptions, 'clock'>;
}

function storeError(path: string, why: string, cause?: unknown): never {
  throw createJiraError({
    kind: 'config',
    reason: `The OAuth token store ${path} ${why}.`,
    remediation: `Delete it and ${RE_LOGIN.toLowerCase()}`,
    cause,
  });
}

function parseStoredTokens(value: unknown, profile: string, path: string): StoredTokens {
  const label = JSON.stringify(safeLabel(profile, 40));
  const damaged = (why: string): never =>
    storeError(path, `has a damaged entry for profile ${label}: ${why}`);

  if (!isRecord(value)) return damaged('it is not an object');

  const cloudId = value['cloudId'];
  if (!nonEmptyString(cloudId)) return damaged('cloudId is missing or empty');
  const site = value['site'];
  if (!nonEmptyString(site)) return damaged('site is missing or empty');
  const clientId = value['clientId'];
  if (!nonEmptyString(clientId)) return damaged('clientId is missing or empty');
  const refreshToken = value['refreshToken'];
  if (!nonEmptyString(refreshToken)) return damaged('refreshToken is missing or empty');

  const scopes = value['scopes'];
  if (!isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    return damaged('scopes is not an array of strings');
  }

  const obtainedAt = value['obtainedAt'];
  if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) {
    return damaged('obtainedAt is not a number');
  }

  const accessToken = value['accessToken'];
  if (accessToken !== undefined && !nonEmptyString(accessToken)) {
    return damaged('accessToken is present but empty');
  }

  const expiresAt = value['expiresAt'];
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
  ) {
    return damaged('expiresAt is not a number');
  }

  return {
    cloudId,
    site,
    clientId,
    scopes: Object.freeze([...scopes]),
    refreshToken,
    ...(typeof accessToken === 'string' ? { accessToken } : {}),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    obtainedAt,
  };
}

/**
 * The 0600 store `login` writes and every refresh rewrites (D95).
 *
 * Tokens live here rather than in the env file because rotation writes on every
 * refresh, and an env file is a document an operator edits by hand. Reads take
 * no lock — `writeFileAtomic` renames, so a reader sees either the whole old
 * file or the whole new one — and only writes serialize.
 */
export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const { path, clock } = deps;
  const lockOptions: EnvLockOptions = { ...deps.lock, clock };

  const readNow = (): TokenStoreFile => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      // No file is not an error: it is the state before the first login, and
      // the resolver turns it into a message naming `login` (CC-102).
      if (isErrnoCode(error, 'ENOENT')) return EMPTY_STORE;
      storeError(path, 'could not be read', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      storeError(path, 'is not valid JSON', error);
    }

    if (!isRecord(parsed)) storeError(path, 'does not contain a JSON object');
    const version = parsed['version'];
    if (version !== TOKEN_STORE_VERSION) {
      const shown =
        typeof version === 'number'
          ? String(version)
          : typeof version === 'string'
            ? JSON.stringify(safeLabel(version, 20))
            : 'nothing recognisable';
      storeError(
        path,
        `records format version ${shown}, but this build only understands version ${String(TOKEN_STORE_VERSION)}`,
      );
    }
    const tokens = parsed['tokens'];
    if (!isRecord(tokens)) storeError(path, 'has no `tokens` object');

    const entries: Record<string, StoredTokens> = {};
    for (const [key, value] of Object.entries(tokens)) {
      entries[key] = parseStoredTokens(value, key, path);
    }
    return { version: TOKEN_STORE_VERSION, tokens: entries };
  };

  const write = (file: TokenStoreFile): void => {
    writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, {
      mode: SECRET_FILE_MODE,
    });
  };

  const locked: LockedTokenStore = {
    read: readNow,
    get: (profile) => readNow().tokens[profileKey(profile)],
    put: (profile, tokens) => {
      const file = readNow();
      write({
        version: TOKEN_STORE_VERSION,
        tokens: { ...file.tokens, [profileKey(profile)]: tokens },
      });
    },
    remove: (profile) => {
      const file = readNow();
      const key = profileKey(profile);
      if (!Object.hasOwn(file.tokens, key)) return false;
      const rest = { ...file.tokens };
      delete rest[key];
      write({ version: TOKEN_STORE_VERSION, tokens: rest });
      return true;
    },
  };

  // In-process writers queue instead of racing for the `mkdir` lock. Without
  // this, two profiles refreshing at once would fight over the same lock
  // directory in one process and the loser would burn its acquire timeout
  // waiting for a holder it shares an event loop with.
  let queue: Promise<unknown> = Promise.resolve();

  function update<T>(fn: (view: LockedTokenStore) => T | Promise<T>): Promise<T> {
    const run = queue.then(() => withEnvLock(path, lockOptions, () => fn(locked)));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    path,
    read: () => Promise.resolve(readNow()),
    get: (profile) => Promise.resolve(locked.get(profile)),
    put: (profile, tokens) =>
      update((view) => {
        view.put(profile, tokens);
      }),
    remove: (profile) => update((view) => view.remove(profile)),
    update,
  };
}

// ---------------------------------------------------------------------------
// 8. Token endpoint calls
// ---------------------------------------------------------------------------

/** The `error` code from a token-endpoint failure, when there is one. */
export function tokenErrorCode(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const code = json['error'];
  return nonEmptyString(code) ? safeLabel(code, 40) : undefined;
}

/**
 * Is this failure worth another attempt, or is the authorization dead?
 *
 * Deliberately wider than the one documented string — see the module header.
 */
export function isTerminalTokenError(status: number, json: unknown): boolean {
  if (status !== 400 && status !== 403) return false;
  const code = tokenErrorCode(json);
  return code !== undefined && TERMINAL_TOKEN_ERRORS.includes(code);
}

function tokenEndpointError(
  status: number,
  json: unknown,
  what: string,
  redactor?: Redactor,
  cause?: unknown,
): Error {
  const code = tokenErrorCode(json);
  const suffix = code === undefined ? '' : ` (${code})`;
  // Only the status and the `error` code ever reach a message. The body may
  // echo values we sent, and one of those is a token.
  const reason = `The Atlassian token endpoint rejected the ${what} with HTTP ${String(status)}${suffix}.`;

  if (isTerminalTokenError(status, json)) {
    return createJiraError({
      kind: 'auth',
      reason,
      remediation: `The authorization is no longer valid — the refresh token was rotated away or expired, the account password changed, or the client credentials no longer match. ${RE_LOGIN}`,
      httpStatus: status,
      retryable: false,
      redactor,
      cause,
    });
  }

  if (status === 429) {
    return createJiraError({
      kind: 'rate_limited',
      reason,
      remediation:
        'Wait and retry the tool call; the token request is never replayed automatically, because a replayed rotation is a logout.',
      httpStatus: status,
      redactor,
      cause,
    });
  }

  if (status >= 500) {
    return createJiraError({
      kind: 'transport',
      reason,
      remediation:
        'This is an Atlassian-side failure; retry the tool call. If it persists, run `jira-mcp-ai doctor`.',
      httpStatus: status,
      redactor,
      cause,
    });
  }

  return createJiraError({
    kind: 'auth',
    reason,
    remediation: `Check JIRA_OAUTH_CLIENT_ID and JIRA_OAUTH_CLIENT_SECRET against your app in the Atlassian developer console, then ${RE_LOGIN.toLowerCase()}`,
    httpStatus: status,
    retryable: false,
    redactor,
    cause,
  });
}

/**
 * The OAuth `error` code carried by a failure the request layer already raised.
 *
 * `createAuthRequest` does not hand a non-2xx token response back as a value —
 * it throws a `JiraError` whose `detail` is either `code` or
 * `code: description`. That is a better default for every other caller, and it
 * means the classification below has to read the code back out of `detail`
 * rather than out of a body it never sees. Bounded and never parsed further:
 * this is a label, not data.
 */
function detailErrorCode(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const head = detail.split(':', 1)[0]?.trim();
  return nonEmptyString(head) ? safeLabel(head, 40) : undefined;
}

/** Status and `error` code of a token failure, for the log line only. */
function tokenFailureFields(error: unknown): { status: number; code: string } {
  if (!isJiraError(error)) return { status: 0, code: 'none' };
  return {
    status: error.httpStatus ?? 0,
    code: detailErrorCode(error.detail) ?? 'none',
  };
}

/**
 * Re-raise a token-endpoint failure, upgrading it when it is terminal.
 *
 * The request layer classifies a 403 and a 400 `invalid_grant` as `auth` on its
 * own, but a 400 carrying `unauthorized_client` or `invalid_client` reaches it
 * as an ordinary rejection — and by the facts those two are just as dead as
 * `invalid_grant`: the app was disabled, or its credentials no longer match.
 * Terminal detection is this module's job (see the module header), so the
 * upgrade happens here rather than being left to whoever catches it next. Every
 * other failure passes through untouched, cause and kind intact.
 */
function rethrowTokenFailure(error: unknown, what: string, redactor?: Redactor): never {
  if (isJiraError(error)) {
    const status = error.httpStatus;
    const code = detailErrorCode(error.detail);
    if (
      (status === 400 || status === 403) &&
      code !== undefined &&
      TERMINAL_TOKEN_ERRORS.includes(code)
    ) {
      throw tokenEndpointError(status, { error: code }, what, redactor, error);
    }
  }
  throw error;
}

function requireClientCredentials(settings: OAuthSettings): {
  clientId: string;
  clientSecret: string;
} {
  if (!nonEmptyString(settings.clientId)) {
    throw createJiraError({
      kind: 'config',
      reason: 'OAuth mode is selected but no client id is configured.',
      remediation:
        'Set JIRA_OAUTH_CLIENT_ID to the client id of your app in the Atlassian developer console.',
    });
  }
  // PKCE does not make the secret optional here: the discovery document does
  // not advertise `none` as a token endpoint auth method, so a public-client
  // flow is not a supported shape and would fail at the token endpoint with a
  // message about the client rather than about the missing configuration.
  if (!nonEmptyString(settings.clientSecret)) {
    throw createJiraError({
      kind: 'config',
      reason:
        'OAuth mode is selected but no client secret is configured, and Atlassian does not accept a PKCE-only public client.',
      remediation:
        'Set JIRA_OAUTH_CLIENT_SECRET to the secret of your app in the Atlassian developer console.',
    });
  }
  return { clientId: settings.clientId, clientSecret: settings.clientSecret };
}

export interface AuthorizationCodeExchange {
  readonly settings: OAuthSettings;
  readonly authRequest: AuthRequestFn;
  readonly clock: Clock;
  /** The `code` from the loopback callback. Secret; redacted on arrival. */
  readonly code: string;
  /** Must be byte-identical to the one sent on the authorize request. */
  readonly redirectUri: string;
  /** The PKCE verifier. Secret; redacted on arrival. */
  readonly verifier: string;
  readonly redactor?: Redactor;
}

/**
 * Exchange an authorization code for tokens.
 *
 * `login` owns the browser dance; this is the one step that must agree with the
 * refresh path about what a token response looks like and which failures are
 * terminal, so both live here rather than being written twice.
 */
export async function exchangeAuthorizationCode(
  input: AuthorizationCodeExchange,
): Promise<OAuthTokens> {
  const { settings, redactor } = input;
  const { clientId, clientSecret } = requireClientCredentials(settings);

  // Registered before the request, not after: anything that throws between here
  // and the response would otherwise be free to quote them.
  redactor?.addSecret(clientSecret);
  redactor?.addSecret(input.code);
  redactor?.addSecret(input.verifier);

  // A non-2xx arrives as a throw, not as a value — but the value branch stays,
  // because `AuthRequestFn` is an interface and nothing in its signature forbids
  // an implementation that returns one. Both roads lead to the same classifier.
  let response;
  try {
    response = await input.authRequest({
      method: 'POST',
      url: tokenEndpoint(settings.authOrigin),
      json: {
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      },
    });
  } catch (error) {
    rethrowTokenFailure(error, 'login', redactor);
  }

  if (response.status < 200 || response.status >= 300) {
    throw tokenEndpointError(response.status, response.json, 'login', redactor);
  }

  const tokens = parseTokenResponse(response.json, input.clock.now());
  redactor?.addSecret(tokens.accessToken);
  if (tokens.refreshToken !== undefined) redactor?.addSecret(tokens.refreshToken);
  return tokens;
}

// ---------------------------------------------------------------------------
// 9. The refreshing credential resolver
// ---------------------------------------------------------------------------

export interface OAuthResolverDeps {
  readonly settings: OAuthSettings;
  readonly store: TokenStore;
  readonly authRequest: AuthRequestFn;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor?: Redactor;
  readonly allowedHosts?: readonly string[];
}

function storedIsFresh(stored: StoredTokens, now: number): boolean {
  const { accessToken, expiresAt, scopes } = stored;
  if (accessToken === undefined || expiresAt === undefined) return false;
  return !isExpired({ accessToken, expiresAt, scopes }, now);
}

/** No store, or no entry in it, is a config error naming `login` — not a 401. */
function noTokensError(path: string, key: string): Error {
  return createJiraError({
    kind: 'config',
    reason: `OAuth mode is selected but ${path} holds no authorization for profile ${JSON.stringify(safeLabel(key, 40))}.`,
    remediation: RE_LOGIN,
  });
}

/**
 * The resolver the server installs in oauth mode.
 *
 * Five properties, each of which is a bug if it is missing:
 *
 * 1. **Single-flight in-process.** N tool calls that all see an expired token
 *    perform ONE refresh and share its promise. N refreshes would rotate N
 *    times and leave N-1 dead tokens, one of which is the one we stored.
 * 2. **Re-read inside the cross-process lock.** Another process may have
 *    refreshed while we waited for the lock; adopting its token is correct, and
 *    burning it by refreshing again is not.
 * 3. **Persist before use.** The rotated refresh token is written before the
 *    access token is handed out; a failed write fails the refresh, because a
 *    rotation held only in memory is a logout on the next restart.
 * 4. **No refresh-and-replay on 401.** Refresh is proactive, inside the skew
 *    window. Replaying an unsafe write whose outcome is unknown is exactly the
 *    failure the retry policy exists to prevent.
 * 5. **Terminal is terminal.** A dead authorization ends the call with a message
 *    naming `login`, never a retry loop (CC-100).
 */
export function createOAuthCredentialResolver(
  deps: OAuthResolverDeps,
): CredentialResolver {
  const { settings, store, authRequest, clock, logger, redactor } = deps;

  // The secret is in the environment either way; registering it here means a
  // message built before the first request cannot quote it.
  if (nonEmptyString(settings.clientSecret)) redactor?.addSecret(settings.clientSecret);

  const inFlight = new Map<string, Promise<StoredTokens>>();

  const refresh = (profile: string | undefined, key: string): Promise<StoredTokens> =>
    store.update(async (view) => {
      const current = view.get(profile);
      if (current === undefined) throw noTokensError(store.path, key);

      // Rule 2: another process may have rotated while we queued for the lock.
      if (storedIsFresh(current, clock.now())) return current;

      const { clientId, clientSecret } = requireClientCredentials(settings);
      if (current.clientId !== clientId) {
        throw createJiraError({
          kind: 'config',
          reason: `The stored authorization for profile ${JSON.stringify(safeLabel(key, 40))} belongs to a different OAuth client than JIRA_OAUTH_CLIENT_ID now names, so refreshing it would fail as an unknown client.`,
          remediation: RE_LOGIN,
        });
      }

      let response;
      try {
        response = await authRequest({
          method: 'POST',
          url: tokenEndpoint(settings.authOrigin),
          json: {
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: current.refreshToken,
          },
        });
      } catch (error) {
        // The log line is the same whichever way the failure arrived, so it is
        // written here as well as below rather than only on the value path.
        logger.emit('oauth_token_refresh_failed', {
          profile: key,
          ...tokenFailureFields(error),
        });
        rethrowTokenFailure(error, 'refresh', redactor);
      }

      if (response.status < 200 || response.status >= 300) {
        logger.emit('oauth_token_refresh_failed', {
          profile: key,
          status: response.status,
          code: tokenErrorCode(response.json) ?? 'none',
        });
        throw tokenEndpointError(response.status, response.json, 'refresh', redactor);
      }

      const now = clock.now();
      const tokens = parseTokenResponse(response.json, now);
      redactor?.addSecret(tokens.accessToken);
      if (tokens.refreshToken !== undefined) redactor?.addSecret(tokens.refreshToken);

      const rotated =
        tokens.refreshToken !== undefined && tokens.refreshToken !== current.refreshToken;
      const next: StoredTokens = {
        ...current,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : current.scopes,
        obtainedAt: now,
      };

      // Rule 3: the write comes first. If it throws, the caller gets the write
      // failure and no credentials — which is the honest outcome, because the
      // token we would have returned is one no restart could ever refresh.
      view.put(profile, next);

      logger.emit('oauth_token_refreshed', {
        profile: key,
        expiresInMs: tokens.expiresAt - now,
        rotated,
      });
      return next;
    });

  // Rule 1: one refresh per profile, shared by everyone who arrives while it
  // runs. `inFlight.set` happens in the same synchronous turn as the call, so
  // no second caller can observe the gap.
  const refreshOnce = (
    profile: string | undefined,
    key: string,
  ): Promise<StoredTokens> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const started = refresh(profile, key).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, started);
    return started;
  };

  return async (profile?: string): Promise<BearerCredentials> => {
    const key = profileKey(profile);
    const stored = await store.get(profile);
    if (stored === undefined) throw noTokensError(store.path, key);

    const fresh = storedIsFresh(stored, clock.now())
      ? stored
      : await refreshOnce(profile, key);

    const accessToken = fresh.accessToken;
    if (accessToken === undefined) {
      throw createJiraError({
        kind: 'auth',
        reason: `The stored authorization for profile ${JSON.stringify(safeLabel(key, 40))} carries no access token after a refresh.`,
        remediation: RE_LOGIN,
      });
    }
    redactor?.addSecret(accessToken);

    // The pin wins over the stored site: one grant can cover several sites, and
    // JIRA_OAUTH_CLOUD_ID says which of them this server addresses. The cloudId
    // is validated inside `gatewayHost` before any URL exists (CC-101).
    const cloudId = nonEmptyString(settings.cloudId) ? settings.cloudId : fresh.cloudId;
    const host = gatewayHost(settings.gatewayOrigin, cloudId);

    // The gateway is not blanket-allowed: `loadSettings` appends it in oauth
    // mode only, so basic-mode egress is unchanged (D97). Catching it here names
    // the cause; letting the request layer catch it names only the symptom.
    const hostname = new URL(host.origin).hostname;
    if (!isAllowedHost(hostname, deps.allowedHosts)) {
      throw createJiraError({
        kind: 'config',
        reason: `The OAuth gateway host ${safeLabel(hostname)} is not in the effective allowlist, so no request could leave for it.`,
        remediation: `Add ${safeLabel(hostname)} to JIRA_ALLOWED_HOSTS, or unset JIRA_OAUTH_GATEWAY_ORIGIN to use the default gateway.`,
      });
    }

    return { kind: 'bearer', host, accessToken };
  };
}
