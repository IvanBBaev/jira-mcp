// `createAuthRequest`: the primitive `core/oauth.ts` uses to talk to Atlassian's
// OAuth endpoints (D515). Not a mode of `createJiraRequest`; the doc comment on
// `createAuthRequest` says why.

import { JiraError } from '../types.js';
import type { Clock, Logger, Redactor, Rng } from '../types.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  MAX_TEXT_BODY_BYTES,
  RETRY_AFTER_JITTER,
  backoffMs,
  capRetryAfterMs,
  isRedirectStatus,
  jitterMs,
  parseRetryAfterMs,
  shouldRetryStatus,
} from '../http-util.js';
import { kindForStatus } from '../errors.js';
import { readTextCapped, readTextOrEmpty } from './body.js';
import type { AttemptFailure, AttemptOutcome, AttemptResult } from './context.js';
import { failureReasonOf, isSuccessStatus } from './decide.js';
import { makeFail, requireFetch } from './failures.js';
import type { Fail } from './failures.js';
import { armAttempt } from './guard.js';
import { headersOf, parseJson } from './status.js';

/**
 * One call to an Atlassian OAuth endpoint.
 *
 * There is no `path`/`query` pair here as on the Jira side, because the two
 * endpoints this reaches are not a REST surface: `POST /oauth/token` and
 * `GET /oauth/token/accessible-resources` are the whole of it, and both are
 * built by `core/oauth.ts` from configured origins. What the primitive still
 * insists on is that the URL's ORIGIN was declared up front.
 */
export interface AuthRequestSpec {
  readonly method: 'GET' | 'POST';
  /** Absolute URL; its origin must be one of `allowedOrigins`. */
  readonly url: string;
  /**
   * POST body, sent as `application/json`. Never logged, at any level.
   *
   * JSON and not `application/x-www-form-urlencoded`, which is what RFC 6749
   * mandates and what almost every other OAuth server wants: Atlassian's 3LO
   * documentation shows a JSON body, and the documented shape is the one we
   * send. (The live endpoint happens to accept form encoding too, but that is
   * undocumented and therefore not a contract we can lean on.)
   */
  readonly json?: Readonly<Record<string, string>>;
  /** Sent as `Authorization: Bearer` — accessible-resources needs it. */
  readonly bearer?: string;
  readonly timeoutMs?: number;
}

/**
 * A successful OAuth response. Non-2xx never reaches the caller as a value: it
 * is raised as a `JiraError` with the kind the status deserves, so no caller
 * can forget to check `status`.
 */
export interface AuthResponse {
  readonly status: number;
  /** The parsed body, or `undefined` when the body was not JSON. */
  readonly json: unknown;
  readonly text: string;
}

export type AuthRequestFn = (spec: AuthRequestSpec) => Promise<AuthResponse>;

/**
 * Everything the OAuth primitive needs. Much smaller than `JiraHttpOptions`
 * because most of what a Jira call carries is meaningless here: there is no site
 * host to queue per, no call budget spanning several requests, and no
 * credentials — the token IS the payload.
 */
export interface AuthRequestOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Applied to every error message and remediation, as on the Jira side. */
  readonly redactor?: Redactor;
  /**
   * Exactly the origins this primitive may speak to — normally the auth origin
   * and the gateway origin. This is the whole SSRF guard for the auth path: a
   * URL whose origin is not on this list never reaches `fetch`.
   */
  readonly allowedOrigins: readonly string[];
  readonly requestTimeoutMs?: number;
  /**
   * Jitter source for the GET retry backoff. Optional, unlike on the Jira side:
   * the only caller that retries here is a single accessible-resources probe, so
   * a client that passes none gets un-jittered waits rather than a `Math.random`
   * this codebase does not allow.
   */
  readonly rng?: Rng;
}

/**
 * Normalise a configured origin the way `URL` will normalise the request URL,
 * so `https://API.Atlassian.com:443` and `https://api.atlassian.com` compare
 * equal. An entry that does not parse is kept verbatim, which can only ever fail
 * to match — a typo in the allowlist must not become a wildcard.
 */
function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** `error` / `error_description` as the OAuth spec defines them, if present. */
function oauthErrorFields(json: unknown): {
  code?: string;
  description?: string;
} {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const body = json as Record<string, unknown>;
  const code = body['error'];
  const description = body['error_description'];
  return {
    code: typeof code === 'string' && code !== '' ? code : undefined,
    description:
      typeof description === 'string' && description !== '' ? description : undefined,
  };
}

/** What one OAuth call fixes before its first attempt. */
interface AuthCall {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rng: Rng;
  readonly fail: Fail;
  readonly method: AuthRequestSpec['method'];
  readonly target: URL;
  /** The path, never the query (OBSERVABILITY.md §Never-log list). */
  readonly route: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string | undefined;
}

/** The long-lived half of an {@link AuthCall}, built once per client. */
interface AuthClient {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rng: Rng;
  readonly fail: Fail;
  readonly defaultTimeoutMs: number;
  readonly allowedOrigins: ReadonlySet<string>;
}

function oauthBodyTooLarge(call: AuthCall, status: number): JiraError {
  const { method: verb, route: path } = call;
  return call.fail({
    kind: verb === 'POST' ? 'auth' : 'validation',
    message: `Atlassian answered ${verb} ${path} with ${String(status)}, but the response body is over the ${String(MAX_TEXT_BODY_BYTES)}-byte response limit, so it was not read.`,
    httpStatus: status,
    retryable: false,
    remediation:
      verb === 'POST'
        ? // The endpoint said yes, so a rotating refresh token has most
          // likely been spent; resending the old one would fail anyway.
          'A token request is never sent twice, because a rotating refresh token cannot survive a replay. Run `jira-mcp-ai login` again.'
        : 'An OAuth response this large is not one Atlassian sends; check for a proxy rewriting the response, then retry.',
  });
}

/** Parse the URL, enforce the origin allowlist and build the request. */
function openAuthCall(client: AuthClient, spec: AuthRequestSpec): AuthCall {
  const { fail } = client;
  const method = spec.method;
  let target: URL;
  try {
    target = new URL(spec.url);
  } catch (cause) {
    throw fail({
      kind: 'config',
      message: `The OAuth endpoint ${JSON.stringify(spec.url)} is not an absolute URL, so no request was sent.`,
      remediation:
        'This is a caller bug: build the URL from the configured OAuth origins rather than from user input.',
      cause,
    });
  }

  // The SSRF guard, and it is an ORIGIN comparison rather than a host suffix
  // or a prefix on the whole URL. Origin-only is deliberate: `api.atlassian.com`
  // serves both the API gateway and `/oauth/token/accessible-resources`, so a
  // path allowlist would have to enumerate two unrelated shapes and would break
  // the moment the gateway path gained a segment. What must never vary is the
  // origin — that is the thing an attacker would want to move.
  if (!client.allowedOrigins.has(target.origin)) {
    throw fail({
      kind: 'config',
      message: `${method} to "${target.origin}" was refused: it is not one of the OAuth origins this server may contact.`,
      retryable: false,
      remediation:
        'Only the configured OAuth auth origin and gateway origin are reachable. Check JIRA_OAUTH_AUTH_ORIGIN and JIRA_OAUTH_GATEWAY_ORIGIN.',
    });
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.bearer !== undefined) headers['authorization'] = `Bearer ${spec.bearer}`;
  let payload: string | undefined;
  if (spec.json !== undefined) {
    payload = JSON.stringify(spec.json);
    headers['content-type'] = 'application/json';
  }

  return {
    clock: client.clock,
    logger: client.logger,
    rng: client.rng,
    fail,
    method,
    target,
    // The path, never the query: a path names an endpoint, a query can carry a
    // code or a token (OBSERVABILITY.md §Never-log list).
    route: target.pathname,
    timeoutMs: spec.timeoutMs ?? client.defaultTimeoutMs,
    // The entire no-replay rule, expressed as a number the loop already reads.
    maxRetries: method === 'GET' ? DEFAULT_RETRY_ATTEMPTS : 0,
    headers,
    payload,
  };
}

/** One fetch, its body read under the attempt's guard. */
async function authAttempt(call: AuthCall, attempt: number): Promise<AttemptOutcome> {
  const { clock, logger, method, route } = call;
  const guard = armAttempt(clock, call.timeoutMs);
  const attemptStartedAt = clock.now();

  try {
    const fetchFn = requireFetch(call.fail);
    const response = await guard.guard(
      fetchFn(call.target.toString(), {
        method,
        headers: call.headers,
        body: call.payload,
        signal: guard.signal,
        // Same reason as the Jira path: an automatic follow would carry the
        // Authorization header — or the token request body — to whatever
        // host the response named.
        redirect: 'manual',
      }),
    );
    logger.emit('http_response', {
      method,
      pathTemplate: route,
      status: response.status,
      durationMs: clock.now() - attemptStartedAt,
      attempt,
    });
    // A non-2xx body only names the failure, so losing it costs a snippet.
    // A 2xx body IS the result, and an over-cap one must not be handed on
    // as an empty success (CC-400).
    let text: string;
    if (isSuccessStatus(response.status)) {
      const read = await readTextCapped(guard, response);
      if (read.kind === 'over') throw oauthBodyTooLarge(call, response.status);
      text = read.text;
    } else {
      text = await readTextOrEmpty(guard, response);
    }
    return {
      kind: 'result',
      result: { status: response.status, headers: headersOf(response), text },
    };
  } catch (error) {
    if (error instanceof JiraError) throw error;
    return {
      kind: 'failure',
      failure: { reason: failureReasonOf(error), cause: error },
    };
  } finally {
    await guard.disarm();
  }
}

/** The error for an attempt that got no response and will not be retried. */
function lostAuthFailure(call: AuthCall, failure: AttemptFailure): JiraError {
  const { method, route } = call;
  const timedOut = failure.reason === 'timeout';
  return call.fail({
    kind: timedOut ? 'timeout' : 'transport',
    message: timedOut
      ? `${method} ${route} timed out after ${String(call.timeoutMs)} ms and was not retried.`
      : `Could not reach ${call.target.origin} for ${method} ${route}.`,
    remediation:
      method === 'POST'
        ? 'A token request is never sent twice, because a rotating refresh token cannot survive a replay. Run `jira-mcp-ai login` again.'
        : 'Check network connectivity and any proxy configuration, then retry.',
    cause: failure.cause,
  });
}

/** Log a retry and say how long it waits. */
function retryIn(
  call: AuthCall,
  reason: 'transport' | '429' | '5xx',
  attempt: number,
  delayMs: number,
): number {
  call.logger.emit('http_retry', {
    method: call.method,
    pathTemplate: call.route,
    reason,
    attempt,
    delayMs,
  });
  return delayMs;
}

/** A 429: the wait before a retry, or the error once the retries are spent. */
function rateLimited(call: AuthCall, result: AttemptResult, attempt: number): number {
  const { clock, method, route, rng } = call;
  const serverMs = parseRetryAfterMs(result.headers['retry-after'], clock.now());
  const cappedMs = serverMs === undefined ? undefined : capRetryAfterMs(serverMs);
  // A zero (or past-date) Retry-After would retry back to back with no
  // jitter, so it earns the same backoff as no header at all (CC-203).
  const waitMs =
    cappedMs === undefined || cappedMs === 0
      ? backoffMs(attempt, rng)
      : jitterMs(cappedMs, RETRY_AFTER_JITTER, rng);
  call.logger.emit('rate_limited', {
    retryAfterS: serverMs === undefined ? undefined : Math.round(serverMs / 1000),
    waitS: Math.round(waitMs / 1000),
  });
  if (attempt <= call.maxRetries) return retryIn(call, '429', attempt, waitMs);
  throw call.fail({
    kind: 'rate_limited',
    message: `Atlassian rate limited ${method} ${route}.`,
    httpStatus: 429,
    remediation:
      method === 'POST'
        ? // Neutral here: this layer cannot tell a refresh (the grant is
          // intact, retrying later is right) from a login exchange (the
          // flow is over, login must run again). core/oauth.ts knows,
          // and restates it (CC-247).
          'A token request is never replayed automatically; wait before trying again.'
        : 'Wait before calling again.',
  });
}

/** The error for a non-2xx, non-redirect, non-retried answer. */
function rejected(call: AuthCall, result: AttemptResult, json: unknown): JiraError {
  const { method, route } = call;
  const { status, headers } = result;
  const { code, description } = oauthErrorFields(json);
  // The OAuth error code names the failure and is not itself a credential —
  // but it goes through `fail`, so a server that echoed one back into
  // `error_description` still cannot print it.
  const detail =
    code === undefined
      ? undefined
      : description === undefined
        ? code
        : `${code}: ${description}`;

  if (status === 401 || status === 403 || (status === 400 && code === 'invalid_grant')) {
    call.logger.emit('auth_failure', { status, pathTemplate: route });
    return call.fail({
      kind: 'auth',
      message:
        code === 'invalid_grant'
          ? `Atlassian rejected the OAuth grant for ${method} ${route}: it has expired, been used already, or been revoked.`
          : `Atlassian rejected ${method} ${route} with HTTP ${String(status)}.`,
      httpStatus: status,
      detail,
      remediation:
        'Run `jira-mcp-ai login` to authorize this server again; the stored grant can no longer be exchanged.',
    });
  }

  return call.fail({
    kind: status >= 500 ? 'transport' : kindForStatus(status, { headers }),
    message: `Atlassian rejected ${method} ${route} with HTTP ${String(status)}.`,
    httpStatus: status,
    detail,
    remediation:
      status >= 500
        ? "Atlassian's OAuth service returned a server error. Check https://status.atlassian.com, then retry."
        : 'Check JIRA_OAUTH_CLIENT_ID, JIRA_OAUTH_CLIENT_SECRET and the redirect URI registered for this app, then run `jira-mcp-ai login` again.',
  });
}

/**
 * Settle an answered attempt: the response, or how long to wait before the
 * next attempt. Every other ending throws.
 */
function settleAnswer(
  call: AuthCall,
  result: AttemptResult,
  attempt: number,
): AuthResponse | number {
  const { method, route } = call;
  const status = result.status;

  if (isRedirectStatus(status)) {
    throw call.fail({
      kind: 'config',
      message: `Atlassian answered ${method} ${route} with a ${String(status)} redirect; redirects are never followed on the OAuth path.`,
      httpStatus: status,
      retryable: false,
      remediation:
        'A redirect here almost always means a proxy is intercepting the call. Check JIRA_OAUTH_AUTH_ORIGIN, JIRA_OAUTH_GATEWAY_ORIGIN and any corporate proxy.',
    });
  }

  if (status === 429) return rateLimited(call, result, attempt);

  if (status >= 500 && shouldRetryStatus(status, method) && attempt <= call.maxRetries) {
    // `shouldRetryStatus` and not `status >= 500`: it carries the rule that a
    // 500 is a bug rather than a hiccup, so only 502/503/504 come back here.
    return retryIn(call, '5xx', attempt, backoffMs(attempt, call.rng));
  }

  const parsed = parseJson(result.text);
  const json = parsed.ok ? parsed.value : undefined;

  if (isSuccessStatus(status)) return { status, json, text: result.text };
  throw rejected(call, result, json);
}

/** The attempt loop: a lost response retries only a GET, and never a cancel. */
async function runAuthCall(call: AuthCall): Promise<AuthResponse> {
  call.logger.emit('http_request', { method: call.method, pathTemplate: call.route });

  for (let attempt = 1; ; attempt += 1) {
    const outcome = await authAttempt(call, attempt);
    if (outcome.kind === 'failure') {
      if (attempt <= call.maxRetries && outcome.failure.reason !== 'aborted') {
        await call.clock.sleep(
          retryIn(call, 'transport', attempt, backoffMs(attempt, call.rng)),
        );
        continue;
      }
      throw lostAuthFailure(call, outcome.failure);
    }
    const settled = settleAnswer(call, outcome.result, attempt);
    if (typeof settled !== 'number') return settled;
    await call.clock.sleep(settled);
  }
}

/**
 * Build the `AuthRequestFn` that `core/oauth.ts` uses to talk to Atlassian.
 *
 * The policy that shapes every branch below, and the reason this is not a mode
 * of `jiraRequest`:
 *
 *   * **A POST is never retried.** Refresh tokens rotate, so the server cannot
 *     distinguish our replay from an attacker replaying a stolen token — and its
 *     defence against the latter is to invalidate the whole chain, which logs the
 *     operator out (D94). An authorization code is single-use for the same
 *     reason. It is the unsafe-write rule, one layer down: when the outcome of a
 *     failed send is unknown, asking again is the one thing that can make it
 *     worse. The rule is arithmetic here, not a special case — the retry budget
 *     for a POST is zero, so no branch can accidentally grow a replay.
 *   * A `GET` (accessible-resources, on the gateway origin) is safe and does
 *     retry, using the same backoff and `Retry-After` arithmetic as the Jira
 *     path. Note that Atlassian documents rate limits for the Jira REST API only;
 *     nothing is documented for `auth.atlassian.com`, so the 429 handling here is
 *     a courtesy to a header that may never appear, not a contract.
 *   * Redirects are never followed, as everywhere else in `core/http*`.
 *   * Neither the request body nor the response body is ever logged. The token
 *     endpoint's request body IS the secret, and its response body is the next
 *     one. What is logged is the status; what may surface in a thrown error's
 *     message is the OAuth `error`/`error_description`, which name the failure
 *     rather than carrying credentials — and even those pass through the
 *     redactor first.
 */ export function createAuthRequest(options: AuthRequestOptions): AuthRequestFn {
  const client: AuthClient = {
    clock: options.clock,
    logger: options.logger,
    // No jitter without an injected source: `Rng` is the only sanctioned one.
    rng: options.rng ?? ((): number => 0),
    fail: makeFail(options.redactor),
    defaultTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    allowedOrigins: new Set(options.allowedOrigins.map(normaliseOrigin)),
  };
  return async function authRequest(spec: AuthRequestSpec): Promise<AuthResponse> {
    return await runAuthCall(openAuthCall(client, spec));
  };
}
